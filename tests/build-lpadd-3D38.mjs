// Build the FIRST OP_LP_ADD on the live pool 0x3D38 (founds the ETH/B pool). Wraps an ETH (A) note +
// a B note, then spends both to set reserves dA/dB and mint a shielded LP-share note. Reconstructs the
// live tree (leaves 0,1,2 from deterministic e2e/bridgeburn blindings + the new A=3, B=4) to compute the
// spendRoot + membership paths. Writes wrap_A.json, wrap_B.json (for the wrap() calls + OP_WRAP settles)
// and lp_op.json (the OP_LP_ADD witness). lp.buildAdd self-checks the openings/conservation.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialLp } from '../dapp/confidential-lp.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (arrs) => { let n = 0; for (const a of arrs) n += a.length; const o = new Uint8Array(n); let i = 0; for (const a of arrs) { o.set(a, i); i += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

const ASSET_A = '0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2'; // ETH (canonical lower)
const ASSET_B = '0x9b7221f39852ba8143fcc5e790b31d5a8736d71a95b480da1c6063ffe92d6ed1'; // MockERC20
const CHAIN_BINDING = '0x83af14fe2eb3e6db14685302758ee1f7295ce533bafd728f4345daa666d07518';
const OWNER = '0x' + '11'.repeat(32);
const SHARE_OWNER = '0x' + '33'.repeat(32);
const FEE_BPS = 30;
const dA = 50000n, dB = 50000n; // in-system; wrap wei = d * 1e10
const KNOWN_LEAF0 = '0x30feb5112eec0f78fa425932a496e0c575809d69daf80a1b80f6a2b047a8ade6';
const KNOWN_LEAF1 = '0x3f508196a93422ef5b085e73f0b38b0c33d88b1f1b516f66ed7ef4f036970ce5';
const KNOWN_LEAF2 = '0xaccf4109e76b9418c51f638cca7bbf1308022eb43c896b1a32ec95e82cef1967';

const N = secp.CURVE.n;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const be32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const scalar = (tag) => { let s = BigInt(hx(keccak_256(new TextEncoder().encode('cps-amm:' + tag)))) % N; return s || 1n; };

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const lp = makeConfidentialLp({ keccak256: keccak_256, pool , kernelSign: ct.kernelSign, rangeProve: ct.rangeProve });
const ct = makeConfidentialTransfer({ keccak256: keccak_256 });

const rA = scalar('lp-A'), rB = scalar('lp-B'), rShares = scalar('lp-shares');
const op = lp.buildAdd({
  assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS,
  reserveAPre: 0, reserveBPre: 0, sharesPre: 0,
  aNote: { owner: OWNER, leafIndex: 0, path: pool.zeros }, dA, rA,
  bNote: { owner: OWNER, leafIndex: 0, path: pool.zeros }, dB, rB,
  shareOwner: SHARE_OWNER, rShares,
});

// the A + B contribution leaves (asset-bound)
const leafA = pool.leaf(ASSET_A, op.a.cx, op.a.cy, OWNER);
const leafB = pool.leaf(ASSET_B, op.b.cx, op.b.cy, OWNER);

// live tree: existing leaves 0,1,2 + A(3) + B(4)
const e0 = (tag, v) => { const C = ct.commit(v, scalar.__proto__ ? undefined : 0); return C; }; // placeholder
// reconstruct existing leaves via the prior e2e/bridgeburn 'cps-e2e:' blindings
const eScalar = (tag) => { let s = BigInt(hx(keccak_256(new TextEncoder().encode('cps-e2e:' + tag)))) % N; return s || 1n; };
const exyA = (P) => { const a = P.toAffine(); return { cx: be32(a.x), cy: be32(a.y) }; };
const l0 = exyA(ct.commit(10000n, eScalar('in-blinding'))); const leaf0 = pool.leaf(ASSET_A, l0.cx, l0.cy, OWNER);
const l1 = exyA(ct.commit(10000n, eScalar('out-blinding'))); const leaf1 = pool.leaf(ASSET_A, l1.cx, l1.cy, OWNER);
const l2 = exyA(ct.commit(7000n, eScalar('bridgeburn-in'))); const leaf2 = pool.leaf(ASSET_A, l2.cx, l2.cy, OWNER);
if (leaf0 !== KNOWN_LEAF0 || leaf1 !== KNOWN_LEAF1 || leaf2 !== KNOWN_LEAF2) throw new Error(`existing-leaf reconstruction mismatch:\n ${leaf0}\n ${leaf1}\n ${leaf2}`);

