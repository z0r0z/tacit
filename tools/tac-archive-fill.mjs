#!/usr/bin/env node
// Catches the API's Tacit transaction archive up on an asset's transfers it lacks. It pages the asset's transfer index, asks the archive
// which of those it holds, reads the rest (their bytes and block) through the API's own cached explorer proxy, one read at a time, checks
// each against the txid its bytes hash to, and, with --send, imports what checks into the archive (the API checks each again itself).
// Without --send nothing is written to the API: it reads, reports and saves what it would send.
//
//   node tools/tac-archive-fill.mjs [--asset <id>] [--api https://api.tacit.finance] [--network mainnet] [--pages 12]
//                                   [--gap-ms 350] [--out tac-archive-fill.json]
//   TACIT_BOX_TOKEN=… node tools/tac-archive-fill.mjs --send            (the operator token; the import is refused without it)
//
// A transfer that is not confirmed yet is left for a later run, and one whose bytes do not hash to its txid is reported and never sent.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { txFromRaw } from '../dapp/tx-archive.js';

export const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const IMPORT_BATCH = 400;                 // the API keeps up to 500 in a request
const sha256 = (b) => createHash('sha256').update(b).digest();
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request with its answer parsed: a 429 waits what it asks (Retry-After, else 5 s) and a failure of the service backs off 1, 2, 4 s, up to `tries` asks in all.
async function call(fetchImpl, sleep, url, init, { text = false, tries = 4, on404 = null } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    let res;
    try { res = await fetchImpl(url, init); } catch (e) { last = e; await sleep(1000 * 2 ** i); continue; }
    if (res.status === 429) { const s = Number(res.headers?.get?.('retry-after')); last = new Error('429'); await sleep((s > 0 ? Math.min(s, 30) : 5) * 1000 + 300); continue; }
    if (res.status >= 500) { last = new Error(`HTTP ${res.status}`); await sleep(1000 * 2 ** i); continue; }
    if (res.status === 404) { if (on404) throw new Error(on404); return null; }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(/\?.*/, '')}`);
    return text ? (await res.text()).trim() : res.json();
  }
  throw last || new Error('no answer');
}

// The unique txids of an asset's transfers, newest first (the index repeats some across its pages).
export async function transferIds({ api, network, asset = TAC, pages = 12, fetchImpl = fetch, sleep = realSleep }) {
  const ids = []; const seen = new Set(); let cursor = null;
  for (let p = 0; p < pages; p++) {
    const j = await call(fetchImpl, sleep, `${api}/assets/${asset}/recent-xfer-txids?network=${encodeURIComponent(network)}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const t of (j && j.txids) || []) { const id = String(t).toLowerCase(); if (/^[0-9a-f]{64}$/.test(id) && !seen.has(id)) { seen.add(id); ids.push(id); } }
    if (!j || j.done || !j.next_cursor) break;
    cursor = j.next_cursor;
  }
  return ids;
}

