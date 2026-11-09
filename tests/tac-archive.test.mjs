#!/usr/bin/env node
// The Tacit transaction archive (worker/src/tac-archive.js) and its routes: a transaction is kept only as one whole transaction
// with a Tacit envelope, under the txid its own bytes hash to; a note's history comes back in one answer from storage alone (no
// upstream request), capped, gzipped when asked, metered per caller; the import needs the operator's token.
//   node tests/tac-archive.test.mjs
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import worker, { scanForEtches, tacArchiveCatchUp } from '../worker/src/index.js';
import { makeTacArchive, parseTx, FUNDING_MAX_BYTES } from '../worker/src/tac-archive.js';

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

  // ── the second store: the ordinary transactions that fund a Tacit transaction's key-spend inputs, and the archive keeping itself complete ──
  {
    const le = (v, b) => { const a = []; for (let i = 0; i < b; i++) a.push(Number((BigInt(v) >> BigInt(8 * i)) & 0xffn)); return a; };
    const vi = (v) => (v < 0xfd ? [v] : v <= 0xffff ? [0xfd, ...le(v, 2)] : [0xfe, ...le(v, 4)]);
    // A whole transaction from inputs { txid, vout, witness: [hex] } and outputs { value, script }: segwit when any input has a witness.
    const mkTx = ({ ins, outs }) => {
      const rev = (h) => [...Buffer.from(h, 'hex')].reverse();
      const body = [...vi(ins.length)];
      for (const i of ins) body.push(...rev(i.txid), ...le(i.vout, 4), 0, ...le(0xffffffff, 4));
      body.push(...vi(outs.length));
      for (const o of outs) { const sc = [...Buffer.from(o.script, 'hex')]; body.push(...le(o.value, 8), ...vi(sc.length), ...sc); }
      const segwit = ins.some((i) => (i.witness || []).length);
      const wit = [];
      if (segwit) for (const i of ins) { const w = i.witness || []; wit.push(...vi(w.length)); for (const it of w) { const b = [...Buffer.from(it, 'hex')]; wit.push(...vi(b.length), ...b); } }
      return Buffer.from([...le(2, 4), ...(segwit ? [0, 1] : []), ...body, ...wit, ...le(0, 4)]).toString('hex');
    };
    const sig = 'ab'.repeat(32), pub = '02' + 'cd'.repeat(32), script = '0014' + 'ee'.repeat(20);
    const R = mkTx({ ins: [{ txid: '11'.repeat(32), vout: 0 }], outs: [{ value: 1000, script }] });                           // a plain commit transaction
    const F1 = mkTx({ ins: [{ txid: '22'.repeat(32), vout: 0 }], outs: [{ value: 5000, script }, { value: 6000, script }] }); // plain funding transactions
    const F2 = mkTx({ ins: [{ txid: '33'.repeat(32), vout: 0 }], outs: [{ value: 7000, script }] });
    const rid = txidOf(R), f1 = txidOf(F1), f2 = txidOf(F2);
    // Transfers: input 0 a reveal (three witness items: its parent is not needed), then key spends (one or two items) of F1 and F2.
    const T1 = mkTx({ ins: [{ txid: rid, vout: 0, witness: ['aa', 'bb', 'cc'] }, { txid: f1, vout: 0, witness: [sig] }], outs: [{ value: 900, script }] });
    const T2 = mkTx({ ins: [{ txid: rid, vout: 0, witness: ['aa', 'bb', 'dd'] }, { txid: f1, vout: 1, witness: [sig] }, { txid: f2, vout: 0, witness: [sig, pub] }], outs: [{ value: 800, script }] });
    const t1 = txidOf(T1), t2 = txidOf(T2);
    const byId = { [rid]: R, [f1]: F1, [f2]: F2, [t1]: T1, [t2]: T2 };
    const rec = (hex) => ({ bytes: hexBytes(hex), h: 970100, b: 'ab'.repeat(32) });

    const pt1 = parseTx(hexBytes(T1), dsha), pt2 = parseTx(hexBytes(T2), dsha);
    ok(pt1.needs.join() === f1 && pt2.needs.join() === [f1, f2].join(), 'a transaction\'s needed parents are those of its key-spend inputs (a witness of one or two items), not of its reveal');
    ok(parseTx(hexBytes(R), dsha).needs.length === 0 && !parseTx(hexBytes(FIX[MID].hex), dsha).needs.includes(FUNDING), 'a transaction without witnesses needs none, and the real purchase chain\'s reveal parent (the commit transaction) is not needed');

    const mkKv = () => { const m = new Map(), puts = []; return { m, puts,
      async get(k, t) { return m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null; },
      async put(k, v, o) { m.set(k, v); puts.push([k, o]); }, async delete(k) { m.delete(k); },
      async list({ prefix = '', limit = 1000, cursor } = {}) { const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort(); const from = cursor ? Number(cursor) : 0; const keys = all.slice(from, from + limit).map((name) => ({ name })); const end = from + keys.length;
        return { keys, list_complete: end >= all.length, cursor: end >= all.length ? undefined : String(end) }; } }; };
    const mkArch = (kv) => makeTacArchive({ kv, network: 'mainnet', dsha256: dsha, isTacit });

    // keepFunding keeps an ordinary transaction apart from the Tacit ones
    {
      const kv = mkKv(), a = mkArch(kv);
      ok((await a.keepFunding(F1, 970100, 'ab'.repeat(32))) === f1 && kv.m.has(`tacfund:mainnet:${f1}`) && !kv.m.has(`tacarch:mainnet:${f1}`), 'an ordinary transaction is kept in the second store under its txid, and not among the Tacit transactions');
      ok((await a.keepFunding(F1 + '00', 970100)) === null && (await a.keepFunding('zz', 970100)) === null && (await a.keepFunding(F1, 0)) === null, 'bytes past the end, junk and a height of 0 are not kept');
      const huge = mkTx({ ins: [{ txid: '44'.repeat(32), vout: 0 }], outs: [{ value: 1, script: '6a' + '00'.repeat(FUNDING_MAX_BYTES) }] });
      ok(hexBytes(huge).length > FUNDING_MAX_BYTES && (await a.keepFunding(huge, 970100)) === null, 'and one over the size limit is left to the explorers');
      // fundingOf: for a root the archive holds, the needed parents the answer lacks that the second store holds
      await kv.put(a.key(t1), JSON.stringify({ hex: T1, h: 970100 }));
      const { txs } = await a.ancestry([t1], { depth: 1 });
      const f = await a.fundingOf(txs, [t1]);
      ok([...f.keys()].join() === f1 && txidOf(f.get(f1).hex) === f1, 'fundingOf returns the funding parent of a root\'s key-spend input, checking against its own txid');
      ok((await a.fundingOf(txs, ['ab'.repeat(32)])).size === 0 && (await mkArch(mkKv()).fundingOf(txs, [t1])).size === 0, 'and nothing for a root it does not hold, or when the second store lacks the parent');
    }

    // the route: `fund: true` brings them, and a caller that does not ask gets exactly what it always did
    {
      const kv = mkKv(); const envF = { REGISTRY_KV: kv, CONFIDENTIAL_BOX_TOKEN: TOKEN }; const a = mkArch(kv);
      await kv.put(a.key(t1), JSON.stringify({ hex: T1, h: 970100 })); await a.keepFunding(F1, 970100);
      const call = (body) => worker.fetch(new Request('https://api.test/chain/tac/ancestry?network=mainnet', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.9' }, body: JSON.stringify(body) }), envF, { waitUntil() {} }).then((r) => r.json());
      const plain = await call({ roots: [t1], depth: 1 }), fund = await call({ roots: [t1], depth: 1, fund: true });
      ok(!('fund' in plain) && Object.keys(plain.txs).join() === t1, 'a caller that does not ask for funding transactions gets no `fund` field, as before');
      ok(Object.keys(fund.fund || {}).join() === f1 && Object.keys(fund.txs).join() === t1, 'with `fund: true` it gets them under `fund`, apart from the Tacit transactions in `txs`');
      ok(Object.keys((await call({ roots: [t1], depth: 1, fund: 'yes' })).fund || {}).length === 0, 'and only for exactly `true`');
    }

    // catch-up
    {
      const kv = mkKv(), a = mkArch(kv); const reads = [];
      const readTx = async (id) => { reads.push(id); return byId[id] ? rec(byId[id]) : null; };
      const r1 = await a.catchUp({ ids: [t1, t2], readTx, budget: 40 });
      ok(r1.kept === 2 && r1.funding === 2 && reads.length === 4 && !r1.stopped, `two transfers the archive lacks are read and kept, with the two funding transactions behind them (${reads.length} reads, the shared parent read once)`);
      ok(kv.m.has(`tacarch:mainnet:${t1}`) && kv.m.has(`tacfund:mainnet:${f1}`) && kv.m.has(`tacfund:mainnet:${f2}`) && !kv.m.has(`tacfund:mainnet:${rid}`), 'each in its own store, and the reveal\'s parent (not needed) not read');
      reads.length = 0;
      const r2 = await a.catchUp({ ids: [t1, t2], readTx, budget: 40 });
      ok(reads.length === 0 && r2.done === 2 && r2.kept === 0, 'a second pass over a whole archive reads nothing from upstream (each transfer is marked done)');
    }
    {
      const kv = mkKv(), a = mkArch(kv); const reads = [];
      const readTx = async (id) => { reads.push(id); return byId[id] ? rec(byId[id]) : null; };
      const r1 = await a.catchUp({ ids: [t1, t2], readTx, budget: 2 });
      ok(r1.stopped && reads.length === 2 && kv.m.has(`tacfund:done:mainnet:${t1}`) && !kv.m.has(`tacfund:done:mainnet:${t2}`), 'a pass stops at its budget of reads, with the transfers it finished marked');
      const r2 = await a.catchUp({ ids: [t1, t2], readTx, budget: 2 });
      ok(r2.kept === 1 && r2.funding === 1 && !r2.stopped && kv.m.has(`tacfund:done:mainnet:${t2}`), 'and the next pass carries on where the marks end');
    }
    {
      // the budget also holds back the funding reads of a transfer the archive already has
      const kv = mkKv(), a = mkArch(kv); const reads = [];
      await kv.put(a.key(t2), JSON.stringify({ hex: T2, h: 970100 }));
      const readTx = async (id) => { reads.push(id); return rec(byId[id]); };
      const r1 = await a.catchUp({ ids: [t2], readTx, budget: 1 });
      ok(reads.length === 1 && r1.stopped && r1.funding === 1 && !kv.m.has(`tacfund:done:mainnet:${t2}`), 'a transfer already held but with two funding parents missing: the budget of one read keeps it to one, and it is not marked');
      const r2 = await a.catchUp({ ids: [t2], readTx, budget: 1 });
      ok(reads.length === 2 && r2.funding === 1 && kv.m.has(`tacfund:done:mainnet:${t2}`), 'and the next pass reads the other, and marks it');
    }
    {
      const kv = mkKv(), a = mkArch(kv);
      const r = await a.catchUp({ ids: [t1], readTx: async (id) => (id === f1 ? null : rec(byId[id])), budget: 40 });
      ok(r.kept === 1 && r.failed === 1 && !kv.m.has(`tacfund:done:mainnet:${t1}`), 'a funding read that fails leaves the transfer unmarked, to try again');
      const reads = []; const r2 = await a.catchUp({ ids: [t1], readTx: async (id) => { reads.push(id); return rec(byId[id]); }, budget: 40 });
      ok(reads.join() === f1 && r2.funding === 1 && kv.m.has(`tacfund:done:mainnet:${t1}`), 'and the next pass reads only the funding transaction, not the transfer again');
      const u = await mkArch(mkKv()).catchUp({ ids: [t1], readTx: async () => ({ unconfirmed: true }), budget: 40 });
      ok(u.unconfirmed === 1 && u.kept === 0, 'a transfer not confirmed yet is left for a later pass');
    }
    {
      const kv = mkKv(), a = mkArch(kv);
      const wrong = await a.catchUp({ ids: [t1], readTx: async () => rec(T2), budget: 40 });
      const doneT1 = kv.puts.find(([k]) => k === `tacfund:done:mainnet:${t1}`);
      ok(!kv.m.has(`tacarch:mainnet:${t1}`) && wrong.kept === 0 && doneT1 && doneT1[1] && doneT1[1].expirationTtl === 7 * 86400, 'bytes that are not the transaction asked for are never kept under its id (nor counted as kept), and it is looked at again in a week');
      const kv2 = mkKv(); const a2 = mkArch(kv2);
      await a2.catchUp({ ids: [f1], readTx: async (id) => rec(byId[id]), budget: 40 });
      ok(!kv2.m.has(`tacarch:mainnet:${f1}`) && kv2.puts.some(([k, o]) => k === `tacfund:done:mainnet:${f1}` && o && o.expirationTtl), 'a listed transaction with no Tacit envelope is not kept, and not read again for a week');
      ok(a.catchUp.length === 1, 'catchUp takes one options object');
    }

    // tacArchiveCatchUp: the worker's driver, over the index's own keys and a stubbed explorer
    {
      const AID = 'ab'.repeat(32), kv = mkKv();
      for (const t of [PURCHASE, MID, SPLIT]) await kv.put(`xferseen:mainnet:${AID}:${t}`, '1');
      await kv.put(`xferseen:${AID}:${'cd'.repeat(32)}`, '1');                          // a signet key is not this network's
      const seen = [];
      globalThis.fetch = async (url) => {
        const p = new URL(String(url)).pathname.replace(/^\/api/, ''); seen.push(p);
        const m = /^\/tx\/([0-9a-f]{64})(\/hex)?$/.exec(p);
        if (m && FIX[m[1]]) return m[2] ? new Response(FIX[m[1]].hex) : new Response(typeof FIX[m[1]].json === 'string' ? FIX[m[1]].json : JSON.stringify(FIX[m[1]].json), { headers: { 'content-type': 'application/json' } });
        return new Response('not found', { status: 404 });
      };
      const envC = { REGISTRY_KV: kv, MAINNET_API: 'https://esplora.test/api' };
      const off = await tacArchiveCatchUp({ ...envC, TAC_ARCHIVE_CATCHUP: '0' }, 'mainnet');
      ok(off === null && seen.length === 0, 'TAC_ARCHIVE_CATCHUP=0 turns it off: no upstream request');
      const [first, second] = await Promise.all([tacArchiveCatchUp(envC, 'mainnet', { keys: 10 }), tacArchiveCatchUp(envC, 'mainnet', { keys: 10 })]);
      ok((first === null) !== (second === null), 'two runs at once do not overlap: the second does nothing');
      const res = first || second;
      ok(res.kept === 3 && [PURCHASE, MID, SPLIT].every((t) => kv.m.has(`tacarch:mainnet:${t}`)), 'the three transfers the index lists are read from upstream and kept (not the signet key\'s)');
      ok(kv.m.has(`tacfund:done:mainnet:${MID}`) && !kv.m.has(`tacfund:done:mainnet:${PURCHASE}`) && !kv.m.has(`tacfund:done:mainnet:${SPLIT}`), 'the one whose needed parents are all held is marked done; those with a parent upstream cannot give (404) are left to try again');
      ok(!kv.m.has('tacfund:cursor:mainnet'), 'the page was the whole index, so the cursor wraps to the start');
      seen.length = 0;
      const again = await tacArchiveCatchUp(envC, 'mainnet', { keys: 10 });
      ok(again.kept === 0 && !seen.some((p) => [PURCHASE, MID, SPLIT].some((t) => p.startsWith(`/tx/${t}`))), 'a second run does not read a transfer it already holds');
      // a page smaller than the index moves a cursor along it
      const kv3 = mkKv(); for (const t of [PURCHASE, MID, SPLIT]) await kv3.put(`xferseen:mainnet:${AID}:${t}`, '1');
      const env3 = { REGISTRY_KV: kv3, MAINNET_API: 'https://esplora.test/api' };
      await tacArchiveCatchUp(env3, 'mainnet', { keys: 2, budget: 100 });
      ok(kv3.m.has('tacfund:cursor:mainnet'), 'a page that is not the whole index leaves a cursor');
      await tacArchiveCatchUp(env3, 'mainnet', { keys: 2, budget: 100 });
      ok(!kv3.m.has('tacfund:cursor:mainnet') && [PURCHASE, MID, SPLIT].every((t) => kv3.m.has(`tacarch:mainnet:${t}`)), 'and the next page finishes the index and the cursor goes');
    }
  }
} finally {
  globalThis.fetch = realFetch;
}
console.log(`${n} tac-archive checks passed${process.exitCode ? ' (with failures above)' : ''}`);
