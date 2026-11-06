// What the points service's liquidity campaign pays for liquidity in a pool of TACD or TACE, as it applies it (worker-relay/src/lib/points-lp.js): each UTC day's
// pot is shared between the weighted dollars held, and no dollar is paid more than the cap. The pools it pays for are matched to a vault by the two tokens each trades.
import { batchReads } from './batch.js';
export const POINTS = 'https://tacit-points.onrender.com';
const WAD = 10n ** 18n, BPS = 10000n;
const TOKEN0 = '0x0dfe1681', TOKEN1 = '0xd21220a7', SQRT_NOW = '0x2af1f249', SQRT_LOW = '0x5c5ac485', SQRT_HIGH = '0x87e43840';

// TAC a day that one dollar of liquidity earns in a pool of weight 1, from the campaign's reading (its /lp), and the pools it pays for.
// Null when the campaign is off, has not started, or has ended.
export function campaignRate(lp, nowSec = Date.now() / 1000) {
  const t = lp?.enabled && nowSec < (Number(lp.endSec) || Infinity) ? lp.terms : null;
  if (t?.dailyWei == null || t.capWeiPerUsdDay == null) return null;
  const pools = (lp.pools || []).map((p) => ({ pool: String(p.pool).toLowerCase(), weight: BigInt(p.weightBps), usd: BigInt(p.valueUsdWei || 0) }));
  const total = pools.reduce((s, p) => s + p.usd * p.weight / BPS, 0n), cap = BigInt(t.capWeiPerUsdDay);
  const share = total > 0n ? BigInt(t.dailyWei) * WAD / total : cap;
  return { perUsd: Number(share < cap ? share : cap) / 1e18, pools };
}

// A year of that, at TAC's price in dollars, for a dollar held in a pool of the given weight, in percent.
export const campaignApr = (perUsd, weight, tacUsd) => (tacUsd > 0 ? perUsd * Number(weight) / Number(BPS) * tacUsd * 365 * 100 : null);

const addrOf = (hex) => `0x${String(hex).slice(-40).toLowerCase()}`;

// The campaign as it stands, with the weights of the pools that trade each vault's token: { perUsd, weights: { usd: [bigint, …], eth: […] }, idle: { usd: […], eth: […] } },
// or null when it pays nothing now. A pool whose price sits outside its band is not trading, so a deposit there is not offered: its weight is in `idle`, not in `weights`
// (a band that could not be read leaves the pool in `weights`). `synths` is { usd: <TACD>, eth: <TACE> } and `ethCall(to, data)` reads Ethereum.
export async function readCampaign({ ethCall, synths }) {
  const lp = await fetch(`${POINTS}/lp`, { signal: AbortSignal.timeout(8e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const rate = campaignRate(lp);
  if (!rate) return null;
  const synth = Object.fromEntries(Object.entries(synths).map(([k, a]) => [k, String(a).toLowerCase()])), lists = () => Object.fromEntries(Object.keys(synth).map((k) => [k, []]));
  const weights = lists(), idle = lists();
  // the five reads of every pool go out as one Multicall3 call (a pool whose read fails in the batch is asked alone, so its failure stays its own)
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

// A vault whose campaign pools are all outside their bands: none of them takes a deposit now.
export const notTrading = (campaign, key) => !campaign?.weights?.[key]?.length && !!campaign?.idle?.[key]?.length;

// The most a dollar of liquidity in any of that vault's pools earns now, in percent a year at TAC's price in dollars; null when there is nothing to say.
export function bestApr(campaign, key, tacUsd) {
  const aprs = (campaign?.weights?.[key] || []).map((w) => campaignApr(campaign.perUsd, w, tacUsd)).filter((x) => x != null);
  return aprs.length ? Math.max(...aprs) : null;
}
