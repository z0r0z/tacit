// The two role machines of a fast bridge swap with the roles SWAPPED: Ethereum -> Bitcoin. The LP holds the Bitcoin TAC note and is the Bitcoin
// locker (it holds t, locks first, claims on the pool); the user holds pool TAC and is the Ethereum locker (it locks its pool note once the Bitcoin
// lock is confirmed, reads z from the LP's claim and opens the Bitcoin lock). The same machines (dapp/fastbridge-bl.js, dapp/fastbridge-el.js), the
// same simulated Bitcoin and pool on one virtual clock as tests/fastbridge-sim.test.mjs, which runs only Bitcoin -> Ethereum.
//   node tests/fastbridge-reverse.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import * as X from '../dapp/adaptor-xswap.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '../dapp/adaptor-btc-tx.js';
import { makeBitcoinLocker } from '../dapp/fastbridge-bl.js';
import { makeEthereumLocker } from '../dapp/fastbridge-el.js';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { tacit, te, scalar, etchNote, fetched } from './lib/btc-sim.mjs';
import { makeClock, makeBitcoinSim, makeEvmSim, makeEvmParty, partyKeys, pool, sha256, ASSET } from './lib/chain-sim.mjs';
import { memStore, VALUE } from './lib/fastbridge-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

// A world like fastbridge-world.mjs, with the seats exchanged: `bl` is the LP's Bitcoin locker, `el` the user's Ethereum locker.
function reverseWorld({ lpConfs = 1, funded = true } = {}) {
  const clock = makeClock(), btc = makeBitcoinSim(clock), evm = makeEvmSim(clock), kit = tacitKit(tacit);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const uW = wallet('user'), lW = wallet('lp');
  const uKeys = partyKeys('user'), lKeys = partyKeys('lp');
  const uEvm = makeEvmParty({ evm, keys: uKeys, clock }), lEvm = makeEvmParty({ evm, keys: lKeys, clock });
  if (funded) uEvm.fund(VALUE, 'inv0');                               // the user holds the pool TAC (or says it does and does not)
  const r0 = scalar('lp/note');                                      // and the LP holds the Bitcoin TAC
  const etch = etchNote({ ticker: 'TP', value: VALUE, r: r0, script: lW.prims.p2wpkhScript(lW.wallet.pub), signerD: scalar('etcher') });
  btc.addConfirmed(etch);
  const note = { txid: etch.txid, vout: 0, value: 546, amount: VALUE, blinding: r0 };
  let coinN = 0;
  const sats = () => [{ txid: bytesToHex(sha256(te('coin/' + coinN++))), vout: 0, value: 200_000 }];
  const uBtc = btc.adapter({ prims: uW.prims, builder: makeAdaptorBtcTx({ prims: uW.prims, kit }), sats });
  const lBtc = btc.adapter({ prims: lW.prims, builder: makeAdaptorBtcTx({ prims: lW.prims, kit }), sats });
  const base = { now: evm.now, lockPosition: evm.lockPosition, jobStatus: evm.jobStatus, submit: evm.submit, lockSpent: evm.lockSpentFn, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  // the pool side of each seat, from the party that now sits in it
  const lBlEvm = { now: evm.now, lockPosition: evm.lockPosition, recipient: lEvm.recipient, claimOp: lEvm.claimOp, submit: evm.submit, claimStatus: evm.jobStatus, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const uElEvm = { ...base, lockOp: uEvm.lockOp, refundOp: uEvm.refundOp, refundKey: uEvm.refundKey, available: uEvm.available };

  const quote = { id: 'q1', btcAsset: bytesToHex(etch.asset), btcValue: VALUE, evmAsset: ASSET, evmAmount: VALUE, validUntil: clock.now() + 3600 };
  const offers = new Map();
  const w = { clock, btc, evm, etch, note, quote, uW, lW, uKeys, lKeys, uBtc, lBtc, uEvm, lEvm, lpStore: memStore(), userStore: memStore(), offers, lpUp: true };
  // the Bitcoin locker (the LP) sends its offer to the Ethereum locker (the user) and reads the user's pool offer back
  const toEl = { sendOffer: async (msg) => { if (!w.userUp) throw new Error('the user is unreachable'); return w.el.receive(msg); }, getEvmOffer: async (id) => offers.get(id) || null };
  const toBl = { publishEvmOffer: async (id, o) => { offers.set(id, o); } };
  const blPolicy = { csvBlocks: 144, minClaimSecs: 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600 };
  const elPolicy = { minCsv: 72, minConfsFor: () => lpConfs, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, minAmount: 1000, maxAmount: 1_000_000, roundSecs: 600 };
  w.userUp = true;
  w.bl = makeBitcoinLocker({ seed: lKeys.seed, now: clock.now, policy: blPolicy, store: w.lpStore, btc: lBtc, evm: lBlEvm, counter: toEl });
  w.el = makeEthereumLocker({ seed: uKeys.seed, now: clock.now, policy: elPolicy, store: w.userStore, quotes: { get: async (id) => (id === quote.id ? quote : null) }, btc: uBtc, evm: uElEvm, counter: toBl });
  w.lp = async () => (await w.lpStore.list())[0];
  w.user = async () => (await w.userStore.list())[0];
  w.start = () => w.bl.start({ asset: etch.asset, amount: VALUE, notes: [note], counterClaimPub: uW.wallet.pub, evmAsset: ASSET, evmAmount: VALUE, quoteId: quote.id });
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
    throw new Error('did not finish: lp ' + JSON.stringify(await w.lp()).slice(0, 500) + ' user ' + JSON.stringify(await w.user()).slice(0, 500));
  };
  w.noteOf = async (txid, vout) => btc.resolveNote(txid, vout);
  w.poolHolds = (leaf) => evm.notes.leaves.some((l) => bytesToHex(l) === strip(leaf));
  return w;
}

test('Ethereum -> Bitcoin: the user ends with the Bitcoin note and the LP with the pool note, and each lock is spent once', async () => {
  const w = reverseWorld();
  const rec = await w.start();
  await w.run(async () => (await w.lp())?.phase === 'done' && (await w.user())?.phase === 'done');
  const lp = await w.lp(), user = await w.user();
  assert.ok(user.take, 'the user took the Bitcoin lock');
  assert.ok(await w.noteOf(user.take.txid, 0), 'the user\'s Bitcoin note is valid, by the real note validator');
  assert.equal(lp.takenBy, user.take.txid, 'the LP saw the user take it');
  const sec = X.deriveSwapSecrets({ seed: w.lKeys.seed, swapId: hexToBytes(rec.id) });
  const O = pool.commitXY(VALUE, '0x' + bytesToHex(bigintToBytes32(sec.rOut)));
  assert.ok(w.poolHolds(pool.leaf(ASSET, O.cx, O.cy, pool.nkToOwner(w.lKeys.nkOut))), 'the LP\'s note is in the pool');
  assert.equal(w.evm.locks.leaves.length, 1, 'one lock for one swap');
  assert.equal(w.evm.lockSpent.size, 1);
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorclaim']);
});

test('the user never completes (it holds no pool TAC): nothing is locked on the pool, and the LP takes its Bitcoin note back once the timelock runs', async () => {
  const w = reverseWorld({ funded: false });
  await w.start();
  await w.run(async () => (await w.lp())?.phase === 'refunded');
  const lp = await w.lp();
  assert.equal(w.evm.locks.leaves.length, 0, 'no pool lock was ever made');
  assert.equal(w.evm.lockSpent.size, 0);
  assert.deepEqual(w.evm.submitted, [], 'nothing was sent to the pool');
  assert.ok(lp.refund && lp.refund.txid, 'the LP refunded its lock');
  assert.ok(await w.noteOf(lp.refund.txid, 0), 'and the note that came back is valid, by the real note validator');
  assert.equal((await w.user())?.take, undefined, 'the user took nothing: it had locked nothing');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${ran} reverse direction checks passed`);
process.exit(process.exitCode || 0);
