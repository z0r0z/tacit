// The pages that wait for a receipt with a loop of their own (the splitter, the Pay page's payments, the association pool, the split deposit and its name update, the fast bridge's settle
// from the wallet, the prove page, the rewards page's turn into TAC) read the first hash for ever when the wallet's speed-up sent another transaction at the same nonce: the payment
// "was not found", the deposit "timed out", and the Pay page offered to pay again. Each now follows the speed-up (dapp/activity.js waitMined / lookReplaced) and says a cancel never ran.
// The real source of each is cut out of its file and run here over a fake chain (tests/fake-eth-chain.mjs), with the page's own poll shortened where it is a fixed number of seconds.
//   node --test tests/own-loop-pages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chain } from './fake-eth-chain.mjs';

const ET = new EventTarget();
globalThis.addEventListener = ET.addEventListener.bind(ET); globalThis.removeEventListener = ET.removeEventListener.bind(ET); globalThis.dispatchEvent = ET.dispatchEvent.bind(ET);
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const REAL = new URL('../dapp/activity.js', import.meta.url).href, NOWHERE = 'file:///nowhere/activity.js';
await import(REAL);                                                         // (loaded here, so a page's own load of it is instant and these short waits do not depend on a busy machine)
// what a page loads: the real module, with the quarter of a minute before a wait first asks about its transaction shortened to ten milliseconds for the test
const ACT = 'data:text/javascript,' + encodeURIComponent(`import { waitMined as real } from ${JSON.stringify(REAL)}; export * from ${JSON.stringify(REAL)}; export const waitMined = (o) => real({ probeMs: 10, ...o });`);

const src = (file) => readFileSync(new URL(`../dapp/${file}`, import.meta.url), 'utf8');
const cut = (text, from, to, what) => { const a = text.indexOf(from), b = text.indexOf(to, a + 1); assert.ok(a >= 0 && b > a, `${what} is where this test expects it`); return text.slice(a, b); };
const IMPORT = /import\('(?:\.\.?\/|\/)activity\.js'\)/g;                   // the page's lazy load of activity.js: pointed at the file (or at nothing, to see the plain wait)
const scale = (text, pairs) => pairs.reduce((t, [a, b]) => { assert.ok(t.includes(a), `${a} is in the source`); return t.replaceAll(a, b); }, text);

const me = '0x' + 'aa'.repeat(20), pool = '0x' + 'bb'.repeat(20), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = { to: pool, value: 5, input: '0x1234abcd' + '00'.repeat(120) };
const orig = { hash: '0x' + '01'.repeat(32), from: me, nonce: 0, ...call }, fast = { hash: '0x' + '02'.repeat(32), from: me, nonce: 0, ...call };
const cancel = { hash: '0x' + '03'.repeat(32), from: me, nonce: 0, to: me, value: 0, input: '0x' };
const later = (ms, f) => setTimeout(f, ms);
const pending = () => { const c = chain(); c.send(orig); return c; };
// The wallet replaces the transaction once the wait has looked at it while it was held (so the order does not depend on how busy the machine is).
const speedUp = (c, ms = 60, by = fast) => {
  const t = setInterval(() => { if (c.calls.includes('eth_getTransactionByHash')) { clearInterval(t); clearTimeout(give); later(ms / 6, () => { c.mempool.delete(orig.hash); c.mine(by, 990); }); } }, 2), give = setTimeout(() => clearInterval(t), 4000);   // (a wait that never looks, the plain one, is left alone)
};

