// Confidential cross-chain adaptor swap — the protocol orchestration (ops/PLAN-confidential-adaptor-swap.md
// phase 4) over the BIP-340-faithful adaptor primitive (dapp/adaptor-signature.js). A state machine that
// sequences the two legs and enforces the safety invariants; the LEG CONSTRUCTION (the real kernel sig
// over a transfer — the EVM OP_ADAPTOR op / the Bitcoin adaptor CXFER, phases 2-3) is abstracted behind
// the (dPriv, msg32, nonce) a caller supplies, so this is testable now and the guest/envelope builders
// plug in later.
//
// Roles + timeout ordering (the load-bearing invariant): the INITIATOR holds the secret t and claims
// FIRST (revealing t); the RESPONDER claims SECOND (after seeing t). So the responder's window must be
// LONGER — the leg the responder claims (the initiator's leg) refunds at `farDeadline`, the leg the
// initiator claims (the responder's leg) refunds at `nearDeadline`, and `farDeadline > nearDeadline`.
// If the initiator never claims, both legs refund and each party keeps its own.

import * as defaultAdaptor from './adaptor-signature.js';

export function makeAdaptorSwap({ adaptor = defaultAdaptor } = {}) {
  // Open a swap: the initiator picks t (→ adaptor point T) and the two deadlines (far > near).
  function open({ t, nearDeadline, farDeadline }) {
    if (!(farDeadline > nearDeadline)) throw new Error('adaptor-swap: farDeadline must exceed nearDeadline');
    return { t, T: adaptor.adaptorPoint(t), nearDeadline, farDeadline, state: 'OPEN', legs: {} };
  }

  // A party locks its leg: pre-sign the leg's kernel message under the leg owner's excess scalar,
  // locked to T. `role` ∈ {'initiator','responder'}. Returns the pre-sig the counterparty verifies.
  function lock(ctx, role, { dPriv, msg32, nonce }) {
    if (role !== 'initiator' && role !== 'responder') throw new Error('adaptor-swap: bad role');
    const ps = adaptor.presign(dPriv, msg32, ctx.T, nonce);
    ctx.legs[role] = { RxPub: ps.RxPub, Px: ps.Px, R: ps.R, sTilde: ps.sTilde, msg32 };
    if (ctx.legs.initiator && ctx.legs.responder) ctx.state = 'LOCKED';
    return ctx.legs[role];
  }

  // Verify a counterparty's locked leg BEFORE committing your own (the pre-sig completes to a valid
  // signature once t is known). Returns false on a tampered/invalid pre-sig.
  function verify(ctx, role) {
    const l = ctx.legs[role];
    return !!l && adaptor.verifyPresign({ Px: l.Px, msg32: l.msg32, R: l.R, T: ctx.T, sTilde: l.sTilde });
  }
  const ready = (ctx) => ctx.state === 'LOCKED' && verify(ctx, 'initiator') && verify(ctx, 'responder');

  // The initiator (holding t) claims the RESPONDER's leg → a completed signature that REVEALS t. Must
  // land before `nearDeadline`. Returns { sig, s } (sig = the 64-byte kernel signature to broadcast).
  function claim(ctx) {
    if (!ready(ctx)) throw new Error('adaptor-swap: both legs must be locked + verified before claim');
    const l = ctx.legs.responder;
    const s = adaptor.complete(l.sTilde, ctx.t, l.R, ctx.T);
    ctx.state = 'CLAIMED';
    return { sig: adaptor.completedSig(l.RxPub, s), s };
  }

  // The responder reads the initiator's claim signature scalar `s`, extracts t, and completes the
  // INITIATOR's leg. Must land before `farDeadline`. Returns { t, sig }.
  function counterclaim(ctx, claimS) {
    const r = ctx.legs.responder, i = ctx.legs.initiator;
    const t = adaptor.extract(r.sTilde, claimS, r.R, ctx.T);
    const s = adaptor.complete(i.sTilde, t, i.R, ctx.T);
    ctx.state = 'SETTLED';
    return { t, sig: adaptor.completedSig(i.RxPub, s) };
  }

  // Refund predicates (the on-chain settlement enforces the actual timeout; these gate the dapp's
  // refund action). The responder's leg refunds to the responder after `nearDeadline` if the initiator
  // never claimed; the initiator's leg refunds to the initiator after `farDeadline`.
  const responderLegRefundable = (ctx, nowTs) => ctx.state !== 'CLAIMED' && ctx.state !== 'SETTLED' && nowTs >= ctx.nearDeadline;
  const initiatorLegRefundable = (ctx, nowTs) => ctx.state !== 'SETTLED' && nowTs >= ctx.farDeadline;

  return { open, lock, verify, ready, claim, counterclaim, responderLegRefundable, initiatorLegRefundable };
}
