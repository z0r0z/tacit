// dapp/swap/later.js, the paths that put a swap's output into another pool (a held balance, or the wallet's ETH, paying a deposit box for the key) and the
// states a plan keeps when a send is in doubt: with a pool wallet and the routes made up, so nothing needs a chain.
//   node --test tests/swap-into.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { makeLater } = await import('../dapp/swap/later.js');

const ZERO = '0x0000000000000000000000000000000000000000', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const BOX = '0x' + 'b0'.repeat(20), REFUND = '0x' + 'f1'.repeat(20), TO = '0x' + 'c2'.repeat(20);
const word = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const E18 = 10n ** 18n;
const hopOf = (token, id) => ({ token, pool: '0x' + '51'.repeat(20), router: '0x' + '52'.repeat(20), id, from: 1, state: { pool: true, router: true } });
const SRC = hopOf(USDC, '1-xa0b86991c6'), DST = hopOf('0xdac17f958d2ee523a2206206994597c13d831ec7', '1-xdac17f958d');

// a pool's wallet that records what it is asked: `failWith` makes the withdrawal throw
function wallets({ balance = 2_000n * 10n ** 6n, fee = 100_000n, failWith = null, noDrop = true } = {}) {
  const w = { calls: { depositBox: [], withdrawAndCall: [], withdraw: [] }, balance };
  Object.assign(w, {
    sync: async () => ({ balance: w.balance, leaves: 40 }), notes: () => [{ index: 30, v: String(w.balance) }], summary: () => ({ balance: w.balance }),
    quote: async () => ({ fee: String(fee) }), refundBox: async () => REFUND,
    depositBox: async (a) => { w.calls.depositBox.push(a); return { box: BOX, amount: a.amount, value: a.amount - BigInt(a.fee), deadline: a.deadline }; },
    withdrawAndCall: async (a) => { w.calls.withdrawAndCall.push(a); if (failWith) throw new Error(failWith); return '0x' + 'ab'.repeat(32); },
    withdraw: async (a) => { w.calls.withdraw.push(a); return '0x' + 'cd'.repeat(32); },
  });
  return w;
}
// routes whose calldata carries the recipient, so a test can see who a swap pays; `mins` is what each asked price pays at least
function routesOf(mins) {
  const seen = [];
  const make = async ({ to, amount }) => { const min = mins[Math.min(seen.length, mins.length - 1)]; seen.push({ to, amount }); return { callData: '0xabcd' + word(to), standData: '0xabcd' + word(to), min, out: min + min / 100n, name: 'made up', deadline: 99_999_999_999n }; };
  return { seen, routes: { routeOut: make, routeFrom: make, routeOutTac: make } };
}
const make = ({ w, r, signer = { address: '0x' + '01'.repeat(20) } }) => {
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  return { L: makeLater({ keyHex: async () => '22'.repeat(32), signer, ethCall: async () => '0x', store, chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] }, walletOf: () => w, routes: r.routes }), store };
};
const into = (hop = null) => ({ hop, refund: REFUND });
const args = (o = {}) => ({ swapWei: 500n * 10n ** 6n, token: ZERO, sym: 'ETH', dec: 18, hop: SRC, pay: { sym: 'USDC', dec: 6 }, feeWei: 100_000n, into: into(), ...o });

test('adopting a balance into another pool keeps its refund address and the destination pool, and refuses what cannot go', async () => {
  const { L, store } = make({ w: wallets(), r: routesOf([E18]) });
  const eth = await L.adopt(args());
  assert.ok(eth.held && eth.state === 'waiting' && eth.into.hop === null && eth.to === REFUND && eth.into.refund === REFUND, 'into the ETH pool');
  const tok = await L.adopt(args({ token: DST.token, sym: 'USDT', dec: 6, into: into(DST) }));
  assert.ok(tok.into.hop.pool === DST.pool && tok.into.hop.sym === 'USDT' && tok.into.hop.dec === 6, 'into a token pool: its pool, and its coin from the destination');
  const before = JSON.parse(store.getItem('tacit-swap-later-v1')).length;
  await assert.rejects(L.adopt(args({ into: into({ ...DST, state: { pool: true, router: false } }) })), /not open/);
  await assert.rejects(L.adopt(args({ swapWei: 0n })), /enter an amount/);
  await assert.rejects(L.adopt(args({ swapWei: 5_000n * 10n ** 6n })), /holds less/);
  assert.strictEqual(JSON.parse(store.getItem('tacit-swap-later-v1')).length, before, 'no plan kept by any refusal');
});