// ── the splitter ──
const splitterSrc = scale(cut(src('splitter/app.js'), 'async function waitMined(hash, ms) {', '\n// ── wallet ──', 'the splitter\'s wait'), [['4000', '5']]);
const splitter = (rpc, act = ACT) => new Function('rpc', 'ACT', `${splitterSrc.replace(IMPORT, 'import(ACT)')}\nreturn waitReceipt;`)(rpc, act);
test('splitter: a speed-up is the transaction that was waited for (a deploy gets the receipt of the one that landed)', async () => {
  const c = pending(); speedUp(c);
  const rc = await splitter(c.read)(orig.hash, 2000);
  assert.equal(rc.transactionHash, fast.hash);
});
test('splitter: a cancel says it never ran; a revert and the time running out say what they said', async () => {
  let c = pending(); speedUp(c, 60, cancel);
  await assert.rejects(splitter(c.read)(orig.hash, 2000), /replaced in your wallet, by a cancel or another transaction, before it was mined/);
  c = pending(); speedUp(c, 60, { ...fast, status: '0x0' });
  await assert.rejects(splitter(c.read)(orig.hash, 2000), /The transaction failed \(0x01010101…\)\. Nothing was lost but its network fee/);
  c = pending();
  await assert.rejects(splitter(c.read)(orig.hash, 120), /Not confirmed after 20 minutes\. It can still land: check the transaction on Etherscan\./);
});
test('splitter: where activity.js cannot load it is the plain wait it was', async () => {
  const c = pending(); later(40, () => c.mine(orig, 999));
  assert.equal((await splitter(c.read, NOWHERE)(orig.hash, 2000)).transactionHash, orig.hash);
  const c2 = pending(); later(40, () => { c2.mempool.delete(orig.hash); c2.mine(fast, 990); });
  await assert.rejects(splitter(c2.read, NOWHERE)(orig.hash, 150), /Not confirmed after 20 minutes/, 'and then a speed-up is not followed, as before');
});

// ── the Pay page: the status of a payment's transaction ──
const paySrc = scale(cut(src('pay/eth/index.html'), 'const TRACK = new Map();', '\nconst mined = ', 'the Pay page\'s receiptOf'), [['15_000', '10']]);
const payWorld = (reads, act = ACT, store = {}) => new Function('rpcApart', 'rpcOn', 'ACT', 'paidReqs', 'writeJson', 'PAID_REQ', `${paySrc.replace(IMPORT, 'import(ACT)')}\nreturn { receiptOf, trackFrom, keepSeen, trackKey };`)(async () => reads.apart, async () => reads.on, act, () => JSON.parse(JSON.stringify(store.paid || {})), (k, v) => { store.paid = v; }, 'paid');
const payPage = (reads, act = ACT) => payWorld(reads, act).receiptOf;
const chainOf = { chainId: 1 };
test('pay: a payment a speed-up landed reads as paid, and a request is not paid again', async () => {
  const c = pending(), receiptOf = payPage({ on: c.read, apart: c.read });
  assert.equal(await receiptOf(chainOf, orig.hash), null, 'still waiting');
  await sleep(15); assert.equal(await receiptOf(chainOf, orig.hash), null, 'and asked about while it waits');
  c.mempool.delete(orig.hash); c.mine(fast, 990);
  await sleep(15); assert.equal(await receiptOf(chainOf, orig.hash), null, 'the look that finds it takes a moment');
  await sleep(15);
  assert.equal(await receiptOf(chainOf, orig.hash), 'ok', 'the speed-up took its nonce: paid');
});
test('pay: a cancel took its place: the payment did not go through; a revert did not either; a payment that lands soon asks nothing extra', async () => {
  let c = pending(), receiptOf = payPage({ on: c.read, apart: c.read });
  await receiptOf(chainOf, orig.hash); await sleep(15); await receiptOf(chainOf, orig.hash);
  c.mempool.delete(orig.hash); c.mine(cancel, 990); await sleep(15); await receiptOf(chainOf, orig.hash); await sleep(15);
  assert.equal(await receiptOf(chainOf, orig.hash), 'reverted');
  c = chain(); c.mine({ ...orig, status: '0x0' }, 990); receiptOf = payPage({ on: c.read, apart: c.read });
  assert.equal(await receiptOf(chainOf, orig.hash), 'reverted');
  c = chain(); c.mine(orig, 990); receiptOf = payPage({ on: c.read, apart: c.read }); c.calls.length = 0;
  assert.equal(await receiptOf(chainOf, orig.hash), 'ok'); assert.deepEqual(c.calls, ['eth_getTransactionReceipt']);
});
test('pay: a read that fails is thrown to the caller as before, and the apart reader is the one asked for a self-signed payment', async () => {
  const c = pending(), d = chain(); d.mine(orig, 990);
  const receiptOf = payPage({ on: c.read, apart: d.read });
  assert.equal(await receiptOf(chainOf, orig.hash, true), 'ok', 'read apart from the wallet\'s node, as before');
  c.down = true; await assert.rejects(receiptOf(chainOf, '0x' + '07'.repeat(32), false), /unreachable/);
});

