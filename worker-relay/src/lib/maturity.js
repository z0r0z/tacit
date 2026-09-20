// A reflection batch may only be attested once its tip sits at least `confirmations` blocks behind the header
// relay's tip (the pool walks the relay tip back its immutable REFLECTION_CONFIRMATIONS to find the anchor).
export function isMatured(attestedTo, relayTip, confirmations) {
  const to = Number(attestedTo), tip = Number(relayTip), conf = Number(confirmations);
  if (![to, tip, conf].every(Number.isFinite)) return false;
  return to + conf <= tip;
}
