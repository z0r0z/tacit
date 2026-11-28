// Client for the Bitcoin shielded pool: the proving artifacts, the proof system, and the replay service and
// relayer APIs. Used by the browser (dapp/sats) and by Node drivers.
//
// Artifacts: /btc-pool/pin.json names the prover wasm, the params and the verification key with their SHA-256,
// and the key's BLAKE2b-512 (vk_hash). They are fetched once, checked against the pin, and kept in the Cache
// API; later loads read the cache. Nothing is fetched until a pool action needs a proof.

import { makeHalo2System } from './btc-pool-halo2-prover.js';
import { defaultAnchor } from './btc-shielded-pool.js';
import { makeBtcScanWorkers } from './btc-pool-scan-workers.js';
import { poseidon2 } from './vendor/tacit-poseidon.min.js';

export const POOL_API = String(globalThis.__TACIT_BTC_POOL_API__ || 'https://tacit-btc-pool-mainnet.onrender.com').replace(/\/$/, '');
const CACHE_NAME = 'tacit-btc-pool-artifacts-v1';

const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const strip = (h) => String(h).replace(/^0x/i, '').toLowerCase();

// The pool's depth-32 Poseidon tree (zero leaf 0, an absent sibling at level i is zeros[i]), as the replay keeps it.
const DEPTH = 32;
const ZEROS = (() => { const z = [0n]; for (let i = 1; i <= DEPTH; i++) z.push(poseidon2([z[i - 1], z[i - 1]])); return z; })();
const word = (v) => '0x' + v.toString(16).padStart(64, '0');
// Root of the tree of the feed's leaves through block `h`, and the paths of `indexes` in it. `memo` keeps the tree's levels between
// calls: a later call rehashes only from the first leaf that differs from the last one (the feed only grows, bar a reorg at its tip).
function pathsAt(feed, h, indexes, memo = { keys: [], levels: [] }) {
  let n = 0;
  while (n < feed.length && feed[n].height <= h) { if (feed[n].leafIndex !== n) throw new Error('the note feed has a gap'); n++; }
  if (indexes.some((i) => i >= n)) throw new Error('a note is newer than the anchor');
  const { keys, levels } = memo;
  while (levels.length <= DEPTH) levels.push([]);
  let p = 0;
  const same = Math.min(n, keys.length);
  while (p < same && keys[p] === strip(feed[p].leaf)) p++;
  try {
    keys.length = n; levels[0].length = n;
    for (let j = p; j < n; j++) { keys[j] = strip(feed[j].leaf); levels[0][j] = BigInt('0x' + keys[j]); }
    for (let i = 0, s = p; i < DEPTH; i++) {
      const a = levels[i], b = levels[i + 1];
      s = Math.floor(s / 2);
      b.length = Math.ceil(a.length / 2);
      for (let j = s; j < b.length; j++) b[j] = poseidon2([a[2 * j], 2 * j + 1 < a.length ? a[2 * j + 1] : ZEROS[i]]);
    }
  } catch (e) { keys.length = 0; throw e; }
  const node = (i, j) => (j < levels[i].length ? levels[i][j] : ZEROS[i]);
  return { root: word(node(DEPTH, 0)), paths: indexes.map((idx) => Array.from({ length: DEPTH }, (_, i) => word(node(i, Math.floor(idx / 2 ** i) ^ 1)))) };
}

async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return hex(d);
}

// Where what a wallet's reads found is kept between page loads (scanMine): the page's localStorage, and nowhere in Node or where it is blocked, where every load reads from the start.
function browserStore() {
  try {
    const l = globalThis.localStorage;
    if (!l || typeof l.getItem !== 'function') return null;
    return { get: (k) => { try { return l.getItem(k); } catch { return null; } }, set: (k, v) => { try { l.setItem(k, v); } catch { /* full or blocked: the next load reads from the start */ } } };
  } catch { return null; }
}
const SCAN_CK = 'tacit-btc-scan-ck-v1', SCAN_CK_KEEP = 6;
// The workers that read the leaves of a feed for a wallet (scanMine): one set for the page, kept a few seconds after a read.
const sharedScanWorkers = makeBtcScanWorkers();
const textBytes = (t) => new TextEncoder().encode(t);