// ── the association pool: a deposit sent from the wallet ──
const assocSrc = scale(cut(src('assoc-pool-ui.js'), '  async function receiptOf(hash) {', '  // A transaction from the pool key', 'the association pool\'s receiptOf'), [['240 * 2500', '150'], ['2500', '5']]);
const assoc = (rpc, act = ACT) => new Function('rpc', 'sleep', 'ACT', `${assocSrc.replace(IMPORT, 'import(ACT)')}\nreturn receiptOf;`)(rpc, sleep, act);
test('association pool: a deposit a speed-up landed is the deposit, a cancel is said, and the time running out says what it said', async () => {
  let c = pending(); speedUp(c);
  assert.equal((await assoc(c.read)(orig.hash)).transactionHash, fast.hash);
  c = pending(); speedUp(c, 60, cancel);
  await assert.rejects(assoc(c.read)(orig.hash), /replaced in your wallet.*Nothing was deposited/);
  c = pending();
  await assert.rejects(assoc(c.read)(orig.hash), /Sent, not confirmed yet\. Check the transaction before sending anything again\./);
  c = pending(); later(40, () => c.mine(orig, 999));
  assert.equal((await assoc(c.read, NOWHERE)(orig.hash)).transactionHash, orig.hash, 'plain wait where activity.js cannot load');
});

