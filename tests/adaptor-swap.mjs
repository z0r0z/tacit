#!/usr/bin/env node
// Confidential cross-chain adaptor swap orchestration (ops/PLAN-confidential-adaptor-swap.md phase 4).
// Drives the full protocol over the BIP-340-faithful adaptor primitive and checks both completed legs
// against the REAL kernel verifier (verifySchnorr): the happy path (lock → verify → claim reveals t →
// counterclaim), the refund path (initiator never claims), and the safety rejections (deadline
// ordering; a tampered pre-sig fails verification before a leg is committed).
//
// Run: node tests/adaptor-swap.mjs

import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { verifySchnorr, modN } from '../dapp/bulletproofs.js';
import { makeAdaptorSwap } from '../dapp/adaptor-swap.js';

const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const sc = (tag) => modN(BigInt('0x' + Buffer.from(sha(tag)).toString('hex'))) || 1n;
const swap = makeAdaptorSwap();
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// shared legs: initiator owns dI (asset → responder), responder owns dR (asset → initiator)
const dI = sc('initiator-excess'), dR = sc('responder-excess'), t = sc('swap-secret');
const mI = sha('leg I: initiator X -> responder'); // claimed by responder (farDeadline)
const mR = sha('leg R: responder Y -> initiator'); // claimed by initiator (nearDeadline)

// ── 1. happy path: lock → verify → claim reveals t → counterclaim; both legs pass verifySchnorr ──
{
  const ctx = swap.open({ t, nearDeadline: 100, farDeadline: 200 });
  const li = swap.lock(ctx, 'initiator', { dPriv: dI, msg32: mI, nonce: sc('kI') });
  const lr = swap.lock(ctx, 'responder', { dPriv: dR, msg32: mR, nonce: sc('kR') });
  assert.strictEqual(ctx.state, 'LOCKED', 'both legs locked');
  assert.strictEqual(swap.verify(ctx, 'initiator'), true, 'responder verifies the initiator leg');
  assert.strictEqual(swap.verify(ctx, 'responder'), true, 'initiator verifies the responder leg');
  assert.strictEqual(swap.ready(ctx), true, 'swap ready');

  // initiator claims the responder leg (reveals t)
  const { sig: sigR, s: claimS } = swap.claim(ctx);
  assert.strictEqual(verifySchnorr(sigR, mR, lr.Px), true, 'the initiator-claim signature verifies (real kernel verifier)');
  assert.strictEqual(ctx.state, 'CLAIMED', 'state CLAIMED');

  // responder extracts t and completes the initiator leg
  const { t: tSeen, sig: sigI } = swap.counterclaim(ctx, claimS);
  assert.strictEqual(tSeen, modN(t), 'responder recovers t');
  assert.strictEqual(verifySchnorr(sigI, mI, li.Px), true, 'the responder-counterclaim signature verifies (real kernel verifier)');
  assert.strictEqual(ctx.state, 'SETTLED', 'state SETTLED');
  ok('happy path: lock → verify → claim (reveals t) → counterclaim; both completed legs pass verifySchnorr');
}

// ── 2. refund path: the initiator never claims → both legs refund after their deadlines ──
{
  const ctx = swap.open({ t, nearDeadline: 100, farDeadline: 200 });
  swap.lock(ctx, 'initiator', { dPriv: dI, msg32: mI, nonce: sc('kI2') });
  swap.lock(ctx, 'responder', { dPriv: dR, msg32: mR, nonce: sc('kR2') });
  // before deadlines: nothing refundable
  assert.strictEqual(swap.responderLegRefundable(ctx, 50), false, 'responder leg not refundable before nearDeadline');
  assert.strictEqual(swap.initiatorLegRefundable(ctx, 150), false, 'initiator leg not refundable before farDeadline');
  // after nearDeadline (no claim): the responder reclaims its leg; after farDeadline the initiator reclaims its leg
  assert.strictEqual(swap.responderLegRefundable(ctx, 100), true, 'responder leg refundable at nearDeadline (no claim)');
  assert.strictEqual(swap.initiatorLegRefundable(ctx, 200), true, 'initiator leg refundable at farDeadline');
  ok('refund path: with no claim, the responder leg refunds at nearDeadline and the initiator leg at farDeadline');
}

// ── 3. once the initiator has claimed, the responder leg is NOT refundable (the value moved) ──
{
  const ctx = swap.open({ t, nearDeadline: 100, farDeadline: 200 });
  swap.lock(ctx, 'initiator', { dPriv: dI, msg32: mI, nonce: sc('kI3') });
  swap.lock(ctx, 'responder', { dPriv: dR, msg32: mR, nonce: sc('kR3') });
  swap.claim(ctx);
  assert.strictEqual(swap.responderLegRefundable(ctx, 100), false, 'a claimed responder leg cannot also refund');
  ok('a claimed leg cannot also refund (no double-settle)');
}

// ── 4. safety rejections: deadline ordering + a tampered pre-sig caught before committing ──
{
  assert.throws(() => swap.open({ t, nearDeadline: 200, farDeadline: 100 }), /farDeadline must exceed/, 'rejects far <= near');
  const ctx = swap.open({ t, nearDeadline: 100, farDeadline: 200 });
  const lr = swap.lock(ctx, 'responder', { dPriv: dR, msg32: mR, nonce: sc('kR4') });
  // tamper the pre-sig → verify must fail (the counterparty would NOT lock its own leg)
  ctx.legs.responder = { ...lr, sTilde: modN(lr.sTilde + 1n) };
  assert.strictEqual(swap.verify(ctx, 'responder'), false, 'a tampered pre-sig fails verification before the other leg is committed');
  ok('safety: deadline ordering enforced + a tampered pre-sig is caught before committing the counter-leg');
}

console.log(`\n${n}/4 adaptor-swap orchestration checks passed`);
