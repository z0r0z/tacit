// The production builder of the swap's Bitcoin transactions (dapp/adaptor-btc-tx.js): lock, claim and refund as signed
// commit/reveal pairs with real funding and fees, each run through the real tacit.validateOutpoint, with the
// signatures checked against the BIP-341 sighashes and the sats accounted to the satoshi. Offline; Node 22.
//   node tests/adaptor-btc-tx.test.mjs

import assert from 'node:assert/strict';
import { sha256, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { G, modN, bigintToBytes32, verifySchnorr } from '../dapp/bulletproofs.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '../dapp/adaptor-btc-tx.js';
import { deriveLock, claimSecret } from '../dapp/adaptor-btc-lock.js';
import * as X from '../dapp/adaptor-xswap.js';
import * as adaptor from '../dapp/adaptor-signature.js';
import { P as userPrims, fetched, tacit, te, scalar, xonly, etchNote, validate } from './lib/btc-sim.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const lpWallet = makeBtcWallet({ priv: bigintToBytes32(scalar('lp-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 1 });
const lpPrims = lpWallet.prims;
const kit = tacitKit(tacit);
const user = makeAdaptorBtcTx({ prims: userPrims, kit });
const lp = makeAdaptorBtcTx({ prims: lpPrims, kit });

const FEE_RATE = 3, CSV = 144, VALUE = 7000n;
const coin = (tag, value) => ({ txid: bytesToHex(sha256(te('coin/' + tag))), vout: 0, value });
const toEsplora = (pair, height = 330000) => ({
  txid: pair.revealTxid,
  esplora: {
    txid: pair.revealTxid, status: { confirmed: true, block_height: height },
    vin: pair.revealTx.inputs.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(bytesToHex) })),
    vout: pair.revealTx.outputs.map((o) => ({ scriptpubkey: bytesToHex(o.script), value: o.value })),
  },
});
const fetchOf = (...ops) => { const m = new Map(ops.map((o) => [o.txid, o.esplora])); return async (id) => m.get(id) || null; };

// The user's note: an etch at the user's own P2WPKH address, then a lock to the LP's key plus T.
const userSpk = userPrims.p2wpkhScript(userPrims.wallet.pub);
const r0 = scalar('note-blinding');
const etch = etchNote({ ticker: 'TP', value: VALUE, r: r0, script: userSpk, signerD: scalar('etcher') });
const note = { txid: etch.txid, vout: 0, value: 546, amount: VALUE, blinding: r0 };
const swapId = X.swapIdOf(note.txid, 0);
const userSeed = sha256(te('user-seed'));
const sec = X.deriveSwapSecrets({ seed: userSeed, swapId });
const dLp = lpPrims.wallet.priv;
const lpPub = lpPrims.wallet.pub;
const userXonly = userPrims.wallet.xonly();
const lock = deriveLock({ prims: userPrims, claimerPub: lpPub, T: sec.T, lockerXonly: userXonly, csvBlocks: CSV });
const hint = X.lockHintScript({ seed: userSeed, swapId, claimerPub: lpPub, csvBlocks: CSV, value: VALUE });

const lockPair = user.lockTransfer({ asset: etch.asset, notes: [note], lock, lockAmount: VALUE, rLock: sec.rLock, hint, satsUtxos: [coin('user-sats', 200_000)], feeRate: FEE_RATE });
const lockOp = toEsplora(lockPair);

test('the lock is a valid note at the lock script, with a change output and the recovery hint behind it', async () => {
  const f = fetchOf(etch, lockOp);
  assert.deepEqual(await validate(f, lockPair.revealTxid, 0), { ok: true, reason: undefined });
  const outs = lockPair.revealTx.outputs;
  assert.equal(bytesToHex(outs[0].script), bytesToHex(lock.spk), 'vout 0 pays the lock');
  assert.equal(bytesToHex(outs[1].script), bytesToHex(userSpk), 'vout 1 is the wallet\'s own change/padding output');
  assert.equal(outs[2].value, 0, 'the hint carries no sats');
  const got = X.recoverBtcLock({ prims: userPrims, seed: userSeed, swapId, lockerXonly: userXonly, outputs: outs });
  assert.equal(got.vout, 0);
  assert.equal(got.value, VALUE);
  assert.equal((await validate(f, lockPair.revealTxid, 1)).ok, true, 'the padding output is a (zero) note of the wallet');
});

