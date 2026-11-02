// The two role machines of a fast bridge swap (dapp/fastbridge-bl.js, dapp/fastbridge-el.js) against a simulated
// Bitcoin and pool on one virtual clock: the whole swap, and what happens when a party is slow, absent, restarted or
// dishonest. Real transactions and the real note validator on the Bitcoin side; the pool's checks mirrored in JS
// (the real guest runs in fast-lane-e2e.test.mjs). Every record goes through JSON, as it does in storage.
//   node tests/fastbridge-sim.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '../dapp/adaptor-btc-tx.js';
import { makeBitcoinLocker } from '../dapp/fastbridge-bl.js';
import { makeEthereumLocker } from '../dapp/fastbridge-el.js';
import * as X from '../dapp/adaptor-xswap.js';
import { G, bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { fetched, tacit, te, scalar, etchNote } from './lib/btc-sim.mjs';
import { makeClock, makeBitcoinSim, makeEvmSim, makeEvmParty, partyKeys, pool, sha256, ASSET } from './lib/chain-sim.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const VALUE = 5000n;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

const memStore = () => {
  const m = new Map();
  return { m, get: async (id) => (m.has(id) ? JSON.parse(m.get(id)) : null), put: async (r) => { m.set(r.id, JSON.stringify(r)); }, list: async () => [...m.values()].map((v) => JSON.parse(v)) };
};

function world({ lpConfs = 1, lp: lpPolicyOver = {}, user: userPolicyOver = {}, funds = 1, lpNowSkew = 0 } = {}) {
  const clock = makeClock();
  const btc = makeBitcoinSim(clock), evm = makeEvmSim(clock);
  const kit = tacitKit(tacit);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const uW = wallet('user'), lW = wallet('lp');
  const uKeys = partyKeys('user'), lKeys = partyKeys('lp');
  const uEvm = makeEvmParty({ evm, keys: uKeys, clock }), lEvm = makeEvmParty({ evm, keys: lKeys, clock });
  for (let i = 0; i < funds; i++) lEvm.fund(VALUE, 'inv' + i);

  // the user's Bitcoin note
  const r0 = scalar('user/note');
  const etch = etchNote({ ticker: 'TP', value: VALUE, r: r0, script: uW.prims.p2wpkhScript(uW.wallet.pub), signerD: scalar('etcher') });
  btc.addConfirmed(etch);
  const note = { txid: etch.txid, vout: 0, value: 546, amount: VALUE, blinding: r0 };
  let coinN = 0;
  const sats = () => [{ txid: bytesToHex(sha256(te('coin/' + coinN++))), vout: 0, value: 200_000 }];

  const uBtc = btc.adapter({ prims: uW.prims, builder: makeAdaptorBtcTx({ prims: uW.prims, kit }), sats });
  const lBtc = btc.adapter({ prims: lW.prims, builder: makeAdaptorBtcTx({ prims: lW.prims, kit }), sats });
  const base = { now: evm.now, lockPosition: evm.lockPosition, jobStatus: evm.jobStatus, submit: evm.submit, lockSpent: evm.lockSpentFn, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const uEvmCtx = { now: evm.now, lockPosition: evm.lockPosition, recipient: uEvm.recipient, claim: uEvm.claim, claimStatus: evm.jobStatus };
  const lEvmCtx = { ...base, now: async () => clock.now() + lpNowSkew, lockOp: lEvm.lockOp, refundOp: lEvm.refundOp, refundKey: lEvm.refundKey };

  const quotes = new Map();
  const quote = { id: 'q1', btcAsset: bytesToHex(etch.asset), btcValue: VALUE, evmAsset: ASSET, evmAmount: VALUE, validUntil: clock.now() + 3600 };
  quotes.set(quote.id, quote);
  const lpOffers = new Map();
  const w = { clock, btc, evm, etch, note, quote, quotes, uW, lW, uKeys, lKeys, lBtc, lEvm, lpUp: true, lpOffers, userStore: memStore(), lpStore: memStore() };
  const toLp = { sendOffer: async (msg) => { if (!w.lpUp) throw new Error('the liquidity provider is unreachable'); return w.lp_.receive(msg); }, getEvmOffer: async (id) => lpOffers.get(id) || null };
  const toUser = { publishEvmOffer: async (id, o) => { lpOffers.set(id, o); } };
  const userPolicy = { csvBlocks: 144, minClaimSecs: 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600, ...userPolicyOver };
  const lpPolicy = { minCsv: 72, minConfsFor: () => lpConfs, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, minAmount: 1000, maxAmount: 1_000_000, roundSecs: 600, ...lpPolicyOver };
  w.userBl = makeBitcoinLocker({ seed: uKeys.seed, now: clock.now, policy: userPolicy, store: w.userStore, btc: uBtc, evm: uEvmCtx, counter: toLp });
  w.makeLp = () => makeEthereumLocker({ seed: lKeys.seed, now: clock.now, policy: lpPolicy, store: w.lpStore, quotes: { get: async (id) => quotes.get(id) || null }, btc: lBtc, evm: lEvmCtx, counter: toUser });
  w.lp_ = w.makeLp();
  w.restartLp = () => { w.lp_ = w.makeLp(); };
  w.user = async () => (await w.userStore.list())[0];
  w.lp = async () => (await w.lpStore.list())[0];
  w.userOnline = true; w.lpOnline = true;
  w.start = () => w.userBl.start({ asset: etch.asset, amount: VALUE, notes: [note], counterClaimPub: lW.wallet.pub, evmAsset: ASSET, evmAmount: VALUE, quoteId: quote.id });
  w.step = async () => {
    if (w.userOnline) for (const r of await w.userStore.list()) await w.userBl.step(r);
    if (w.lpOnline) for (const r of await w.lpStore.list()) await w.lp_.step(r);
    evm.process();
  };
  // one tick is a minute; a block is found every ten
  let ticks = 0;
  w.run = async (until, max = 2000) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return i;
      await w.step();
      clock.advance(60); ticks++;
      if (ticks % 10 === 0) btc.mine(1, { advance: false });
    }
    throw new Error('did not finish: user ' + JSON.stringify(await w.user()).slice(0, 400) + ' lp ' + JSON.stringify(await w.lp()).slice(0, 400));
  };
  w.noteOf = async (txid, vout) => btc.resolveNote(txid, vout);
  w.poolHolds = (leaf) => evm.notes.leaves.some((l) => bytesToHex(l) === strip(leaf));
  return w;
}

