// dapp/swap/later.js, the parts of a token start paid for by the gas relay (a sale into a deposit box of the ETH pool) that need no chain: the amount sold is sized to the
// box's expected output with a margin, the keeper's fee is a half over its quote, and the plan's states follow what happened (a no or a refusal before the order is posted
// is stopped, an order that ran and a box not yet completed is depositing until the pool shows the note, anything unclear is unsure).
//   node --test tests/swap-boxed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { makeLater, sizeBoxed, boxFeeOf, depositFeeOf, depositFee, BOX_GAS, BOXED_MARGIN_BPS, readPlans } = await import('../dapp/swap/later.js');

const PAYER = '0x' + '0a'.repeat(20), DEST = '0x' + '0d'.repeat(20), REFUND = '0x' + '0f'.repeat(20), BOX = '0x' + 'b0'.repeat(20), REFUND_BOX = '0x' + 'Ab'.repeat(20);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', DAI = '0x6b175474e89094c44da98b954eedeac495271d0f', ZERO = '0x0000000000000000000000000000000000000000';
const HASH = '0x' + 'ab'.repeat(32);

// ── sizeBoxed ──
test('the amount sold is scaled to the output the box needs, with the margin, and the route is asked for it', async () => {
  const calls = [], route = async (a) => { calls.push(a); return { out: a * 3n, name: 'pool' }; };
  const need = 2_000_000_000n, keep = 10000n - BOXED_MARGIN_BPS, want = (need * 10000n + keep - 1n) / keep;
  const r = await sizeBoxed({ route, amountIn: 1_000_000n, out: 3_000_000n, needWei: need });
  assert.ok(r && r.out >= want, `the route pays ${r?.out}, at least ${want}`);
  assert.strictEqual(calls.length, 1, 'one ask was enough');
  assert.strictEqual(r.amountIn, calls[0], 'the amount it found is the one it asked for');
  assert.ok(r.out * 10000n <= want * 10006n && r.out * 10000n >= want * 10004n, 'and a little over: the scale-up is five basis points, so a route that pays slightly less than quoted still covers the box');
  assert.ok(r.out >= need + (need * (BOXED_MARGIN_BPS - 2n)) / 10000n, 'the output leaves the margin over the box');
});

test('a route that pays less per token as the amount grows is asked again with what it paid', async () => {
  const calls = [], route = async (a) => { calls.push(a); return { out: 3n * a - (a * a) / 50_000_000n, name: 'pool' }; };
  const need = 2_500_000n, want = (need * 10000n + 9959n) / 9960n;
  const r = await sizeBoxed({ route, amountIn: 500_000n, out: 1_500_000n, needWei: need });
  assert.ok(r && r.out >= want, 'it found an amount that pays enough');
  assert.ok(calls.length >= 2 && calls.length <= 3, `it was asked again (${calls.length} asks)`);
  assert.ok(calls[1] > calls[0], 'for more than the first try');
});

test('no amount is offered when the route never pays enough in three asks, or has no route, or the figures are nothing', async () => {
  assert.strictEqual(await sizeBoxed({ route: async () => ({ out: 1n }), amountIn: 1000n, out: 1000n, needWei: 5000n }), null);
  assert.strictEqual(await sizeBoxed({ route: async () => null, amountIn: 1000n, out: 1000n, needWei: 5000n }), null);
  for (const bad of [{ amountIn: 0n }, { out: 0n }, { needWei: 0n }]) {
    let asked = 0;
    assert.strictEqual(await sizeBoxed({ route: async () => { asked++; return { out: 10n ** 30n }; }, amountIn: 1000n, out: 1000n, needWei: 5000n, ...bad }), null);
    assert.strictEqual(asked, 0, 'nothing is asked of the chain for it');
  }
  let n = 0;
  assert.strictEqual(await sizeBoxed({ route: async () => { n++; return { out: 1n }; }, amountIn: 1000n, out: 1000n, needWei: 5000n, tries: 5 }), null);
  assert.strictEqual(n, 5, 'tries is how many asks it makes');
});

test('amounts may be strings, and the margin and the gas the keeper is asked at are what the page reads', () => {
  assert.strictEqual(BOXED_MARGIN_BPS, 40n);
  assert.strictEqual(BOX_GAS, 500_000, 'the keeper prices a deposit at its own default, 500,000 gas');
  assert.strictEqual(boxFeeOf(1000n), 1500n, 'a half over the quote');
  assert.strictEqual(boxFeeOf('2'), 3n);
  assert.strictEqual(boxFeeOf(1n), 1n, 'rounded down');
  assert.strictEqual(boxFeeOf(0n), 0n);
});

