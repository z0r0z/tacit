// Confidential cross-chain adaptor swap — the protocol orchestration (ops/PLAN-confidential-adaptor-swap.md
// phase 4) over the adaptor primitives in dapp/adaptor-signature.js. Each leg has a lane: 'bitcoin' (default) locks
// a BIP-340 kernel signature; 'evm' locks the OP_ADAPTOR_CLAIM conservation kernel over (L → O), which the settle
// guest verifies with its keccak kernel transcript, not BIP-340. Both lanes share T = t·G, so either can be the
// leg that reveals t. A state machine that
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

export function makeAdaptorSwap({ adaptor = defaultAdaptor, minDeadlineGap = 0 } = {}) {
  // Open a swap: the initiator picks t (→ adaptor point T) and the two deadlines (far > near).
  // `minGap` is the minimum far−near separation: the responder can only claim the initiator's leg
  // AFTER it observes t (revealed by the initiator's claim of the responder's leg), so the responder's
  // window (up to farDeadline) must exceed the initiator's (up to nearDeadline) by enough confirmation
  // slack to actually land the counterclaim. A too-small gap is the classic adaptor-swap "free option":
  // the initiator claims leg-1 at nearDeadline−ε and the responder cannot land its leg-2 claim in time.
  function open({ t, nearDeadline, farDeadline, minGap = minDeadlineGap }) {
    if (!(farDeadline > nearDeadline)) throw new Error('adaptor-swap: farDeadline must exceed nearDeadline');
    if (minGap > 0 && (farDeadline - nearDeadline) < minGap) {
      throw new Error('adaptor-swap: far/near gap below minimum confirmation buffer');
    }
    return { t, T: adaptor.adaptorPoint(t), nearDeadline, farDeadline, state: 'OPEN', legs: {}, _nonces: new Set() };
  }

  // A party locks its leg: pre-sign the leg's kernel message under the leg owner's excess scalar,
  // locked to T. `role` ∈ {'initiator','responder'}. Returns the pre-sig the counterparty verifies.
  // `nonce` is optional: when omitted a fresh per-leg nonce is derived deterministically (the safe
  // default — see adaptor-signature.deriveNonce). Either way, nonce reuse across the two legs is
  // rejected, since a reused (d, nonce) leaks the leg's excess scalar.
  // An EVM leg passes { lane: 'evm', excess, inC: [L], outC: [O], nonce? } instead of (dPriv, msg32): `excess` is
  // r_L − r_O, and the completed leg is the claim kernel { R, z } rather than a 64-byte signature.
  function lock(ctx, role, { lane = 'bitcoin', dPriv, msg32, nonce, excess, inC, outC }) {
    if (role !== 'initiator' && role !== 'responder') throw new Error('adaptor-swap: bad role');
    if (lane !== 'bitcoin' && lane !== 'evm') throw new Error('adaptor-swap: lane must be bitcoin or evm');
    if (lane === 'evm') {
      if (excess == null || !Array.isArray(inC) || !Array.isArray(outC)) throw new Error('adaptor-swap: an evm leg needs excess, inC and outC (the claim kernel), not a BIP-340 message');
      const k = nonce != null ? nonce : adaptor.evmKernelNonce({ excess, inC, outC, T: ctx.T });
      ctx._nonces = ctx._nonces || new Set();
      if (ctx._nonces.has(String(k))) throw new Error('adaptor-swap: nonce reuse across legs leaks the excess key');
      ctx._nonces.add(String(k));
      const ps = adaptor.evmKernelPresign({ excess, inC, outC, T: ctx.T, nonce: k });
      ctx.legs[role] = { lane, R: ps.R, sTilde: ps.sTilde, inC, outC };
      if (ctx.legs.initiator && ctx.legs.responder) ctx.state = 'LOCKED';
      return ctx.legs[role];
    }
    const k = nonce != null ? nonce : adaptor.deriveNonce(dPriv, msg32, ctx.T);
    ctx._nonces = ctx._nonces || new Set();
    const nkey = String(k);
    if (ctx._nonces.has(nkey)) throw new Error('adaptor-swap: nonce reuse across legs leaks the excess key');
    ctx._nonces.add(nkey);
    const ps = adaptor.presign(dPriv, msg32, ctx.T, k);
    ctx.legs[role] = { lane, RxPub: ps.RxPub, Px: ps.Px, R: ps.R, sTilde: ps.sTilde, msg32 };
    if (ctx.legs.initiator && ctx.legs.responder) ctx.state = 'LOCKED';
    return ctx.legs[role];
  }

  // Verify a counterparty's locked leg BEFORE committing your own (the pre-sig completes to a valid
  // signature once t is known). Returns false on a tampered/invalid pre-sig.
  function verify(ctx, role) {
    const l = ctx.legs[role];
    if (!l) return false;
    if (l.lane === 'evm') return adaptor.evmKernelVerifyPresign({ inC: l.inC, outC: l.outC, R: l.R, T: ctx.T, sTilde: l.sTilde });
    return adaptor.verifyPresign({ Px: l.Px, msg32: l.msg32, R: l.R, T: ctx.T, sTilde: l.sTilde });
  }
  const ready = (ctx) => ctx.state === 'LOCKED' && verify(ctx, 'initiator') && verify(ctx, 'responder');

  // The initiator (holding t) claims the RESPONDER's leg → a completed signature that REVEALS t. Must
  // land before `nearDeadline`. Returns { sig, s } (sig = the 64-byte kernel signature to broadcast).
  function claim(ctx) {
    if (!ready(ctx)) throw new Error('adaptor-swap: both legs must be locked + verified before claim');
    const l = ctx.legs.responder;
    ctx.state = 'CLAIMED';
    if (l.lane === 'evm') { const kernel = adaptor.evmKernelComplete({ R: l.R, T: ctx.T, sTilde: l.sTilde }, ctx.t); return { kernel, s: kernel.z }; }
    const s = adaptor.complete(l.sTilde, ctx.t, l.R, ctx.T);
    return { sig: adaptor.completedSig(l.RxPub, s), s };
  }

  // The responder reads the initiator's claim signature scalar `s`, extracts t, and completes the
  // INITIATOR's leg. Must land before `farDeadline`. Returns { t, sig }.
  function counterclaim(ctx, claimS) {
    const r = ctx.legs.responder, i = ctx.legs.initiator;
    const t = r.lane === 'evm' ? adaptor.evmKernelExtract(r.sTilde, claimS) : adaptor.extract(r.sTilde, claimS, r.R, ctx.T);
    ctx.state = 'SETTLED';
    if (i.lane === 'evm') return { t, kernel: adaptor.evmKernelComplete({ R: i.R, T: ctx.T, sTilde: i.sTilde }, t) };
    const s = adaptor.complete(i.sTilde, t, i.R, ctx.T);
    return { t, sig: adaptor.completedSig(i.RxPub, s) };
  }

  // Refund predicates (the on-chain settlement enforces the actual timeout; these gate the dapp's
  // refund action). The responder's leg refunds to the responder after `nearDeadline` if the initiator
  // never claimed; the initiator's leg refunds to the initiator after `farDeadline`.
  const responderLegRefundable = (ctx, nowTs) => ctx.state !== 'CLAIMED' && ctx.state !== 'SETTLED' && nowTs >= ctx.nearDeadline;
  const initiatorLegRefundable = (ctx, nowTs) => ctx.state !== 'SETTLED' && nowTs >= ctx.farDeadline;

  return { open, lock, verify, ready, claim, counterclaim, responderLegRefundable, initiatorLegRefundable };
}
