// dapp/swap/later.js, the parts that need no chain: the deposit for "Swap privately" is not an amount of its own (the swap, the relay's fee
// twice and an extra drawn around the slider's share, never under a twentieth of the swap, rounded up to two significant figures).
//   node --test tests/swap-later.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { depositFor } = await import('../dapp/swap/later.js');

const sig = (v) => v.toString().replace(/0+$/, '').length;
const E = 10n ** 18n;

test('a deposit is a round amount: two significant figures, at least the swap, the fee twice and its extra', () => {
  for (const [swap, fee, pct] of [[5n * E / 10n, 30n ** 10n, 25], [2n * E / 100n, 12_345_678_901_234n, 60], [3n * E, 9n * 10n ** 14n, 100], [123_456_789_000_000n, 1n, 5]]) {
    for (const rand of [() => 0, () => 0.5, () => 0.999]) {
      const { depositWei, extraWei } = depositFor({ swapWei: swap, feeWei: fee, pct, rand });
      assert.ok(sig(depositWei) <= 2, `${depositWei} has more than two significant figures`);
      assert.strictEqual(depositWei, swap + 2n * fee + extraWei, 'the parts add up to the deposit');
      assert.ok(extraWei * 100n >= swap * 5n, `the extra ${extraWei} is at least a twentieth of the swap ${swap}`);
    }
  }
});

test('the extra is drawn around the slider: three quarters to one and a quarter of its share', () => {
  const swap = 10n ** 18n, at = (r) => depositFor({ swapWei: swap, feeWei: 0n, pct: 40, rand: () => r });
  assert.ok(at(0).depositWei < at(0.999).depositWei, 'a different draw makes a different deposit');
  assert.ok(at(0).extraWei >= (swap * 30n) / 100n && at(0.999).extraWei <= (swap * 51n) / 100n + swap / 10n, 'within the range around 40%');
});

test('a zero share is not offered: the floor keeps the deposit from being the swap and its fee', () => {
  const { depositWei } = depositFor({ swapWei: 10n ** 17n, feeWei: 10n ** 14n, pct: 0, rand: () => 0 });
  assert.ok(depositWei >= 10n ** 17n + 2n * 10n ** 14n + 5n * 10n ** 15n);
});

test('a swap into a private balance sets aside the gas to make it private, on top of the fee and the extra', () => {
  const swap = 10n ** 17n, fee = 10n ** 14n, gas = 15n * 10n ** 14n;
  const a = depositFor({ swapWei: swap, feeWei: fee, pct: 25, rand: () => 0.5 }), b = depositFor({ swapWei: swap, feeWei: fee, pct: 25, rand: () => 0.5, gasWei: gas });
  assert.ok(b.depositWei >= a.depositWei + gas - 10n ** 16n, 'the deposit grows by about the gas');
  assert.strictEqual(b.depositWei, swap + 2n * fee + gas + b.extraWei, 'the parts, with the gas, add up to the deposit');
  assert.ok(b.extraWei * 100n >= swap * 5n, 'the extra still keeps its floor');
});