test('the fee for a deposit box is the keeper\'s own figure, else its quote for the default gas, else nothing', async () => {
  assert.strictEqual(depositFeeOf({ fee: '1000', depositFee: '1800' }), '1800');
  assert.strictEqual(depositFeeOf({ fee: '1000' }), '1000', 'a keeper that does not say what a deposit costs');
  assert.strictEqual(depositFeeOf({ fee: '1000', depositFee: 'soon' }), '1000');
  assert.strictEqual(depositFeeOf({ fee: 1000 }), '1000');
  assert.strictEqual(depositFeeOf({}), null);
  assert.strictEqual(depositFeeOf(null), null);
  const seen = [], get = (body, ok = true) => async (url) => { seen.push(url); return { ok, json: async () => body }; };
  assert.strictEqual(await depositFee(get({ fee: '1000', depositFee: '1800' }), 'https://k'), 1800n);
  assert.deepStrictEqual(seen, [`https://k/quote?gas=${BOX_GAS}`], 'read at the default gas, for a keeper that has no figure of its own');
  assert.strictEqual(await depositFee(get({ fee: '1000' }), 'https://k'), 1000n);
  await assert.rejects(depositFee(get({}), 'https://k'), /could not quote/);
  await assert.rejects(depositFee(get({ fee: '1000' }, false), 'https://k'), /could not quote/);
});

// ── startBoxed and check against a pool wallet that is not a chain ──
function setup({ fee = 1000n, depositFee: own = null, leaves = 10, found = true, notesLate = false } = {}) {
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  const M = { boxes: [], quotes: [], notes: [], leaves, steps: [], funded: [], syncs: 0 };
  const pool = {
    quote: async (gas) => { M.quotes.push(gas); if (M.quoteError) throw new Error('internal error'); return { fee: String(fee), ...(own != null ? { depositFee: String(own) } : {}) }; },
    sync: async () => { M.syncs++; if (M.failSyncAfter != null && M.syncs > M.failSyncAfter) throw new Error('request rejected by the node'); return { leaves: M.leaves, balance: 0n, notes: M.notes.length }; },
    refundBox: async () => REFUND_BOX,
    notes: () => M.notes,
    depositBox: async (a) => { M.boxes.push(a); return { box: BOX, amount: a.amount, value: a.amount - a.fee, deadline: a.deadline, intent: { amount: String(a.amount), refund: a.refund, deadline: String(a.deadline) } }; },
  };
  const L = makeLater({ keyHex: async () => { throw new Error('the key is not needed'); }, signer: { address: PAYER }, ethCall: async () => '0x', store, walletOf: async () => pool, chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] } });
  // the keeper completing the box: a note of the deposit's amount at the next leaf
  const complete = (depositWei) => { M.notes.push({ v: String(depositWei), index: M.leaves }); M.leaves += 2; };
  return { L, M, complete, store };
}
const base = { swapWei: 20n * 10n ** 15n, extraWei: 8n * 10n ** 15n, token: DAI, sym: 'DAI', dec: 18, to: DEST, depositWei: 3n * 10n ** 16n, pay: { token: USDC, sym: 'USDC', dec: 6, amountIn: 70_000_000n }, refund: REFUND, pollMs: 5 };

