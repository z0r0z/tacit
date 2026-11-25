// The take locked with the lock: a Bitcoin lock that pays the provider's fee for taking it as a second output of the lock's own script, so the provider has
// it only when the swap is done (its key and t open it) and the user has it back when it is not (the refund path opens it). Builders with the signatures
// checked, the swap through the simulated chains, the old form still answered, and the quote that says which form a provider takes.
//   node tests/fastbridge-take-in-lock.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { sha256, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { bigintToBytes32, verifySchnorr } from '../dapp/bulletproofs.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '../dapp/adaptor-btc-tx.js';
import { deriveLock, claimSecret } from '../dapp/adaptor-btc-lock.js';
import { makeQuoter } from '../dapp/fastbridge-provider.js';
import { applyEnv } from '../fastbridge-lp/lib/env-config.mjs';
import * as X from '../dapp/adaptor-xswap.js';
import { P as userPrims, tacit, te, scalar, etchNote, validate } from './lib/btc-sim.mjs';
import { ASSET } from './lib/chain-sim.mjs';
import { world, memStore, VALUE } from './lib/fastbridge-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const hx = bytesToHex;

// ── the builders, with the signatures checked against the BIP-341 sighashes ──
const lpWallet = makeBtcWallet({ priv: bigintToBytes32(scalar('lp-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 1 });
const lpPrims = lpWallet.prims, kit = tacitKit(tacit);
const user = makeAdaptorBtcTx({ prims: userPrims, kit }), lp = makeAdaptorBtcTx({ prims: lpPrims, kit });
const FEE_RATE = 3, CSV = 144, AMOUNT = 7000n, TAKE = 3546;
const coin = (tag, value) => ({ txid: hx(sha256(te('coin/' + tag))), vout: 0, value });
const userSpk = userPrims.p2wpkhScript(userPrims.wallet.pub);
const r0 = scalar('note-blinding');
const etch = etchNote({ ticker: 'TP', value: AMOUNT, r: r0, script: userSpk, signerD: scalar('etcher') });
const note = { txid: etch.txid, vout: 0, value: 546, amount: AMOUNT, blinding: r0 };
const swapId = X.swapIdOf(note.txid, 0), userSeed = sha256(te('user-seed'));
const sec = X.deriveSwapSecrets({ seed: userSeed, swapId });
const dLp = lpPrims.wallet.priv, userXonly = userPrims.wallet.xonly();
const lock = deriveLock({ prims: userPrims, claimerPub: lpPrims.wallet.pub, T: sec.T, lockerXonly: userXonly, csvBlocks: CSV });
const hint = X.lockHintScript({ seed: userSeed, swapId, claimerPub: lpPrims.wallet.pub, csvBlocks: CSV, value: AMOUNT });
const lockPair = user.lockTransfer({ asset: etch.asset, notes: [note], lock, lockAmount: AMOUNT, rLock: sec.rLock, hint, pay: { value: TAKE, script: lock.spk }, satsUtxos: [coin('user-sats', 200_000)], feeRate: FEE_RATE });
const takeVout = lockPair.revealTx.outputs.findIndex((o, i) => i !== 0 && o.value === TAKE && hx(o.script) === hx(lock.spk));
const takeOut = { txid: lockPair.revealTxid, vout: takeVout, value: TAKE };
const claimSk = claimSecret({ dClaimer: dLp, t: sec.t, lock });

test('the lock with its take: the take is a second output of the lock\'s own script, vout 0 is still the note, and the lock is found again from the key', async () => {
  assert.ok(takeVout > 0, 'the take is an output of its own');
  const op = { txid: lockPair.revealTxid, esplora: { txid: lockPair.revealTxid, status: { confirmed: true, block_height: 330000 }, vin: lockPair.revealTx.inputs.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(hx) })), vout: lockPair.revealTx.outputs.map((o) => ({ scriptpubkey: hx(o.script), value: o.value })) } };
  const f = async (id) => (id === etch.txid ? etch.esplora : id === op.txid ? op.esplora : null);
  assert.deepEqual(await validate(f, lockPair.revealTxid, 0), { ok: true, reason: undefined });
  const got = X.recoverBtcLock({ prims: userPrims, seed: userSeed, swapId, lockerXonly: userXonly, outputs: op.esplora.vout });
  assert.equal(got.vout, 0);
  assert.equal(got.value, AMOUNT);
});

test('the provider sweeps the take by the key path under its key plus t, to its own address, and the signature verifies', () => {
  const sweep = lp.claimSats({ lockOut: takeOut, lock, sk: claimSk, feeRate: 4, maxFee: 1800 });
  const w = sweep.revealTx.inputs[0].witness;
  assert.equal(w.length, 1);
  assert.ok(verifySchnorr(w[0], lpPrims.tapSighashKeyPath(sweep.revealTx, 0, [{ value: TAKE, script: lock.spk }], 0x00), lock.outputXonly), 'verifies under the lock output key');
  assert.equal(hx(sweep.revealTx.outputs[0].script), hx(lpPrims.p2wpkhScript(lpPrims.wallet.pub)), 'to the provider\'s own address');
  assert.ok(sweep.revealFee <= 1800 && sweep.revealTx.outputs[0].value === TAKE - sweep.revealFee, 'the fee comes out of the output, under its ceiling');
  assert.throws(() => lp.claimSats({ lockOut: takeOut, lock, sk: bigintToBytes32(scalar('wrong')), feeRate: 4 }), /does not verify/, 'a key that does not open it cannot');
});

test('the user takes the take back by the refund path once the lock is old: the sequence is the timelock, the control block opens to the lock key, and the provider\'s key is not the refund key', () => {
  const back = user.refundSats({ lockOut: takeOut, lock, dLocker: userPrims.wallet.priv, feeRate: 4, maxFee: 1800 });
  const inp = back.revealTx.inputs[0];
  assert.equal(inp.sequence, CSV);
  const [sig, leaf, control] = inp.witness;
  assert.ok(verifySchnorr(sig, userPrims.tapSighash(back.revealTx, 0, [{ value: TAKE, script: lock.spk }], userPrims.tapLeafHash(leaf), 0x00), userXonly));
  assert.equal(hx(userPrims.tweakedOutputKey(control.slice(1), userPrims.tapLeafHash(leaf)).Q_xonly), hx(lock.outputXonly));
  assert.equal(hx(back.revealTx.outputs[0].script), hx(userSpk), 'back to the user\'s own address');
  assert.ok(back.revealFee <= 1800);
  assert.throws(() => lp.refundSats({ lockOut: takeOut, lock, dLocker: dLp, feeRate: 4 }), /not the refund key/);
});

// ── the swap, through the simulated chains ──
function tilWorld(over = {}, { inLock = true } = {}) {
  const w = world(over);
  w.quote.takeSats = TAKE; w.quote.takeInLock = true;
  w.lBtc.satsUtxos = async () => [];       // the provider holds no coin of its own: whatever funds its take comes from the lock
  w.start = (takeSats = TAKE) => w.userBl.start({ asset: w.etch.asset, amount: VALUE, notes: [w.note], counterClaimPub: w.lW.wallet.pub, evmAsset: ASSET, evmAmount: VALUE, quoteId: w.quote.id, takeSats, takeInLock: inLock });
  return w;
}
const lpAddr = (w) => hx(w.lW.prims.p2wpkhScript(w.lW.wallet.pub));

test('with the take locked, the swap runs to its end with a provider that holds no coin: it sweeps the take, funds the take of the note from what it left, and the user pays it nothing outside the lock', async () => {
  const w = tilWorld();
  const rec = await w.start();
  assert.equal(rec.takeInLock, true);
  assert.ok(rec.takeVout > 0 && rec.takeValue === TAKE, 'the record knows where the take is');
  const lockTx = w.btc.txs.get(rec.lock.txid) || null;
  await w.run(async () => (await w.user())?.phase === 'done' && (await w.lp())?.phase === 'done');
  const lp = await w.lp(), user = await w.user();
  assert.equal(lp.takeVout, rec.takeVout, 'the provider found it');
  assert.ok(lp.sweep && lp.sweeps.length >= 1, 'it swept the take first');
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:${rec.takeVout}`), lp.sweep.txid, 'the take output was spent by that sweep');
  assert.ok(lp.take && lp.take.coins.length && lp.take.coins.every((c) => c.txid === lp.sweep.txid), 'and the take of the note was funded from the sweep\'s coin alone');
  assert.ok(await w.noteOf(lp.take.txid, 0), 'the provider\'s Bitcoin note is valid');
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:${rec.lock.vout}`), lp.take.txid, 'the lock was taken by the provider');   // (the user's side is done once its claim is final)
  // nothing in the lock paid the provider's own address
  const sim = w.btc.txs.get(rec.lock.txid) || lockTx;
  if (sim) assert.ok(!sim.esplora.vout.some((o) => o.scriptpubkey === lpAddr(w) && o.value > 546), 'no output of the lock goes straight to the provider');
});

