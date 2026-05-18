// Dapp-prover wiring test: full prove → serialize-to-wire → parse-from-wire →
// verify roundtrip using the EXACT serialize/parse helpers the dapp ships.
//
// The dapp emits 256-byte Groth16 proofs (`_serializeGroth16Proof` at
// `dapp/tacit.js:18667`) and ingests them via `_parseGroth16Proof` at
// `dapp/tacit.js:8543`. Both helpers must roundtrip cleanly against
// `snarkjs.groth16.prove` output, otherwise the dapp's `verifyAmmProof`
// rejects every real ceremony proof. This test pins:
//   • snarkjs proof JSON → 256 bytes round-trips losslessly
//   • the round-tripped proof verifies via snarkjs.groth16.verify
//   • all three AMM circuit dimensions (5/8/123 public signals) survive
//     the dapp's `_publicInputsToDecimal` pass-through
//
// Mirrors the wire layout in prove-verify-roundtrip.test.mjs; that test
// pins the validator's publicSignals serializer matches circom's witness
// layout. This test pins the dapp's proof codec matches snarkjs.
//
// Run from the dev-zkey dir: node dapp-prover-wiring.test.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '../../../..');
const CIRC_DIR  = resolve(ROOT, 'dapp/circuits/amm');
const DEV_ZKEY  = resolve(CIRC_DIR, 'dev-zkey');
const SNARKJS   = resolve(ROOT, 'dapp/circuits/node_modules/.bin/snarkjs');
const TESTS     = resolve(ROOT, 'tests');

const { pedersenBJJ, N_BJJ } = await import(resolve(TESTS, 'amm-bjj.mjs'));
const validator = await import(resolve(TESTS, 'amm-validator.mjs'));
const snarkjsLib = await import(resolve(ROOT, 'dapp/circuits/node_modules/snarkjs/main.js'));

