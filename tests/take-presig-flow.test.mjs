// An ETH-for-Bitcoin swap of plain sats where the user's side signs the take ahead (dapp/fastbridge-el.js protect, dapp/take-presig.js) and a watcher finishes it
// (worker-relay/src/take-watcher.js): the provider (the Bitcoin locker) locks sats to the user's key plus T, the user locks pool ETH to T, the provider claims, and
// the user is GONE (its records lost, its page closed). The watcher reads the claim, completes the pre-signature and sends the take to the user's own address.
// The simulated Bitcoin and pool of tests/lib/chain-sim.mjs on one virtual clock, the real role machines. Offline.
//   node tests/take-presig-flow.test.mjs        (Node 22)
import assert from 'node:assert/strict';
import * as X from '../dapp/adaptor-xswap.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx } from '../dapp/adaptor-btc-tx.js';
import { makeBitcoinLocker } from '../dapp/fastbridge-bl.js';
import { makeEthereumLocker } from '../dapp/fastbridge-el.js';
import { describeRev } from '../dapp/fastbridge-pair.js';
import * as TP from '../dapp/take-presig.js';
import { makeTakeWatcher, memoryStore, fundPlan } from '../worker-relay/src/take-watcher.js';
import { bigintToBytes32, G } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { te, scalar, fetched } from './lib/btc-sim.mjs';
import { makeClock, makeBitcoinSim, makeEvmSim, makeEvmParty, partyKeys, pool, sha256, ASSET } from './lib/chain-sim.mjs';
import { memStore } from './lib/fastbridge-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const SATS = 100_000n, OUT = 3_700_000n, CSV = 144;

function world({ publish = 'ok' } = {}) {
  const clock = makeClock(), btc = makeBitcoinSim(clock), evm = makeEvmSim(clock);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const uW = wallet('user'), lW = wallet('lp');
  const uKeys = partyKeys('user'), lKeys = partyKeys('lp');
  const uEvm = makeEvmParty({ evm, keys: uKeys, clock }), lEvm = makeEvmParty({ evm, keys: lKeys, clock });
  uEvm.fund(OUT, 'inv0');                                              // the user holds the pool ETH
  let coinN = 0;
  const coin = () => [{ txid: bytesToHex(sha256(te('coin/' + coinN++))), vout: 0, value: 200_000 }];
  const uBtc = btc.adapter({ prims: uW.prims, builder: makeAdaptorBtcTx({ prims: uW.prims }), sats: coin });
  const lBtc = btc.adapter({ prims: lW.prims, builder: makeAdaptorBtcTx({ prims: lW.prims }), sats: coin });
  const lBlEvm = { now: evm.now, lockPosition: evm.lockPosition, recipient: lEvm.recipient, claimOp: lEvm.claimOp, submit: evm.submit, claimStatus: evm.jobStatus, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const uElEvm = { now: evm.now, lockPosition: evm.lockPosition, jobStatus: evm.jobStatus, submit: evm.submit, lockSpent: evm.lockSpentFn, findClaim: evm.findClaim, lockNullifier: pool.nullifier, lockOp: uEvm.lockOp, refundOp: uEvm.refundOp, refundKey: uEvm.refundKey, available: uEvm.available };
  const quote = { id: 'q1', btcAsset: X.SATS_ASSET, btcValue: SATS, evmAsset: ASSET, evmAmount: OUT, validUntil: clock.now() + 3600 };
  const offers = new Map(), posted = [];
  const w = { clock, btc, evm, uW, lW, lpStore: memStore(), userStore: memStore(), posted, userUp: true, lpUp: true, publishCalls: 0 };
  const toEl = { sendOffer: async (msg) => w.el.receive(msg), getEvmOffer: async (id) => offers.get(id) || null };
  const toBl = { publishEvmOffer: async (id, o) => { offers.set(id, o); } };
  // the page's publish: answered, refused, or unreachable
  const takePresig = { publish: async (p) => { w.publishCalls++; if (publish === 'throw') throw new Error('the API is unreachable'); if (publish === 'refuse') return false; posted.push(p); return true; } };
  const blPolicy = { csvBlocks: CSV, minClaimSecs: 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600 };
  const elPolicy = { minCsv: 72, minConfsFor: () => 1, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, minAmount: 20_000, maxAmount: 10_000_000, roundSecs: 600 };
  w.bl = makeBitcoinLocker({ seed: lKeys.seed, now: clock.now, policy: blPolicy, store: w.lpStore, btc: lBtc, evm: lBlEvm, counter: toEl });
  w.el = makeEthereumLocker({ seed: uKeys.seed, now: clock.now, policy: elPolicy, store: w.userStore, quotes: { get: async (id) => (id === quote.id ? quote : null) }, btc: uBtc, evm: uElEvm, counter: toBl, takePresig });
  w.user = async () => (await w.userStore.list())[0];
  w.lp = async () => (await w.lpStore.list())[0];
  w.start = () => w.bl.start({ asset: hexToBytes(X.SATS_ASSET), amount: SATS, counterClaimPub: uW.wallet.pub, evmAsset: ASSET, evmAmount: OUT, quoteId: quote.id });
  w.step = async () => {
    if (w.lpUp) for (const r of await w.lpStore.list()) await w.bl.step(r);
    if (w.userUp) for (const r of await w.userStore.list()) await w.el.step(r);
    evm.process();
  };
  let ticks = 0;
  w.run = async (until, max = 2000) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return i;
      await w.step();
      clock.advance(60); ticks++;
      if (ticks % 10 === 0) btc.mine(1, { advance: false });
    }
    throw new Error('did not finish: lp ' + JSON.stringify(await w.lp()).slice(0, 400) + ' user ' + JSON.stringify(await w.user()).slice(0, 400));
  };
  // a watcher over the same simulated chains
  const sentHex = new Map();
  w.watcher = ({ list = () => posted, funder = null, policy = {} } = {}) => makeTakeWatcher({
    source: { list: async () => list() }, store: memoryStore(), funder, now: clock.now, policy,
    pool: { findClaim: async (nu) => evm.findClaim(nu) },
    chain: {
      outspend: btc.outspend, status: btc.status, feeRate: async () => 3,
      outputSpk: async (txid, vout) => { const t = await btc.fetchTx(txid); return t && t.vout[vout] ? t.vout[vout].scriptpubkey : null; },
      broadcast: async (hex, tx) => { if (tx) sentHex.set(hex, tx); const t = sentHex.get(hex); if (!t) throw new Error('already known'); await btc.broadcast({ revealTxid: TP.txidOf(t), revealTx: t }); w.sent = (w.sent || 0) + 1; },
    },
  });
  return w;
}