test('a box is made for the deposit and the keeper\'s fee, the relay sells into it, and the plan waits once the note is there', async () => {
  const { L, M, complete } = setup();
  const steps = [];
  const plan = await L.startBoxed({ ...base, onStep: (s) => steps.push(s), fund: async ({ box, amount, fee, onStep }) => {
    assert.strictEqual(box, BOX);
    assert.strictEqual(fee, 1500n, 'the keeper\'s fee is a half over its quote of 1000');
    assert.strictEqual(amount, base.depositWei + 1500n, 'the box holds the deposit and the fee');
    assert.strictEqual(M.syncs > 0, true);
    complete(base.depositWei);                                    // the keeper completes the box once it is paid
    return { hash: HASH, amountIn: 71_234_567n, route: 'Uniswap v3 0.05%' };
  } });
  assert.deepStrictEqual(M.quotes, [BOX_GAS], 'the keeper is asked its price for a deposit');
  assert.strictEqual(M.boxes.length, 1);
  assert.strictEqual(M.boxes[0].amount, base.depositWei + 1500n);
  assert.strictEqual(M.boxes[0].fee, 1500n);
  assert.strictEqual(M.boxes[0].refund, REFUND, 'what the sale pays above the box is refundable to the address given');
  const left = M.boxes[0].deadline - Math.floor(Date.now() / 1000);
  assert.ok(left > 2300 && left <= 2400, `the box lasts forty minutes (${left} s)`);
  assert.strictEqual(plan.state, 'waiting');
  assert.strictEqual(plan.boxed, true);
  assert.strictEqual(plan.depositTx, HASH);
  assert.strictEqual(plan.box, BOX);
  assert.strictEqual(plan.boxWei, String(base.depositWei + 1500n));
  assert.deepStrictEqual(plan.boxIntent, { amount: String(base.depositWei + 1500n), refund: REFUND, deadline: String(M.boxes[0].deadline) }, 'the box\'s intent is kept: sending its balance back needs it');
  assert.strictEqual(plan.boxDeadline, M.boxes[0].deadline);
  assert.strictEqual(plan.pay.amountWei, '71234567', 'what was sold is what the funder found, not what the page sized before the box existed');
  assert.strictEqual(plan.pay.route, 'Uniswap v3 0.05%');
  assert.strictEqual(plan.from, PAYER, 'the wallet that deposited is kept, so the swap out is never sent from it');
  assert.strictEqual(plan.depositWei, String(base.depositWei));
  assert.strictEqual(plan.leaves0, M.leaves, 'the mix is counted from when the note appeared');
  assert.ok(plan.depositedAt > 0 && !plan.err);
  assert.deepStrictEqual(steps, ['opening your deposit box', 'making your deposit private']);
  assert.strictEqual(L.plans()[0].id, plan.id, 'the plan is kept for a closed tab');
  assert.strictEqual(L.plans()[0].state, 'waiting');
});

test('the refund address reaches the keeper in lower case, whatever case it was given in', async () => {
  const { L, M, complete } = setup();
  await L.startBoxed({ ...base, refund: '0x00000000000000000000000000000000000De5A0', fund: async () => { complete(base.depositWei); return HASH; } });
  assert.strictEqual(M.boxes[0].refund, '0x00000000000000000000000000000000000de5a0', 'a wrongly cased address would be refused by the keeper');
});

test('a funder that gives only the hash is taken as it is', async () => {
  const { L, complete } = setup();
  const plan = await L.startBoxed({ ...base, fund: async () => { complete(base.depositWei); return HASH; } });
  assert.strictEqual(plan.depositTx, HASH);
  assert.strictEqual(plan.pay.amountWei, '70000000', 'the page\'s own figure stays');
  assert.strictEqual(plan.pay.route, 'relay');
});

test('a note of the same size from before the box is not the deposit', async () => {
  const { L, M, complete } = setup({ leaves: 10 });
  M.notes.push({ v: String(base.depositWei), index: 4 });          // an older note of exactly that amount: some other money
  await assert.rejects(L.startBoxed({ ...base, waitMs: 20, fund: async () => HASH }), /its deposit is on its way/);
  assert.strictEqual(L.plans()[0].state, 'depositing');
  complete(base.depositWei);
  const again = await L.check(L.plans()[0]);
  assert.strictEqual(again.state, 'waiting', 'the new one is');
});

test('a no or a refusal before the order is posted leaves the plan stopped, whatever the words', async () => {
  for (const make of [
    () => Object.assign(new Error('The relay did not take the order. Nothing was spent.'), { nothingSpent: true }),
    () => Object.assign(new Error('some unusual wording'), { nothingSpent: true }),
    () => Object.assign(new Error('User rejected the request.'), { code: 4001 }),
    () => new Error('The price moved: the deposit takes more USDC than was shown. Nothing was spent; check it and press again.'),
    () => Object.assign(new Error('Cancelled in your wallet.'), { userStopped: true }),
  ]) {
    const { L, M } = setup();
    const err = make();
    await assert.rejects(L.startBoxed({ ...base, fund: async () => { throw err; } }), (e) => e === err);
    const p = L.plans()[0];
    assert.strictEqual(p.state, 'stopped', err.message);
    assert.ok(!p.depositTx && p.err, 'no transaction, and the reason is kept');
    assert.strictEqual(M.boxes.length, 1, 'the box was made and is only an address nobody paid');
  }
});

test('anything unclear after the box is made is unsure, never stopped: the order may have run', async () => {
  const { L } = setup();
  await assert.rejects(L.startBoxed({ ...base, fund: async () => { throw new Error('socket hang up'); } }), /socket hang up/);
  assert.strictEqual(L.plans()[0].state, 'unsure');
});

