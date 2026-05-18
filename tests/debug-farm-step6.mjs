// Local replay of step 6 — commitmentForUtxo on the launcher's vin[1] parent.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

const w = await import('../worker/src/index.js');
const { decodeEnvelopeScript, T_CXFER_BPP, verifySchnorr, ammKernelMsgV1, compressedPointFromHex, bpRangeAggVerify, decodeTFarmInitPayload } = w;

const FARM_INIT_TXID = '44546a18b803ae41e88841e5c26333cb536b130a11589026c5256e99a740dcd5';
const PARENT_TXID = '39c5148dc13c373d5a03287793bcc8e8db81633e14a02b85b03d4c19db85fed3';
const PARENT_VOUT = 0;

async function fetchTx(txid) {
  const r = await fetch(`https://mempool.space/signet/api/tx/${txid}`);
  return await r.json();
}

const parentTx = await fetchTx(PARENT_TXID);
console.log('parent witness count:', parentTx.vin[0].witness.length);
const env = decodeEnvelopeScript(hexToBytes(parentTx.vin[0].witness[1]));
console.log('parent envelope opcode: 0x' + env.opcode.toString(16), 'payload len:', env.payload.length);
console.log('decoded.opcode === T_CXFER_BPP?', env.opcode === T_CXFER_BPP);

// Find decoder via worker
const { decodeCXferBppPayload } = w;
console.log('decodeCXferBppPayload available?', typeof decodeCXferBppPayload);
if (typeof decodeCXferBppPayload === 'function') {
  const dec = decodeCXferBppPayload(env.payload);
  if (!dec) {
    console.log('✗ decodeCXferBppPayload returned null');
  } else {
    console.log('✓ decodeCXferBppPayload:');
    console.log('  asset_id:', dec.asset_id?.slice(0, 16) + '…');
    console.log('  outputs:', dec.outputs?.length);
    if (dec.outputs?.[PARENT_VOUT]) {
      console.log('  outputs[' + PARENT_VOUT + '].commitment:', dec.outputs[PARENT_VOUT].commitment?.slice(0,16) + '…');
    }
  }
}

// Now compute the kernel-verify point and check if the FARM_INIT's kernel_sig verifies
const farmTx = await fetchTx(FARM_INIT_TXID);
const farmEnv = decodeEnvelopeScript(hexToBytes(farmTx.vin[0].witness[1]));
const fi = decodeTFarmInitPayload(farmEnv.payload);
console.log('\n=== FARM_INIT kernel-sig replay ===');
console.log('reward_total:', fi.reward_total);
console.log('c_change_or_sentinel:', fi.c_change_or_sentinel.slice(0,16) + '…');
console.log('kernel_sig:', fi.kernel_sig.slice(0,16) + '…');

const dec = decodeCXferBppPayload(env.payload);
const parentCommit = dec.outputs[PARENT_VOUT].commitment;
console.log('parent commit:', parentCommit.slice(0,16) + '…');
console.log('parent asset_id:', dec.asset_id.slice(0,16) + '…');
console.log('matches reward_asset_id?', dec.asset_id === fi.reward_asset_id);

// === Step 7: Kernel-sig verify ===
console.log('\n=== Step 7: Kernel-sig verify ===');
const isSentinel = fi.c_change_or_sentinel === '00'.repeat(33);
console.log('is sentinel?', isSentinel);
const rewardTotal = BigInt(fi.reward_total);
const kernelMsg = ammKernelMsgV1(
  hexToBytes(fi.reward_asset_id),
  [{ txid: PARENT_TXID, vout: PARENT_VOUT }],
  [hexToBytes(fi.c_change_or_sentinel)],
  rewardTotal,
);
console.log('kernel_msg hash:', bytesToHex(kernelMsg).slice(0,16) + '…');

// Need PEDERSEN_ZERO, PEDERSEN_H — reconstruct
import * as secp from '@noble/secp256k1';
const PZ = secp.ProjectivePoint.ZERO;
// PEDERSEN_H is the worker's H point. Let's import it via worker pedersenCommit fn.
const { pedersenCommit, modN } = w;
// pedersenCommit(0, 0) === ZERO. pedersenCommit(1, 0) === H. So derive H.
const H = pedersenCommit(1n, 0n);

const cIn = compressedPointFromHex(parentCommit);
const cChangeOrZero = isSentinel ? PZ : compressedPointFromHex(fi.c_change_or_sentinel);
const burnedH = rewardTotal === 0n ? PZ : H.multiply(rewardTotal);
const Pfi = cChangeOrZero.add(cIn.negate()).add(burnedH);
console.log('Pfi == ZERO?', Pfi.equals(PZ));

if (!Pfi.equals(PZ)) {
  const ok = verifySchnorr(
    hexToBytes(fi.kernel_sig), kernelMsg,
    Pfi.toRawBytes(true).slice(1),
  );
  console.log('kernel_sig verify:', ok ? '✓ PASS' : '✗ FAIL');
}

// === Step 8: Bulletproof m=1 over c_change_or_sentinel ===
console.log('\n=== Step 8: Bulletproof verify ===');
const cChangePt = isSentinel ? PZ : compressedPointFromHex(fi.c_change_or_sentinel);
if (cChangePt.equals(PZ)) {
  console.log('range_proof len:', fi.range_proof.length);
  console.log('bp accept (sentinel): range_proof.length > 0?', fi.range_proof.length > 0);
} else {
  const ok = bpRangeAggVerify([cChangePt], hexToBytes(fi.range_proof));
  console.log('bp verify:', ok ? '✓ PASS' : '✗ FAIL');
}
