// The Bitcoin-side keeper wallets: do they hold enough sats, in a shape they can work in?
//
//   pool    the shielded-pool relayer. A batch reserves its smallest coin as the bind and funds the carrier from the
//           rest (minCarrierSats there), so it needs two coins and enough left after the smallest.
//   crossout the relay that pays the Bitcoin step of a bridge to Bitcoin. One coin is its normal shape (one crossing
//           per block); it needs sats for the next few steps.
//
// → { level: 'ok' | 'warning' | 'critical' | 'unknown', why }

export const BTC_KEEPERS_MAINNET = [
  { name: 'pool relayer', kind: 'pool', address: 'bc1q7zscdfnead28xh3cryrdzjd4ehawwmp9hh4qj8' },
  { name: 'bridge relay', kind: 'crossout', address: 'bc1qdp49dk80dlg39gvnm05hplwwsh2ec4yehdwavv' },
];

export function keeperCoinsVerdict(kind, utxos, { minCarrierSats = 3000, warnPoolSats = 15000, warnPoolCoins = 3, stepSats = 880, warnSteps = 10, criticalSteps = 2 } = {}) {
  if (!Array.isArray(utxos)) return { level: 'unknown', why: 'the coin list could not be read' };
  const vals = utxos.filter((u) => u.status?.confirmed !== false).map((u) => u.value).sort((a, b) => a - b);
  const total = vals.reduce((a, b) => a + b, 0);
  if (kind === 'pool') {
    const rest = total - (vals[0] || 0);
    const have = `${vals.length} confirmed coin${vals.length === 1 ? '' : 's'}, ${total} sats`;
    if (vals.length < 2 || rest < minCarrierSats) return { level: 'critical', why: `${have}: after the bind there are ${rest} sats, under the ${minCarrierSats} a carrier needs, so quotes are refused` };
    if (total < warnPoolSats || vals.length < warnPoolCoins) return { level: 'warning', why: `${have}: running low (warns under ${warnPoolSats} sats or ${warnPoolCoins} coins)` };
    return { level: 'ok', why: have };
  }
  const steps = Math.floor(total / stepSats);
  const have = `${total} sats, about ${steps} bridge step${steps === 1 ? '' : 's'}`;
  if (steps < criticalSteps) return { level: 'critical', why: `${have}: bridges to Bitcoin are about to stop being sponsored` };
  if (steps < warnSteps) return { level: 'warning', why: `${have}: top up soon` };
  return { level: 'ok', why: have };
}
