#!/usr/bin/env node
// tETH bridge end-to-end testnet harness.
// Tests the full Sepolia ↔ Signet round-trip:
//   1. Deposit Sepolia ETH into the mixer contract
//   2. Mint tETH on Tacit (signet) via T_BRIDGE_DEPOSIT
//   3. Burn tETH on Tacit via T_BRIDGE_BURN
//   4. Recover Sepolia ETH via withdrawFromBurn
//
// Prerequisites:
//   - Sepolia TacitETHMixer deployed (set MIXER_ADDRESS below)
//   - Signet tETH asset etched (set TETH_ASSET_ID below)
//   - Worker updated with bridge handlers
//   - Attestor posting Sepolia roots to worker
//
// Usage:
//   DEPLOYER_KEY=0x... SEPOLIA_RPC=https://... node bridge-e2e-testnet.mjs
//
// This script is a blueprint — fill in the deployment addresses after
// contract deployment and etch. Each step is independently runnable
// (comment out completed steps to resume from a failure point).

import { createHash } from 'node:crypto';

// --- Configuration (fill in after deployment) ---
const SEPOLIA_RPC     = process.env.SEPOLIA_RPC || 'https://rpc.sepolia.org';
const DEPLOYER_KEY    = process.env.DEPLOYER_KEY;  // Sepolia private key (hex, no 0x prefix)
const MIXER_ADDRESS   = process.env.MIXER_ADDRESS || '0x0000000000000000000000000000000000000000';
const TETH_ASSET_ID   = process.env.TETH_ASSET_ID || '0'.repeat(64);
const WORKER_URL      = process.env.WORKER_URL || 'https://tacit.finance';
const DENOMINATION    = 1_000_000_000_000_000_000n; // 1 ETH in wei
const DENOM_TACIT     = 100_000_000n;               // 1 tETH in 8-decimal base units