// Which of `ids` the archive holds (64 roots to a request, the transfers themselves and nothing they spend from).
export async function heldBy({ api, network, ids, fetchImpl = fetch, sleep = realSleep }) {
  const held = new Set();
  for (let i = 0; i < ids.length; i += 64) {
    const j = await call(fetchImpl, sleep, `${api}/chain/tac/ancestry?network=${encodeURIComponent(network)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roots: ids.slice(i, i + 64), depth: 0 }) });
    for (const id of Object.keys((j && j.txs) || {})) held.add(id.toLowerCase());
  }
  return held;
}

// Reads each id's block and bytes, a read at a time with `gapMs` between them: { found: [{ txid, hex, h, b }], unconfirmed: [txid], failed: [[txid, why]] }.
export async function readMissing({ api, network, ids, fetchImpl = fetch, sleep = realSleep, gapMs = 350, log = () => {} }) {
  const found = [], unconfirmed = [], failed = [];
  const get = async (path, opts) => { const r = await call(fetchImpl, sleep, `${api}/chain${path}?network=${encodeURIComponent(network)}`, undefined, opts); if (gapMs) await sleep(gapMs); return r; };
  for (const [i, txid] of ids.entries()) {
    try {
      const st = await get(`/tx/${txid}/status`);
      if (!st) { failed.push([txid, 'not found']); continue; }
      if (!st.confirmed || !Number.isInteger(st.block_height)) { unconfirmed.push(txid); continue; }
      const hex = await get(`/tx/${txid}/hex`, { text: true });
      if (!hex) { failed.push([txid, 'no bytes']); continue; }
      const tx = txFromRaw(hex, { txid, height: st.block_height, blockHash: st.block_hash, sha256 });
      if (!tx) { failed.push([txid, 'bytes do not hash to the txid']); continue; }
      found.push({ txid, hex, h: st.block_height, ...(st.block_hash ? { b: st.block_hash } : {}) });
    } catch (e) { failed.push([txid, String(e.message || e)]); }
    if ((i + 1) % 25 === 0 || i + 1 === ids.length) log(`  read ${i + 1} of ${ids.length}`);
  }
  return { found, unconfirmed, failed };
}

// Imports `found` into the archive, `batch` to a request; returns { kept, refused: [txid] }.
export async function sendFound({ api, network, token, found, batch = IMPORT_BATCH, fetchImpl = fetch, sleep = realSleep }) {
  let kept = 0; const refused = [];
  for (let i = 0; i < found.length; i += batch) {
    const part = found.slice(i, i + batch);
    const res = await call(fetchImpl, sleep, `${api}/chain/tac/import?network=${encodeURIComponent(network)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ txs: part.map(({ hex, h, b }) => ({ hex, h, ...(b ? { b } : {}) })) }),
    }, { on404: 'the API answered 404 to the import: it does not accept this token (a wrong one is answered as if the route did not exist), so nothing was imported' });
    kept += (res && res.kept) || 0;
    for (const j of (res && res.refused) || []) if (part[j]) refused.push(part[j].txid);
  }
  return { kept, refused };
}

export async function main(argv, env, { fetchImpl = fetch, sleep = realSleep, log = console.log, write = writeFileSync } = {}) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const api = arg('--api', 'https://api.tacit.finance').replace(/\/$/, ''), network = arg('--network', 'mainnet'), asset = arg('--asset', TAC);
  const pages = Number(arg('--pages', 12)), gapMs = Number(arg('--gap-ms', 350)), out = arg('--out', 'tac-archive-fill.json');
  const send = argv.includes('--send'), token = env.TACIT_BOX_TOKEN || '';
  if (send && token.length < 16) { log('set TACIT_BOX_TOKEN to the operator token (or leave out --send to only read)'); return 2; }

  const ids = await transferIds({ api, network, asset, pages, fetchImpl, sleep });
  const held = await heldBy({ api, network, ids, fetchImpl, sleep });
  const missing = ids.filter((t) => !held.has(t));
  log(`${ids.length} transfers in the index; the archive holds ${held.size}, lacks ${missing.length}`);
  if (!missing.length) return 0;

  const { found, unconfirmed, failed } = await readMissing({ api, network, ids: missing, fetchImpl, sleep, gapMs, log });
  log(`read ${found.length} whole and confirmed; ${unconfirmed.length} not confirmed yet (left for a later run); ${failed.length} failed`);
  for (const [t, why] of failed) log(`  ${t}: ${why}`);
  if (found.length) { write(out, JSON.stringify({ network, txs: found }, null, 1)); log(`saved what it would send to ${out}`); }
  if (!send) { log('nothing was sent (add --send with TACIT_BOX_TOKEN to import them)'); return failed.length ? 1 : 0; }
  if (!found.length) return failed.length ? 1 : 0;

  const { kept, refused } = await sendFound({ api, network, token, found, fetchImpl, sleep });
  for (const t of refused) log(`  refused ${t}`);
  log(`imported: ${kept} kept, ${refused.length} refused`);
  const after = await heldBy({ api, network, ids: found.map((f) => f.txid), fetchImpl, sleep });
  const still = found.filter((f) => !after.has(f.txid)).length;
  log(`the archive now holds ${held.size + after.size} of ${ids.length} (${still} of the ones sent still missing)`);
  return refused.length || failed.length || still ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message || e); process.exitCode = 1; });
}
