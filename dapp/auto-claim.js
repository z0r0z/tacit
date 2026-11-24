// Payments sent to a key are claimed for it when the key is open, without a press.
//
// A payment to someone's `tacit1…` address is a stealth lock: the owner has to claim it, because the claim is where the owner's own spend key is chosen (a sender who
// built the note would know it: docs/BUILD-A-TACIT-DAPP.md, "You cannot send a note directly to someone else"). The claim goes through the relay, and the relay's fee
// comes out of the payment. This decides which locks the page claims unasked: those the claim costs nothing of (the key proves on its own device, or the lock is liquidity
// shares, which carry no relay fee) and those the fee takes a small share of. A payment the fee takes much of is left to the person, with the Claim button and the wording
// that was always there.

// The most of a payment, in percent, that the relay's fee may be for it to be claimed unasked. (A relay that has moved its floor can ask double the fee once
// (sheets.js settleLocks), so this is half of the most a claim can take.)
export const AUTO_CLAIM_SHARE = 15;
// The most payments one sitting claims unasked; the rest wait for the Claim button.
export const AUTO_CLAIM_MAX = 4;
// localStorage: 'off' turns automatic claiming off in this browser.
export const AUTO_CLAIM_KEY = 'tacit-auto-claim-v1';

// `read(key)` gives what the browser holds for a key (it may throw: a private window has no storage).
export const autoClaimOff = (read) => { try { return read(AUTO_CLAIM_KEY) === 'off'; } catch { return false; } };
// The wallet sheet's switch: 'off' kept in the browser's storage, or taken away. false when the browser would not keep it (a private window has no storage; `store` may be null).
export function autoClaimSet(store, off) {
  try { if (off) store.setItem(AUTO_CLAIM_KEY, 'off'); else store.removeItem(AUTO_CLAIM_KEY); return true; } catch { return false; }
}
// Whether the note of a payment claimed unasked should also say that claiming is automatic and where to stop it: the first time in this browser, never again (and never
// where the browser keeps nothing, which would repeat it every time).
export const AUTO_CLAIM_TOLD = 'tacit-auto-claim-told-v1';
export function autoClaimHint(store) {
  try { if (store.getItem(AUTO_CLAIM_TOLD)) return false; store.setItem(AUTO_CLAIM_TOLD, '1'); return true; } catch { return false; }
}

const key = (l) => String(l.leaf).toLowerCase();

// Whether the relay's fee takes more of a payment than the share that is claimed unasked (`fee` in the payment's own units, null when not known). A fee that is the whole
// payment or more is not offered at all, so it is not held here; one that is not known is not said.
export function autoClaimHeldByFee(amount, fee, share = AUTO_CLAIM_SHARE) {
  if (fee == null) return false;
  const a = BigInt(amount), f = BigInt(fee);
  return a > 0n && f < a && f * 100n > a * BigInt(share);
}
// The fee as a share of the payment, in whole percent for a banner: the nearest, but never the limit itself for a payment it holds back ('15%' beside a limit of 15%).
export function autoClaimFeeShare(amount, fee, share = AUTO_CLAIM_SHARE) {
  const a = BigInt(amount), f = BigInt(fee);
  return a > 0n ? Math.max(Math.round(Number((f * 10000n) / a) / 100), share + 1) : 0;
}

// Which of `locks` ([{ leaf, amount, asset, deadline }], those offered to claim) to claim now.
//   fee(lock)   the relay's fee for it in the lock's own units: 0n where the claim costs nothing, null where it is not known
//   tried       leaves already tried in this sitting (a failed one is left to the Claim button, never run again unasked)
// → { claim: [locks, the soonest to lapse first], held: [{ lock, why }] } with why 'tried' | 'unknown' | 'small' (the fee is the whole payment or more) | 'fee' (over the
// share) | 'limit' (past the most one sitting claims).
export function autoClaimPick({ locks, fee, tried = new Set(), max = AUTO_CLAIM_MAX, share = AUTO_CLAIM_SHARE }) {
  const claim = [], held = [];
  const byDeadline = [...locks].sort((a, b) => { const x = BigInt(a.deadline), y = BigInt(b.deadline); return x < y ? -1 : x > y ? 1 : 0; });
  for (const l of byDeadline) {
    const f = fee(l), amount = BigInt(l.amount);
    if (tried.has(key(l))) held.push({ lock: l, why: 'tried' });
    else if (f == null) held.push({ lock: l, why: 'unknown' });
    else if (BigInt(f) >= amount) held.push({ lock: l, why: 'small' });
    else if (autoClaimHeldByFee(amount, f, share)) held.push({ lock: l, why: 'fee' });
    else if (claim.length >= max) held.push({ lock: l, why: 'limit' });
    else claim.push(l);
  }
  return { claim, held };
}