// Reads a response body with progress(loaded, total).
async function readWithProgress(resp, total, progress) {
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const b = new Uint8Array(await resp.arrayBuffer());
    progress?.(b.length, total || b.length);
    return b;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    progress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

// base: where pin.json and the artifacts are served. readFile(name) → bytes replaces fetch (Node).
export function makePoolClient({ api = POOL_API, relayApi = null, base = '/btc-pool/', fetchImpl = (...a) => globalThis.fetch(...a), readFile = null, store = browserStore(), scanWorkers = sharedScanWorkers } = {}) {
  const baseUrl = base.endsWith('/') ? base : base + '/';
  let pinP = null;
  const cache = new Map();

  async function getJson(url, init) {
    const r = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout?.(60_000), ...init });   // never hangs a payment
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error(j?.error || `${url}: HTTP ${r.status}`);
      e.status = r.status; e.body = j;
      throw e;
    }
    return j;
  }

  // A failed read is not kept: the next call asks again, so a network blip does not end every later proof.
  const pin = () => (pinP ||= (readFile ? Promise.resolve(JSON.parse(new TextDecoder().decode(readFile('pin.json')))) : getJson(baseUrl + 'pin.json'))
    .catch((e) => { pinP = null; throw e; }));

  // Bytes of a pinned artifact, checked against its SHA-256. onProgress({ name, loaded, total, cached }).
  async function artifact(name, sha, total, onProgress) {
    if (cache.has(name)) return cache.get(name);
    let bytes = null, fromCache = false;
    if (readFile) {
      bytes = readFile(name);
      if ((await sha256Hex(bytes)) !== strip(sha)) throw new Error(`${name} does not match its pinned hash`);
    } else {
      const key = `${baseUrl}${name}?sha256=${sha}`;
      let store = null;
      try { store = await globalThis.caches?.open(CACHE_NAME); } catch { store = null; }
      const hit = store ? await store.match(key).catch(() => null) : null;
      if (hit) {
        bytes = new Uint8Array(await hit.arrayBuffer());
        fromCache = true;
        onProgress?.({ name, loaded: bytes.length, total: bytes.length, cached: true });
      } else {
        const r = await fetchImpl(baseUrl + name);
        if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
        bytes = await readWithProgress(r, total || Number(r.headers.get('content-length')) || 0, (loaded, t) => onProgress?.({ name, loaded, total: t, cached: false }));
      }
      if ((await sha256Hex(bytes)) !== strip(sha)) {
        if (store && fromCache) await store.delete(key).catch(() => {});
        throw new Error(`${name} does not match its pinned hash`);
      }
      if (store && !fromCache) await store.put(key, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
    }
    cache.set(name, bytes);
    return bytes;
  }

  const pinned = (p) => [[p.wasm, p.wasm_sha256, p.wasm_bytes], [p.params, p.params_sha256, p.params_bytes], [p.vk, p.vk_sha256, p.vk_bytes]];
  // Download size of the prover artifacts, in bytes.
  const artifactBytes = async () => pinned(await pin()).reduce((a, [, , n]) => a + (n || 0), 0);

  // The proof system over the pinned key. The artifacts load on the first prove or verify.
  async function system({ onProgress } = {}) {
    const p = await pin();
    return makeHalo2System({
      pinnedVkHash: p.vk_hash,
      wasm: () => artifact(p.wasm, p.wasm_sha256, p.wasm_bytes, onProgress),
      // the threaded prover (rayon over Web Workers, about 3.5x faster on 8 cores): only where the page is cross-origin isolated, which its
      // shared memory needs; the single one otherwise, and if it fails to start
      wasmThreads: p.wasm_threads && globalThis.crossOriginIsolated ? () => artifact(p.wasm_threads, p.wasm_threads_sha256, p.wasm_threads_bytes, onProgress) : null,
      params: () => artifact(p.params, p.params_sha256, p.params_bytes, onProgress),
      vk: () => artifact(p.vk, p.vk_sha256, p.vk_bytes, onProgress),
    });
  }
  // True when every prover artifact is already in the browser cache.
  async function artifactsCached() {
    if (readFile) return true;
    try {
      const p = await pin();
      const store = await globalThis.caches?.open(CACHE_NAME);
      if (!store) return false;
      for (const [n, s] of pinned(p)) if (!(await store.match(`${baseUrl}${n}?sha256=${s}`))) return false;
      return true;
    } catch { return false; }
  }

  // ── replay service ──
  const status = () => getJson(`${api}/btc-pool/status`);
  async function allNotes({ from = 0 } = {}) {
    const out = [];
    for (let guard = 0; guard < 10000; guard++) {
      const j = await getJson(`${api}/btc-pool/notes?from=${from}&limit=1000`);
      for (const x of j.notes) out.push({ leafIndex: x.leafIndex, txid: x.txid, height: x.height, leaf: x.leaf, asset: x.asset, pkEph: x.pk_eph, ctNote: x.ct_note });
      if (!j.notes.length || j.next === from) break;
      from = j.next;
    }
    return out;
  }
  const path = (leafIndex, at) => getJson(`${api}/btc-pool/path/${leafIndex}?at=${at}`);
  const nullifier = (nf) => getJson(`${api}/btc-pool/nullifier/${strip(nf)}`);
  const exit = (txid, vout) => getJson(`${api}/btc-pool/exit/${strip(txid)}/${vout}`);
  // What the replay made of the pool envelopes in one transaction: { seen, height, envelopes: [{ height, vin, opcode, accepted, reason }] }. A replay without the route answers 404.
  const envelope = (txid) => getJson(`${api}/btc-pool/envelope/${strip(txid)}`);

  // The note feed, read again only when the last read is over 20 s old (a spend reads it right after the balance did). A later
  // read keeps the notes it has and asks only from twelve blocks below its newest note on, for reorgs; `fresh` reads it all.
  let feedMemo = null;
  async function feedNow(fresh = false) {
    if (!fresh && feedMemo && Date.now() - feedMemo.at < 20e3) return feedMemo.notes;
    let notes = null;
    const had = !fresh && feedMemo?.notes;
    if (had && had.length) {
      const floor = had[had.length - 1].height - 12;
      let cut = had.length;
      while (cut > 0 && had[cut - 1].height >= floor) cut--;
      const tail = await allNotes({ from: cut });
      if (!tail.length || tail[0].leafIndex === cut) notes = had.slice(0, cut).concat(tail);
    }
    if (!notes) notes = await allNotes();
    feedMemo = { at: Date.now(), notes };
    return notes;
  }
  // Whether the feed holds a note made by transaction `txid` (a shield's notes carry its txid), from the feed held if it is under 20 s old, or `fresh`ly read.
  async function feedHas(txid, { fresh = false } = {}) {
    const t = strip(txid);
    return (await feedNow(fresh)).some((n) => strip(n.txid) === t);
  }
  const treeMemo = { keys: [], levels: [] };
  // Every nullifier the pool has seen, kept between reads and read again from twelve blocks back for reorgs; null when
  // the replay does not serve the list.
  let nfMemo = null;
  async function spentList() {
    const tip = (await status()).height ?? 0, from = nfMemo ? Math.max(0, nfMemo.through - 12) : 0;
    const map = new Map(nfMemo ? [...nfMemo.map].filter(([, h]) => h < from) : []);
    let q = `from=${from}`;
    for (let guard = 0; guard < 10000 && q; guard++) {
      let j;
      try { j = await getJson(`${api}/btc-pool/nullifiers?${q}&limit=5000`); } catch (e) { if (e.status === 404) return null; throw e; }
      for (const [nf, h] of j.nullifiers) map.set(strip(nf), h);
      q = j.next ? `from=${j.next.from}&after=${strip(j.next.after)}` : null;
    }
    nfMemo = { map, through: tip };
    return map;
  }

  // The feed's notes that open under `wallet` (pool.scan's results). Each leaf is tried once per wallet object and the
  // answer kept: the feed only grows, so a later read tries just the leaves it has not seen, and one whose leaf changed
  // under the same index. Every leaf is still tried alike; a long first read yields to the page between batches.
  //
  // Trying a leaf is a point multiplication or two (about 2.5 ms) and a page load starts with no memory of the last, so every load tried
  // every leaf again, more of them as the pool grows. What a read found is kept for the next load, and none of it is secret: for a wallet,
  // named by the public keys that decide what it can see (the view tier is part of the name), how many leaves of the feed were tried, a digest
  // of those leaves as the feed gave them, and the indexes of those that opened. A load whose feed begins with the same leaves tries only
  // what came after and opens the kept notes again to read them under the wallet in hand; if the feed differs, a kept note no longer opens,
  // or the record is not what was written, it reads from the start as before.
  // one entry per wallet object: its memo, and the record's restore into it, which every read of that wallet waits for (a second read made while the first is still opening
  // the kept notes must not read the whole feed)
  const scanned = new WeakMap();
  const walletTag = async (w) => {
    if (!w || !w.network || !w.V || !w.A || !w.N || (w.vInt != null && !w.VInt)) return null;
    return (await sha256Hex(textBytes(['btc-scan-v1', w.network, strip(w.V), strip(w.A), strip(w.N), w.vInt != null ? strip(w.VInt) : ''].join('|')))).slice(0, 32);
  };
  const feedDigest = (feed, n) => sha256Hex(textBytes(feed.slice(0, n).map((f) => `${strip(f.leaf)}:${strip(f.asset)}:${strip(f.pkEph)}:${strip(f.ctNote)}`).join(',')));
  const contiguous = (feed, n) => { for (let i = 0; i < n; i++) if (!feed[i] || feed[i].leafIndex !== i) return false; return true; };
  const keptRead = () => { try { const j = JSON.parse(store.get(SCAN_CK) || 'null'); return j && j.v === 1 && Array.isArray(j.e) ? j.e : []; } catch { return []; } };
  // A message to oneself yields like a timer but is not clamped to four milliseconds a turn once turns nest, nor slowed in a background tab.
  const handBack = () => new Promise((r) => { if (typeof MessageChannel === 'undefined') return setTimeout(r, 0); const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });
  // What the pool's receive makes of each of `leaves` under the wallet, a note or null each: from the workers where they answer (a leaf is a point multiplication or two, and a note that
  // opens about forty milliseconds more, its keys, its leaf and its nullifier), here for every leaf they did not answer, the thread handed back between leaves.
  async function readLeaves(pool, wallet, leaves, opts) {
    const out = new Array(leaves.length).fill(null);
    let told = null;
    if (scanWorkers && leaves.length) {
      try { const t = await scanWorkers(wallet, leaves, opts); if (Array.isArray(t) && t.length === leaves.length) told = t; } catch { told = null; }
    }
    let at = Date.now();
    for (let i = 0; i < leaves.length; i++) {
      if (told && told[i] !== undefined) { out[i] = told[i] || null; continue; }
      out[i] = pool.scan(wallet, [leaves[i]]).find((x) => x.leafIndex === leaves[i].leafIndex) || null;     // matched by index, as a scan of a whole batch is
      if (Date.now() - at > 12) { await handBack(); at = Date.now(); }
    }
    return out;
  }
  async function restoreScan(pool, wallet, feed, memo) {
    if (!store || !feed.length) return;
    try {
      const k = await walletTag(wallet), rec = k && keptRead().find((e) => e && e.k === k);
      if (!rec || !Number.isInteger(rec.n) || rec.n < 1 || rec.n > feed.length || !Array.isArray(rec.mine) || typeof rec.d !== 'string') return;
      if (!rec.mine.every((i) => Number.isInteger(i) && i >= 0 && i < rec.n) || !contiguous(feed, rec.n) || await feedDigest(feed, rec.n) !== rec.d) return;
      const opened = await readLeaves(pool, wallet, rec.mine.map((i) => feed[i]), { minLeaves: 8 });
      if (opened.some((x) => !x)) return;
      const byIndex = new Map(rec.mine.map((i, j) => [i, opened[j]]));
      for (let i = 0; i < rec.n; i++) memo.set(i, { leaf: feed[i].leaf, x: byIndex.get(i) || null });
    } catch { memo.clear(); }
  }
  async function keepScan(wallet, feed, memo) {
    if (!store || !feed.length || !contiguous(feed, feed.length)) return;
    try {
      const k = await walletTag(wallet);
      if (!k) return;
      const mine = []; feed.forEach((f, i) => { if (memo.get(i)?.x) mine.push(i); });
      const e = keptRead().filter((x) => x && x.k !== k);
      e.unshift({ k, n: feed.length, d: await feedDigest(feed, feed.length), mine });
      store.set(SCAN_CK, JSON.stringify({ v: 1, e: e.slice(0, SCAN_CK_KEEP) }));
    } catch { /* not kept: the next load reads from the start */ }
  }
  async function scanMine(pool, wallet, feed) {
    let entry = scanned.get(wallet);
    if (!entry) { const m = new Map(); scanned.set(wallet, (entry = { memo: m, ready: restoreScan(pool, wallet, feed, m) })); }
    await entry.ready;
    const memo = entry.memo;
    const todo = feed.filter((f) => memo.get(f.leafIndex)?.leaf !== f.leaf);
    const read = await readLeaves(pool, wallet, todo);
    todo.forEach((f, i) => memo.set(f.leafIndex, { leaf: f.leaf, x: read[i] }));
    if (todo.length) await keepScan(wallet, feed, memo);
    return feed.map((f) => memo.get(f.leafIndex).x).filter(Boolean);
  }
  // A wallet's notes from the feed, each with its height, txid and spent flag. Spent flags come from the whole list of
  // the pool's nullifiers, so no request names a note of this wallet's. A replay without the list can only be asked note by
  // note, which names them: that is done only when the caller sets `namedChecks`.
  async function walletNotes(pool, wallet, { notes = null, namedChecks = false } = {}) {
    const feed = notes || await feedNow();
    const byIndex = new Map(feed.map((n) => [n.leafIndex, n]));
    const mine = (await scanMine(pool, wallet, feed)).map((x) => ({ ...x, height: byIndex.get(x.leafIndex).height, txid: byIndex.get(x.leafIndex).txid }));
    const list = mine.some((x) => x.nf) ? await spentList() : null;
    if (mine.some((x) => x.nf) && !list && !namedChecks) throw new Error('the pool replay does not serve its list of spent notes, so the notes of this wallet are not checked against it');
    for (const x of mine) if (x.nf) x.spent = list ? list.has(strip(x.nf)) : (await nullifier(x.nf)).spent === true;
    return mine;
  }

  // Anchor for spending `notes` under the wallet policy, the root there and each note's path. Returns
  // { wait } with the number of blocks left when the policy anchor is still below a note's block; with
  // { anchor } the caller picks any retained height instead (at least every note's block). A path asked of the replay names the
  // note it is for, so the paths come from the feed alone unless the caller sets `namedPaths`.
  async function anchorAndPaths(notes, { anchor = null, namedPaths = false } = {}) {
    const s = await status();
    if (s.halted) throw new Error('the pool replay is paused');
    if (s.height == null) throw new Error('the pool replay has not started');
    const need = Math.max(...notes.map((n) => n.height));
    const hAnchor = anchor ?? defaultAnchor(s.height);
    if (hAnchor < need) {
      const firstTip = Math.ceil(need / 6) * 6 + 6;
      return { wait: firstTip - s.height, tip: s.height, need };
    }
    if (hAnchor > s.height) throw new Error('anchor is ahead of the pool replay');
    // The paths are worked out here from the feed, which holds every leaf, and the root is checked against the
    // replay's root for the anchor.
    const R = await getJson(`${api}/btc-pool/root/${hAnchor}`).catch(() => null);
    if (R?.root && R.retained !== false) {
      for (const fresh of [false, true]) {
        try {
          const feed = await feedNow(fresh), L = pathsAt(feed, hAnchor, notes.map((n) => n.leafIndex), treeMemo);
          if (strip(L.root) !== strip(R.root) || notes.some((n) => strip(feed[n.leafIndex].leaf) !== strip(n.leaf))) continue;
          return { hAnchor, root: L.root, tip: s.height, notes: notes.map((n, i) => ({ ...n, path: L.paths[i] })) };
        } catch { /* read the paths from the replay */ }
      }
    }
    if (!namedPaths) throw new Error('the pool replay did not give a root to check the paths against just now; try again in a moment');
    const withPaths = [];
    let root = null;
    for (const n of notes) {
      const j = await path(n.leafIndex, hAnchor);
      if (strip(j.leaf) !== strip(n.leaf) || j.hAnchor !== hAnchor) throw new Error('the pool served a path for another leaf');
      if (root && strip(root) !== strip(j.root)) throw new Error('the pool served paths under two roots');
      root = j.root;
      withPaths.push({ ...n, path: j.path });
    }
    return { hAnchor, root, tip: s.height, notes: withPaths };
  }

  // ── relayer ──
  // The relayer can be mounted on the replay service, but both deployed networks run it as its own origin,
  // so it gets its own base. Defaults to `api`, which is the mounted-together case.
  const rApi = relayApi || api;
  const relayInfo = async () => { try { return await getJson(`${rApi}/btc-pool/relay/info`); } catch (e) { if (e.status === 404) return null; throw e; } };
  const quote = (body) => getJson(`${rApi}/btc-pool/relay/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const submit = (body) => getJson(`${rApi}/btc-pool/relay/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const relayStatus = (id) => getJson(`${rApi}/btc-pool/relay/status/${id}`);

  return { pin, system, artifactBytes, artifactsCached, status, allNotes, feedHas, path, nullifier, exit, envelope, walletNotes, scanMine, anchorAndPaths, relayInfo, quote, submit, relayStatus, api };
}
