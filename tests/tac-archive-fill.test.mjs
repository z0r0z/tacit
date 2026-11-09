#!/usr/bin/env node
// tools/tac-archive-fill.mjs: finds the transfers of an asset the API's archive lacks, reads them through the API's proxy, keeps only
// the ones whose bytes hash to their txid and are confirmed, and imports them only with --send and the operator token.
//   node tests/tac-archive-fill.test.mjs
import { readFileSync } from 'node:fs';
import { transferIds, heldBy, readMissing, sendFound, main, TAC } from '../tools/tac-archive-fill.mjs';

let n = 0;
const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
const API = 'https://api.test';

// Four real TAC transactions with their bytes and the block each is in.
const FIX = JSON.parse(readFileSync(new URL('./fixtures/esplora-tx-json-2026-10-19.json', import.meta.url), 'utf8'));
const real = Object.entries(FIX).map(([id, r]) => { const j = typeof r.json === 'string' ? JSON.parse(r.json) : r.json; return { id, hex: r.hex, h: j.status.block_height, b: j.status.block_hash }; });
const [A, B, C, D] = real;
const E = 'e1'.repeat(32), F = 'f2'.repeat(32), G = 'a3'.repeat(32);     // not confirmed yet, bytes that are not its own, unknown to the explorer
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[String(k).toLowerCase()] ?? null }, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// The API as the tool sees it: an index in two pages (one txid on both), an archive holding A and B, an explorer proxy, and an import that keeps what it is given.
function makeApi({ throttleOnce = false, importRefuses = [], rejectToken = false } = {}) {
  const st = { held: new Set([A.id, B.id]), calls: [], imports: [], throttled: false, auth: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname; st.calls.push(`${init.method || 'GET'} ${p}`);
    if (p === `/assets/${TAC}/recent-xfer-txids`) {
      return u.searchParams.get('cursor') === 'c1' ? res(200, { txids: [C.id, D.id, E, F, G], done: true, next_cursor: null }) : res(200, { txids: [A.id, B.id, C.id], done: false, next_cursor: 'c1' });
    }
    if (p === '/chain/tac/ancestry') {
      if (throttleOnce && !st.throttled) { st.throttled = true; return res(429, { error: 'too many requests' }, { 'retry-after': '2' }); }
      const { roots, depth } = JSON.parse(init.body); st.depth = depth;
      return res(200, { txs: Object.fromEntries(roots.filter((r) => st.held.has(r)).map((r) => [r, { hex: '00', h: 1 }])), truncated: false });
    }
    let m;
    if ((m = /^\/chain\/tx\/([0-9a-f]{64})\/status$/.exec(p))) {
      const id = m[1], r = real.find((x) => x.id === id);
      if (r) return res(200, { confirmed: true, block_height: r.h, block_hash: r.b });
      if (id === E) return res(200, { confirmed: false });
      if (id === F) return res(200, { confirmed: true, block_height: 970000, block_hash: 'cd'.repeat(32) });
      return res(404, 'Transaction not found');
    }
    if ((m = /^\/chain\/tx\/([0-9a-f]{64})\/hex$/.exec(p))) {
      const id = m[1], r = real.find((x) => x.id === id);
      return res(200, r ? r.hex + '\n' : id === F ? C.hex : 'Transaction not found');       // F is served C's bytes: they do not hash to F
    }
    if (p === '/chain/tac/import') {
      st.auth.push(init.headers?.authorization || null);
      if (rejectToken) return res(404, { error: 'not found' });
      const { txs } = JSON.parse(init.body); st.imports.push(txs);
      const refused = []; txs.forEach((t, i) => { const id = real.find((x) => x.hex === t.hex)?.id; if (importRefuses.includes(id)) refused.push(i); else st.held.add(id); });
      return res(200, { ok: true, kept: txs.length - refused.length, refused });
    }
    return res(404, {});
  };
  return { st, fetchImpl };
}
const noSleep = async () => {};

{
  const { st, fetchImpl } = makeApi();
  const ids = await transferIds({ api: API, network: 'mainnet', fetchImpl, sleep: noSleep });
  ok(ids.length === 7 && new Set(ids).size === 7 && ids[0] === A.id, 'the index is read to its end across pages, a txid it lists twice once, newest first');
  const held = await heldBy({ api: API, network: 'mainnet', ids, fetchImpl, sleep: noSleep });
  ok(held.size === 2 && held.has(A.id) && held.has(B.id) && st.depth === 0, 'the archive is asked about the transfers themselves (depth 0): it holds two');
  const r = await readMissing({ api: API, network: 'mainnet', ids: ids.filter((t) => !held.has(t)), fetchImpl, sleep: noSleep, gapMs: 0 });
  ok(r.found.length === 2 && r.found.map((f) => f.txid).sort().join() === [C.id, D.id].sort().join(), 'the two confirmed transfers with their own bytes are kept');
  ok(r.found.every((f) => { const x = real.find((q) => q.id === f.txid); return f.hex === x.hex && f.h === x.h && f.b === x.b; }), 'each with its bytes (trimmed), its height and its block');
  ok(r.unconfirmed.length === 1 && r.unconfirmed[0] === E, 'one that is not confirmed yet is left for a later run');
  ok(r.failed.some(([t, w]) => t === F && /hash/.test(w)) && r.failed.some(([t]) => t === G), 'bytes that do not hash to the txid, and a transfer the explorer does not know, are reported and not kept');
  ok(r.failed.length === 2, 'and nothing else fails');
}

