// Node benchmark of the single-thread wasm prover: node wasm/bench-node.cjs [runs]
const fs = require('fs');
const path = require('path');
const m = require('./pkg-node/btc_pool_halo2.js');
const runs = Number(process.argv[2] || 3);
const params = fs.readFileSync(path.join(__dirname, '../artifacts/params-k13.bin'));
let t = performance.now();
const p = new m.Prover(params);
const tk = (performance.now() - t) / 1000;
console.log(`threads ${m.numThreads()}, keygen ${tk.toFixed(2)} s, vk ${p.vkDigest().slice(0, 16)}`);
for (const name of ['pay', 'partialExit', 'shield']) {
  const input = m.sampleInput(name);
  const xs = [];
  let out;
  for (let i = 0; i < (name === 'pay' ? runs : 1); i++) {
    t = performance.now();
    out = p.prove(input);
    xs.push((performance.now() - t) / 1000);
  }
  t = performance.now();
  const ok = p.verify(out);
  const tv = (performance.now() - t) / 1000;
  const doc = JSON.parse(out);
  const bad = { ...doc, publics: doc.publics.map((x, i) => (i === 1 ? (BigInt(x) + 1n).toString() : x)) };
  if (!ok || p.verify(JSON.stringify(bad))) throw new Error(`${name}: verify mismatch`);
  console.log(`${name}: prove ${xs.map((x) => x.toFixed(2)).join(' / ')} s, verify ${(tv * 1000).toFixed(0)} ms, proof ${doc.proof.length / 2} B`);
}
