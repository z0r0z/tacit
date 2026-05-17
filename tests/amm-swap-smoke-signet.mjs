// T_SWAP_VAR signet smoke test.
//
// Pairs with tests/amm-smoke-signet.mjs (POOL_INIT phase). Reads the
// pool state saved by that test, then constructs + broadcasts a
// T_SWAP_VAR envelope against it via dapp's
// buildAndBroadcastSwapVarSelfFulfill.
//
// Pre-req:
//   .local/amm-signet-wallet.json   (gen-amm-signet-wallet.mjs)
//   .local/amm-signet-state.json    (amm-smoke-signet.mjs, phase 4 complete)
//
// Optional env:
//   DIRECTION         0|1 (default 0 = A→B)
//   DELTA_IN          base units of input asset (default 10_000)
//   SLIPPAGE_BPS      max slippage in bps (default 100 = 1%)
//   EXPIRY_BLOCKS     expire after N blocks from current tip (default 144)
//   SKIP_BROADCAST=1  build envelope + tx, print hex without broadcasting
//
// Pool reserves come from the smoke state's deltaA / deltaB (no prior
// swaps assumed against this pool). For a real swap against a pool
// that's seen traffic, fetch /amm/pool/<id> from the worker instead.

import { JSDOM } from 'jsdom';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const WALLET_FILE = path.join(STATE_DIR, 'amm-signet-wallet.json');
const POOL_STATE_FILE = path.join(STATE_DIR, 'amm-signet-state.json');

if (!existsSync(WALLET_FILE)) {
  console.error(`✗ Wallet missing: ${WALLET_FILE}`);
  console.error(`  Run: node tests/gen-amm-signet-wallet.mjs`);
  process.exit(1);
}
if (!existsSync(POOL_STATE_FILE)) {
  console.error(`✗ Pool state missing: ${POOL_STATE_FILE}`);
  console.error(`  Run: node tests/amm-smoke-signet.mjs first (need phase 4 complete)`);
  process.exit(1);
}
const wallet = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
const poolState = JSON.parse(readFileSync(POOL_STATE_FILE, 'utf8'));
if (!poolState.poolInit?.pool_id_hex) {
  console.error(`✗ Pool not seeded yet (state.poolInit missing).`);
  process.exit(1);
}

const PRIV = hexToBytes(wallet.priv_hex);
const PUB = secp.getPublicKey(PRIV, true);

const DIRECTION = Number(process.env.DIRECTION || 0);
const DELTA_IN = BigInt(process.env.DELTA_IN || 10_000n);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 100);
const EXPIRY_BLOCKS = Number(process.env.EXPIRY_BLOCKS || 144);
const SKIP_BROADCAST = process.env.SKIP_BROADCAST === '1';

if (DIRECTION !== 0 && DIRECTION !== 1) {
  console.error(`✗ DIRECTION must be 0 (A→B) or 1 (B→A)`);
  process.exit(1);
}

const dapp = await import('../dapp/tacit.js');
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(PUB), '1'); } catch {}
dapp.wallet.priv = PRIV;
dapp.wallet.pub = PUB;
dapp.invalidateHoldingsCache();

console.log(`\n=== AMM signet T_SWAP_VAR smoke test ===\n`);
console.log(`  address:      ${wallet.address}`);
console.log(`  pool_id:      ${poolState.poolInit.pool_id_hex}`);
console.log(`  reserve_A:    ${poolState.poolInit.canonical_delta_a}`);
console.log(`  reserve_B:    ${poolState.poolInit.canonical_delta_b}`);
console.log(`  fee_bps:      ${poolState.poolInit.fee_bps}`);
console.log(`  direction:    ${DIRECTION} (${DIRECTION === 0 ? 'A→B' : 'B→A'})`);
console.log(`  delta_in:     ${DELTA_IN}`);
console.log(`  slippage:     ${SLIPPAGE_BPS} bps`);

