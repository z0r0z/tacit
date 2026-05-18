// Debug helper: fetch the actual on-chain T_SWAP_ROUTE envelope bytes
// from signet, decode + run the reference validator, and report which
// gate (if any) rejects it. Pinpoints worker/dapp validator divergence
// when a route confirms on chain but the worker rejects it silently.
//
// Usage:
//   node tests/debug-route-onchain.mjs <reveal_txid> [<carve_txid>]
//
// If <carve_txid> is omitted, we read the carve from vin[1] of the
// reveal tx automatically.

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { decodeSwapRoute, validateSwapRoute, OPCODE_T_SWAP_ROUTE } from './swap-route.mjs';

const ROUTE_TXID = process.argv[2] || 'b1f542089ae2c2fbd7533d8743e453d58600688af6c14b1e1110e681bc4c0ab9';
const NETWORK = 'signet';
const ESPLORA = `https://mempool.space/${NETWORK}/api`;
const WORKER  = 'https://tacit-pin.rosscampbell9.workers.dev';

async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

const route_tx = await jget(`${ESPLORA}/tx/${ROUTE_TXID}`);
console.log(`route tx: ${ROUTE_TXID.slice(0, 16)}…  block ${route_tx.status.block_height}`);

// Decode envelope from witness[0][1]
const witness = route_tx.vin[0].witness;
if (!witness || witness.length < 3) throw new Error('reveal vin[0] has no taproot script-path witness');
const script_bytes = hexToBytes(witness[1]);
// Find 'TACIT' magic offset and skip to payload chunks
const tacit = new TextEncoder().encode('TACIT');
let idx = 0;
while (idx < script_bytes.length - tacit.length) {
  let match = true;
  for (let i = 0; i < tacit.length; i++) {
    if (script_bytes[idx + i] !== tacit[i]) { match = false; break; }
  }
  if (match) break;
  idx++;
}
if (idx >= script_bytes.length - tacit.length) throw new Error('TACIT magic not found');
let p = idx + tacit.length;
// version push (0x01 0x01)
if (script_bytes[p] !== 0x01 || script_bytes[p + 1] !== 0x01) throw new Error(`expected version push, got ${script_bytes.slice(p, p+2)}`);
p += 2;
// payload chunks (could be multiple OP_PUSHDATA2)
const chunks = [];
while (p < script_bytes.length) {
  const op = script_bytes[p];
  if (op === 0x68) break;  // OP_ENDIF — end of envelope
  if (op === 0x4d) {  // OP_PUSHDATA2
    const ln = script_bytes[p + 1] | (script_bytes[p + 2] << 8);
    chunks.push(script_bytes.slice(p + 3, p + 3 + ln));
    p += 3 + ln;
  } else if (op === 0x4c) {  // OP_PUSHDATA1
    const ln = script_bytes[p + 1];
    chunks.push(script_bytes.slice(p + 2, p + 2 + ln));
    p += 2 + ln;
  } else if (op >= 0x01 && op <= 0x4b) {  // direct push
    chunks.push(script_bytes.slice(p + 1, p + 1 + op));
    p += 1 + op;
  } else {
    throw new Error(`unexpected opcode at offset ${p}: 0x${op.toString(16)}`);
  }
}
const payload = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
let off = 0;
for (const c of chunks) { payload.set(c, off); off += c.length; }
console.log(`payload: ${payload.length} bytes, opcode_offset_1 = 0x${payload[1].toString(16)} (expect 0x33)`);

// Decode payload (reference impl uses camelCase keys)
const decoded = decodeSwapRoute(payload);
console.log(`decoded:`);
console.log(`  nHops: ${decoded.nHops}`);
console.log(`  traderInputAssetId: ${bytesToHex(decoded.traderInputAssetId)}`);
console.log(`  traderOutputAssetId: ${bytesToHex(decoded.traderOutputAssetId)}`);
console.log(`  minOut: ${decoded.minOut}`);
console.log(`  expiryHeight: ${decoded.expiryHeight}`);
console.log(`  traderPubkey: ${bytesToHex(decoded.traderPubkey)}`);
console.log(`  hops:`);
for (let i = 0; i < decoded.hops.length; i++) {
  const h = decoded.hops[i];
  console.log(`    [${i}] poolId=${bytesToHex(h.poolId).slice(0, 16)}… direction=${h.direction} fee=${h.feeBps} R_A_pre=${h.R_A_pre} R_B_pre=${h.R_B_pre} dAm=${h.deltaANetMag} dBm=${h.deltaBNetMag}`);
}
console.log(`  traderInputOutpoint: ${bytesToHex(decoded.traderInputOutpointTxid)}:${decoded.traderInputOutpointVout}`);
console.log(`  cInSecp: ${bytesToHex(decoded.cInSecp)}`);
console.log(`  cReceiptSecp: ${bytesToHex(decoded.cReceiptSecp)}`);
console.log(`  rReceipt: ${bytesToHex(decoded.rReceipt)}`);
console.log(`  range_proof_len: ${decoded.rangeProof.length}`);

