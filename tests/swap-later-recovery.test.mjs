// dapp/swap/later.js, the two ways a plan gets its money back or is told the truth about it:
//   - a boxed plan (the relay sells the token into a deposit box, the pool's keeper completes the box) whose box never reached the pool: reclaimBox sends the router's
//     reclaimDeposit for the plan's own intent once the box's deadline has passed, from the wallet, once;
//   - a direct payout (a plan with no escrow): judged by its own transaction, else by the notes it was built from, else (a plan from before either was kept) by the pool's balance.
// The pool's wallet is a fake and the chain a local JSON-RPC server, so nothing needs the network.
//   node --test tests/swap-later-recovery.test.mjs
// LATER_JS=<path> runs the same tests against another copy of later.js (the old one, to see them fail).
import { test, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { makeLater, ROUTER } = await import(process.env.LATER_JS ? new URL(process.env.LATER_JS, 'file://' + process.cwd() + '/').href : '../dapp/swap/later.js');
const gw = await import('../dapp/evm-pool-gateway.js');

const PAYER = '0x' + '0a'.repeat(20), DEST = '0x' + '0d'.repeat(20), TO = '0x' + 'c2'.repeat(20), BOX = '0x' + 'b0'.repeat(20), REFUND_BOX = '0x' + 'ab'.repeat(20), ZERO = '0x' + '00'.repeat(20);
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const HASH = '0x' + 'ab'.repeat(32), SEND = '0x' + 'cd'.repeat(32), PAYOUT = '0x' + 'ef'.repeat(32);
const E18 = 10n ** 18n;
const SELECTORS = { reclaim: '0xf255eb45', boxOf: '0x34a44915', notExpired: '0xd0404f85', nothing: '0xfddb35b3' };

// ── a chain: just what the plan's reads ask ──
const servers = [];
async function chain(state = {}) {
  const S = { balance: 0n, boxAt: BOX, receipts: {}, sim: null, calls: [], ...state };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      S.calls.push({ method, params });
      const ok = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      const err = (message, data) => res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message, ...(data ? { data } : {}) } }));
      res.setHeader('content-type', 'application/json');
      if (method === 'eth_getBalance') return ok('0x' + S.balance.toString(16));
      if (method === 'eth_getTransactionReceipt') return ok(S.receipts[params[0]] ?? null);
      if (method === 'eth_call') {
        const data = params[0].data;
        if (data.startsWith(SELECTORS.boxOf)) return ok('0x' + S.boxAt.slice(2).toLowerCase().padStart(64, '0'));
        if (data.startsWith('0x70a08231')) return ok('0x' + (S.tokenBal ?? 0n).toString(16).padStart(64, '0'));      // a token's balanceOf
        if (data.startsWith(SELECTORS.reclaim)) {
          if (S.sim === 'down') return res.end('not json');
          if (S.sim === 'expired') return err('execution reverted', SELECTORS.notExpired);
          if (S.sim === 'empty') return err('execution reverted', SELECTORS.nothing);
          if (S.sim === 'other') return err('execution reverted: BadIntent', '0xa5a5a5a5');
          return ok('0x');
        }
      }
      err('unexpected ' + method);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  S.url = `http://127.0.0.1:${srv.address().port}`;
  return S;
}
after(() => { for (const s of servers) s.close(); });

