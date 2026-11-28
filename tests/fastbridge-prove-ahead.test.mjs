// The pool lock built and proved ahead (dapp/fastbridge-el.js preStep): while the counterparty's Bitcoin lock waits for its block, the Ethereum locker takes the
// offer early, builds its lock with a deadline counted from the ask, and has the relay prove it (prove only: nothing lands). Once the Bitcoin lock is confirmed
// and agreed, the lock goes in at once if its deadline passes the same checks a lock built then would; otherwise it is let go and built from the block (the
// fallback, as before). Both directions: ETH for BTC (the user locks ETH: dapp/fastbridge-reverse-client.js) and BTC for ETH (the provider locks ETH:
// dapp/fastbridge-provider.js, from the offer the page names to /extend). Also the bump of a lock that a block went by without (fastbridge-bl.js bumpLock).
// Needs Node 22.
import assert from 'node:assert/strict';
import { checkPreDeadline, preDeadline, PRE_DEFAULTS, lockDeadline } from '../dapp/fastbridge-el.js';
import * as X from '../dapp/adaptor-xswap.js';
import { lockBumpCap } from '../dapp/fastbridge-bl.js';
import { fetched } from './lib/btc-sim.mjs';
import { pairWorld, UNITS, strip } from './lib/pair-world.mjs';
import { makeReverseClient, makeReverseCounter } from '../dapp/fastbridge-reverse-client.js';
import { SATS_ASSET } from '../dapp/fastbridge-pair.js';
import { ASSET } from './lib/chain-sim.mjs';
import { memStore } from './lib/fastbridge-world.mjs';
import { makeFastBridgeEvm } from '../dapp/fastbridge-evm.js';
import { secp, sha256 as dsha, keccak_256, hmac } from '../dapp/vendor/tacit-deps.min.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// The relay as the swap meets it: a relayed lock waits its turn and is proved (`proveSecs`) then sent (`sendSecs`); a proof asked for ahead takes `proveSecs` and
// lands nothing; a proof posted lands after `sendSecs`. Over a party's pool context: the sim's pool decides what lands.
function relayModel(w, ctx, { proveSecs = 240, sendSecs = 30 } = {}) {
  const jobs = new Map(), log = [];
  let n = 0;
  const orig = { ...ctx }, { submit, jobStatus } = orig;
  const due = (j) => w.clock.now() - j.at >= j.lat;
  const add = (kind, type, op, lat) => { const id = `${kind}-${++n}`; jobs.set(id, { kind, type, op, at: w.clock.now(), lat }); log.push({ kind, type, at: w.clock.now() }); return { jobId: id }; };
  const status = async (id) => {
    const j = jobs.get(id);
    if (!j) return jobStatus(id);
    if (j.kind === 'prove' || !due(j)) return 'pending';
    if (!j.real) j.real = (await submit(j.type, j.op)).jobId;
    return jobStatus(j.real);
  };
  // the note a built lock holds is given back when it is let go (the sim's party marks it used as it builds)
  const holdings = ctx === w.uEvmCtx ? w.uEvm.holdings : w.lEvm.holdings;
  const lockOp = async (args) => {
    const before = new Set(holdings.filter((h) => !h.used));
    const built = await orig.lockOp(args);
    const h = built && holdings.find((x) => x.used && before.has(x));
    return built ? { ...built, noteLeaf: h ? String(h.leaf) : null } : built;
  };
  const release = ({ rec }) => { const h = holdings.find((x) => String(x.leaf) === String(rec && rec.lockNote)); if (h) h.used = false; };
  return {
    log, jobs,
    ctx: {
      ...orig, lockOp, release,
      submit: async (type, op) => add('relayed', type, op, proveSecs + sendSecs), jobStatus: status, claimStatus: status,
      proveAhead: async (type, op) => add('prove', type, op, proveSecs),
      provenStatus: async (id) => { const j = jobs.get(id); return j && due(j) ? { status: 'proven', publicValues: '0x01', proof: '0x02', memos: null } : { status: 'proving' }; },
      postProven: async (type, st, op) => add('posted', type, op, sendSecs),
    },
  };
}

