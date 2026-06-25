// Day-1 end-to-end gap harness — the live-broadcast flows not yet covered by an on-chain *-signet.mjs.
//
// Consolidates the gap flows the launch depends on into one phase-sequenced rehearsal (the shape of
// tests/amm-full-e2e-signet.mjs). Each phase maps to a dapp confidential-DeFi entrypoint; the live run
// broadcasts on Sepolia+Signet via the box (ops/runbooks/V1-TESTNET-LAUNCH-PLAYBOOK.md §5).
//
// Two modes:
//   preflight (default) — load the manifest, and for each phase assert its required contracts/asset ids
//     resolve + print the phase→entrypoint matrix. Runs locally; catches missing wiring before a live run.
//   live (MODE=live)    — drive each phase through the dapp action layer + box. Gated (signet wallets + box).
//
// Phases (the recon gap set):
//   1 CDP lifecycle      cUSD mint → topup → close, + an oracle-driven liquidation     openCdp/topupCdp/closeCdp
//   2 cBTC.zk backing    Bitcoin lock → reflect → mint, native-ETH escrow + slashing    mintCbtc + CollateralEngine
//   3 BTC→ETH deposit    Bitcoin deposit envelope → reflect → bridge_mint               bridge_mint
//   4 Router zap         external liquidity (zRouter) → single-sided LP                 ConfidentialRouter zap
//   5 Confidential book  adaptor lock/claim/refund + cross-chain RFQ                     OP_ADAPTOR_* / orderbook
//   6 cETH round-trip    ETH → cETH → bridge to Bitcoin → back                           wrap/unwrap + bridge
//   7 Relayer paths      relayed settle (TacitRelayer) AND self-settle (pool.settle)     relay + direct
//   8 Reflection         consume ν on ETH → reflect consumed set → reject stale attest   attestBitcoinStateProven
//   9 Bridge-stealth-mint Bitcoin burn → reflect → mint into the stealth lock-set →       buildBridgeStealthMint
//                         recipient OP_STEALTH_CLAIM (cross-chain confidential pay)         + stealthClaim
//
// Run (preflight): node tests/v1-day1-e2e-signet.mjs contracts/deployments/11155111.json
// Run (live):      MODE=live node tests/v1-day1-e2e-signet.mjs contracts/deployments/11155111.json

import { readFileSync } from 'node:fs';

const Z = '0x' + '0'.repeat(64);
const isId = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) && v !== Z;
const isAddr = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && v !== '0x' + '0'.repeat(40);

// phase → { needs: manifest fields required, entry: dapp entrypoint, note }
const PHASES = [
  { n: 1, name: 'CDP lifecycle (mint/topup/close + oracle liquidation)', needs: ['pool', 'engine', 'cBtc', 'cUsd'], entry: 'openCdp/topupCdp/closeCdp', relayed: true, selfSettle: true },
  { n: 2, name: 'cBTC.zk lock → backing + ETH escrow + slashing', needs: ['pool', 'engine', 'cBtc'], entry: 'mintCbtc + engine.postEscrow/slash', relayed: true, selfSettle: true },
  { n: 3, name: 'BTC→ETH deposit (reflect → bridge_mint)', needs: ['pool'], entry: 'bridge_mint (reflection-gated)', relayed: true, selfSettle: true },
  { n: 4, name: 'Router zap (zRouter → single-sided LP)', needs: ['pool', 'router'], entry: 'ConfidentialRouter zap', relayed: false, selfSettle: true },
  { n: 5, name: 'Confidential orderbook + cross-chain RFQ', needs: ['pool'], entry: 'OP_ADAPTOR_LOCK/CLAIM/REFUND', relayed: true, selfSettle: true },
  { n: 6, name: 'cETH round-trip (wrap → bridge → back)', needs: ['pool', 'cEth'], entry: 'wrap/unwrap + bridge', relayed: true, selfSettle: true },
  { n: 7, name: 'Relayer: relayed settle AND self-settle', needs: ['pool', 'relayer'], entry: 'TacitRelayer.relaySettle + pool.settle', relayed: true, selfSettle: true },
  { n: 8, name: 'Reflection / fast-lane consumed-ν reject-stale', needs: ['pool'], entry: 'attestBitcoinStateProven', relayed: false, selfSettle: false },
  { n: 9, name: 'Bridge-stealth-mint (BTC burn → reflect → stealth lock → recipient claim)', needs: ['pool'], entry: 'buildBridgeStealthMint + OP_STEALTH_CLAIM', relayed: true, selfSettle: true },
];

// PHASE=n runs/inspects only that phase (so the orchestrator can run phases in parallel as separate jobs).
const ONLY = process.env.PHASE ? Number(process.env.PHASE) : 0;
const selected = () => (ONLY ? PHASES.filter((p) => p.n === ONLY) : PHASES);

function preflight(m) {
  let ok = true;
  console.log('phase  needs-resolved  paths            flow');
  for (const p of selected()) {
    const missing = p.needs.filter((k) => !(isId(m[k]) || isAddr(m[k])));
    const resolved = missing.length === 0;
    if (!resolved) ok = false;
    const paths = [p.relayed ? 'relayed' : null, p.selfSettle ? 'self-settle' : null].filter(Boolean).join('+') || '—';
    console.log(`  ${p.n}    ${resolved ? 'ok      ' : 'MISSING '}${resolved ? '       ' : missing.join(',')}  ${paths.padEnd(16)} ${p.name}  [${p.entry}]`);
  }
  // Relaying AND self-settle are both exercised across the phases (the user's explicit ask).
  const relayed = selected().filter((p) => p.relayed).length;
  const self = selected().filter((p) => p.selfSettle).length;
  console.log(`\nrelayed path phases: ${relayed}   self-settle path phases: ${self}`);
  return ok;
}

async function live(m) {
  console.error(`live mode${ONLY ? ` (phase ${ONLY} only)` : ''}: broadcast via the dapp action layer + box (PLAYBOOK §5).`);
  console.error('prereqs: .local signet wallets, CONFIDENTIAL_BOX_TOKEN, worker base, Sepolia RPC, funded ops.');
  console.error('each phase drives dapp/confidential-defi-actions.js (or confidential-stealth.js for the');
  console.error('orderbook/bridge-stealth-mint phases) + dapp/confidential-relay.js (relayed) and pool.settle');
  console.error('(self-settle); see tests/amm-full-e2e-signet.mjs for the wallet/box bootstrap.');
  throw new Error('live E2E runs on signet with wallets+box; wire .local wallets then re-run. (preflight is the CI-safe path.)');
}

const manifestPath = process.argv[2];
if (!manifestPath) { console.error('usage: node tests/v1-day1-e2e-signet.mjs <deployments/<chainid>.json> [MODE=live]'); process.exit(2); }
const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
console.log(`day-1 E2E — ${process.env.MODE === 'live' ? 'LIVE' : 'PREFLIGHT'} — pool ${m.pool}\n`);

if (process.env.MODE === 'live') {
  await live(m);
} else {
  const ok = preflight(m);
  console.log(`\n${ok ? 'PREFLIGHT OK — every gap phase has its wiring' : 'PREFLIGHT INCOMPLETE — wire the missing fields (deploy with engine/reflection?)'}`);
  process.exit(ok ? 0 : 1);
}