test('Bitcoin -> Ethereum: the LP ends with the Bitcoin note and the user with the pool note, and each lock is spent once', async () => {
  const w = world();
  const rec = await w.start();
  await w.run(async () => (await w.user())?.phase === 'done' && (await w.lp())?.phase === 'done');
  const lp = await w.lp(), user = await w.user();
  assert.ok(lp.take, 'the LP took the Bitcoin lock');
  assert.ok(await w.noteOf(lp.take.txid, 0), 'the LP\'s Bitcoin note is valid');
  assert.equal(user.takenBy, lp.take.txid);
  const sec = X.deriveSwapSecrets({ seed: w.uKeys.seed, swapId: hexToBytes(rec.id) });
  const O = pool.commitXY(VALUE, '0x' + bytesToHex(bigintToBytes32(sec.rOut)));
  assert.ok(w.poolHolds(pool.leaf(ASSET, O.cx, O.cy, pool.nkToOwner(w.uKeys.nkOut))), 'the user\'s note is in the pool');
  assert.equal(w.evm.locks.leaves.length, 1, 'one lock for one swap');
  assert.equal(w.evm.lockSpent.size, 1);
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorclaim']);
});

test('the LP is unreachable: the user takes its Bitcoin note back once the timelock runs', async () => {
  const w = world();
  w.lpUp = false; w.lpOnline = false;
  await w.start();
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  assert.match((await w.user()).why, /could not be reached/);
  w.btc.mine(143);
  await w.run(async () => (await w.user())?.phase === 'refunded');
  const user = await w.user();
  assert.ok(await w.noteOf(user.refund.txid, 0), 'the refund is a valid note');
  assert.equal(w.evm.locks.leaves.length, 0, 'nothing was ever locked on Ethereum');
});

test('the user goes silent after the LP has locked: the LP refunds after the deadline, and the user cannot claim late', async () => {
  const w = world();
  await w.start();
  await w.run(async () => (await w.lp())?.phase === 'offered');
  w.userOnline = false;
  const lp0 = await w.lp();
  w.clock.advance(lp0.deadline - w.clock.now() + 5);
  await w.run(async () => (await w.lp())?.phase === 'refunded');
  assert.equal(w.evm.lockSpent.size, 1);
  assert.deepEqual([...w.evm.claims.values()], [[]], 'spent by a refund: no kernel s was ever published');
  // the user returns before its Bitcoin timelock: the offer it finds is too close to, or past, its deadline
  w.userOnline = true;
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  assert.ok(!w.evm.submitted.some((j) => j.type === 'adaptorclaim'), 'no claim was built');
  w.btc.mine(144);
  await w.run(async () => (await w.user())?.phase === 'refunded');
});

