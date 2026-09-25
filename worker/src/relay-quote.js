// Gas-priced relay-fee quote + profitability guard for the Tacit confidential relayer.
//
// The relay fee a user offers is BOUND in their proof (opening sigma / kernel), so a relayer can't change it
// at settle time — it can only choose whether to settle. Competition therefore lives at the QUOTE level: the
// dapp asks the relayer what fee to bake into the proof. The optimal quote is GAS-PRICED, not bps-of-value —
// a settle costs ~fixed gas regardless of note size, so `fee = settleGas × gasPrice × (1 + margin)`, converted
// into the fee asset. A bps fee overcharges large notes and undercharges dust; the gas-priced floor undercuts
// both, and a relayer competes by setting its margin.
//
// Pure functions (no I/O) so they're byte-identical in the worker, the relayer, the dapp quote, and tests.

// Per-op settle gas. The Groth16 verify dominates (~constant); each public effect (withdrawal / fee leg /
// minted leaf / nullifier) adds a little. Tune to the deployed verifier + chain (these are conservative).
export const SETTLE_GAS = { base: 300000n, perEffect: 30000n };

export function estimateSettleGas(effects = 2n) {
  return SETTLE_GAS.base + SETTLE_GAS.perEffect * BigInt(effects);
}

// The minimum fee in WEI (ETH terms) to cover gas + a margin. marginBps = 0 is break-even (max undercut); to
// run a loss-leader, quote below this and eat the difference (see `isProfitable({ subsidize: true })`).
export function floorWei({ gasPriceWei, effects = 2n, marginBps = 1000n }) {
  const cost = estimateSettleGas(effects) * BigInt(gasPriceWei);
  return cost + (cost * BigInt(marginBps)) / 10000n;
}

// Convert the wei floor into the fee asset's IN-SYSTEM units. `weiPerFeeUnit` = the wei value of ONE in-system
// unit of the fee asset: for cETH @ tacitDecimals 8 that's the unitScale (1e10); for another asset it's
// unitScale × (ETH price of the asset's base unit), from the AMM/oracle. Ceil so the floor always covers gas.
export function floorInFeeUnits({ gasPriceWei, weiPerFeeUnit, effects = 2n, marginBps = 1000n }) {
  const fw = floorWei({ gasPriceWei, effects, marginBps });
  const w = BigInt(weiPerFeeUnit);
  return w <= 0n ? 0n : (fw + w - 1n) / w;
}

// Is a user-offered fee (in the fee asset's in-system units) worth settling? `subsidize` lets the initial
// relayer accept fee = 0 as a loss-leader; a profit-seeking relayer leaves it false.
export function isProfitable({ feeOffered, gasPriceWei, weiPerFeeUnit, effects = 2n, marginBps = 0n, subsidize = false }) {
  const f = BigInt(feeOffered ?? 0n);
  if (f === 0n) return !!subsidize;
  return f * BigInt(weiPerFeeUnit) >= floorWei({ gasPriceWei, effects, marginBps });
}

// Extract the declared relay-fee legs from an op witness, per type — used to gate at submit/claim time BEFORE
// spending a prove cycle. Returns [{ value }] (asset omitted where the witness doesn't carry it; the relayer
// maps each op's natural fee asset). The fee-less-by-design ops return [].
export function feeLegsOf(type, op) {
  const v = (x) => BigInt(x ?? 0n);
  switch (type) {
    case 'swap':
      return (op.intents || []).map((it) => ({ value: v(it.fee) })).filter((x) => x.value > 0n);
    case 'otc':
      return [{ value: v(op.feeA) }, { value: v(op.feeB) }].filter((x) => x.value > 0n);
    // fee-less by design (value-locking / on-ramp / pre-committed destination / t-reveal)
    case 'wrap': case 'cbtcmint': case 'farmbond':
    case 'adaptorlock': case 'adaptorclaim': case 'cdptopup': case 'stealthlock':
    case 'bridgestealthmint':
      return [];
    case 'fastlane':
      return v(op.transfer?.fee) > 0n ? [{ value: v(op.transfer.fee) }] : [];
    // single fee leg: transfer/route/lp/bid/unwrap/bridgeburn/bridgemint/adaptorrefund/cdpmint/cdpclose/cdpliquidate/farmharvest/farmunbond.
    // bridgemint's fee is v_burn - v_out (the destination fixed at burn time opens to the burned value net of
    // it); fee 0 is a self-mint and returns no leg, so it stays on the subsidised path below.
    default:
      return v(op.fee) > 0n ? [{ value: v(op.fee) }] : [];
  }
}

