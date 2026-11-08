#!/usr/bin/env node
// The Tacit transaction archive (worker/src/tac-archive.js) and its routes: a transaction is kept only as one whole transaction
// with a Tacit envelope, under the txid its own bytes hash to; a note's history comes back in one answer from storage alone (no
// upstream request), capped, gzipped when asked, metered per caller; the import needs the operator's token.
//   node tests/tac-archive.test.mjs
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import worker, { scanForEtches } from '../worker/src/index.js';
import { makeTacArchive, parseTx } from '../worker/src/tac-archive.js';

let n = 0;
const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
const makeKv = () => { const m = new Map(); return { m, async get(k, t) { return m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; };
const dsha = (b) => sha256(sha256(b));
const hexBytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const txidOf = (hex) => parseTx(hexBytes(hex), dsha).txid;

// A real purchase on the order book and the history behind it: the purchase spends 683798fa, which spends the split note 57829e14
// and a plain funding transaction (9981c2ea, no envelope).
const FIX = JSON.parse(readFileSync(new URL('./fixtures/burndep-listing-purchase-2026-10-16.json', import.meta.url), 'utf8'));
const id = (p) => Object.keys(FIX).find((k) => k.startsWith(p));
const PURCHASE = id('c654294c'), MID = id('683798fa'), SPLIT = id('57829e14'), FUNDING = id('9981c2ea');
const heightOf = (t) => JSON.parse(FIX[t].json).status.block_height;
const isTacit = (w) => !!(w && w.length >= 3);   // the routes use the real envelope decoder; here any reveal-shaped witness

const realFetch = globalThis.fetch;
try {
  {
    const a = makeTacArchive({ kv: makeKv(), network: 'mainnet', dsha256: dsha, isTacit });
    for (const t of [PURCHASE, MID, SPLIT]) ok((await a.keep(FIX[t].hex, heightOf(t))) === t, `${t.slice(0, 8)} is kept under the txid its bytes hash to`);
    ok((await a.keep(FIX[FUNDING].hex, heightOf(FUNDING))) === null, 'a transaction with no Tacit envelope is not kept');
    ok((await a.keep(FIX[SPLIT].hex + '00', heightOf(SPLIT))) === null, 'bytes past the end of a transaction are not one transaction');
    ok((await a.keep('zz', 970000)) === null && (await a.keep(FIX[SPLIT].hex, 0)) === null, 'neither junk nor a height of 0 is kept');
    const { txs, truncated } = await a.ancestry([PURCHASE]);
    ok(!truncated && [...txs.keys()].sort().join() === [PURCHASE, MID, SPLIT].sort().join(), 'the purchase\'s history comes back whole, through its inputs, with the funding left out');
    ok([...txs].every(([t, r]) => txidOf(r.hex) === t && Number.isInteger(r.h)), 'each answer hashes to its own txid and carries its height');
    const capped = await a.ancestry([PURCHASE], { cap: 2 });
    ok(capped.truncated && capped.txs.size === 2, 'a walk past its cap stops and says so');
    ok((await a.ancestry(['ab'.repeat(32)])).txs.size === 0, 'a txid the archive does not hold has no history here');
    const roots = await a.ancestry([PURCHASE], { depth: 0 }), one = await a.ancestry([PURCHASE], { depth: 1 });
    ok([...roots.txs.keys()].join() === PURCHASE && one.txs.size === 2 && one.txs.has(MID), 'depth 0 answers the roots alone, and depth 1 their parents too');
  }

  // ── the routes ──
  globalThis.fetch = async (url) => { throw new Error(`no upstream request may be made (${url})`); };
  const TOKEN = 't'.repeat(40);
  const env = { REGISTRY_KV: makeKv(), CONFIDENTIAL_BOX_TOKEN: TOKEN };
  const post = (path, body, headers = {}) => worker.fetch(new Request(`https://api.test${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.7', ...headers }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  const list = [PURCHASE, MID, SPLIT, FUNDING].map((t) => ({ hex: FIX[t].hex, h: heightOf(t) }));
  ok((await post('/chain/tac/import?network=mainnet', { txs: list })).status === 404, 'the import is closed without the operator token');
  ok((await post('/chain/tac/import?network=mainnet', { txs: list }, { authorization: 'Bearer ' + 'x'.repeat(40) })).status === 404, 'and with a wrong one');
  const imp = await post('/chain/tac/import?network=mainnet', { txs: list }, { authorization: 'Bearer ' + TOKEN });
  const ib = await imp.json();
  ok(imp.status === 200 && ib.kept === 3 && ib.refused.join() === '3', `with it, the three Tacit transactions are kept and the funding one refused (${JSON.stringify(ib)})`);
  const res = await post('/chain/tac/ancestry?network=mainnet', { roots: [PURCHASE] });
  const body = await res.json();
  ok(res.status === 200 && Object.keys(body.txs).length === 3 && body.truncated === false, `a note's history in one answer, from storage alone (${res.status})`);
  ok(Object.entries(body.txs).every(([t, r]) => txidOf(r.hex) === t), 'every transaction in it checks against its txid');
  const gz = await post('/chain/tac/ancestry?network=mainnet', { roots: [PURCHASE] }, { 'accept-encoding': 'gzip, br' });
  ok(gz.headers.get('content-encoding') === 'gzip', 'gzipped for a caller that takes it');
  const unz = JSON.parse(await new Response(gz.body.pipeThrough(new DecompressionStream('gzip'))).text());
  ok(Object.keys(unz.txs).length === 3, 'and the same answer once unzipped');
  ok((await post('/chain/tac/ancestry?network=mainnet', { roots: ['nope'] })).status === 400, 'a root that is not a txid is refused');
  ok((await post('/chain/tac/ancestry?network=mainnet', { roots: Array.from({ length: 65 }, () => PURCHASE) })).status === 400, 'and more than 64 roots');
  const statuses = [];
  for (let i = 0; i < 70; i++) statuses.push((await post('/chain/tac/ancestry?network=mainnet', { roots: [SPLIT] })).status);
  ok(statuses.slice(0, 40).every((s) => s === 200), 'a caller gets a burst large enough for a whole rescan (a page asks about 25 times) before any is refused');
  ok(statuses.includes(429), `and one asking without pause is metered all the same (${statuses.filter((s) => s === 429).length} of 70 refused)`);

  // ── the forward scan keeps the Tacit transactions of a block it reads, by the block's own bytes ──
  {
    const H = 970179, HASH = 'cd'.repeat(32);
    const txHexes = [FUNDING, SPLIT, MID, PURCHASE].map((t) => FIX[t].hex);
    const block = Buffer.concat([Buffer.alloc(80), Buffer.from([txHexes.length]), ...txHexes.map((h) => Buffer.from(h, 'hex'))]);
    const kv = makeKv();
    await kv.put('meta:last_scanned:mainnet', String(H - 1));
    globalThis.fetch = async (url) => {
      const p = new URL(String(url)).pathname.replace(/^\/api/, '');
      if (p === '/blocks/tip/height') return new Response(String(H));
      if (p === `/block-height/${H}`) return new Response(HASH);
      if (p === `/block/${HASH}/raw`) return new Response(block);
      return new Response('not found', { status: 404 });
    };
    await scanForEtches({ REGISTRY_KV: kv, MAINNET_API: 'https://esplora.test/api' }, 'mainnet').catch((e) => ok(false, `the scan ran (${e.message})`));
    await new Promise((r) => setTimeout(r, 50));
    const kept = [PURCHASE, MID, SPLIT].filter((t) => kv.m.has(`tacarch:mainnet:${t}`));
    ok(kept.length === 3 && !kv.m.has(`tacarch:mainnet:${FUNDING}`), `the scan kept the block's three Tacit transactions and not the funding one (${kept.length})`);
    const rec = JSON.parse(kv.m.get(`tacarch:mainnet:${PURCHASE}`) || '{}');
    ok(rec.hex === FIX[PURCHASE].hex && rec.h === H && rec.b === HASH, 'with the exact bytes, the height and the block');
  }
} finally {
  globalThis.fetch = realFetch;
}
console.log(`${n} tac-archive checks passed${process.exitCode ? ' (with failures above)' : ''}`);
