// A node that refuses a transaction under its own minimum fee is not the last word on a broadcast while the other explorers have not been asked.
//
// The wallet's chain reader (dapp/tacit.js api()) sends a transaction to the explorers in turn. Any 4xx answer ended it at once, so a node that holds a
// 1 sat/vB minimum ("min relay fee not met") stopped a transaction that pays 0.2 sat/vB, which the next explorer's node takes (most nodes relay at 0.1 now).
// Now a refusal for the fee moves on to the next explorer; if none takes the transaction the node's own words are thrown; any other 4xx still ends it.
// Mocked explorers; no network.
//
// Run (Node 22): node --no-experimental-global-navigator tests/explorer-fee-fallback.test.mjs
import { JSDOM } from './_jsdom.mjs';

const dom = new JSDOM('', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, __TACIT_NO_INIT__: true });
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
localStorage.setItem('tacit-network-v1', 'mainnet');

// one input, no outputs: enough for the wallet to read which coin the transaction spends
const RAW = '02000000' + '01' + 'ab'.repeat(32) + '00000000' + '00' + 'fdffffff' + '00' + '00000000';
const TXID = 'cd'.repeat(32);
const FEE_MSG = 'sendrawtransaction RPC error -26: min relay fee not met, 31 < 100';
const MEMPOOL_FEE_MSG = '{"code":-26,"message":"mempool min fee not met, 31 < 1000"}';

// per explorer host: what its node answers to the transaction
const answer = {};
const posted = [];
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input?.url ?? input));
  if ((init?.method || 'GET').toUpperCase() !== 'POST' || u.pathname !== '/api/tx') throw new Error('offline: ' + u.href);
  posted.push(u.host);
  const a = answer[u.host] || { status: 200, body: TXID };
  return new Response(a.body, { status: a.status, headers: a.headers || {} });
};

const T = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; } };
const run = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: String(e?.message || e) }; } };
const reset = () => { for (const k of Object.keys(answer)) delete answer[k]; posted.length = 0; };
// the hosts are named by the first two explorers of the mainnet list; the wallet rests a host that failed, so each case first lets the rest end
const settle = () => new Promise((r) => setTimeout(r, 30));

{
  reset();
  answer['mempool.space'] = { status: 400, body: FEE_MSG };
  const r = await run(() => T.broadcast(RAW));
  ok('the first node refuses for the fee and the second takes it', r.value === TXID, JSON.stringify(r));
  ok('both were asked, the refusing one first', posted[0] === 'mempool.space' && posted.includes('blockstream.info'), posted.join(','));
  await settle();
}
{
  reset();
  answer['mempool.space'] = { status: 400, body: MEMPOOL_FEE_MSG };
  const r = await run(() => T.broadcast(RAW));
  ok('"mempool min fee not met" is a fee refusal too', r.value === TXID, JSON.stringify(r));
  await settle();
}
{
  reset();
  answer['mempool.space'] = { status: 400, body: FEE_MSG };
  answer['blockstream.info'] = { status: 400, body: FEE_MSG };
  const r = await run(() => T.broadcast(RAW));
  ok('every node refusing for the fee throws the node\'s own words', /API 400: .*min relay fee not met/.test(r.error || ''), JSON.stringify(r));
  await settle();
}
{
  reset();
  answer['mempool.space'] = { status: 400, body: FEE_MSG };
  answer['blockstream.info'] = { status: 429, body: 'slow down', headers: { 'retry-after': '1' } };
  const r = await run(() => T.broadcast(RAW));
  ok('a fee refusal followed by a rate limit still says the fee was refused', /min relay fee not met/.test(r.error || ''), JSON.stringify(r));
  await settle();
}
{
  reset();
  answer['mempool.space'] = { status: 400, body: 'sendrawtransaction RPC error -25: bad-txns-inputs-missingorspent' };
  const r = await run(() => T.broadcast(RAW));
  ok('any other refusal ends it at once, as before', /bad-txns-inputs-missingorspent/.test(r.error || ''), JSON.stringify(r));
  ok('and the next node was not asked', !posted.includes('blockstream.info'), posted.join(','));
  await settle();
}
{
  reset();
  answer['mempool.space'] = { status: 400, body: FEE_MSG };
  answer['blockstream.info'] = { status: 400, body: 'sendrawtransaction RPC error -25: bad-txns-inputs-missingorspent' };
  const r = await run(() => T.broadcast(RAW));
  ok('a fee refusal does not hide a later node\'s different refusal', /bad-txns-inputs-missingorspent/.test(r.error || ''), JSON.stringify(r));
  await settle();
}
{
  // a read is not a broadcast: a GET answered with the same words is not rotated
  reset();
  const seen = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input?.url ?? input));
    seen.push(u.host);
    return new Response(FEE_MSG, { status: 400 });
  };
  const r = await run(() => T.getTx('ef'.repeat(32)));
  ok('only a broadcast moves on after a fee refusal', seen.length === 1, seen.join(',') + ' ' + JSON.stringify(r));
  globalThis.fetch = before;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
