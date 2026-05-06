// Microbenchmarks for the bulletproofs prover and verifier.
// Run with: npm run bench

import {
  randomScalar, _bpGens,
  bpRangeAggProve, bpRangeAggVerify, bpRangeAggBatchVerify,
} from './bulletproofs.mjs';

function bench(label, fn, iters = 5) {
  const times = [];
  let result;
  for (let i = 0; i < iters; i++) {
    const t = Date.now();
    result = fn();
    times.push(Date.now() - t);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times), max = Math.max(...times);
  console.log(`  ${label.padEnd(38)} avg ${avg.toFixed(0).padStart(5)}ms  min ${min}ms  max ${max}ms`);
  return result;
}

console.log('Warming up generators…');
const tg = Date.now();
_bpGens();
console.log(`  derived in ${Date.now() - tg}ms\n`);

console.log('Prover:');
const p1 = bench('prove m=1 (CETCH)', () => bpRangeAggProve([(1n << 60n) + 12345n], [randomScalar()]));
const p2 = bench('prove m=2 (CXFER, 2 outputs)', () => bpRangeAggProve([1n << 32n, 999n], [randomScalar(), randomScalar()]));
const p4 = bench('prove m=4', () => bpRangeAggProve(
  [1n, 1n << 16n, 1n << 32n, 1n << 48n],
  [randomScalar(), randomScalar(), randomScalar(), randomScalar()],
));

console.log('\nProof sizes:');
console.log(`  m=1: ${p1.proof.length} B`);
console.log(`  m=2: ${p2.proof.length} B`);
console.log(`  m=4: ${p4.proof.length} B`);

console.log('\nVerifier (single-proof):');
bench('verify m=1', () => bpRangeAggVerify(p1.commitments, p1.proof));
bench('verify m=2', () => bpRangeAggVerify(p2.commitments, p2.proof));
bench('verify m=4', () => bpRangeAggVerify(p4.commitments, p4.proof));

console.log('\nVerifier (batched, simulating recursive ancestry walk):');
function makeBatchOfM1(n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const p = bpRangeAggProve([BigInt(i + 1)], [randomScalar()]);
    items.push({ commitments: p.commitments, proof: p.proof });
  }
  return items;
}
function makeBatchOfM2(n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const p = bpRangeAggProve([BigInt(i + 1), BigInt(i + 2)], [randomScalar(), randomScalar()]);
    items.push({ commitments: p.commitments, proof: p.proof });
  }
  return items;
}

for (const N of [3, 5, 10]) {
  const batchM1 = makeBatchOfM1(N);
  bench(`batch ${N} × m=1 (one multi-exp)`, () => bpRangeAggBatchVerify(batchM1));

  const tSingle = Date.now();
  let allOk = true;
  for (const it of batchM1) allOk = allOk && bpRangeAggVerify(it.commitments, it.proof);
  console.log(`  ${(`${N} × m=1 sequential`).padEnd(38)} total ${(Date.now() - tSingle).toString().padStart(5)}ms  (${allOk ? 'all valid' : 'FAIL'})`);
}

console.log('\nMixed-size batch (1×m=1, 2×m=2, 1×m=4):');
const mix = [];
mix.push({ ...bpRangeAggProve([42n], [randomScalar()]) });
mix.push({ ...bpRangeAggProve([10n, 20n], [randomScalar(), randomScalar()]) });
mix.push({ ...bpRangeAggProve([7n, 8n], [randomScalar(), randomScalar()]) });
mix.push({ ...bpRangeAggProve([1n, 2n, 3n, 4n], [randomScalar(), randomScalar(), randomScalar(), randomScalar()]) });
const mixItems = mix.map(p => ({ commitments: p.commitments, proof: p.proof }));
bench('batch mixed m=1+2+2+4', () => bpRangeAggBatchVerify(mixItems));
