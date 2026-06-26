// Build OP_LP_REMOVE on the live pool 0x3D38: burn the founder's LP-share note (leaf 5, 49000 shares) →
// withdraw the proportional A/B reserves as two fresh notes, leaving exactly MINIMUM_LIQUIDITY. Reconstructs
// the live 8-leaf tree (leaves 0..7) and self-checks the root + the share leaf vs the on-chain values.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialLp } from '../dapp/confidential-lp.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

const ASSET_A = '0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2';
const ASSET_B = '0x9b7221f39852ba8143fcc5e790b31d5a8736d71a95b480da1c6063ffe92d6ed1';
const CHAIN_BINDING = '0x83af14fe2eb3e6db14685302758ee1f7295ce533bafd728f4345daa666d07518';
const OWNER = '0x' + '11'.repeat(32);
const SHARE_OWNER = '0x' + '33'.repeat(32);
const FEE_BPS = 30;
const RA = 51000n, RB = 49023n, SHARES = 50000n, D_SHARES = 49000n;
const LEAVES = [
  '0x30feb5112eec0f78fa425932a496e0c575809d69daf80a1b80f6a2b047a8ade6',
  '0x3f508196a93422ef5b085e73f0b38b0c33d88b1f1b516f66ed7ef4f036970ce5',
  '0xaccf4109e76b9418c51f638cca7bbf1308022eb43c896b1a32ec95e82cef1967',
  '0xdac90b9e82d033d2a782bfa5c22caa2689037bbd7ac8acf585bc6ae66a9e869e',
  '0x360a63b3d243bbce6d43877cec2f94767d959a6b1262f37d6f8d0352c246c3a0',
  '0x39b00c5ec389c8fe2d413a27e4cb921184bb8c57875e049f781612386e1858d9', // share note (leaf 5)
  '0xb63d1e517275754e5635237ab54febc70fbf90ffd9c0ef6955a9abd331732e69',
  '0xa50ea451c555e0ca85eebccbba674679298a427567db2a0ab7feb2dbe5f0ee48',
];
const KNOWN_ROOT = '0xe9f26b0221a5fc59ec2ed2c19ae8234da81e4bc27d55c446d266095ac4e29c7d';

const N = secp.CURVE.n;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const be32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const scalar = (tag) => { let s = BigInt(hx(keccak_256(new TextEncoder().encode('cps-amm:' + tag)))) % N; return s || 1n; };

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const lp = makeConfidentialLp({ keccak256: keccak_256, pool });

const tree = new pool.Tree(); LEAVES.forEach((l) => tree.insert(l));
if (tree.root() !== KNOWN_ROOT) throw new Error(`tree root mismatch: ${tree.root()} != ${KNOWN_ROOT}`);
const sharePath = tree.rootAndPath(5).path;

const rShares = scalar('lp-shares'); // SAME blinding the lp_add minted the share note with
const op = lp.buildRemove({
  assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS,
  reserveAPre: RA, reserveBPre: RB, sharesPre: SHARES,
  shareNote: { owner: SHARE_OWNER, leafIndex: 5, path: sharePath }, dShares: D_SHARES, rShares,
  aOwner: OWNER, rA: scalar('lprm-a'), bOwner: OWNER, rB: scalar('lprm-b'),
});

// the share note we're spending must be the on-chain leaf 5
const shareLeaf = pool.leaf(lp.lpShareId(lp.poolId(ASSET_A, ASSET_B, FEE_BPS)), op.share.cx, op.share.cy, SHARE_OWNER);
if (shareLeaf !== LEAVES[5]) throw new Error(`share leaf mismatch: ${shareLeaf} != ${LEAVES[5]}`);

const { settlement, nullifiers, leaves } = lp.verifyRemove(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot: KNOWN_ROOT });

const lpRemoveOp = {
  chainBinding: CHAIN_BINDING, spendRoot: KNOWN_ROOT, op: 8, assetA: ASSET_A, assetB: ASSET_B, feeBps: FEE_BPS,
  reserveAPre: Number(RA), reserveBPre: Number(RB), sharesPre: Number(SHARES),
  share: { cx: op.share.cx, cy: op.share.cy, owner: SHARE_OWNER, leafIndex: 5, path: sharePath, dShares: Number(D_SHARES), sigR: op.sSig.R, sigZ: op.sSig.z },
  dA: Number(op.dA), remA: Number(op.remA), dB: Number(op.dB), remB: Number(op.remB),
  a: { cx: op.a.cx, cy: op.a.cy, owner: OWNER, sigR: op.aSig.R, sigZ: op.aSig.z },
  b: { cx: op.b.cx, cy: op.b.cy, owner: OWNER, sigR: op.bSig.R, sigZ: op.bSig.z },
  deadline: Number(op.deadline ?? 0),
  expected: { poolId: settlement.poolId, reserveAPost: Number(settlement.reserveAPost), reserveBPost: Number(settlement.reserveBPost), sharesPost: Number(settlement.sharesPost), nullifiers, leaves },
};
writeFileSync('/tmp/settle_3D38/lp_remove_op.json', JSON.stringify(lpRemoveOp, null, 2));
console.log('share leaf 5     ', shareLeaf, '(matches on-chain ✓)');
console.log('burn shares      ', D_SHARES.toString(), 'of', SHARES.toString(), '-> sharesPost', settlement.sharesPost.toString());
console.log('withdraw         ', op.dA.toString(), 'A +', op.dB.toString(), 'B  (reserves', RA + '/' + RB, '->', settlement.reserveAPost + '/' + settlement.reserveBPost + ')');
console.log('share nullifier  ', nullifiers[0]);
console.log('output leaves    ', leaves.join(', '));
console.log('wrote /tmp/settle_3D38/lp_remove_op.json');
