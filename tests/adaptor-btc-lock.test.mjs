// The Bitcoin leg of the cross-chain adaptor swap (dapp/adaptor-btc-lock.js), end to end and offline:
//   etch -> lock (note into a Taproot output keyed P_claimer + T) -> claim | refund,
// each a real commit/reveal pair built with the wallet's own envelope and BIP-341 helpers, signed, and run
// through the real tacit.validateOutpoint. Then the link to the Ethereum leg: the keccak claim kernel's
// completion publishes t, and t is what opens the Bitcoin lock.
// No node and no script interpreter: Taproot signatures are verified against the output keys with the BIP-341
// sighashes, but OP_CHECKSEQUENCEVERIFY itself is only checked structurally (leaf bytes, nSequence).
//   node tests/adaptor-btc-lock.test.mjs        (needs jsdom, like the other validator tests)

import assert from 'node:assert/strict';
import { sha256, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { G, SECP_N, modN, pedersenCommit, bigintToBytes32, signSchnorr, verifySchnorr } from '../dapp/bulletproofs.js';
import * as adaptor from '../dapp/adaptor-signature.js';
import { deriveLock, claimSecret, refundLeaf } from '../dapp/adaptor-btc-lock.js';
import { deriveSwapSecrets, swapIdOf, lockHintScript, recoverBtcLock } from '../dapp/adaptor-xswap.js';
import { P, fetched, tacit, te, scalar, xonly, eq, has, p2trKey, keyPathSigner, fetchFrom, validate, C, cxfer, etchNote, NOTE_VALUE } from './lib/btc-sim.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── the actors ──
const dUser = scalar('user'), dLp = scalar('lp'), t = scalar('swap-secret'), T = adaptor.adaptorPoint(t);
const CSV = 144;
const VALUE = 1000n;
const r0 = scalar('r-note'), rLock = scalar('r-lock'), rClaim = scalar('r-claim'), rRefund = scalar('r-refund');
const userSpk = p2trKey(xonly(dUser)), lpSpk = p2trKey(xonly(dLp));

// BTC -> ETH: the user (initiator, holds t) locks the Bitcoin note to the LP's key plus T.
const lock = deriveLock({ prims: P, claimerPub: G.multiply(dLp), T, lockerXonly: xonly(dUser), csvBlocks: CSV });

// etch: the supply note (VALUE, r0) at the user's address.
const etch = etchNote({ ticker: 'TP', value: VALUE, r: r0, script: userSpk });
const noteIn = { txid: etch.txid, vout: 0, value: NOTE_VALUE, spk: userSpk, sign: keyPathSigner(dUser), r: r0 };

// lock: the user moves the note into the lock output.
const lockOp = cxfer(etch.asset, [noteIn], [{ value: VALUE, r: rLock, script: lock.spk }]);
const lockIn = { txid: lockOp.txid, vout: 0, value: NOTE_VALUE, spk: lock.spk, r: rLock };

// claim: the LP spends the lock output by key path with d_LP + t (kernel from the opening the user shared).
const claimSk = claimSecret({ dClaimer: dLp, t, lock });
const claimOp = cxfer(etch.asset, [{ ...lockIn, sign: keyPathSigner(claimSk) }], [{ value: VALUE, r: rClaim, script: lpSpk }]);

// refund: the user, by script path, once the input is CSV blocks old (nSequence = CSV).
const refundSigner = (tx, idx, prevouts) => [
  signSchnorr(P.tapSighash(tx, idx, prevouts, lock.leafHash, 0x00), bigintToBytes32(dUser)), lock.leaf, lock.controlBlock,
];
const refundOp = cxfer(etch.asset, [{ ...lockIn, sequence: CSV, sign: refundSigner }], [{ value: VALUE, r: rRefund, script: userSpk }]);

// ── tests ──
test('the lock output is a valid note, and so are its claim and its refund', async () => {
  const both = fetchFrom(etch, lockOp, claimOp, refundOp);
  assert.deepEqual(await validate(both, etch.txid, 0), { ok: true, reason: undefined });
  assert.deepEqual(await validate(both, lockOp.txid, 0), { ok: true, reason: undefined }, 'a note can sit at the lock script');
  assert.deepEqual(await validate(both, claimOp.txid, 0), { ok: true, reason: undefined }, 'claim');
  assert.deepEqual(await validate(both, refundOp.txid, 0), { ok: true, reason: undefined }, 'refund');
  assert.ok(eq(lockOp.reveal.outputs[0].script, lock.spk), 'the lock output pays the derived lock script');
});

test('the lock script is recomputable from the offer, and is bound to every term of it', () => {
  const again = deriveLock({ prims: P, claimerPub: G.multiply(dLp).toRawBytes(true), T, lockerXonly: xonly(dUser), csvBlocks: CSV });
  assert.ok(eq(again.spk, lock.spk), 'same offer, same script (33-byte key form)');
  const base = bytesToHex(lock.spk);
  const other = (o) => bytesToHex(deriveLock({ prims: P, claimerPub: G.multiply(dLp), T, lockerXonly: xonly(dUser), csvBlocks: CSV, ...o }).spk);
  assert.notEqual(other({ T: adaptor.adaptorPoint(scalar('other-t')) }), base, 'adaptor point');
  assert.notEqual(other({ claimerPub: G.multiply(scalar('other-lp')) }), base, 'claimer key');
  assert.notEqual(other({ lockerXonly: xonly(scalar('other-user')) }), base, 'refund key');
  assert.notEqual(other({ csvBlocks: CSV + 1 }), base, 'timelock');
  assert.throws(() => deriveLock({ prims: P, claimerPub: G.multiply(dLp), T: G.multiply(dLp).negate(), lockerXonly: xonly(dUser), csvBlocks: CSV }), /cancels/);
});

test('the claim is a valid key-path spend of the lock output, and every output is bound by it', () => {
  const sh = P.tapSighashKeyPath(claimOp.reveal, 1, claimOp.prevouts, 0x00);
  const [sig] = claimOp.reveal.inputs[1].witness;
  assert.ok(verifySchnorr(sig, sh, lock.outputXonly), 'verifies under the lock output key');
  assert.ok(verifySchnorr(claimOp.reveal.inputs[0].witness[0], claimOp.sh0, claimOp.signerXonly), 'the envelope signature (vin[0]) verifies');
  const redirected = { ...claimOp.reveal, outputs: [{ ...claimOp.reveal.outputs[0], script: userSpk }] };
  assert.ok(!verifySchnorr(sig, P.tapSighashKeyPath(redirected, 1, claimOp.prevouts, 0x00), lock.outputXonly), 'a redirected output voids the signature');
});

test('the refund is a valid script-path spend: control block opens to the lock key, signature under the locker, nSequence = CSV', () => {
  const [sig, leaf, control] = refundOp.reveal.inputs[1].witness;
  const sh = P.tapSighash(refundOp.reveal, 1, refundOp.prevouts, P.tapLeafHash(leaf), 0x00);
  assert.ok(verifySchnorr(sig, sh, xonly(dUser)), 'signature under the refund key in the leaf');
  assert.ok(eq(leaf, refundLeaf({ lockerXonly: xonly(dUser), csvBlocks: CSV })));
  assert.ok(has(leaf, xonly(dUser)), 'the leaf names the locker');
  assert.equal(leaf[0], 0x02, 'CSV 144 is a two-byte script number');
  assert.deepEqual([...leaf.slice(1, 3)], [0x90, 0x00], '144 = 0x0090, little endian, sign byte kept');
  assert.deepEqual([...leaf.slice(3, 5)], [0xb2, 0x75], 'OP_CHECKSEQUENCEVERIFY OP_DROP');
  assert.equal(refundOp.reveal.inputs[1].sequence, CSV, 'nSequence carries the relative locktime');
  const { Q_xonly } = P.tweakedOutputKey(control.slice(1), P.tapLeafHash(leaf));
  assert.ok(eq(Q_xonly, lock.outputXonly), 'the control block and the leaf commit to the lock output key');
  assert.equal(control[0] & 1, lock.parity, 'parity bit');
  // The claim path is not blocked by the timelock: its nSequence is final-ish, not CSV.
  assert.notEqual(claimOp.reveal.inputs[1].sequence, CSV);
});

test('without t the claimer cannot sign; with the wrong t nobody can', () => {
  const sh = P.tapSighashKeyPath(claimOp.reveal, 1, claimOp.prevouts, 0x00);
  assert.ok(!verifySchnorr(signSchnorr(sh, bigintToBytes32(dLp)), sh, lock.outputXonly), "the claimer's own key is not enough");
  assert.ok(!verifySchnorr(signSchnorr(sh, bigintToBytes32(dUser)), sh, lock.outputXonly), "nor is the locker's");
  assert.throws(() => claimSecret({ dClaimer: dLp, t: scalar('wrong-t'), lock }), /does not open/);
  assert.throws(() => claimSecret({ dClaimer: dUser, t, lock }), /does not open/, 'right t, wrong claimer');
});

test('both internal-key parities open (the P_claimer + T sum can have either y)', () => {
  let odd = 0, even = 0;
  for (let k = 0; k < 24 && (odd < 2 || even < 2); k++) {
    const tk = scalar('parity-t' + k), Tk = adaptor.adaptorPoint(tk);
    const l = deriveLock({ prims: P, claimerPub: G.multiply(dLp), T: Tk, lockerXonly: xonly(dUser), csvBlocks: CSV });
    const sk = claimSecret({ dClaimer: dLp, t: tk, lock: l });
    const msg = sha256(te('m' + k));
    assert.ok(verifySchnorr(signSchnorr(msg, sk), msg, l.outputXonly));
    l.internalOddY ? odd++ : even++;
  }
  assert.ok(odd >= 1 && even >= 1, `exercised odd=${odd} even=${even}`);
});

test("the kernel needs the locked note's opening: a claim signed without r_lock is not a note", async () => {
  const forged = cxfer(etch.asset, [{ ...lockIn, sign: keyPathSigner(claimSk) }], [{ value: VALUE, r: rClaim, script: lpSpk }], { kernelKey: scalar('guess') });
  const f = fetchFrom(etch, lockOp, forged);
  assert.equal((await validate(f, forged.txid, 0)).ok, false);
  // a wrong value is rejected as well: the opening is (value, blinding)
  const inflated = cxfer(etch.asset, [{ ...lockIn, sign: keyPathSigner(claimSk) }], [{ value: VALUE * 2n, r: rClaim, script: lpSpk }]);
  assert.equal((await validate(fetchFrom(etch, lockOp, inflated), inflated.txid, 0)).ok, false, 'conservation');
});

test("the transfer's kernel_sig sits inside the commit script, so the commit address cannot precede it", () => {
  assert.ok(has(claimOp.script, claimOp.kernelSig), 'kernel_sig is a push inside the envelope leaf');
  const otherSig = signSchnorr(sha256(te('x')), bigintToBytes32(scalar('x')));
  const swapped = bytesToHex(claimOp.script).replace(bytesToHex(claimOp.kernelSig), bytesToHex(otherSig));
  assert.notEqual(swapped, bytesToHex(claimOp.script));
  const leafOf = (hex) => P.tapLeafHash(Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16))));
  const spkOf = (leaf) => bytesToHex(P.p2trScript(P.tweakedOutputKey(P.TAP_NUMS, leaf).Q_xonly));
  assert.notEqual(spkOf(leafOf(swapped)), bytesToHex(claimOp.commitSpk), 'a different kernel_sig is a different commit address');
});

