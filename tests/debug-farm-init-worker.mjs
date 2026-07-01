// Local debug replay of the worker's T_FARM_INIT chain-scan branch.
// Fetches a confirmed FARM_INIT tx from mempool.space, runs each validator
// step from the worker code, and reports which check rejects.

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

// Import the worker's actual decoders + helpers (exported for tests)
const w = await import('../worker/src/index.js');
const {
  T_FARM_INIT,
  AMM_FARM_MIN_REWARD_TOTAL, AMM_FARM_MAX_START_DELAY,
  decodeTFarmInitPayload, ammDeriveFarmId,
  ammFarmKey,
  verifySchnorr, decodeEnvelopeScript,
  commitmentForUtxo, ammKernelMsgV1,
  compressedPointFromHex,
  bpRangeAggVerify,
} = w;

const FARM_INIT_TXID = '44546a18b803ae41e88841e5c26333cb536b130a11589026c5256e99a740dcd5';

async function fetchTx(txid) {
  const r = await fetch(`https://mempool.space/signet/api/tx/${txid}`);
  if (!r.ok) throw new Error(`tx not found: ${txid}`);
  return await r.json();
}

const tx = await fetchTx(FARM_INIT_TXID);
const h = tx.status?.block_height;
console.log(`FARM_INIT tx ${FARM_INIT_TXID.slice(0,16)}… confirmed block ${h}`);
console.log(`  vin[1] (launcher input): ${tx.vin[1].txid.slice(0,16)}…:${tx.vin[1].vout}`);
console.log(`  vout[0] OP_RETURN: ${tx.vout[0].scriptpubkey.slice(0,60)}…`);

// Extract envelope payload from vin[0].witness[1] via the worker's decoder
const witnessHex = tx.vin[0].witness[1];
const witnessBytes = hexToBytes(witnessHex);
// The worker uses decodeEnvelopeScript via its internal `decodeEnvelopeScript` —
// re-implementing inline to avoid module-load complexity:
// Wire: <push 32><xonly><OP_CHECKSIG><OP_FALSE><OP_IF>
//   <push "TACIT"><push version><push payload-chunk-1>[...]<OP_ENDIF>
function decodeEnvelope(script) {
  let p = 0;
  if (script[p] !== 32) return null; p += 1;
  p += 32;                          // skip xonly
  if (script[p] !== 0xac) return null; p += 1;   // OP_CHECKSIG
  if (script[p] !== 0x00) return null; p += 1;   // OP_FALSE
  if (script[p] !== 0x63) return null; p += 1;   // OP_IF
  const pushes = [];
  while (p < script.length) {
    if (script[p] === 0x68) break;  // OP_ENDIF
    const op = script[p]; p += 1;
    let data;
    if (op >= 1 && op <= 75) { data = script.slice(p, p + op); p += op; }
    else if (op === 0x4c) { const ln = script[p]; p += 1; data = script.slice(p, p + ln); p += ln; }
    else if (op === 0x4d) { const ln = script[p] | (script[p+1] << 8); p += 2; data = script.slice(p, p + ln); p += ln; }
    else if (op === 0x4e) { const ln = script[p] | (script[p+1] << 8) | (script[p+2] << 16) | (script[p+3] << 24); p += 4; data = script.slice(p, p + ln); p += ln; }
    else { return null; }
    pushes.push(data);
  }
  if (pushes.length < 3) return null;
  // pushes[0] = "TACIT", pushes[1] = version byte, pushes[2..] = payload chunks
  const magic = new TextDecoder().decode(pushes[0]);
  if (magic !== 'TACIT') return null;
  const payload = concatBytes(...pushes.slice(2));
  return { magic, version: pushes[1][0], payload };
}
const env = decodeEnvelope(witnessBytes);
if (!env) { console.log('FAIL: envelope decode failed'); process.exit(1); }
console.log(`  envelope payload: ${env.payload.length} bytes, opcode=0x${env.payload[1].toString(16)}`);
const payload = env.payload;

// Run worker's decoder
console.log('\n=== Step 1: decodeTFarmInitPayload ===');
const fi = decodeTFarmInitPayload(payload);
if (!fi) { console.log('  ✗ REJECT: decoder returned null'); process.exit(1); }
console.log('  ✓ decoded:');
console.log('    pool_id:', fi.pool_id.slice(0,16) + '…');
console.log('    launcher_pubkey:', fi.launcher_pubkey.slice(0,16) + '…');
console.log('    reward_asset_id:', fi.reward_asset_id.slice(0,16) + '…');
console.log('    reward_total:', fi.reward_total);
console.log('    reward_per_block:', fi.reward_per_block);
console.log('    start_height:', fi.start_height);
console.log('    end_height:', fi.end_height);
console.log('    c_change_or_sentinel:', fi.c_change_or_sentinel.slice(0,16) + '…');

