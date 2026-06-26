// EVM airdrop merkle builder for contracts/src/MerkleDistributor.sol.
//
// This is the ETHEREUM-side distributor tree — UNTAGGED keccak256 with commutative (sorted-pair)
// internal hashing, to match Solady MerkleProofLib used by MerkleDistributor.claim. It is deliberately
// distinct from the Bitcoin-side T_DROP airdrop in tests/composition.mjs (tagged sha256), which serves a
// different lane.
//
//   leaf = keccak256( abi.encodePacked(uint256 index, address account, uint256 amount) )   // 32+20+32 bytes
//   node = keccak256( min(a,b) ‖ max(a,b) )                                                  // commutative
//
// Lone nodes at an odd level are promoted unchanged (standard simple-merkle). Proof generation matches.
//
// CLI:  node tools/airdrop/build-merkle.mjs <snapshot.json> [out.json]
//   snapshot.json : [{ "account": "0x..", "amount": "<decimal or 0x hex>" , "index"?: n }, ...]
//                   (index optional; assigned by array order when absent)
//   out.json      : { root, total, count, claims: [{ index, account, amount, proof:[..] }] }
//
// Programmatic: import { buildClaims, leafHash, verifyProof } from './build-merkle.mjs'

import { keccak_256 } from '@noble/hashes/sha3.js';

const concatBytes = (...a) => {
  const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of a) { o.set(x, p); p += x.length; }
  return o;
};

const hx = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const hb = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));

function be(value, n) {
  let x = BigInt(value);
  if (x < 0n) throw new Error('negative amount');
  const o = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; }
  if (x !== 0n) throw new Error(`value overflows ${n} bytes`);
  return o;
}

function addr20(a) {
  const b = hb(a);
  if (b.length !== 20) throw new Error(`bad address (need 20 bytes): ${a}`);
  return b;
}

// Re-export keccak256 so callers don't re-import @noble (avoids subpath-export clashes in nested node_modules).
export const keccak256 = (bytes) => keccak_256(bytes);

// leaf = keccak256(abi.encodePacked(uint256 index, address account, uint256 amount))
export function leafHash(index, account, amount) {
  return keccak_256(concatBytes(be(index, 32), addr20(account), be(amount, 32)));
}

function lt(a, b) {
  for (let i = 0; i < 32; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}

export function hashPair(a, b) {
  return lt(a, b) ? keccak_256(concatBytes(a, b)) : keccak_256(concatBytes(b, a));
}

// Build all levels bottom-up; levels[0] = leaves, last level = [root].
export function buildTree(leaves) {
  if (leaves.length === 0) throw new Error('empty tree');
  const levels = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]); // promote lone node
    }
    levels.push(next);
    cur = next;
  }
  return levels;
}

export function rootOf(levels) {
  return levels[levels.length - 1][0];
}

export function getProof(levels, index) {
  const proof = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const sib = idx ^ 1;
    if (sib < level.length) proof.push(level[sib]); // else: this node was promoted (no sibling at this level)
    idx = idx >> 1;
  }
  return proof;
}

// Solady MerkleProofLib port (sorted-pair walk) — self-check that a generated proof reconstructs root.
export function verifyProof(proof, root, leaf) {
  let h = leaf;
  for (const sib of proof) h = hashPair(h, sib);
  return hx(h) === hx(root);
}

// snapshot -> { root, total, count, claims:[{index,account,amount,proof}] }
export function buildClaims(snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) throw new Error('snapshot must be a non-empty array');
  const rows = snapshot.map((r, i) => {
    const index = r.index === undefined ? i : Number(r.index);
    const account = '0x' + hx(addr20(r.account)).slice(2); // normalize
    const amount = BigInt(r.amount);
    return { index, account, amount };
  });
  // Reject duplicate indices (a duplicate index would let one slot be double-spent against the bitmap).
  const seen = new Set();
  for (const r of rows) { if (seen.has(r.index)) throw new Error(`duplicate index ${r.index}`); seen.add(r.index); }
  rows.sort((a, b) => a.index - b.index);

  const leaves = rows.map((r) => leafHash(r.index, r.account, r.amount));
  const levels = buildTree(leaves);
  const root = rootOf(levels);

  const claims = rows.map((r, i) => {
    const proof = getProof(levels, i).map(hx);
    if (!verifyProof(getProof(levels, i), root, leaves[i])) throw new Error(`self-check failed at index ${r.index}`);
    return { index: r.index, account: r.account, amount: r.amount.toString(), proof };
  });
  const total = rows.reduce((s, r) => s + r.amount, 0n);
  return { root: hx(root), total: total.toString(), count: rows.length, claims };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , inPath, outPath] = process.argv;
  if (!inPath) { console.error('usage: node tools/airdrop/build-merkle.mjs <snapshot.json> [out.json]'); process.exit(2); }
  const fs = await import('node:fs');
  const snapshot = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const out = buildClaims(snapshot);
  const text = JSON.stringify(out, null, 2);
  if (outPath) { fs.writeFileSync(outPath, text); console.error(`wrote ${out.count} claims, total ${out.total}, root ${out.root} -> ${outPath}`); }
  else console.log(text);
}
