// Cumulative merkle tree builder for contracts/src/PointsDistributor.sol.
//
// Vendored copy of ../../../tools/points-tree.mjs's core (that file is canonical — ops tooling, fixture
// generation, contracts/test/PointsDistributorVectors.t.sol's cross-language check all run against it). This
// copy exists only because Render's build for this service sets rootDir: worker-relay, so the Docker build
// context can't reach the repo-root tools/ directory; runtime code here has to be self-contained. Keep the two
// byte-for-byte identical — a change to one without the other is exactly the kind of drift that produces a
// leaf encoding mismatch nothing catches until a real claim reverts with BadProof.
//
// Unlike tools/airdrop-tree.mjs (a one-shot, index-keyed tree for TacAirdrop's immutable single root), this
// builds a tree for a distributor whose root is republished periodically: each leaf is `(account,
// cumulativeAmount)` — the TOTAL an account has ever earned to date, not a per-epoch delta. No index, no
// alignment-to-unit-scale requirement (TAC claims here are plain ERC20 transfers, not pool wraps).
//
// Leaf : keccak256(keccak256(abi.encode(address account, uint256 cumulativeAmount)))
// Node : keccak256(min(a, b) ‖ max(a, b))
// Layout: one array of 2n-1 nodes, leaves in reverse order at the end, node i's children at 2i+1 / 2i+2 — the
//         same layout Solady's MerkleTreeLib builds, so contracts/test/PointsDistributor.t.sol can rebuild any
//         tree this tool emits and cross-check it byte-for-byte.

import { keccak_256 } from '@noble/hashes/sha3.js';

const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
const cat = (...a) => Buffer.concat(a.map((x) => Buffer.from(x)));
const word = (v) => {
  const b = Buffer.alloc(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  if (x) throw new Error('overflow');
  return b;
};

export function checksum(addr) {
  const a = addr.toLowerCase().replace(/^0x/, '');
  const h = Buffer.from(keccak_256(Buffer.from(a, 'ascii'))).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}

export function normalizeAddress(s) {
  const t = String(s).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error(`not an address: ${t}`);
  const body = t.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && checksum(t) !== t) throw new Error(`bad checksum: ${t}`);
  return t.toLowerCase();
}

export function leafHash(address, cumulativeAmount) {
  const inner = keccak_256(cat(word(BigInt(address)), word(cumulativeAmount)));
  return keccak_256(inner);
}

const pairHash = (a, b) => keccak_256(Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? cat(a, b) : cat(b, a));

export function buildTree(leaves) {
  const n = leaves.length;
  if (n === 0) throw new Error('no leaves');
  const tree = new Array(2 * n - 1);
  for (let i = 0; i < n; i++) tree[2 * n - 2 - i] = leaves[i];
  for (let i = n - 2; i >= 0; i--) tree[i] = pairHash(tree[2 * i + 1], tree[2 * i + 2]);
  return tree;
}

export function proofFor(tree, position) {
  const n = (tree.length + 1) / 2;
  let i = 2 * n - 2 - position;
  const proof = [];
  while (i > 0) {
    proof.push(tree[i % 2 === 1 ? i + 1 : i - 1]);
    i = (i - 1) >> 1;
  }
  return proof;
}

export function verifyProof(proof, root, leaf) {
  let h = Buffer.from(leaf);
  for (const p of proof) h = Buffer.from(pairHash(h, unhex(p)));
  return hex(h) === String(root).toLowerCase();
}

export const formatTac = (wei) => {
  const w = BigInt(wei);
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return (w / 10n ** 18n).toString() + (frac ? '.' + frac : '');
};

// entries: [{ address, cumulativeAmountWei: bigint }], every account's TOTAL earned to date (not a delta).
// Every entry is checked before a root is produced: well-formed/checksummed address, no zero address, no
// duplicate, amount > 0 (a zero-amount leaf is just omitted — nothing to claim). Every proof is recomputed
// against the root before anything is returned, so a caller never receives an unverifiable tree.
export function build(entries) {
  const problems = [];
  const seen = new Map();
  const rows = [];
  entries.forEach((e, i) => {
    const where = `entry ${i + 1}`;
    let addr;
    try { addr = normalizeAddress(e.address); } catch (err) { problems.push(`${where}: ${err.message}`); return; }
    if (BigInt(addr) === 0n) problems.push(`${where}: zero address`);
    if (seen.has(addr)) problems.push(`${where}: duplicate of entry ${seen.get(addr) + 1} (${addr})`);
    else seen.set(addr, i);
    const amt = e.cumulativeAmountWei;
    if (typeof amt !== 'bigint' || amt <= 0n) problems.push(`${where}: cumulativeAmountWei must be a positive bigint (${addr})`);
    rows.push({ address: addr, cumulativeAmountWei: amt });
  });
  if (!rows.length) problems.push('no entries');
  if (problems.length) { const e = new Error(problems.length + ' problem(s):\n  ' + problems.join('\n  ')); e.problems = problems; throw e; }

  rows.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const leaves = rows.map((r) => leafHash(r.address, r.cumulativeAmountWei));
  const tree = buildTree(leaves);
  const root = hex(tree[0]);
  const total = rows.reduce((s, r) => s + r.cumulativeAmountWei, 0n);
  const claims = {};
  rows.forEach((r, i) => {
    claims[r.address] = {
      address: checksum(r.address),
      cumulativeAmount: r.cumulativeAmountWei.toString(),
      proof: proofFor(tree, i).map(hex),
    };
  });
  const out = { root, count: rows.length, totalWei: total.toString(), claims };
  verifyFile(out); // never emit a tree that does not check out
  return out;
}

export function verifyFile(file) {
  const errors = [];
  const root = (file.root || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(root)) errors.push('missing or malformed root');
  let total = 0n;
  for (const [key, c] of Object.entries(file.claims || {})) {
    try {
      const addr = normalizeAddress(c.address);
      if (addr !== key.toLowerCase()) errors.push(`${key}: key/address mismatch`);
      const amt = BigInt(c.cumulativeAmount);
      total += amt;
      const leaf = leafHash(addr, amt);
      if (!verifyProof(c.proof, root, leaf)) errors.push(`${key}: proof does not verify`);
    } catch (err) { errors.push(`${key}: ${err.message}`); }
  }
  if (file.totalWei !== undefined && BigInt(file.totalWei) !== total) {
    errors.push(`declared totalWei ${file.totalWei} != recomputed ${total}`);
  }
  if (errors.length) throw new Error(errors.length + ' problem(s):\n  ' + errors.join('\n  '));
  return { ok: true, total };
}
