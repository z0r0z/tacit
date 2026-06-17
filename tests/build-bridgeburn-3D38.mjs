// Build a wrap (fresh ETH note → leaf 2) + an OP_BRIDGE_BURN witness that burns it into a Bitcoin
// destination crossOut, on the live pool 0x3D38. Reconstructs leaf0/leaf1 (deterministic e2e blindings)
// to rebuild the live tree, self-checks them vs the known on-chain leaves, then computes leaf2's path
// against the post-wrap tree [leaf0, leaf1, leaf2]. Writes wrap_op2.json + bridgeburn_op.json.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (arrs) => { let n = 0; for (const a of arrs) n += a.length; const o = new Uint8Array(n); let i = 0; for (const a of arrs) { o.set(a, i); i += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

const ASSET = '0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2';
const CHAIN_BINDING = '0x83af14fe2eb3e6db14685302758ee1f7295ce533bafd728f4345daa666d07518';
const OWNER = '0x' + '11'.repeat(32);
const BTC_OWNER = '0x' + Buffer.from('btc-dest-owner'.padEnd(32, '\0')).toString('hex');
const KNOWN_LEAF0 = '0x30feb5112eec0f78fa425932a496e0c575809d69daf80a1b80f6a2b047a8ade6';
const KNOWN_LEAF1 = '0x3f508196a93422ef5b085e73f0b38b0c33d88b1f1b516f66ed7ef4f036970ce5';
const V2 = 7000n; // in-system value; wrap wei = V2 * 1e10

const N = secp.CURVE.n;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const be32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const xy = (P) => { const a = P.toAffine(); return { cx: be32(a.x), cy: be32(a.y) }; };
const ptHex = (P) => '0x' + Buffer.from(P.toRawBytes(true)).toString('hex');
const scalar = (tag) => { let s = BigInt(hx(keccak_256(new TextEncoder().encode('cps-e2e:' + tag)))) % N; return s || 1n; };

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const ct = makeConfidentialTransfer({ keccak256: keccak_256 });

// existing leaves (deterministic from e2e-confidential-settle.mjs)
const l0 = xy(ct.commit(10000n, scalar('in-blinding')));
const leaf0 = pool.leaf(ASSET, l0.cx, l0.cy, OWNER);
const l1 = xy(ct.commit(10000n, scalar('out-blinding')));
const leaf1 = pool.leaf(ASSET, l1.cx, l1.cy, OWNER);
if (leaf0 !== KNOWN_LEAF0 || leaf1 !== KNOWN_LEAF1) throw new Error(`leaf reconstruction mismatch: ${leaf0} ${leaf1}`);

// fresh note → leaf 2 (the bridge-burn input)
const r2 = scalar('bridgeburn-in');
const c2 = xy(ct.commit(V2, r2));
const leaf2 = pool.leaf(ASSET, c2.cx, c2.cy, OWNER);
const wrapOp2 = { chainBinding: CHAIN_BINDING, asset: ASSET, value: V2.toString(), cx: c2.cx, cy: c2.cy, owner: OWNER, blinding: be32(r2) };
const depositId2 = pool.depositId(ASSET, V2, c2.cx, c2.cy, OWNER);

// tree after the wrap settle: [leaf0, leaf1, leaf2] → R3 + leaf2 path
const tree = new pool.Tree();
tree.insert(leaf0); tree.insert(leaf1); tree.insert(leaf2);
const R3 = tree.root();
const path2 = tree.rootAndPath(2).path;
if (!pool.verifyPath(leaf2, 2, path2, R3)) throw new Error('leaf2 membership self-check failed');

// OP_BRIDGE_BURN: burn leaf2 (V2) → one Bitcoin crossOut (V2), Σin==Σout
const bindNu = pool.nullifier(c2.cx, c2.cy);
const bb = ct.buildBridgeBurn({
  inputs: [{ value: V2, blinding: r2 }],
  outputs: [{ value: V2, blinding: scalar('bridgeburn-out'), owner: BTC_OWNER }],
  assetId: ASSET, destChain: 1, bindNullifier: bindNu,
});
if (!ct.verifyBridgeBurn(bb)) throw new Error('verifyBridgeBurn self-check failed');
const o0 = xy(bb.outC[0]);
const bridgeBurnOp = {
  chainBinding: CHAIN_BINDING, spendRoot: R3, asset: ASSET, owner: OWNER, destChain: 1,
  inputs: [{ cx: c2.cx, cy: c2.cy, owner: OWNER, leafIndex: 2, path: path2, secret: '0x' + '00'.repeat(32) }],
  outputs: [{ cx: o0.cx, cy: o0.cy, owner: BTC_OWNER }],
  rangeProof: hx(bb.rangeProof), kernel: { R: ptHex(bb.kernel.R), z: be32(bb.kernel.z) },
  expected: { crossOuts: bb.crossOuts.map((c) => ({ destChain: c.destChain, destCommitment: c.destCommitment, nullifier: c.nullifier, assetId: c.assetId, claimId: c.claimId })) },
};

writeFileSync('/tmp/settle_3D38/wrap_op2.json', JSON.stringify(wrapOp2, null, 2));
writeFileSync('/tmp/settle_3D38/bridgeburn_op.json', JSON.stringify(bridgeBurnOp, null, 2));
console.log('leaf2            ', leaf2);
console.log('post-wrap2 root R3', R3, '(bridge_burn spendRoot)');
console.log('bind nullifier   ', bindNu);
console.log('crossOut claimId ', bb.crossOuts[0].claimId);
console.log('crossOut destCmt ', bb.crossOuts[0].destCommitment);
console.log('WRAP2_ARGS', ASSET, V2.toString(), c2.cx, c2.cy, OWNER, '-> wei', (V2 * 10n ** 10n).toString(), 'depositId', depositId2);
console.log('wrote /tmp/settle_3D38/wrap_op2.json + bridgeburn_op.json');
