// Build an n-intent OP_SWAP_BLIND fixture for harnesses/exec-swapblind.rs.
//
//   ZKEY=<finalized amm_swap_batch zkey> N=2 OUT=swapblind_n2.json node tests/gen-swapblind-fixture.mjs
//
// Traders alternate A→B / B→A, each spending its own note from one shared tree. The proof is only
// accepted by the guest when ZKEY is the finalized ceremony key (docs/CEREMONY.md).
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialSwapblind } from '../dapp/confidential-swapblind.js';
import { swapBatchGroth16Prove } from '../dapp/confidential-swapbatch.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const N_ORDER = secp.CURVE.n;
const randScalar = () => {
  for (;;) {
    const b = createHash('sha256').update(crypto.getRandomValues(new Uint8Array(32))).digest();
    let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v);
    if (x > 0n && x < N_ORDER) return x;
  }
};

const n = Number(process.env.N || 2);
const zkey = process.env.ZKEY;
if (!zkey) { console.error('set ZKEY to the finalized amm_swap_batch zkey path'); process.exit(2); }
if (!(n >= 1 && n <= 16)) { console.error('N must be 1..16'); process.exit(2); }
const out = process.env.OUT || `swapblind_n${n}.json`;
const DIRS = process.env.DIRS ? process.env.DIRS.split(',').map(Number) : null;
const AMOUNTS = process.env.AMOUNTS ? process.env.AMOUNTS.split(',').map(BigInt) : null;

const WASM = new URL('../dapp/vendor/amm_swap_batch.wasm', import.meta.url).pathname;
const ZERO33 = '0x' + '00'.repeat(33);
const assetA = '0x' + '11'.repeat(32);
const assetB = '0x' + '22'.repeat(32);
const feeBps = 30;
const reserveAPre = 1_000_000_000n, reserveBPre = 1_000_000_000n;
const chainBinding = '0x' + 'ab'.repeat(32);
const tip = 10n;

const tree = new pool.Tree();
const traders = [];
for (let i = 0; i < n; i++) {
  const direction = DIRS ? DIRS[i] : i % 2;
  const amountIn = AMOUNTS ? AMOUNTS[i] : 1000n + BigInt(i) * 37n;
  const rInSecp = randScalar();
  const xy = pool.commitXY(amountIn + tip, rInSecp);
  const nk = '0x' + (i + 1).toString(16).padStart(2, '0').repeat(32);
  const owner = pool.nkToOwner(nk);
  const leaf = pool.leaf(direction === 0 ? assetA : assetB, xy.cx, xy.cy, owner);
  tree.insert(leaf);
  traders.push({ direction, amountIn, tip, rInSecp, xy, nk, owner, leafIndex: i });
}

const proveGroth16 = async ({ input }) => (await swapBatchGroth16Prove(input, WASM, zkey)).proofBytes;
const ammDerivePoolIdV1 = (a, b, f) => pool.ammDerivePoolIdFull(a, b, f, 0, ZERO33, 0);
const emitter = makeConfidentialSwapblind({ pool, proveGroth16, ammDerivePoolIdV1 });

const spendRoot = tree.rootAndPath(0).root;
const t0 = Date.now();
const { fixture } = await emitter.buildSwapBlindOp({
  chainBinding, assetA, assetB, feeBps, reserveAPre, reserveBPre, spendRoot,
  traders: traders.map((t) => ({
    direction: t.direction, amountIn: t.amountIn, minOut: 0, deadline: 0, tip: t.tip,
    inNote: { cx: t.xy.cx, cy: t.xy.cy, owner: t.owner, rSecp: t.rInSecp, leafIndex: t.leafIndex, path: tree.rootAndPath(t.leafIndex).path, nk: t.nk },
    outOwner: '0x' + (0x80 + t.leafIndex).toString(16).repeat(32).slice(0, 64), rOutSecp: randScalar(),
  })),
});
writeFileSync(out, JSON.stringify(fixture, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(`wrote ${out}: ${n} intents, Groth16 proved in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
