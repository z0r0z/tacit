// Build an OP_UNWRAP witness that spends the transfer-output note (leaf 1) on pool 0x3D38,
// releasing its escrowed ETH to RECIPIENT. Reconstructs the deterministic blindings from
// e2e-confidential-settle.mjs (same 'cps-e2e:' tags), rebuilds the live tree [leaf0, leaf1],
// and self-checks leaf1 + root against the known on-chain values before writing.
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
const RECIPIENT = '0xD5B75Ea6dfC22E234ecA88e5C75f5E1972b2C6E1';
const V = 10000n;
const OWNER = '0x' + '11'.repeat(32);
const KNOWN_LEAF1 = '0x3f508196a93422ef5b085e73f0b38b0c33d88b1f1b516f66ed7ef4f036970ce5';
const KNOWN_ROOT = '0x9068baf786718449a42134fac9752f48f39a6fa8427f6a2d0056ca6a93ecdc11';

const N = secp.CURVE.n;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const be32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const xy = (P) => { const a = P.toAffine(); return { cx: be32(a.x), cy: be32(a.y) }; };
const scalar = (tag) => { let s = BigInt(hx(keccak_256(new TextEncoder().encode('cps-e2e:' + tag)))) % N; return s || 1n; };

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const xfer = makeConfidentialTransfer({ keccak256: keccak_256 });

const rIn = scalar('in-blinding'), rOut = scalar('out-blinding');
const leaf0Xy = xy(xfer.commit(V, rIn));
const leaf0 = pool.leaf(ASSET, leaf0Xy.cx, leaf0Xy.cy, OWNER);
const outXy = xy(xfer.commit(V, rOut));
const leaf1 = pool.leaf(ASSET, outXy.cx, outXy.cy, OWNER);
if (leaf1 !== KNOWN_LEAF1) throw new Error(`leaf1 mismatch: ${leaf1} != ${KNOWN_LEAF1}`);

const tree = new pool.Tree();
tree.insert(leaf0); tree.insert(leaf1);
const { root, path: path1 } = tree.rootAndPath(1);
if (root !== KNOWN_ROOT) throw new Error(`root mismatch: ${root} != ${KNOWN_ROOT}`);
if (!pool.verifyPath(leaf1, 1, path1, root)) throw new Error('leaf1 membership self-check failed');

const unwrapOp = {
  chainBinding: CHAIN_BINDING, spendRoot: root, asset: ASSET,
  cx: outXy.cx, cy: outXy.cy, owner: OWNER, leafIndex: 1, path: path1,
  secret: '0x' + '00'.repeat(32), value: V.toString(), blinding: be32(rOut),
  recipient: RECIPIENT,
};
writeFileSync('/tmp/settle_3D38/unwrap_op.json', JSON.stringify(unwrapOp, null, 2));
console.log('leaf1            ', leaf1, '(matches on-chain ✓)');
console.log('spendRoot        ', root, '(matches live currentRoot ✓)');
console.log('nullifier(leaf1) ', pool.nullifier(outXy.cx, outXy.cy));
console.log('value            ', V.toString(), '-> wei released', (V * 10n ** 10n).toString());
console.log('recipient        ', RECIPIENT);
console.log('wrote /tmp/settle_3D38/unwrap_op.json');
