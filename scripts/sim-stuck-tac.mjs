import { normalizeStuckPolicy, priceWithClass } from '../dapp/fastbridge-stuck-policy.js';
const TAC = 100_000_000n;
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function generateBridges(n, { seed = 20261122, pLong = 230 / 4546, pExit = 0.03 } = {}) {
  const rng = mulberry32(seed), out = [];
  for (let i = 0; i < n; i++) {
    const r = rng(), noteClass = r < pExit ? 'pool_exit' : r < pExit + pLong ? 'long' : 'clean';
    out.push({ noteClass, amount: BigInt(Math.round(25 + Math.pow(rng(), 1.4) * 200)) * TAC });
  }
  return out;
}
function runScenario(mode, bridges, cfg) {
  let ethFree = cfg.startEth, btcClean = 0n, btcLong = 0n, btcExit = 0n, filled = 0, stuckFill = 0, refused = 0;
  for (const b of bridges) {
    if (btcClean >= cfg.rebalanceThreshold) { ethFree += btcClean - (btcClean * BigInt(cfg.rebalanceBps)) / 10000n; btcClean = 0n; }
    if (mode === 'strict' && b.noteClass !== 'clean') { refused++; continue; }
    let evmOut;
    if (mode === 'track_c') {
      try { evmOut = priceWithClass({ policy: cfg.policy, noteClass: b.noteClass, amount: b.amount, minAmount: 1n * TAC, maxAmount: 1000n * TAC, baseFeeBps: cfg.baseFeeBps, baseFlatFee: cfg.baseFlatFee, inventory: { totalUnits: ethFree + btcClean + btcLong + btcExit, stuckUnits: btcLong + btcExit, pendingStuckUnits: 0n } }).evmAmount; } catch { refused++; continue; }
    } else {
      evmOut = b.amount - ((b.amount * BigInt(cfg.baseFeeBps)) / 10000n + cfg.baseFlatFee);
    }
    if (evmOut > ethFree) { refused++; continue; }
    ethFree -= evmOut; filled++;
    if (b.noteClass === 'clean') btcClean += b.amount;
    else { stuckFill++; if (b.noteClass === 'long') btcLong += b.amount; else btcExit += b.amount; }
  }
  const lendableEthEq = ethFree + btcClean - (btcClean * BigInt(cfg.rebalanceBps)) / 10000n;
  const stuckTotal = btcLong + btcExit;
  const netPnl = lendableEthEq + (btcLong - (btcLong * 300n) / 10000n) + (btcExit - (btcExit * 600n) / 10000n) - cfg.startEth;
  return { mode, filled, stuckFill, refused, lendableEthEq, stuckTotal, netPnl };
}
const cfg = {
  startEth: 10000n * TAC, baseFeeBps: 30, baseFlatFee: 10_000_000n, rebalanceThreshold: 1000n * TAC, rebalanceBps: 15,
  policy: normalizeStuckPolicy({
    enabled: true, maxStuckShare: 0.15, maxStuckUnits: String(1500n * TAC),
    classes: {
      long: { enabled: true, minHaircutBps: 200, extraBps: 350, utilizationSlopeBps: 100, extraFlatFee: '0', maxAmount: String(500n * TAC) },
      pool_exit: { enabled: true, minHaircutBps: 400, extraBps: 650, utilizationSlopeBps: 150, extraFlatFee: '5000000', maxAmount: String(250n * TAC) },
    },
  }),
};
for (const N of [100, 500, 1000]) {
  const bridges = generateBridges(N);
  console.log(`N=${N}`, ['naive', 'strict', 'track_c'].map((m) => runScenario(m, bridges, cfg)));
}
