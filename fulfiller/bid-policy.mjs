// Pure policy gate for the buyer-side watchtower.
//
// Decides whether a single seller fill (one atomic-intent record) is allowed by
// the buyer's resting-bid policy: unit price within the ceiling and the
// cumulative fill within the cap. Kept side-effect-free and dependency-free so
// it can be applied twice — once cheaply against the list record (pre-filter)
// and once authoritatively against the record actually being settled — and so
// the soundness logic is unit-testable apart from the daemon's I/O.
//
// `rec` carries `amount` (BASE units, integer-ish) and `price_sats` (whole-fill
// price). The unit price is price_sats / (amount / 10^decimals).
export function evalBidPolicy(rec, { maxUnitPriceSats, decimals, maxTotalFillBase, filledBase }) {
  let amt, price;
  try { amt = BigInt(rec.amount); price = Number(rec.price_sats); }
  catch { return { ok: false, reason: 'unparseable amount/price' }; }
  if (amt <= 0n || !Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: 'non-positive amount/price' };
  }
  const whole = Number(amt) / Math.pow(10, decimals);
  const unit = whole > 0 ? price / whole : Infinity;
  if (unit > maxUnitPriceSats) {
    return { ok: false, reason: `unit price ${unit.toFixed(2)} > cap ${maxUnitPriceSats}` };
  }
  if (maxTotalFillBase > 0n && filledBase + amt > maxTotalFillBase) {
    return { ok: false, reason: `would exceed max_total_fill (${filledBase + amt} > ${maxTotalFillBase})` };
  }
  return { ok: true, amt, price };
}
