import { batchReads } from './batch.js';
export const POINTS = 'https://tacit-points.onrender.com';
const WAD = 10n ** 18n, BPS = 10000n;
const TOKEN0 = '0x0dfe1681', TOKEN1 = '0xd21220a7', SQRT_NOW = '0x2af1f249', SQRT_LOW = '0x5c5ac485', SQRT_HIGH = '0x87e43840';

export function campaignRate(lp, nowSec = Date.now() / 1000) {
  const t = lp?.enabled && nowSec < (Number(lp.endSec) || Infinity) ? lp.terms : null;
  if (t?.dailyWei == null || t.capWeiPerUsdDay == null) return null;
  const pools = (lp.pools || []).map((p) => ({ pool: String(p.pool).toLowerCase(), weight: BigInt(p.weightBps), usd: BigInt(p.valueUsdWei || 0) }));
  const total = pools.reduce((s, p) => s + p.usd * p.weight / BPS, 0n), cap = BigInt(t.capWeiPerUsdDay);
  const share = total > 0n ? BigInt(t.dailyWei) * WAD / total : cap;
  return { perUsd: Number(share < cap ? share : cap) / 1e18, pools };
}

export const campaignApr = (perUsd, weight, tacUsd) => (tacUsd > 0 ? perUsd * Number(weight) / Number(BPS) * tacUsd * 365 * 100 : null);

const addrOf = (hex) => `0x${String(hex).slice(-40).toLowerCase()}`;

export async function readCampaign({ ethCall, synths }) {
  const lp = await fetch(`${POINTS}/lp`, { signal: AbortSignal.timeout(8e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const rate = campaignRate(lp);
  if (!rate) return null;
  const synth = Object.fromEntries(Object.entries(synths).map(([k, a]) => [k, String(a).toLowerCase()])), lists = () => Object.fromEntries(Object.keys(synth).map((k) => [k, []]));
  const weights = lists(), idle = lists();
  const call = batchReads((tx) => ethCall(tx.to, tx.data)), read = (to, data) => call({ to, data });
  await Promise.all(rate.pools.map(async (p) => {
    const [[a, b], off] = await Promise.all([
      Promise.all([read(p.pool, TOKEN0), read(p.pool, TOKEN1)]).then((r) => r.map(addrOf)).catch(() => []),
      Promise.all([SQRT_NOW, SQRT_LOW, SQRT_HIGH].map((s) => read(p.pool, s).then(BigInt))).then(([now, lo, hi]) => !(now > lo && now < hi)).catch(() => false),
    ]);
    for (const k of Object.keys(synth)) if (a === synth[k] || b === synth[k]) (off ? idle : weights)[k].push(p.weight);
  }));
  return { perUsd: rate.perUsd, weights, idle };
}

export const notTrading = (campaign, key) => !campaign?.weights?.[key]?.length && !!campaign?.idle?.[key]?.length;

export function bestApr(campaign, key, tacUsd) {
  const aprs = (campaign?.weights?.[key] || []).map((w) => campaignApr(campaign.perUsd, w, tacUsd)).filter((x) => x != null);
  return aprs.length ? Math.max(...aprs) : null;
}