// A run without --send reads and saves but writes nothing to the API, with or without the token.
{
  const { st, fetchImpl } = makeApi(); const out = [], saved = {};
  const code = await main(['--out', 'x.json', '--gap-ms', '0'], { TACIT_BOX_TOKEN: 'x'.repeat(40) }, { fetchImpl, sleep: noSleep, log: (s) => out.push(s), write: (f, c) => { saved[f] = c; } });
  ok(st.imports.length === 0 && !st.calls.some((c) => c.includes('/import')), 'without --send nothing is imported, token or no token');
  ok(JSON.parse(saved['x.json']).txs.length === 2, 'and what it would send is saved');
  ok(code === 1 && out.some((s) => /lacks 5/.test(s)) && out.some((s) => /nothing was sent/.test(s)), 'it says what the archive lacks and that nothing was sent (exit 1: two could not be read)');
}

// --send needs the operator token, and sends only what checked.
{
  const { st, fetchImpl } = makeApi(); const out = [];
  const code = await main(['--send', '--gap-ms', '0'], {}, { fetchImpl, sleep: noSleep, log: (s) => out.push(s), write: () => {} });
  ok(code === 2 && st.calls.length === 0, 'with --send and no token it stops before asking anything');
}
{
  const { st, fetchImpl } = makeApi(); const out = [];
  const code = await main(['--send', '--gap-ms', '0'], { TACIT_BOX_TOKEN: 'secret-token-for-the-test' }, { fetchImpl, sleep: noSleep, log: (s) => out.push(s), write: () => {} });
  ok(st.imports.length === 1 && st.imports[0].length === 2 && st.imports[0].every((t) => t.hex && Number.isInteger(t.h) && t.b), 'with the token the two that checked are imported (bytes, height, block), and no more');
  ok(st.auth[0] === 'Bearer secret-token-for-the-test', 'as the operator');
  ok(!out.join('\n').includes('secret-token-for-the-test'), 'and the token is never printed');
  ok(st.held.has(C.id) && st.held.has(D.id) && out.some((s) => /now holds 4 of 7/.test(s)), 'afterwards it asks the archive again: it holds four of the seven');
  ok(code === 1, 'and exits non-zero while a transfer is unreadable (the run is not "clean")');
}
// a refusal by the API is reported, and the re-check shows what is still missing
{
  const { st, fetchImpl } = makeApi({ importRefuses: [D.id] }); const out = [];
  const code = await main(['--send', '--gap-ms', '0'], { TACIT_BOX_TOKEN: 'secret-token-for-the-test' }, { fetchImpl, sleep: noSleep, log: (s) => out.push(s), write: () => {} });
  ok(out.some((s) => s.includes(`refused ${D.id}`)) && out.some((s) => /1 kept, 1 refused/.test(s)) && out.some((s) => /1 of the ones sent still missing/.test(s)) && code === 1, 'a transaction the API refuses is named, and the re-check counts it as still missing');
}
// a token the API does not accept is answered 404: the run says so plainly and nothing is counted as imported
{
  const { st, fetchImpl } = makeApi({ rejectToken: true }); const out = [];
  let err = null;
  try { await main(['--send', '--gap-ms', '0'], { TACIT_BOX_TOKEN: 'a-wrong-token-for-the-test' }, { fetchImpl, sleep: noSleep, log: (s) => out.push(s), write: () => {} }); } catch (e) { err = e; }
  ok(err && /does not accept this token/.test(err.message) && st.imports.length === 0, 'a token the API does not accept (404) stops the run with a plain message');
  ok(!out.some((s) => /imported:/.test(s)) && !out.join('\n').includes('a-wrong-token-for-the-test'), 'without reporting an import, and without printing the token');
}
// batches
{
  const { st, fetchImpl } = makeApi();
  const r = await sendFound({ api: API, network: 'mainnet', token: 'secret-token-for-the-test', found: [C, D].map((x) => ({ txid: x.id, hex: x.hex, h: x.h, b: x.b })), batch: 1, fetchImpl, sleep: noSleep });
  ok(st.imports.length === 2 && r.kept === 2, 'the import goes in batches of the size given (here 1: two requests)');
}
// a 429 from the API is waited for, not taken for a failure
{
  const { st, fetchImpl } = makeApi({ throttleOnce: true }); const sleeps = [];
  const held = await heldBy({ api: API, network: 'mainnet', ids: [A.id, C.id], fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  ok(held.size === 1 && sleeps.length === 1 && sleeps[0] === 2300, `a 429 waits what it asked (~2 s and a little more: ${sleeps[0]} ms) and the question is asked again`);
}
console.log(`${n} tac-archive-fill checks passed${process.exitCode ? ' (with failures above)' : ''}`);