// steps every `stepSecs`, a block `firstGap` seconds after the start and every ten minutes after it; returns when `until()` holds
async function drive(w, pair, until, { stepSecs = 15, firstGap = 600, max = 6000, onBlock = () => {} } = {}) {
  let nextBlock = w.clock.now() + firstGap;
  for (let i = 0; i < max; i++) {
    if (await until()) return;
    await w.providerFeed.refresh().catch(() => {}); await w.clientFeed.refresh().catch(() => {});
    if (w.up.lp) { await w.fwd.tick(); await w.rev.tick(); }
    await pair.pump(); w.evm.process();
    w.clock.advance(stepSecs);
    if (w.clock.now() >= nextBlock) { w.btc.mine(1, { advance: false }); onBlock(w.clock.now()); nextBlock += 600; }
  }
  throw new Error('did not finish: ' + JSON.stringify((await pair.records()).map((r) => [r.dir, r.state, r.title])));
}
const userRec = async (w) => (await w.mems.get('swaps:lp1').list())[0];

// ETH for BTC once through, from the ask to the BTC taken; `opts`: the pair's policy, the relay model, when the first block comes. What the user's lock waited
// from the block that confirmed the provider's lock, and the record.
async function e2bOnce({ early = true, firstGap = 600, proveSecs = 240, sendSecs = 30, untilDone = true } = {}) {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const m = relayModel(w, w.uEvmCtx, { proveSecs, sendSecs });
  const pair = w.makePair({ evm: m.ctx, policy: { early } });
  const q = await pair.quote({ dir: 'e2b', amount: UNITS });
  const t0 = w.clock.now();
  await pair.start(q);
  let confirmedAt = null, landedAt = null;
  const lockConfirmed = async () => { const r = (await w.stores.rv.swaps.list())[0]; return !!(r && r.lock && (await w.btc.status(r.lock.txid)).confirmations > 0); };
  await drive(w, pair, async () => {
    if (confirmedAt == null && (await lockConfirmed())) confirmedAt = w.clock.now();
    const r = await userRec(w);
    if (landedAt == null && r && r.lock && (await w.evm.lockPosition(r.lock.lockLeaf))) landedAt = w.clock.now();
    return untilDone ? !!(r && r.phase === 'done') : landedAt != null;
  }, { firstGap });
  return { w, m, pair, t0, confirmedAt, landedAt, rec: await userRec(w), wait: landedAt - confirmedAt };
}

test('the deadline built ahead: used only inside the window that keeps both sides safe; too early or too late is refused', () => {
  const policy = { evmWindowSecs: 4 * 3600, roundSecs: 600, minClaimSecs: 3600, claimSlackSecs: 7200 };
  const now = 1_800_000_000, opens = now + 95 * 300;                       // a 96-block lock just confirmed: its refund at the soonest, blocks every five minutes
  assert.deepEqual(checkPreDeadline({ deadline: now + 3 * 3600, nowSecs: now, btcRefundOpens: opens, policy }), [], 'three hours to claim, and the slack before the refund: used');
  assert.ok(checkPreDeadline({ deadline: now + 3600, nowSecs: now, btcRefundOpens: opens, policy }).some((r) => /too little time to claim/.test(r)), 'an hour left is under the two the counterparty is given: refused');
  assert.ok(checkPreDeadline({ deadline: now + 6 * 3600, nowSecs: now, btcRefundOpens: opens + 9 * 3600, policy }).some((r) => /further out than a counterparty accepts/.test(r)), 'six hours out is more than a Bitcoin locker accepts (and than the window ever gives): refused');
  assert.ok(checkPreDeadline({ deadline: now + 3 * 3600, nowSecs: now, btcRefundOpens: now + 4 * 3600, policy }).some((r) => /refunded too soon/.test(r)), 'a deadline the Bitcoin refund could open within the slack of: refused, as for any lock');
  // the window: counted from when the offer was taken, half an hour more than a lock counted from the block, rounded as a lock's is
  assert.equal(preDeadline({ takenAt: now, policy }), lockDeadline({ blockTime: now, windowSecs: 4 * 3600 + PRE_DEFAULTS.preWindowExtraSecs, roundSecs: 600 }));
  // what the window covers: a block up to two and a half hours late still leaves two hours to claim
  const d = preDeadline({ takenAt: now, policy });
  assert.deepEqual(checkPreDeadline({ deadline: d, nowSecs: now + 2.4 * 3600, btcRefundOpens: now + 2.4 * 3600 + 95 * 300, policy }), []);
  assert.notDeepEqual(checkPreDeadline({ deadline: d, nowSecs: now + 2.7 * 3600, btcRefundOpens: now + 2.7 * 3600 + 95 * 300, policy }), []);
});