test('an order that ran with no hash found still waits for the keeper: the hash is the step\'s link alone', async () => {
  // the keeper completes the box: the plan waits, with no transaction to link
  const { L, complete } = setup();
  const plan = await L.startBoxed({ ...base, pollMs: 5, fund: async () => { complete(base.depositWei); return { hash: null }; } });
  assert.strictEqual(plan.state, 'waiting');
  assert.ok(!plan.depositTx, 'no hash was found');
  // the keeper has not: depositing (the order ran, so the box is funded, hash or none), and check moves it on once the note is there
  const { L: L2, complete: done2 } = setup();
  await assert.rejects(L2.startBoxed({ ...base, waitMs: 30, pollMs: 5, fund: async () => ({ hash: null }) }), (e) => e.pending === true && /its deposit is on its way/.test(e.message));
  assert.strictEqual(L2.plans()[0].state, 'depositing', 'an order that ran with no hash and no note yet is depositing');
  assert.strictEqual((await L2.check(L2.plans()[0])).state, 'depositing', 'and a check before the note is there leaves it so');
  done2(base.depositWei);
  assert.strictEqual((await L2.check(L2.plans()[0])).state, 'waiting');
});

test('a keeper that says what completing a box costs is paid a half over that, not over its quote for the default gas', async () => {
  const { L, M, complete } = setup({ fee: 1000n, depositFee: 1800n });
  await L.startBoxed({ ...base, fund: async ({ amount, fee }) => {
    assert.strictEqual(fee, 2700n, 'a half over its own figure of 1800');
    assert.strictEqual(amount, base.depositWei + 2700n);
    complete(base.depositWei);
    return HASH;
  } });
  assert.strictEqual(M.boxes[0].fee, 2700n);
});

test('the keeper failing to quote its fee stops the start in words, before anything is made', async () => {
  const { L, M } = setup();
  M.quoteError = true;
  await assert.rejects(L.startBoxed({ ...base, fund: async () => HASH }), (e) => e.nothingSpent === true && /keeper could not quote its fee/.test(e.message));
  assert.strictEqual(L.plans().length, 0, 'no plan, no box');
  assert.strictEqual(M.boxes.length, 0);
});

test('an order that ran and a box the keeper has not completed yet leaves the plan depositing, and check moves it on once the note is there', async () => {
  const { L, M, complete } = setup();
  await assert.rejects(L.startBoxed({ ...base, waitMs: 30, fund: async () => ({ hash: HASH, amountIn: 5n, route: 'r' }) }), (e) => e.pending === true && /its deposit is on its way/.test(e.message));
  let p = L.plans()[0];
  assert.strictEqual(p.state, 'depositing');
  assert.strictEqual(p.depositTx, HASH);
  assert.ok(p.err);
  p = await L.check(p);
  assert.strictEqual(p.state, 'depositing', 'still nothing: it stays depositing, not stopped');
  assert.strictEqual(p.err, null);
  complete(base.depositWei);
  p = await L.check(p);
  assert.strictEqual(p.state, 'waiting');
  assert.ok(p.depositedAt > 0 && !p.err);
  assert.strictEqual(p.leaves0, M.leaves, 'counted from the pool as it is now');
});

test('a box never completed is stopped after its deadline, and says where the ETH goes', async () => {
  const { L } = setup();
  await assert.rejects(L.startBoxed({ ...base, waitMs: 10, fund: async () => HASH }), /its deposit is on its way/);
  const p = L.plans()[0];
  p.at = Date.now() - 41 * 60e3;
  const after = await L.check(p);
  assert.strictEqual(after.state, 'stopped');
  assert.match(after.err, /still in the box.*send back to an address your key owns/);
});

test('an order not seen to run is unsure for as long as its box can be completed, then stopped', async () => {
  const { L } = setup();
  await assert.rejects(L.startBoxed({ ...base, fund: async () => { throw new Error('socket hang up'); } }), /socket hang up/);
  let p = L.plans()[0];
  p = await L.check(p);
  assert.strictEqual(p.state, 'unsure');
  assert.match(p.err, /may still send the swap/);
  p.at = Date.now() - 16 * 60e3;
  p = await L.check(p);
  assert.strictEqual(p.state, 'unsure', 'the order lasts ten minutes but the keeper can complete the box for forty: not stopped yet');
  p.at = Date.now() - 41 * 60e3;
  p = await L.check(p);
  assert.strictEqual(p.state, 'stopped', 'past the box\'s deadline nothing can complete it');
});

