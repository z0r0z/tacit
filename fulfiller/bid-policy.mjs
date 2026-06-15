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
  // Exact ceiling check via integer cross-multiplication. `Number(amt)` loses
  // precision past 2^53 and this is the watchtower's only price-soundness
  // gate, so compare in bigint (the float `unit` below is for the message
  // only):  price/(amt/10^d) > cap  ⇔  price·10^d·1e8 > round(cap·1e8)·amt.
  const whole = Number(amt) / Math.pow(10, decimals);
  const unit = whole > 0 ? price / whole : Infinity;
  if (Number.isFinite(maxUnitPriceSats)) {
    const tenPowD = 10n ** BigInt(decimals);
    const capScaled = BigInt(Math.max(0, Math.round(Number(maxUnitPriceSats) * 1e8)));
    if (BigInt(Math.round(price)) * tenPowD * 100000000n > capScaled * amt) {
      return { ok: false, reason: `unit price ${unit.toFixed(2)} > cap ${maxUnitPriceSats}` };
    }
  }
  if (maxTotalFillBase > 0n && filledBase + amt > maxTotalFillBase) {
    return { ok: false, reason: `would exceed max_total_fill (${filledBase + amt} > ${maxTotalFillBase})` };
  }
  return { ok: true, amt, price };
}