test('ETH for BTC: the lock is built and proved while the provider\'s lock waits for its block, and goes in the moment it is confirmed; the swap ends done', async () => {
  const fast = await e2bOnce({ early: true });
  const slow = await e2bOnce({ early: false });
  assert.equal(fast.rec.phase, 'done'); assert.equal(slow.rec.phase, 'done');
  assert.equal(fast.rec.early, true, 'the offer was taken before the block');
  assert.equal(fast.rec.preUsed, true, 'the lock built ahead is the one that went in');
  assert.deepEqual(fast.m.log.filter((j) => j.type === 'adaptorlock').map((j) => j.kind), ['prove', 'posted'], 'proved ahead, then only posted: no second proof');
  assert.ok(fast.m.log.find((j) => j.kind === 'prove').at < fast.confirmedAt, 'the proof was asked for before the block');
  assert.equal(fast.rec.deadline, preDeadline({ takenAt: fast.rec.created, policy: { evmWindowSecs: 4 * 3600, roundSecs: 600 } }), 'its deadline is counted from when the offer was taken');
  assert.deepEqual(slow.m.log.filter((j) => j.type === 'adaptorlock').map((j) => j.kind), ['relayed'], 'without it: proved and sent after the block, as before');
  assert.ok(fast.wait <= 60, `from the block to the lock in the pool: ${fast.wait} s ahead`);
  assert.ok(slow.wait >= 270, `and ${slow.wait} s when proved after the block`);
  console.log(`    block -> lock in the pool: ${slow.wait} s as before, ${fast.wait} s proved ahead (relay: 240 s to prove, 30 s to send)`);
  // the provider takes the request-relative deadline: its claim landed (the swap is done), and it is within what the provider accepts
  assert.ok(fast.rec.deadline - fast.confirmedAt <= 6 * 3600 && fast.rec.deadline - fast.confirmedAt >= 2 * 3600);
});

test('ETH for BTC: a block so late that the lock built ahead no longer leaves the provider two hours is let go, and the lock is built from the block as before', async () => {
  const late = await e2bOnce({ early: true, firstGap: 3 * 3600 });
  assert.equal(late.rec.phase, 'done', 'the swap still goes through');
  assert.equal(late.rec.preUsed, undefined, 'the lock built ahead was not used');
  assert.match(late.rec.preWhy || '', /too little time to claim/, 'and why is kept');
  const blockTime = Math.max(...[...late.w.btc.blockTimes.entries()].filter(([h]) => h <= (late.rec.lockHeight || 0)).map(([, t]) => t));
  assert.equal(late.rec.deadline, lockDeadline({ blockTime, windowSecs: 4 * 3600, roundSecs: 600 }), 'its deadline is counted from the block, as before');
  assert.deepEqual(late.m.log.filter((j) => j.type === 'adaptorlock').map((j) => j.kind), ['prove', 'relayed'], 'the proof made ahead is not posted; the lock is proved again for its new deadline');
});

test('ETH for BTC: a provider that never claims leaves the user to take its ETH back after the deadline built ahead', async () => {
  const r = await e2bOnce({ early: true, untilDone: false });
  assert.equal(r.rec.preUsed, true);
  r.w.up.lp = false;                                                         // the provider is gone: no claim
  await drive(r.w, r.pair, async () => ['refunded', 'done'].includes((await userRec(r.w)).phase), { stepSecs: 120 });
  const rec = await userRec(r.w);
  assert.equal(rec.phase, 'refunded', 'the ETH came back');
  assert.ok(r.w.clock.now() > rec.deadline, 'and only after the deadline');
});

test('ETH for BTC: a provider that does not give its offer early (an older one) changes nothing: the lock is built after the block, as before', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const m = relayModel(w, w.uEvmCtx);
  const rev = w.rev.handle;
  w.rev.handle = async (req) => (/\/early-offer$/.test(req.path) ? { status: 404, body: { error: 'not found' } } : rev(req));
  const pair = w.makePair({ evm: m.ctx, reverseCallFor: () => async (method, path, body) => { const x = await w.rev.handle({ method, path, body }); return { status: x.status, body: x.body }; } });
  await pair.start(await pair.quote({ dir: 'e2b', amount: UNITS }));
  await drive(w, pair, async () => (await userRec(w))?.phase === 'done');
  const rec = await userRec(w);
  assert.equal(rec.early, undefined);
  assert.deepEqual(m.log.filter((j) => j.type === 'adaptorlock').map((j) => j.kind), ['relayed']);
});