// ── making a swap's TAC private (shield): only what the swap paid, and a wrap already sent is never sent twice ──
const { makeLater } = await import('../dapp/swap/later.js');
const TAC = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279', ACCT = '0x' + 'ac'.repeat(20), SCALE = 10n ** 10n, TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SWAP_TX = '0x' + '5a'.repeat(32), WRAP_TX = '0x' + 'a7'.repeat(32);
// a node that knows the swap (paying the account `paid` TAC) and, once mined, the wrap (`wrapStatus`: null = not mined yet)
function chainWith({ paid, wrapStatus = '0x1' }) {
  globalThis.fetch = async (_url, init) => {
    const j = JSON.parse(init.body), one = (x) => {
      if (x.method !== 'eth_getTransactionReceipt') return { jsonrpc: '2.0', id: x.id, result: null };
      const h = x.params[0];
      if (h === SWAP_TX) return { jsonrpc: '2.0', id: x.id, result: { status: '0x1', logs: [{ address: TAC, topics: [TRANSFER, '0x' + '0'.repeat(64), '0x' + ACCT.slice(2).padStart(64, '0')], data: '0x' + paid.toString(16) }] } };
      if (h === WRAP_TX) return { jsonrpc: '2.0', id: x.id, result: wrapStatus ? { status: wrapStatus, logs: [] } : null };
      return { jsonrpc: '2.0', id: x.id, result: null };
    };
    return new Response(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)), { headers: { 'content-type': 'application/json' } });
  };
}
function setup({ paid, held, wrapStatus, plan: over = {}, sendFails = false }) {
  chainWith({ paid, wrapStatus });
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  const M = { wraps: [], sends: [], held };
  const t = { assetByTicker: { TAC: { assetId: '0x' + '7a'.repeat(32), unitScale: String(SCALE) } }, account: () => ({ address: ACCT }),
    ethCall: async () => '0x' + M.held.toString(16), routerWrap: async ({ amountWei }) => { M.wraps.push(BigInt(amountWei)); M.held -= BigInt(amountWei); return { txHash: WRAP_TX }; }, waitReceipt: async () => {} };
  const sendPrivate = async (o) => { M.sends.push(o); if (sendFails) throw new Error('the relay is busy'); return { sent: { txHash: '0x' + 'ee'.repeat(32) } }; };
  const L = makeLater({ keyHex: async () => '11'.repeat(32), signer: { address: '0x' + '01'.repeat(20) }, ethCall: async () => '0x', ux: async () => t, sendPrivate, store, chain: { chainId: 1, rpc: ['http://node.test'], keeper: null, deployBlock: 0, confirmations: 0 } });
  const plan = { id: 'p', at: Date.now(), swapWei: '1', depositWei: '2', token: TAC, sym: 'TAC', dec: 18, to: ACCT, dest: { kind: 'tacit', pubHex: '02' + 'cd'.repeat(32), name: 'bob.wei' }, state: 'shielding', swapTx: SWAP_TX, tacBefore: '0', min: '1', ...over };
  return { L, M, plan };
}

test('the wrap takes what the swap paid the account, not other TAC that arrived there meanwhile', async () => {
  const paid = 123n * SCALE + 7n, { L, M, plan } = setup({ paid, held: paid + 999n * SCALE });
  const done = await L.shield(plan);
  assert.deepStrictEqual(M.wraps, [123n * SCALE], 'exactly the swap\'s TAC, rounded down to the pool\'s unit');
  assert.strictEqual(done.state, 'done');
  assert.strictEqual(M.sends[0].units, 123n, 'and that note is what is sent on');
});

test('a send-on that stopped after the wrap is pressed again: the wrap is not made twice, the note is sent', async () => {
  const paid = 50n * SCALE, s1 = setup({ paid, held: paid, sendFails: true });
  await assert.rejects(s1.L.shield(s1.plan), /relay is busy/);
  assert.strictEqual(s1.plan.state, 'held');
  assert.strictEqual(s1.plan.shieldTx, WRAP_TX, 'the wrap is kept on the plan');
  const s2 = setup({ paid, held: 0n, plan: { ...s1.plan } });
  const done = await s2.L.shield(s2.plan);
  assert.strictEqual(s2.M.wraps.length, 0, 'no second wrap');
  assert.strictEqual(s2.M.sends[0].units, 50n);
  assert.strictEqual(done.state, 'done');
});

test('a wrap not mined yet is waited for, never sent again; one that reverted is made again', async () => {
  const paid = 9n * SCALE, base = { shieldTx: WRAP_TX, shielded: String(paid), state: 'held' };
  const a = setup({ paid, held: paid, wrapStatus: null, plan: base });
  await assert.rejects(a.L.shield(a.plan), /still being mined/);
  assert.strictEqual(a.M.wraps.length, 0);
  const b = setup({ paid, held: paid, wrapStatus: '0x0', plan: base });
  const done = await b.L.shield(b.plan);
  assert.deepStrictEqual(b.M.wraps, [paid], 'reverted: wrapped again');
  assert.strictEqual(done.state, 'done');
});

// ── a swap out of what a pool already holds (adopt): refused before anything is read or kept when it cannot go ──
const { heldSwapMax } = await import('../dapp/swap/later.js');
test('the most a pool balance can swap leaves the relay’s fee twice, and nothing when the balance is no more than that', () => {
  assert.strictEqual(heldSwapMax(1000n, 100n), 800n);
  assert.strictEqual(heldSwapMax(200n, 100n), 0n);
  assert.strictEqual(heldSwapMax('1000', '100'), 800n, 'strings read as amounts');
});

