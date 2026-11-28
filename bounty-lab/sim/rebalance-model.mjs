// Offline accounting model. All values are integer TAC base units (8 decimals).
// A bridgeable Bitcoin note is recoverable by the ordinary bridge in both scenarios.
// A stuck note is recoverable only in the desk scenario, less the desk fee.
export function simulate({ initialPool, bridges, deskFeeBps = 30, deskFlat = 0n, deskCapacity = null }) {
  const initial = BigInt(initialPool);
  const rows = [];
  let baseline = initial;
  let recovered = initial;
  let remainingDesk = deskCapacity == null ? null : BigInt(deskCapacity);
  for (const [index, bridge] of bridges.entries()) {
    const paid = BigInt(bridge.paid);
    const received = BigInt(bridge.received ?? bridge.paid);
    if (paid <= 0n || received <= 0n) throw new Error('bridge amounts must be positive');
    baseline = baseline > paid ? baseline - paid : 0n;
    recovered = recovered > paid ? recovered - paid : 0n;
    let output = 0n;
    let reason = 'ordinary-bridge';
    if (bridge.stuck === true) {
      const fee = received * BigInt(deskFeeBps) / 10000n + BigInt(deskFlat);
      output = received > fee ? received - fee : 0n;
      if (remainingDesk != null && output > remainingDesk) {
        output = 0n;
        reason = 'desk-capacity';
      } else if (output === 0n) reason = 'fee-exceeds-input';
      else reason = 'desk-recovered';
      if (output > 0n && remainingDesk != null) remainingDesk -= output;
    } else {
      output = received;
      reason = 'ordinary-bridge';
    }
    baseline += bridge.stuck === true ? 0n : received;
    recovered += output;
    rows.push({ bridge: index + 1, paid, received, output, baseline, recovered, reason });
  }
  return { baseline, recovered, rows, remainingDesk };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const TAC = 100_000_000n;
  const bridges = Array.from({ length: 10 }, (_, i) => ({
    paid: 1000n * TAC,
    received: 1000n * TAC,
    stuck: i % 2 === 0,
  }));
  const result = simulate({ initialPool: 10_000n * TAC, bridges, deskFeeBps: 100 });
  console.log('Bridge | baseline pool TAC | with desk TAC | recovered this bridge');
  for (const r of result.rows) {
    const fmt = (n) => (Number(n) / 1e8).toFixed(2);
    console.log(`${String(r.bridge).padStart(6)} | ${fmt(r.baseline).padStart(18)} | ${fmt(r.recovered).padStart(13)} | ${fmt(r.output)} (${r.reason})`);
  }
}