test('once the order has run, nothing that goes wrong after is called stopped, whatever the words', async () => {
  // the node's own words match the "no" patterns: the order ran, so a second deposit must not be invited
  const { L, M } = setup();
  await assert.rejects(L.startBoxed({ ...base, pollMs: 5, fund: async () => { M.failSyncAfter = M.syncs; return { hash: HASH }; } }), /rejected by the node/);
  assert.strictEqual(L.plans()[0].state, 'depositing');
  const { L: L2, M: M2 } = setup();
  await assert.rejects(L2.startBoxed({ ...base, pollMs: 5, fund: async () => { M2.failSyncAfter = M2.syncs; return { hash: null }; } }), /rejected by the node/);
  assert.strictEqual(L2.plans()[0].state, 'depositing', 'with no hash to show it: depositing all the same, the order having run');
});

test('a relayed start pays an address: no address, or a private destination with none, is refused before a box is made', async () => {
  const { L, M } = setup();
  for (const to of ['', null, undefined, '0x1234', 'tacit1abc']) {
    await assert.rejects(L.startBoxed({ ...base, to, waitMs: 20, pollMs: 5, fund: async () => HASH }), (e) => e.nothingSpent === true && /address it goes to/.test(e.message));
  }
  assert.strictEqual(M.boxes.length, 0, 'no box');
  assert.strictEqual(L.plans().length, 0, 'no plan');
});

test('the refund is a fresh receive box of the key by default, in lower case, and what is given is used as it is', async () => {
  const { L, M, complete } = setup();
  await L.startBoxed({ ...base, refund: undefined, pollMs: 5, fund: async () => { complete(base.depositWei); return HASH; } });
  assert.strictEqual(M.boxes[0].refund, REFUND_BOX.toLowerCase(), 'not a stable address of the key: the intent is public once the box is completed');
  const { L: L2, M: M2, complete: c2 } = setup();
  await L2.startBoxed({ ...base, refund: REFUND, pollMs: 5, fund: async () => { c2(base.depositWei); return HASH; } });
  assert.strictEqual(M2.boxes[0].refund, REFUND);
});

test('a swap out is refused when the plan has no address to pay', async () => {
  const { L } = setup();
  await assert.rejects(L.offer({ id: 'x', swapWei: '1', token: DAI, sym: 'DAI', dec: 18, to: '', depositWei: '1', state: 'waiting' }), /no address to pay/);
});

test('a deposit from the wallet the pool does not show yet stays in doubt for half an hour, so Check is still offered, and is stopped after', async () => {
  const { L } = setup();
  const plan = (age) => ({ id: 'x' + age, at: Date.now() - age, swapWei: '1', depositWei: '12345', state: 'depositing', leaves0: 10, token: DAI, sym: 'DAI', dec: 18, to: DEST });
  const young = await L.check(plan(10 * 60e3));
  assert.strictEqual(young.state, 'unsure', 'a slow transaction is not a failed one');
  assert.match(young.err, /may still be on its way/);
  assert.ok(!young.depositedAt);
  const old = await L.check(plan(31 * 60e3));
  assert.strictEqual(old.state, 'stopped');
  assert.match(old.err, /did not reach the pool/);
});

test('a deposit that lands after a check found nothing is found by the next one, and the mix is counted after its own pair of leaves', async () => {
  for (const [index, since] of [[10, 12], [11, 12]]) {
    const { L, M } = setup({ leaves: 10 });
    const plan = { id: 'x', at: Date.now() - 5 * 60e3, swapWei: '1', depositWei: '12345', state: 'depositing', leaves0: 10, token: DAI, sym: 'DAI', dec: 18, to: DEST };
    assert.strictEqual((await L.check(plan)).state, 'unsure');
    M.notes.push({ v: '12345', index }); M.leaves = 12;
    const p = await L.check(plan);
    assert.strictEqual(p.state, 'waiting');
    assert.strictEqual(p.depositedAt, plan.at);
    assert.strictEqual(p.leaves0, since, `the note at ${index} is in the pair that ends at ${since}`);
    assert.strictEqual((await L.blend(p)).since, 0, 'nothing else has been deposited since: the deposit is not mixed with itself');
    M.leaves = 16;
    assert.strictEqual((await L.blend(p)).since, 4);
  }
});

test('a plan whose browser cannot keep it stops a relayed start before a box is made or anything is sold', async () => {
  const M = { boxes: [] }, pool = { quote: async () => ({ fee: '1000' }), sync: async () => ({ leaves: 10 }), refundBox: async () => REFUND_BOX, notes: () => [], depositBox: async (a) => { M.boxes.push(a); return { box: BOX }; } };
  const L = makeLater({ keyHex: async () => { throw new Error('the key is not needed'); }, signer: { address: PAYER }, ethCall: async () => '0x', store: { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } }, walletOf: async () => pool, chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] } });
  let sold = false;
  await assert.rejects(L.startBoxed({ ...base, fund: async () => { sold = true; return HASH; } }), /could not keep the swap’s plan, so nothing was sent/);
  assert.strictEqual(M.boxes.length, 0);
  assert.strictEqual(sold, false);
});