test('the price into another pool makes one box for a little under the floor and asks the route again paying it', async () => {
  const w = wallets(), r = routesOf([E18, E18 + 1_000n]), { L } = make({ w, r });
  const plan = await L.adopt(args());
  const shown = await L.offer(plan, { slippageBps: 50 });
  assert.strictEqual(w.calls.depositBox.length, 1, 'one box');
  assert.strictEqual(w.calls.depositBox[0].amount, (E18 * 997n) / 1000n, 'for 0.3% under the first floor');
  assert.strictEqual(r.seen.length, 2);
  assert.notStrictEqual(r.seen[0].to.toLowerCase(), BOX, 'the first price is for a stand-in');
  assert.strictEqual(r.seen[1].to, BOX, 'the second pays the box');
  assert.ok(shown.callData.includes(word(BOX)) && shown.intoBox.box === BOX && shown.arrives === shown.intoBox.amount - 100_000n, 'and what arrives is the box less that pool’s fee');
});

test('a second price under the box, or an amount the fee would swallow, is refused before anything is sent', async () => {
  const lower = routesOf([E18, E18 / 2n]), a = make({ w: wallets(), r: lower });
  await assert.rejects(a.L.offer(await a.L.adopt(args())), (e) => e.moved === true && /price moved/.test(e.message));
  const tiny = routesOf([150_000n]), b = make({ w: wallets({ fee: 100_000n }), r: tiny });
  await assert.rejects(b.L.offer(await b.L.adopt(args())), /Too small/);
});

test('the swap out into another pool is sent once and remembers the box', async () => {
  const w = wallets(), r = routesOf([E18, E18]), { L } = make({ w, r });
  const plan = await L.adopt(args());
  const done = await L.swapOut(plan, { shown: await L.offer(plan), via: 'relay' });
  assert.strictEqual(done.state, 'done');
  assert.strictEqual(done.intoBox, BOX);
  assert.strictEqual(w.calls.withdrawAndCall.length, 1);
  assert.strictEqual(w.calls.withdrawAndCall[0].amount, 500n * 10n ** 6n);
});

test('a send that may have landed leaves the plan in doubt, and checking it does not offer it again', async () => {
  for (const msg of ['Those funds were already spent. Check Activity.', 'the pool kept moving; try again', 'the relay did not answer']) {
    const w = wallets({ failWith: msg }), { L, store } = make({ w, r: routesOf([E18, E18]) });
    const plan = await L.adopt(args());
    await assert.rejects(L.swapOut(plan, { shown: await L.offer(plan), via: 'relay' }), new RegExp(msg.slice(0, 12)));
    assert.strictEqual(JSON.parse(store.getItem('tacit-swap-later-v1'))[0].state, 'unsure', msg);
    const checked = await L.check(JSON.parse(store.getItem('tacit-swap-later-v1'))[0]);
    assert.strictEqual(checked.state, 'unsure', `${msg}: still in doubt a moment after the send, with the balance not yet down`);
  }
  // a refusal before anything was sent is not in doubt: the plan waits to be offered again
  const w = wallets({ failWith: 'fee went up' }), { L, store } = make({ w, r: routesOf([E18, E18]) });
  const plan = await L.adopt(args());
  await assert.rejects(L.swapOut(plan, { shown: await L.offer(plan), via: 'relay' }));
  assert.strictEqual(JSON.parse(store.getItem('tacit-swap-later-v1'))[0].state, 'waiting');
});

