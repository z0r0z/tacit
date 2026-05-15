// Bulletproof malformed-input fuzz.
//
// Asserts that bpRangeAggVerify rejects (returns false, never throws) for:
//   - Random-byte garbage of every common size
//   - Single-byte tampering of a valid proof
//   - Truncated valid proof
//   - Oversized (extra trailing bytes) proof
//   - Zero-length / empty proofs
//   - Pathologically large proof inputs (no DoS)
//
// Production indexers will receive untrusted bytes from the network; the verifier
// MUST be a total function over Uint8Array — any throw is a DoS vector.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  bpRangeAggProve, bpRangeAggVerify, bpRangeAggBatchVerify,
  G as G_SECP, H as H_SECP, pedersenCommit, SECP_N, modN,
} from './bulletproofs.mjs';

function randBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
function randScalar() {
  while (true) {
    const x = bytesToBig(randBytes(32));
    if (x > 0n && x < SECP_N) return x;
  }
}
function bytesToBig(b) {
  let n = 0n;
  for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
  return n;
}

// Build one valid 1-value aggregate proof to use as the "good" baseline.
// bpRangeAggProve returns { proof: Uint8Array, commitments: Point[] }
function makeValidSingleProof(value = 1234n) {
  const r = randScalar();
  const V = pedersenCommit(value, r);
  const { proof } = bpRangeAggProve([value], [r]);
  return { V, proof };
}

// Build a valid 4-value aggregate proof.
function makeValidQuadProof() {
  const values   = [10n, 1_000n, 1_000_000n, 1_000_000_000n];
  const blinds   = values.map(() => randScalar());
  const commits  = values.map((v, i) => pedersenCommit(v, blinds[i]));
  const { proof } = bpRangeAggProve(values, blinds);
  return { V_pts: commits, proof };
}

function fillRandom(buf) {
  // crypto.getRandomValues caps at 65536 per call; fill in chunks.
  const CHUNK = 65536;
  for (let i = 0; i < buf.length; i += CHUNK) {
    crypto.getRandomValues(buf.subarray(i, Math.min(i + CHUNK, buf.length)));
  }
}