// ── a boxed plan: made by startBoxed against a fake pool wallet, whose box the keeper never completes ──
const intentOf = (a) => ({ amount: String(a.amount), outLeaf0: '123456789', outLeaf1: '0', memo0Hash: '0x' + '11'.repeat(32), memo1Hash: '0x' + '22'.repeat(32), refund: a.refund, deadline: String(a.deadline), nonce: '7777' });
function boxedSetup({ C, skew = 0, signer = {} } = {}) {
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  const sent = [], clock = { skew };
  const pool = {
    quote: async () => ({ fee: '1000' }), sync: async () => ({ leaves: 10, balance: 0n, notes: 0 }), notes: () => [], refundBox: async () => REFUND_BOX,
    depositBox: async (a) => ({ box: BOX, amount: a.amount, value: a.amount - a.fee, deadline: a.deadline, intent: intentOf(a) }),
  };
  const sg = { address: PAYER, send: async (tx) => { sent.push(tx); return SEND; }, receipt: async () => ({ status: '0x1' }), ...signer };
  const L = makeLater({ keyHex: async () => { throw new Error('the key is not needed'); }, signer: sg, ethCall: async () => '0x', store, walletOf: async () => pool, chain: { chainId: 1, rpc: [C.url] }, now: () => Date.now() + clock.skew });
  return { L, store, sent, clock, mem };
}
const base = { swapWei: 20n * 10n ** 15n, extraWei: 8n * 10n ** 15n, token: DAI, sym: 'DAI', dec: 18, to: DEST, depositWei: 3n * 10n ** 16n, pay: { token: USDC, sym: 'USDC', dec: 6, amountIn: 70_000_000n }, pollMs: 5 };
// the relay's sale ran and the keeper never completed the box: forty-one minutes on, the plan is stopped and the box's deadline (forty minutes from its making) has passed
async function stoppedPlan(ctx) {
  await assert.rejects(ctx.L.startBoxed({ ...base, waitMs: 20, fund: async () => HASH }), /its deposit is on its way/);
  const p = ctx.L.plans()[0];
  ctx.mem.set('tacit-swap-later-v1', JSON.stringify([{ ...p, at: Date.now() - 41 * 60e3 }]));
  const stopped = await ctx.L.check(ctx.L.plans()[0]);
  assert.strictEqual(stopped.state, 'stopped');
  ctx.clock.skew = 41 * 60e3;
  return stopped;
}
const words = (data) => data.slice(10).match(/.{64}/g);

test('a box the keeper never completed is sent back by the router\'s reclaim for the plan\'s own intent, from the wallet, once', async () => {
  const C = await chain({ balance: 5n * 10n ** 16n }), ctx = boxedSetup({ C }), steps = [];
  const plan = await stoppedPlan(ctx);
  assert.strictEqual(await ctx.L.boxHolds(plan), 5n * 10n ** 16n, 'the card can see what the box holds');
  const r = await ctx.L.reclaimBox(plan, { onStep: (s) => steps.push(s) });
  assert.strictEqual(ctx.sent.length, 1, 'one transaction');
  const tx = ctx.sent[0];
  assert.strictEqual(tx.to, ROUTER);
  assert.strictEqual(tx.value, 0n);
  assert.ok(tx.data.startsWith(SELECTORS.reclaim), 'reclaimDeposit(intent, token)');
  const w = words(tx.data), i = plan.boxIntent;
  assert.strictEqual(w.length, 9);
  assert.deepStrictEqual(w.slice(0, 5).map((x) => BigInt('0x' + x)), [BigInt(i.amount), BigInt(i.outLeaf0), BigInt(i.outLeaf1), BigInt(i.memo0Hash), BigInt(i.memo1Hash)], 'the amount, both leaves, both memo hashes');
  assert.strictEqual('0x' + w[5].slice(24), i.refund, 'the refund address the box was made with');
  assert.deepStrictEqual(w.slice(6, 8).map((x) => BigInt('0x' + x)), [BigInt(i.deadline), BigInt(i.nonce)]);
  assert.strictEqual(BigInt('0x' + w[8]), 0n, 'the token is ETH');
  assert.strictEqual(r.hash, SEND);
  assert.strictEqual(r.wei, 5n * 10n ** 16n);
  assert.strictEqual(r.to, REFUND_BOX.toLowerCase(), 'where it goes: the box\'s refund');
  assert.deepStrictEqual(steps, ['confirm in your wallet', 'waiting for the block']);
  const kept = ctx.L.plans()[0];
  assert.strictEqual(kept.reclaimTx, SEND);
  assert.ok(kept.reclaimedAt > 0 && /sent back/.test(kept.err), 'the plan says it was sent back');
  // pressed again, it looks at the send and makes no other
  const again = await ctx.L.reclaimBox(kept);
  assert.strictEqual(again.again, true);
  assert.strictEqual(ctx.sent.length, 1, 'never twice');
});