test('it is refused before a box is made: the wallet is the destination, ETH is the payer, the token is the one bought, no wallet', async () => {
  const { L, M } = setup();
  await assert.rejects(L.startBoxed({ ...base, to: PAYER, fund: async () => HASH }), /another address/);
  await assert.rejects(L.startBoxed({ ...base, pay: { ...base.pay, token: ZERO }, fund: async () => HASH }), /another token/);
  await assert.rejects(L.startBoxed({ ...base, pay: { ...base.pay, token: DAI }, fund: async () => HASH }), /another token/);
  const mem = new Map(), none = makeLater({ keyHex: async () => '11'.repeat(32), signer: {}, ethCall: async () => '0x', store: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) }, walletOf: async () => ({}), chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] } });
  await assert.rejects(none.startBoxed({ ...base, fund: async () => HASH }), /Connect a wallet/);
  assert.strictEqual(M.boxes.length, 0, 'no box');
  assert.strictEqual(L.plans().length, 0, 'no plan was kept');
});

test('the keeper\'s refusal of the box is the end of it: nothing is sold', async () => {
  const { L, M } = setup();
  let sold = false;
  const pool = await (async () => null)();
  const mem = new Map(), L2 = makeLater({ keyHex: async () => '11'.repeat(32), signer: { address: PAYER }, ethCall: async () => '0x', store: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) },
    walletOf: async () => ({ quote: async () => ({ fee: '1000' }), sync: async () => ({ leaves: 1 }), notes: () => [], depositBox: async () => { throw new Error('The relay did not take this deposit (fee too low), so nothing was sent.'); } }), chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] } });
  await assert.rejects(L2.startBoxed({ ...base, fund: async () => { sold = true; return HASH; } }), /did not take this deposit/);
  assert.strictEqual(sold, false, 'the relay is never asked to sell into a box the keeper will not complete');
  assert.strictEqual(readPlans({ getItem: (k) => mem.get(k) ?? null })[0].state, 'stopped', 'and the plan says nothing was sent');
  void L; void M; void pool;
});


// ── placeOrder: the order's permits, its run before posting, and the wait ──
const GR = await import('../dapp/gas-relay.js');
const RELAY = GR.GAS_RELAY[1], TACADDR = GR.TAC, PERMIT2 = GR.PERMIT2, USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', ZROUTER = '0x000000000000fb114709235f1ccbffb925f600e4';
const SIG = '0x' + 'ab'.repeat(32) + 'cd'.repeat(32) + '1b', w32 = (v) => BigInt(v).toString(16).padStart(64, '0'), PAYER_ = '0x' + '0a'.repeat(20);
// a chain that is a table: nonces, allowances, Permit2's record, the contract's simulation and `used`, the block number and the log
function chainFor({ allowance = 0n, p2nonce = 7n, simulate = 'ok', usedAfter = 1, logs = [[{ transactionHash: HASH }]], block = 1000, blockFails = 0 } = {}) {
  const C = { calls: [], logs: [], polls: 0, blockReads: 0 };
  C.rpc = async (method, params) => {
    C.calls.push([method, params]);
    if (method === 'eth_blockNumber') { if (++C.blockReads <= blockFails) throw new Error('node down'); return '0x' + block.toString(16); }
    if (method === 'eth_getLogs') { C.logs.push(params[0]); const r = logs.length > C.logs.length - 1 ? logs[C.logs.length - 1] : logs[logs.length - 1]; return r; }
    if (method !== 'eth_call') throw new Error('unexpected ' + method);
    const { to, data, from } = params[0];
    if (data.startsWith('0x7ecebe00')) return '0x' + w32(5);
    if (data.startsWith('0xdd62ed3e')) return '0x' + w32(allowance);
    if (data.startsWith('0x927da105')) return '0x' + w32(10n ** 30n) + w32(0) + w32(p2nonce);
    if (data.startsWith('0xad04dc3f')) return '0x' + w32(++C.polls >= usedAfter ? 1 : 0);
    if (to.toLowerCase() === RELAY.toLowerCase()) { C.simulated = { from, data }; if (simulate !== 'ok') throw Object.assign(new Error('execution reverted'), { data: { data: simulate } }); return '0x'; }
    throw new Error('unexpected call ' + data.slice(0, 10));
  };
  return C;
}
function orderFor({ tokenIn = USDC, feeToken = tokenIn, amountIn = 5_000_000n, fee = 1_000_000n, ttlSecs = 600, now } = {}) {
  return GR.buildOrder({ payer: PAYER_, tokenIn, amountIn, feeToken, fee, tokenOut: ZERO, minOut: 1n, recipient: BOX, target: ZROUTER, data: '0x1234', ttlSecs, ...(now ? { now } : {}) });
}
const place = (o, C, extra = {}) => {
  const typed = [], bodies = [];
  const run = GR.placeOrder({ ...o, from: PAYER_, symbol: 'USDC', sign: { typed: async (t) => { typed.push(t); return SIG; } }, rpc: C.rpc, pollMs: 1, lookupMs: 1, minWait: 1,
    post: async (b) => { bodies.push(b); return { ok: true }; }, ...extra });
  return { run, typed, bodies };
};