const claimLanded = (w) => async () => w.evm.lockSpent.size === 1;

test('the provider claims and the user is gone: the watcher finishes the take to the user\'s own address', async () => {
  const w = world();
  await w.start();
  await w.run(claimLanded(w));
  assert.equal(w.posted.length, 1, 'the page published one pre-signature, before the claim');
  const user = await w.user();
  assert.equal(user.presig.published, true);
  assert.equal(describeRev(user, w.clock.now).watched, true, 'and the card says so');
  const lockTxid = user.lockTxid;
  // the page is closed and its records are lost
  w.userUp = false;
  w.userStore.m.clear();
  assert.equal(w.btc.spends.get(`${lockTxid}:${user.lockVout}`), undefined, 'the lock is untouched: nobody has taken it');

  const watcher = w.watcher();
  const out = await watcher.pass();
  assert.equal(out.claimed, 1);
  const spender = w.btc.spends.get(`${lockTxid}:${user.lockVout}`);
  assert.ok(spender, 'the lock is spent');
  const tx = await w.btc.fetchTx(spender);
  assert.equal(tx.vout.length, 1);
  assert.equal(tx.vout[0].scriptpubkey, bytesToHex(w.uW.prims.p2wpkhScript(w.uW.wallet.pub)), 'to the user\'s own address');
  assert.equal(tx.vout[0].value, user.lockValue - w.posted[0].fee, 'for the lock less the committed fee');
  assert.equal(tx.vin[0].witness[0].length, 130, 'a 65-byte signature: the hash type is the last byte');
  // it confirms, and a second pass ends it; running it again changes nothing (idempotent)
  w.btc.mine(1);
  await watcher.pass();
  await watcher.pass();
  assert.equal(w.sent, 1, 'one broadcast');
});

test('the same watcher state after a restart sends nothing twice and a finished take is left alone', async () => {
  const w = world();
  await w.start();
  await w.run(claimLanded(w));
  w.userUp = false;
  const store = memoryStore();
  const mk = () => makeTakeWatcher({ source: { list: async () => w.posted }, store, now: w.clock.now, pool: { findClaim: async (nu) => w.evm.findClaim(nu) }, chain: { outspend: w.btc.outspend, status: w.btc.status, feeRate: async () => 3, broadcast: async (hex, tx) => { await w.btc.broadcast({ revealTxid: TP.txidOf(tx), revealTx: tx }); w.sent = (w.sent || 0) + 1; } } });
  await mk().pass();
  w.btc.mine(1);
  await mk().pass();
  await mk().pass();
  assert.equal(w.sent, 1);
  const [st] = await store.list();
  assert.equal(st.phase, 'done');
});

test('no claim, no take: a watcher holding the pre-signature sends nothing while the lock is unclaimed or after it is refunded', async () => {
  const w = world();
  await w.start();
  await w.run(async () => (await w.user())?.phase === 'offered' && w.evm.lockSpent.size === 0 && w.posted.length === 1);
  const watcher = w.watcher();
  const out = await watcher.pass();
  assert.equal(out.watching, 1);
  assert.equal(w.sent || 0, 0);
  assert.equal(w.btc.spends.get(`${w.posted[0].lock.txid}:${w.posted[0].lock.vout}`), undefined);
});