test('the box is read for its balance and the plan\'s intent must make it; a plan with no box has none', async () => {
  const C = await chain({ balance: 7n }), ctx = boxedSetup({ C });
  const plan = await stoppedPlan(ctx);
  assert.strictEqual(await ctx.L.boxHolds(plan), 7n);
  assert.strictEqual(await ctx.L.boxHolds({ ...plan, box: undefined }), null);
  assert.strictEqual(await ctx.L.boxHolds({ ...plan, boxIntent: null }), null);
  assert.strictEqual(await ctx.L.boxHolds({ id: 'x', state: 'stopped' }), null);
  C.boxAt = '0x' + 'bb'.repeat(20);
  await assert.rejects(ctx.L.reclaimBox(plan), /does not match its box/);
  assert.strictEqual(ctx.sent.length, 0);
});

test('nothing is sent while the deadline has not passed, or the box is empty, or the plan is not stopped', async () => {
  const C = await chain({ balance: 10n ** 16n }), ctx = boxedSetup({ C });
  const plan = await stoppedPlan(ctx);
  ctx.clock.skew = 0;                                                         // the chain's time is before the box's deadline
  await assert.rejects(ctx.L.reclaimBox(plan), /once its deadline has passed.*Nothing was sent/);
  ctx.clock.skew = 41 * 60e3; C.balance = 0n;
  await assert.rejects(ctx.L.reclaimBox(plan), /holds nothing.*Nothing was sent/);
  C.balance = 10n ** 16n;
  for (const state of ['waiting', 'depositing', 'unsure', 'done']) {
    ctx.mem.set('tacit-swap-later-v1', JSON.stringify([{ ...plan, state }]));
    await assert.rejects(ctx.L.reclaimBox({ ...plan, state }), /no deposit box to send back/, state);
  }
  assert.strictEqual(ctx.sent.length, 0);
  assert.ok(!ctx.L.plans()[0].reclaimTx);
});

test('a record with no intent, or half of one, is not sent', async () => {
  const C = await chain({ balance: 10n ** 16n }), ctx = boxedSetup({ C });
  const plan = await stoppedPlan(ctx);
  for (const boxIntent of [null, { amount: '1', refund: REFUND_BOX, deadline: '5' }]) {
    ctx.mem.set('tacit-swap-later-v1', JSON.stringify([{ ...plan, boxIntent }]));
    await assert.rejects(ctx.L.reclaimBox({ ...plan, boxIntent }), /no deposit box to send back|incomplete/);
  }
  assert.strictEqual(ctx.sent.length, 0);
});

test('the router\'s own refusals are said in words and nothing is sent; a check that could not be made is not a refusal', async () => {
  const C = await chain({ balance: 10n ** 16n }), ctx = boxedSetup({ C });
  const plan = await stoppedPlan(ctx);
  for (const [sim, say] of [['expired', /deadline has not passed yet/], ['empty', /holds nothing/], ['other', /would refuse it.*BadIntent/], ['down', /Could not check the send-back just now/]]) {
    C.sim = sim;
    await assert.rejects(ctx.L.reclaimBox(plan), say, sim);
  }
  assert.strictEqual(ctx.sent.length, 0);
  assert.ok(!ctx.L.plans()[0].reclaimTx);
});

test('a wallet that says no sends nothing and leaves no send behind', async () => {
  const C = await chain({ balance: 10n ** 16n }), ctx = boxedSetup({ C, signer: { send: async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); } } });
  const plan = await stoppedPlan(ctx);
  await assert.rejects(ctx.L.reclaimBox(plan), /User rejected/);
  assert.ok(!ctx.L.plans()[0].reclaimTx);
  assert.strictEqual(ctx.L.plans()[0].state, 'stopped');
});

