
export const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E', FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0';
const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const wordOf = (a) => a.slice(2).toLowerCase().padStart(64, '0');

export const aprFrom = (tacPerDay, stakedEth, tacEth) => (stakedEth > 0 && tacEth ? tacPerDay * 365 * tacEth / stakedEth * 100 : null);

export function poolWorthEth(pool, tacEth, px = {}) {
  const r = pool?.reserves || {};
  if (String(r.assetA).toLowerCase() !== CETH) return null;
  const a = Number(r.reserveA) / 1e8, b = Number(r.reserveB) / 1e8, other = String(pool.pair || '').split('/').find((k) => k !== 'cETH');
  const unit = other === 'TAC' ? tacEth : other === 'cUSD' ? (px.ethUsd > 0 ? 1 / px.ethUsd : 0) : other === 'cBTC' ? (px.ethUsd > 0 && px.btcUsd > 0 ? px.btcUsd / px.ethUsd : 0) : 0;
  return unit > 0 ? a + b * unit : 2 * a;
}

export function shieldedApr(pool, tacEth, px) {
  const r = pool.reserves || {}, total = Number(r.lpTotalShares || 0), worth = poolWorthEth(pool, tacEth, px);
  if (worth == null || !total) return null;
  return aprFrom(Number(pool.tacPerDayForPool), worth * Number(pool.totalShares) / total, tacEth);
}

const CHAINLINK = { ethUsd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', btcUsd: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' };
export async function readSpot(batch) {
  const r = await batch([CHAINLINK.ethUsd, CHAINLINK.btcUsd].map((to) => ({ to, data: '0xfeaf968c' }))).catch(() => []);
  const fresh = (x) => {
    const h = String(x || '').replace(/^0x/, '');
    if (h.length < 64 * 5) return null;
    const w = (i) => BigInt(`0x${h.slice(i * 64, (i + 1) * 64)}`);
    return w(1) > 0n && w(3) > BigInt(Math.floor(Date.now() / 1000) - 6 * 3600) ? Number(w(1)) / 1e8 : null;
  };
  return { ethUsd: fresh(r?.[0]), btcUsd: fresh(r?.[1]) };
}

export const aprText = (a) => (a == null ? '' : a >= 100000 ? 'over 100,000%' : a >= 100 ? `${Math.round(a).toLocaleString('en-US')}%` : `${a.toFixed(1)}%`);

export async function readPrecision(call) {
  const farm = await Promise.all([[POOL, '0x443cb4bc'], [POOL, '0x5a76f25e'], [POOL, '0x18160ddd'], [POOL, '0x2af1f249'], [FARM, '0x817b1cd2'], [FARM, '0x7b0a47ee'], [FARM, '0xebe2b12b']]
    .map(([to, data]) => call({ to, data }).then(BigInt))).catch(() => null);
  if (!farm) return null;
  const [r0, r1, supply, sp, totalStaked, rate, finish] = farm;
  const sq = Number(sp) / 1e18, tacEth = sq > 0 ? 1 / (sq * sq) : 0;
  const live = tacEth > 0 && Date.now() / 1000 < Number(finish);
  const stakedEth = supply > 0n ? (Number(r0) + Number(r1) * tacEth) * Number(totalStaked) / Number(supply) : 0;
  return { r0, r1, supply, tacEth, live, finish: Number(finish), perDay: live ? rate * 86400n : 0n, stakedEth, apr: live ? aprFrom(Number(rate) * 86400 / 1e18, stakedEth / 1e18, tacEth) : null };
}

export async function readStake(call, who, f) {
  const m = await Promise.all([[FARM, '0x98807d84'], [FARM, '0x008cc262'], [POOL, '0x70a08231']].map(([to, sel]) => call({ to, data: `${sel}${wordOf(who)}` }).then(BigInt))).catch(() => null);
  if (!m) return null;
  const [staked, earned, loose] = m, ok = f && f.supply > 0n;
  return { staked, earned, loose, eth: ok ? staked * f.r0 / f.supply : 0n, tac: ok ? staked * f.r1 / f.supply : 0n };
}

export function privateFarms(program, tacEth, px) {
  if (!program?.epoch?.active) return [];
  return (program.pools || []).filter((p) => Number(p.tacPerDayForPool) > 0).map((p) => {
    const k = String(p.pair).split('/').map((x) => (x === 'cETH' ? 'tETH' : x));
    if (k[1] === 'tETH') k.reverse();
    return { pid: Number(p.pid), name: k.join(' / '), icons: k.map((x) => x.toLowerCase()), perDay: Number(p.tacPerDayForPool), apr: shieldedApr(p, tacEth, px) };
  });
}