test('ETH for BTC: an early offer whose terms are not the lock on the chain is not taken, and the swap goes on from the confirmed offer', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const m = relayModel(w, w.uEvmCtx);
  const rev = w.rev.handle;
  // a provider that names another adaptor point early: the lock's script does not commit to it
  w.rev.handle = async (req) => {
    const x = await rev(req);
    if (/\/early-offer$/.test(req.path) && x.status === 200) return { status: 200, body: { ...x.body, T: '02' + 'ab'.repeat(32) } };
    return x;
  };
  const pair = w.makePair({ evm: m.ctx, reverseCallFor: () => async (method, path, body) => { const x = await w.rev.handle({ method, path, body }); return { status: x.status, body: x.body }; } });
  await pair.start(await pair.quote({ dir: 'e2b', amount: UNITS }));
  await drive(w, pair, async () => (await userRec(w))?.phase === 'done');
  const rec = await userRec(w);
  assert.equal(rec.early, undefined, 'the early offer was refused');
  const q = (await w.mems.get('quotes:lp1').list())[0];
  assert.match(q.earlyOff || '', /./, 'and why is kept on the ask');
});

test('the provider refuses a pool lock whose deadline is further out than it accepts, however it was counted', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  // a user side whose window is six and a half hours (the page's is four, or four and a half built ahead): its lock lands, and the provider will not take it
  const answers = [];
  const call = async (method, path, body) => { const x = await w.rev.handle({ method, path, body }); if (/evm-offer$/.test(path)) answers.push(x.body); return { status: x.status, body: x.body }; };
  const rc = makeReverseClient({
    lp: makeReverseCounter(call), btc: w.uBtc, evm: w.uEvmCtx, seed: w.uKeys.seed, store: memStore(), quoteStore: memStore(), now: w.clock.now,
    pins: { btcAsset: SATS_ASSET, evmAsset: ASSET }, confsOf: () => 1, valueCheck: () => ({ fee: 0n, highFee: false }),
    policy: { evmWindowSecs: 6.5 * 3600, claimSlackSecs: 1800, early: false },
  });
  const q = await rc.quote(UNITS);
  await rc.start({ quote: q });
  for (let i = 0; i < 200 && !answers.length; i++) { await w.rev.tick(); await rc.pump(); w.evm.process(); w.clock.advance(30); if (i % 20 === 19) w.btc.mine(1, { advance: false }); }
  assert.ok(answers.length, 'the user\'s lock landed and its offer was posted');
  assert.equal(answers[0].ok, false);
  assert.match(answers[0].why, /further out than this side accepts/, 'refused for its deadline');
  assert.equal((await w.stores.rv.evmOffers.list()).length, 0, 'and not kept');
});

test('a lock read the moment it lands, while the nodes\' agreed head is a block behind, is found once the head has passed it (live 11-25: 20 minutes in "Locking")', async () => {
  // the pool: the lock lands at block 101; the newest block is 101 at once, the nodes agree on 100 for a while
  const LEAF = '0x' + 'de'.repeat(32), ROOT0 = '0x' + '01'.repeat(32), ROOT1 = '0x' + '02'.repeat(32);
  let latest = 101, agreed = 100;
  const countAt = (b) => (b >= 101 ? 393 : 392), rootAt = (b) => (b >= 101 ? ROOT1 : ROOT0);
  const tagOf = (t) => (t === 'latest' ? latest : parseInt(t, 16));
  const ux = {
    rpc: async (m, p) => {
      if (m === 'eth_getStorageAt' && p[1] === '0x54') return '0x' + countAt(tagOf(p[2])).toString(16);
      if (m === 'eth_getStorageAt' && p[1] === '0x55') return rootAt(tagOf(p[2]));
      throw new Error('not read here: ' + m);
    },
    stealthLockPosition: async ({ lockLeaf, opts }) => (String(lockLeaf) === LEAF && (opts?.toBlock ?? latest) >= 101 ? { lIndex: 392, lPath: [], lockSetRoot: rootAt(opts?.toBlock ?? latest) } : null),
  };
  const quorum = { head: async () => agreed, agree: async (m, p, norm) => norm(await ux.rpc(m, p)) };
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(dsha, k, m), walletPriv: new Uint8Array(32).fill(7), seed: new Uint8Array(32).fill(9), asset: '0x' + 'f0'.repeat(32), poolAddress: '0x' + '00'.repeat(20), quorum });
  assert.equal(await evm.lockPosition(LEAF), null, 'the agreed head has not reached the lock yet');
  agreed = 101;                                                              // no other lock lands meanwhile: the newest count stays where it was
  const pos = await evm.lockPosition(LEAF);
  assert.ok(pos && pos.lIndex === 392, 'once the head has passed it the lock is found, though no other lock landed');
});

