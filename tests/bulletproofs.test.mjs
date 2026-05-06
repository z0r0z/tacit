// Correctness suite for the bulletproofs aggregated rangeproof.
// Run with: npm test
//
// Fails loudly on any incorrect prove/verify behaviour. Mutates valid proofs
// and verifies the verifier rejects them — this is the line of defence against
// silently-broken crypto.

import {
  randomScalar, pedersenCommit, _bpGens,
  bpRangeAggProve, bpRangeAggVerify, bpRangeAggBatchVerify,
} from './bulletproofs.mjs';

let pass = 0, fail = 0;

function test(label, fn) {
  const start = Date.now();
  try {
    const ok = fn();
    const ms = Date.now() - start;
    if (ok) { console.log(`  PASS  ${label.padEnd(48)} ${ms}ms`); pass++; }
    else    { console.log(`  FAIL  ${label.padEnd(48)} ${ms}ms`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label.padEnd(48)} ${e.message}`);
    fail++;
  }
}

console.log('Deriving generators (one-time)…');
const t0 = Date.now();
_bpGens();
console.log(`  ready in ${Date.now() - t0}ms\n`);

console.log('Single-value range proofs:');
test('v=0', () => {
  const p = bpRangeAggProve([0n], [randomScalar()]);
  return bpRangeAggVerify(p.commitments, p.proof);
});
test('v=1', () => {
  const p = bpRangeAggProve([1n], [randomScalar()]);
  return bpRangeAggVerify(p.commitments, p.proof);
});
test('v=2^32 (still in 64-bit range)', () => {
  const p = bpRangeAggProve([1n << 32n], [randomScalar()]);
  return bpRangeAggVerify(p.commitments, p.proof);
});
test('v=2^64-1 (max in range)', () => {
  const p = bpRangeAggProve([(1n << 64n) - 1n], [randomScalar()]);
  return bpRangeAggVerify(p.commitments, p.proof);
});
test('proof size for m=1 is 688 bytes', () => {
  const p = bpRangeAggProve([42n], [randomScalar()]);
  return p.proof.length === 688;
});

console.log('\nAggregated range proofs:');
test('m=2', () => {
  const p = bpRangeAggProve([100n, 200n], [randomScalar(), randomScalar()]);
  return bpRangeAggVerify(p.commitments, p.proof);
});
test('m=2 proof size is 754 bytes', () => {
  const p = bpRangeAggProve([100n, 200n], [randomScalar(), randomScalar()]);
  return p.proof.length === 754;
});
test('m=4', () => {
  const p = bpRangeAggProve(
    [0n, 1n << 32n, 1n << 63n, 42n],
    [randomScalar(), randomScalar(), randomScalar(), randomScalar()],
  );
  return bpRangeAggVerify(p.commitments, p.proof);
});
test('m=4 proof size is 820 bytes', () => {
  const p = bpRangeAggProve(
    [1n, 2n, 3n, 4n],
    [randomScalar(), randomScalar(), randomScalar(), randomScalar()],
  );
  return p.proof.length === 820;
});

console.log('\nRejection cases:');
test('reject v >= 2^64', () => {
  try { bpRangeAggProve([1n << 64n], [randomScalar()]); return false; }
  catch { return true; }
});
test('reject v < 0', () => {
  try { bpRangeAggProve([-1n], [randomScalar()]); return false; }
  catch { return true; }
});
test('reject m=3 (must be power of 2 ∈ {1,2,4,8})', () => {
  try { bpRangeAggProve([1n, 2n, 3n], [randomScalar(), randomScalar(), randomScalar()]); return false; }
  catch { return true; }
});
test('reject tampered proof body', () => {
  const p = bpRangeAggProve([42n], [randomScalar()]);
  const tampered = new Uint8Array(p.proof);
  tampered[Math.floor(tampered.length / 2)] ^= 1;
  return !bpRangeAggVerify(p.commitments, tampered);
});
test('reject tampered first byte', () => {
  const p = bpRangeAggProve([42n], [randomScalar()]);
  const tampered = new Uint8Array(p.proof); tampered[0] ^= 1;
  return !bpRangeAggVerify(p.commitments, tampered);
});
test('reject tampered last byte', () => {
  const p = bpRangeAggProve([42n], [randomScalar()]);
  const tampered = new Uint8Array(p.proof); tampered[tampered.length - 1] ^= 1;
  return !bpRangeAggVerify(p.commitments, tampered);
});
test('reject swapped commitments', () => {
  const p = bpRangeAggProve([1n, 2n], [randomScalar(), randomScalar()]);
  return !bpRangeAggVerify([p.commitments[1], p.commitments[0]], p.proof);
});
test('reject forged commitment', () => {
  const p = bpRangeAggProve([5n], [randomScalar()]);
  const fakeC = pedersenCommit(7n, randomScalar());
  return !bpRangeAggVerify([fakeC], p.proof);
});
test('reject wrong-length proof', () => {
  const p = bpRangeAggProve([5n], [randomScalar()]);
  const truncated = p.proof.slice(0, p.proof.length - 1);
  return !bpRangeAggVerify(p.commitments, truncated);
});

console.log('\nBatched verification:');
test('batch of 1 ≡ single verify', () => {
  const p = bpRangeAggProve([42n], [randomScalar()]);
  return bpRangeAggBatchVerify([{ commitments: p.commitments, proof: p.proof }]);
});
test('batch of 3 (all m=1) all valid', () => {
  const items = [];
  for (let i = 0; i < 3; i++) {
    const p = bpRangeAggProve([BigInt(i * 100 + 1)], [randomScalar()]);
    items.push({ commitments: p.commitments, proof: p.proof });
  }
  return bpRangeAggBatchVerify(items);
});
test('batch with 1 bad item rejects whole batch', () => {
  const items = [];
  for (let i = 0; i < 3; i++) {
    const p = bpRangeAggProve([BigInt(i * 100 + 1)], [randomScalar()]);
    items.push({ commitments: p.commitments, proof: p.proof });
  }
  // Tamper with the middle proof.
  const bad = new Uint8Array(items[1].proof); bad[Math.floor(bad.length / 2)] ^= 1;
  items[1].proof = bad;
  return !bpRangeAggBatchVerify(items);
});
test('batch mixes m=1, m=2, m=4', () => {
  const p1 = bpRangeAggProve([1n], [randomScalar()]);
  const p2 = bpRangeAggProve([10n, 20n], [randomScalar(), randomScalar()]);
  const p4 = bpRangeAggProve([100n, 200n, 300n, 400n], [randomScalar(), randomScalar(), randomScalar(), randomScalar()]);
  return bpRangeAggBatchVerify([
    { commitments: p1.commitments, proof: p1.proof },
    { commitments: p2.commitments, proof: p2.proof },
    { commitments: p4.commitments, proof: p4.proof },
  ]);
});
test('empty batch is vacuously true', () => {
  return bpRangeAggBatchVerify([]);
});
test('batch detects forged commitment in one item', () => {
  const p1 = bpRangeAggProve([1n], [randomScalar()]);
  const p2 = bpRangeAggProve([2n], [randomScalar()]);
  const fakeC = pedersenCommit(99n, randomScalar());
  return !bpRangeAggBatchVerify([
    { commitments: p1.commitments, proof: p1.proof },
    { commitments: [fakeC], proof: p2.proof },
  ]);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
