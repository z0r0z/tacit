#!/usr/bin/env node
// BIP-340-faithful adaptor signatures (ops/PLAN-confidential-adaptor-swap.md phase 1). THE decisive
// property: a completed adaptor signature is accepted by the REAL kernel verifier `verifySchnorr`
// (dapp/bulletproofs.js) — so it locks an actual Tacit kernel/opening Schnorr sig, not a toy one.
// Locks: completing reveals t = σ·(s − s̃); the R'=R+T even-y parity is handled for BOTH parities;
// a pre-sig is message-bound; a wrong t fails the real verifier; a completed adaptor sig is
// shape-indistinguishable from a normal signSchnorr sig; and the two-leg same-T swap round-trips
// through verifySchnorr.
//
// Run: node tests/adaptor-signature.mjs

import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { verifySchnorr, signSchnorr, SECP_N, modN, bigintToBytes32 } from '../dapp/bulletproofs.js';
import { evenSigningKey, adaptorPoint, presign, verifyPresign, complete, completedSig, extract } from '../dapp/adaptor-signature.js';

const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const sc = (tag) => modN(BigInt('0x' + Buffer.from(sha(tag)).toString('hex'))) || 1n; // scalar in [1,n)
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// ── 1. the completed adaptor signature is accepted by the REAL verifySchnorr (both parities) ──
{
  let even = 0, odd = 0;
  for (let i = 0; i < 40; i++) {
    const d = sc('excess' + i), t = sc('secret' + i), k = sc('nonce' + i);
    const msg = sha('kernel-msg-' + i); // 32 bytes, stands in for cxferKernelMsg
    const T = adaptorPoint(t);
    const ps = presign(d, msg, T, k);
    ps.rhatEven ? even++ : odd++;
    assert.strictEqual(verifyPresign({ Px: ps.Px, msg32: msg, R: ps.R, T, sTilde: ps.sTilde }), true, 'pre-sig verifies (iter ' + i + ')');
    const s = complete(ps.sTilde, t, ps.R, T);
    const sig = completedSig(ps.RxPub, s);
    assert.strictEqual(verifySchnorr(sig, msg, ps.Px), true, 'REAL verifySchnorr accepts the completed adaptor sig (iter ' + i + ')');
    assert.strictEqual(extract(ps.sTilde, s, ps.R, T), modN(t), 'extract recovers t (iter ' + i + ')');
  }
  assert.ok(even > 0 && odd > 0, `both R+T parities exercised (even=${even}, odd=${odd})`);
  ok(`a completed adaptor sig is accepted by the real verifySchnorr, and reveals t — across both R+T parities`);
}

// ── 2. a pre-signature is NOT a valid signature, and is message-bound ──
{
  const d = sc('excess-x'), t = sc('secret-x'), k = sc('nonce-x');
  const msg = sha('msg-A');
  const ps = presign(d, msg, adaptorPoint(t), k);
  // the bare pre-sig (treated as a full sig) does not verify
  assert.strictEqual(verifySchnorr(completedSig(ps.RxPub, ps.sTilde), msg, ps.Px), false, 'the pre-sig alone is not a valid signature');
  // bound to its message
  assert.strictEqual(verifyPresign({ Px: ps.Px, msg32: sha('msg-B'), R: ps.R, T: adaptorPoint(t), sTilde: ps.sTilde }), false, 'pre-sig is message-bound');
  ok('a pre-signature is not a valid signature on its own and is message-bound');
}

// ── 3. a wrong t does not complete to a valid signature under the real verifier ──
{
  const d = sc('excess-w'), t = sc('secret-w'), k = sc('nonce-w');
  const msg = sha('msg-W'), T = adaptorPoint(t);
  const ps = presign(d, msg, T, k);
  const sBad = complete(ps.sTilde, modN(t + 1n), ps.R, T);
  assert.strictEqual(verifySchnorr(completedSig(ps.RxPub, sBad), msg, ps.Px), false, 'completing with the wrong t fails the real verifier');
  ok('a wrong t does not complete to a signature the kernel verifier accepts');
}

// ── 4. shape-indistinguishable from a normal signSchnorr signature (no swap leakage) ──
{
  const d = sc('excess-i'), t = sc('secret-i'), k = sc('nonce-i');
  const msg = sha('msg-I'), T = adaptorPoint(t);
  const { d: dEven, Px } = evenSigningKey(d);
  const ps = presign(d, msg, T, k);
  const adaptorSig = completedSig(ps.RxPub, complete(ps.sTilde, t, ps.R, T));
  const plainSig = signSchnorr(msg, bigintToBytes32(dEven)); // a normal kernel sig under the same key
  assert.strictEqual(adaptorSig.length, 64, 'adaptor sig is 64 bytes');
  assert.strictEqual(plainSig.length, 64, 'plain sig is 64 bytes');
  assert.strictEqual(verifySchnorr(adaptorSig, msg, Px), true, 'adaptor sig verifies');
  assert.strictEqual(verifySchnorr(plainSig, msg, Px), true, 'plain sig verifies under the same key');
  ok('a completed adaptor sig is shape-indistinguishable from a normal kernel signature');
}

// ── 5. the swap: two legs share T — completing leg 2 reveals t, which completes leg 1 ──
{
  const dA = sc('alice-excess'), dB = sc('bob-excess'), t = sc('swap-t');
  const T = adaptorPoint(t);
  const mBtc = sha('Bitcoin leg: Alice X_btc -> Bob');
  const mEth = sha('Ethereum leg: Bob X_eth -> Alice');
  const legBtc = presign(dA, mBtc, T, sc('kA')); // Alice pre-signs her note → Bob, locked to T
  const legEth = presign(dB, mEth, T, sc('kB')); // Bob pre-signs his note → Alice, same T
  assert.ok(legBtc.T.equals(legEth.T), 'both legs locked to the same adaptor point T');

  // Alice (knows t) claims the Ethereum leg → publishes a sig the real verifier accepts
  const sEth = complete(legEth.sTilde, t, legEth.R, T);
  assert.strictEqual(verifySchnorr(completedSig(legEth.RxPub, sEth), mEth, legEth.Px), true, 'Alice claims the Ethereum leg (verifySchnorr)');

  // Bob extracts t from the published sig and completes the Bitcoin leg
  const tSeen = extract(legEth.sTilde, sEth, legEth.R, T);
  assert.strictEqual(tSeen, modN(t), 'Bob recovers t from the Ethereum-leg signature');
  const sBtc = complete(legBtc.sTilde, tSeen, legBtc.R, T);
  assert.strictEqual(verifySchnorr(completedSig(legBtc.RxPub, sBtc), mBtc, legBtc.Px), true, 'Bob completes the Bitcoin leg with the revealed t (verifySchnorr)');
  ok('the two-leg swap round-trips through the real kernel verifier: claim leg 2 → reveal t → complete leg 1');
}

console.log(`\n${n}/5 BIP-340-faithful adaptor-signature checks passed`);