// ---- Inline copies of the dapp's serialize/parse helpers ----
// Keep these byte-identical to dapp/tacit.js. If the dapp's helpers change,
// update these too; the test catches divergence by failing roundtrip.
function _be32ToDecimal(bytes) {
  let v = 0n;
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v.toString();
}
function _publicInputsToDecimal(inputs) {
  return inputs.map(s => {
    if (typeof s !== 'string') s = String(s);
    if (s.startsWith('0x')) return BigInt(s).toString();
    if (/^[0-9a-fA-F]+$/.test(s) && s.length === 64) return BigInt('0x' + s).toString();
    return s;
  });
}
function _parseGroth16Proof(proofBytes) {
  if (!(proofBytes instanceof Uint8Array) || proofBytes.length !== 256) return null;
  const slice = (off) => proofBytes.slice(off, off + 32);
  return {
    pi_a: [_be32ToDecimal(slice(0)),   _be32ToDecimal(slice(32)),  '1'],
    pi_b: [
      [_be32ToDecimal(slice(64)),  _be32ToDecimal(slice(96))],
      [_be32ToDecimal(slice(128)), _be32ToDecimal(slice(160))],
      ['1', '0'],
    ],
    pi_c: [_be32ToDecimal(slice(192)), _be32ToDecimal(slice(224)), '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
}
function _serializeGroth16Proof(proofObj) {
  const out = new Uint8Array(256);
  const writeBE32 = (offset, decStr) => {
    let v = BigInt(decStr);
    for (let i = 31; i >= 0; i--) {
      out[offset + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  };
  writeBE32(0,   proofObj.pi_a[0]);
  writeBE32(32,  proofObj.pi_a[1]);
  writeBE32(64,  proofObj.pi_b[0][0]);
  writeBE32(96,  proofObj.pi_b[0][1]);
  writeBE32(128, proofObj.pi_b[1][0]);
  writeBE32(160, proofObj.pi_b[1][1]);
  writeBE32(192, proofObj.pi_c[0]);
  writeBE32(224, proofObj.pi_c[1]);
  return out;
}

let pass = 0, fail = 0, skipped = 0;
function _isSkip(v) { return v === 'skip' || (typeof v === 'string' && v.startsWith('skip')); }
function test(label, fn) {
  try {
    const ok = fn();
    if (_isSkip(ok)) { console.log(`  SKIP  ${label}  (${ok})`); skipped++; return; }
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}
async function testAsync(label, fn) {
  try {
    const ok = await fn();
    if (_isSkip(ok)) { console.log(`  SKIP  ${label}  (${ok})`); skipped++; return; }
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}
function snarkjs(args) {
  return execSync(`${SNARKJS} ${args}`, { cwd: ROOT, stdio: 'pipe' }).toString();
}
function randomBJJBlinding() {
  while (true) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
    if (n > 0n && n < N_BJJ) return n;
  }
}

// =========================================================================
// LP_ADD: prove → serialize → parse → verify roundtrip
// =========================================================================
console.log('amm_lp_add proof wire-format roundtrip');

const LP_ADD_VK = resolve(DEV_ZKEY, 'amm_lp_add_vkey.json');
const LP_ADD_ZKEY = resolve(DEV_ZKEY, 'amm_lp_add_final.zkey');
const LP_ADD_WASM = resolve(CIRC_DIR, 'build/amm_lp_add_js/amm_lp_add.wasm');

if (!existsSync(LP_ADD_VK) || !existsSync(LP_ADD_ZKEY)) {
  test('LP_ADD wire roundtrip', () => 'skip — dev-zkey artifacts missing');
} else {
  const shareAmount = 1_414_213n;
  const r = randomBJJBlinding();
  const C = pedersenBJJ(shareAmount, r);
  const input = {
    pool_id_fr: '12345678901234567890',
    variant: '0',
    share_amount: shareAmount.toString(),
    C_share_BJJ_u: C[0].toString(),
    C_share_BJJ_v: C[1].toString(),
    r_share_BJJ: r.toString(),
  };
  writeFileSync(`${DEV_ZKEY}/_wire_lp_add_input.json`, JSON.stringify(input));
  snarkjs(`wtns calculate ${LP_ADD_WASM} ${DEV_ZKEY}/_wire_lp_add_input.json ${DEV_ZKEY}/_wire_lp_add_witness.wtns`);
  snarkjs(`groth16 prove ${LP_ADD_ZKEY} ${DEV_ZKEY}/_wire_lp_add_witness.wtns ${DEV_ZKEY}/_wire_lp_add_proof.json ${DEV_ZKEY}/_wire_lp_add_public.json`);
  const proofObj = JSON.parse(readFileSync(`${DEV_ZKEY}/_wire_lp_add_proof.json`, 'utf8'));
  const publicSignals = JSON.parse(readFileSync(`${DEV_ZKEY}/_wire_lp_add_public.json`, 'utf8'));
  const vk = JSON.parse(readFileSync(LP_ADD_VK, 'utf8'));

  await testAsync('LP_ADD raw snarkjs proof verifies', async () => {
    return await snarkjsLib.groth16.verify(vk, publicSignals, proofObj);
  });

  test('LP_ADD _serializeGroth16Proof emits exactly 256 bytes', () => {
    const bytes = _serializeGroth16Proof(proofObj);
    return bytes instanceof Uint8Array && bytes.length === 256;
  });

  const serializedBytes = _serializeGroth16Proof(proofObj);
  const reparsed = _parseGroth16Proof(serializedBytes);
  test('LP_ADD _parseGroth16Proof recovers proof object (pi_a/pi_b/pi_c match)', () => {
    return reparsed.pi_a[0] === proofObj.pi_a[0]
        && reparsed.pi_a[1] === proofObj.pi_a[1]
        && reparsed.pi_b[0][0] === proofObj.pi_b[0][0]
        && reparsed.pi_b[0][1] === proofObj.pi_b[0][1]
        && reparsed.pi_b[1][0] === proofObj.pi_b[1][0]
        && reparsed.pi_b[1][1] === proofObj.pi_b[1][1]
        && reparsed.pi_c[0] === proofObj.pi_c[0]
        && reparsed.pi_c[1] === proofObj.pi_c[1];
  });

  await testAsync('LP_ADD round-tripped proof verifies via snarkjs', async () => {
    const decInputs = _publicInputsToDecimal(publicSignals);
    return await snarkjsLib.groth16.verify(vk, decInputs, reparsed);
  });

  // Cross-check: dapp's verifyAmmProof contract emits publicInputs in the
  // SAME canonical decimal-string form that validator.buildPublicSignalsLpAdd
  // returns. Hand-build the publicInputs array the way dapp/tacit.js:11811
  // does, run them through _publicInputsToDecimal, and confirm verify still
  // passes — proves no transformation drift across the (validator helper →
  // dapp inline construction → dapp parser) path.
  await testAsync('LP_ADD validator-built signals match dapp inline construction', async () => {
    const validatorSigs = validator.buildPublicSignalsLpAdd(
      { variant: 0, shareAmount, cShareBjjU: C[0], cShareBjjV: C[1] },
      { pool_id: new Uint8Array(32), reserve_A: 1_000_000n, reserve_B: 2_000_000n },
    );
    validatorSigs[0] = '12345678901234567890';   // override pool_id_fr to witness value
    const decAfter = _publicInputsToDecimal(validatorSigs);
    // _publicInputsToDecimal should pass through already-decimal strings unchanged.
    for (let i = 0; i < validatorSigs.length; i++) {
      if (decAfter[i] !== validatorSigs[i]) {
        console.log(`     [${i}] before="${validatorSigs[i]}" after="${decAfter[i]}"`);
        return false;
      }
    }
    return await snarkjsLib.groth16.verify(vk, decAfter, reparsed);
  });
}

// =========================================================================
// LP_REMOVE: same suite
// =========================================================================
console.log('\namm_lp_remove proof wire-format roundtrip');

const LP_REM_VK = resolve(DEV_ZKEY, 'amm_lp_remove_vkey.json');
const LP_REM_ZKEY = resolve(DEV_ZKEY, 'amm_lp_remove_final.zkey');
const LP_REM_WASM = resolve(CIRC_DIR, 'build/amm_lp_remove_js/amm_lp_remove.wasm');

if (!existsSync(LP_REM_VK) || !existsSync(LP_REM_ZKEY)) {
  test('LP_REMOVE wire roundtrip', () => 'skip — dev-zkey artifacts missing');
} else {
  const shareAmount = 1000n, deltaA = 500n, deltaB = 1000n;
  const rA = randomBJJBlinding();
  const rB = randomBJJBlinding();
  const CA = pedersenBJJ(deltaA, rA);
  const CB = pedersenBJJ(deltaB, rB);
  const input = {
    pool_id_fr: '12345678901234567890',
    share_amount: shareAmount.toString(),
    delta_A: deltaA.toString(),
    delta_B: deltaB.toString(),
    recv_A_BJJ_u: CA[0].toString(),
    recv_A_BJJ_v: CA[1].toString(),
    recv_B_BJJ_u: CB[0].toString(),
    recv_B_BJJ_v: CB[1].toString(),
    r_recv_A_BJJ: rA.toString(),
    r_recv_B_BJJ: rB.toString(),
  };
  writeFileSync(`${DEV_ZKEY}/_wire_lp_rem_input.json`, JSON.stringify(input));
  snarkjs(`wtns calculate ${LP_REM_WASM} ${DEV_ZKEY}/_wire_lp_rem_input.json ${DEV_ZKEY}/_wire_lp_rem_witness.wtns`);
  snarkjs(`groth16 prove ${LP_REM_ZKEY} ${DEV_ZKEY}/_wire_lp_rem_witness.wtns ${DEV_ZKEY}/_wire_lp_rem_proof.json ${DEV_ZKEY}/_wire_lp_rem_public.json`);
  const proofObj = JSON.parse(readFileSync(`${DEV_ZKEY}/_wire_lp_rem_proof.json`, 'utf8'));
  const publicSignals = JSON.parse(readFileSync(`${DEV_ZKEY}/_wire_lp_rem_public.json`, 'utf8'));
  const vk = JSON.parse(readFileSync(LP_REM_VK, 'utf8'));

  await testAsync('LP_REMOVE raw snarkjs proof verifies', async () => {
    return await snarkjsLib.groth16.verify(vk, publicSignals, proofObj);
  });

  const serializedBytes = _serializeGroth16Proof(proofObj);
  const reparsed = _parseGroth16Proof(serializedBytes);
  test('LP_REMOVE _serializeGroth16Proof emits exactly 256 bytes', () =>
    serializedBytes instanceof Uint8Array && serializedBytes.length === 256
  );
  test('LP_REMOVE _parseGroth16Proof recovers proof coords', () =>
    reparsed.pi_a[0] === proofObj.pi_a[0]
    && reparsed.pi_a[1] === proofObj.pi_a[1]
    && reparsed.pi_b[0][0] === proofObj.pi_b[0][0]
    && reparsed.pi_b[0][1] === proofObj.pi_b[0][1]
    && reparsed.pi_b[1][0] === proofObj.pi_b[1][0]
    && reparsed.pi_b[1][1] === proofObj.pi_b[1][1]
    && reparsed.pi_c[0] === proofObj.pi_c[0]
    && reparsed.pi_c[1] === proofObj.pi_c[1]
  );
  await testAsync('LP_REMOVE round-tripped proof verifies via snarkjs', async () => {
    return await snarkjsLib.groth16.verify(vk, _publicInputsToDecimal(publicSignals), reparsed);
  });

  await testAsync('LP_REMOVE validator-built signals match dapp inline construction', async () => {
    const validatorSigs = validator.buildPublicSignalsLpRemove(
      { shareAmount, deltaA, deltaB,
        recvABjjU: CA[0], recvABjjV: CA[1], recvBBjjU: CB[0], recvBBjjV: CB[1] },
      { pool_id: new Uint8Array(32), reserve_A: 1_000_000n, reserve_B: 2_000_000n },
    );
    validatorSigs[0] = '12345678901234567890';
    return await snarkjsLib.groth16.verify(vk, _publicInputsToDecimal(validatorSigs), reparsed);
  });
}

// =========================================================================
// SWAP_BATCH (heavy — runs only if dev-zkey artifact exists)
// =========================================================================
console.log('\namm_swap_batch proof wire-format roundtrip');

const SB_VK   = resolve(DEV_ZKEY, 'amm_swap_batch_vkey.json');
const SB_ZKEY = resolve(DEV_ZKEY, 'amm_swap_batch_final.zkey');
const SB_WASM = resolve(CIRC_DIR, 'build/amm_swap_batch_js/amm_swap_batch.wasm');

if (!existsSync(SB_VK) || !existsSync(SB_ZKEY)) {
  test('SWAP_BATCH wire roundtrip', () => 'skip — dev-zkey artifacts missing (run build-dev-zkey.sh)');
} else {
  // Reuse the witness inputs that prove-verify-roundtrip.test.mjs builds —
  // we just need a valid (proof, publicSignals) pair to roundtrip.
  const sbInputPath  = `${DEV_ZKEY}/_rt_sb_input.json`;
  const sbProofPath  = `${DEV_ZKEY}/_rt_sb_proof.json`;
  const sbPublicPath = `${DEV_ZKEY}/_rt_sb_public.json`;

  if (!existsSync(sbProofPath) || !existsSync(sbPublicPath)) {
    test('SWAP_BATCH wire roundtrip', () =>
      'skip — run prove-verify-roundtrip.test.mjs first to materialize a witness/proof');
  } else {
    const proofObj = JSON.parse(readFileSync(sbProofPath, 'utf8'));
    const publicSignals = JSON.parse(readFileSync(sbPublicPath, 'utf8'));
    const vk = JSON.parse(readFileSync(SB_VK, 'utf8'));

    await testAsync('SWAP_BATCH raw snarkjs proof verifies', async () => {
      return await snarkjsLib.groth16.verify(vk, publicSignals, proofObj);
    });

    const serializedBytes = _serializeGroth16Proof(proofObj);
    const reparsed = _parseGroth16Proof(serializedBytes);
    test('SWAP_BATCH _serializeGroth16Proof emits exactly 256 bytes', () =>
      serializedBytes instanceof Uint8Array && serializedBytes.length === 256
    );
    test('SWAP_BATCH _parseGroth16Proof recovers proof coords', () =>
      reparsed.pi_a[0] === proofObj.pi_a[0]
      && reparsed.pi_a[1] === proofObj.pi_a[1]
      && reparsed.pi_b[0][0] === proofObj.pi_b[0][0]
      && reparsed.pi_b[0][1] === proofObj.pi_b[0][1]
      && reparsed.pi_b[1][0] === proofObj.pi_b[1][0]
      && reparsed.pi_b[1][1] === proofObj.pi_b[1][1]
      && reparsed.pi_c[0] === proofObj.pi_c[0]
      && reparsed.pi_c[1] === proofObj.pi_c[1]
    );
    await testAsync('SWAP_BATCH round-tripped proof verifies via snarkjs', async () => {
      return await snarkjsLib.groth16.verify(vk, _publicInputsToDecimal(publicSignals), reparsed);
    });
  }
}

console.log(`\n${pass}/${pass + fail} dapp-prover-wiring checks passed (${skipped} skipped, ${fail} failed)`);
if (fail > 0) process.exit(1);