// Step 2: OP_RETURN binding
console.log('\n=== Step 2: OP_RETURN binding ===');
const opReturnSpk = tx.vout[0].scriptpubkey.toLowerCase();
console.log('  vout[0].scriptpubkey length:', opReturnSpk.length);
if (opReturnSpk.length !== 68) { console.log('  ✗ REJECT: not 68 hex chars'); process.exit(1); }
if (!opReturnSpk.startsWith('6a20')) { console.log('  ✗ REJECT: not 6a20 prefix'); process.exit(1); }
const opReturnHash = hexToBytes(opReturnSpk.slice(4));
const expectedHash = sha256(payload);
const match = bytesToHex(opReturnHash) === bytesToHex(expectedHash);
console.log('  expected SHA256(payload):', bytesToHex(expectedHash).slice(0,16) + '…');
console.log('  actual OP_RETURN hash:   ', bytesToHex(opReturnHash).slice(0,16) + '…');
if (!match) { console.log('  ✗ REJECT: OP_RETURN ≠ SHA256(payload)'); process.exit(1); }
console.log('  ✓ OP_RETURN binds payload');

// Step 3: Pool lookup (via worker endpoint)
console.log('\n=== Step 3: Pool registered ===');
const poolR = await fetch(`https://api.tacit.finance/amm/pool/${fi.pool_id}?network=signet`);
const farmPool = await poolR.json();
if (farmPool.error) { console.log('  ✗ REJECT: pool not registered'); process.exit(1); }
console.log('  ✓ pool registered, validation:', farmPool.validation);
if (farmPool.validation !== 'verified' && farmPool.validation !== 'xcurve-verified') {
  console.log('  ✗ REJECT: pool not verified');
  process.exit(1);
}

// Step 4: Schedule sanity
console.log('\n=== Step 4: Schedule sanity ===');
const rewardTotal = BigInt(fi.reward_total);
const rewardPerBlock = BigInt(fi.reward_per_block);
if (rewardPerBlock === 0n) { console.log('  ✗ rewardPerBlock == 0'); process.exit(1); }
if (rewardTotal < AMM_FARM_MIN_REWARD_TOTAL) { console.log('  ✗ rewardTotal < min'); process.exit(1); }
if (rewardTotal % rewardPerBlock !== 0n) { console.log('  ✗ not divisible'); process.exit(1); }
const initLock = farmPool.amm_initial_lp_lock_blocks ?? 6;
const initHeight = farmPool.init_height || 0;
if (fi.start_height < initHeight + initLock) {
  console.log(`  ✗ start_height (${fi.start_height}) < init_height+lock (${initHeight + initLock})`);
  process.exit(1);
}
if (fi.start_height < h + 3) {
  console.log(`  ✗ start_height (${fi.start_height}) < h+3 (${h + 3})`);
  process.exit(1);
}
if (fi.start_height > h + AMM_FARM_MAX_START_DELAY) {
  console.log(`  ✗ start_height too far future`);
  process.exit(1);
}
const durationBlocks = rewardTotal / rewardPerBlock;
const expectedEnd = fi.start_height + Number(durationBlocks);
if (fi.end_height !== expectedEnd) {
  console.log(`  ✗ end_height ${fi.end_height} != expected ${expectedEnd}`);
  process.exit(1);
}
console.log('  ✓ schedule passes all gates');
console.log(`    confirmation height h=${h}, start_height=${fi.start_height}, end_height=${fi.end_height}`);
console.log(`    pool.init_height=${initHeight}, lock=${initLock}`);

// Step 5: launcher_sig
console.log('\n=== Step 5: launcher_sig verify ===');
const farmIdBytes = ammDeriveFarmId(
  hexToBytes(fi.pool_id),
  hexToBytes(fi.launcher_pubkey),
  hexToBytes(fi.reward_asset_id),
  hexToBytes(fi.farm_nonce),
);
console.log('  derived farm_id:', bytesToHex(farmIdBytes).slice(0,16) + '…');