// Total declared fee value across legs (naive sum; the relayer refines per-asset with weiPerFeeUnit). 0 ⇒ a
// self-settle / subsidy candidate.
export function totalFee(type, op) {
  return feeLegsOf(type, op).reduce((s, x) => s + x.value, 0n);
}

// The asset id the (single) fee leg is denominated in, for the op types where that's an unambiguous single
// field — deliberately narrower than feeLegsOf: swap (per-intent, possibly mixed assets) and otc (two
// DISTINCT fee legs, one per side) don't have one answer, so they return null here (a caller like the
// worker's gate should treat null as "can't price this op's fee — pass it through ungated" rather than guess).
export function feeAssetOf(type, op) {
  switch (type) {
    // Verified directly against each builder's own op shape (dapp/confidential-*.js) — every other type
    // (including cdp*/farm*/adaptor*, which likely follow the same `.asset` shape but weren't checked here)
    // deliberately falls through to null rather than guess: wrong here means "pass through ungated", never
    // a wrong rejection, but an unverified guess is still worse than an honest "don't know".
    case 'transfer': case 'unwrap': case 'sendunwrap': case 'bridgeburn':
    case 'bridgemint': // exec-bridgemint.rs: the burned and minted notes share `asset`, and the fee is paid in it
      return op.asset || null;
    case 'lp': case 'lpremove': case 'lpbond':
      return op.assetA || null; // the relay fee is carved from the A side (see quoteLpAdd in confidential-pool-ux.js)
    case 'route':
      return op.asset0 || null; // the route's START asset (the only note the trader actually spends)
    case 'fastlane':
      return op.transfer?.asset || null; // the Bitcoin-homed transfer's fee is carved from its own asset
    default:
      return null; // swap (per-intent) / otc (two legs) / everything else: no single verified answer
  }
}

// A submit-time gate: returns true iff the op's offered fee clears the floor (or is a subsidized self-settle).
// `weiPerFeeUnit` may be a number (single fee asset) or a (legIndex)=>wei function for multi-asset ops.
export function passesFloor({ type, op, gasPriceWei, weiPerFeeUnit, marginBps = 0n, subsidize = false }) {
  const legs = feeLegsOf(type, op);
  if (legs.length === 0) return !!subsidize || type === 'wrap' || type === 'bridgemint' || type === 'cbtcmint'
    || type === 'farmbond' || type === 'adaptorlock' || type === 'adaptorclaim' || type === 'cdptopup'
    || type === 'stealthlock' || type === 'bridgestealthmint';
  const wpu = (i) => BigInt(typeof weiPerFeeUnit === 'function' ? weiPerFeeUnit(i) : weiPerFeeUnit);
  // Every fee leg must individually cover its share; the simplest sound rule is the SUM clears one settle.
  const valueWei = legs.reduce((s, x, i) => s + x.value * wpu(i), 0n);
  return valueWei >= floorWei({ gasPriceWei, effects: BigInt(Math.max(2, legs.length + 1)), marginBps });
}

// ── Pricing a fee asset from a public AMM pool ──
// An asset with no direct feed can still be valued against one that has a feed, through a confidential AMM
// pool pairing the two: the pool's reserves are public (`pools(bytes32)`), and both reserves are in in-pool
// units, so reserveRef / reserveFee is the spot value of one fee unit in reference units without needing the
// fee asset's decimals or scale. Everything here fails closed: an answer that is missing, malformed, shallow
// or out of range is null ("unpriced"), never a guess.

