// Builds the `pay` spend witness input (2 in, 3 out) exactly as tests/btc-pool-zk.test.mjs does, and
// checks it against the r1cs. Writes build/input.json and build/spend.wtns.
import { writeFileSync } from 'node:fs';
import * as snarkjs from 'snarkjs';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from 'poseidon-lite';
import { makeBtcPoolZk, assetField, bodyHash } from '../../../../dapp/btc-pool-zk.js';

const B = new URL('./build/', import.meta.url).pathname;
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
const zk = makeBtcPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const te = new TextEncoder();

const alice = zk.walletKeys(new Uint8Array(32).fill(7), 'signet');
const bob = zk.walletKeys(new Uint8Array(32).fill(9), 'signet');
const assetF = assetField(new Uint8Array(32).fill(0xab));
const s1 = Uint8Array.from([2, ...new Uint8Array(32).fill(0x11)]);
const s2 = Uint8Array.from([3, ...new Uint8Array(32).fill(0x22)]);
const k1 = zk.ownedKeys(alice, s1);
const k2 = zk.ownedKeys(alice, s2);
const leaf1 = zk.leafOf(assetF, 1000n, k1.npk, k1.rho);
const leaf2 = zk.leafOf(assetF, 234n, k2.npk, k2.rho);
const T = zk.tree([123n, leaf1, 456n, leaf2]);
const BH = bodyHash(te.encode('T_BTC_SPEND body bytes: asset h_anchor bind nf outputs exit want'));
const inp = (k, v, index) => ({ v, rho: k.rho, nk: k.nk, Ak: k.Ak, index, path: T.path(index), sig: zk.sign(k.sk, BH) });
const out = (W, v, s) => { const o = zk.outputKeys(W.A, W.N, s); return { v, npk: o.npk, rho: o.rho }; };
const sOut = (i) => Uint8Array.from([2, ...new Uint8Array(32).fill(0x40 + i)]);

const w = zk.buildWitness({
  root: T.root, bodyHash: BH, assetF,
  inputs: [inp(k1, 1000n, 1), inp(k2, 234n, 3)],
  outputs: [out(bob, 900n, sOut(0)), out(alice, 300n, sOut(1)), out(bob, 34n, sOut(2))],
});
const input = w.input ?? w;
writeFileSync(B + 'input.json', JSON.stringify(input, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));
await snarkjs.wtns.calculate(input, B + 'spend_js/spend.wasm', B + 'spend.wtns');
const ok = await snarkjs.wtns.check(B + 'spend.r1cs', B + 'spend.wtns', console);
console.log('witness satisfies r1cs:', ok);
process.exit(ok ? 0 : 1);