test('the sats balance to the satoshi, and each fee covers its transaction at the quoted rate', () => {
  const pairs = [lockPair];
  for (const p of pairs) {
    const commitIn = 200_000;
    const commitOut = p.commitTx.outputs.reduce((s, o) => s + o.value, 0);
    assert.equal(commitIn - commitOut, p.commitFee, 'commit: inputs minus outputs is the fee');
    const revealIn = p.commitTx.outputs[0].value + 546;
    const revealOut = p.revealTx.outputs.reduce((s, o) => s + o.value, 0);
    assert.equal(revealIn - revealOut, p.revealFee, 'reveal: inputs minus outputs is the fee');
    assert.ok(p.revealFee >= Math.ceil(user.vsizeOf(p.revealTx) * FEE_RATE), 'the reveal fee covers its real size');
    assert.ok(p.commitFee >= Math.ceil(user.vsizeOf(p.commitTx) * FEE_RATE), 'the commit fee covers its real size');
    assert.ok(p.revealTx.outputs.every((o) => o.value === 0 || o.value >= 546), 'no dust output');
  }
});

// LP claims with the t it read: key path under d_LP + t.
const claimSk = claimSecret({ dClaimer: dLp, t: sec.t, lock });
const lockOut = { txid: lockPair.revealTxid, vout: 0, value: 546 };
const claimPair = lp.claimTransfer({ asset: etch.asset, lockOut, lock, sk: claimSk, amount: VALUE, rLock: sec.rLock, satsUtxos: [coin('lp-sats', 150_000)], feeRate: FEE_RATE });
const claimOp = toEsplora(claimPair);

test('the claim is a valid key-path spend of the lock, the validator takes its output as the LP\'s note, and the wallet can read the amount back', async () => {
  const f = fetchOf(etch, lockOp, claimOp);
  assert.deepEqual(await validate(f, claimPair.revealTxid, 0), { ok: true, reason: undefined });
  const w = claimPair.revealTx.inputs[1].witness;
  assert.equal(w.length, 1);
  const prevouts = [{ value: claimPair.commitTx.outputs[0].value, script: claimPair.commitTx.outputs[0].script }, { value: 546, script: lock.spk }];
  assert.ok(verifySchnorr(w[0], lpPrims.tapSighashKeyPath(claimPair.revealTx, 1, prevouts, 0x00), lock.outputXonly), 'verifies under the lock output key');
  assert.equal(bytesToHex(claimPair.revealTx.outputs[0].script), bytesToHex(lpPrims.p2wpkhScript(lpPrims.wallet.pub)), 'the claimed note goes to the LP\'s own address');
  // the amount in the payload decrypts with the wallet's own keystream for this input and output index
  const env = tacit.decodeEnvelopeScript(claimPair.revealTx.inputs[0].witness[1]);
  const dec = tacit.decodeCXferBppPayload(env.payload);
  const anchor = new Uint8Array([...hexToBytes(lockOut.txid).reverse(), 0, 0, 0, 0]);
  const ks = tacit.deriveAmountKeystreamSelf(lpPrims.wallet.priv, anchor, 0);
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(dec.outputs[0].encryptedAmount[i] ^ ks[i]);
  assert.equal(n, VALUE);
});

test('a key that does not open the lock cannot build a claim', () => {
  assert.throws(() => lp.claimTransfer({ asset: etch.asset, lockOut, lock, sk: bigintToBytes32(scalar('wrong')), amount: VALUE, rLock: sec.rLock, satsUtxos: [coin('lp-sats2', 150_000)], feeRate: FEE_RATE }), /does not verify/);
});

// The user refunds once the lock is CSV blocks old.
const refundPair = user.refundTransfer({ asset: etch.asset, lockOut, lock, dLocker: userPrims.wallet.priv, amount: VALUE, rLock: sec.rLock, satsUtxos: [coin('user-sats2', 120_000)], feeRate: FEE_RATE });

test('the refund is a valid script-path spend: nSequence is the timelock, the control block opens to the lock key', async () => {
  const f = fetchOf(etch, lockOp, toEsplora(refundPair));
  assert.deepEqual(await validate(f, refundPair.revealTxid, 0), { ok: true, reason: undefined });
  const inp = refundPair.revealTx.inputs[1];
  assert.equal(inp.sequence, CSV);
  const [sig, leaf, control] = inp.witness;
  const prevouts = [{ value: refundPair.commitTx.outputs[0].value, script: refundPair.commitTx.outputs[0].script }, { value: 546, script: lock.spk }];
  assert.ok(verifySchnorr(sig, userPrims.tapSighash(refundPair.revealTx, 1, prevouts, userPrims.tapLeafHash(leaf), 0x00), userXonly));
  assert.equal(bytesToHex(userPrims.tweakedOutputKey(control.slice(1), userPrims.tapLeafHash(leaf)).Q_xonly), bytesToHex(lock.outputXonly));
  assert.throws(() => lp.refundTransfer({ asset: etch.asset, lockOut, lock, dLocker: dLp, amount: VALUE, rLock: sec.rLock, satsUtxos: [coin('lp-sats3', 120_000)], feeRate: FEE_RATE }), /not the refund key/);
});