test('the wallet’s ETH into a pool is sent only at a price within a thousandth of the one shown', async () => {
  const sent = [], signer = { address: '0x' + '01'.repeat(20), send: async (t) => { sent.push(t); return '0x' + 'ee'.repeat(32); } };
  const { L } = make({ w: wallets({ fee: 100_000n }), r: routesOf([100n * 10n ** 6n]), signer });
  const base = { swapWei: E18 / 10n, token: DST.token, into: { hop: DST }, refund: REFUND };
  await assert.rejects(L.swapIntoPool({ ...base, shownMin: 120n * 10n ** 6n }), (e) => e.moved === true);
  assert.strictEqual(sent.length, 0, 'nothing sent at a worse price');
  const ok = await L.swapIntoPool({ ...base, shownMin: 100n * 10n ** 6n });
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].data.includes(word(BOX)) && sent[0].value === E18 / 10n, 'one swap, paying the box, with the ETH');
  assert.strictEqual(ok.box, BOX);
  assert.strictEqual(ok.arrives, (100n * 10n ** 6n * 997n) / 1000n - 100_000n);
});

// ── the states a plan keeps: only a waiting swap is sent, a read that failed before anything went is not a doubt, the browser must keep the plan ──
const withPlans = (plans) => { const mem = new Map([['tacit-swap-later-v1', JSON.stringify(plans)]]); return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), mem }; };
const stateOf = (store, id) => JSON.parse(store.getItem('tacit-swap-later-v1')).find((p) => p.id === id)?.state;

test('a swap that is not waiting is not sent again, whichever tab moved it', async () => {
  for (const state of ['done', 'swapping', 'unsure', 'shielding']) {
    const w = wallets({ balance: 5_000n * 10n ** 6n }), { L, store } = make({ w, r: routesOf([E18, E18]) });
    const plan = await L.adopt(args()), shown = await L.offer(plan);
    // this tab still holds the plan as waiting; the copy kept (the other tab's) has moved on
    store.setItem('tacit-swap-later-v1', JSON.stringify(JSON.parse(store.getItem('tacit-swap-later-v1')).map((p) => ({ ...p, state }))));
    await assert.rejects(L.swapOut(plan, { shown, via: 'relay' }), /not waiting to be sent/, state);
    assert.strictEqual(w.calls.withdrawAndCall.length + w.calls.withdraw.length, 0, `${state}: nothing was sent`);
    assert.strictEqual(stateOf(store, plan.id), state, `${state}: and the plan is left as it was`);
  }
});

test('an unanswered read before the send is a refusal to try again, not a doubt that locks the plan; a pool that kept moving still is one', async () => {
  for (const [msg, state] of [['The operation timed out.', 'waiting'], ['signal timed out', 'waiting'], ['timed out waiting for the previous transaction', 'waiting'], ['the pool kept moving; try again', 'unsure']]) {
    const { L, store } = make({ w: wallets({ failWith: msg }), r: routesOf([E18, E18]) });
    const plan = await L.adopt(args());
    await assert.rejects(L.swapOut(plan, { shown: await L.offer(plan), via: 'relay' }));
    assert.strictEqual(stateOf(store, plan.id), state, msg);
    assert.strictEqual((await L.check(JSON.parse(store.getItem('tacit-swap-later-v1'))[0])).state, state, `${msg}: and a check leaves it so`);
  }
});