test('the user wakes up with too little time left on the Ethereum deadline: it builds no claim, so no t is published', async () => {
  const w = world();
  await w.start();
  await w.run(async () => (await w.lp())?.phase === 'offered');
  w.userOnline = false;
  w.clock.advance((await w.lp()).deadline - w.clock.now() - 1800);
  w.userOnline = true;
  await w.step();
  await w.step();
  assert.equal((await w.user()).phase, 'refund-wait');
  assert.ok(!w.evm.submitted.some((j) => j.type === 'adaptorclaim'));
  assert.equal(w.evm.claims.size, 0);
});

test('an LP restarted around its lock never locks the swap twice, with its record kept or lost', async () => {
  // (a) the lock is stored, the process dies before it is sent, the new process sends it from the stored bytes
  let w = world({ funds: 2 });
  await w.start();
  w.evm.dieOnce = 'adaptorlock';
  await w.run(async () => (await w.lp())?.lock?.op !== undefined && !!(await w.lp())?.lastError);
  w.restartLp();
  await w.run(async () => (await w.lp())?.phase === 'offered');
  assert.equal(w.evm.locks.leaves.length, 1);
  // (b) the lock landed and the record is gone: the swap's own lock leaf is found in the pool and adopted, no second lock
  w = world({ funds: 2 });
  const rec = await w.start();
  await w.run(async () => (await w.lp())?.phase === 'offered');
  const first = await w.lp();
  w.lpStore.m.clear(); w.lpOffers.clear();
  await w.lp_.receive({ quoteId: 'q1', offer: await sentOffer(w, rec) });
  await w.run(async () => (await w.lp())?.phase === 'offered');
  assert.equal(w.evm.locks.leaves.length, 1, 'adopted, not repeated');
  assert.equal((await w.lp()).lock.lockLeaf, first.lock.lockLeaf);
});

// the Bitcoin lock offer the user sent, rebuilt from its record
async function sentOffer(w, rec) {
  const u = await w.userStore.get(rec.id);
  const sec = X.deriveSwapSecrets({ seed: w.uKeys.seed, swapId: hexToBytes(u.id) });
  return X.makeBtcLockOffer({
    swapId: hexToBytes(u.id), asset: u.asset, value: BigInt(u.amount), rLock: sec.rLock, txid: u.lock.txid, vout: 0, csvBlocks: u.csvBlocks,
    lockerXonly: w.uW.wallet.pub.slice(1), T: sec.T, claimerPub: u.counterClaimPub,
    evm: { asset: u.evmAsset, amount: BigInt(u.evmAmount), recipient: bytesToHex(G.multiply(w.uKeys.dAuth).toRawBytes(true).slice(1)), rOut: sec.rOut },
  });
}

// A world where the user's lock is confirmed and the LP has not been told yet.
async function confirmedLock(over) {
  const w = world(over);
  w.lpUp = false; w.lpOnline = false;
  const rec = await w.start();
  await w.step();
  w.btc.mine(1);
  return { w, rec, offer: async () => JSON.parse(JSON.stringify(await sentOffer(w, rec))) };
}

test('the LP refuses an offer it cannot check against the chain and its quote, and answers none of them with a lock', async () => {
  const cases = [
    ['a swap id that is not the outpoint the lock spends', (o) => ({ ...o, swapId: bytesToHex(X.swapIdOf('d0'.repeat(32), 0)) }), /swap id is not the outpoint/],
    ['a lock to someone else\'s claim key', (o) => ({ ...o, claimerPub: bytesToHex(G.multiply(12345n).toRawBytes(true)) }), /not keyed to my claim key/],
    ['a value the quote does not name', (o) => ({ ...o, btc: { ...o.btc, value: '4000' } }), /differs from the quote|amounts differ/],
    ['an output that does not exist', (o) => ({ ...o, btc: { ...o.btc, vout: 7 } }), /no spendable amount|does not pay the lock|not a valid note/],
  ];
  for (const [name, tamper, why] of cases) {
    const { w, offer } = await confirmedLock();
    const got = await w.lp_.receive({ quoteId: 'q1', offer: tamper(await offer()) });
    assert.equal(got.ok, false, name);
    assert.match(got.why, why, name);
    assert.equal((await w.lpStore.list()).length, 0, name + ': a refusal stores nothing');
    assert.equal(w.evm.locks.leaves.length, 0, name);
  }
  const { w, offer } = await confirmedLock();
  assert.equal((await w.lp_.receive({ quoteId: 'nope', offer: await offer() })).why, 'unknown quote');
  assert.equal((await w.lp_.receive({ quoteId: 'q1', offer: await offer() })).ok, true, 'a refusal is not remembered: the same swap with the right quote is taken');
  const x = await confirmedLock();
  x.w.clock.advance(7200);
  assert.equal((await x.w.lp_.receive({ quoteId: 'q1', offer: await x.offer() })).why, 'quote expired');
});