test('a refund rebuilt from the key and the chain alone is valid and spends the same lock by the same path', async () => {
  const got = X.recoverBtcLock({ prims: userPrims, seed: userSeed, swapId, lockerXonly: userXonly, outputs: lockPair.revealTx.outputs });
  const again = user.refundTransfer({ asset: etch.asset, lockOut: { txid: lockPair.revealTxid, vout: got.vout, value: 546 }, lock: got.lock, dLocker: userPrims.wallet.priv, amount: got.value, rLock: got.rLock, satsUtxos: [coin('user-sats2', 120_000)], feeRate: FEE_RATE });
  assert.deepEqual(await validate(fetchOf(etch, lockOp, toEsplora(again)), again.revealTxid, 0), { ok: true, reason: undefined });
  const a = again.revealTx.inputs[1], b = refundPair.revealTx.inputs[1];
  assert.equal(`${a.txid}:${a.vout}:${a.sequence}`, `${b.txid}:${b.vout}:${b.sequence}`);
  assert.equal(bytesToHex(a.witness[1]), bytesToHex(b.witness[1]), 'the same refund leaf');
  assert.equal(bytesToHex(a.witness[2]), bytesToHex(b.witness[2]), 'the same control block');
});

test('the builder refuses what would not be a transfer: unbalanced amounts, too few sats, a lock larger than the notes', () => {
  assert.throws(() => user.transfer({ asset: etch.asset, inputs: [{ ...note, spk: userSpk, witnessSizes: [72, 33], sign: () => [] }], outputs: [{ amount: VALUE + 1n, blinding: 5n, script: userSpk }], satsUtxos: [coin('x', 100000)], feeRate: 1 }), /exactly what the inputs hold/);
  assert.throws(() => user.lockTransfer({ asset: etch.asset, notes: [note], lock, lockAmount: VALUE, rLock: sec.rLock, hint, satsUtxos: [coin('dust', 800)], feeRate: FEE_RATE }), /not enough sats/);
  assert.throws(() => user.lockTransfer({ asset: etch.asset, notes: [note], lock, lockAmount: VALUE + 1n, rLock: sec.rLock, hint, satsUtxos: [coin('y', 200000)], feeRate: FEE_RATE }), /within the notes/);
});

test('a lock of part of a note returns the rest to the wallet as a note it can read', async () => {
  const part = user.lockTransfer({ asset: etch.asset, notes: [note], lock, lockAmount: 2000n, rLock: sec.rLock, hint, satsUtxos: [coin('user-sats4', 200_000)], feeRate: FEE_RATE });
  const f = fetchOf(etch, toEsplora(part));
  assert.equal((await validate(f, part.revealTxid, 0)).ok, true);
  assert.equal((await validate(f, part.revealTxid, 1)).ok, true, 'the 5000 change');
  const env = tacit.decodeEnvelopeScript(part.revealTx.inputs[0].witness[1]);
  const dec = tacit.decodeCXferBppPayload(env.payload);
  const anchor = new Uint8Array([...hexToBytes(note.txid).reverse(), 0, 0, 0, 0]);
  const ks = tacit.deriveAmountKeystreamSelf(userPrims.wallet.priv, anchor, 1);
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(dec.outputs[1].encryptedAmount[i] ^ ks[i]);
  assert.equal(n, VALUE - 2000n);
});

test('the claim opens with t from the Ethereum leg: z -> t -> the same secret the claim signed with', () => {
  const Ts = sec.T;
  const L = G.multiply(scalar('L')), O = G.multiply(scalar('O')); // stand-ins: only the algebra of the adaptor is exercised here
  const excess = modN(scalar('L') - scalar('O'));
  const nonce = adaptor.evmKernelNonce({ excess, inC: [L], outC: [O], T: Ts });
  const pre = adaptor.evmKernelPresign({ excess, inC: [L], outC: [O], T: Ts, nonce });
  const done = adaptor.evmKernelComplete(pre, sec.t);
  const t = adaptor.evmKernelExtract(pre.sTilde, done.z);
  assert.equal(t, sec.t);
  assert.equal(bytesToHex(claimSecret({ dClaimer: dLp, t, lock })), bytesToHex(claimSk));
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} adaptor-btc-tx checks passed`);
process.exit(process.exitCode || 0);
