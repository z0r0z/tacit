// Validator robustness sweep.
//
// Every validator entry point (validateLpAdd / validateLpRemove /
// validateSwapBatch / validateSwapVar / validateProtocolFeeClaim) has
// the contract `(...args) → {valid: true, ...} | {valid: false, reason}`.
// Throwing instead of returning is a contract violation — calling code
// that branches on `r.valid` will instead crash, and the indexer's
// pipeline will halt mid-block.
//
// This test passes adversarial / malformed inputs to every validator
// and asserts the contract holds: the result is always an object with
// `valid: false` (or `valid: true` for honest paths), never an unhandled
// throw.
//
// Found in this audit series: same-asset POOL_INIT threw inside
// derivePoolId; wrong-length minLiqOutput threw inside
// decryptMinLiqAmount. Both fixed; this sweep is the regression
// backstop and a forward-looking catch-net.
//
// Run: `node amm-validator-robustness.test.mjs`

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';

import {
  validateLpAdd as _validateLpAdd, validateLpRemove as _validateLpRemove,
  validateSwapBatch, validateSwapVar,
  validateProtocolFeeClaim,
  SKIP_GROTH16_VERIFY_UNSAFE, SKIP_MIN_LIQ_VERIFY_UNSAFE,
  SKIP_OP_RETURN_VERIFY_UNSAFE,
} from './amm-validator.mjs';
import { encodeSwapVar } from './swap-var.mjs';