test('a note already consumed on Ethereum is not answered with a lock', async () => {
  const { w, offer } = await confirmedLock();
  w.btc.consumed.add(`${w.note.txid}:${w.note.vout}`);
  const got = await w.lp_.receive({ quoteId: 'q1', offer: await offer() });
  assert.equal(got.ok, false);
  assert.match(got.why, /consumed on Ethereum/);
});

test('the same offer twice is one swap', async () => {
  const { w, offer } = await confirmedLock();
  const a = await w.lp_.receive({ quoteId: 'q1', offer: await offer() });
  const b = await w.lp_.receive({ quoteId: 'q1', offer: await offer() });
  assert.equal(a.rec.phase, 'accepted');
  assert.equal(b.rec.id, a.rec.id);
  assert.equal((await w.lpStore.list()).length, 1);
});

test('the LP waits for the confirmations its policy asks for before it locks', async () => {
  const w = world({ lpConfs: 3 });
  await w.start();
  await w.run(async () => (await w.lp())?.phase === 'accepted', 200);
  const lockTxid = (await w.user()).lock.txid;
  assert.equal((await w.btc.status(lockTxid)).confirmations >= 1, true);
  while ((await w.btc.status(lockTxid)).confirmations < 3) { await w.step(); assert.equal((await w.lp()).phase, 'accepted', 'not locked at fewer than 3'); w.btc.mine(1); }
  await w.run(async () => (await w.lp())?.phase === 'offered', 200);
  assert.equal(w.evm.locks.leaves.length, 1);
});

test('the user refuses a lock the pool does not show, a changed offer and a deadline that is too close', async () => {
  // a lock that never lands: the user waits out its patience and goes to the refund path
  let w = world();
  w.evm.paused = true;
  await w.start();
  await w.run(async () => (await w.user())?.phase === 'refund-wait', 3000);
  assert.match((await w.user()).why, /never showed|no Ethereum lock/);
  // an offer changed on the way: the leaf no longer matches its terms
  w = world();
  await w.start();
  await w.run(async () => (await w.lp())?.phase === 'offered');
  w.userOnline = false;
  const id = (await w.user()).id;
  w.lpOffers.set(id, { ...w.lpOffers.get(id), amount: '4000' });
  w.userOnline = true;
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  assert.match((await w.user()).why, /differs from the quote|lock leaf|pre-signature/);
  assert.equal(w.evm.claims.size, 0);
});


// ── stuck states and clock skew: each of these held a swap or its funds with no step to move it ──
const claimSubmitted = async (w) => w.run(async () => !!(await w.user())?.claim);

test('the LP takes the Bitcoin when a claim lands in the gap its clock leaves, even after it has decided to refund', async () => {
  const w = world({ lpNowSkew: 900 });
  await w.start();
  await w.run(async () => (await w.lp())?.phase === 'offered');
  w.evm.paused = true;
  await claimSubmitted(w);
  const deadline = (await w.lp()).deadline;
  w.clock.advance(deadline - 200 - w.clock.now());
  await w.step();
  assert.equal((await w.lp()).phase, 'refunding', 'the LP\'s clock is ahead of the chain, so it has decided to refund');
  w.evm.paused = false;
  w.evm.process();
  await w.run(async () => (await w.lp())?.phase === 'done' && (await w.user())?.phase === 'done');
  assert.ok((await w.lp()).take, 'it found the claim and took the lock');
  assert.equal(w.evm.claims.size, 1);
});

test('a claim the relay never answers does not hold the user: after the deadline the note comes back on the timelock', async () => {
  const w = world();
  await w.start();
  await w.run(async () => (await w.lp())?.phase === 'offered');
  w.evm.paused = true;
  await claimSubmitted(w);
  w.clock.advance((await w.lp()).deadline - w.clock.now() + 700);
  await w.step();
  assert.equal((await w.user()).phase, 'refund-wait');
  assert.match((await w.user()).why, /did not land/);
  w.btc.mine(144);
  await w.run(async () => (await w.user())?.phase === 'refunded');
});