test('a lock carrying its recovery hint is still a valid note, and the locker refunds it from key + chain alone', async () => {
  const seed = sha256(te('user-seed')), swapId = swapIdOf(noteIn.txid, noteIn.vout);
  const sec = deriveSwapSecrets({ seed, swapId });
  const lk = deriveLock({ prims: P, claimerPub: G.multiply(dLp), T: sec.T, lockerXonly: xonly(dUser), csvBlocks: CSV });
  const hint = lockHintScript({ seed, swapId, claimerPub: G.multiply(dLp).toRawBytes(true), csvBlocks: CSV, value: VALUE });
  const hinted = cxfer(etch.asset, [noteIn], [{ value: VALUE, r: sec.rLock, script: lk.spk }], { extra: [{ value: 0, script: hint }] });
  assert.equal(hinted.reveal.outputs.length, 2);
  // Forget everything but the key: read the spending transaction back, find the lock, rebuild the refund.
  const got = recoverBtcLock({ prims: P, seed, swapId, lockerXonly: xonly(dUser), outputs: hinted.reveal.outputs });
  assert.equal(got.vout, 0);
  assert.equal(got.value, VALUE);
  const refund = cxfer(etch.asset, [{ txid: hinted.txid, vout: got.vout, value: NOTE_VALUE, spk: got.lock.spk, r: got.rLock, sequence: got.csvBlocks,
    sign: (tx, idx, prevouts) => [signSchnorr(P.tapSighash(tx, idx, prevouts, got.lock.leafHash, 0x00), bigintToBytes32(dUser)), got.lock.leaf, got.lock.controlBlock] }],
  [{ value: got.value, r: scalar('r-recovered-refund'), script: userSpk }]);
  const f = fetchFrom(etch, hinted, refund);
  assert.deepEqual(await validate(f, hinted.txid, 0), { ok: true, reason: undefined }, 'the hint output does not disturb the transfer');
  assert.equal((await validate(f, hinted.txid, 1)).ok, false, 'the hint itself is not a note');
  assert.deepEqual(await validate(f, refund.txid, 0), { ok: true, reason: undefined }, 'refund rebuilt from recovered data');
  const [sig, leaf] = refund.reveal.inputs[1].witness;
  assert.ok(verifySchnorr(sig, P.tapSighash(refund.reveal, 1, refund.prevouts, P.tapLeafHash(leaf), 0x00), xonly(dUser)));
});

