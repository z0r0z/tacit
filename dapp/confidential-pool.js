// Client module for the Phase-1 confidential pool (ConfidentialPool.sol). Builds
// the deterministic primitives the contract + SP1 guest agree on (note leaves,
// chain-independent nullifiers, deposit ids) and a Keccak incremental Merkle tree
// matching the contract's on-chain tree — the wallet needs the tree to build
// membership paths for transfers and to recover its balance from a chain scan.
//
// Leaf/nullifier/deposit-id byte layouts are locked against the contract by
// tests/gen-confidential-pool-fixture.mjs + contracts/test/ConfidentialPoolKAT.t.sol.
//
// Crypto deps injected for Node + browser: { secp, keccak256, sha256 }. Reuses
// dapp/evm-confidential.js for the secp note commitment (C = v·H + r·G).

import { makeConfidentialProver } from './evm-confidential.js';

export const TREE_DEPTH = 32;

export function makeConfidentialPool({ secp, keccak256, sha256 }) {
  const prover = makeConfidentialProver({ secp, keccak256, sha256 });
  const N = secp.CURVE.n;

  const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
  const bytesToHex = (b) => Buffer.from(b).toString('hex');
  const hx = (b) => '0x' + bytesToHex(b);
  const b32 = (v) => {
    if (v instanceof Uint8Array) return v.length === 32 ? v : padL(v, 32);
    if (typeof v === 'bigint') return hexToBytes(v.toString(16).padStart(64, '0'));
    return hexToBytes(v.toString().replace(/^0x/, '').padStart(64, '0'));
  };
  const padL = (b, n) => { const o = new Uint8Array(n); o.set(b, n - b.length); return o; };
  const beBytes = (n, len = 32) => hexToBytes(BigInt(n).toString(16).padStart(len * 2, '0'));
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
  const keccak = (...parts) => keccak256(concat(parts.map(b32)));
  const mod = (a, m) => ((a % m) + m) % m;
  const bToBig = (b) => BigInt('0x' + bytesToHex(b));

  const ZERO32 = new Uint8Array(32);

  // ── note commitment (secp), reused from the prover ──
  // commitment C = value·H + blinding·G ; returns { cx, cy } as 0x-hex.
  function commitXY(value, blinding) {
    const C = prover.commit(BigInt(value), BigInt(blinding));
    const a = C.toAffine();
    return { cx: hx(beBytes(a.x)), cy: hx(beBytes(a.y)) };
  }

  // ── deterministic note derivation from the wallet seed ──
  // (secret, blinding) for note `index` of `assetId`; recover-from-seed-alone.
  function deriveNote(seed, assetId, index) {
    const base = concat([b32(seed), new TextEncoder().encode('tacit-evm-cnote-v1'), b32(assetId), beBytes(index, 8)]);
    const secret = sha256(concat([base, new Uint8Array([0])]));
    const blinding = mod(bToBig(sha256(concat([base, new Uint8Array([1])]))), N) || 1n;
    return { secret: hx(secret), blinding };
  }

  // ── primitives the contract + guest agree on ──
  // leaf = keccak(asset_id ‖ Cx ‖ Cy ‖ owner)
  const leaf = (assetId, cx, cy, owner) => hx(keccak(assetId, cx, cy, owner));
  // nullifier = keccak(Cx ‖ Cy ‖ "spent") — note-bound (spec B3), chain-independent.
  // Derived from the commitment (not a free secret), so a note has exactly one nullifier.
  const SPENT = new Uint8Array([0x73, 0x70, 0x65, 0x6e, 0x74]); // "spent"
  const nullifier = (cx, cy) => hx(keccak256(concat([b32(cx), b32(cy), SPENT])));
  // deposit id = keccak(abi.encode(assetId, value, Cx, Cy, owner)); binds the note's
  // in-system value (the contract derives the same value = amount/unitScale at wrap, so
  // a matching id forces value·unitScale == escrowed amount). Static types encode ==
  // packed 32-byte words, so value is its big-endian 32-byte form.
  const depositId = (assetId, value, cx, cy, owner) => hx(keccak256(concat([b32(assetId), beBytes(value, 32), b32(cx), b32(cy), b32(owner)])));

  // ── Keccak incremental Merkle, matching ConfidentialPool._insertLeaf ──
  const zeros = (() => {
    const z = [ZERO32];
    for (let i = 1; i < TREE_DEPTH; i++) z.push(keccak256(concat([z[i - 1], z[i - 1]])));
    return z;
  })();

  class Tree {
    constructor() { this.leaves = []; }
    insert(leafHex) { this.leaves.push(b32(leafHex)); return this.leaves.length - 1; }

    // Root + the 32-sibling membership path for `index`, zero-filling empty
    // subtrees exactly as the on-chain incremental tree does.
    rootAndPath(index) {
      let level = this.leaves.slice();
      const path = [];
      for (let i = 0; i < TREE_DEPTH; i++) {
        const pos = index >>> i;
        const sib = pos ^ 1;
        path.push(hx(sib < level.length ? level[sib] : zeros[i]));
        const next = [];
        for (let k = 0; k * 2 < level.length; k++) {
          const l = level[2 * k];
          const r = 2 * k + 1 < level.length ? level[2 * k + 1] : zeros[i];
          next.push(keccak256(concat([l, r])));
        }
        level = next.length ? next : [zeros[i + 1] || ZERO32];
      }
      return { root: hx(level[0]), path };
    }

    root() { return this.rootAndPath(0).root; }
  }

  // ── Indexed-Merkle (spent-set) accumulator — build side, mirrors cxfer-core ──
  // imt_leaf(value, next) = keccak(value ‖ next); the set is the sorted low-nullifier
  // linked list folded into the same depth-32 keccak tree.
  const imtLeaf = (value, next) => hx(keccak(value, next));
  // Build the spent-set root from its sorted (value, next) links — what the relay
  // submits as bitcoinSpentRoot and the contract gate pins.
  function imtRoot(links) {
    const t = new Tree();
    for (const [v, n] of links) t.insert(imtLeaf(v, n));
    return t.root();
  }
  // The NON-ZERO empty-set root: a single sentinel low-leaf {0→0} ("0 is the max").
  // The reflected spent root is seeded to this and only advances; a zero root is
  // rejected by the contract (it would let the guest skip its non-membership check).
  const imtEmptyRoot = () => imtRoot([[ZERO32, ZERO32]]);

  // Stateful spent-set accumulator: maintains the sorted low-nullifier linked list
  // (seeded with the {0→0} sentinel) and supports incremental insert — the op the
  // Bitcoin-side pool indexer and the reflection prover fold each new spend through.
  // insert splits the predecessor low-leaf (its `next` → nu) and appends {nu → old
  // next} at a new index; leaf-index order is insertion (chronological) order, so the
  // root is order-dependent and the indexer + prover MUST fold in the same order.
  function makeImtAccumulator() {
    const norm = (x) => hx(b32(x));
    const big = (x) => BigInt(norm(x));
    const links = [[norm(ZERO32), norm(ZERO32)]]; // sentinel: 0 is the max, empty set
    const lowIndexOf = (nu) => links.findIndex(([v, n]) => big(v) < big(nu) && (big(n) === 0n || big(nu) < big(n)));
    function insert(nuIn) {
      const nu = norm(nuIn);
      if (big(nu) === 0n) throw new Error('cannot insert 0 (the min/sentinel anchor)');
      const i = lowIndexOf(nu);
      if (i < 0) throw new Error('no low link (nu out of range)');
      if (big(links[i][0]) === big(nu)) throw new Error('nullifier already spent');
      const old = links[i][1];
      links[i] = [links[i][0], nu]; // predecessor now points to nu
      links.push([nu, old]);        // nu takes the displaced successor
      return i;
    }
    const buildTree = () => { const t = new Tree(); for (const [v, n] of links) t.insert(imtLeaf(v, n)); return t; };
    const root = () => buildTree().root();
    function nonMembershipWitness(nuIn) {
      const nu = norm(nuIn);
      const i = lowIndexOf(nu);
      if (i < 0) throw new Error('nu is a member or out of range — no non-membership witness');
      const { path } = buildTree().rootAndPath(i);
      return { lowValue: links[i][0], lowNext: links[i][1], lowIndex: i, path };
    }
    // Prove nu IS spent: the leaf imt_leaf(nu, next) sits at `index`. bridge_mint uses
    // this to show a Bitcoin note was burned (its ν reflected into the spent set).
    function membershipWitness(nuIn) {
      const nu = norm(nuIn);
      const i = links.findIndex(([v]) => big(v) === big(nu));
      if (i < 0) throw new Error('nu is not a member — no membership witness');
      const { path } = buildTree().rootAndPath(i);
      return { next: links[i][1], index: i, path };
    }
    return { insert, root, nonMembershipWitness, membershipWitness, links: () => links.map((l) => l.slice()) };
  }

  // Mirror of the guest's keccak_merkle_verify — fold a leaf with its path.
  function verifyPath(leafHex, index, path, rootHex) {
    let h = b32(leafHex);
    for (let i = 0; i < TREE_DEPTH; i++) {
      const sib = b32(path[i]);
      h = ((index >>> i) & 1) ? keccak256(concat([sib, h])) : keccak256(concat([h, sib]));
    }
    return hx(h) === rootHex;
  }

  return {
    prover, TREE_DEPTH, zeros: zeros.map(hx),
    commitXY, deriveNote, leaf, nullifier, depositId, Tree, verifyPath,
    imtLeaf, imtRoot, imtEmptyRoot, makeImtAccumulator,
    _internal: { keccak, concat, b32, beBytes, hx },
  };
}