test('placeOrder: an input that takes a permit and a fee in the same token: one permit for both, signed with the order, then the contract run as the relay will run it', async () => {
  const C = chainFor(), o = orderFor(), { run, typed, bodies } = place(o, C);
  assert.strictEqual(await run, HASH, 'the relay\'s transaction hash, from the contract\'s Executed event');
  assert.strictEqual(typed.length, 2, 'a permit and the order');
  assert.strictEqual(typed[0].primaryType, 'Permit');
  assert.strictEqual(typed[0].domain.name, 'USD Coin');
  assert.strictEqual(typed[0].message.spender.toLowerCase(), RELAY.toLowerCase());
  assert.strictEqual(typed[0].message.value, '6000000', 'the amount and the fee');
  assert.strictEqual(typed[1].primaryType, 'Order');
  assert.strictEqual(bodies.length, 1);
  const x = bodies[0].order;
  assert.strictEqual(x.signature, SIG);
  assert.strictEqual(x.inPermit.value, '6000000');
  assert.strictEqual(x.feePermit.deadline, '0', 'no second permit');
  assert.strictEqual(x.p2.use, false);
  assert.strictEqual(x.data, '0x1234');
  assert.ok(C.simulated && C.simulated.data.startsWith('0x7e75f5be'), 'the order was run as execute(...) before it was posted');
  assert.ok(typed[0].message.deadline > Math.floor(Date.now() / 1000) && Number(typed[0].message.deadline) > Number(o.order.deadline), 'the permit outlives the order');
});

test('placeOrder: a fee in TAC with an input that takes a permit signs a second permit, for the fee alone', async () => {
  const C = chainFor(), o = orderFor({ feeToken: TACADDR, fee: 40n * 10n ** 18n }), { run, typed, bodies } = place(o, C);
  await run;
  const permits = typed.filter((t) => t.primaryType === 'Permit');
  assert.strictEqual(permits.length, 2);
  assert.strictEqual(permits[0].message.value, '5000000', 'USDC for the sale alone');
  assert.strictEqual(permits[1].domain.name, 'Tacit Token');
  assert.strictEqual(permits[1].message.value, String(40n * 10n ** 18n));
  assert.strictEqual(bodies[0].order.feePermit.value, String(40n * 10n ** 18n));
  assert.notStrictEqual(bodies[0].order.feePermit.deadline, '0');
});

test('placeOrder: an input with no permit goes through one Permit2 batch once Permit2 is approved, and its fee must be in that token', async () => {
  const o = orderFor({ tokenIn: USDT, amountIn: 7_000_000n, fee: 1_000_000n });
  const none = chainFor({ allowance: 7_999_999n }), a = place(o, none);
  await assert.rejects(a.run, (e) => e.nothingSpent === true && /has not been approved for Permit2/.test(e.message));
  assert.strictEqual(a.bodies.length, 0, 'nothing posted');
  const C = chainFor({ allowance: 8_000_000n, p2nonce: 9n }), b = place(o, C);
  await b.run;
  const x = b.bodies[0].order;
  assert.strictEqual(x.p2.use, true);
  assert.strictEqual(x.p2.batch.spender.toLowerCase(), RELAY.toLowerCase());
  assert.deepStrictEqual(x.p2.batch.details.map((d) => [d.token.toLowerCase(), d.amount, d.nonce]), [[USDT, '8000000', '9']], 'one detail: the amount and the fee, with the nonce Permit2 holds');
  assert.strictEqual(x.inPermit.deadline, '0');
  assert.strictEqual(b.typed.filter((t) => t.primaryType === 'PermitBatch').length, 1);
  const tac = orderFor({ tokenIn: USDT, feeToken: TACADDR, fee: 10n ** 18n }), c = place(tac, chainFor({ allowance: 10n ** 30n }));
  await assert.rejects(c.run, (e) => e.nothingSpent === true && /takes no permit/.test(e.message));
  assert.strictEqual(c.bodies.length, 0);
});