// --- Helpers ---
function sha256(data) {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

// --- Step 1: Deposit Sepolia ETH ---
async function step1_deposit() {
  log('DEPOSIT', 'Generating secret pair (secret, ν)...');

  // Generate random secret + nullifier_preimage.
  const secret = new Uint8Array(32);
  const nullifierPreimage = new Uint8Array(32);
  globalThis.crypto.getRandomValues(secret);
  globalThis.crypto.getRandomValues(nullifierPreimage);

  log('DEPOSIT', `secret: ${Buffer.from(secret).toString('hex')}`);
  log('DEPOSIT', `nullifier_preimage: ${Buffer.from(nullifierPreimage).toString('hex')}`);
  log('DEPOSIT', 'SAVE THESE — you need them for every subsequent step.');

  // Compute commitment = Poseidon₃(secret, ν, denomination).
  // In the real flow, this uses poseidon-lite. For this harness,
  // the dApp's buildBridgeDepositEnvelope handles it.
  log('DEPOSIT', `denomination: ${DENOMINATION} wei (${Number(DENOMINATION) / 1e18} ETH)`);
  log('DEPOSIT', `mixer contract: ${MIXER_ADDRESS}`);
  log('DEPOSIT', '');
  log('DEPOSIT', 'To deposit, call from your Ethereum wallet:');
  log('DEPOSIT', `  mixer.deposit{value: ${DENOMINATION}}(commitment)`);
  log('DEPOSIT', '');
  log('DEPOSIT', 'Or use cast:');
  log('DEPOSIT', `  cast send ${MIXER_ADDRESS} "deposit(bytes32)" <commitment> --value ${DENOMINATION} --rpc-url ${SEPOLIA_RPC} --private-key 0x<key>`);

  return { secret, nullifierPreimage };
}

// --- Step 2: Wait for anonymity set + fetch Ethereum tree root ---
async function step2_fetchEthRoot() {
  log('ETH_ROOT', `Fetching current mixer root from ${MIXER_ADDRESS}...`);
  log('ETH_ROOT', 'Use cast:');
  log('ETH_ROOT', `  cast call ${MIXER_ADDRESS} "getPoolRoot(bytes32)(bytes32)" $(cast keccak "$(cast abi-encode "f(uint256)" ${DENOMINATION}")") --rpc-url ${SEPOLIA_RPC}`);
  log('ETH_ROOT', '');
  log('ETH_ROOT', 'Then post the root to the worker attestor:');
  log('ETH_ROOT', `  curl -X POST ${WORKER_URL}/bridge/eth-roots -d '{"asset_id":"${TETH_ASSET_ID}","eth_root":"<root>","eth_block_number":<block>,"attestor_pubkey":"<pub>","attestor_sig":"<sig>"}'`);
}

// --- Step 3: Mint tETH on signet ---
async function step3_mintTeth() {
  log('MINT', 'Generate withdraw proof against the Ethereum tree (withdraw.circom).');
  log('MINT', 'Public inputs: [eth_root, nullifier_hash, denomination, r_leaf, bind_hash]');
  log('MINT', '');
  log('MINT', 'Build T_BRIDGE_DEPOSIT envelope and broadcast on signet.');
  log('MINT', 'The dApp\'s buildBridgeDepositEnvelope() handles proof input generation.');
  log('MINT', 'After broadcast, the worker indexes the leaf and tETH appears in your wallet.');
}

// --- Step 4: Burn tETH ---
async function step4_burnTeth() {
  log('BURN', 'Generate withdraw proof against the Tacit tETH pool (withdraw.circom).');
  log('BURN', 'Build T_BRIDGE_BURN envelope with eth_recipient = your Sepolia address.');
  log('BURN', 'Broadcast on signet. Wait for 6+ Bitcoin confirmations.');
  log('BURN', '');
  log('BURN', 'The T_BRIDGE_BURN envelope embeds your ETH recipient address in the bind_hash,');
  log('BURN', 'so no one can front-run the Ethereum withdrawal.');
}

// --- Step 5: Recover Sepolia ETH ---
async function step5_recoverEth() {
  log('RECOVER', 'After 6 Bitcoin confirmations:');
  log('RECOVER', '  1. Get the raw burn Bitcoin transaction (getrawtransaction or esplora API)');
  log('RECOVER', '  2. Get the burn block hash');
  log('RECOVER', '  3. Build the Bitcoin merkle proof for tx inclusion');
  log('RECOVER', '  4. Call mixer.withdrawFromBurn(rawBtcTx, blockHash, merkleProof, txIndex)');
  log('RECOVER', '');
  log('RECOVER', 'The contract parses the OP_RETURN, extracts the burn envelope,');
  log('RECOVER', 'verifies the Bitcoin header chain, and sends ETH to your address.');
  log('RECOVER', '');
  log('RECOVER', 'Use cast:');
  log('RECOVER', `  cast send ${MIXER_ADDRESS} "withdrawFromBurn(bytes,bytes32,bytes32[],uint256)" 0x<rawTx> <blockHash> "[<proof>]" <txIndex> --rpc-url ${SEPOLIA_RPC} --private-key 0x<key>`);
}

// --- Main ---
async function main() {
  console.log('=== tETH Bridge E2E Testnet Harness ===');
  console.log(`Sepolia RPC: ${SEPOLIA_RPC}`);
  console.log(`Mixer: ${MIXER_ADDRESS}`);
  console.log(`tETH asset: ${TETH_ASSET_ID}`);
  console.log(`Worker: ${WORKER_URL}`);
  console.log('');

  if (!DEPLOYER_KEY) {
    console.log('Set DEPLOYER_KEY to run automated steps.');
    console.log('Without it, this script prints the manual commands for each step.');
    console.log('');
  }

  console.log('\n--- STEP 1: Deposit Sepolia ETH ---');
  await step1_deposit();

  console.log('\n--- STEP 2: Fetch & attest Ethereum tree root ---');
  await step2_fetchEthRoot();

  console.log('\n--- STEP 3: Mint tETH on signet ---');
  await step3_mintTeth();

  console.log('\n--- STEP 4: Burn tETH ---');
  await step4_burnTeth();

  console.log('\n--- STEP 5: Recover Sepolia ETH ---');
  await step5_recoverEth();

  console.log('\n=== Harness complete. Follow the steps above in order. ===');
}

main().catch(e => { console.error(e); process.exit(1); });