// ── the fast bridge: a settle sent from the wallet ──
const wireSrc = cut(src('fast/wire.js'), 'export function walletSettle(', '// What both roles need of a key', 'walletSettle');
function wallet(c, act = ACT, opts = {}) {
  const sent = [], provider = { request: async ({ method }) => { if (method === 'eth_chainId') return '0x1'; if (method === 'eth_requestAccounts') return [me]; if (method === 'eth_sendTransaction') { sent.push(1); return orig.hash; } throw new Error('no ' + method); } };
  const ux = { cfg: { pool }, settleCalldata: () => '0x01', rpc: async (m, p) => (m === 'eth_call' ? '0x' : c.read(m, p)) };
  const walletSettle = new Function('ACT', `${wireSrc.replace('export function', 'function').replace(IMPORT, 'import(ACT)')}\nreturn walletSettle;`)(act);
  return { sent, send: walletSettle({ ux, wallet: () => provider, sleep, everyMs: 5, waitMs: 2000, ...opts }) };
}
test('fast bridge: a settle a speed-up landed is told to the relay under the hash that landed', async () => {
  const c = pending(), w = wallet(c); speedUp(c);
  assert.deepEqual(await w.send({ jobId: 'j' }), { txHash: fast.hash }); assert.equal(w.sent.length, 1, 'sent once');
});
test('fast bridge: a cancel says it never ran, a revert fails it, and a wait that runs out says it has not landed', async () => {
  let c = pending(), w = wallet(c); speedUp(c, 60, cancel);
  await assert.rejects(w.send({}), /replaced there, by a cancel or another transaction, before it was mined, so it never ran/);
  c = pending(); w = wallet(c); speedUp(c, 60, { ...fast, status: '0x0' });
  await assert.rejects(w.send({}), /the settle sent from your wallet failed/);
  c = pending(); w = wallet(c, ACT, { waitMs: 120 });
  await assert.rejects(w.send({}), /has not landed yet \(0x0101/);
  c = pending(); later(30, () => c.mine(orig, 999)); w = wallet(c, NOWHERE);
  assert.deepEqual(await w.send({}), { txHash: orig.hash }, 'plain wait where activity.js cannot load');
});

// ── the split deposit: one transaction from the wallet, and the update of a name ──
const flowSrc = cut(src('fixed-pool-flow.js'), '  async function mined(hash) {', '  // The notes of `plan`', 'sendOne');
function flow(c, { act = ACT, timeout = 2000 } = {}) {
  const provider = { request: async ({ method, params }) => (method === 'eth_sendTransaction' ? orig.hash : c.read(method, params)) };
  const until = async (fn, what) => { for (const end = Date.now() + timeout; ; await sleep(5)) { let r = null; try { r = await fn(); } catch { } if (r) return r; if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`); } };
  return new Function('provider', 'txOf', 'until', 'timeout', 'poll', 'ACT', `${flowSrc.replace(IMPORT, 'import(ACT)')}\nreturn { sendOne };`)(provider, () => ({}), until, timeout, 5, act).sendOne;
}
test('split deposit: a deposit a speed-up landed is the deposit, under the hash that landed', async () => {
  const c = pending(); speedUp(c);
  assert.deepEqual(await flow(c)({}), { hash: fast.hash });
});
test('split deposit: a cancel, a revert and a wait that runs out say what happened', async () => {
  let c = pending(); speedUp(c, 60, cancel);
  await assert.rejects(flow(c)({}), /was replaced in your wallet, by a cancel or another transaction, before it was mined\. Nothing was deposited\./);
  c = pending(); speedUp(c, 60, { ...fast, status: '0x0' });
  await assert.rejects(flow(c)({}), /The deposit 0x0101.* failed\./);
  c = pending();
  await assert.rejects(flow(c, { timeout: 120 })({}), /Timed out waiting for the deposit\./);
  c = pending(); later(30, () => c.mine(orig, 999));
  assert.deepEqual(await flow(c, { act: NOWHERE })({}), { hash: orig.hash }, 'plain wait where activity.js cannot load');
});
const namesSrc = cut(src('fixed-pool-pay.js'), "      step('waiting for the update');", "      paint().catch(() => {});\n    });\n  }\n  paint().catch(() => say(''));", 'the name update\'s wait');
function names(c, act = ACT) {
  const done = [], env = { read: async () => c.read, done: (cc, h, text) => done.push(h) }, primary = { name: 'zed.wei' }, r = { txHash: orig.hash };
  const body = scale(namesSrc, [['3 * 60 * 1000', '150'], ['4000', '5']]);
  const run = new Function('step', 'env', 'primary', 'r', 'c', 'ACT', `return (async () => {\n${body.replace(IMPORT, 'import(ACT)')}\n})();`);
  return { done, run: () => run(() => {}, env, primary, r, {}, act) };
}
test('name update: one a speed-up landed is done under the hash that landed; a cancel and a wait that runs out say what they say', async () => {
  let c = pending(), n = names(c); speedUp(c); await n.run(); assert.deepEqual(n.done, [fast.hash]);
  c = pending(); n = names(c); speedUp(c, 60, cancel);
  await assert.rejects(n.run(), /was replaced in your wallet.*so nothing changed\. Try again\./);
  c = pending(); n = names(c);
  await assert.rejects(n.run(), /is not confirmed yet\. Check it in your wallet\./);
  c = pending(); n = names(c, NOWHERE); later(30, () => c.mine(orig, 999)); await n.run(); assert.deepEqual(n.done, [orig.hash]);
});

// ── the prove page: a send from the wallet ──
const proveSrc = scale(cut(src('prove/ops.js'), 'async function waitReceipt(hash) {', '\nconst landed = (r) =>', 'the prove page\'s waitReceipt'), [['100 * 3000', '150'], ['3000', '5']]);
function prove(c, pendingHash, act = ACT) {
  let kept = pendingHash ? { hash: pendingHash } : null;
  const waitReceipt = new Function('rpc', 'sleep', 'pendingGet', 'pendingSet', 'ACT', `${proveSrc.replace(IMPORT, 'import(ACT)')}\nreturn waitReceipt;`)(c.read, sleep, () => kept, (p) => { kept = p; }, act);
  return { waitReceipt, kept: () => kept };
}
test('prove page: a send a speed-up landed is confirmed, and no longer the wallet\'s last send; a cancel clears it too', async () => {
  let c = pending(), p = prove(c, orig.hash); speedUp(c);
  assert.equal((await p.waitReceipt(orig.hash)).transactionHash, fast.hash); assert.equal(p.kept(), null);
  c = pending(); p = prove(c, orig.hash); speedUp(c, 60, cancel);
  await assert.rejects(p.waitReceipt(orig.hash), /replaced in your wallet.*so it never ran/); assert.equal(p.kept(), null);
  c = pending(); p = prove(c, orig.hash);
  await assert.rejects(p.waitReceipt(orig.hash), /Not confirmed after 5 minutes\. It can still land/); assert.ok(p.kept(), 'a send still unconfirmed stays the wallet\'s last');
  c = pending(); p = prove(c, orig.hash, NOWHERE); later(30, () => c.mine(orig, 999));
  assert.equal((await p.waitReceipt(orig.hash)).transactionHash, orig.hash); assert.equal(p.kept(), null);
});

// ── the rewards page: a turn into TAC sent before, looked at before another goes out ──
const farmsSrc = cut(src('rewards/farms.js'), "    if (earlier) {\n      // (what the wallet's trace says first", '    for (const [i, n] of mine.entries()) {', 'the earlier turn\'s check');
const { makeWallet } = await import('../dapp/trade/wallet.js');
const { makeJournal } = await import(REAL);
async function earlierTurn({ c, trace = true, age = 60e3, seen }) {
  mem.clear();
  const J = makeJournal({}), id = `tx:1:${orig.hash}`;
  J.put(id, { kind: 'tx', label: 'Turn 5 wTAC into TAC', chain: 1, hash: orig.hash, to: me, status: 'pending', at: Date.now() - age, seen });
  const real = makeWallet({ rpc: c.read }), wallet = trace ? { trace: (h, sn, o) => real.trace(h, sn, { read: c.read, ...o }) } : {};
  const check = new Function('wallet', 'rpc', 'J', 'earlier', `return (async () => {\n${farmsSrc}\n})();`);
  const run = async () => { await check(wallet, c.read, J, J.get(id)); return J.get(id); };
  return { run };
}
const kept = { from: me, nonce: '0', to: pool, value: '5', data: '' };
test('rewards page: a turn into TAC a speed-up landed is confirmed under the hash that landed, and a cancel ends it, so another can be sent', async () => {
  const { fingerprint } = await import(REAL), sn = { ...kept, data: fingerprint(call.input) };
  let c = pending(); c.mempool.delete(orig.hash); c.mine(fast, 990);
  let e = await (await earlierTurn({ c, seen: sn })).run();
  assert.equal(e.status, 'confirmed'); assert.equal(e.hash, fast.hash);
  c = pending(); c.mempool.delete(orig.hash); c.mine(cancel, 990);
  e = await (await earlierTurn({ c, seen: sn })).run();
  assert.equal(e.status, 'failed'); assert.equal(e.replaced, true); assert.equal(e.hash, cancel.hash);
});
test('rewards page: one still held is waited for, one nobody holds is let go after a quarter of an hour, and a wallet with no trace does as it did', async () => {
  const { fingerprint } = await import(REAL), sn = { ...kept, data: fingerprint(call.input) };
  let c = pending();
  await assert.rejects((await earlierTurn({ c, seen: sn })).run(), /An earlier turn into TAC is not confirmed yet\. Wait for it, or speed it up/);
  c = pending(); c.mempool.delete(orig.hash);
  await assert.rejects((await earlierTurn({ c, seen: sn, age: 60e3 })).run(), /not confirmed yet/, 'dropped a minute ago: a node asked may not have seen one still going round');
  assert.equal((await (await earlierTurn({ c, seen: sn, age: 16 * 60e3 })).run()).status, 'stale', 'dropped for a quarter of an hour: let go');
  c = pending(); c.mempool.delete(orig.hash); c.mine(fast, 990);
  await assert.rejects((await earlierTurn({ c, trace: false, seen: sn })).run(), /not confirmed yet/, 'a wallet that cannot trace cannot tell a speed-up from nothing: held, as before');
  c = pending(); c.mine(orig, 990);
  assert.equal((await (await earlierTurn({ c, trace: false })).run()).status, 'confirmed', 'its own receipt still confirms it');
});


test('pay: what a payment\'s transaction was learned to be is kept with the paid request, and put back when the page is opened again', async () => {
  const c = pending(), store = { paid: { 'req1': { h: orig.hash, chain: 1, a: '5', at: Date.now() }, other: { h: '0x' + '09'.repeat(32), chain: 1, a: '1', at: Date.now() } } };
  const w = payWorld({ on: c.read, apart: c.read }, ACT, store);
  assert.equal(await w.receiptOf(chainOf, orig.hash), null);
  await sleep(15); await w.receiptOf(chainOf, orig.hash);
  assert.equal(store.paid.req1.seen?.nonce, '0', 'written to the request\'s record the look that learned it'); assert.equal(store.paid.other.seen, undefined, 'and to no other');
  // a new page: nothing in memory, the record restored: the speed-up lands while it was closed
  c.mempool.delete(orig.hash); c.mine(fast, 990);
  const again = payWorld({ on: c.read, apart: c.read }, ACT, store);
  again.trackFrom(chainOf, orig.hash, store.paid.req1.seen);
  assert.equal(await again.receiptOf(chainOf, orig.hash), null, 'the look that finds it takes a moment'); await sleep(15);
  assert.equal(await again.receiptOf(chainOf, orig.hash), 'ok', 'found from what was kept, with no look at it while it waited');
});
