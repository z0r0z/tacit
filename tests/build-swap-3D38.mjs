// Build an OP_SWAP (A=ETH → B=MCK) against the live funded pool 0x3D38 (reserves 50000/50000, fee 30).
// Wraps a fresh ETH input note (leaf 6), clears it at the fee-correct constant-product price, mints a B
// output note. Reconstructs the live tree (leaves 0..5: the e2e/bridgeburn notes + the lp A/B notes +
// the LP-share note) and self-checks the root vs the post-lp on-chain currentRoot before adding leaf 6.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialSwap, solveClearing, clearingPriceBperA } from '../dapp/confidential-swap.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

const ASSET_A = '0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2'; // ETH
const ASSET_B = '0x9b7221f39852ba8143fcc5e790b31d5a8736d71a95b480da1c6063ffe92d6ed1'; // MCK
const CHAIN_BINDING = '0x83af14fe2eb3e6db14685302758ee1f7295ce533bafd728f4345daa666d07518';
const OWNER = '0x' + '11'.repeat(32);
const OUT_OWNER = '0x' + '44'.repeat(32);
const FEE_BPS = 30;
const RA = 50000n, RB = 50000n;
const amountIn = 1000n; // in-system A (ETH); wrap wei = amountIn * 1e10
// live tree leaves 0..5 (known on-chain) + post-lp currentRoot
const LEAVES = [
  '0x30feb5112eec0f78fa425932a496e0c575809d69daf80a1b80f6a2b047a8ade6',
  '0x3f508196a93422ef5b085e73f0b38b0c33d88b1f1b516f66ed7ef4f036970ce5',
  '0xaccf4109e76b9418c51f638cca7bbf1308022eb43c896b1a32ec95e82cef1967',
  '0xdac90b9e82d033d2a782bfa5c22caa2689037bbd7ac8acf585bc6ae66a9e869e',
  '0x360a63b3d243bbce6d43877cec2f94767d959a6b1262f37d6f8d0352c246c3a0',
  '0x39b00c5ec389c8fe2d413a27e4cb921184bb8c57875e049f781612386e1858d9',
];
const KNOWN_ROOT_0_5 = '0xb5a5ec639f826ee8f5785d906a31b4731f190035c34038dbd60bd3f6e0bd3b85';

const N = secp.CURVE.n;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const be32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const scalar = (tag) => { let s = BigInt(hx(keccak_256(new TextEncoder().encode('cps-amm:' + tag)))) % N; return s || 1n; };

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const swap = makeConfidentialSwap({ keccak256: keccak_256, pool });

// verify the live tree [0..5]
let t05 = new pool.Tree(); LEAVES.forEach((l) => t05.insert(l));
if (t05.root() !== KNOWN_ROOT_0_5) throw new Error(`tree[0..5] root mismatch: ${t05.root()} != ${KNOWN_ROOT_0_5}`);

// fee-correct clearing price for a single A->B of amountIn against RA/RB
const sol = solveClearing(amountIn, 0n, RA, RB, FEE_BPS);
const { priceNum, priceDen } = clearingPriceBperA(sol);

const rIn = scalar('swap-in'), rOut = scalar('swap-out');
const intent = swap.buildIntent({
  direction: 'A->B', amountIn, priceNum, priceDen, minOut: 0,
  rInSecp: rIn, rOutSecp: rOut,
  inNote: { owner: OWNER, leafIndex: 6, path: pool.zeros }, outOwner: OUT_OWNER,
});

// swap input note → leaf 6; full tree [0..6] for spendRoot + path
const inLeaf = pool.leaf(ASSET_A, intent.in.cx, intent.in.cy, OWNER);
const tree = new pool.Tree(); LEAVES.forEach((l) => tree.insert(l)); tree.insert(inLeaf);
const spendRoot = tree.root();
const path6 = tree.rootAndPath(6).path;
intent.in.leafIndex = 6; intent.in.path = path6;
if (!pool.verifyPath(inLeaf, 6, path6, spendRoot)) throw new Error('swap input membership self-check failed');

const batch = swap.buildBatch({ assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre: RA, reserveBPre: RB, priceNum, priceDen, intents: [intent], spendRoot });
const { settlement, nullifiers, leaves } = swap.verifyBatch(batch, { merkleRootFrom: pool.merkleRootFrom });

const swapOp = {
  chainBinding: CHAIN_BINDING, spendRoot, assetA: ASSET_A, assetB: ASSET_B, feeBps: FEE_BPS,
  reserveAPre: Number(RA), reserveBPre: Number(RB), priceNum: Number(priceNum), priceDen: Number(priceDen),
  intents: [{
    direction: intent.dirByte, inCx: intent.in.cx, inCy: intent.in.cy, inOwner: OWNER,
    inLeafIndex: 6, inPath: path6,
    amountIn: Number(intent.amountIn), amountOut: Number(intent.amountOut), rem: Number(intent.rem),
    inSigR: intent.inSig.R, inSigZ: intent.inSig.z, minOut: 0, deadline: 0,
    outCx: intent.out.cx, outCy: intent.out.cy, outOwner: OUT_OWNER, outSigR: intent.outSig.R, outSigZ: intent.outSig.z,
  }],
  expected: { poolId: settlement.poolId, reserveAPost: Number(settlement.reserveAPost), reserveBPost: Number(settlement.reserveBPost), nullifiers, leaves },
};
writeFileSync('/tmp/settle_3D38/swap_op.json', JSON.stringify(swapOp, null, 2));
writeFileSync('/tmp/settle_3D38/wrap_swapin.json', JSON.stringify({ chainBinding: CHAIN_BINDING, asset: ASSET_A, value: amountIn.toString(), cx: intent.in.cx, cy: intent.in.cy, owner: OWNER, blinding: be32(rIn) }, null, 2));
console.log('clearing price   ', priceNum + '/' + priceDen, '(B per A)');
console.log('amountIn/out     ', amountIn.toString(), '->', intent.amountOut.toString(), 'B  (rem', intent.rem.toString() + ')');
console.log('reserves post    ', settlement.reserveAPost + '/' + settlement.reserveBPost, '(k:', (RA * RB).toString(), '->', (settlement.reserveAPost * settlement.reserveBPost).toString() + ')');
console.log('swap input leaf6 ', inLeaf);
console.log('spendRoot        ', spendRoot, '(must == currentRoot after the input wrap settles)');
console.log('output B leaf    ', leaves[0]);
console.log('WRAP_SWAPIN', ASSET_A, amountIn.toString(), intent.in.cx, intent.in.cy, OWNER, '-> wei', (amountIn * 10n ** 10n).toString());
console.log('wrote /tmp/settle_3D38/swap_op.json');
