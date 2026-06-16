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
import { verifySchnorr } from './bulletproofs.js';
import { bppRangeVerify, bytesToPoint as bppPoint } from './bulletproofs-plus.js';

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

  // The per-bid secret driving an OP_BID buyer's received-note blindings — derived from the wallet
  // seed + the bid's own funding commitment (Cx,Cy), so it is recoverable FROM THE SEED ALONE after a
  // wipe: the buyer re-finds its funding leaf on-chain, recomputes this secret, and re-derives the
  // filled notes (the seller can't seal a memo for them — it never learns these blindings). The guest
  // is agnostic to how the buyer produced the blindings (it only re-checks commitments), so this is a
  // client-only binding (no re-prove).
  function deriveBidSecret(seed, fundCx, fundCy) {
    return hx(sha256(concat([b32(seed), new TextEncoder().encode('tacit-evm-bid-secret-v1'), b32(fundCx), b32(fundCy)])));
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
    // Is nu already in the set? (a non-throwing membership query — the burn-deposit fold uses it to
    // skip-not-panic on a re-presented/collided ν, mirroring the guest's fold_spent().is_ok() guard.)
    const contains = (nuIn) => { const nu = norm(nuIn); return links.some(([v]) => big(v) === big(nu)); };
    return { insert, root, nonMembershipWitness, membershipWitness, contains, links: () => links.map((l) => l.slice()) };
  }

  // ── Bridge-burn accumulator — build side, mirrors cxfer-core UtxoAccumulator ──
  // utxo_leaf(key, next, value) = keccak(key ‖ next ‖ value): a sorted linked list keyed
  // by the burned note's ν, each live node carrying its destCommitment as the value, seeded
  // with the {0→0→0} sentinel. The committed root is what the reflection prover submits as
  // bitcoinBurnRoot; bridge_mint proves ν is a live key here with value == its dest_leaf, so
  // only a note burned FOR THE BRIDGE (not an ordinary spend) is mintable, at its pinned dest.
  const utxoLeaf = (key, next, value) => hx(keccak(key, next, value));
  function makeUtxoAccumulator() {
    const norm = (x) => hx(b32(x));
    const big = (x) => BigInt(norm(x));
    // [key, next, value, alive]: a tombstoned node (alive=false) hashes to 0 (skipped).
    const nodes = [[norm(ZERO32), norm(ZERO32), norm(ZERO32), true]]; // sentinel: key 0 is the max
    const lowIndexOf = (key) => nodes.findIndex(([k, n, , a]) => a && big(k) < big(key) && (big(n) === 0n || big(key) < big(n)));
    const find = (key) => nodes.findIndex(([k, , , a]) => a && big(k) === big(key));
    const predOf = (key) => nodes.findIndex(([, n, , a]) => a && big(n) === big(key));
    function insert(keyIn, valueIn) {
      const key = norm(keyIn), value = norm(valueIn);
      if (big(key) === 0n) throw new Error('cannot insert key 0 (the sentinel anchor)');
      const i = lowIndexOf(key);
      if (i < 0) throw new Error('no low link (key present or out of range)');
      if (big(nodes[i][0]) === big(key)) throw new Error('outpoint/ν already present');
      const old = nodes[i][1];
      nodes[i] = [nodes[i][0], key, nodes[i][2], true]; // predecessor → key
      nodes.push([key, old, value, true]);              // key takes the displaced successor + its value
      return i;
    }
    // Spend an outpoint: rewire its predecessor to skip it, then tombstone it (leaf → 0).
    function remove(keyIn) {
      const key = norm(keyIn);
      const i = find(key); if (i < 0) throw new Error('outpoint not in the UTXO set');
      const p = predOf(key); if (p < 0) throw new Error('predecessor missing');
      nodes[p] = [nodes[p][0], nodes[i][1], nodes[p][2], true]; // pred.next = node.next
      nodes[i] = [nodes[i][0], nodes[i][1], nodes[i][2], false]; // tombstone
    }
    const leafAt = ([k, n, v, a]) => (a ? utxoLeaf(k, n, v) : hx(ZERO32));
    const buildTree = () => { const t = new Tree(); for (const nd of nodes) t.insert(leafAt(nd)); return t; };
    const root = () => buildTree().root();
    const leaves = () => nodes.map(leafAt);
    function membershipWitness(keyIn) {
      const i = find(norm(keyIn));
      if (i < 0) throw new Error('key is not a member — no membership witness');
      const { path } = buildTree().rootAndPath(i);
      return { next: nodes[i][1], value: nodes[i][2], index: i, path };
    }
    // The straddling low node (insert witness) and the predecessor (remove witness) — what the
    // Phase-4.2 witness builder hands the prover's utxo_insert_transition / utxo_remove_transition.
    function low(keyIn) {
      const i = lowIndexOf(norm(keyIn)); if (i < 0) return null;
      return { index: i, key: nodes[i][0], next: nodes[i][1], value: nodes[i][2] };
    }
    function predecessor(keyIn) {
      const i = predOf(norm(keyIn)); if (i < 0) return null;
      return { index: i, key: nodes[i][0], value: nodes[i][2] };
    }
    return { insert, remove, root, leaves, membershipWitness, low, predecessor, nodes: () => nodes.map((n) => n.slice()) };
  }

  // ── Live UTXO set — full-scan reflection (F4), mirrors cxfer-core LiveUtxoSet ──
  // The live-ONLY outpoint → commitment_hash set the full-scan prover is HANDED + root-checks
  // once, then resolves every confirmed tx's vins against. Committed as the depth-32 keccak tree
  // over keccak(key ‖ value) leaves in ascending key order — so the root is O(live) to rebuild
  // (unlike the insertion-order UtxoAccumulator, O(history)). Lives only in the reflection digest.
  // Leaf = keccak(key ‖ asset ‖ value): the asset is committed so the reflection digest pins each
  // note's asset (a wrong handoff fails the digest), which is what lets the CXFER fold re-impose
  // asset preservation on resume. Mirrors cxfer-core LiveUtxoSet::root (kn(&[k, a, v])).
  const liveLeaf = (key, value, asset) => hx(keccak(key, asset, value));
  function makeLiveUtxoSet() {
    const norm = (x) => hx(b32(x));
    const big = (x) => BigInt(norm(x));
    let entries = []; // [key, value, asset], ascending by key
    const idxOf = (key) => entries.findIndex(([k]) => big(k) === big(key));
    const sort = () => entries.sort((a, b) => (big(a[0]) < big(b[0]) ? -1 : big(a[0]) > big(b[0]) ? 1 : 0));
    // Resolve → [value=commitment_hash, asset]; the asset is what the CXFER fold checks vs the envelope.
    function get(keyIn) { const i = idxOf(norm(keyIn)); return i < 0 ? null : [entries[i][1], entries[i][2]]; }
    function insert(keyIn, valueIn, assetIn) {
      const key = norm(keyIn), value = norm(valueIn), asset = norm(assetIn);
      if (big(key) === 0n) throw new Error('live set: key 0 reserved');
      if (idxOf(key) >= 0) throw new Error('live set: duplicate outpoint');
      entries.push([key, value, asset]); sort();
    }
    function remove(keyIn) {
      const key = norm(keyIn), i = idxOf(key);
      if (i < 0) throw new Error('live set: outpoint not live');
      const [, v, a] = entries[i]; entries.splice(i, 1); return [v, a];
    }
    function root() { const t = new Tree(); for (const [k, v, a] of entries) t.insert(liveLeaf(k, v, a)); return t.root(); }
    // The sorted (key,value,asset) triples handed to the prover (its from_sorted re-checks the order).
    const triples = () => entries.map(([k, v, a]) => [k, v, a]);
    // Adopt a handed set when resuming from a snapshot.
    function load(ts) { entries = []; for (const [k, v, a] of ts) insert(k, v, a); }
    return { get, insert, remove, root, triples, load, len: () => entries.length };
  }

  // The UTXO-set value for a note: keccak(Cx ‖ Cy) — what the reflection prover stores at an
  // outpoint and re-opens to derive ν. Mirrors cxfer-core::commitment_hash.
  const commitmentHash = (cx, cy) => hx(keccak(cx, cy));
  // Decompress a 33-byte secp commitment (as a CXFER envelope carries it) → its (Cx,Cy) — the
  // reflection indexer resolves output notes' coords this way. Mirrors cxfer-core decompress→affine.
  const decompressCommitment = (compressed) => {
    const h = (typeof compressed === 'string') ? compressed.replace(/^0x/, '') : bytesToHex(compressed);
    const a = secp.ProjectivePoint.fromHex(h).toAffine();
    return { cx: hx(beBytes(a.x)), cy: hx(beBytes(a.y)) };
  };
  // Compress an affine (Cx,Cy) → its 33-byte form (inverse of decompressCommitment) — the wire
  // form a CXFER envelope carries; used to build test fixtures + round-trip checks.
  const compressXY = (cx, cy) => hx(secp.ProjectivePoint.fromAffine({ x: BigInt(cx), y: BigInt(cy) }).toRawBytes(true));
  // The reflection prover's outpoint key: keccak(txid ‖ vout_le). Mirrors cxfer-core::outpoint_key.
  const outpointKey = (txid, vout) => {
    const v = new Uint8Array(4); new DataView(v.buffer).setUint32(0, vout, true);
    return hx(keccak256(concat([b32(txid), v])));
  };
  const u64be = (n) => beBytes(n, 32); // a u64 as a 32-byte big-endian word (digest encoding)

  // ── Reflection state (the Bitcoin-indexer / reflection-prover side) ──
  // The canonical Bitcoin confidential-pool state the reflection prover proves over: the note
  // tree, spent-set, bridge-burn set, and UTXO set, advanced as confirmed effects land. Mirrors
  // cxfer-core::WitnessedReflection BYTE-FOR-BYTE — `digest()` is the resumption anchor the
  // contract chains (knownReflectionDigest), so the JS genesis digest MUST equal the Rust
  // prover's and the contract's REFLECTION_GENESIS_DIGEST (the three-way agreement). Provides
  // `witnessTransfer` / `witnessBridgeOut` (the Δ-witnesses the prover folds) by capturing each
  // accumulator's pre-op state, then advancing.
  function makeReflectionState() {
    const notes = new Tree();            // append-only note tree (pool root)
    const spent = makeImtAccumulator();  // spent-nullifier IMT
    const utxo = makeUtxoAccumulator();  // outpoint → commitment_hash
    const burns = makeUtxoAccumulator(); // ν → destCommitment (bridge-outs only)
    let noteCount = 0;
    let height = 0;

    const poolRoot = () => notes.root();
    const spentCount = () => spent.links().length;
    const utxoCount = () => utxo.nodes().length;
    const burnCount = () => burns.nodes().length;

    function commit() { return { poolRoot: poolRoot(), spentRoot: spent.root(), burnRoot: burns.root(), height }; }
    function digest() {
      return hx(keccak(
        poolRoot(), u64be(noteCount),
        spent.root(), u64be(spentCount()),
        utxo.root(), u64be(utxoCount()),
        burns.root(), u64be(burnCount()),
        u64be(height),
      ));
    }

    // Fold a confirmed transfer: spends (nullify + remove outpoint) then outputs (append note +
    // insert outpoint→commitment). `spends`: [{ nu, outpoint }]; `outputs`: [{ noteLeaf, outpoint,
    // commitmentHash }]. Height must not decrease (same-block effects share a height).
    function applyTransfer(spends, outputs, h) {
      if (h < height) throw new Error('reflection height must not decrease');
      for (const s of spends) { spent.insert(s.nu); utxo.remove(s.outpoint); }
      for (const o of outputs) { notes.insert(o.noteLeaf); noteCount++; utxo.insert(o.outpoint, o.commitmentHash); }
      height = h;
    }
    // Fold a confirmed cross-chain burn: a spend plus ν → destCommitment in the burn set.
    function applyBridgeOut(burn, h) {
      if (h < height) throw new Error('reflection height must not decrease');
      spent.insert(burn.nu); utxo.remove(burn.outpoint); burns.insert(burn.nu, burn.destCommitment);
      height = h;
    }

    // ── Phase 4.2: build the Δ-witnesses the reflection prover folds (mirrors the Rust
    //    build_*_witness). Each is built against the CURRENT (pre-op) accumulator state. ──
    // A spent note's witness: the spent-set IMT insert (straddling low + the new slot) and the
    // UTXO remove (the node + its predecessor). ν is derived (the prover re-derives it).
    function spendWitness(cx, cy, outpoint) {
      const nu = nullifier(cx, cy);
      const spentLeaves = spent.links().map(([vv, nn]) => imtLeaf(vv, nn));
      const low = spent.nonMembershipWitness(nu); // { lowValue, lowNext, lowIndex, path }
      const sInterm = spentLeaves.slice(); sInterm[low.lowIndex] = imtLeaf(low.lowValue, nu);
      const utxoLeaves = utxo.leaves();
      const node = utxo.membershipWitness(outpoint); // { next, value, index, path }
      const pred = utxo.predecessor(outpoint);       // { index, key, value }
      const uInterm = utxoLeaves.slice(); uInterm[pred.index] = utxoLeaf(pred.key, node.next, pred.value);
      return {
        cx, cy, outpoint,
        sLowValue: low.lowValue, sLowNext: low.lowNext, sLowIndex: low.lowIndex, sLowPath: low.path,
        sNewPath: merklePath(sInterm, spentLeaves.length),
        uNodeNext: node.next, uNodeValue: node.value, uNodeIndex: node.index, uNodePath: merklePath(uInterm, node.index),
        uPredKey: pred.key, uPredValue: pred.value, uPredIndex: pred.index, uPredPath: merklePath(utxoLeaves, pred.index),
      };
    }
    // An output note's witness: the note-tree append-path (the empty next slot) + the UTXO insert.
    function outputWitness(noteLeaf, outpoint, commitmentHash) {
      const utxoLeaves = utxo.leaves();
      const low = utxo.low(outpoint); // { index, key, next, value }
      const interm = utxoLeaves.slice(); interm[low.index] = utxoLeaf(low.key, outpoint, low.value);
      return {
        noteLeaf, outpoint, commitmentHash,
        notePath: notes.rootAndPath(noteCount).path,
        uLowKey: low.key, uLowNext: low.next, uLowValue: low.value, uLowIndex: low.index, uLowPath: merklePath(utxoLeaves, low.index),
        uNewPath: merklePath(interm, utxoLeaves.length),
      };
    }
    // A burn's witness: a spend, plus the burn-set insert of ν → destCommitment.
    function burnWitness(cx, cy, outpoint, destCommitment) {
      const nu = nullifier(cx, cy);
      const burnLeaves = burns.leaves();
      const low = burns.low(nu);
      const interm = burnLeaves.slice(); interm[low.index] = utxoLeaf(low.key, nu, low.value);
      return {
        spend: spendWitness(cx, cy, outpoint), destCommitment,
        bLowKey: low.key, bLowNext: low.next, bLowValue: low.value, bLowIndex: low.index, bLowPath: merklePath(burnLeaves, low.index),
        bNewPath: merklePath(interm, burnLeaves.length),
      };
    }

    // Witness + advance, in lockstep (so later witnesses see the earlier sub-ops). spends:
    // [{cx,cy,outpoint}], outputs: [{noteLeaf,outpoint,commitmentHash}]. Returns the witnesses.
    function witnessTransfer(spends, outputs, h) {
      if (h < height) throw new Error('reflection height must not decrease');
      const sw = [];
      for (const s of spends) { sw.push(spendWitness(s.cx, s.cy, s.outpoint)); spent.insert(nullifier(s.cx, s.cy)); utxo.remove(s.outpoint); }
      const ow = [];
      for (const o of outputs) { ow.push(outputWitness(o.noteLeaf, o.outpoint, o.commitmentHash)); notes.insert(o.noteLeaf); noteCount++; utxo.insert(o.outpoint, o.commitmentHash); }
      height = h;
      return { spends: sw, outputs: ow, height: h };
    }
    function witnessBridgeOut(burn, h) {
      if (h < height) throw new Error('reflection height must not decrease');
      const bw = burnWitness(burn.cx, burn.cy, burn.outpoint, burn.destCommitment);
      const nu = nullifier(burn.cx, burn.cy);
      spent.insert(nu); utxo.remove(burn.outpoint); burns.insert(nu, burn.destCommitment);
      height = h;
      return bw;
    }

    return {
      commit, digest, applyTransfer, applyBridgeOut,
      witnessTransfer, witnessBridgeOut,
      poolRoot, spentRoot: () => spent.root(), burnRoot: () => burns.root(), utxoRoot: () => utxo.root(),
      counts: () => ({ note: noteCount, spent: spentCount(), utxo: utxoCount(), burn: burnCount(), height }),
      _acc: { notes, spent, utxo, burns }, // for the witness builder (Phase 4.2)
    };
  }

  // ── Phase 4.3: assemble the reflection prover's input (the guest's io::read order) ──
  // Given a reflection state (the prior, resumed from a digest) and a batch — { anchorHeight,
  // headers (80-byte hex), effects } — build the Δ-witnesses (advancing the state) and emit the
  // ordered field record the exec harness writes to SP1Stdin. An effect carries its tx-binding
  // (blockIndex into headers, txData, txIndex, txids) + the note data; transfer effects list
  // outputs with their vout, bridge-outs carry the burn (destCommitment comes from the envelope,
  // so it is NOT serialized). Returns { prior, anchorHeight, headers, effects, newDigest }.
  function assembleReflectionInput(state, batch) {
    const c = state.counts();
    const prior = {
      poolRoot: state.poolRoot(), noteCount: c.note,
      spentRoot: state.spentRoot(), spentCount: c.spent,
      utxoRoot: state.utxoRoot(), utxoCount: c.utxo,
      burnRoot: state.burnRoot(), burnCount: c.burn,
      height: c.height,
    };
    const effects = [];
    for (const e of (batch.effects || [])) {
      const base = { blockIndex: e.blockIndex, txData: e.txData, txIndex: e.txIndex, txids: e.txids };
      if (e.type === 'bridge_out') {
        effects.push({ op: 1, ...base, burn: state.witnessBridgeOut(e.burn, e.height) });
      } else {
        const w = state.witnessTransfer(e.spends || [], e.outputs || [], e.height);
        effects.push({ op: 0, ...base, spends: w.spends, outputs: w.outputs.map((ow, i) => ({ ...ow, vout: e.outputs[i].vout })) });
      }
    }
    return { prior, anchorHeight: batch.anchorHeight | 0, headers: batch.headers || [], effects, newDigest: state.digest() };
  }

  // ── Full-scan reflection state (F4) — mirrors cxfer-core ScanReflection ──
  // Same headless note/spent/burn engine as makeReflectionState (roots + counts + witnessed
  // transitions) but the UTXO set is the full in-memory live set. digest binds live.root() +
  // size, so a resumed cycle that re-derives this digest has provably been HANDED the committed
  // live set (the contract chains priorDigest). foldSpent/foldOutput/foldBurn build the witness a
  // sub-op needs AND advance, in the guest's per-tx order.
  function makeScanReflectionState() {
    const notes = new Tree();
    const spent = makeImtAccumulator();
    const live = makeLiveUtxoSet();
    const burns = makeUtxoAccumulator();
    let height = 0;
    // cBTC: the live self-custody cBTC.zk locks (outpoint → sats) + a running backing total. Mirrors
    // cxfer-core ScanReflection.cbtc_locks / cbtc_backing_sats — both ride digest() so the off-pool
    // CbtcBuffer reads a backing the prover cannot forge.
    const cbtcLocks = makeLiveUtxoSet();
    let cbtcBackingSats = 0n;

    // Counts derive from the accumulators (not a separate cursor), so a snapshot restore that
    // replays the raw leaves/links/nodes reconstructs the exact digest without bookkeeping drift.
    const noteCount = () => notes.leaves.length;
    const spentCount = () => spent.links().length;
    const burnCount = () => burns.nodes().length;
    const commit = () => ({ poolRoot: notes.root(), spentRoot: spent.root(), burnRoot: burns.root(), height });
    function digest() {
      return hx(keccak(
        notes.root(), u64be(noteCount()),
        spent.root(), u64be(spentCount()),
        live.root(), u64be(live.len()),
        burns.root(), u64be(burnCount()),
        u64be(height),
        cbtcLocks.root(), u64be(cbtcBackingSats),
      ));
    }

    // A detected spend's ν → the spent-set IMT insert witness (low + new slot), then advance. The
    // live-set removal is the caller's (it mirrors scan_tx_spends).
    function foldSpent(nu) {
      const spentLeaves = spent.links().map(([vv, nn]) => imtLeaf(vv, nn));
      const low = spent.nonMembershipWitness(nu);
      const interm = spentLeaves.slice(); interm[low.lowIndex] = imtLeaf(low.lowValue, nu);
      const w = { sLowValue: low.lowValue, sLowNext: low.lowNext, sLowIndex: low.lowIndex, sLowPath: low.path, sNewPath: merklePath(interm, spentLeaves.length) };
      spent.insert(nu);
      return w;
    }
    // An output note: the note-tree append-path witness, then append + add the outpoint live
    // (carrying the note's asset so a later spend's CXFER fold can enforce asset preservation).
    function foldOutput(noteLeaf, outpoint, commitmentHash, asset) {
      const w = { noteLeaf, notePath: notes.rootAndPath(noteCount()).path };
      notes.insert(noteLeaf);
      live.insert(outpoint, commitmentHash, asset);
      return w;
    }
    // A burn-deposit's proven-real note: append it to the note tree (so OP_BRIDGE_MINT proves its
    // pool membership and the kernel binds v_mint == v_burn), WITHOUT adding it live — it is spent now,
    // not in-pool-spendable. Mirror of ScanReflection::fold_note_append. Returns the append-path witness.
    function foldNoteAppend(noteLeaf) {
      const w = { noteLeaf, notePath: notes.rootAndPath(noteCount()).path };
      notes.insert(noteLeaf);
      return w;
    }
    // A bridge-out: the burn-set insert witness ν → destCommitment, then advance.
    function foldBurn(nu, destCommitment) {
      const burnLeaves = burns.leaves();
      const low = burns.low(nu);
      const interm = burnLeaves.slice(); interm[low.index] = utxoLeaf(low.key, nu, low.value);
      const w = { bLowKey: low.key, bLowNext: low.next, bLowValue: low.value, bLowIndex: low.index, bLowPath: merklePath(burnLeaves, low.index), bNewPath: merklePath(interm, burnLeaves.length) };
      burns.insert(nu, destCommitment);
      return w;
    }
    function setHeight(h) { if (h < height) throw new Error('reflection height must not decrease'); height = h; }

    return {
      commit, digest, foldSpent, foldOutput, foldNoteAppend, foldBurn, setHeight,
      spentContains: (nu) => spent.contains(nu),
      poolRoot: () => notes.root(), spentRoot: () => spent.root(), burnRoot: () => burns.root(), liveRoot: () => live.root(),
      counts: () => ({ note: noteCount(), spent: spentCount(), live: live.len(), burn: burnCount(), height }),
      live, _acc: { notes, spent, live, burns },
    };
  }

  // ── CXFER value-conservation gate (worker liveness mirror of the guest) ──
  // Bitcoin does NOT check the Tacit kernel, so a confirmed tx can carry a CXFER envelope whose
  // outputs don't conserve value (Σ C_in ≠ Σ C_out) or fall out of range. The reflection guest
  // re-verifies conservation (cxfer-core verify_cxfer_conservation) before folding any output and
  // SKIPS a non-conserving cxfer's outputs. The worker mirrors that here so its canonical pool root
  // stays byte-identical to what the guest proves — otherwise the next batch's prior digest diverges
  // and every later proof fails. Faithful port: same kernel message, same verify key
  // P = Σ C_in − Σ C_out (x-only, burned = 0), same BP+ range over the output commitments.
  const CXFER_KERNEL_DOMAIN = new TextEncoder().encode('tacit-kernel-v1');
  const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  const u64leBytes = (n) => { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, Number(BigInt(n) & 0xffffffffn), true); v.setUint32(4, Number((BigInt(n) >> 32n) & 0xffffffffn), true); return b; };
  // kernel_msg = sha256("tacit-kernel-v1" ‖ asset ‖ in_count ‖ (txid ‖ vout_LE)×in ‖ out_count ‖
  //                     commitment(33)×out ‖ burned_LE8) — byte-identical to cxfer_kernel_verify.
  function cxferKernelMsg(asset, inputOutpoints, outsCompressed, burned = 0) {
    const parts = [CXFER_KERNEL_DOMAIN, b32(asset), Uint8Array.of(inputOutpoints.length & 0xff)];
    for (const [txid, vout] of inputOutpoints) { parts.push(b32(txid)); parts.push(u32le(vout)); }
    parts.push(Uint8Array.of(outsCompressed.length & 0xff));
    for (const c of outsCompressed) parts.push(hexToBytes(c));
    parts.push(u64leBytes(burned));
    return sha256(concat(parts));
  }
  const cxferOutPoints = (outsCompressed) => outsCompressed.map((c) => secp.ProjectivePoint.fromHex(c.replace(/^0x/, '')));
  // Kernel-only: Σ C_in = Σ C_out, proven by a BIP-340 sig over the kernel message (burned = 0),
  // with verify key P = Σ C_in − Σ C_out (x-only). A cxfer env MUST carry asset/kernelSig/
  // commitments — a missing field is a wiring bug (throws), NOT a silent drop of a legitimate note.
  // `burned` (default 0) is the public supply a CBURN step destroys: the verify key becomes
  // P = Σ C_in − Σ C_out − burned·H, matching cxfer_kernel_verify, so the burn-deposit provenance walk can
  // verify a CBURN step (a note descending from its change outputs). A pure transfer is burned = 0.
  function cxferKernelVerify({ asset, inputOutpoints, inputPoints, outsCompressed, kernelSig, burned = 0 }) {
    if (asset == null || kernelSig == null || !Array.isArray(outsCompressed) || outsCompressed.some((c) => c == null)) {
      throw new Error('cxfer kernel: missing asset/kernelSig/commitments');
    }
    if (inputOutpoints.length !== inputPoints.length) return false;
    if (inputOutpoints.length > 255 || outsCompressed.length < 1 || outsCompressed.length > 255) return false;
    let outPoints; try { outPoints = cxferOutPoints(outsCompressed); } catch { return false; }
    const Z = secp.ProjectivePoint.ZERO;
    let P = inputPoints.reduce((a, p) => a.add(p), Z).add(outPoints.reduce((a, p) => a.add(p), Z).negate());
    if (BigInt(burned) !== 0n) P = P.add(prover.H.multiply(BigInt(burned)).negate()); // − burned·H
    if (P.equals(Z)) return false;                    // identity verify key → reject (matches Rust)
    const px = P.toRawBytes(true).slice(1);           // x-only verify key
    let sig; try { sig = hexToBytes(kernelSig); } catch { return false; }
    if (sig.length !== 64) return false;
    return verifySchnorr(sig, cxferKernelMsg(asset, inputOutpoints, outsCompressed, burned), px);
  }
  // Full conservation: kernel (no inflation) AND every output in BP+ range (no wraparound). The
  // exact predicate the reflection guest re-runs before folding a cxfer's outputs (REFLECT-1).
  function verifyCxferConservation({ asset, inputOutpoints, inputPoints, outsCompressed, rangeProof, kernelSig, burned = 0 }) {
    if (rangeProof == null) throw new Error('cxfer conservation: missing rangeProof');
    if (!cxferKernelVerify({ asset, inputOutpoints, inputPoints, outsCompressed, kernelSig, burned })) return false;
    let rp; try { rp = hexToBytes(rangeProof); } catch { return false; }
    // bppRangeVerify uses bulletproofs-plus.js's own secp instance — build its commitment points
    // with that module's bytesToPoint so the range check is independent of the injected `secp`.
    let rangePts; try { rangePts = outsCompressed.map((c) => bppPoint(hexToBytes(c))); } catch { return false; }
    return bppRangeVerify(rangePts, rp);
  }

  // ── Assemble the FULL-SCAN reflection input (the new guest's io::read order) ──
  // batch = { anchorHeight, headers (80-byte hex), blocks: [{ txs: [{ txData, txid, vins:
  // [{prevTxid,vout}], env: null | {type:'burn', dest} | {type:'cxfer', assetId, kernelSig,
  // rangeProof, outputs:[{cx,cy, compressed, commitmentHash, noteLeaf, vout}]} }] }] }. A cxfer
  // env's outputs are folded ONLY if it conserves value (REFLECT-1); a non-conserving cxfer's
  // detected spends are still nullified but it injects no notes (the guest skips it identically).
  // `coords` is a Map(outpointKey → {cx,cy}) of every
  // live pool note (so a detected spend's opening is known); it is advanced as outputs land/spends
  // clear. The guest re-derives txids + the block merkle root, so completeness is enforced there;
  // here we SIMULATE the scan to emit the matching witnesses in stream order: per tx, the spend
  // openings (vin order), the spent-set inserts, a burn insert, then the outputs.
  // Zero-shaped witnesses for a burn-deposit the guest reads but folds nothing (invalid provenance / a
  // re-presented ν). The guest reads these fields UNCONDITIONALLY for stream sync, then discards them.
  const BD_ZERO_HEX = '0x' + '00'.repeat(32);
  const BD_ZERO_PATH = Array(TREE_DEPTH).fill(BD_ZERO_HEX);
  const BD_ZERO_SPENT = { sLowValue: BD_ZERO_HEX, sLowNext: BD_ZERO_HEX, sLowIndex: 0, sLowPath: BD_ZERO_PATH, sNewPath: BD_ZERO_PATH };
  const BD_ZERO_BURN = { bLowKey: BD_ZERO_HEX, bLowNext: BD_ZERO_HEX, bLowValue: BD_ZERO_HEX, bLowIndex: 0, bLowPath: BD_ZERO_PATH, bNewPath: BD_ZERO_PATH };
  // A burn-deposit context with EMPTY provenance, for a 0x2B burn of a non-live note that carries no
  // holder bundle. The guest reads a full burn-deposit witness stream for every such burn and its
  // verified() returns None at the first check (prov_headers empty) → folds nothing. Emitting this skip
  // witness (vs throwing) keeps the stream in sync AND means a bundle-less burn can't wedge the cycle.
  // The box harness write_burn_deposit loops over each array length, so empty arrays serialize as n=0.
  const BD_ZERO_WITNESS = { etchTx: '0x', etchIndex: 0, etchSiblings: [], provHeaders: [], cxfers: [], cmints: [] };
  const BD_SKIP_CTX = { valid: false, nu: BD_ZERO_HEX, dest: BD_ZERO_HEX, burnedCx: BD_ZERO_HEX, burnedCy: BD_ZERO_HEX, burnedNoteLeaf: BD_ZERO_HEX, witness: BD_ZERO_WITNESS };

  // Fold (or, on invalid provenance, no-op) a burn-deposit, mirroring the reflect.rs dispatch EXACTLY.
  // ctx = { valid, nu, dest, burnedCx, burnedCy, burnedNoteLeaf, witness:{ etchTx, etchIndex, etchSiblings,
  // provHeaders, cxfers, cmints } } — the scan indexer assembles `witness` (merkle paths) + computes `valid`
  // from the JS mirror (verifyProvenanceLeaves over C_0 ∪ authorized cmints). A valid, fresh ν folds
  // fold_spent → fold_note_append → fold_burn (onboarding the proven-real note as a pool member so the
  // Ethereum OP_BRIDGE_MINT binds v_mint == v_burn); otherwise nothing folds but the witness is still emitted.
  function foldBurnDepositTx(state, ctx) {
    const base = { ...ctx.witness, burnedCx: ctx.burnedCx, burnedCy: ctx.burnedCy };
    if (ctx.valid && !state.spentContains(ctx.nu)) {
      return {
        ...base,
        spentInsert: state.foldSpent(ctx.nu),
        notePath: state.foldNoteAppend(ctx.burnedNoteLeaf).notePath,
        burnInsert: state.foldBurn(ctx.nu, ctx.dest),
      };
    }
    return { ...base, spentInsert: BD_ZERO_SPENT, notePath: BD_ZERO_PATH, burnInsert: BD_ZERO_BURN };
  }

  function assembleReflectionScanInput(state, batch, coords) {
    const norm = (x) => hx(b32(x));
    const c = state.counts();
    const prior = {
      poolRoot: state.poolRoot(), noteCount: c.note,
      spentRoot: state.spentRoot(), spentCount: c.spent,
      live: state.live.triples(), liveCount: c.live,
      burnRoot: state.burnRoot(), burnCount: c.burn,
      height: c.height,
    };
    const blocksOut = [];
    const nonConserving = [];
    // Value-entry envelopes (T_MINT/cmint) the full-scan model does NOT yet reflect: the model is
    // conservation-CLOSED (no free-output deposit path — that was the REFLECT-1 risk), so a mint's
    // output does not enter bitcoinPoolRoot and is not bridge-mintable until the cmint-deposit effect
    // ships (SPEC-BITCOIN-REFLECTION-AMENDMENT §6.1). Surface them LOUD so a value-entering envelope is
    // never silently dropped (the guest skips it identically — an unrecognized envelope folds nothing).
    const unreflectedValueEntry = [];
    let blockIndex = 0;
    for (const block of (batch.blocks || [])) {
      state.setHeight((batch.anchorHeight | 0) + blockIndex);
      const txsOut = [];
      for (const tx of block.txs) {
        const openings = [];
        const inOutpoints = [];
        const inAssets = []; // each detected spend's asset (from the live set) — for the cxfer gate
        const spentInserts = [];
        for (const { prevTxid, vout } of (tx.vins || [])) {
          const key = outpointKey(prevTxid, vout);
          const hit = state.live.get(key);
          if (hit == null) continue;
          const co = coords.get(norm(key));
          if (!co) throw new Error('live spend has no known coords: ' + norm(key));
          openings.push({ cx: norm(co.cx), cy: norm(co.cy) });
          inOutpoints.push([prevTxid, vout]);
          inAssets.push(norm(hit[1])); // the spent note's asset, carried by the live set
          spentInserts.push(state.foldSpent(nullifier(co.cx, co.cy)));
          state.live.remove(key);
          coords.delete(norm(key));
        }
        let burnInsert = null;
        let burnDeposit = null;
        if (tx.env && tx.env.type === 'burn') {
          if (openings.length === 1) {
            // Reflected-note bridge-out: the burned note is a live pool note (already nullified above by the
            // spend scan). Record ν → dest.
            burnInsert = state.foldBurn(nullifier(openings[0].cx, openings[0].cy), tx.env.dest);
          } else if (openings.length === 0 && tx.env.burnDeposit) {
            // BURN-DEPOSIT: a pre-existing, never-reflected note (no live-set spend). The worker assembled the
            // provenance witness + ran the JS mirror (ctx.valid). The guest reads the witness UNCONDITIONALLY
            // (stream sync) and folds ONLY if the provenance verifies — mirror that exactly here.
            burnDeposit = foldBurnDepositTx(state, tx.env.burnDeposit);
          } else if (openings.length === 0) {
            // BURN-DEPOSIT with NO holder bundle: the guest still reads a burn-deposit witness stream for
            // every 0x2B burn of a non-live note and SKIPS if the provenance doesn't verify (skip-not-panic).
            // Emit the empty-provenance skip witness so the stream stays in sync and a bundle-less burn can't
            // wedge the attestation cycle (a griefer could otherwise broadcast one to halt reflection).
            burnDeposit = foldBurnDepositTx(state, BD_SKIP_CTX);
          } else {
            // openings.length >= 2 under a burn envelope: the guest's `assert!(spends.is_empty())` fails (it
            // panics), so this IS a genuine desync. (Making the guest skip-not-panic for a multi-spend burn
            // is a separate hardening that needs a re-prove.)
            throw new Error('burn tx: multiple live-note spends under a burn envelope (guest asserts spends.is_empty())');
          }
        }
        const outputs = [];
        if (tx.env && tx.env.type === 'cxfer') {
          // REFLECT-1 + asset preservation: fold the output notes ONLY if the cxfer conserves value
          // AND every spent note is of the envelope's declared asset, mirroring the guest (which
          // gates on the SAME predicate before it reads output witnesses, then skips). A
          // non-conserving OR asset-relabeling cxfer injects nothing and carries no output witnesses
          // in the stream; its detected spends are still nullified above (the relabel burns the
          // attacker's input for nothing).
          const envAsset = norm(tx.env.assetId);
          const assetPreserving = inAssets.every((a) => a === envAsset);
          const conserves = assetPreserving && verifyCxferConservation({
            asset: tx.env.assetId,
            inputOutpoints: inOutpoints,
            inputPoints: openings.map((o) => secp.ProjectivePoint.fromAffine({ x: BigInt(o.cx), y: BigInt(o.cy) })),
            outsCompressed: tx.env.outputs.map((o) => o.compressed),
            rangeProof: tx.env.rangeProof,
            kernelSig: tx.env.kernelSig,
          });
          if (conserves) {
            for (const o of tx.env.outputs) {
              const outpoint = outpointKey(tx.txid, o.vout);
              const w = state.foldOutput(o.noteLeaf, outpoint, o.commitmentHash, envAsset);
              outputs.push({ noteLeaf: w.noteLeaf, notePath: w.notePath, vout: o.vout });
              coords.set(norm(outpoint), { cx: o.cx, cy: o.cy });
            }
          } else {
            nonConserving.push({ txid: tx.txid, outputs: tx.env.outputs.length, reason: assetPreserving ? 'non-conserving' : 'non-asset-preserving' });
          }
        } else if (tx.env && tx.env.type === 'mint') {
          // A confidential-mint (T_MINT/cmint) value-entry: NOT reflected by the conservation-closed
          // full-scan model — surfaced, not folded, so callers see un-onboarded Bitcoin value.
          unreflectedValueEntry.push({ txid: tx.txid, assetId: tx.env.assetId || null });
        }
        txsOut.push({ txData: tx.txData, openings, spentInserts, burnInsert, outputs, burnDeposit });
      }
      blocksOut.push({ txs: txsOut });
      blockIndex++;
    }
    return { prior, anchorHeight: batch.anchorHeight | 0, headers: batch.headers || [], blocks: blocksOut, newDigest: state.digest(), nonConserving, unreflectedValueEntry };
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

  // The depth-32 Merkle path for `index` over `leaves` (zero-filling empty subtrees), via a
  // fresh tree — the witness builder the reflection indexer runs (mirrors the Rust test helper
  // merkle_path). Positions ≥ leaves.length resolve to the zero leaf.
  function merklePath(leaves, index) {
    const t = new Tree();
    for (const l of leaves) t.insert(l);
    return t.rootAndPath(index).path;
  }

  // Fold a leaf up its path to the root it implies — the compute-side of verifyPath (mirrors
  // cxfer-core::merkle_root_from). The witnessed transitions derive the post-update root with it.
  function merkleRootFrom(leafHex, index, path) {
    let h = b32(leafHex);
    for (let i = 0; i < TREE_DEPTH; i++) {
      const sib = b32(path[i]);
      h = ((index >>> i) & 1) ? keccak256(concat([sib, h])) : keccak256(concat([h, sib]));
    }
    return hx(h);
  }

  // ── opening proof-of-knowledge (swap / LP), mirror of cxfer_core::verify_opening_sigma ──
  // Prove knowledge of the blinding `r` for a commitment of a PUBLIC `amount`, bound to a 32-byte
  // `context` (the trade terms), WITHOUT revealing `r`. The settle box verifies this instead of
  // taking raw `r`, so it never learns the blinding → cannot spend the input or redirect the
  // output. `nonce` is a fresh random scalar (a reused nonce leaks `r`). e = keccak(DOMAIN ‖
  // amount_be8 ‖ context ‖ compress(C) ‖ compress(R)) mod n; proof = (R, z=k+e·r).
  const OPENING_DOMAIN = new TextEncoder().encode('tacit-open-sigma-v1');
  const be8 = (n) => { const o = new Uint8Array(8); let v = BigInt(n); for (let i = 7; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
  const compressPt = (P) => P.toRawBytes(true);
  const ptFromXY = (cx, cy) => secp.ProjectivePoint.fromAffine({ x: BigInt(cx), y: BigInt(cy) });
  const openChallenge = (amount, contextHex, C, R) =>
    mod(bToBig(keccak256(concat([OPENING_DOMAIN, be8(amount), b32(contextHex), compressPt(C), compressPt(R)]))), N);

  // Mirror of cxfer_core::intent_context — the 32-byte context the opening sigmas bind. `tag` is a
  // string/bytes domain; `notes` = [[cx,cy,owner], …] (spent + minted, fixed order); `amounts` = the
  // public u64 quantities. MUST match the guest's field order byte-for-byte.
  function intentContext(tag, chainBinding, assetA, assetB, notes, amounts) {
    const parts = [tag instanceof Uint8Array ? tag : new TextEncoder().encode(tag), b32(chainBinding), b32(assetA), b32(assetB)];
    for (const [cx, cy, owner] of notes) { parts.push(b32(cx), b32(cy), b32(owner)); }
    for (const a of amounts) { parts.push(be8(a)); }
    return hx(keccak256(concat(parts)));
  }

  function openingSigma(amount, r, contextHex, nonce) {
    const rS = mod(BigInt(r), N), kS = mod(BigInt(nonce), N);
    // A zero nonce makes R = identity and z = e·r, exposing r = z·e⁻¹ from ONE published intent — and
    // under the bearer model recovering r is recovering spend authority. Fail closed.
    if (kS === 0n) throw new Error('openingSigma: zero nonce would expose the blinding r');
    const C = prover.commit(BigInt(amount), rS);
    const R = secp.ProjectivePoint.BASE.multiply(kS);
    const e = openChallenge(amount, contextHex, C, R);
    return { R: hx(compressPt(R)), z: hx(beBytes(mod(kS + e * rS, N), 32)) };
  }

  // Derive an opening-sigma nonce deterministically + uniquely per (note blinding r, intent context,
  // role). Binding the nonce to the CONTEXT means re-signing the SAME note under a DIFFERENT intent (a
  // re-quote, LP re-add, OTC renegotiation, or a relay rebuild) automatically yields a NEW nonce — which
  // eliminates the cross-op nonce-reuse class that otherwise leaks r = (z1−z2)/(e1−e2) (a bearer spend).
  // RFC6979-style: deterministic in (r, context, role), never zero. swap/LP/OTC derive every sigma nonce
  // through this rather than trusting a caller-supplied value.
  function deriveOpeningNonce(r, contextHex, role) {
    const roleB = role instanceof Uint8Array ? role : new TextEncoder().encode(role);
    const k = mod(bToBig(keccak256(concat([new TextEncoder().encode('tacit-open-nonce-v1'), beBytes(mod(BigInt(r), N), 32), b32(contextHex), roleB]))), N);
    return k === 0n ? 1n : k;
  }

  function verifyOpeningSigma(cx, cy, amount, Rhex, zHex, contextHex) {
    const C = ptFromXY(cx, cy);
    const R = secp.ProjectivePoint.fromHex(Rhex.replace(/^0x/, ''));
    const e = openChallenge(amount, contextHex, C, R);
    const amtH = BigInt(amount) === 0n ? secp.ProjectivePoint.ZERO : prover.H.multiply(BigInt(amount));
    const X = C.add(amtH.negate()); // C − amount·H = r·G
    const lhs = secp.ProjectivePoint.BASE.multiply(mod(BigInt(zHex), N));
    const rhs = R.add(X.multiply(e));
    return hx(compressPt(lhs)) === hx(compressPt(rhs));
  }

  return {
    prover, TREE_DEPTH, zeros: zeros.map(hx),
    commitXY, deriveNote, deriveBidSecret, leaf, nullifier, depositId, Tree, verifyPath, merklePath, merkleRootFrom,
    imtLeaf, imtRoot, imtEmptyRoot, makeImtAccumulator,
    utxoLeaf, makeUtxoAccumulator, commitmentHash, decompressCommitment, compressXY, outpointKey,
    makeReflectionState, assembleReflectionInput, openingSigma, verifyOpeningSigma, deriveOpeningNonce, intentContext,
    liveLeaf, makeLiveUtxoSet, makeScanReflectionState, assembleReflectionScanInput,
    cxferKernelVerify, verifyCxferConservation,
    _internal: { keccak, concat, b32, beBytes, hx },
  };
}
