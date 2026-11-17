// What the pages do about a transaction their wait gave up on, when the wallet's speed-up (or cancel) took its place while nobody was waiting. The trade page
// (checkPending), the rewards page (pendingState) and the swap card (landed, pendingState, pendingHolds) kept the hash and read an unknown one as dropped, so a speed-up
// that landed could be traded or claimed again, or waited on for another half hour. They now keep what the wait learned of the transaction (its sender and nonce) and ask the
// wallet's trace (dapp/trade/wallet.js over dapp/activity.js traceTx) what became of it.
// The real source of each is cut out of its page and run here with the real wallet module over a fake chain, and stand-ins for the page around it.
//   node --test tests/pending-tx-pages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chain } from './fake-eth-chain.mjs';

const ET = new EventTarget();
globalThis.addEventListener = ET.addEventListener.bind(ET); globalThis.removeEventListener = ET.removeEventListener.bind(ET); globalThis.dispatchEvent = ET.dispatchEvent.bind(ET);
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { makeWallet } = await import('../dapp/trade/wallet.js');
await import('../dapp/activity.js');                                       // (the wallet loads it when first wanted: here it is loaded already, so a wait of a quarter of a second learns of a pending transaction on a busy machine too)

const src = (file) => readFileSync(new URL(`../dapp/${file}`, import.meta.url), 'utf8');
const cut = (text, from, to, what) => { const a = text.indexOf(from), b = text.indexOf(to, a + 1); assert.ok(a > 0 && b > a, `${what} is where this test expects it`); return text.slice(a, b); };
const tradeSrc = cut(src('trade/app.js'), 'async function checkPending() {', '\n}\n', 'checkPending') + '\n}\n';
const sendSrc = cut(src('trade/app.js'), 'async function sendAndReport(', '// A trade\'s receipt:', 'sendAndReport');
const rewardsSrc = cut(src('rewards/app.js'), 'async function pendingState({ hash, at, seen }) {', '\n}\n', 'pendingState (rewards)') + '\n}\n';
const cardSrc = cut(src('swap/card.js'), 'let PENDING = null;', 'async function go() {', 'the swap card\'s pending code');
const tethSrc = cut(src('teth/app.js'), 'async function landing(st) {', 'async function retry(', 'landing (teth)');
const frontSrc = cut(src('index.html'), 'const swcWallet = {', '  canBatch: () => canBatch(),', 'the swap card\'s wallet on the front page');