test('with the take locked and no swap, the take comes back with the refund: the user has the lock and the take, and the provider has neither', async () => {
  const w = tilWorld();
  w.lpUp = false; w.lpOnline = false;
  const rec = await w.start();
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  w.btc.mine(143);
  await w.run(async () => (await w.user())?.phase === 'refunded');
  const user = await w.user();
  assert.ok(await w.noteOf(user.refund.txid, 0), 'the lock came home');
  assert.ok(user.takeRefund, 'a refund of the take was made');
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:${rec.takeVout}`), user.takeRefund.txid, 'the take output was spent by the user\'s refund');
  assert.equal(user.takeSettled, true);
  assert.equal((await w.lpStore.list()).length, 0, 'the provider took on nothing');
});

test('the form the provider has always taken still works against a provider that says it takes the new one: the take paid to its address, taken from there', async () => {
  const w = tilWorld({}, { inLock: false });
  w.lBtc.satsUtxos = async () => [];
  const rec = await w.start();
  assert.equal(rec.takeInLock, undefined);
  await w.run(async () => (await w.user())?.phase === 'done' && (await w.lp())?.phase === 'done');
  const lp = await w.lp();
  assert.equal(lp.takeVout, undefined);
  assert.equal(lp.sweep, undefined, 'no sweep: the coin was already its own');
  assert.ok(lp.take && await w.noteOf(lp.take.txid, 0));
});

test('a lock that pays the take in neither form is refused, and the user is told why', async () => {
  const w = tilWorld();
  await w.start(0);                         // the lock carries no take at all
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  assert.match((await w.user()).why, /does not pay the fee of the take/);
  assert.deepEqual(await w.lpStore.list(), []);
});

test('a take that was locked is found again with a lock found from the key', async () => {
  const w = tilWorld();
  const rec = await w.start();
  await w.run(async () => !!(await w.user())?.confirmedAt);
  const { makeFastBridgeClient } = await import('../dapp/fastbridge-client.js');
  const fresh = memStore();
  const fb = makeFastBridgeClient({ lp: w.userBl && { sendOffer: async () => ({ ok: false, why: 'unused' }), getEvmOffer: async () => null }, btc: w.uBtc, evm: w.uEvmCtx, store: fresh, seed: w.uKeys.seed, policy: { csvBlocks: 144, minClaimSecs: 3600, offerWaitSecs: 7200, maxEvmWindowSecs: 21600 }, now: w.clock.now });
  const found = await fb.recover();
  assert.equal(found.length, 1);
  const stored = (await fresh.list())[0];
  assert.equal(stored.takeVout, rec.takeVout);
  assert.equal(stored.takeValue, TAKE);
  assert.equal(stored.takeInLock, true);
});

// ── what a provider says in its quote, and the switch ──
test('a provider says in its quote that it takes the fee from the lock, only when it is set to and has a take to take; a quote without it is the quote as it was', async () => {
  const mk = (extra) => makeQuoter({ store: memStore(), now: () => 1_800_000_000, params: { btcAsset: '11'.repeat(32), evmAsset: '22'.repeat(32), minAmount: 1, maxAmount: 1_000_000, feeBps: 30, flatFee: 0, claimPub: '02' + 'aa'.repeat(32), csvBlocks: 144, evmWindowSecs: 14400, minConfsFor: () => 1, takeSats: async () => 3546, ...extra } });
  assert.equal((await mk({ takeInLock: true }).quote(10_000)).takeInLock, true);
  assert.equal('takeInLock' in (await mk({}).quote(10_000)), false, 'unset: the quote is unchanged');
  assert.equal('takeInLock' in (await mk({ takeInLock: false }).quote(10_000)), false);
  assert.equal('takeInLock' in (await mk({ takeInLock: true, takeSats: null }).quote(10_000)), false, 'with no take there is nothing to lock');
  assert.equal(applyEnv({ quote: {} }, { FB_LP_TAKE_IN_LOCK: 'on' }).quote.takeInLock, true);
  assert.equal(applyEnv({ quote: { takeInLock: true } }, { FB_LP_TAKE_IN_LOCK: 'off' }).quote.takeInLock, false);
  assert.equal('takeInLock' in applyEnv({ quote: {} }, {}).quote, false);
  assert.throws(() => applyEnv({ quote: {} }, { FB_LP_TAKE_IN_LOCK: 'yes' }), /must be on or off/);
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} take-in-lock checks passed`);
process.exit(process.exitCode || 0);
