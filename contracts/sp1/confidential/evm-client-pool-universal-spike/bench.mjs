// bench.mjs <groth16|plonk|fflonk> <zkey> [runs] [singleThread]
// Times `snarkjs.<sys>.prove` in-process on the prebuilt witness (build/spend.wtns), verifies the result
// against the zkey's vk, writes build/<tag>_proof.json / _public.json, and reports peak RSS.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import * as snarkjs from 'snarkjs';

const [, , sys, zkeyPath, runsArg, st] = process.argv;
const runs = +(runsArg ?? 3);
const singleThread = st === '1';
const tag = { groth16: 'g16', plonk: 'plonk', fflonk: 'fflonk' }[sys];
const B = new URL('./build/', import.meta.url).pathname;
const quiet = { info() {}, warn() {}, error: console.error, debug() {} };

const wasm = B + 'spend_js/spend.wasm';
const input = JSON.parse(readFileSync(B + 'input.json', 'utf8'));
let t = performance.now();
const wtns = { type: 'mem' };
await snarkjs.wtns.calculate(input, wasm, wtns);
const tw = (performance.now() - t) / 1000;

const opts = [undefined, { singleThread }];
const xs = [];
let res;
for (let i = 0; i < runs; i++) {
  t = performance.now();
  res = await snarkjs[sys].prove(zkeyPath, wtns, ...opts);
  xs.push((performance.now() - t) / 1000);
}
const vk = await snarkjs.zKey.exportVerificationKey(zkeyPath, quiet);
const ok = await snarkjs[sys].verify(vk, res.publicSignals, res.proof, quiet);
writeFileSync(B + `${tag}_proof.json`, JSON.stringify(res.proof));
writeFileSync(B + `${tag}_public.json`, JSON.stringify(res.publicSignals));
writeFileSync(B + `${tag}_vk.json`, JSON.stringify(vk));
const maxRSS = process.resourceUsage().maxRSS; // KiB on macOS as reported by libuv
console.log(JSON.stringify({
  sys, zkeyBytes: statSync(zkeyPath).size, witnessSec: +tw.toFixed(2),
  proveSec: xs.map((x) => +x.toFixed(2)), singleThread, verified: ok,
  peakRssMiB: Math.round(maxRSS / 1024), nPublic: res.publicSignals.length,
}));
process.exit(ok ? 0 : 1);