test('a pre-signature with a changed destination, amount or key is refused and nothing is sent', async () => {
  const w = world();
  await w.start();
  await w.run(claimLanded(w));
  const good = w.posted[0];
  const bad = [{ ...good, dest: '0014' + 'cd'.repeat(20) }, { ...good, fee: good.fee + 7 }, { ...good, claimerPub: '02' + 'ab'.repeat(32) }];
  const watcher = w.watcher({ list: () => bad });
  const out = await watcher.pass();
  assert.equal(out.added, 0);
  assert.equal(w.sent || 0, 0);
});

test('a pre-signature that names the real lock output with terms that make another script is let go', async () => {
  const w = world();
  await w.start();
  await w.run(claimLanded(w));
  const good = w.posted[0], d = scalar('attacker'), t = scalar('attacker-t');
  const fake = TP.makePresig({
    dUser: d, claimerPub: G.multiply(d).toRawBytes(true), T: G.multiply(t), lockerXonly: G.multiply(scalar('x')).toRawBytes(true).slice(1), csvBlocks: 144, lockOut: good.lock,
    dest: '0014' + 'ee'.repeat(20), fee: 1500, sTilde: good.sTilde, lockNu: good.lockNu, deadline: good.deadline,
  });
  assert.ok(TP.verifyPresig(fake).ok, 'it verifies on its own terms');
  const watcher = w.watcher({ list: () => [fake] });
  await watcher.pass();
  await watcher.pass();
  assert.equal(w.sent || 0, 0);
  assert.equal(w.btc.spends.get(`${good.lock.txid}:${good.lock.vout}`), undefined);
});

test('a publish that is refused or fails leaves the swap exactly as it is: no claim of protection, the swap completes, the take is the page\'s', async () => {
  for (const mode of ['refuse', 'throw']) {
    const w = world({ publish: mode });
    await w.start();
    await w.run(async () => (await w.user())?.phase === 'done' && (await w.lp())?.phase === 'done');
    const user = await w.user();
    assert.ok(w.publishCalls >= 1);
    assert.notEqual(user.presig && user.presig.published, true);
    assert.equal(describeRev(user, w.clock.now).watched, false, 'the card does not say it');
    assert.ok(user.take, 'the user took the BTC itself');
  }
});

test('with the page up, its own take and the watcher agree: whoever is second finds the lock spent', async () => {
  const w = world();
  await w.start();
  await w.run(async () => (await w.user())?.phase === 'done');
  const watcher = w.watcher();
  await watcher.pass();
  assert.equal(w.sent || 0, 0, 'the lock is spent by the user\'s own take: the watcher sends nothing');
});

test('the watcher funds a fee a committed fee falls short of, and never touches the committed output', async () => {
  const w = world();
  await w.start();
  await w.run(claimLanded(w));
  w.userUp = false;
  const dest = bytesToHex(w.uW.prims.p2wpkhScript(w.uW.wallet.pub));
  const funder = { changeSpk: hexToBytes('0014' + '77'.repeat(20)), coins: async () => [{ txid: 'ab'.repeat(32), vout: 0, value: 30_000 }], sign: (tx, inputs) => inputs.map(() => [new Uint8Array(64), new Uint8Array(33)]) };
  // the market has moved well past the committed fee (a 4.5 sat/vB fee at 3 x 1.5): the take is built with the funder's input
  const w2 = makeTakeWatcher({ source: { list: async () => w.posted }, store: memoryStore(), funder, now: w.clock.now, pool: { findClaim: async (nu) => w.evm.findClaim(nu) }, chain: { outspend: async () => null, status: async () => ({ confirmations: 0 }), feeRate: async () => 40, broadcast: async () => {} } });
  await w2.take(w.posted);
  const [st] = [{ id: w2.idOf(w.posted[0]), presig: w.posted[0] }];
  const t = TP.extractT(st.presig, [...w.evm.claims.values()][0][0]);
  assert.ok(t, 'the claim gives t');
  const built = await w2.build(st, t, 40);
  assert.equal(built.funded, true);
  assert.equal(built.tx.inputs.length, 2);
  assert.equal(built.tx.outputs[0].value, w.posted[0].lock.value - w.posted[0].fee);
  assert.equal(bytesToHex(built.tx.outputs[0].script), dest);
  assert.ok(built.effectiveFee / built.vsize >= 39, String(built.effectiveFee / built.vsize));
  assert.ok(built.effectiveFee - w.posted[0].fee <= 20_000, 'within the watcher\'s own cap');
  assert.equal(fundPlan({ baseFee: 1500, baseVsize: 111, feeRate: 40, coin: { txid: 'a', vout: 0, value: 30_000 }, changeSpk: funder.changeSpk, maxFund: 100 }), null, 'refused above the cap');
});

let passed = 0;
for (const [name, fn] of tests) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} take pre-signature flow checks passed`);
process.exit(process.exitCode || 0);