// Defaults, overridable per call. A pool is only trusted when its reference side holds at least
// `minDepthUsd`, and the value is taken `haircutBps` below spot so a nudged pool cannot flatter a fee.
export const AMM_PRICE_DEFAULTS = { minDepthUsd: 2000, haircutBps: 2000 };
const U64_LIMIT = 1n << 64n;

// Decode a `pools(bytes32)` return: (init, assetA, assetB, reserveA, reserveB, feeBps, totalShares, ...).
// Null for a short or malformed answer and for an uninitialized pool.
export function decodePoolState(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  if (h.length < 64 * 7 || !/^[0-9a-fA-F]*$/.test(h)) return null;
  const word = (i) => h.slice(i * 64, i * 64 + 64);
  const big = (i) => BigInt('0x' + word(i));
  if (big(0) === 0n) return null;
  return {
    assetA: '0x' + word(1).toLowerCase(), assetB: '0x' + word(2).toLowerCase(),
    reserveA: big(3), reserveB: big(4), feeBps: Number(big(5)), totalShares: big(6),
  };
}

// USD per in-pool unit of `feeAsset`, read from one pool pairing it with `refAsset` (worth `refUsdPerUnit`
// dollars per in-pool unit). Null unless the pool is exactly that pair, both reserves are live u64 values, it
// has outstanding shares, and its reference side is at least `minDepthUsd` deep.
export function ammUsdPerUnit({ state, feeAsset, refAsset, refUsdPerUnit, minDepthUsd = AMM_PRICE_DEFAULTS.minDepthUsd, haircutBps = AMM_PRICE_DEFAULTS.haircutBps }) {
  try {
    if (!state) return null;
    const ref = Number(refUsdPerUnit);
    if (!Number.isFinite(ref) || ref <= 0) return null;
    const hb = Number(haircutBps);
    if (!Number.isInteger(hb) || hb < 0 || hb >= 10000) return null;
    const minDepth = Number(minDepthUsd);
    if (!Number.isFinite(minDepth) || minDepth <= 0) return null;
    const lc = (x) => String(x || '').toLowerCase();
    const f = lc(feeAsset), r = lc(refAsset);
    if (!f || !r || f === r) return null;
    let rFee, rRef;
    if (lc(state.assetA) === f && lc(state.assetB) === r) { rFee = state.reserveA; rRef = state.reserveB; }
    else if (lc(state.assetA) === r && lc(state.assetB) === f) { rFee = state.reserveB; rRef = state.reserveA; }
    else return null;
    if (typeof rFee !== 'bigint' || typeof rRef !== 'bigint') return null;
    if (rFee <= 0n || rRef <= 0n || rFee >= U64_LIMIT || rRef >= U64_LIMIT) return null;
    if (typeof state.totalShares !== 'bigint' || state.totalShares <= 0n) return null;
    const depthUsd = Number(rRef) * ref;
    if (!Number.isFinite(depthUsd) || depthUsd < minDepth) return null;
    const usd = ((Number(rRef) / Number(rFee)) * ref * (10000 - hb)) / 10000;
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch { return null; }
}

// The value to use across several candidate pools (different reference assets or fee tiers): the LOWEST
// qualifying reading, so a fee is never valued above what every deep enough pool supports. Null when none
// qualifies.
export function ammUsdPerUnitBest({ feeAsset, candidates = [], minDepthUsd, haircutBps }) {
  let best = null;
  for (const c of candidates || []) {
    const v = ammUsdPerUnit({ state: c && c.state, feeAsset, refAsset: c && c.refAsset, refUsdPerUnit: c && c.refUsdPerUnit, minDepthUsd, haircutBps });
    if (v != null && (best == null || v < best)) best = v;
  }
  return best;
}