const me = '0x' + 'aa'.repeat(20), pool = '0x' + 'bb'.repeat(20);
const call = { to: pool, value: 5, input: '0x1234abcd' + '00'.repeat(120) };
const orig = { hash: '0x' + '01'.repeat(32), from: me, nonce: 0, ...call }, fast = { hash: '0x' + '02'.repeat(32), from: me, nonce: 0, ...call }, cancel = { hash: '0x' + '03'.repeat(32), from: me, nonce: 0, to: me, value: 0, input: '0x' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// (what a test waits for, rather than for a time: on a busy machine a fixed pause lands before or after the thing it was timed against)
const until = async (f, ms = 5000) => { for (const end = Date.now() + ms; !f(); await sleep(5)) if (Date.now() > end) throw new Error('timed out waiting'); };
const probed = (c) => until(() => c.calls.includes('eth_getTransactionByHash'));    // the wait has looked at the transaction while it was held

// The chain, a wallet over it, and the record a page would have kept: the wait runs out while the transaction is held by a node (it learns who sent it), as the page's does.
async function stuck() {
  const c = chain(); c.send(orig);
  const wallet = makeWallet({ rpc: c.read });
  const fast_ = (o = {}) => ({ read: c.read, probeMs: 5, every: 5, timeoutMs: 1200, ...o });
  const err = await wallet.receipt(orig.hash, fast_()).then(() => null, (e) => e);
  assert.match(err.message, /Sent, not confirmed yet/); assert.equal(err.seen?.nonce, '0', 'the error the wait threw carries what it learned');
  // the page's own wallet: its wait is the real one, shortened for the test; its trace is the real trace over the same chain
  const page = { receipt: (h) => wallet.receipt(h, fast_()), trace: (h, seen, o) => wallet.trace(h, seen, { read: c.read, ...o }) };
  return { c, wallet, page, err };
}

// ── the trade page ──
function tradePage({ wallet, rpc, pending }) {
  const S = { pending }, said = [], landedWith = [];
  const landed = async (rc, p) => { landedWith.push({ status: rc.status, hash: p.hash }); };
  const checkPending = new Function('S', 'say', 'txLink', 'landed', 'wallet', 'rpc', `${tradeSrc}\nreturn checkPending;`)(S, (t) => said.push(String(t)), (h) => `[${h.slice(0, 6)}]`, landed, wallet, rpc);
  return { S, said, landedWith, checkPending };
}
test('trade: a speed-up that landed after the wait gave up is booked as the trade, and nothing is sent again', async () => {
  const { c, page, err } = await stuck();
  c.mempool.delete(orig.hash); c.mine(fast, 990);
  const t = tradePage({ wallet: page, rpc: c.read, pending: { hash: orig.hash, from: me, buy: true, seen: err.seen } });
  assert.equal(await t.checkPending(), false, 'the press stops: the earlier trade went in');
  assert.deepEqual(t.landedWith, [{ status: '0x1', hash: fast.hash }], 'booked under the hash that landed'); assert.equal(t.S.pending, null);
});
test('trade: a cancel took its place, so it never ran and the press goes on', async () => {
  const { c, page, err } = await stuck();
  c.mempool.delete(orig.hash); c.mine(cancel, 990);
  const t = tradePage({ wallet: page, rpc: c.read, pending: { hash: orig.hash, from: me, seen: err.seen } });
  assert.equal(await t.checkPending(), true); assert.equal(t.S.pending, null); assert.deepEqual(t.landedWith, []);
});
test('trade: dropped with its nonce still free: the press goes on, as it did', async () => {
  const { c, page, err } = await stuck();
  c.mempool.delete(orig.hash);
  const t = tradePage({ wallet: page, rpc: c.read, pending: { hash: orig.hash, from: me, seen: err.seen } });
  assert.equal(await t.checkPending(), true); assert.equal(t.S.pending, null);
});
test('trade: nothing kept of it and no node holds it: it says so once and sends nothing, the next press goes on', async () => {
  const { c, page } = await stuck();
  c.mempool.delete(orig.hash); c.mine(fast, 990);
  const t = tradePage({ wallet: page, rpc: c.read, pending: { hash: orig.hash, from: me } });
  assert.equal(await t.checkPending(), false); assert.equal(t.S.pending, null);
  assert.match(t.said.at(-1), /not known to the network any more.*Nothing was sent.*press again/s);
  assert.equal(await t.checkPending(), true, 'and with the record cleared the next press goes on');
});
test('trade: still held by a node: nothing is sent; unreadable: nothing is sent and the press is told', async () => {
  const { c, page, err } = await stuck();
  const t = tradePage({ wallet: page, rpc: c.read, pending: { hash: orig.hash, from: me, seen: err.seen } });
  assert.equal(await t.checkPending(), false); assert.match(t.said.at(-1), /Still waiting for .* to land, so nothing was sent/); assert.ok(t.S.pending, 'and it is kept');
  c.down = true; await assert.rejects(t.checkPending(), /Could not check the earlier transaction, so nothing was sent/); assert.ok(t.S.pending);
});
test('trade: its own receipt, reverted, is the trade page\'s failure to report', async () => {
  const { c, page, err } = await stuck();
  c.mempool.delete(orig.hash); c.mine({ ...orig, status: '0x0' }, 990);
  const t = tradePage({ wallet: page, rpc: c.read, pending: { hash: orig.hash, from: me, seen: err.seen } });
  assert.equal(await t.checkPending(), false); assert.deepEqual(t.landedWith, [{ status: '0x0', hash: orig.hash }]);
});

// ── the rewards page ──
function rewardsPage({ wallet, read }) {
  return new Function('wallet', 'readRpc', 'health', `${rewardsSrc}\nreturn pendingState;`)(wallet, (m, p) => read(m, p), null);
}
test('rewards: a claim a speed-up landed is confirmed under the hash that landed; a cancel ends it; dropped waits its ten minutes', async () => {
  const { c, page, err } = await stuck();
  const state = rewardsPage({ wallet: page, read: c.read }), rec = { hash: orig.hash, at: Date.now() - 60e3, seen: err.seen }, old = { ...rec, at: Date.now() - 11 * 60e3 };
  assert.deepEqual(await state(rec), { state: 'pending', hash: orig.hash }, 'held by a node: pending');
  c.mempool.delete(orig.hash);
  assert.deepEqual(await state(rec), { state: 'pending', hash: orig.hash }, 'dropped a minute ago: a node asked may not have seen one still going round');
  assert.deepEqual(await state(old), { state: 'gone', hash: orig.hash }, 'dropped for ten minutes: gone');
  c.mine(fast, 990);
  assert.deepEqual(await state(rec), { state: 'confirmed', hash: fast.hash }, 'a speed-up landed: confirmed, and the claim is not sent again');
  assert.deepEqual(await state({ hash: orig.hash, at: Date.now() - 60e3 }), { state: 'pending', hash: orig.hash }, 'nothing kept: no telling yet');
  assert.deepEqual(await state({ hash: orig.hash, at: Date.now() - 11 * 60e3 }), { state: 'gone', hash: orig.hash }, 'and after ten minutes, gone, as it was');
  const c2 = chain(); c2.send(orig); c2.mempool.delete(orig.hash); c2.mine(cancel, 990);
  assert.deepEqual(await rewardsPage({ wallet: { trace: (h, s, o) => makeWallet({ rpc: c2.read }).trace(h, s, { ...o, read: c2.read }) }, read: c2.read })(rec), { state: 'gone', hash: orig.hash }, 'a cancel took its place: gone at once');
  const c3 = chain(); c3.mine({ ...orig, status: '0x0' }, 990);
  assert.equal((await rewardsPage({ wallet: { trace: (h, s, o) => makeWallet({ rpc: c3.read }).trace(h, s, { ...o, read: c3.read }) }, read: c3.read })(rec)).state, 'failed', 'a revert is a failure');
  c.down = true; assert.deepEqual(await state(rec), { state: 'pending', hash: orig.hash }, 'unreadable: pending, so nothing is sent');
});

// ── the swap card ──
// (the card starts its own wait the moment the transaction is sent, so the chain here is only mutated while it waits: a wait that began after a
// replacement learned nothing of the transaction and could tell nothing)
function sent() {
  const c = chain(); c.send(orig);
  const wallet = makeWallet({ rpc: c.read }), o = { read: c.read, probeMs: 5, every: 5, timeoutMs: 1200 };
  return { c, page: { receipt: (h) => wallet.receipt(h, o), trace: (h, seen, x) => wallet.trace(h, seen, { read: c.read, ...x }) } };
}
function card({ wallet, rpc }) {
  const said = [], remembered = [], H = { onDone: () => said.push('done') };
  let halted = false, turns = 0;                                            // (the card's half-hour loop is stopped where a test leaves it going, and after a few thousand turns whatever a test does)
  const make = new Function('wallet', 'rpc', 'say', 'remember', 'paintRecent', 'txLink', 'H', 'readBalances', 'paintSides', 'setTimeout', `${cardSrc}\nreturn { landed, pendingHolds, state: () => PENDING };`);
  const api = make(wallet, rpc, (t) => said.push(String(t)), (h, s) => remembered.push(s), () => {}, (h) => `[${h.slice(0, 6)}]`, H, async () => {}, () => {}, (f) => { if (!halted && ++turns < 3000) globalThis.setTimeout(f, 1); });
  return { ...api, said, remembered, halt: () => { halted = true; } };
}
const replace = (c, by) => { c.mempool.delete(orig.hash); c.mine(by, 990); };
test('swap card: a speed-up that lands while the wait is on is the swap', async () => {
  const { c, page } = sent(), k = card({ wallet: page, rpc: c.read }), p = k.landed(orig.hash, me, 'Swap 1 ETH');
  await probed(c); await sleep(10); replace(c, fast);
  assert.equal((await p).transactionHash, fast.hash); assert.equal(k.state(), null, 'and nothing is kept as pending');
  k.halt();
});
test('swap card: one that lands after the wait gave up is found by the loop that goes on, and the next press is not held', async () => {
  const { c, page } = sent(), k = card({ wallet: page, rpc: c.read }), p = k.landed(orig.hash, me, 'Swap 1 ETH');
  await until(() => k.state()); assert.ok(k.state(), 'the wait gave up: kept as pending'); assert.equal(k.state().seen?.nonce, '0', 'with what the wait learned of it');
  assert.equal(await k.pendingHolds(), true); assert.match(k.said.at(-1), /not confirmed yet/, 'while nothing has happened it holds, as it did');
  replace(c, fast);
  assert.equal((await p).transactionHash, fast.hash, 'the loop resolves with the speed-up\'s receipt'); assert.equal(k.state(), null);
  assert.equal(await k.pendingHolds(), false); k.halt();
});
test('swap card: a press after a speed-up landed (before the loop looked) is booked, not held', async () => {
  const { c, page } = sent(), k = card({ wallet: page, rpc: c.read }), p = k.landed(orig.hash, me, 'Swap 1 ETH').catch((e) => e);
  await until(() => k.state()); replace(c, fast);
  assert.equal(await k.pendingHolds(), false, 'not held'); assert.equal(k.remembered.at(-1), 'Swap 1 ETH', 'and remembered as the swap');
  k.halt(); await Promise.race([p, sleep(50)]);
});
test('swap card: a cancel says nothing was swapped, found by the wait or by the loop after it', async () => {
  let { c, page } = sent(), k = card({ wallet: page, rpc: c.read }), p = k.landed(orig.hash, me, 'Swap 1 ETH').catch((e) => e);
  await probed(c); await sleep(10); replace(c, cancel);
  let e = await p; assert.ok(e.html === true && /cancelled or replaced in your wallet.*nothing was swapped/.test(e.message), 'the wait itself found it'); k.halt();
  ({ c, page } = sent()); k = card({ wallet: page, rpc: c.read }); p = k.landed(orig.hash, me, 'Swap 1 ETH').catch((x) => x);
  await until(() => k.state()); replace(c, cancel);
  e = await p; assert.match(e.message, /cancelled or replaced in your wallet before it was mined, so it never ran and nothing was swapped/); assert.equal(k.state(), null); k.halt();
});
test('swap card: a press after a cancel says so once, and the next goes on', async () => {
  const { c, page } = sent(), k = card({ wallet: page, rpc: c.read }), p = k.landed(orig.hash, me, 'Swap 1 ETH').catch((e) => e);
  await until(() => k.state()); replace(c, cancel);
  assert.equal(await k.pendingHolds(), true); assert.match(k.said.at(-1), /cancelled or replaced in your wallet before it was mined, so it never ran\. Nothing was swapped: press again/); assert.equal(k.state(), null);
  assert.equal(await k.pendingHolds(), false, 'with the record cleared the next press goes on'); k.halt(); await Promise.race([p, sleep(50)]);
});
test('swap card: a host with no trace holds as it always did', async () => {
  const c = chain(); c.send(orig);
  const k = card({ wallet: { receipt: async () => { throw new Error('Sent, not confirmed yet.'); } }, rpc: c.read }), p = k.landed(orig.hash, me, 'Swap 1 ETH').catch((e) => e);
  await until(() => k.state()); assert.equal(await k.pendingHolds(), true); assert.match(k.said.at(-1), /not confirmed yet/);
  k.halt(); void p;
});

// ── the tETH page: a deposit it was told is not confirmed yet, looked at again from "Check again" ──
function tethPage({ wallet, stuck }) {
  const S = { stuck, busy: false, steps: null }, said = [], painted = [];
  const landing = new Function('S', 'STEPS', 'lockTicket', 'renderGo', 'say', 'paintSteps', 'wallet', 'esc', 'stuckText', `${tethSrc}\nreturn landing;`)(
    S, [1, 2, 3, 4], () => {}, () => {}, (t) => said.push(String(t)), (...a) => painted.push(a), wallet, (x) => String(x), (e, st) => `stuck:${e.message.slice(0, 12)}`);
  return { S, said, painted, landing };
}
test('tETH: a deposit a speed-up landed is confirmed, and the hash the settle names is the one that landed', async () => {
  const { c, page, err } = await stuck();
  c.mempool.delete(orig.hash); c.mine(fast, 990);
  const st = { hash: orig.hash, wei: 1n, landed: false, first: true, seen: err.seen }, t = tethPage({ wallet: page, stuck: st });
  assert.equal(await t.landing(st), true); assert.equal(st.landed, true); assert.equal(st.hash, fast.hash);
});
test('tETH: a cancel took the deposit\'s place: it is let go, and the person is told nothing was lost', async () => {
  const { c, page, err } = await stuck();
  c.mempool.delete(orig.hash); c.mine(cancel, 990);
  const st = { hash: orig.hash, wei: 1n, landed: false, first: true, seen: err.seen }, t = tethPage({ wallet: page, stuck: st });
  assert.equal(await t.landing(st), false); assert.equal(t.S.stuck, null); assert.match(t.said.at(-1), /replaced in your wallet.*Nothing was lost/);
});
test('tETH: still on its way, or nothing kept of it: the wait goes on as it did, and what that wait learns is kept', async () => {
  const { c, page, err } = await stuck();
  const st = { hash: orig.hash, wei: 1n, landed: false, first: true, seen: null }, t = tethPage({ wallet: page, stuck: st });
  assert.equal(await t.landing(st), false); assert.match(t.said.at(-1), /^stuck:Sent, not/); assert.equal(st.seen?.nonce, '0', 'the new wait learned who sent it');
  c.mempool.delete(orig.hash); c.mine(fast, 990);
  assert.equal(await t.landing(st), true, 'and the next look, with that kept, finds the speed-up'); assert.equal(st.hash, fast.hash); void err;
});

// ── the front page: the wallet it hands the swap card ──
test('front page: the swap card\'s wallet throws a cancel as the others do, and traces from what the Activity entry kept', async () => {
  const { A } = { A: await import('../dapp/activity.js') };
  const { c, err } = await stuck();
  c.mempool.delete(orig.hash); c.mine(fast, 990);
  const entries = new Map([[`tx:1:${orig.hash}`, { seen: err.seen }]]);
  let next;
  const make = (receipt) => new Function('ensureChain', 'swcNo', 'S', 'sendTx', 'receipt', 'REPLACED_TEXT', 'traceTx', 'rpc', 'actGet', 'canBatch', `${frontSrc}\n};\nreturn swcWallet;`)(
    async () => {}, (e) => e, { wallet: me }, async () => orig.hash, receipt, A.REPLACED_TEXT, A.traceTx, c.read, (id) => entries.get(id), () => false);
  const w = make(async () => next);
  next = { status: '0x0', replaced: true, transactionHash: cancel.hash };
  await assert.rejects(w.receipt(orig.hash), (e) => e.replaced === true && e.hash === cancel.hash && e.message === A.REPLACED_TEXT);
  next = { status: '0x1', transactionHash: orig.hash }; assert.equal((await w.receipt(orig.hash)).transactionHash, orig.hash);
  next = null; await assert.rejects(w.receipt(orig.hash), /Sent, not confirmed yet/);
  assert.equal((await w.trace(orig.hash)).landed.transactionHash, fast.hash, 'with nothing handed in it uses what the page\'s Activity entry kept of the transaction');
  assert.equal((await w.trace(orig.hash, err.seen)).landed.transactionHash, fast.hash, 'and what is handed in');
  entries.clear(); assert.deepEqual(await w.trace(orig.hash), { unknown: true }, 'with neither there is no telling');
});

// ── the trade page, whole: a press whose wait gave up, a speed-up in the wallet, and the next press ──
test('trade: the press that gave up keeps what it learned, and the next press books the speed-up instead of trading again', async () => {
  const c = chain(), real = makeWallet({ rpc: c.read }), S = { pending: null }, said = [], booked = [], sentTx = [];
  const wallet = { sendTx: async (t) => { sentTx.push(t); c.send(orig); return orig.hash; }, receipt: (h) => real.receipt(h, { read: c.read, probeMs: 5, every: 5, timeoutMs: 1200 }), trace: (h, seen, o) => real.trace(h, seen, { read: c.read, ...o }) };
  const body = `${sendSrc}\n${tradeSrc}\nreturn { sendAndReport, checkPending };`;
  const { sendAndReport, checkPending } = new Function('S', 'say', 'txLink', 'landed', 'wallet', 'rpc', 'clearTicket', 'readBalances', 'renderBalance', body)(
    S, (t) => said.push(String(t)), (h) => `[${h.slice(0, 6)}]`, async (rc, p) => { booked.push({ status: rc.status, hash: p.hash }); }, wallet, c.read, () => {}, async () => {}, () => {});
  await assert.rejects(sendAndReport({ to: pool, data: '0x', value: 5n }, { from: me, buy: true, P: {} }), /Sent, not confirmed yet/);
  assert.equal(S.pending?.hash, orig.hash); assert.equal(S.pending.seen?.nonce, '0', 'what the wait learned of the transaction went into the record');
  c.mempool.delete(orig.hash); c.mine(fast, 990);                                    // the person speeds it up in the wallet; it lands
  assert.equal(await checkPending(), false, 'the next press sends nothing'); assert.deepEqual(booked, [{ status: '0x1', hash: fast.hash }]); assert.equal(sentTx.length, 1, 'one transaction was ever sent');
});


// ── the swap card: the signer it hands its saved plans ──
test('swap card: the signer the plans use traces through the wallet, and answers with a promise where the wallet cannot trace', async () => {
  const text = src('swap/card.js');
  const body = cut(text, 'const pageSigner = {', '\nlet proverAsked = 0;', 'the card\'s signer');
  const make = (wallet) => new Function('W', 'H', 'wallet', 'lc', 'signTyped', `${body}\nreturn pageSigner;`)({ account: '0xme' }, {}, wallet, (x) => String(x).toLowerCase(), async () => '0xsig');
  const asked = [];
  const traced = make({ trace: async (h, seen) => { asked.push([h, seen]); return { landed: { transactionHash: '0x2' } }; }, receipt: async () => ({}) });
  assert.deepEqual(await traced.trace('0x1', { nonce: '3' }), { landed: { transactionHash: '0x2' } }); assert.deepEqual(asked, [['0x1', { nonce: '3' }]]);
  const plain = make({ receipt: async () => ({}) });
  const none = plain.trace('0x1');
  assert.ok(none instanceof Promise, 'a promise, so a caller can ask with .catch and carry on'); assert.equal(await none, undefined);
});