test('BTC for ETH: the provider builds and proves its lock from the offer the page names to /extend, and locks the moment the user\'s lock is confirmed', async () => {
  const once = async (early) => {
    const w = pairWorld();
    await w.ready();
    w.lEvm.fund(3_560_000n * 2n, 'inv0');
    const m = relayModel(w, w.lEvmCtx);
    Object.assign(w.lEvmCtx, m.ctx);
    const pair = w.makePair({ policy: { early } });
    const q = await pair.quote({ dir: 'b2e', amount: 100_000n });
    w.lEvm.fund(q.get, 'exact');
    await pair.start(q);
    let confirmedAt = null, landedAt = null;
    await drive(w, pair, async () => {
      const u = (await w.mems.get('fwd').list())[0], p = (await w.stores.lp.list())[0];
      if (confirmedAt == null && u && (await w.btc.status(u.lock.txid)).confirmations > 0) confirmedAt = w.clock.now();
      if (landedAt == null && p && p.lock && (await w.evm.lockPosition(p.lock.lockLeaf))) landedAt = w.clock.now();
      return !!(u && ['done', 'counter-took'].includes(u.phase));
    });
    return { m, p: (await w.stores.lp.list())[0], wait: landedAt - confirmedAt };
  };
  const fast = await once(true), slow = await once(false);
  assert.equal(fast.p.early, true, 'the provider took the offer before the block');
  assert.equal(fast.p.preUsed, true);
  assert.deepEqual(fast.m.log.filter((j) => j.type === 'adaptorlock').map((j) => j.kind), ['prove', 'posted']);
  assert.deepEqual(slow.m.log.filter((j) => j.type === 'adaptorlock').map((j) => j.kind), ['relayed']);
  assert.ok(fast.wait < slow.wait - 200, `block -> the provider's lock in the pool: ${slow.wait} s as before, ${fast.wait} s ahead`);
  console.log(`    b2e block -> provider's lock in the pool: ${slow.wait} s as before, ${fast.wait} s proved ahead`);
});

test('a lock of sats that a block goes by without is bumped from its change to the next block\'s rate, child pays for parent, its txid kept, within its cap', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const pair = w.makePair();
  const q = await pair.quote({ dir: 'e2b', amount: UNITS });
  // the provider's lock pays 3 sat/vB; the next block wants 20: the lock is held back on its own rate, and mined with a child that lifts the two
  let rate = 3;
  w.rBtc.feeRate = async () => rate;
  await pair.start(q);
  await w.rev.tick();
  const s0 = (await w.stores.rv.swaps.list())[0];
  const lockTxid = s0.lock.txid;
  // the rate the provider sends at stays 3 (its few-blocks estimate lags a backlog); the next block wants 20, and the bump is sized to that (2026-11-28)
  w.rBtc.nextFeeRate = async () => 20;
  const child = () => [...w.btc.txs.entries()].find(([, e]) => e.esplora.vin.some((i) => i.txid === lockTxid));
  w.btc.holdBack = (id) => id === lockTxid && !child();
  w.btc.mine(1);
  await w.rev.tick(); await w.rev.tick();
  const s1 = (await w.stores.rv.swaps.list())[0];
  assert.ok(s1.cpfp && child(), 'a block went by without the lock: a child of its change was sent');
  assert.equal(s1.lock.txid, lockTxid, 'the lock keeps its txid');
  const cap = lockBumpCap(s1.amount, s1.lock.change.value), want = 20 * (s1.lock.vsize + w.rBtc.tx.childVsize()) - s1.lock.fee;
  assert.equal(s1.cpfp.fee, Math.min(cap, want), 'the two together pay the rate the next block wants, or as near it as the cap for the amount allows');
  w.btc.mine(1);
  assert.ok((await w.btc.status(lockTxid)).confirmations > 0, 'the lock is mined with its child');
});

test('the cap on a lock\'s bumps: 1% of a large amount, up to 1,500 sats for a small one, never past what the change holds', () => {
  assert.equal(lockBumpCap(26_000, 26_505), 1500, '1% of 26,000 is 260: too little to leave a backlog, so the small-amount allowance applies');
  assert.equal(lockBumpCap(1_000_000, 900_000), 10_000, 'a large amount keeps 1%');
  assert.equal(lockBumpCap(10_000, 9_000), 600, 'a tiny amount: 6% of it');
  assert.equal(lockBumpCap(26_000, 1_000), 453, 'the change bounds it');
});

let passed = 0;
for (const [name, fn] of tests) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} prove-ahead checks passed`);
process.exit(process.exitCode || 0);                                        // (a provider's timers are not this test's to wait out)