test('a held swap with no amount, no address or a pool not open is refused, and no plan is kept', async () => {
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  const L = makeLater({ keyHex: async () => { throw new Error('the key must not be opened'); }, signer: {}, ethCall: async () => '0x', store, chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] } });
  const base = { swapWei: 5n, token: TAC, sym: 'TAC', dec: 18, to: ACCT, feeWei: 1n };
  await assert.rejects(L.adopt({ ...base, swapWei: 0n }), /enter an amount/);
  await assert.rejects(L.adopt({ ...base, to: 'bob.eth' }), /address/);
  await assert.rejects(L.adopt({ ...base, hop: { state: { pool: true, router: false } }, pay: { sym: 'USDC', dec: 6 } }), /USDC pool is not open/);
  assert.strictEqual(L.plans().length, 0, 'nothing was kept');
});

// ── a deposit proved ahead of the press: proofs run one at a time, and of the deposits asked for the latest is the one proved ──
const { oneAtATime } = await import('../dapp/swap/later.js');
test('oneAtATime runs one call at a time in the order asked, and a failure does not stop the next', async () => {
  let running = 0, peak = 0;
  const order = [], f = oneAtATime(async (x) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 10)); order.push(x); running--; if (x === 'bad') throw new Error('stopped'); return x; });
  const done = await Promise.allSettled([f('a'), f('bad'), f('c')]);
  assert.strictEqual(peak, 1);
  assert.deepStrictEqual(order, ['a', 'bad', 'c']);
  assert.strictEqual(done[1].status, 'rejected');
  assert.strictEqual(done[2].value, 'c');
});

function aheadLater(walletOf) {
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  return makeLater({ keyHex: async () => '11'.repeat(32), signer: {}, ethCall: async () => '0x', store, walletOf, chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] } });
}
test('ahead proves the latest deposit asked for on the pool it goes into, and one run serves every ask meanwhile', async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const proved = [], L = aheadLater(async (hop) => { await gate; return { prepareDeposit: async (a) => { proved.push([hop?.id ?? null, a]); } }; });
  const first = L.ahead({ depositWei: 1n });
  L.ahead({ depositWei: 2n });
  const last = L.ahead({ depositWei: 3n, hop: { id: 'usdc' } });
  assert.strictEqual(first, last, 'one run');
  open();
  await last;
  assert.deepStrictEqual(proved, [['usdc', 3n]], 'only the latest, on its pool');
  await L.ahead({ depositWei: '40' });
  assert.deepStrictEqual(proved[1], [null, 40n], 'a new ask after the run ended starts another, and an amount may be a string');
});

test('ahead: a wallet that cannot be opened ends the run with that error, and the next ask tries again', async () => {
  let n = 0;
  const closed = Object.assign(new Error('Cancelled.'), { unlockCancelled: true }), proved = [];
  const L = aheadLater(async () => { if (!n++) throw closed; return { prepareDeposit: async (a) => { proved.push(a); } }; });
  await assert.rejects(L.ahead({ depositWei: 5n }), (e) => e === closed);
  await L.ahead({ depositWei: 6n });
  assert.deepStrictEqual(proved, [6n]);
});

test('ahead: a figure that fails does not stop a newer one asked for meanwhile', async () => {
  let open; const gate = new Promise((r) => { open = r; });
  const proved = [], L = aheadLater(async () => ({ prepareDeposit: async (a) => { if (a === 1n) { await gate; throw new Error('Proving stopped on this device'); } proved.push(a); } }));
  const run = L.ahead({ depositWei: 1n });
  await new Promise((r) => setTimeout(r, 20));
  L.ahead({ depositWei: 2n });
  open();
  await run;
  assert.deepStrictEqual(proved, [2n]);
});

test('ahead: a failure with nothing newer asked is the run\'s, and a key that could not be opened ends it even with a newer figure waiting', async () => {
  const L1 = aheadLater(async () => ({ prepareDeposit: async () => { throw new Error('Proving stopped on this device'); } }));
  await assert.rejects(L1.ahead({ depositWei: 1n }), /Proving stopped/);
  let open; const gate = new Promise((r) => { open = r; });
  const closed = Object.assign(new Error('Cancelled.'), { unlockCancelled: true }), proved = [];
  let n = 0;
  const L2 = aheadLater(async () => { if (!n++) { await gate; throw closed; } return { prepareDeposit: async (a) => { proved.push(a); } }; });
  const run = L2.ahead({ depositWei: 1n });
  L2.ahead({ depositWei: 2n });
  open();
  await assert.rejects(run, (e) => e === closed);
  assert.deepStrictEqual(proved, [], 'the sheet is not shown a second time for the newer figure');
  await L2.ahead({ depositWei: 3n });
  assert.deepStrictEqual(proved, [3n]);
});