test('placeOrder: an order the contract would revert is never posted, and says nothing was spent', async () => {
  const C = chainFor({ simulate: '0x52be750b' + '0'.repeat(56) }), { run, bodies } = place(orderFor(), C);
  await assert.rejects(run, (e) => e.nothingSpent === true && /would not go through, so nothing was sent \(0x52be750b/.test(e.message));
  assert.strictEqual(bodies.length, 0);
});

test('placeOrder: the relay refusing the order is final, with its reason; no answer at all is waited out like an order it has', async () => {
  const C = chainFor(), no = place(orderFor(), C, { post: async () => ({ ok: false, error: 'fee below the floor' }) });
  await assert.rejects(no.run, (e) => e.nothingSpent === true && /did not take the order: fee below the floor/.test(e.message));
  const C2 = chainFor({ usedAfter: 3 }), steps = [], silent = place(orderFor(), C2, { post: async () => null, step: (s) => steps.push(s) });
  assert.strictEqual(await silent.run, HASH, 'the order ran after all');
  assert.ok(steps.some((s) => /did not answer/.test(s)), 'and it said it was checking');
  const C3 = chainFor({ usedAfter: 1e9 }), lapsed = place(orderFor({ ttlSecs: 1 }), C3, { post: async () => null, minWait: 0.05, now: () => Math.floor(Date.now() / 1000) + 500 });
  await assert.rejects(lapsed.run, (e) => e.nothingSpent === true && /did not send it before the order lapsed \(it never answered\)\. Nothing was spent/.test(e.message));
});

test('placeOrder: an order the relay never sends lapses with nothing spent, and the wait is as long as the order can still run', async () => {
  const C = chainFor({ usedAfter: 1e9 }), t0 = Date.now();
  const x = place(orderFor({ ttlSecs: 1 }), C, { post: async () => ({ ok: true }), minWait: 0.3, now: () => Math.floor(Date.now() / 1000) - 14 });
  await assert.rejects(x.run, (e) => e.nothingSpent === true && /did not send it before the order lapsed\. Nothing was spent/.test(e.message));
  assert.ok(Date.now() - t0 >= 1900, `it waited for the order's own deadline and the margin, not only the least (${Date.now() - t0} ms)`);
});

test('placeOrder: the relay\'s transaction is looked for from the block the order was posted at, and asked again if no log shows yet', async () => {
  const C = chainFor({ block: 5000, logs: [[], [], [{ transactionHash: HASH }]] }), x = place(orderFor(), C);
  assert.strictEqual(await x.run, HASH);
  assert.strictEqual(C.logs.length, 3, 'asked three times');
  assert.strictEqual(C.logs[0].fromBlock, '0x' + (5000 - 3).toString(16), 'from three blocks before the one posted at');
  assert.strictEqual(C.logs[0].address.toLowerCase(), RELAY.toLowerCase());
  assert.strictEqual(C.logs[0].topics[1], '0x' + w32(BigInt(PAYER_)), 'the payer');
  assert.strictEqual(C.logs[0].topics[3], '0x' + w32(BigInt(x.bodies[0].order.order.nonce)), 'and the nonce');
  const none = chainFor({ logs: [[]] }), n = place(orderFor(), none);
  assert.strictEqual(await n.run, null, 'a log that never shows is no hash, not an error: the order ran');
  assert.strictEqual(none.logs.length, 5);
});

test('placeOrder: a node that fails the block number read before posting is read again after, and none at all asks for no log', async () => {
  const C = chainFor({ block: 9000, blockFails: 1 }), x = place(orderFor(), C);
  assert.strictEqual(await x.run, HASH);
  assert.strictEqual(C.logs[0].fromBlock, '0x' + (9000 - 50 - 3).toString(16), 'fifty blocks back, with the margin');
  const down = chainFor({ blockFails: 99 }), d = place(orderFor(), down);
  assert.strictEqual(await d.run, null);
  assert.strictEqual(down.logs.length, 0, 'no range to ask for, so no read');
});

test('placeOrder: a page that moved on (guard) stops it before anything is signed', async () => {
  const C = chainFor(), x = place(orderFor(), C, { guard: () => { throw new Error('Another Tacit wallet was opened.'); } });
  await assert.rejects(x.run, /Another Tacit wallet/);
  assert.strictEqual(x.typed.length, 0);
  assert.strictEqual(x.bodies.length, 0);
});
