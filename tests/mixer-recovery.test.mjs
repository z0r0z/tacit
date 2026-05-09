// SPEC §5.11 + §6 path 7 — dapp's mixer-side recovery + Groth16 verify-glue.
//
// Two surfaces this covers that mixer-envelope.test.mjs / mixer-e2e.test.mjs
// don't:
//
//   A) **Recovery math** — the dapp's scanHoldings / validateOutpoint walk
//      for T_WITHDRAW outputs. Specifically the step where the recipient's
//      wallet trial-decodes the public (denomination, r_leaf) and verifies
//      pedersenCommit(denomination, r_leaf) == recipient_commitment to credit
//      the new UTXO. This is the user-facing "did my withdraw show up?"
//      question.
//
//   B) **Format-conversion glue** — `parseGroth16Proof(256-byte payload)`
//      and `publicInputsToDecimal(mixed-form list)` used inside the dapp's
//      verifyMixerProof wrapper. These are the byte-shuffling pieces most
//      likely to silently break (BE vs LE, pi_b nesting, hex vs decimal).
//      We feed a known-good sample_proof.json through them and verify the
//      output round-trips against the proof's canonical snarkjs form, then
//      run snarkjs.groth16.verify directly against parseGroth16Proof's
//      output to prove end-to-end byte→snarkjs→verify works.
//
// Run: `node mixer-recovery.test.mjs`

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
async function test(label, fn) {
  try {
    const ok = await fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`);
    fail++;
  }
}

// ============== A. Withdraw recovery math ==============
//
// SPEC §6 path 7: a fresh wallet that owns a T_WITHDRAW output recovers
// (denomination, r_leaf) from the public envelope and verifies
//   pedersenCommit(denomination, r_leaf) == recipient_commitment
// — same shape as T_PMINT's (amount, blinding) pattern. The test below
// builds a self-consistent envelope from primitives, runs the dapp's
// decoder, and exercises the Pedersen check the dapp uses inline at
// scanHoldings (around tacit.js:5080-5098).

console.log('Withdraw recovery math (T_WITHDRAW → spendable holdings):');

// Pick a small denomination + r_leaf, derive recipient_commitment. SPEC §3.2:
// commitment = denomination · H + r_leaf · G.
const DENOM = 100000000n;
const R_LEAF_BIGINT = 0x123456789abcdef0n;     // arbitrary nonzero scalar
const R_LEAF_BYTES = (() => {
  const buf = new Uint8Array(32);
  let v = R_LEAF_BIGINT;
  for (let i = 31; i >= 0; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
})();
const RECIPIENT_COMMITMENT_PT = dapp.pedersenCommit(DENOM, R_LEAF_BIGINT);
const RECIPIENT_COMMITMENT_BYTES = dapp.pointToBytes(RECIPIENT_COMMITMENT_PT);

const ASSET_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
const ROOT_BYTES = new Uint8Array(32).map((_, i) => (i * 13 + 7) & 0xff);
const NULL_BYTES = new Uint8Array(32).map((_, i) => (i * 17 + 11) & 0xff);
const PROOF_BYTES = new Uint8Array(256).map((_, i) => (i * 3 + 1) & 0xff);

// bind_hash = SHA256("tacit-withdraw-bind-v1" || asset_id || denom_LE
//                    || nullifier_hash || recipient_commitment || r_leaf)
function computeBindHash(assetId, denomination, nullifierHash, recipientCommitment, rLeaf) {
  const denomLE = new Uint8Array(8);
  const v = new DataView(denomLE.buffer);
  v.setUint32(0, Number(denomination & 0xffffffffn), true);
  v.setUint32(4, Number((denomination >> 32n) & 0xffffffffn), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-withdraw-bind-v1'),
    assetId, denomLE, nullifierHash, recipientCommitment, rLeaf,
  ));
}

const BIND_HASH = computeBindHash(ASSET_BYTES, DENOM, NULL_BYTES, RECIPIENT_COMMITMENT_BYTES, R_LEAF_BYTES);
const WITHDRAW_PAYLOAD = dapp.encodeTWithdrawPayload({
  assetId: ASSET_BYTES, denomination: DENOM, merkleRoot: ROOT_BYTES,
  nullifierHash: NULL_BYTES, recipientCommitment: RECIPIENT_COMMITMENT_BYTES,
  rLeaf: R_LEAF_BYTES, bindHash: BIND_HASH, proof: PROOF_BYTES,
});

await test('decodeTWithdrawPayload accepts a self-consistent envelope', () => {
  const dec = dapp.decodeTWithdrawPayload(WITHDRAW_PAYLOAD);
  return dec !== null
      && dec.kind === 'withdraw'
      && dec.denomination === DENOM
      && bytesToHex(dec.recipientCommitment) === bytesToHex(RECIPIENT_COMMITMENT_BYTES);
});

await test('Pedersen recovery: pedersenCommit(denom, r_leaf) opens recipient_commitment', () => {
  const dec = dapp.decodeTWithdrawPayload(WITHDRAW_PAYLOAD);
  // Reproduce the recovery math from tacit.js:5080-5098.
  let r = 0n;
  for (let i = 0; i < 32; i++) r = (r << 8n) | BigInt(dec.rLeaf[i]);
  r = r % dapp.SECP_N;
  const reconstructed = dapp.pedersenCommit(dec.denomination, r);
  const onChain = dapp.bytesToPoint(dec.recipientCommitment);
  return reconstructed.equals(onChain);
});

await test('mutated denomination fails Pedersen recovery', () => {
  const tampered = new Uint8Array(WITHDRAW_PAYLOAD);
  // denom occupies bytes 33..40
  tampered[33] ^= 0x01;
  const dec = dapp.decodeTWithdrawPayload(tampered);
  // Could be null (bind_hash check) OR decode + Pedersen mismatch.
  if (dec === null) return true;     // bind_hash caught it, fine
  let r = 0n;
  for (let i = 0; i < 32; i++) r = (r << 8n) | BigInt(dec.rLeaf[i]);
  r = r % dapp.SECP_N;
  const reconstructed = dapp.pedersenCommit(dec.denomination, r);
  const onChain = dapp.bytesToPoint(dec.recipientCommitment);
  return !reconstructed.equals(onChain);
});

await test('mutated r_leaf fails Pedersen recovery (when bind_hash regen is bypassed)', () => {
  // r_leaf is at offset 1 + 32 + 8 + 32 + 32 + 33 = 138, length 32.
  const tampered = new Uint8Array(WITHDRAW_PAYLOAD);
  tampered[138] ^= 0x80;
  // The mutation also breaks bind_hash, so decodeTWithdrawPayload returns null
  // first. That's a stricter rejection than Pedersen — good. Document by
  // asserting the null path triggers.
  return dapp.decodeTWithdrawPayload(tampered) === null;
});

await test('correct denomination but wrong r_leaf still rejected (bind_hash defense)', () => {
  // Build a payload with a wrong r_leaf but correctly-recomputed bind_hash for
  // that wrong r_leaf. The Pedersen check would still fail because the
  // recipient_commitment was for the original r_leaf. Bind_hash defense alone
  // doesn't catch this — the EXTERNAL Pedersen check at line 4633-4637 of
  // validateOutpoint does. Test asserts the full recovery chain rejects.
  const wrongR = new Uint8Array(32).map((_, i) => (i + 99) & 0xff);
  const wrongBind = computeBindHash(ASSET_BYTES, DENOM, NULL_BYTES, RECIPIENT_COMMITMENT_BYTES, wrongR);
  const payload = dapp.encodeTWithdrawPayload({
    assetId: ASSET_BYTES, denomination: DENOM, merkleRoot: ROOT_BYTES,
    nullifierHash: NULL_BYTES, recipientCommitment: RECIPIENT_COMMITMENT_BYTES,
    rLeaf: wrongR, bindHash: wrongBind, proof: PROOF_BYTES,
  });
  const dec = dapp.decodeTWithdrawPayload(payload);
  if (!dec) return false;     // should decode (bind_hash matches)
  let r = 0n;
  for (let i = 0; i < 32; i++) r = (r << 8n) | BigInt(dec.rLeaf[i]);
  r = r % dapp.SECP_N;
  const reconstructed = dapp.pedersenCommit(dec.denomination, r);
  return !reconstructed.equals(dapp.bytesToPoint(dec.recipientCommitment));
});

// ============== B. Format-conversion glue ==============
//
// `parseGroth16Proof` takes 256 raw bytes (4 G1 coords × 32 + 4 G2 fp_2 = 256)
// and produces a snarkjs.groth16-compatible proof object. Wrong byte ordering
// or G2 nesting silently breaks every dapp-side verify; this is the most
// failure-prone glue in the whole mixer surface.

console.log('\nGroth16 format-conversion glue (parseGroth16Proof / publicInputsToDecimal):');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PROOF_PATH = path.resolve(__dirname, '..', 'dapp', 'circuits', 'artifacts', 'sample_proof.json');

let SAMPLE = null;
try {
  SAMPLE = JSON.parse(await fs.readFile(SAMPLE_PROOF_PATH, 'utf8'));
} catch {
  /* fresh checkout — circuits/build.sh not run yet, format tests get skipped */
}

await test('publicInputsToDecimal handles 64-char hex (no prefix) → decimal', () => {
  const hexInput = 'aa'.repeat(32);
  const out = dapp.publicInputsToDecimal([hexInput]);
  return out.length === 1 && out[0] === BigInt('0x' + hexInput).toString();
});

await test('publicInputsToDecimal handles 0x-prefixed hex → decimal', () => {
  const hexInput = '0x' + 'bb'.repeat(32);
  const out = dapp.publicInputsToDecimal([hexInput]);
  return out.length === 1 && out[0] === BigInt(hexInput).toString();
});

await test('publicInputsToDecimal passes through decimal strings unchanged', () => {
  const out = dapp.publicInputsToDecimal(['100000000']);
  return out.length === 1 && out[0] === '100000000';
});

await test('publicInputsToDecimal mixed batch (the verifyMixerProof shape)', () => {
  // Real shape from validateOutpoint at tacit.js:4640-4646:
  //   [ root_hex, nullifier_hex, denom_decimal, r_leaf_hex, bind_hash_hex ]
  const out = dapp.publicInputsToDecimal([
    'aa'.repeat(32), 'bb'.repeat(32), '100', 'cc'.repeat(32), 'dd'.repeat(32),
  ]);
  return out.length === 5
      && out[0] === BigInt('0x' + 'aa'.repeat(32)).toString()
      && out[1] === BigInt('0x' + 'bb'.repeat(32)).toString()
      && out[2] === '100'
      && out[3] === BigInt('0x' + 'cc'.repeat(32)).toString()
      && out[4] === BigInt('0x' + 'dd'.repeat(32)).toString();
});

await test('parseGroth16Proof rejects wrong-length input (not 256 bytes)', () => {
  const bad = new Uint8Array(255);
  return dapp.parseGroth16Proof(bad) === null;
});

await test('parseGroth16Proof produces snarkjs-compatible shape', () => {
  const proof = dapp.parseGroth16Proof(new Uint8Array(256));
  if (!proof) return false;
  return proof.protocol === 'groth16'
      && proof.curve === 'bn128'
      && Array.isArray(proof.pi_a) && proof.pi_a.length === 3
      && proof.pi_a[2] === '1'
      && Array.isArray(proof.pi_b) && proof.pi_b.length === 3
      && Array.isArray(proof.pi_b[0]) && proof.pi_b[0].length === 2
      && Array.isArray(proof.pi_b[2]) && proof.pi_b[2][0] === '1' && proof.pi_b[2][1] === '0'
      && Array.isArray(proof.pi_c) && proof.pi_c.length === 3
      && proof.pi_c[2] === '1';
});

if (!SAMPLE) {
  console.log('  SKIP  end-to-end snarkjs verify (run `cd dapp/circuits && bash build.sh && node prove-sample.mjs` first)');
} else {
  // Convert sample_proof's snarkjs form back to the 256-byte wire form, then
  // round-trip through parseGroth16Proof. If the result verifies under
  // snarkjs.groth16.verify, the dapp's wire serialization is canonically
  // correct — same byte-ordering / G2 nesting that the prover emits.
  function decimalToBE32(decStr) {
    let v = BigInt(decStr);
    const buf = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
    return buf;
  }
  function snarkjsProofToWireBytes(p) {
    return concatBytes(
      decimalToBE32(p.pi_a[0]), decimalToBE32(p.pi_a[1]),
      decimalToBE32(p.pi_b[0][0]), decimalToBE32(p.pi_b[0][1]),
      decimalToBE32(p.pi_b[1][0]), decimalToBE32(p.pi_b[1][1]),
      decimalToBE32(p.pi_c[0]), decimalToBE32(p.pi_c[1]),
    );
  }

  await test('parseGroth16Proof round-trip: snarkjs → wire bytes → parseGroth16Proof matches snarkjs', () => {
    const wireBytes = snarkjsProofToWireBytes(SAMPLE.proof);
    const reparsed = dapp.parseGroth16Proof(wireBytes);
    if (!reparsed) return false;
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    return eq(reparsed.pi_a, SAMPLE.proof.pi_a)
        && eq(reparsed.pi_b, SAMPLE.proof.pi_b)
        && eq(reparsed.pi_c, SAMPLE.proof.pi_c)
        && reparsed.protocol === SAMPLE.proof.protocol
        && reparsed.curve === SAMPLE.proof.curve;
  });

  // End-to-end: feed parseGroth16Proof's output through real
  // snarkjs.groth16.verify (loaded from dapp/circuits/node_modules where
  // it ships as part of the prover toolchain). This is the closest we can
  // get to exercising verifyMixerProof without lifting the browser bundle
  // (vendor/tacit-mixer.min.js) into a node-side shim.
  let snarkjs = null;
  try {
    snarkjs = await import('../dapp/circuits/node_modules/snarkjs/main.js');
  } catch {
    /* circuits node_modules not installed — skip the hard verify */
  }

  if (!snarkjs?.groth16?.verify) {
    console.log('  SKIP  snarkjs.groth16.verify against parseGroth16Proof output (snarkjs not in dapp/circuits/node_modules)');
  } else {
    const VK_PATH = path.resolve(__dirname, '..', 'dapp', 'circuits', 'artifacts', 'verification_key.json');
    const vk = JSON.parse(await fs.readFile(VK_PATH, 'utf8'));

    await test('end-to-end: parseGroth16Proof output verifies under snarkjs against vk', async () => {
      const wireBytes = snarkjsProofToWireBytes(SAMPLE.proof);
      const reparsed = dapp.parseGroth16Proof(wireBytes);
      // publicInputsToDecimal is a no-op when inputs are already decimal,
      // but we run it for parity with verifyMixerProof's full path.
      const decInputs = dapp.publicInputsToDecimal(SAMPLE.publicSignals);
      return await snarkjs.groth16.verify(vk, decInputs, reparsed);
    });

    await test('end-to-end: snarkjs rejects a mutated proof (sanity check)', async () => {
      const wireBytes = snarkjsProofToWireBytes(SAMPLE.proof);
      const tampered = new Uint8Array(wireBytes);
      tampered[0] ^= 0x01;
      const reparsed = dapp.parseGroth16Proof(tampered);
      const decInputs = dapp.publicInputsToDecimal(SAMPLE.publicSignals);
      // snarkjs may reject by returning false OR by throwing on a malformed
      // field element — both are acceptable rejections.
      try {
        const ok = await snarkjs.groth16.verify(vk, decInputs, reparsed);
        return ok === false;
      } catch { return true; }
    });

    await test('end-to-end: snarkjs rejects when public inputs are tampered', async () => {
      const wireBytes = snarkjsProofToWireBytes(SAMPLE.proof);
      const reparsed = dapp.parseGroth16Proof(wireBytes);
      const tamperedInputs = SAMPLE.publicSignals.slice();
      tamperedInputs[0] = (BigInt(tamperedInputs[0]) ^ 1n).toString();
      const decInputs = dapp.publicInputsToDecimal(tamperedInputs);
      try {
        const ok = await snarkjs.groth16.verify(vk, decInputs, reparsed);
        return ok === false;
      } catch { return true; }
    });
  }
}

console.log('');
console.log(`${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