test('a send that failed on chain is made again; one not mined yet is not made twice', async () => {
  const C = await chain({ balance: 10n ** 16n });
  let status = '0x0';
  const ctx = boxedSetup({ C, signer: { receipt: async () => ({ status }) } });
  const plan = await stoppedPlan(ctx);
  await assert.rejects(ctx.L.reclaimBox(plan), /failed on chain, so the box still holds it/);
  assert.ok(!ctx.L.plans()[0].reclaimTx, 'a failed send is not kept');
  // the wallet cannot say whether the next one landed: its hash is kept, and a press looks at it
  ctx.sent.length = 0;
  const ctx2 = boxedSetup({ C, signer: { receipt: async () => null } });
  const p2 = await stoppedPlan(ctx2);
  await assert.rejects(ctx2.L.reclaimBox(p2), /has not confirmed yet/);
  assert.strictEqual(ctx2.L.plans()[0].reclaimTx, SEND, 'the hash is kept');
  await assert.rejects(ctx2.L.reclaimBox(ctx2.L.plans()[0]), /still being mined/);
  assert.strictEqual(ctx2.sent.length, 1, 'no second send');
  // it lands: the next press settles on it
  C.receipts[SEND] = { status: '0x1' };
  const done = await ctx2.L.reclaimBox(ctx2.L.plans()[0]);
  assert.strictEqual(done.again, true);
  assert.ok(ctx2.L.plans()[0].reclaimedAt > 0);
  assert.strictEqual(ctx2.sent.length, 1);
  // a hash whose receipt shows it failed is dropped and the send made again
  const ctx3 = boxedSetup({ C });
  const p3 = await stoppedPlan(ctx3);
  const keep = ctx3.L.plans()[0];
  ctx3.mem.set('tacit-swap-later-v1', JSON.stringify([{ ...keep, reclaimTx: '0x' + '99'.repeat(32), reclaimAt: Date.now() - 60e3, reclaimWei: '1' }]));
  C.receipts['0x' + '99'.repeat(32)] = { status: '0x0' };
  const r3 = await ctx3.L.reclaimBox(p3);
  assert.strictEqual(r3.hash, SEND);
  assert.strictEqual(ctx3.sent.length, 1);
});

// ── a direct payout (no escrow) ──
function payoutSetup({ C, notes = [], balance = 2n * E18, fee = 100_000n, withdraw = null } = {}) {
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  const W = { balance, notes, calls: [], seen: [] };
  const w = {
    sync: async () => ({ balance: W.balance, leaves: 40, block: 100 }), notes: () => W.notes, quote: async () => ({ fee: String(fee) }), refundBox: async () => REFUND_BOX,
    withdraw: async (a) => { W.calls.push(a); return withdraw ? withdraw(a, W, store) : PAYOUT; },
  };
  const L = makeLater({ keyHex: async () => '22'.repeat(32), signer: { address: PAYER }, ethCall: async () => '0x', store, walletOf: () => w, chain: { chainId: 1, rpc: [C.url] } });
  return { L, W, store, mem };
}
const SWAP = E18;
// a payout of 1 ETH to TO from the ETH pool, whose balance was 3 ETH before it was sent
const sentPlan = async ({ L, W }, over = {}) => {
  const now = W.balance; W.balance = 3n * E18;                                  // adopted while the pool held what it did before the payout
  const plan = await L.adopt({ swapWei: SWAP, token: ZERO, sym: 'ETH', dec: 18, to: TO, feeWei: 100_000n });
  W.balance = now;
  return { ...plan, state: 'swapping', balBefore: String(3n * E18), swapBlock: 100, swapAt: Date.now() - 60e3, ...over };
};
const rcOk = { status: '0x1' }, rcFail = { status: '0x0' };