// The link to the Ethereum leg, in both directions: whoever claims the EVM lock first completes its adaptor
// pre-signature with t, which publishes z; the other party extracts t = z - s~ and opens the Bitcoin lock with it.
for (const dir of [
  { name: 'BTC -> ETH (user locks Bitcoin, LP locks Ethereum)', holder: 'user', btcLocker: 'user', btcClaimer: 'lp' },
  { name: 'ETH -> BTC (user locks Ethereum, LP locks Bitcoin)', holder: 'lp', btcLocker: 'lp', btcClaimer: 'user' },
]) {
  test(`the Ethereum claim opens the Bitcoin lock: ${dir.name}`, () => {
    const d = { user: dUser, lp: dLp };
    const secret = scalar('secret-' + dir.holder), Ts = adaptor.adaptorPoint(secret);
    const btc = deriveLock({ prims: P, claimerPub: G.multiply(d[dir.btcClaimer]), T: Ts, lockerXonly: xonly(d[dir.btcLocker]), csvBlocks: CSV });
    // the EVM leg: the locked note L and the claim output O, kernel excess r_L - r_O, locked to the same T
    const evmLocker = dir.holder === 'user' ? 'lp' : 'user';
    const L = pedersenCommit(500n, scalar('evm-rL-' + evmLocker)), O = pedersenCommit(500n, scalar('evm-rO'));
    const excess = modN(scalar('evm-rL-' + evmLocker) - scalar('evm-rO'));
    const nonce = adaptor.evmKernelNonce({ excess, inC: [L], outC: [O], T: Ts });
    const pre = adaptor.evmKernelPresign({ excess, inC: [L], outC: [O], T: Ts, nonce });
    assert.ok(adaptor.evmKernelVerifyPresign({ inC: [L], outC: [O], R: pre.R, T: Ts, sTilde: pre.sTilde }), 'the counterparty checks the pre-signature before locking its own leg');
    // before the claim the Bitcoin claimer has nothing that opens the lock
    assert.throws(() => claimSecret({ dClaimer: d[dir.btcClaimer], t: scalar('guess'), lock: btc }), /does not open/);
    // the holder claims the EVM leg: the completed kernel is what the guest verifies
    const kernel = adaptor.evmKernelComplete(pre, secret);
    const e = adaptor.evmKernelChallenge([L], [O], kernel.R);
    assert.ok(G.multiply(kernel.z).equals(kernel.R.add(L.add(O.negate()).multiply(e))), 'z*G == R + e*(L - O)');
    // the other party reads z off Ethereum, extracts t, and opens the Bitcoin lock
    const tGot = adaptor.evmKernelExtract(pre.sTilde, kernel.z);
    assert.equal(tGot, secret);
    const sk = claimSecret({ dClaimer: d[dir.btcClaimer], t: tGot, lock: btc });
    const msg = sha256(te('claim ' + dir.holder));
    assert.ok(verifySchnorr(signSchnorr(msg, sk), msg, btc.outputXonly), 'the extracted t signs for the lock output');
  });
}

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} adaptor-btc-lock checks passed`);
process.exit(process.exitCode || 0);
