// Client for the Bitcoin shielded pool: the proving artifacts, the proof system, and the replay service and
// relayer APIs. Used by the browser (dapp/sats) and by Node drivers (tests/secret-sats-e2e-signet.mjs).
//
// Artifacts: /btc-pool/pin.json names the prover wasm, the params and the verification key with their SHA-256,
// and the key's BLAKE2b-512 (vk_hash). They are fetched once, checked against the pin, and kept in the Cache
// API; later loads read the cache. Nothing is fetched until a pool action needs a proof.

import { makeHalo2System } from './btc-pool-halo2-prover.js';
import { defaultAnchor } from './btc-shielded-pool.js';

export const POOL_API = String(globalThis.__TACIT_BTC_POOL_API__ || 'https://tacit-btc-pool.onrender.com').replace(/\/$/, '');
const CACHE_NAME = 'tacit-btc-pool-artifacts-v1';

const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const strip = (h) => String(h).replace(/^0x/i, '').toLowerCase();

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
export function makePoolClient({ api = POOL_API, base = '/btc-pool/', fetchImpl = (...a) => globalThis.fetch(...a), readFile = null } = {}) {
  const baseUrl = base.endsWith('/') ? base : base + '/';
  let pinP = null;
  const cache = new Map();

  async function getJson(url, init) {
    const r = await fetchImpl(url, { cache: 'no-store', ...init });
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error(j?.error || `${url}: HTTP ${r.status}`);
      e.status = r.status; e.body = j;
      throw e;
    }
    return j;
  }

  const pin = () => (pinP ||= readFile ? Promise.resolve(JSON.parse(new TextDecoder().decode(readFile('pin.json')))) : getJson(baseUrl + 'pin.json'));

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

  // A wallet's notes from the feed, each with its height, txid and spent flag.
  async function walletNotes(pool, wallet, { notes = null } = {}) {
    const feed = notes || await allNotes();
    const byIndex = new Map(feed.map((n) => [n.leafIndex, n]));
    const mine = pool.scan(wallet, feed).map((x) => ({ ...x, height: byIndex.get(x.leafIndex).height, txid: byIndex.get(x.leafIndex).txid }));
    for (const x of mine) if (x.nf) x.spent = (await nullifier(x.nf)).spent === true;
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

  // ── relayer (mounted on the replay service when configured) ──
  const relayInfo = async () => { try { return await getJson(`${api}/btc-pool/relay/info`); } catch (e) { if (e.status === 404) return null; throw e; } };
  const quote = (body) => getJson(`${api}/btc-pool/relay/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const submit = (body) => getJson(`${api}/btc-pool/relay/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const relayStatus = (id) => getJson(`${api}/btc-pool/relay/status/${id}`);

  return { pin, system, artifactBytes, artifactsCached, status, allNotes, path, nullifier, exit, walletNotes, anchorAndPaths, relayInfo, quote, submit, relayStatus, api };
}
