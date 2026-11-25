// Leaning the price toward the flow that refills the side running low. A pair provider prices both directions from one rate (pool ETH per sat). When it holds
// much more of one side than its target share, it moves that rate a few basis points: holding too much ETH, the rate rises (a user who brings BTC gets a little
// more ETH; one who brings ETH gets a little fewer sats), and the other way round. It is a shift of the provider's own mid price, nothing else.
//
// Bounds: at most `maxBps` either way, nothing inside a dead band around the target, and never so far that a quote at the minimum amount, with its fee, would
// stand more than `guardBps` under the market (the pages block a quote 3% under it: fastbridge-pair.js maxWorseBps). A side that is off has no skew.
//
//   skewBps({ ethValueSats, btcSats, cfg, feeAtMinBps: { fwd, rev } }) -> whole basis points, + raises the rate
//   applySkew(rate, bps) -> the rate moved

export const SKEW_DEFAULTS = Object.freeze({ enabled: true, maxBps: 15, targetEthShare: 0.5, deadBand: 0.1, guardBps: 250 });

export function skewConfig(C = {}, env = process.env) {
  const k = { ...SKEW_DEFAULTS, ...((C && typeof C.skew === 'object' && C.skew) || {}) };
  if (C && C.skew === false) k.enabled = false;
  const sw = env.FB_LP_SKEW != null ? String(env.FB_LP_SKEW).trim().toLowerCase() : '';
  if (sw) { if (sw !== 'on' && sw !== 'off') throw new Error(`FB_LP_SKEW must be on or off (got "${env.FB_LP_SKEW}")`); k.enabled = sw === 'on'; }
  const n = (name, v, lo, hi) => { const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`skew.${name} must be from ${lo} to ${hi} (got "${v}")`); return x; };
  return { enabled: k.enabled !== false, maxBps: Math.round(n('maxBps', k.maxBps, 0, 100)), targetEthShare: n('targetEthShare', k.targetEthShare, 0.05, 0.95), deadBand: n('deadBand', k.deadBand, 0, 0.4), guardBps: Math.round(n('guardBps', k.guardBps, 0, 290)) };
}

// what a side's fee is at its minimum amount, in basis points (its share plus its flat part over the minimum)
export const feeAtMinBps = (min, feeBps, flat) => { const m = Number(min); return m > 0 ? Number(feeBps || 0) + (Number(flat || 0) / m) * 10000 : Infinity; };

export function skewBps({ ethValueSats, btcSats, cfg, feeAtMinBps: fam = {} }) {
  if (!cfg || !cfg.enabled || !(cfg.maxBps > 0)) return 0;
  const e = Number(ethValueSats), b = Number(btcSats);
  if (!Number.isFinite(e) || !Number.isFinite(b) || e < 0 || b < 0 || e + b <= 0) return 0;
  const d = e / (e + b) - cfg.targetEthShare, span = Math.max(1e-9, Math.max(cfg.targetEthShare, 1 - cfg.targetEthShare) - cfg.deadBand);
  if (Math.abs(d) <= cfg.deadBand) return 0;
  let bps = Math.round(cfg.maxBps * Math.min(1, (Math.abs(d) - cfg.deadBand) / span));
  // the side the move makes dearer: + (too much ETH) costs the ETH -> BTC user, - costs the BTC -> ETH user. That side's fee at its minimum plus the skew stays under the guard
  const room = Math.max(0, Math.floor(cfg.guardBps - (d > 0 ? fam.rev ?? Infinity : fam.fwd ?? Infinity)));
  bps = Math.min(bps, room);
  return d > 0 ? bps : -bps;
}

export function applySkew(rate, bps) {
  if (!rate || !bps) return rate;
  return { ...rate, num: BigInt(rate.num) * BigInt(10000 + bps), den: BigInt(rate.den) * 10000n };
}
