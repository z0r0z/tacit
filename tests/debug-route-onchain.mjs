// Lightweight debug: fetch the on-chain T_SWAP_ROUTE bytes from signet,
// run them through the reference validator, and pinpoint which gate (if
// any) rejects. NO dapp module dependency — manual byte parse is fine
// because both opcodes have stable, simple layouts.
//
// Usage:
//   node tests/debug-route-onchain.mjs <reveal_txid>

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  decodeSwapRoute, validateSwapRoute, computeSwapRouteEnvelopeHash,
  OPCODE_T_SWAP_ROUTE,
} from './swap-route.mjs';
import { bpRangeAggVerify, ZERO } from './bulletproofs.mjs';
import * as secp from '@noble/secp256k1';

const ROUTE_TXID = process.argv[2] || 'b1f542089ae2c2fbd7533d8743e453d58600688af6c14b1e1110e681bc4c0ab9';
const NETWORK = 'signet';
const ESPLORA = `https://mempool.space/${NETWORK}/api`;
const WORKER  = process.env.TACIT_WORKER_BASE || process.env.WORKER_BASE || 'https://api.tacit.finance';

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

function extractEnvelopePayload(scriptHex) {
  const s = hexToBytes(scriptHex);
  const TACIT = new TextEncoder().encode('TACIT');
  let idx = 0;
  while (idx < s.length - TACIT.length) {
    let m = true;
    for (let i = 0; i < TACIT.length; i++) {
      if (s[idx + i] !== TACIT[i]) { m = false; break; }
    }
    if (m) break;
    idx++;
  }
  if (idx >= s.length - TACIT.length) throw new Error('TACIT magic not found');
  // After TACIT push (5 bytes data, preceded by 1-byte length prefix), next is version push (0x01 0x01)
  // Then payload chunks
  let p = idx + TACIT.length;
  if (s[p] !== 0x01 || s[p + 1] !== 0x01) throw new Error('expected version push 0x0101 after TACIT');
  p += 2;
  const chunks = [];
  while (p < s.length) {
    const op = s[p];
    if (op === 0x68) break;
    if (op === 0x4d) {
      const ln = s[p + 1] | (s[p + 2] << 8);
      chunks.push(s.slice(p + 3, p + 3 + ln)); p += 3 + ln;
    } else if (op === 0x4c) {
      const ln = s[p + 1]; chunks.push(s.slice(p + 2, p + 2 + ln)); p += 2 + ln;
    } else if (op >= 0x01 && op <= 0x4b) {
      chunks.push(s.slice(p + 1, p + 1 + op)); p += 1 + op;
    } else break;
  }
  const payload = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let off = 0; for (const c of chunks) { payload.set(c, off); off += c.length; }
  return payload;
}

// ── 1. Fetch + decode the route ──
const route_tx = await jget(`${ESPLORA}/tx/${ROUTE_TXID}`);
console.log(`route tx: ${ROUTE_TXID.slice(0, 16)}…  block ${route_tx.status.block_height}`);
const routeWitness = route_tx.vin[0].witness;
if (!routeWitness || routeWitness.length < 3) throw new Error('vin[0] missing script-path witness');
const routePayload = extractEnvelopePayload(routeWitness[1]);
console.log(`payload: ${routePayload.length} B, version=0x${routePayload[0].toString(16)}, opcode=0x${routePayload[1].toString(16)}`);

const decoded = decodeSwapRoute(routePayload);
console.log(`decoded:`);
console.log(`  nHops=${decoded.nHops} minOut=${decoded.minOut} expiry=${decoded.expiryHeight}`);
console.log(`  cInSecp:      ${bytesToHex(decoded.cInSecp)}`);
console.log(`  cReceiptSecp: ${bytesToHex(decoded.cReceiptSecp)}`);

const inputTxidLE = bytesToHex(decoded.traderInputOutpointTxid.slice().reverse());
console.log(`  traderInputOutpoint: ${inputTxidLE}:${decoded.traderInputOutpointVout}`);

// ── 2. Fetch + decode the carve (the parent of the route's vin[1]) ──
const carve = await jget(`${ESPLORA}/tx/${inputTxidLE}`);
console.log(`\ncarve tx: ${inputTxidLE.slice(0, 16)}…  block ${carve.status.block_height}`);
const carveWitness = carve.vin[0].witness;
if (!carveWitness || carveWitness.length < 3) throw new Error('carve vin[0] missing script-path witness');
const carvePayload = extractEnvelopePayload(carveWitness[1]);
const carveOpcode = carvePayload[0];
console.log(`carve payload: ${carvePayload.length} B, opcode=0x${carveOpcode.toString(16)} (expect 0x22=T_CXFER_BPP or 0x23=T_CXFER)`);

