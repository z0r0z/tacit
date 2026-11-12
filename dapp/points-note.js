const KINDS = ['zswapeth', 'wrap', 'evmpooldeposit'];
export function makePointsNote({ read, now = () => Date.now() }) {
  let at = 0, rate = 0, per = {};
  const take = (p, day, a = 'zswapeth') => {
    const w = Number([...(p?.weights || [])].reverse().find((e) => e.fromDay <= day)?.weights?.[a] ?? 1), r = Number(p?.rates?.[a]);
    return Number.isFinite(r) && r > 0 && Number.isFinite(w) && w > 0 ? r * w : 0;
  };
  async function load() {
    if (now() - at < 600e3) return rate;
    at = now();
    try {
      const j = await read();
      if (j?.program) { const day = Math.floor(now() / 86400e3); per = Object.fromEntries(KINDS.map((a) => [a, take(j.program, day, a)])); rate = per.zswapeth; }
      else at = now() - 540e3;
    } catch { at = now() - 540e3; }
    return rate;
  }
  const floor = (wei) => { const n = rate ? Math.floor(Number(wei) / 1e18 * rate) : 0; return n >= 1 ? `${n.toLocaleString('en-US')}+ points` : ''; };
  const est = (wei, a = 'zswapeth') => (per[a] ? (Number(wei) / 1e18) * per[a] : 0);
  return { load, perEth: () => rate, floor, est };
}