function validateLpAdd(args) {
  return _validateLpAdd({ opReturnData: SKIP_OP_RETURN_VERIFY_UNSAFE, ...args });
}
function validateLpRemove(args) {
  return _validateLpRemove({ opReturnData: SKIP_OP_RETURN_VERIFY_UNSAFE, ...args });
}

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}: ${typeof ok === 'object' ? JSON.stringify(ok) : ok}`); fail++; }
  } catch (e) {
    // Catch escaping throws — this is the contract violation we're looking for.
    console.log(`  FAIL  ${label}: VALIDATOR THREW: ${e.message}`);
    fail++;
  }
}

// Run a validator call and assert it returns a {valid: false, reason: string}
// (never throws). The `label` prefix is shared across mutation flavors.
function assertRejects(label, fn) {
  test(label, () => {
    const r = fn();
    if (r === undefined || r === null) return `returned ${r} (expected {valid: false})`;
    if (typeof r !== 'object') return `returned non-object ${typeof r}`;
    if (r.valid !== false) return `expected valid=false, got valid=${r.valid}`;
    if (typeof r.reason !== 'string') return `expected reason: string, got reason=${typeof r.reason}`;
    return true;
  });
}

const DUMMY_POOL_ID = sha256(new TextEncoder().encode('dummy-pool'));
const DUMMY_ASSET_A = new Uint8Array(32).fill(0x01);
const DUMMY_ASSET_B = new Uint8Array(32).fill(0x02);
const ZERO_33 = new Uint8Array(33);
const ZERO_32 = new Uint8Array(32);
const ZERO_64 = new Uint8Array(64);
const ZERO_8 = new Uint8Array(8);
const ZERO_20 = new Uint8Array(20);

// ============================================================
// validateLpAdd: malformed inputs
// ============================================================

console.log('validateLpAdd — robustness sweep');

assertRejects('empty payload', () => validateLpAdd({
  payload: new Uint8Array(0), pool: null,
  inputCommitmentsA: [], inputCommitmentsB: [],
  inputsA: [], inputsB: [],
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
  currentHeight: 0,
  minLiqOutput: SKIP_MIN_LIQ_VERIFY_UNSAFE,
}));

assertRejects('wrong opcode byte', () => validateLpAdd({
  payload: new Uint8Array([0xFF, 0, ...new Uint8Array(64), ...new Uint8Array(8)]),
  pool: null,
  inputCommitmentsA: [], inputCommitmentsB: [],
  inputsA: [], inputsB: [],
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
  currentHeight: 0,
  minLiqOutput: SKIP_MIN_LIQ_VERIFY_UNSAFE,
}));

assertRejects('truncated payload (1 byte)', () => validateLpAdd({
  payload: new Uint8Array([0x2D]),
  pool: null,
  inputCommitmentsA: [], inputCommitmentsB: [],
  inputsA: [], inputsB: [],
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
  currentHeight: 0,
  minLiqOutput: SKIP_MIN_LIQ_VERIFY_UNSAFE,
}));

assertRejects('truncated payload (partial fields)', () => validateLpAdd({
  payload: new Uint8Array(100),                      // opcode 0x00 (wrong) + bytes
  pool: null,
  inputCommitmentsA: [], inputCommitmentsB: [],
  inputsA: [], inputsB: [],
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
  currentHeight: 0,
  minLiqOutput: SKIP_MIN_LIQ_VERIFY_UNSAFE,
}));

// ============================================================
// validateLpRemove: malformed inputs
// ============================================================

console.log('\nvalidateLpRemove — robustness sweep');

assertRejects('empty payload + null pool', () => validateLpRemove({
  payload: new Uint8Array(0),
  pool: null,
  lpInputCommitments: [], lpInputs: [],
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
}));

assertRejects('empty payload + dummy pool', () => validateLpRemove({
  payload: new Uint8Array(0),
  pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
          reserve_A: 1000n, reserve_B: 1000n, lp_total_shares: 1000n,
          fee_bps: 30, protocol_fee_address: ZERO_33, protocol_fee_bps: 0 },
  lpInputCommitments: [], lpInputs: [],
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
}));

assertRejects('garbage payload bytes', () => validateLpRemove({
  payload: new Uint8Array(500).fill(0xAA),
  pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
          reserve_A: 1000n, reserve_B: 1000n, lp_total_shares: 1000n,
          fee_bps: 30, protocol_fee_address: ZERO_33, protocol_fee_bps: 0 },
  lpInputCommitments: [], lpInputs: [],
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
}));

// ============================================================
// validateSwapBatch: malformed inputs
// ============================================================

console.log('\nvalidateSwapBatch — robustness sweep');

assertRejects('empty payload + null pool', () => validateSwapBatch({
  payload: new Uint8Array(0),
  pool: null,
  opReturnData: new Uint8Array(32),
  inputCommitmentsByIntent: [],
  intentInputUtxos: [],
  receiveScripts: [],
  currentHeight: 0,
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
}));

assertRejects('null opReturnData', () => validateSwapBatch({
  payload: new Uint8Array(1000).fill(0x2F),
  pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
          reserve_A: 1000n, reserve_B: 1000n, lp_total_shares: 1000n,
          fee_bps: 30, capability_flags: 0x02 },
  opReturnData: null,
  inputCommitmentsByIntent: [],
  intentInputUtxos: [],
  receiveScripts: [],
  currentHeight: 0,
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
}));

assertRejects('wrong-length opReturnData (16 bytes)', () => validateSwapBatch({
  payload: new Uint8Array(1000).fill(0x2F),
  pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
          reserve_A: 1000n, reserve_B: 1000n, lp_total_shares: 1000n,
          fee_bps: 30, capability_flags: 0x02 },
  opReturnData: new Uint8Array(16),
  inputCommitmentsByIntent: [],
  intentInputUtxos: [],
  receiveScripts: [],
  currentHeight: 0,
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
}));

assertRejects('garbage payload (200 bytes of 0x2F)', () => validateSwapBatch({
  payload: new Uint8Array(200).fill(0x2F),
  pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
          reserve_A: 1000n, reserve_B: 1000n, lp_total_shares: 1000n,
          fee_bps: 30, capability_flags: 0x02 },
  opReturnData: new Uint8Array(32),
  inputCommitmentsByIntent: [],
  intentInputUtxos: [],
  receiveScripts: [],
  currentHeight: 0,
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
}));

// ============================================================
// validateSwapVar: malformed inputs
// ============================================================

console.log('\nvalidateSwapVar — robustness sweep');

assertRejects('empty payload + null pool', () => validateSwapVar({
  payload: new Uint8Array(0),
  pool: null,
  opReturnData: ZERO_32,
  assetInputOutpointTxid: '00'.repeat(32),
  assetInputOutpointVout: 0,
  currentHeight: 0,
  receiveScriptPubKey: new Uint8Array(22),
  bulletproofVerify: () => true,
  inputCommitment: ZERO_33,
}));

assertRejects('truncated payload + dummy pool', () => validateSwapVar({
  payload: new Uint8Array(50),
  pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
          reserve_A: 1000n, reserve_B: 1000n, fee_bps: 30 },
  opReturnData: ZERO_32,
  assetInputOutpointTxid: '00'.repeat(32),
  assetInputOutpointVout: 0,
  currentHeight: 0,
  receiveScriptPubKey: new Uint8Array(22),
  bulletproofVerify: () => true,
  inputCommitment: ZERO_33,
}));

assertRejects('wrong opcode in payload', () => {
  // Build a real-shape payload but with wrong opcode byte.
  const p = new Uint8Array(300);
  p[0] = 0x01;                                                    // version
  p[1] = 0xFF;                                                    // bad opcode
  return validateSwapVar({
    payload: p,
    pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
            reserve_A: 1000n, reserve_B: 1000n, fee_bps: 30 },
    opReturnData: ZERO_32,
    assetInputOutpointTxid: '00'.repeat(32),
    assetInputOutpointVout: 0,
    currentHeight: 0,
    receiveScriptPubKey: new Uint8Array(22),
    bulletproofVerify: () => true,
    inputCommitment: ZERO_33,
  });
});

// ============================================================
// validateProtocolFeeClaim: malformed inputs
// ============================================================

console.log('\nvalidateProtocolFeeClaim — robustness sweep');

assertRejects('empty payload + null pool', () => validateProtocolFeeClaim({
  payload: new Uint8Array(0),
  pool: null,
}));

assertRejects('garbage payload + dummy pool', () => validateProtocolFeeClaim({
  payload: new Uint8Array(200).fill(0x31),
  pool: { pool_id: DUMMY_POOL_ID, lp_asset_id: ZERO_32,
          reserve_A: 1000n, reserve_B: 1000n, lp_total_shares: 1000n,
          fee_bps: 30,
          protocol_fee_address: ZERO_33, protocol_fee_bps: 0,
          protocol_fee_accrued: 0n, k_last: 1_000_000n },
}));

// ============================================================
// Required-parameter contract checks (these are designed to THROW
// rather than return {valid: false}, since they catch caller bugs
// before any envelope state is touched; we assert the throw is a
// helpful diagnostic, not a runtime crash)
// ============================================================

console.log('\nRequired-parameter contract — throws with helpful message');

function assertThrowsWith(label, regex, fn) {
  test(label, () => {
    try { fn(); return 'expected throw, got return'; }
    catch (e) {
      if (!regex.test(e.message)) return `wrong message: ${e.message}`;
      return true;
    }
  });
}

assertThrowsWith('validateLpAdd without groth16Verify', /groth16Verify is required/, () => validateLpAdd({
  payload: new Uint8Array(0), pool: null,
  inputCommitmentsA: [], inputCommitmentsB: [],
  inputsA: [], inputsB: [],
  // groth16Verify omitted
  currentHeight: 0,
  minLiqOutput: SKIP_MIN_LIQ_VERIFY_UNSAFE,
}));

assertThrowsWith('validateLpAdd without currentHeight', /currentHeight/, () => validateLpAdd({
  payload: new Uint8Array(0), pool: null,
  inputCommitmentsA: [], inputCommitmentsB: [],
  inputsA: [], inputsB: [],
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
  // currentHeight omitted
  minLiqOutput: SKIP_MIN_LIQ_VERIFY_UNSAFE,
}));

assertThrowsWith('validateSwapVar without inputCommitment', /inputCommitment is required/, () => {
  // Build a minimally well-shaped payload that gets past the pool / OP_RETURN
  // checks so we reach the inputCommitment-required throw.
  const tracerPriv = new Uint8Array(32).fill(0x11);
  const env = {
    poolId: DUMMY_POOL_ID, direction: 0,
    R_A_pre: 1000n, R_B_pre: 1000n,
    deltaIn: 100n, deltaInMin: 1n, deltaInMax: 1000n, deltaOut: 50n,
    minOut: 0n, tipAmount: 0n, tipAsset: 0,
    expiryHeight: 1_000_000, traderPubkey: new Uint8Array(33).fill(0x02),
    cInSecp: new Uint8Array(33).fill(0x02),
    cChangeOrSentinel: new Uint8Array(33),                       // sentinel
    cReceiptSecp: new Uint8Array(33).fill(0x02),
    rReceipt: ZERO_32,
    rangeProof: new Uint8Array(0),
    kernelSig: ZERO_64,
    intentSig: ZERO_64,
  };
  const payload = encodeSwapVar(env);
  return validateSwapVar({
    payload,
    pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
            reserve_A: 1000n, reserve_B: 1000n, fee_bps: 30 },
    opReturnData: sha256(payload),                                // satisfies envelope hash gate
    assetInputOutpointTxid: '00'.repeat(32),
    assetInputOutpointVout: 0,
    currentHeight: 0,
    receiveScriptPubKey: new Uint8Array(22),
    bulletproofVerify: () => true,
    // inputCommitment omitted ⇒ should throw at the required-param guard
  });
});

assertThrowsWith('validateSwapVar without bulletproofVerify', /bulletproofVerify is required/, () => validateSwapVar({
  payload: new Uint8Array(0),
  pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
          reserve_A: 1000n, reserve_B: 1000n, fee_bps: 30 },
  opReturnData: ZERO_32,
  assetInputOutpointTxid: '00'.repeat(32),
  assetInputOutpointVout: 0,
  currentHeight: 0,
  receiveScriptPubKey: new Uint8Array(22),
  // bulletproofVerify omitted
  inputCommitment: ZERO_33,
}));

// ============================================================
// Random fuzz: 1000 random byte sequences fed to each validator
// ============================================================
//
// Sweeps the broadest fuzz surface. Every result must be {valid:
// false, reason: string} or a typed throw from a required-parameter
// check — never a stack trace from inside the validator's body.

console.log('\nRandom-bytes fuzz (1000 inputs/validator)');

let fuzzSeed = 0xC0DEC0DE;
function fuzzBytes(len) {
  // Xorshift32 — deterministic per index
  let s = fuzzSeed++;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    out[i] = s & 0xff;
  }
  return out;
}

function runFuzz(label, n, factory) {
  let throwsEscaped = 0, returnedValid = 0, returnedInvalid = 0;
  for (let i = 0; i < n; i++) {
    const payload = fuzzBytes(50 + (i % 200));
    try {
      const r = factory(payload);
      if (r && r.valid === true) returnedValid++;
      else if (r && r.valid === false && typeof r.reason === 'string') returnedInvalid++;
      else throwsEscaped++;
    } catch (e) {
      throwsEscaped++;
    }
  }
  test(`${label}: ${n} fuzz inputs — no escaped throws`, () => {
    // Some random payloads may decode-cleanly and reach later checks;
    // those return {valid: false, reason}. The contract is: never a
    // bare throw. (Required-param throws are not exercised here since
    // we pass all params.)
    if (throwsEscaped > 0) return `${throwsEscaped} escaped throws (returnedInvalid=${returnedInvalid}, valid=${returnedValid})`;
    return true;
  });
}

runFuzz('validateLpAdd', 1000, (p) => validateLpAdd({
  payload: p, pool: null,
  inputCommitmentsA: [], inputCommitmentsB: [],
  inputsA: [], inputsB: [],
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
  currentHeight: 0,
  minLiqOutput: SKIP_MIN_LIQ_VERIFY_UNSAFE,
}));

runFuzz('validateLpRemove', 1000, (p) => validateLpRemove({
  payload: p,
  pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
          reserve_A: 1000n, reserve_B: 1000n, lp_total_shares: 1000n,
          fee_bps: 30, protocol_fee_address: ZERO_33, protocol_fee_bps: 0 },
  lpInputCommitments: [], lpInputs: [],
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
}));

runFuzz('validateSwapBatch', 1000, (p) => validateSwapBatch({
  payload: p,
  pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
          reserve_A: 1000n, reserve_B: 1000n, lp_total_shares: 1000n,
          fee_bps: 30, capability_flags: 0x02 },
  opReturnData: ZERO_32,
  inputCommitmentsByIntent: [],
  intentInputUtxos: [],
  receiveScripts: [],
  currentHeight: 0,
  groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
}));

runFuzz('validateSwapVar', 1000, (p) => validateSwapVar({
  payload: p,
  pool: { pool_id: DUMMY_POOL_ID, asset_A: DUMMY_ASSET_A, asset_B: DUMMY_ASSET_B,
          reserve_A: 1000n, reserve_B: 1000n, fee_bps: 30 },
  opReturnData: ZERO_32,
  assetInputOutpointTxid: '00'.repeat(32),
  assetInputOutpointVout: 0,
  currentHeight: 0,
  receiveScriptPubKey: new Uint8Array(22),
  bulletproofVerify: () => true,
  inputCommitment: ZERO_33,
}));

runFuzz('validateProtocolFeeClaim', 1000, (p) => validateProtocolFeeClaim({
  payload: p,
  pool: { pool_id: DUMMY_POOL_ID, lp_asset_id: ZERO_32,
          reserve_A: 1000n, reserve_B: 1000n, lp_total_shares: 1000n,
          fee_bps: 30,
          protocol_fee_address: ZERO_33, protocol_fee_bps: 0,
          protocol_fee_accrued: 0n, k_last: 1_000_000n },
}));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