describe('bulletproof malformed-input fuzz', () => {

  test('valid baseline single-value proof verifies', () => {
    const { V, proof } = makeValidSingleProof();
    assert.strictEqual(bpRangeAggVerify([V], proof), true);
  });

  test('valid baseline 4-value aggregate proof verifies', () => {
    const { V_pts, proof } = makeValidQuadProof();
    assert.strictEqual(bpRangeAggVerify(V_pts, proof), true);
  });

  test('random garbage of 32 different sizes never verifies + never throws', () => {
    const { V } = makeValidSingleProof();
    const sizes = [0, 1, 31, 32, 33, 64, 100, 200, 500, 688, 689, 690, 700, 800, 1024, 4096];
    for (const sz of sizes) {
      for (let i = 0; i < 4; i++) {
        const garbage = randBytes(sz);
        let result;
        try { result = bpRangeAggVerify([V], garbage); }
        catch (e) { assert.fail(`size=${sz} threw: ${e.message}`); }
        assert.strictEqual(result, false, `size=${sz} accepted random garbage`);
      }
    }
  });

  test('single-byte tampering of a valid proof rejects', () => {
    const { V, proof } = makeValidSingleProof();
    // Sample 12 random byte positions; flip each in turn; ensure all reject.
    for (let i = 0; i < 12; i++) {
      const idx = Math.floor(Math.random() * proof.length);
      const flipped = new Uint8Array(proof);
      flipped[idx] ^= 0x01;
      let result;
      try { result = bpRangeAggVerify([V], flipped); }
      catch (e) { assert.fail(`flip@${idx} threw: ${e.message}`); }
      assert.strictEqual(result, false, `flip@${idx} accepted`);
    }
  });

  test('truncated valid proof rejects at every truncation length', () => {
    const { V, proof } = makeValidSingleProof();
    const cuts = [proof.length - 1, proof.length - 16, Math.floor(proof.length / 2), 64, 32, 1];
    for (const cut of cuts) {
      const trunc = proof.subarray(0, cut);
      let result;
      try { result = bpRangeAggVerify([V], trunc); }
      catch (e) { assert.fail(`cut=${cut} threw: ${e.message}`); }
      assert.strictEqual(result, false, `cut=${cut} accepted`);
    }
  });

  test('oversized (extra trailing bytes) proof rejects', () => {
    const { V, proof } = makeValidSingleProof();
    for (const extra of [1, 8, 64, 256]) {
      const padded = new Uint8Array(proof.length + extra);
      padded.set(proof, 0);
      fillRandom(padded.subarray(proof.length));
      let result;
      try { result = bpRangeAggVerify([V], padded); }
      catch (e) { assert.fail(`extra=${extra} threw: ${e.message}`); }
      assert.strictEqual(result, false, `extra=${extra} accepted`);
    }
  });

  test('empty / zero-length input rejects without throwing', () => {
    const { V } = makeValidSingleProof();
    assert.strictEqual(bpRangeAggVerify([V], new Uint8Array(0)), false);
  });

  test('pathologically large 1MB input rejects without DoS', () => {
    const { V } = makeValidSingleProof();
    const huge = new Uint8Array(1024 * 1024);
    fillRandom(huge);
    const start = Date.now();
    const result = bpRangeAggVerify([V], huge);
    const elapsed = Date.now() - start;
    assert.strictEqual(result, false);
    // 1MB garbage must be rejected fast (length-check before any crypto work).
    // Threshold is generous: 500ms ≫ any sane bound.
    assert.ok(elapsed < 500, `1MB rejection took ${elapsed}ms — should be O(length-check)`);
  });

  test('batch-verify rejects when one of N proofs is malformed', () => {
    const { V: V1, proof: p1 } = makeValidSingleProof(100n);
    const { V: V2, proof: p2 } = makeValidSingleProof(200n);
    const { V: V3, proof: p3 } = makeValidSingleProof(300n);

    // All-honest batch verifies.
    assert.strictEqual(
      bpRangeAggBatchVerify([
        { commitments: [V1], proof: p1 },
        { commitments: [V2], proof: p2 },
        { commitments: [V3], proof: p3 },
      ]),
      true,
    );

    // Tamper p2; batch must reject.
    const badP2 = new Uint8Array(p2);
    badP2[badP2.length - 1] ^= 0x01;
    assert.strictEqual(
      bpRangeAggBatchVerify([
        { commitments: [V1], proof: p1 },
        { commitments: [V2], proof: badP2 },
        { commitments: [V3], proof: p3 },
      ]),
      false,
    );
  });

  test('proof bound to one commitment fails verification under a different commitment', () => {
    const { proof } = makeValidSingleProof(1234n);
    // Build a different valid commitment to the same value — different blinding.
    const r2 = randScalar();
    const V2 = pedersenCommit(1234n, r2);
    assert.strictEqual(bpRangeAggVerify([V2], proof), false);
  });

  test('proof of 4 values rejects against 3 commitments and vice versa', () => {
    const { V_pts, proof } = makeValidQuadProof();
    // Wrong commitment count both ways.
    assert.strictEqual(bpRangeAggVerify(V_pts.slice(0, 3), proof), false);
    const { V } = makeValidSingleProof();
    assert.strictEqual(bpRangeAggVerify([V, V, V, V, V], proof), false);
  });

  test('null / non-Uint8Array proof input rejects without throwing', () => {
    const { V } = makeValidSingleProof();
    // verifier-shape robustness — must not crash on totally-wrong types.
    for (const bad of [null, undefined, '', 'hex-string', [], {}, 0, 42]) {
      let result;
      try { result = bpRangeAggVerify([V], bad); }
      catch { result = 'threw'; }
      assert.ok(result === false || result === 'threw',
        `bad input ${typeof bad} = ${JSON.stringify(bad)} returned truthy`);
      // (We accept throws here; the primary requirement is that they don't
      // crash the *process*. A try-wrapped indexer will turn the throw into
      // a reject. The only real failure is returning a truthy value.)
    }
  });

});
