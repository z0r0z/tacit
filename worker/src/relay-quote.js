// Gas-priced relay-fee quote + profitability guard for the Tacit confidential relayer.
//
// The relay fee a user offers is BOUND in their proof (opening sigma / kernel), so a relayer can't change it
// at settle time — it can only choose whether to settle. Competition therefore lives at the QUOTE level: the
// dapp asks the relayer what fee to bake into the proof. The optimal quote is GAS-PRICED, not bps-of-value —
// a settle costs ~fixed gas regardless of note size, so `fee = settleGas × gasPrice × (1 + margin)`, converted
// into the fee asset. A bps fee overcharges whales and undercharges dust; the gas-priced floor undercuts both,
// which is exactly how the initial relayer competes (set margin low/zero) and how an open market clears.
//
// Pure functions (no I/O) so they're byte-identical in the worker, the box loop, the dapp quote, and tests.

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
// burning a GPU prove cycle. Returns [{ value }] (asset omitted where the witness doesn't carry it; the box
// maps each op's natural fee asset). The fee-less-by-design ops return [].
export function feeLegsOf(type, op) {
  const v = (x) => BigInt(x ?? 0n);
  switch (type) {
    case 'swap':
      return (op.intents || []).map((it) => ({ value: v(it.fee) })).filter((x) => x.value > 0n);
    case 'otc':
      return [{ value: v(op.feeA) }, { value: v(op.feeB) }].filter((x) => x.value > 0n);
    // fee-less by design (value-locking / on-ramp / pre-committed destination / t-reveal)
    case 'wrap': case 'bridgemint': case 'cbtcmint': case 'farmbond':
    case 'adaptorlock': case 'adaptorclaim': case 'cdptopup': case 'stealthlock':
    case 'bridgestealthmint':
      return [];
    // single fee leg: transfer/route/lp/bid/unwrap/bridgeburn/adaptorrefund/cdpmint/cdpclose/cdpliquidate/farmharvest/farmunbond
    default:
      return v(op.fee) > 0n ? [{ value: v(op.fee) }] : [];
  }
}

// Total declared fee value across legs (naive sum; the box refines per-asset with weiPerFeeUnit). 0 ⇒ a
// self-settle / subsidy candidate.
export function totalFee(type, op) {
  return feeLegsOf(type, op).reduce((s, x) => s + x.value, 0n);
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
