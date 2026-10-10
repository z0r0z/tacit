// Client for the Bitcoin shielded pool: the proving artifacts, the proof system, and the replay service and
// relayer APIs. Used by the browser (dapp/sats) and by Node drivers (tests/secret-sats-e2e-signet.mjs).
//
// Artifacts: /btc-pool/pin.json names the prover wasm, the params and the verification key with their SHA-256,
// and the key's BLAKE2b-512 (vk_hash). They are fetched once, checked against the pin, and kept in the Cache
// API; later loads read the cache. Nothing is fetched until a pool action needs a proof.

import { makeHalo2System } from './btc-pool-halo2-prover.js';
import { defaultAnchor } from './btc-shielded-pool.js';
import { poseidon2 } from './vendor/tacit-poseidon.min.js';

export const POOL_API = String(globalThis.__TACIT_BTC_POOL_API__ || 'https://tacit-btc-pool.onrender.com').replace(/\/$/, '');
const CACHE_NAME = 'tacit-btc-pool-artifacts-v1';

const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const strip = (h) => String(h).replace(/^0x/i, '').toLowerCase();

// The pool's depth-32 Poseidon tree (zero leaf 0, an absent sibling at level i is zeros[i]), as the replay keeps it.
const DEPTH = 32;
const ZEROS = (() => { const z = [0n]; for (let i = 1; i <= DEPTH; i++) z.push(poseidon2([z[i - 1], z[i - 1]])); return z; })();
const word = (v) => '0x' + v.toString(16).padStart(64, '0');
// Root of the tree of the feed's leaves through block `h`, and the paths of `indexes` in it.
function pathsAt(feed, h, indexes) {
  let n = 0;
  while (n < feed.length && feed[n].height <= h) { if (feed[n].leafIndex !== n) throw new Error('the note feed has a gap'); n++; }
  if (indexes.some((i) => i >= n)) throw new Error('a note is newer than the anchor');
  const levels = [feed.slice(0, n).map((x) => BigInt('0x' + strip(x.leaf)))];
  for (let i = 0; i < DEPTH; i++) {
    const a = levels[i], b = new Array(Math.ceil(a.length / 2));
    for (let j = 0; j < b.length; j++) b[j] = poseidon2([a[2 * j], 2 * j + 1 < a.length ? a[2 * j + 1] : ZEROS[i]]);
    levels.push(b);
  }
  const node = (i, j) => (j < levels[i].length ? levels[i][j] : ZEROS[i]);
  return { root: word(node(DEPTH, 0)), paths: indexes.map((idx) => Array.from({ length: DEPTH }, (_, i) => word(node(i, Math.floor(idx / 2 ** i) ^ 1)))) };
}

async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return hex(d);
}

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
export function makePoolClient({ api = POOL_API, relayApi = null, base = '/btc-pool/', fetchImpl = (...a) => globalThis.fetch(...a), readFile = null } = {}) {
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

  // The note feed, read again only when the last read is over 20 s old (a spend reads it right after the balance did).
  let feedMemo = null;
  async function feedNow(fresh = false) {
    if (!fresh && feedMemo && Date.now() - feedMemo.at < 20e3) return feedMemo.notes;
    const notes = await allNotes();
    feedMemo = { at: Date.now(), notes };
    return notes;
  }
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

  // A wallet's notes from the feed, each with its height, txid and spent flag. Spent flags come from the whole list of
  // the pool's nullifiers, so no request names a note of this wallet's; a replay without the list is asked note by note.
  async function walletNotes(pool, wallet, { notes = null } = {}) {
    const feed = notes || await feedNow();
    const byIndex = new Map(feed.map((n) => [n.leafIndex, n]));
    const mine = pool.scan(wallet, feed).map((x) => ({ ...x, height: byIndex.get(x.leafIndex).height, txid: byIndex.get(x.leafIndex).txid }));
    const list = mine.some((x) => x.nf) ? await spentList() : null;
    for (const x of mine) if (x.nf) x.spent = list ? list.has(strip(x.nf)) : (await nullifier(x.nf)).spent === true;
    return mine;
  }

  // Anchor for spending `notes` under the wallet policy, the root there and each note's path. Returns
  // { wait } with the number of blocks left when the policy anchor is still below a note's block; with
  // { anchor } the caller picks any retained height instead (at least every note's block).
  async function anchorAndPaths(notes, { anchor = null } = {}) {
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
    // replay's root for the anchor; the replay is asked for paths only if the two disagree twice.
    const R = await getJson(`${api}/btc-pool/root/${hAnchor}`).catch(() => null);
    if (R?.root && R.retained !== false) {
      for (const fresh of [false, true]) {
        try {
          const feed = await feedNow(fresh), L = pathsAt(feed, hAnchor, notes.map((n) => n.leafIndex));
          if (strip(L.root) !== strip(R.root) || notes.some((n) => strip(feed[n.leafIndex].leaf) !== strip(n.leaf))) continue;
          return { hAnchor, root: L.root, tip: s.height, notes: notes.map((n, i) => ({ ...n, path: L.paths[i] })) };
        } catch { /* read the paths from the replay */ }
      }
    }
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

  return { pin, system, artifactBytes, artifactsCached, status, allNotes, path, nullifier, exit, walletNotes, anchorAndPaths, relayInfo, quote, submit, relayStatus, api };
}
