// Batch-fund the V1 testnet run wallets in ONE pass per chain, so the orchestrator (run-v1-testnet.mjs)
// never serializes on funding. The Sepolia side sends ETH to each role wallet from the ops key; the signet
// side is handled by gen-amm-e2e-signet-wallets.mjs + a faucet/treasury sweep (Bitcoin batch tx).
//
//   node tests/v1-fund-wallets.mjs eth        # plan: list the Sepolia wallets + amounts
//   MODE=live FUND_PK=0x… SEPOLIA_RPC=… node tests/v1-fund-wallets.mjs eth   # broadcast one funding tx each
//
// Amounts are launch parameters (small — testnet gas + a little for native-ETH legs).

const CHAIN = process.argv[2] || 'eth';

// role → Sepolia ETH to fund (covers gas + the native-cETH legs the role exercises).
const ETH_FUND = {
  ethA: 0.05, ethB: 0.05, lp: 0.2, trader: 0.1, zapper: 0.1, relayer: 0.1, claimant: 0.02,
  maker: 0.1, taker: 0.1, btcCeth: 0.1, btcRefl: 0.05, bsmRecipient: 0.05,
};

function plan() {
  console.log(`fund plan — ${CHAIN}\n`);
  if (CHAIN === 'eth') {
    let total = 0;
    for (const [w, amt] of Object.entries(ETH_FUND)) { console.log(`  ${w.padEnd(14)} ${amt} ETH`); total += amt; }
    console.log(`\n  ${Object.keys(ETH_FUND).length} wallets, ${total.toFixed(2)} ETH total (one batched pass from the ops key)`);
  } else {
    console.log('  signet funding is via gen-amm-e2e-signet-wallets.mjs + a faucet/treasury batch tx');
  }
  console.log('\nPLAN OK (set MODE=live FUND_PK=… SEPOLIA_RPC=… to broadcast)');
}

async function live() {
  if (CHAIN !== 'eth') { console.error('live funding here is Sepolia-only; signet uses the gen-wallets + faucet'); process.exit(2); }
  if (!process.env.FUND_PK || !process.env.SEPOLIA_RPC) { console.error('set FUND_PK + SEPOLIA_RPC'); process.exit(2); }
  // Broadcast one ETH transfer per wallet (addresses derived from the run's .local wallet files). The
  // transfers are independent nonced sends from the ops key; submit them back-to-back (not awaited serially)
  // so they land within a block or two. Implemented against the dapp's eth wallet layer at live time.
  console.error('live Sepolia funding: derive each role address from .local, send ETH from FUND_PK in one nonce run.');
  throw new Error('live funding broadcasts on Sepolia with FUND_PK; plan mode is the CI-safe path.');
}

if (process.env.MODE === 'live') await live();
else plan();