const tree = new pool.Tree();
[leaf0, leaf1, leaf2, leafA, leafB].forEach((l) => tree.insert(l));
const spendRoot = tree.root();
op.a.leafIndex = 3; op.a.path = tree.rootAndPath(3).path;
op.b.leafIndex = 4; op.b.path = tree.rootAndPath(4).path;
if (!pool.verifyPath(leafA, 3, op.a.path, spendRoot)) throw new Error('A membership self-check failed');
if (!pool.verifyPath(leafB, 4, op.b.path, spendRoot)) throw new Error('B membership self-check failed');

const { settlement, nullifiers, leaves } = lp.verifyAdd(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });

const wrapA = { chainBinding: CHAIN_BINDING, asset: ASSET_A, value: dA.toString(), cx: op.a.cx, cy: op.a.cy, owner: OWNER, blinding: be32(rA) };
const wrapB = { chainBinding: CHAIN_BINDING, asset: ASSET_B, value: dB.toString(), cx: op.b.cx, cy: op.b.cy, owner: OWNER, blinding: be32(rB) };
const lpOp = {
  chainBinding: CHAIN_BINDING, spendRoot, op: 7, assetA: ASSET_A, assetB: ASSET_B, feeBps: FEE_BPS,
  reserveAPre: 0, reserveBPre: 0, sharesPre: 0,
  a: { cx: op.a.cx, cy: op.a.cy, owner: OWNER, leafIndex: 3, path: op.a.path, d: Number(op.dA), sigR: op.aSig.R, sigZ: op.aSig.z },
  b: { cx: op.b.cx, cy: op.b.cy, owner: OWNER, leafIndex: 4, path: op.b.path, d: Number(op.dB), sigR: op.bSig.R, sigZ: op.bSig.z },
  share: { cx: op.share.cx, cy: op.share.cy, owner: SHARE_OWNER, sigR: op.sSig.R, sigZ: op.sSig.z },
  deadline: Number(op.deadline ?? 0),
  expected: { poolId: settlement.poolId, reserveAPost: Number(settlement.reserveAPost), reserveBPost: Number(settlement.reserveBPost), sharesPost: Number(settlement.sharesPost), nullifiers, leaves },
};

writeFileSync('/tmp/settle_3D38/wrap_A.json', JSON.stringify(wrapA, null, 2));
writeFileSync('/tmp/settle_3D38/wrap_B.json', JSON.stringify(wrapB, null, 2));
writeFileSync('/tmp/settle_3D38/lp_op.json', JSON.stringify(lpOp, null, 2));
console.log('leafA(3)         ', leafA);
console.log('leafB(4)         ', leafB);
console.log('lp spendRoot     ', spendRoot, '(must == currentRoot after both wraps settle)');
console.log('poolId           ', settlement.poolId);
console.log('reserves post    ', settlement.reserveAPost + '/' + settlement.reserveBPost, 'shares', settlement.sharesPost, '(dShares', op.dShares?.toString(), ')');
console.log('share leaf (mint)', leaves[0]);
console.log('WRAP_A', ASSET_A, dA.toString(), op.a.cx, op.a.cy, OWNER, '-> wei', (dA * 10n ** 10n).toString());
console.log('WRAP_B', ASSET_B, dB.toString(), op.b.cx, op.b.cy, OWNER, '-> base', (dB * 10n ** 10n).toString());
console.log('wrote wrap_A.json + wrap_B.json + lp_op.json');
