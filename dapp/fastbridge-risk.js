// Opt-in TAC/TAC pricing. All amounts are integer base units.
const SCALE = 10000n;
const classes = ['clean', 'long', 'poolExit'];
export const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const isTac = (asset) => typeof asset === "string" && asset.replace(/^0x/i, "").toLowerCase() === TAC;
const ceil = (n, d) => (n + d - 1n) / d;
export function riskConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('risk config required');
  const result = {};
  for (const k of classes) {
    const v = raw[k];
    if (!Number.isInteger(v) || v < 0 || v >= 10000) throw new Error(`invalid ${k} haircut`);
    result[k] = v;
  }
  if (result.long < result.clean || result.poolExit < result.clean) throw new Error('stuck haircut below clean');
  if (!Number.isInteger(raw.maxTotalBps) || raw.maxTotalBps < Math.max(...classes.map(k => result[k])) || raw.maxTotalBps >= 10000) throw new Error('invalid fee ceiling');
  result.maxTotalBps = raw.maxTotalBps;
  return Object.freeze(result);
}
export function riskBps(cfg, kind) {
  if (kind === undefined) return Math.max(...classes.map(k => cfg[k]));
  if (!classes.includes(kind)) throw Object.assign(new Error('unknown TAC risk class'), {status:400});
  return cfg[kind];
}
export function riskFee(amount, baseBps, flat, cfg, kind) {
  const a = BigInt(amount), b = BigInt(baseBps), f = BigInt(flat);
  const surcharge = BigInt(riskBps(cfg, kind));
  if (a <= 0n || b < 0n || f < 0n) throw new Error('invalid amount or fee');
  const fee = ceil(a * (b + surcharge), SCALE) + f;
  if (fee >= a || fee * SCALE > a * BigInt(cfg.maxTotalBps)) throw Object.assign(new Error('risk fee exceeds configured ceiling'), {status:400});
  return fee;
}
export function classify(v) {
  if (v?.state === 'tracked') return 'clean';
  // Reserve two transfers for the lock and subsequent claim.
  if (v?.state === 'traced' && Number.isInteger(v.hops) && v.hops >= 0) return v.hops <= 253 ? 'clean' : 'long';
  if (v?.state === 'long') return 'long';
  // Upstream groups shielded opcodes 0x6c/0x6d; conservatively price both.
  if (v?.state === 'unprovable' && v.through === 'shielded') return 'poolExit';
  return null;
}
export function makeRiskScreen(vet, raw, baseBps, flat) {
  const cfg = riskConfig(raw);
  return async (inputs, quote) => {
    if (!Array.isArray(inputs) || !inputs.length || !quote || !isTac(quote.btcAsset) || !isTac(quote.evmAsset)) return {why:'risk screen: missing TAC terms or inputs'};
    let verdicts;
    try { verdicts = await vet(inputs); } catch { return {why:'risk screen: lineage unavailable', retry:true}; }
    let highest = 'clean';
    for (const n of inputs) {
      const v = verdicts?.get(`${n.txid}:${n.vout}`), kind = classify(v);
      if (!kind) return {why:'risk screen: unsupported or unread lineage', retry:!v || v.state === 'unread'};
      if (cfg[kind] > cfg[highest]) highest = kind;
    }
    try {
      const a = BigInt(quote.btcValue), out = BigInt(quote.evmAmount);
      const required = riskFee(a, baseBps, flat, cfg, highest);
      if (out <= 0n || out > a || a - out < required || (a-out)*SCALE > a*BigInt(cfg.maxTotalBps)) return {why:'risk screen: quote does not cover verified lineage within fee ceiling'};
      return null;
    } catch { return {why:'risk screen: invalid or out-of-limit quote'}; }
  };
}