test('the payout\'s leaves and hash are kept by the time the wallet is waiting for the block, so a lost answer or a closed tab leaves them', async () => {
  const C = await chain();
  let during = null;
  const { L, W } = payoutSetup({ C, notes: [{ index: 31, v: String(3n * E18) }], withdraw: async (a, _w, store) => {
    a.onSend([31]);
    a.onSent(PAYOUT);
    during = JSON.parse(store.getItem('tacit-swap-later-v1'))[0];
    throw new Error('The relay did not answer, and it may still have sent your payment. Check Activity before sending again.');
  } });
  const plan = await L.adopt({ swapWei: SWAP, token: ZERO, sym: 'ETH', dec: 18, to: TO, feeWei: 100_000n });
  await assert.rejects(L.swapOut(plan, { shown: await L.offer(plan), via: 'relay' }), /may still have sent/);
  assert.deepStrictEqual([during?.outIns, during?.outTx, during?.state], [[31], PAYOUT, 'swapping'], 'kept while the send is still being waited for');
  const kept = L.plans()[0];
  assert.strictEqual(kept.state, 'unsure');
  assert.deepStrictEqual([kept.outIns, kept.outTx], [[31], PAYOUT]);
  assert.strictEqual(W.calls.length, 1);
});

test('a new try forgets the last one\'s leaves and hash before it can leave its own', async () => {
  const C = await chain();
  let seen = null;
  const { L } = payoutSetup({ C, withdraw: async (_a, _w, store) => { seen = JSON.parse(store.getItem('tacit-swap-later-v1'))[0]; return PAYOUT; } });
  const plan = { ...(await L.adopt({ swapWei: SWAP, token: ZERO, sym: 'ETH', dec: 18, to: TO, feeWei: 100_000n })), outIns: [5], outTx: '0x' + '55'.repeat(32) };
  await L.swapOut(plan, { shown: await L.offer(plan), via: 'relay' });
  assert.strictEqual(seen.state, 'swapping');
  assert.ok(!seen.outIns && !seen.outTx, 'a check made while this try is proved does not judge it by the last one');
});

test('a try that went nowhere, or a check that offers the payout again, does not leave its notes behind to be taken for a later payout', async () => {
  const C = await chain();
  const { L, store } = payoutSetup({ C, withdraw: async (a) => { a.onSend([31]); throw new Error('The relay fee went up since it was shown. Check the new fee and try again.'); } });
  const plan = await L.adopt({ swapWei: SWAP, token: ZERO, sym: 'ETH', dec: 18, to: TO, feeWei: 100_000n });
  await assert.rejects(L.swapOut(plan, { shown: await L.offer(plan), via: 'relay' }), /fee went up/);
  const kept = JSON.parse(store.getItem('tacit-swap-later-v1'))[0];
  assert.strictEqual(kept.state, 'waiting');
  assert.ok(!kept.outIns && !kept.outTx, 'a try that was refused spent nothing, so nothing says it did');
  const s = payoutSetup({ C, balance: 3n * E18, notes: [{ index: 31, v: '1' }] });
  const stale = await sentPlan(s, { state: 'unsure', swapAt: Date.now() - 21 * 60e3, outIns: [31], outTx: PAYOUT });
  C.receipts[PAYOUT] = rcFail;
  const again = await s.L.check(stale);
  assert.strictEqual(again.state, 'waiting');
  assert.ok(!again.outIns && !again.outTx, 'offered again, it starts clean');
});

test('a payout whose own transaction succeeded is done, whatever the pool\'s balance did since', async () => {
  const C = await chain({ receipts: { [PAYOUT]: rcOk } });
  // another deposit made the balance look as if nothing had left: 3 ETH before, 1 out, 2 and a half in
  const s = payoutSetup({ C, balance: 4n * E18 + E18 / 2n, notes: [{ index: 31, v: '1' }] }), { L } = s;
  const plan = await sentPlan(s, { state: 'unsure', swapAt: Date.now() - 30 * 60e3, outTx: PAYOUT, outIns: [31] });
  const checked = await L.check(plan);
  assert.strictEqual(checked.state, 'done');
  assert.strictEqual(checked.swapTx, PAYOUT, 'and its hash is the link');
});