const dom_ = new TextEncoder().encode('tacit-amm-farm-init-v1');
const initMsgBuf = new Uint8Array(dom_.length + 32 + 33 + 8 + 8 + 4 + 4);
let p = 0;
initMsgBuf.set(dom_, p); p += dom_.length;
initMsgBuf.set(farmIdBytes, p); p += 32;
initMsgBuf.set(hexToBytes(fi.launcher_pubkey), p); p += 33;
new DataView(initMsgBuf.buffer).setBigUint64(p, rewardTotal, true); p += 8;
new DataView(initMsgBuf.buffer).setBigUint64(p, rewardPerBlock, true); p += 8;
new DataView(initMsgBuf.buffer).setUint32(p, fi.start_height, true); p += 4;
new DataView(initMsgBuf.buffer).setUint32(p, fi.end_height, true); p += 4;
console.log('  init_msg buf length:', initMsgBuf.length);
const initMsg = sha256(initMsgBuf);
console.log('  init_msg hash:', bytesToHex(initMsg).slice(0,16) + '…');

const launcherXOnly = hexToBytes(fi.launcher_pubkey).slice(1);
let launcherOk = false;
try {
  launcherOk = verifySchnorr(hexToBytes(fi.launcher_sig), initMsg, launcherXOnly);
} catch (e) {
  console.log('  ✗ verify threw:', e.message);
}
console.log('  launcher_sig verify:', launcherOk ? '✓ PASS' : '✗ FAIL');
if (!launcherOk) {
  console.log('\n  >>> ROOT CAUSE: launcher_sig fails. Check msg-byte construction divergence.');
  console.log('  msg preimage bytes (hex):', bytesToHex(initMsgBuf));
  process.exit(1);
}

// Step 6: commitmentForUtxo lookup on vin[1] (launcher's reward-asset UTXO)
console.log('\n=== Step 6: commitmentForUtxo(vin[1]) ===');
const launcherInp = tx.vin[1];
console.log(`  vin[1]: ${launcherInp.txid.slice(0,16)}…:${launcherInp.vout}`);
// Need a mock env shaped like Cloudflare Workers env with KV bindings.
// The worker checks REGISTRY_KV.get(...) for indexed asset hint keys.
// Easiest: just hit the worker's debug endpoint if there is one; otherwise
// inspect the parent tx and see if our reward asset_id is indexed for it.
const PROD_WORKER = process.env.TACIT_WORKER_BASE || process.env.WORKER_BASE || 'https://api.tacit.finance';
const parentRes = await fetch(`${PROD_WORKER}/asset/utxo/${launcherInp.txid}/${launcherInp.vout}?network=signet`);
console.log(`  /asset/utxo response: ${parentRes.status}`);
if (parentRes.ok) {
  const parentInfo = await parentRes.json();
  console.log('  parent record:', JSON.stringify(parentInfo).slice(0, 200));
  if (parentInfo.asset_id) {
    console.log(`  parent asset_id: ${parentInfo.asset_id.slice(0,16)}… (expected: ${fi.reward_asset_id.slice(0,16)}…)`);
    if (parentInfo.asset_id !== fi.reward_asset_id) {
      console.log('  ✗ REJECT: parent asset_id mismatch');
    } else {
      console.log('  ✓ parent asset_id matches reward asset');
    }
  }
} else {
  console.log(`  ${await parentRes.text()}`);
}

// Also check what tx vin[1] resolves to (parent tx of the launcher UTXO)
console.log('\n=== Step 6b: parent tx inspection ===');
const parentTxRes = await fetch(`https://mempool.space/signet/api/tx/${launcherInp.txid}`);
if (parentTxRes.ok) {
  const parentTx = await parentTxRes.json();
  console.log(`  parent tx confirmed at block: ${parentTx.status?.block_height || 'mempool'}`);
  console.log(`  parent vout count: ${parentTx.vout?.length || 0}`);
  if (parentTx.vout?.[0]?.scriptpubkey?.startsWith('6a')) {
    console.log(`  parent vout[0] is OP_RETURN (likely an envelope): ${parentTx.vout[0].scriptpubkey.slice(0,20)}…`);
  }
  // Look at vin[0].witness[1] for envelope opcode
  if (parentTx.vin?.[0]?.witness?.[1]) {
    const pWitness = hexToBytes(parentTx.vin[0].witness[1]);
    const pEnv = decodeEnvelope(pWitness);
    if (pEnv) {
      console.log(`  parent envelope payload[0..5]: ${bytesToHex(pEnv.payload.slice(0,5))}`);
      console.log(`  parent envelope payload len: ${pEnv.payload.length}`);
    }
  }
  console.log(`  parent vout[0].scriptpubkey: ${parentTx.vout[0]?.scriptpubkey?.slice(0,80) || 'n/a'}`);
  console.log(`  parent vout[1] value: ${parentTx.vout[1]?.value} sats`);
  console.log(`  parent vout[1].scriptpubkey type: ${parentTx.vout[1]?.scriptpubkey_type}`);
}