// T_CXFER_BPP layout: opcode(1) + asset_id(32) + kernel_sig(64) + m(1) + (commitment(33) + amount_ct(8)) × m + rp_len(2) + rp
// T_CXFER layout: opcode(1) + asset_id(32) + kernel_sig(64) + m(1) + (commitment(33) + amount_ct(8)) × m + rp_len(2) + rp + sender_pub(33)
// Both share the outputs layout we need.
const carveAssetId = bytesToHex(carvePayload.slice(1, 1 + 32));
const carveM = carvePayload[1 + 32 + 64];
console.log(`carve asset_id: ${carveAssetId}`);
console.log(`carve m (output count): ${carveM}`);

const outputsBase = 1 + 32 + 64 + 1;
const carveCommitments = [];
for (let i = 0; i < carveM; i++) {
  const off = outputsBase + i * (33 + 8);
  carveCommitments.push(bytesToHex(carvePayload.slice(off, off + 33)));
}
console.log(`carve commitments:`);
for (let i = 0; i < carveCommitments.length; i++) {
  console.log(`  [${i}] ${carveCommitments[i]}`);
}

const targetVout = decoded.traderInputOutpointVout;
const targetCommit = carveCommitments[targetVout];
console.log(`\nrouting against vout[${targetVout}] of carve = ${targetCommit}`);
console.log(`envelope cInSecp                            = ${bytesToHex(decoded.cInSecp)}`);
if (targetCommit === bytesToHex(decoded.cInSecp)) {
  console.log(`✓ MATCH — cInSecp matches the carve's vout[${targetVout}] commitment`);
} else {
  console.log(`✗ MISMATCH — cInSecp would FAIL the worker's commitmentForUtxo check`);
}

// ── 3. Fetch pool state from worker (post-route — currently still pre-route reserves) ──
const ab_pool = await jget(`${WORKER}/amm/pool/${bytesToHex(decoded.hops[0].poolId)}?network=${NETWORK}`);
const bc_pool = await jget(`${WORKER}/amm/pool/${bytesToHex(decoded.hops[1].poolId)}?network=${NETWORK}`);
console.log(`\npool AB (worker now): R_A=${ab_pool.reserve_a} R_B=${ab_pool.reserve_b} fee=${ab_pool.fee_bps} validation=${ab_pool.validation}`);
console.log(`pool BC (worker now): R_A=${bc_pool.reserve_a} R_B=${bc_pool.reserve_b} fee=${bc_pool.fee_bps} validation=${bc_pool.validation}`);

const pools = new Map([
  [bytesToHex(decoded.hops[0].poolId), {
    asset_A: hexToBytes(ab_pool.asset_a), asset_B: hexToBytes(ab_pool.asset_b),
    reserve_A: BigInt(ab_pool.reserve_a), reserve_B: BigInt(ab_pool.reserve_b),
    fee_bps: ab_pool.fee_bps, tradable: true,
  }],
  [bytesToHex(decoded.hops[1].poolId), {
    asset_A: hexToBytes(bc_pool.asset_a), asset_B: hexToBytes(bc_pool.asset_b),
    reserve_A: BigInt(bc_pool.reserve_a), reserve_B: BigInt(bc_pool.reserve_b),
    fee_bps: bc_pool.fee_bps, tradable: true,
  }],
]);

// ── 4. Run reference validator ──
const opReturnData = hexToBytes(route_tx.vout[0].scriptpubkey.slice(4));
console.log(`\nopReturnData: ${bytesToHex(opReturnData)}`);
console.log(`expectedHash: ${bytesToHex(computeSwapRouteEnvelopeHash(routePayload))}`);

// Real BP verify (no stub). Validator passes (V_pts_array, rangeProof_bytes).
function realBulletproofVerify(V_pts, rangeProof) {
  try { return bpRangeAggVerify(V_pts, rangeProof); }
  catch (e) { console.error(`  BP throw: ${e.message}`); return false; }
}

const result = validateSwapRoute({
  payload: routePayload,
  pools,
  currentHeight: route_tx.status.block_height,
  opReturnData,
  inputCommitment: hexToBytes(targetCommit),
  bulletproofVerify: realBulletproofVerify,
});

console.log(`\nreference validator (real BP): ${result.valid ? '✓ ACCEPT' : `✗ REJECT — "${result.reason}"`}`);