test('the timelock refunds the note from any waiting phase, whatever step is stuck', async () => {
  const w = world();
  await w.start();
  await w.run(async () => (await w.lp())?.phase === 'offered');
  w.lpOffers.set((await w.user()).id, { ...w.lpOffers.get((await w.user()).id), lockLeaf: 'zz' }); // an offer nothing can read
  w.btc.mine(150);
  w.userOnline = true;
  await w.run(async () => (await w.user())?.phase === 'refunded');
});

test('a lock sent just before the process died, found too late to answer, is still watched and refunded', async () => {
  const w = world({ funds: 2 });
  await w.start();
  w.evm.dieAfter = 'adaptorlock';
  await w.run(async () => (await w.lp())?.lock?.op !== undefined && !!(await w.lp())?.lastError);
  assert.equal(w.evm.locks.leaves.length, 1, 'the job went through before the process died');
  w.restartLp();
  const lp = await w.lp();
  w.clock.advance(lp.deadline - 3000 - w.clock.now());
  await w.run(async () => (await w.lp())?.phase === 'refunded', 400);
  assert.equal(w.evm.lockSpent.size, 1);
  assert.equal(w.evm.submitted.filter((j) => j.type === 'adaptorlock').length, 1, 'no second lock');
});

test('two overlapping steps of one swap build one lock', async () => {
  const w = world({ funds: 2 });
  w.evm.paused = true;
  await w.start();
  await w.run(async () => (await w.lp())?.phase === 'locking');
  const rec = await w.lp();
  await Promise.all([w.lp_.step(rec), w.lp_.step(rec), w.lp_.step(rec)]);
  assert.equal(w.lEvm.holdings.filter((h) => h.used).length, 1, 'one note was taken for the lock');
  assert.ok(w.evm.submitted.filter((j) => j.type === 'adaptorlock').length <= 1);
});

test('an offer with a field the later steps cannot read is refused before anything is locked', async () => {
  for (const [name, tamper] of [
    ['an output blinding that is not hex', (o) => ({ ...o, evm: { ...o.evm, rOut: 'not-hex' } })],
    ['an output blinding of zero', (o) => ({ ...o, evm: { ...o.evm, rOut: '00'.repeat(32) } })],
    ['a value that is not a number', (o) => ({ ...o, btc: { ...o.btc, value: 'abc' } })],
    ['a refund key that is not a point', (o) => ({ ...o, btc: { ...o.btc, lockerXonly: '00'.repeat(32) } })],
  ]) {
    const { w, offer } = await confirmedLock();
    const got = await w.lp_.receive({ quoteId: 'q1', offer: tamper(await offer()) });
    assert.equal(got.ok, false, name);
    assert.equal(w.evm.locks.leaves.length, 0, name);
  }
});

test('a published Ethereum offer with a field that is not a number is refused and the user goes to its refund', async () => {
  const w = world();
  await w.start();
  await w.run(async () => (await w.lp())?.phase === 'offered');
  const id = (await w.user()).id;
  w.lpOffers.set(id, { ...w.lpOffers.get(id), amount: 'abc' });
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  assert.match((await w.user()).why, /malformed offer/);
  assert.equal(w.evm.claims.size, 0);
});

test('the take is signed over the lock output\'s real sats value, whatever the locker chose', async () => {
  const { w, rec, offer } = await confirmedLock();
  w.btc.txs.get(rec.lock.txid).esplora.vout[0].value = 1000;
  const seen = [];
  const claimTransfer = w.lBtc.tx.claimTransfer;
  w.lBtc.tx.claimTransfer = (a) => { seen.push(a.lockOut.value); return claimTransfer(a); };
  w.lpUp = true; w.lpOnline = true;
  assert.equal((await w.lp_.receive({ quoteId: 'q1', offer: await offer() })).ok, true);
  await w.run(async () => (await w.lp())?.phase === 'done' || !!(await w.lp())?.take, 600);
  assert.deepEqual(seen, [1000]);
});

test('an offer that reaches the LP long after the lock confirmed is not answered', async () => {
  const { w, offer } = await confirmedLock();
  w.quote.validUntil += 100_000;
  w.clock.advance(4000);
  const got = await w.lp_.receive({ quoteId: 'q1', offer: await offer() });
  assert.equal(got.ok, false);
  assert.match(got.why, /too late/);
});

let passed = 0, ran = 0;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
for (const [name, fn] of tests) {
  if (ONLY && !ONLY.test(name)) continue;
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${ran} fastbridge simulation checks passed`);
process.exit(process.exitCode || 0);