// Now fetch the on-chain Pedersen commitment of the input UTXO via worker
const inputTxidLE = bytesToHex(decoded.traderInputOutpointTxid.slice().reverse());
const inputVout = decoded.traderInputOutpointVout;
console.log(`\nfetching input outpoint commitment via mempool.space-style txid: ${inputTxidLE}:${inputVout}`);

const ab_pool = await jget(`${WORKER}/amm/pool/${bytesToHex(decoded.hops[0].poolId)}?network=${NETWORK}`);
const bc_pool = await jget(`${WORKER}/amm/pool/${bytesToHex(decoded.hops[1].poolId)}?network=${NETWORK}`);
console.log(`\npool AB at worker: R_A=${ab_pool.reserve_a} R_B=${ab_pool.reserve_b} fee=${ab_pool.fee_bps} validation=${ab_pool.validation}`);
console.log(`pool BC at worker: R_A=${bc_pool.reserve_a} R_B=${bc_pool.reserve_b} fee=${bc_pool.fee_bps} validation=${bc_pool.validation}`);

// Snapshot for the reference validator
const pools = new Map([
  [bytesToHex(decoded.hops[0].poolId), {
    asset_A: hexToBytes(ab_pool.asset_a),
    asset_B: hexToBytes(ab_pool.asset_b),
    reserve_A: BigInt(ab_pool.reserve_a),
    reserve_B: BigInt(ab_pool.reserve_b),
    fee_bps: ab_pool.fee_bps,
    tradable: true,
  }],
  [bytesToHex(decoded.hops[1].poolId), {
    asset_A: hexToBytes(bc_pool.asset_a),
    asset_B: hexToBytes(bc_pool.asset_b),
    reserve_A: BigInt(bc_pool.reserve_a),
    reserve_B: BigInt(bc_pool.reserve_b),
    fee_bps: bc_pool.fee_bps,
    tradable: true,
  }],
]);

// Decode the carve's T_CXFER_BPP envelope using the dapp's own decoder
// (jsdom-bootstrap so the dapp module loads under node).
import { JSDOM } from 'jsdom';
const _dom = new JSDOM('<!doctype html>', { url: 'http://localhost/' });
globalThis.window = _dom.window;
globalThis.document = _dom.window.document;
globalThis.localStorage = _dom.window.localStorage;
globalThis.location = _dom.window.location;
globalThis.navigator = _dom.window.navigator;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');
const dapp = await import('../dapp/tacit.js');

const carve = await jget(`${ESPLORA}/tx/${inputTxidLE}`);
console.log(`\ncarve tx: ${inputTxidLE.slice(0, 16)}…  block ${carve.status.block_height}`);
const carveScript = hexToBytes(carve.vin[0].witness[1]);
const carveDecoded = dapp.decodeEnvelopeScript(carveScript);
if (!carveDecoded) throw new Error('carve envelope decode failed');
console.log(`  carve envelope opcode: 0x${carveDecoded.payload[0].toString(16)} (expect 0x22 = T_CXFER_BPP, or 0x23 = T_CXFER)`);
const carveType = carveDecoded.payload[0] === 0x22 ? 'bpp' : 'classic';
const cxDecoded = carveType === 'bpp'
  ? dapp.decodeCXferBppPayload(carveDecoded.payload)
  : dapp.decodeCXferPayload(carveDecoded.payload);
if (!cxDecoded) throw new Error(`failed to decode carve ${carveType}`);
console.log(`  carve asset_id: ${bytesToHex(cxDecoded.assetId)}`);
console.log(`  carve outputs: ${cxDecoded.outputs.length}`);
for (let i = 0; i < cxDecoded.outputs.length; i++) {
  console.log(`    [${i}] commitment=${bytesToHex(cxDecoded.outputs[i].commitment)}`);
}
const out0_commit = bytesToHex(cxDecoded.outputs[0].commitment);
const asset_id = bytesToHex(cxDecoded.assetId);
console.log(`  envelope cInSecp:         ${bytesToHex(decoded.cInSecp)}`);
if (out0_commit === bytesToHex(decoded.cInSecp)) {
  console.log(`  ✓ MATCH — cInSecp matches the carve's vout[0] commitment`);
} else {
  console.log(`  ✗ MISMATCH — cInSecp would fail the worker's commitmentForUtxo check`);
}

// Trivial BP verify stub — we know dapp builds m=2 over (ZERO, C_receipt).
const opReturnData = hexToBytes(route_tx.vout[0].scriptpubkey.slice(4));
console.log(`opReturnData: ${bytesToHex(opReturnData)} (from tx.vout[0])`);

// Run the reference validator
console.log(`\nrunning reference validator against on-chain payload + worker pool snapshots…`);
const result = validateSwapRoute({
  payload,
  pools,
  currentHeight: route_tx.status.block_height,
  opReturnData,
  inputCommitment: hexToBytes(out0_commit),
  bulletproofVerify: () => true,  // stub — we're isolating which non-BP gate fails
});
console.log(`reference validator (BP stubbed true): ${result.valid ? '✓ ACCEPT' : `✗ REJECT: ${result.reason}`}`);
if (!result.valid) {
  console.log(`\n⇒ The on-chain route is REJECTED by the reference validator.`);
  console.log(`⇒ Worker is likely failing the same gate.`);
}