test('a payout whose own transaction reverted is offered again at once; one not mined yet stays in doubt, whatever the state', async () => {
  const C = await chain({ receipts: { [PAYOUT]: rcFail } });
  const mk = async (over) => { const s = payoutSetup({ C, balance: 3n * E18, notes: [{ index: 31, v: '1' }] }); return { ...s, plan: await sentPlan(s, over) }; };
  for (const state of ['unsure', 'swapping']) {
    const { L, plan } = await mk({ state, outTx: PAYOUT, outIns: [31] });
    const checked = await L.check(plan);
    assert.strictEqual(checked.state, 'waiting', `${state}: a reverted payout paid nothing`);
    assert.ok(!checked.err);
  }
  // not mined: the pool shows its notes unspent, but the transaction may still land
  for (const state of ['unsure', 'swapping']) {
    const { L, plan } = await mk({ state, outTx: '0x' + '77'.repeat(32), outIns: [31] });
    const checked = await L.check(plan);
    assert.strictEqual(checked.state, 'unsure', `${state}: sent a minute ago and not seen yet`);
    assert.match(checked.err, /not mined yet/);
  }
  // not mined for twenty minutes: it is not coming
  const { L, plan } = await mk({ state: 'unsure', outTx: '0x' + '77'.repeat(32), outIns: [31], swapAt: Date.now() - 21 * 60e3 });
  assert.strictEqual((await L.check(plan)).state, 'waiting');
});

test('with no hash, the notes the payout was built from being spent says it went, whatever the balance', async () => {
  const C = await chain();
  // note 31 is gone and the balance is up on what it was (another deposit): the old balance test said it had not gone
  const s = payoutSetup({ C, balance: 5n * E18, notes: [{ index: 44, v: String(5n * E18) }] }), { L } = s;
  const plan = await sentPlan(s, { state: 'unsure', outIns: [31] });
  const checked = await L.check(plan);
  assert.strictEqual(checked.state, 'done');
  assert.ok(!checked.swapTx, 'no transaction is known to link');
});

test('with no hash, notes still unspent mean it did not go: in doubt for twenty minutes, then offered again', async () => {
  const C = await chain();
  const mk = async (over) => { const s = payoutSetup({ C, balance: 1n * E18, notes: [{ index: 31, v: String(E18) }] }); return { ...s, plan: await sentPlan(s, over) }; };
  // the balance is down by more than the swap (something else spent from the pool), which the old test took for the payout
  const young = await mk({ state: 'unsure', outIns: [31], swapAt: Date.now() - 5 * 60e3 });
  assert.strictEqual((await young.L.check(young.plan)).state, 'unsure');
  const old = await mk({ state: 'unsure', outIns: [31], swapAt: Date.now() - 21 * 60e3 });
  assert.strictEqual((await old.L.check(old.plan)).state, 'waiting');
  // every note must be gone: one of two still unspent is not the payout
  const two = payoutSetup({ C, balance: 1n * E18, notes: [{ index: 31, v: '1' }] });
  const p2 = await sentPlan(two, { state: 'unsure', outIns: [31, 32], swapAt: Date.now() - 21 * 60e3 });
  assert.strictEqual((await two.L.check(p2)).state, 'waiting');
  const spent2 = payoutSetup({ C, balance: 1n * E18, notes: [] });
  const p3 = await sentPlan(spent2, { state: 'unsure', outIns: [31, 32] });
  assert.strictEqual((await spent2.L.check(p3)).state, 'done');
});

