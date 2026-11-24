// States the periphery contracts must stay in, as one verdict the monitor pages on. Pure, so it is tested without a chain.
//
//   claimBond   ProofMarket.claimBond() in wei (the market runs with none)
//   funder      { tac, wtac }: what TacFarmFunder holds of each (fund() needs it empty)
//   points      { onchainRoot, publishedRoot, rootsSent }: the distributor's root against what the points service reports having sent
//
// → { level: 'ok' | 'warning' | 'critical', why: string[] }
const lc = (s) => String(s).toLowerCase();

export function peripheryVerdict({ claimBond = null, funder = null, points = null }) {
  const why = [];
  let level = 'ok';
  const raise = (l, msg) => { why.push(msg); if (l === 'critical' || level === 'ok') level = l; };
  if (claimBond != null && BigInt(claimBond) !== 0n) raise('critical', `ProofMarket's claim bond is ${claimBond} wei: the market runs with none`);
  if (funder && (BigInt(funder.tac) !== 0n || BigInt(funder.wtac) !== 0n)) {
    raise('warning', 'TacFarmFunder holds a balance, so fund() is stopped: fund the manager with fundAndNotify instead');
  }
  if (points?.onchainRoot && points.publishedRoot !== undefined) {
    const sent = new Set([points.publishedRoot, ...(points.rootsSent || [])].filter(Boolean).map(lc));
    const zero = /^0x0{64}$/.test(lc(points.onchainRoot));
    if (!zero && sent.size && !sent.has(lc(points.onchainRoot))) {
      raise('critical', `PointsDistributor holds root ${points.onchainRoot}, which the points service did not send: pause it and rotate the root setter`);
    }
  }
  if (!why.length) why.push('claim bond none, funder empty, distributor root as sent');
  return { level, why };
}