const R_A_pre = BigInt(poolState.poolInit.canonical_delta_a);
const R_B_pre = BigInt(poolState.poolInit.canonical_delta_b);
const curve = dapp.swapVarCurveDeltaOut(DIRECTION, R_A_pre, R_B_pre, DELTA_IN, poolState.poolInit.fee_bps);
const deltaOut = curve.deltaOut;
const minOut = deltaOut - (deltaOut * BigInt(SLIPPAGE_BPS)) / 10_000n;
console.log(`  expected_out: ${deltaOut} (slippage floor: ${minOut})`);

console.log(`\n--- pre-flight ---`);
const holdings = await dapp.scanHoldings();
if (!holdings || !(holdings instanceof Map)) { console.error('✗ holdings scan failed'); process.exit(1); }
const inputAssetHex = DIRECTION === 0 ? poolState.poolInit.canonical_asset_a : poolState.poolInit.canonical_asset_b;
const outputAssetHex = DIRECTION === 0 ? poolState.poolInit.canonical_asset_b : poolState.poolInit.canonical_asset_a;
const h = holdings.get(inputAssetHex);
if (!h || h.balance < DELTA_IN) {
  console.error(`✗ insufficient input balance: have ${h?.balance ?? 0}, need ${DELTA_IN}`);
  process.exit(1);
}
console.log(`  ✓ input asset balance: ${h.balance}`);

console.log(`  carving exact ${DELTA_IN}…`);
const carved = await dapp.carveExactAmount({ assetIdHex: inputAssetHex, amount: DELTA_IN });
if (!carved) { console.error('✗ carve failed'); process.exit(1); }
console.log(`  ✓ input UTXO: ${carved.utxo.txid.slice(0, 16)}…:${carved.utxo.vout}`);

const tipResp = await fetch('https://mempool.space/signet/api/blocks/tip/height');
const tipHeight = await tipResp.text().then(t => parseInt(t.trim(), 10));
const expiryHeight = tipHeight + EXPIRY_BLOCKS;
console.log(`  tip ${tipHeight} → expiry ${expiryHeight}`);

const poolReserves = {
  pool_id_hex: poolState.poolInit.pool_id_hex,
  reserve_a: R_A_pre.toString(),
  reserve_b: R_B_pre.toString(),
  fee_bps: poolState.poolInit.fee_bps,
};
const assetInputUtxo = {
  txid: carved.utxo.txid,
  vout: carved.utxo.vout,
  amount: carved.amount,
  blinding: carved.blinding,
  asset_id_hex: inputAssetHex,
};

if (SKIP_BROADCAST) {
  console.log(`\n--- SKIP_BROADCAST=1: building envelope only ---`);
  const built = await dapp.buildSwapVarEnvelopeSelfFulfill({
    poolReserves, assetInputUtxo,
    direction: DIRECTION, deltaIn: DELTA_IN, minOut,
    expiryHeight, receiveAssetIdHex: outputAssetHex,
  });
  console.log(`  ✓ envelope built (${built.payload.length} bytes)`);
  console.log(`  envelope_hash: ${bytesToHex(built.envelopeHash)}`);
  console.log(`  isWholeInput: ${built.isWholeInput}`);
  console.log(`  changeAmount: ${built.changeAmount}`);
  process.exit(0);
}

console.log(`\n--- broadcasting T_SWAP_VAR ---`);
const r = await dapp.buildAndBroadcastSwapVarSelfFulfill({
  poolReserves, assetInputUtxo,
  direction: DIRECTION, deltaIn: DELTA_IN, minOut,
  expiryHeight, receiveAssetIdHex: outputAssetHex,
});

console.log(`  ✓ commit txid: ${r.commitTxid}`);
console.log(`  ✓ reveal txid: ${r.revealTxid}`);
console.log(`  ✓ delta_out:   ${r.deltaOut}`);
console.log(`  ✓ raPost:      ${r.raPost}`);
console.log(`  ✓ rbPost:      ${r.rbPost}`);

console.log(`\n=== T_SWAP_VAR signet smoke complete ===\n`);
console.log(`  https://mempool.space/signet/tx/${r.revealTxid}`);