test('a plan that kept neither a hash nor its notes is still judged by the pool\'s balance', async () => {
  const C = await chain();
  const down = payoutSetup({ C, balance: 2n * E18 });
  assert.strictEqual((await down.L.check(await sentPlan(down, { state: 'unsure', swapAt: Date.now() - 30 * 60e3 }))).state, 'done', 'down by the swap: it went');
  const same = payoutSetup({ C, balance: 3n * E18 });
  assert.strictEqual((await same.L.check(await sentPlan(same, { state: 'unsure', swapAt: Date.now() - 30 * 60e3 }))).state, 'waiting', 'not down: it did not');
});

test('a receipt that cannot be read falls back to the notes, then the balance, and never throws', async () => {
  const C = await chain();
  C.url = 'http://127.0.0.1:1';                                              // no node answers
  const s = payoutSetup({ C, balance: 5n * E18, notes: [] }), { L } = s;
  const plan = await sentPlan(s, { state: 'unsure', outTx: PAYOUT, outIns: [31] });
  assert.strictEqual((await L.check(plan)).state, 'done', 'the note is gone');
});

// ── a deposit box the card paid from the wallet into a token pool's private balance (walletIntoGo), kept with its intent and its pool's router ──
test('a token pool\'s deposit box kept by the card is sent back through that pool\'s router, in its token, once its deadline has passed, and only once', async () => {
  const TOKEN_ROUTER = '0x' + '7e'.repeat(20);
  const C = await chain({ tokenBal: 4_200_000n }), ctx = boxedSetup({ C }), sentAt = [];
  const rec = { router: TOKEN_ROUTER, box: BOX, token: USDC, intent: intentOf({ amount: 100_000_000n, refund: PAYER, deadline: Math.floor(Date.now() / 1000) - 60 }) };
  const r = await ctx.L.reclaimIntoBox(rec, { onSent: (h, held) => sentAt.push([h, held]) });
  assert.strictEqual(ctx.sent.length, 1, 'one transaction');
  const tx = ctx.sent[0], w = words(tx.data);
  assert.strictEqual(tx.to, TOKEN_ROUTER, 'the router of the pool the box belongs to');
  assert.ok(tx.data.startsWith(SELECTORS.reclaim), 'reclaimDeposit(intent, token)');
  assert.strictEqual('0x' + w[8].slice(24), USDC, 'the token the box holds');
  assert.strictEqual('0x' + w[5].slice(24), PAYER, 'to the refund the box was made with');
  assert.deepStrictEqual(sentAt, [[SEND, 4_200_000n]], 'the hash is handed back before the wait');
  assert.strictEqual(r.held, 4_200_000n);
  C.receipts[SEND] = { status: '0x1' };
  const again = await ctx.L.reclaimIntoBox({ ...rec, reclaimTx: SEND, reclaimAt: Date.now(), reclaimHeld: '4200000' });
  assert.strictEqual(again.again, true);
  assert.strictEqual(ctx.sent.length, 1, 'never twice');
});

test('a kept deposit box is not sent back before its deadline, when it is empty, or when its record does not make it', async () => {
  const C = await chain({ tokenBal: 5n }), ctx = boxedSetup({ C });
  const rec = { router: '0x' + '7e'.repeat(20), box: BOX, token: USDC, intent: intentOf({ amount: 1000n, refund: PAYER, deadline: Math.floor(Date.now() / 1000) + 600 }) };
  await assert.rejects(ctx.L.reclaimIntoBox(rec), /once its deadline has passed.*Nothing was sent/);
  const late = { ...rec, intent: { ...rec.intent, deadline: String(Math.floor(Date.now() / 1000) - 60) } };
  C.tokenBal = 0n;
  await assert.rejects(ctx.L.reclaimIntoBox(late), /holds nothing.*Nothing was sent/);
  C.tokenBal = 5n; C.boxAt = '0x' + 'bb'.repeat(20);
  await assert.rejects(ctx.L.reclaimIntoBox(late), /does not match its box/);
  await assert.rejects(ctx.L.reclaimIntoBox({ ...late, router: null }), /incomplete/);
  assert.strictEqual(ctx.sent.length, 0);
});