test('the keeper’s own words for a relay that will not send offer the wallet; a swap error does not', async () => {
  for (const [msg, refused] of [
    ['the relay is busy with other sends; try again in a minute. Sending it from your own wallet also works, and shows your address as the sender', true],
    ["the relay can't price its fee in this token right now; try again in a few minutes. Sending it from your own wallet also works, and shows your address as the sender", true],
    ["the relay has used today's gas for this pool; try again tomorrow. Sending it from your own wallet also works, and shows your address as the sender", true],
    ['gas above the 1500000 cap', true], ['relaying is off', true], ['relayer returned 503', true], ['the transaction reverts: ShortOutput', false]]) {
    const { L, store } = make({ w: wallets({ failWith: msg }), r: routesOf([E18, E18]) });
    const plan = await L.adopt(args());
    await assert.rejects(L.swapOut(plan, { shown: await L.offer(plan), via: 'relay' }));
    assert.strictEqual(JSON.parse(store.getItem('tacit-swap-later-v1'))[0].refused, refused, msg);
  }
});

test('a hash the chain does not know is a swap in doubt, kept with its hash, not a swap made', async () => {
  const w = wallets();
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  const L = makeLater({ keyHex: async () => '22'.repeat(32), signer: { address: '0x' + '01'.repeat(20) }, ethCall: async () => '0x', store, chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] }, walletOf: () => w, routes: routesOf([E18, E18]).routes, knows: async () => false });
  const plan = await L.adopt(args());
  await assert.rejects(L.swapOut(plan, { shown: await L.offer(plan), via: 'relay' }), /may still have sent/);
  const kept = JSON.parse(store.getItem('tacit-swap-later-v1'))[0];
  assert.strictEqual(kept.state, 'unsure');
  assert.strictEqual(kept.swapTx, '0x' + 'ab'.repeat(32), 'the hash is kept for the check');
});

test('what a check or the making private reads is kept before the send, so a closed tab leaves it', async () => {
  const w = wallets(), seen = [];
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { seen.push(JSON.parse(v)[0]); mem.set(k, String(v)); } };
  w.withdrawAndCall = async () => { throw new Error('the tab was closed'); };
  const L = makeLater({ keyHex: async () => '22'.repeat(32), signer: { address: '0x' + '01'.repeat(20) }, ethCall: async () => '0x', store, chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] }, walletOf: () => w, routes: routesOf([E18, E18]).routes });
  const plan = await L.adopt(args());
  await assert.rejects(L.swapOut(plan, { shown: await L.offer(plan), via: 'relay' }));
  const swapping = seen.find((p) => p.state === 'swapping');
  assert.strictEqual(swapping?.min, String(E18), 'the floor is in the plan when it is first marked as sending');
  assert.ok(swapping?.route, 'and so is the route');
});

test('twenty plans are kept, and a swap that still waits is not the one that goes', async () => {
  const { L, store } = make({ w: wallets({ balance: 9_000n * 10n ** 6n }), r: routesOf([E18]) });
  const first = await L.adopt(args());
  for (let i = 0; i < 25; i++) {
    const p = await L.adopt(args());
    store.setItem('tacit-swap-later-v1', JSON.stringify(JSON.parse(store.getItem('tacit-swap-later-v1')).map((x) => (x.id === p.id ? { ...x, state: 'done' } : x))));
  }
  const kept = JSON.parse(store.getItem('tacit-swap-later-v1'));
  assert.ok(kept.length <= 20, `${kept.length} kept`);
  assert.ok(kept.some((x) => x.id === first.id && x.state === 'waiting'), 'the swap that waits is still kept');
});

test('a browser that cannot keep the plan stops the swap before anything is sent', async () => {
  const w = wallets(), store = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  const L = makeLater({ keyHex: async () => '22'.repeat(32), signer: { address: '0x' + '01'.repeat(20) }, ethCall: async () => '0x', store, chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] }, walletOf: () => w, routes: routesOf([E18]).routes });
  await assert.rejects(L.adopt(args()), /could not keep the swap’s plan, so nothing was sent/);
});

test('a pool that takes another token than the swap pays is refused before a box is made', async () => {
  const w = wallets(), { L } = make({ w, r: routesOf([E18, E18]) });
  await assert.rejects(L.adopt(args({ token: ZERO, sym: 'ETH', into: into(DST) })), /takes another token/);
  assert.strictEqual(w.calls.depositBox.length, 0);
});
