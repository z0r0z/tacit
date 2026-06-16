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

  // The Track-B pool-registry leaf — byte-identical to cxfer-core PoolReserveSet::root's leaf:
  // keccak(poolId ‖ assetA ‖ assetB ‖ u64be(reserveA) ‖ u64be(reserveB) ‖ u64be(totalShares) ‖
  // backed ‖ u64be(protocolFeeBps) ‖ u128be(kLast) ‖ u64be(protocolFeeAccrued)). `backed` is u64be(1|0)
  // (byte 31 set, matching the Rust `backed[31]=1`); `kLast` is a u128 right-aligned in a 32-byte word
  // (beBytes is BigInt-exact, so the low 16 bytes carry it — identical to the Rust u128b encoding).
  const poolLeaf = (poolId, s) => hx(keccak(
    poolId, s.assetA, s.assetB,
    u64be(s.reserveA), u64be(s.reserveB), u64be(s.totalShares), u64be(s.c0Backed ? 1 : 0),
    u64be(s.protocolFeeBps || 0), beBytes(BigInt(s.kLast || 0), 32), u64be(s.protocolFeeAccrued || 0),
  ));
  // The Track-B per-pool reserve registry mirror (cxfer-core PoolReserveSet). Sorted by pool_id; the
  // root rides ScanReflection.digest() so a resumed cycle can't forge a pool's reserves, its c0_backed
  // flag, or its accrued protocol fee. The worker does not yet FOLD Bitcoin AMM envelopes into it (the
  // same deferred step as the cBTC-lock fold), so it is empty today — but the resume handoff serializes
  // whatever it holds, and digest() commits it, so JS == Rust == the contract's REFLECTION_GENESIS_DIGEST.
  function makePoolReserveSet() {
    const norm = (x) => hx(b32(x));
    let map = new Map(); // pool_id(hex) -> { assetA, assetB, reserveA, reserveB, totalShares, c0Backed, protocolFeeBps, kLast, protocolFeeAccrued }
    const keys = () => [...map.keys()].sort(); // hex sort == byte order (fixed-length keys), matching from_sorted
    function set(poolId, s) { map.set(norm(poolId), s); }
    function get(poolId) { const s = map.get(norm(poolId)); return s ? { ...s } : null; }
    // The pool_ids whose (asset_a, asset_b) match (mirror pool_ids_for_assets) — for variant-0 LP-remove,
    // which carries no fee_bps, so the pool is found by canonical-pair enumeration then kernel disambiguation.
    function poolIdsForAssets(assetA, assetB) {
      const a = norm(assetA), b = norm(assetB);
      return keys().filter((k) => { const s = map.get(k); return norm(s.assetA) === a && norm(s.assetB) === b; });
    }
    function root() { const t = new Tree(); for (const k of keys()) t.insert(poolLeaf(k, map.get(k))); return t.root(); }
    // The sorted entries handed to the prover (its from_sorted re-checks the order). reserve/share/k_last
    // are strings — u64/u128 exceed JS Number — so the harness parses them losslessly.
    function list() {
      return keys().map((k) => { const s = map.get(k); return {
        poolId: k, assetA: norm(s.assetA), assetB: norm(s.assetB),
        reserveA: String(s.reserveA), reserveB: String(s.reserveB), totalShares: String(s.totalShares),
        c0Backed: !!s.c0Backed, protocolFeeBps: Number(s.protocolFeeBps || 0),
        kLast: String(s.kLast || 0), protocolFeeAccrued: String(s.protocolFeeAccrued || 0),
      }; });
    }
    function load(arr) {
      map = new Map();
      for (const e of (arr || [])) set(e.poolId, {
        assetA: e.assetA, assetB: e.assetB, reserveA: BigInt(e.reserveA), reserveB: BigInt(e.reserveB),
        totalShares: BigInt(e.totalShares), c0Backed: !!e.c0Backed, protocolFeeBps: Number(e.protocolFeeBps || 0),
        kLast: BigInt(e.kLast || 0), protocolFeeAccrued: BigInt(e.protocolFeeAccrued || 0),
      });
    }
    return { set, get, poolIdsForAssets, root, list, load, len: () => map.size };
  }

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
  // ── cBTC.zk sats-lock constants (mirror cxfer-core CBTC_ZK_ASSET_ID / CBTC_LOCK_DOMAIN) ──
  const CBTC_ZK_ASSET_ID = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
  const CBTC_LOCK_DOMAIN = new TextEncoder().encode('tacit-cbtc-lock-v1');
  const CBTC_NOTE_OWNER = '0x' + '0'.repeat(64); // the cBTC note is owner-free (leaf owner = 0)
  // The opening-sigma context for a cBTC sats-lock: keccak(domain ‖ asset ‖ lock_txid ‖ lock_vout_LE),
  // RAW concatenation (NOT 32-padded) — mirrors cxfer-core kn(&[CBTC_LOCK_DOMAIN, asset, txid, vout_le]).
  // Uses the raw keccak256 dep, not the b32-padding `keccak` helper.
  const cbtcLockContext = (asset, lockTxid, lockVout) =>
    hx(keccak256(concat([CBTC_LOCK_DOMAIN, b32(asset), b32(lockTxid), u32le(lockVout)])));

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
    // Track B: the per-pool reserve registry (cxfer-core ScanReflection.pools). Empty until the worker
    // folds Bitcoin AMM envelopes; rides digest() so a resumed cycle can't forge a pool's reserves/skim.
    const pools = makePoolReserveSet();
    // FAST-LANE resume count (cxfer-core ScanReflection.consumed_count): how many eth-consumed ν have been
    // folded into the spent set via Mode-B reverse reflection. The JS scan is forward-only (no Mode-B fold), so
    // it stays 0 — but it MUST ride digest() (the guest pins it) or the guest↔JS digest diverges.
    let consumedCount = 0n;

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
        // Track B: per-pool reserve registry — pinned so a resumed cycle can't forge a pool's reserves
        // or its c0_backed flag (which would let an onboarding fold mint unbacked value).
        pools.root(), u64be(pools.len()),
        // FAST LANE: eth-consumed ν fold count (cxfer-core pins it last; 0 for the forward-only JS scan).
        u64be(consumedCount),
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

    // ── cBTC.zk sats-lock fold (mirror cxfer-core fold_cbtc_lock / fold_cbtc_lock_spends) ──
    // The lock value `vBtc` (parsed from the lock output) + the opening sigma (rx,ry,z, locker-supplied)
    // come from the caller. Gates: asset == the one cBTC.zk id, lock vout != 0 (the note is vout 0), and
    // the note opens to EXACTLY vBtc under the lock-bound context. Effect: track the lock outpoint + add
    // backing + append the owner-free note (tree + live). Returns the note-path witness, or null if a gate
    // fails (skip-not-panic, like the guest). Built on parity-validated primitives (leaf / foldOutput /
    // outpointKey / commitmentHash / u64be / verifyOpeningSigma); the guest-digest parity for the lock
    // CONTEXT encoding is confirmed end-to-end by the reflect-exec fixture (the live wiring step).
    function foldCbtcLock({ asset, cx, cy, vBtc, lockVout, lockTxid, sigRx, sigRy, sigZ }) {
      if (hx(b32(asset)) !== CBTC_ZK_ASSET_ID) return null;          // not the cBTC.zk asset
      if ((lockVout >>> 0) === 0) return null;                        // lock vout must differ from the note (vout 0)
      let R;
      try { ptFromXY(cx, cy); R = secp.ProjectivePoint.fromAffine({ x: BigInt(sigRx), y: BigInt(sigRy) }); } catch { return null; }
      const ctx = cbtcLockContext(asset, lockTxid, lockVout);
      if (!verifyOpeningSigma(cx, cy, BigInt(vBtc), hx(R.toRawBytes(true)), hx(b32(sigZ)), ctx)) return null;
      cbtcLocks.insert(outpointKey(lockTxid, lockVout), u64be(BigInt(vBtc)), asset);
      cbtcBackingSats += BigInt(vBtc);
      const w = foldOutput(leaf(asset, cx, cy, CBTC_NOTE_OWNER), outpointKey(lockTxid, 0), commitmentHash(cx, cy), asset);
      return { notePath: w.notePath };
    }
    // Self-custody rug: drop the backing of any tracked lock outpoint this tx's inputs spend. `vins` =
    // [{prevTxid, vout}]. Returns the sats removed (saturating, like the guest's saturating_sub).
    function foldCbtcLockSpends(vins) {
      let removed = 0n;
      for (const { prevTxid, vout } of (vins || [])) {
        const key = outpointKey(prevTxid, vout);
        const hit = cbtcLocks.get(key);
        if (hit) { const v = BigInt(hit[0]); cbtcBackingSats = cbtcBackingSats > v ? cbtcBackingSats - v : 0n; cbtcLocks.remove(key); removed += v; }
      }
      return removed;
    }

    // ── Track-B swap_var fold (mirror cxfer-core fold_swap_var) ──
    // The pool must be C0-backed + its tracked reserves match the envelope; the taker's spent input (c_in,
    // a detected live note of the in-side asset) is kernel-bound to delta_in_total; the receipt opens to the
    // PUBLIC delta_out; delta_out ≤ the out-side reserve. Effect: onboard the receipt + advance reserves
    // (in += delta_in, out −= delta_out). Returns the receipt note-path witness, or null (skip) on any gate.
    function foldSwapVar(sv, inputOutpoint, inputAsset, receiptOutpoint) {
      const pool = pools.get(sv.poolId);
      if (!pool || !pool.c0Backed) return null;
      if (BigInt(pool.reserveA) !== BigInt(sv.rAPre) || BigInt(pool.reserveB) !== BigInt(sv.rBPre)) return null;
      const dir = sv.direction;
      const [assetIn, assetOut, rInPre, rOutPre] = dir === 0
        ? [pool.assetA, pool.assetB, BigInt(pool.reserveA), BigInt(pool.reserveB)]
        : [pool.assetB, pool.assetA, BigInt(pool.reserveB), BigInt(pool.reserveA)];
      if (hx(b32(inputAsset)) !== hx(b32(assetIn))) return null;
      const deltaInTotal = BigInt(sv.deltaIn) + BigInt(sv.tipAmount);
      if (deltaInTotal >= (1n << 64n)) return null;
      if (!swapVarKernelVerify(assetIn, inputOutpoint, sv.cIn, sv.cChangeOrSentinel, deltaInTotal, sv.kernelSig)) return null;
      if (BigInt(sv.deltaOut) === 0n) return null;
      if (!verifyPedersenOpening(sv.cReceipt, BigInt(sv.deltaOut), sv.rReceipt)) return null;
      if (BigInt(sv.deltaOut) > rOutPre) return null;
      const { cx, cy } = decompressCommitment(sv.cReceipt);
      const w = foldOutput(leaf(assetOut, cx, cy, CBTC_NOTE_OWNER), receiptOutpoint, commitmentHash(cx, cy), assetOut);
      const upd = { ...pool };
      if (dir === 0) { upd.reserveA = rInPre + BigInt(sv.deltaIn); upd.reserveB = rOutPre - BigInt(sv.deltaOut); }
      else { upd.reserveB = rInPre + BigInt(sv.deltaIn); upd.reserveA = rOutPre - BigInt(sv.deltaOut); }
      pools.set(sv.poolId, upd);
      return { notePath: w.notePath };
    }

    // ── Track-B swap_route fold (mirror cxfer-core fold_swap_route) ──
    // The multi-hop sibling of swap_var: the trader's single real input note flows through 2–4 pools and lands
    // as ONE receipt note. Validate + STAGE every hop before mutating (all-or-nothing): each pool c0-backed +
    // its tracked reserves match the hop's declared R_pre; the chain links (hop_i input asset/amount == hop_{i-1}
    // output); hop 0's input is kernel-bound to its magnitude; no hop drains its out-reserve; the final output
    // asset == the route's output asset and the receipt opens to the final amount. null (skip) on any gate.
    function foldSwapRoute(env, inputOutpoint, inputAsset, receiptOutpoint) {
      if (hx(b32(inputAsset)) !== hx(b32(env.traderInputAsset))) return null;
      const SENTINEL_HEX = '0x' + '00'.repeat(33);
      const staged = [];
      let curAsset = env.traderInputAsset, curAmount = 0n;
      for (let i = 0; i < env.hops.length; i++) {
        const hop = env.hops[i];
        if (staged.some(([pid]) => hx(b32(pid)) === hx(b32(hop.poolId)))) return null; // pool repeated
        const pool = pools.get(hop.poolId);
        if (!pool || !pool.c0Backed) return null;
        if (BigInt(pool.reserveA) !== BigInt(hop.rAPre) || BigInt(pool.reserveB) !== BigInt(hop.rBPre)) return null;
        const dir = hop.direction;
        const [inAsset, outAsset, rIn, rOut, inMag, outMag] = dir === 0
          ? [pool.assetA, pool.assetB, BigInt(pool.reserveA), BigInt(pool.reserveB), BigInt(hop.deltaANetMag), BigInt(hop.deltaBNetMag)]
          : [pool.assetB, pool.assetA, BigInt(pool.reserveB), BigInt(pool.reserveA), BigInt(hop.deltaBNetMag), BigInt(hop.deltaANetMag)];
        if (hx(b32(inAsset)) !== hx(b32(curAsset))) return null;
        if (i === 0) {
          if (inMag === 0n) return null;
          if (!swapVarKernelVerify(curAsset, inputOutpoint, env.cIn, SENTINEL_HEX, inMag, env.kernelSig)) return null;
        } else if (inMag !== curAmount) return null;
        if (outMag === 0n || outMag > rOut) return null;
        const upd = { ...pool };
        if (dir === 0) { upd.reserveA = rIn + inMag; upd.reserveB = rOut - outMag; }
        else { upd.reserveB = rIn + inMag; upd.reserveA = rOut - outMag; }
        staged.push([hop.poolId, upd]);
        curAsset = outAsset; curAmount = outMag;
      }
      if (hx(b32(curAsset)) !== hx(b32(env.traderOutputAsset))) return null;
      if (!verifyPedersenOpening(env.cReceipt, curAmount, env.rReceipt)) return null;
      const { cx, cy } = decompressCommitment(env.cReceipt);
      const w = foldOutput(leaf(env.traderOutputAsset, cx, cy, CBTC_NOTE_OWNER), receiptOutpoint, commitmentHash(cx, cy), env.traderOutputAsset);
      for (const [pid, pool] of staged) pools.set(pid, pool);
      return { receiptPath: w.notePath };
    }

    // ── Track-B harvest / farm-refund fold (mirror cxfer-core fold_harvest) ──
    // A reward/refund note minted by DECREE at vout[1], drawn from a C0-backed farm treasury. The note is
    // DERIVED from the public (amount, r): C = amount·H + r·G — so its value is exactly the treasury draw,
    // and the treasury (reserve_a) is debited amount (≤ remaining ⇒ no inflation). Onboards the note + debits.
    // Covers T_LP_HARVEST (0x3B) and T_FARM_REFUND (0x3E) — same shape, same fold. null (skip) on any gate.
    function foldHarvest(farmId, amount, rHex, outpoint) {
      const farm = pools.get(farmId);
      if (!farm || !farm.c0Backed) return null;
      const amt = BigInt(amount);
      if (amt === 0n || amt > BigInt(farm.reserveA)) return null;
      const { cx, cy } = commitXY(amt, mod(BigInt(rHex), N)); // amount·H + r·G
      const w = foldOutput(leaf(farm.assetA, cx, cy, CBTC_NOTE_OWNER), outpoint, commitmentHash(cx, cy), farm.assetA);
      const upd = { ...farm }; upd.reserveA = BigInt(farm.reserveA) - amt;
      pools.set(farmId, upd);
      return { notePath: w.notePath };
    }

    // ── Track-B protocol-fee claim fold (mirror cxfer-core fold_protocol_fee_claim) ──
    // The pool's fee recipient claims the creator-earned protocol-fee LP-share skim as a real bridgeable note.
    // Crystallize the swap-driven accrual, require claim == accrued (exact, no over-mint), verify the claim note
    // opens to claim_amount under its PUBLIC blinding, onboard it as an LP-share note, reset accrued. The skim
    // was already counted into total_shares by crystallize, so bridging it is backed. null (skip) on any gate.
    function foldProtocolFeeClaim(poolId, claimAmount, claimCSecp, claimBlinding, outpoint) {
      const pool = pools.get(poolId);
      if (!pool || !pool.c0Backed) return null;
      if (Number(pool.protocolFeeBps || 0) === 0) return null;
      crystallizeProtocolFee(pool); // mutates the copy: accrued / total_shares / k_last
      const amt = BigInt(claimAmount);
      if (amt === 0n || amt !== BigInt(pool.protocolFeeAccrued)) return null;
      if (!verifyPedersenOpening(claimCSecp, amt, claimBlinding)) return null;
      const lpAsset = ammDeriveLpAssetId(poolId);
      const { cx, cy } = decompressCommitment(claimCSecp);
      const w = foldOutput(leaf(lpAsset, cx, cy, CBTC_NOTE_OWNER), outpoint, commitmentHash(cx, cy), lpAsset);
      pools.set(poolId, { ...pool, protocolFeeAccrued: 0n });
      return { notePath: w.notePath };
    }

    // ── Track-B farm-init fold (mirror cxfer-core fold_farm_init) ──
    // A T_FARM_INIT (0x34) establishes a farm treasury as a C0-backed reserve: the launcher's single detected
    // reward-asset spend funds reward_total under the SAME swap-shape kernel (C_in − C_change = reward_total·H),
    // and the treasury is registered as a degenerate pool keyed by farm_id (asset_a = reward asset, the rest 0).
    // No note onboarded (the treasury is virtual) → no note-path witness. Returns true / null (skip) on any gate.
    function foldFarmInit(farmId, rewardAsset, rewardTotal, inputOutpoint, cIn, cChangeOrSentinel, kernelSig) {
      const total = BigInt(rewardTotal);
      if (total === 0n) return null;
      if (pools.get(farmId)) return null; // already registered
      if (!swapVarKernelVerify(rewardAsset, inputOutpoint, cIn, cChangeOrSentinel, total, kernelSig)) return null;
      pools.set(farmId, { assetA: rewardAsset, assetB: '0x' + '00'.repeat(32), reserveA: total, reserveB: 0n, totalShares: 0n, c0Backed: true, protocolFeeBps: 0, kLast: 0n, protocolFeeAccrued: 0n });
      return true;
    }

    // ── Track-B lp_remove fold (mirror cxfer-core fold_lp_remove + the canonical-pair pool search) ──
    // The LP burns its detected LP-share spends (which net to share_amount under the share-burn kernel) and
    // withdraws the proportional (delta_a, delta_b); both withdrawn notes are onboarded (each bound to its
    // PUBLIC delta_X by a witnessed blinding) and reserves/shares drawn down. The envelope has no fee_bps, so
    // the pool is found by canonical-pair enumeration + kernel disambiguation. Returns the two recv note-paths,
    // or null (skip) on any gate. `lpOutpoints` / `lpOpenings` are the detected burned LP-share spends.
    function foldLpRemove(lr, lpOutpoints, lpOpenings, recvAOutpoint, recvBOutpoint) {
      const [ca, cb] = ammCanonicalPair(lr.assetA, lr.assetB);
      if (!ca) return null;
      const swapped = hx(b32(lr.assetA)) !== ca;
      const [daC, dbC] = swapped ? [lr.deltaB, lr.deltaA] : [lr.deltaA, lr.deltaB];
      const [recvCa, recvCb] = swapped ? [lr.recvBSecp, lr.recvASecp] : [lr.recvASecp, lr.recvBSecp];
      const [rca, rcb] = swapped ? [lr.rRecvB, lr.rRecvA] : [lr.rRecvA, lr.rRecvB];
      const lpPts = lpOpenings.map((o) => secp.ProjectivePoint.fromAffine({ x: BigInt(o.cx), y: BigInt(o.cy) }));
      // Find the pool whose pool_id makes the share-burn kernel verify (one V1 candidate per pair), then fold
      // it (break after the first kernel-match, matching the guest — the non-kernel gates apply to that pool).
      for (const pid of pools.poolIdsForAssets(ca, cb)) {
        if (!lpRemoveKernelVerify(pid, lr.shareAmount, daC, dbC, recvCa, recvCb, lpOutpoints, lpPts, lr.kernelSig)) continue;
        const pool = pools.get(pid);
        if (!pool || !pool.c0Backed) return null;
        crystallizeProtocolFee(pool); // crystallize BEFORE the withdrawal (Uniswap-V2 _mintFee)
        const S = BigInt(pool.totalShares), sa = BigInt(lr.shareAmount);
        if (S === 0n || sa === 0n || sa > S) return null;
        const da = (BigInt(pool.reserveA) * sa) / S, db = (BigInt(pool.reserveB) * sa) / S;
        if (da !== BigInt(daC) || db !== BigInt(dbC)) return null;       // proportional (matches the worker)
        if (da === 0n || db === 0n) return null;
        if (!verifyPedersenOpening(recvCa, da, rca)) return null;        // recv_a opens to delta_a (witnessed r)
        if (!verifyPedersenOpening(recvCb, db, rcb)) return null;        // recv_b opens to delta_b
        const A = decompressCommitment(recvCa), B = decompressCommitment(recvCb);
        const wa = foldOutput(leaf(pool.assetA, A.cx, A.cy, CBTC_NOTE_OWNER), recvAOutpoint, commitmentHash(A.cx, A.cy), pool.assetA);
        const wb = foldOutput(leaf(pool.assetB, B.cx, B.cy, CBTC_NOTE_OWNER), recvBOutpoint, commitmentHash(B.cx, B.cy), pool.assetB);
        const upd = { ...pool };
        upd.reserveA = BigInt(pool.reserveA) - da;
        upd.reserveB = BigInt(pool.reserveB) - db;
        upd.totalShares = S - sa;
        upd.kLast = upd.reserveA * upd.reserveB;       // not a fee — advance k_last to the post-removal k
        pools.set(pid, upd);
        return { recvAPath: wa.notePath, recvBPath: wb.notePath };
      }
      return null;
    }

    // ── Track-B lp_add / POOL_INIT fold (mirror cxfer-core fold_lp_add + fold_lp_share_mint) ──
    // The LP's per-asset detected spends fund a pool (variant 1 = POOL_INIT, insert at isqrt(ΔaΔb) shares;
    // variant 0 = LP-add, grow an existing pool by the proportional mint), each side's inputs proven to net
    // to delta_X by its kernel. Then the minted LP-share note (opens to the total_shares delta this op
    // produced, under a witnessed blinding) is onboarded so it bridges + a later LP-remove can burn it. All
    // mapped to canonical asset order. Returns the share note-path, or null (skip) on any gate. `spends` = the
    // detected LP contributions. (Live edge: a fold that mutates the pool but fails the share-mint still
    // consumed share_r/share_path — not reachable by a valid 0x2D, which always mints.)
    function foldLpAdd(la, spends, shareR, shareOutpoint) {
      const [ca, cb] = ammCanonicalPair(la.assetA, la.assetB);
      if (!ca) return null;
      const swapped = hx(b32(la.assetA)) !== ca;
      const [daC, dbC] = swapped ? [la.deltaB, la.deltaA] : [la.deltaA, la.deltaB];
      const [kaC, kbC] = swapped ? [la.kernelSigB, la.kernelSigA] : [la.kernelSigA, la.kernelSigB];
      const pid = la.variant === 1
        ? ammDerivePoolIdFull(ca, cb, la.feeBps, la.capabilityFlags, la.protocolFeeAddress, la.protocolFeeBps)
        : (pools.poolIdsForAssets(ca, cb)[0] || null);
      if (!pid) return null;
      const coll = (asset) => {                          // group the detected spends by canonical asset side
        const ops = [], pts = [];
        for (const s of spends) if (hx(b32(s.asset)) === asset) { ops.push(s.outpoint); pts.push(secp.ProjectivePoint.fromAffine({ x: BigInt(s.cx), y: BigInt(s.cy) })); }
        return [ops, pts];
      };
      const [aOps, aPts] = coll(ca), [bOps, bPts] = coll(cb);
      const preShares = pools.get(pid) ? BigInt(pools.get(pid).totalShares) : 0n;
      if (!lpAddKernelVerify(la.variant, pid, ca, daC, la.shareAmount, la.shareCsecp, aOps, aPts, kaC)) return null;
      if (!lpAddKernelVerify(la.variant, pid, cb, dbC, la.shareAmount, la.shareCsecp, bOps, bPts, kbC)) return null;
      if (la.variant === 1) {                            // POOL_INIT: a fresh pool
        if (pools.get(pid)) return null;
        if (BigInt(daC) === 0n || BigInt(dbC) === 0n) return null;
        const totalShares = isqrt(BigInt(daC) * BigInt(dbC));
        if (totalShares > U64_MAX) return null;
        pools.set(pid, { assetA: ca, assetB: cb, reserveA: BigInt(daC), reserveB: BigInt(dbC), totalShares, c0Backed: true, protocolFeeBps: Number(la.protocolFeeBps || 0), kLast: BigInt(daC) * BigInt(dbC), protocolFeeAccrued: 0n });
      } else if (la.variant === 0) {                     // LP-add: grow an existing pool
        const pool = pools.get(pid);
        if (!pool) return null;
        if (hx(b32(pool.assetA)) !== ca || hx(b32(pool.assetB)) !== cb) return null;
        crystallizeProtocolFee(pool);                    // _mintFee BEFORE the deposit (proportional over post-crystallize S)
        const minted = lpAddShares(pool.totalShares, daC, dbC, pool.reserveA, pool.reserveB);
        if (minted > U64_MAX) return null;
        const upd = { ...pool };
        upd.reserveA = BigInt(pool.reserveA) + BigInt(daC);
        upd.reserveB = BigInt(pool.reserveB) + BigInt(dbC);
        upd.totalShares = BigInt(pool.totalShares) + minted;
        upd.kLast = upd.reserveA * upd.reserveB;          // deposit isn't a fee — advance k_last to the post-deposit k
        pools.set(pid, upd);
      } else { return null; }
      // Onboard the LP's minted share note (lp_shares = the total_shares delta this op produced).
      const p = pools.get(pid);
      const lpShares = la.variant === 1 ? BigInt(p.totalShares) - AMM_MINIMUM_LIQUIDITY : BigInt(p.totalShares) - preShares;
      if (lpShares <= 0n) return null;
      if (!verifyPedersenOpening(la.shareCsecp, lpShares, shareR)) return null;
      const lpAsset = ammDeriveLpAssetId(pid);
      const { cx, cy } = decompressCommitment(la.shareCsecp);
      const w = foldOutput(leaf(lpAsset, cx, cy, CBTC_NOTE_OWNER), shareOutpoint, commitmentHash(cx, cy), lpAsset);
      return { sharePath: w.notePath };
    }

    return {
      commit, digest, foldSpent, foldOutput, foldNoteAppend, foldBurn, foldCbtcLock, foldCbtcLockSpends, foldSwapVar, foldSwapRoute, foldHarvest, foldProtocolFeeClaim, foldFarmInit, foldLpRemove, foldLpAdd, setHeight,
      // The next free slot's note append-path, computed WITHOUT inserting — the swap_batch witness emits this n
      // times on a skip (the guest reads n receipt paths unconditionally, then discards them when the fold bails).
      notePathPeek: () => notes.rootAndPath(noteCount()).path,
      spentContains: (nu) => spent.contains(nu),
      poolRoot: () => notes.root(), spentRoot: () => spent.root(), burnRoot: () => burns.root(), liveRoot: () => live.root(),
      cbtcBackingSats: () => cbtcBackingSats, cbtcLocks,
      counts: () => ({ note: noteCount(), spent: spentCount(), live: live.len(), burn: burnCount(), height }),
      live, pools, _acc: { notes, spent, live, burns },
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
  const u16leBytes = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, Number(n) & 0xffff, true); return b; };
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
  // swap_var kernel (mirror cxfer-core swap_var_kernel_verify → asset_scoped_kernel_verify): the taker's
  // input C_in contributes delta_in_total of asset_in; verify key P = C_in − C_change − delta_in_total·H
  // (x-only). A sentinel (all-zero) c_change means no change (C_change = identity). The message binds
  // asset ‖ the input outpoint ‖ c_change ‖ delta_in_total — distinct from the cxfer kernel message.
  function swapVarKernelVerify(asset, inputOutpoint, cInHex, cChangeHex, deltaInTotal, kernelSigHex) {
    const [txid, vout] = inputOutpoint;
    const msg = sha256(concat([CXFER_KERNEL_DOMAIN, b32(asset), Uint8Array.of(1), b32(txid), u32le(vout), Uint8Array.of(1), hexToBytes(cChangeHex), u64leBytes(deltaInTotal)]));
    let cInPt; try { cInPt = secp.ProjectivePoint.fromHex(cInHex.replace(/^0x/, '')); } catch { return false; }
    const isSentinel = /^(0x)?0*$/i.test(cChangeHex);
    const Z = secp.ProjectivePoint.ZERO;
    let cChangePt = Z;
    if (!isSentinel) { try { cChangePt = secp.ProjectivePoint.fromHex(cChangeHex.replace(/^0x/, '')); } catch { return false; } }
    let P = cInPt.add(cChangePt.negate());
    if (BigInt(deltaInTotal) !== 0n) P = P.add(prover.H.multiply(BigInt(deltaInTotal)).negate());
    if (P.equals(Z)) return false;                    // identity verify key → reject (matches Rust)
    const px = P.toRawBytes(true).slice(1);           // x-only verify key
    let sig; try { sig = hexToBytes(kernelSigHex); } catch { return false; }
    if (sig.length !== 64) return false;
    return verifySchnorr(sig, msg, px);
  }
  // Direct Pedersen opening C == amount·H + r·G with a PUBLIC r (mirror verify_pedersen_opening) — a swap
  // receipt's blinding r_receipt is cleartext, so its value is exactly delta_out.
  function verifyPedersenOpening(cHex, amount, rHex) {
    let C; try { C = secp.ProjectivePoint.fromHex(cHex.replace(/^0x/, '')); } catch { return false; }
    return C.equals(prover.commit(BigInt(amount), mod(BigInt(rHex), N)));
  }
  // ── Track-B protocol-fee crystallization (mirror cxfer-core PoolReserveState::crystallize_protocol_fee +
  // protocol_fee_shares — the Uniswap-V2 lazy mintFee skim from SWAP-driven k-growth). isqrt / shares are the
  // byte-for-byte BigInt port of the worker's ammIsqrt / ammComputeProtocolShares the protocol cites. ──
  const U64_MAX = (1n << 64n) - 1n;
  const AMM_LP_ASSET_DOMAIN = new TextEncoder().encode('tacit-amm-lp-v1');
  const isqrt = (nIn) => { let n = BigInt(nIn); if (n < 2n) return n < 0n ? 0n : n; let x = n, y = (x + 1n) >> 1n; while (y < x) { x = y; y = (x + n / x) >> 1n; } return x; };
  function protocolFeeShares(sPre, kPre, kNow, feeBps) {
    const S = BigInt(sPre), kp = BigInt(kPre), kn = BigInt(kNow), bps = BigInt(feeBps);
    if (bps === 0n || S === 0n || kn <= kp) return 0n;
    const rootPre = isqrt(kp), rootNow = isqrt(kn);
    if (rootNow <= rootPre) return 0n;
    const den = (10000n - bps) * rootNow + bps * rootPre;
    if (den === 0n) return 0n;
    const r = (S * bps * (rootNow - rootPre)) / den;
    return r > U64_MAX ? U64_MAX : r;     // saturate to u64 (matches the Rust unwrap_or(u64::MAX))
  }
  const satU64 = (x) => (x > U64_MAX ? U64_MAX : x);
  // The reflection's crystallize gates ONLY on protocol_fee_bps (PoolReserveState has no fee-recipient
  // address). Mutates the passed pool copy: mint the swap-driven skim into accrued + total_shares, advance k_last.
  function crystallizeProtocolFee(pool) {
    if (Number(pool.protocolFeeBps || 0) === 0) return;
    const kNow = BigInt(pool.reserveA) * BigInt(pool.reserveB);
    if (kNow <= BigInt(pool.kLast || 0)) { pool.kLast = kNow; return; }
    const shares = protocolFeeShares(pool.totalShares, pool.kLast, kNow, pool.protocolFeeBps);
    pool.protocolFeeAccrued = satU64(BigInt(pool.protocolFeeAccrued || 0) + shares);
    pool.totalShares = satU64(BigInt(pool.totalShares || 0) + shares);
    pool.kLast = kNow;
  }
  // Bitcoin-AMM LP-share asset-id: sha256(domain ‖ pool_id) (mirror amm_derive_lp_asset_id / ammDeriveLpAssetId).
  const ammDeriveLpAssetId = (poolId) => hx(sha256(concat([AMM_LP_ASSET_DOMAIN, b32(poolId)])));
  // Bitcoin-AMM farm-id: sha256(domain ‖ pool_id ‖ launcher_pubkey(33) ‖ reward_asset ‖ farm_nonce) (mirror
  // amm_derive_farm_id / worker ammDeriveFarmId). Keys a farm treasury so a harvest draws from the right one.
  const AMM_FARM_INIT_DOMAIN = new TextEncoder().encode('tacit-amm-farm-init-v1');
  const ammDeriveFarmId = (poolId, launcherPubkey, rewardAsset, farmNonce) =>
    hx(sha256(concat([AMM_FARM_INIT_DOMAIN, b32(poolId), hexToBytes(launcherPubkey), b32(rewardAsset), b32(farmNonce)])));
  // Canonical asset pair (mirror amm_canonical_pair): sort the two asset-ids; returns [ca, cb] (ca < cb) or
  // [null, null] if equal. A variant-0 LP-remove carries no fee_bps, so the pool is found by enumerating the
  // registry for this canonical pair (pools.poolIdsForAssets) + disambiguated by which pool_id makes the kernel verify.
  function ammCanonicalPair(a, b) {
    const ha = hx(b32(a)), hb2 = hx(b32(b));
    if (ha === hb2) return [null, null];
    return BigInt(ha) < BigInt(hb2) ? [ha, hb2] : [hb2, ha];
  }
  // Generalized asset-scoped conservation kernel (mirror asset_scoped_kernel_verify): verify key
  // P = Σ in − Σ out − net·H (x-only), BIP-340 over msg. The shared core of the lp_remove kernel.
  function assetScopedKernelVerify(msg, inPts, outPts, net, sigHex) {
    const Z = secp.ProjectivePoint.ZERO;
    let P = inPts.reduce((a, p) => a.add(p), Z).add(outPts.reduce((a, p) => a.add(p), Z).negate());
    if (BigInt(net) !== 0n) P = P.add(prover.H.multiply(BigInt(net)).negate());
    if (P.equals(Z)) return false;                    // identity verify key → reject (matches Rust)
    let sig; try { sig = hexToBytes(sigHex); } catch { return false; }
    if (sig.length !== 64) return false;
    return verifySchnorr(sig, msg, P.toRawBytes(true).slice(1));
  }
  // LP-remove share-burn kernel (mirror lp_remove_kernel_verify): the burned LP-share inputs net to EXACTLY
  // share_amount (anti-theft — only a real shareholder withdraws). msg binds (pool_id, share_amount, delta_a,
  // delta_b, recv_a_secp, recv_b_secp, LP input outpoints).
  const LP_REMOVE_KERNEL_DOMAIN = new TextEncoder().encode('tacit-amm-lp-remove-v1');
  function lpRemoveKernelVerify(poolId, shareAmount, deltaA, deltaB, recvASecp, recvBSecp, lpOutpoints, lpPts, sigHex) {
    if (lpOutpoints.length === 0 || lpOutpoints.length > 255 || lpOutpoints.length !== lpPts.length) return false;
    const parts = [LP_REMOVE_KERNEL_DOMAIN, b32(poolId), u64leBytes(shareAmount), u64leBytes(deltaA), u64leBytes(deltaB), hexToBytes(recvASecp), hexToBytes(recvBSecp), Uint8Array.of(lpOutpoints.length & 0xff)];
    for (const [txid, vout] of lpOutpoints) { parts.push(b32(txid)); parts.push(u32le(vout)); }
    return assetScopedKernelVerify(sha256(concat(parts)), lpPts, [], shareAmount, sigHex);
  }
  // LP-add per-asset kernel (mirror lp_add_kernel_verify): the LP's asset-X inputs net to EXACTLY delta_x.
  // msg binds (variant, pool_id, asset_x, delta_x, share_amount, share_csecp, input outpoints).
  const LP_ADD_KERNEL_DOMAIN = new TextEncoder().encode('tacit-amm-lp-add-v1');
  function lpAddKernelVerify(variant, poolId, assetX, deltaX, shareAmount, shareCsecp, inOutpoints, inPts, sigHex) {
    if (inOutpoints.length === 0 || inOutpoints.length > 255 || inOutpoints.length !== inPts.length) return false;
    const parts = [LP_ADD_KERNEL_DOMAIN, Uint8Array.of(variant & 0xff), b32(poolId), b32(assetX), u64leBytes(deltaX), u64leBytes(shareAmount), hexToBytes(shareCsecp), Uint8Array.of(inOutpoints.length & 0xff)];
    for (const [txid, vout] of inOutpoints) { parts.push(b32(txid)); parts.push(u32le(vout)); }
    return assetScopedKernelVerify(sha256(concat(parts)), inPts, [], deltaX, sigHex);
  }
  // AMM pool_id derivation (mirror amm_derive_pool_id_full / worker ammDerivePoolId): sha256(domain ‖ low ‖
  // high ‖ fee_bps_LE ‖ capability_flags ‖ [protocol_fee_address ‖ protocol_fee_bps_LE iff fee != 0]). A
  // protocol-fee / capability-flagged pool gets a DISTINCT pool_id from the canonical no-skim slot.
  const AMM_POOL_ID_DOMAIN = new TextEncoder().encode('tacit-amm-pool-v1');
  function ammDerivePoolIdFull(assetA, assetB, feeBps, capabilityFlags, protocolFeeAddress, protocolFeeBps) {
    const [low, high] = ammCanonicalPair(assetA, assetB);
    if (!low) return null;
    const parts = [AMM_POOL_ID_DOMAIN, b32(low), b32(high), u16leBytes(feeBps), Uint8Array.of(Number(capabilityFlags) & 0xff)];
    if (Number(protocolFeeBps) !== 0) { parts.push(hexToBytes(protocolFeeAddress)); parts.push(u16leBytes(protocolFeeBps)); }
    return hx(sha256(concat(parts)));
  }
  const AMM_MINIMUM_LIQUIDITY = 1000n;
  // Constant-product LP-add proportional mint (mirror lp_add_shares): min(S·dA/Ra, S·dB/Rb).
  function lpAddShares(sharesPre, dA, dB, reserveA, reserveB) {
    const sp = BigInt(sharesPre);
    const a = (sp * BigInt(dA)) / BigInt(reserveA), b = (sp * BigInt(dB)) / BigInt(reserveB);
    return a < b ? a : b;
  }
  // swap_batch aggregate Pedersen identity (mirror swap_batch_aggregate_identity) — the per-asset NO-INFLATION
  // bound for a T_SWAP_BATCH: Σ(input C_in_secp) − Σ(output C_out_secp) − tip_X − (±δ_X·H) == R_net_X·G. Ties
  // the receipts' total to the traders' REAL spent inputs + the public net delta + the c0-backed reserve, so a
  // batch can't onboard unbacked value. `intents`: [{direction, cInSecp}]; `receiptsCOut`: compressed hex[].
  function swapBatchAggregateIdentity(intents, receiptsCOut, assetXIsA, deltaXSign, deltaXMag, tipXCSecp, rNetX) {
    if (intents.length !== receiptsCOut.length) return false;
    const Z = secp.ProjectivePoint.ZERO;
    const pt = (h) => secp.ProjectivePoint.fromHex(String(h).replace(/^0x/, ''));
    let sum = Z;
    try {
      for (let i = 0; i < intents.length; i++) {
        const dir = intents[i].direction;
        const isInput = (assetXIsA && dir === 0) || (!assetXIsA && dir === 1);
        const isOutput = (assetXIsA && dir === 1) || (!assetXIsA && dir === 0);
        if (isInput) sum = sum.add(pt(intents[i].cInSecp));
        else if (isOutput) sum = sum.add(pt(receiptsCOut[i]).negate());
      }
      sum = sum.add(pt(tipXCSecp).negate());
    } catch { return false; }
    if (BigInt(deltaXMag) !== 0n) {
      const dh = prover.H.multiply(BigInt(deltaXMag));
      sum = deltaXSign === 0 ? sum.add(dh.negate()) : sum.add(dh);
    }
    const k = mod(BigInt(rNetX), N);                          // R_net_X reduced mod n (matches scalar_reduce_be)
    return sum.equals(k === 0n ? Z : secp.ProjectivePoint.BASE.multiply(k));
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

  async function assembleReflectionScanInput(state, batch, coords) {
    const norm = (x) => hx(b32(x));
    const c = state.counts();
    const prior = {
      poolRoot: state.poolRoot(), noteCount: c.note,
      spentRoot: state.spentRoot(), spentCount: c.spent,
      live: state.live.triples(), liveCount: c.live,
      burnRoot: state.burnRoot(), burnCount: c.burn,
      height: c.height,
      // Track B: the per-pool reserve registry the guest reads after cbtcBackingSats (empty today; the
      // harness writes n_pools=0 + no entries, the guest reconstructs the same empty registry).
      pools: state.pools.list(),
    };
    const blocksOut = [];
    const nonConserving = [];
    // Value-entry envelopes (T_MINT/cmint) the full-scan model does NOT yet reflect: the model is
    // conservation-CLOSED (no free-output deposit path — that was the REFLECT-1 risk), so a mint's
    // output does not enter bitcoinPoolRoot and is not bridge-mintable until the cmint-deposit effect
    // ships (SPEC-BITCOIN-REFLECTION-AMENDMENT §6.1). Surface them LOUD so a value-entering envelope is
    // never silently dropped (the guest skips it identically — an unrecognized envelope folds nothing).
    const unreflectedValueEntry = [];
    // Tacit envelopes the guest FOLDS but this scan does not yet mirror — surfaced so the attester
    // refuses the batch rather than desync the witness stream. See txSpec / classifyConfidentialTx.
    const unsupportedEnvelopes = [];
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
        // cBTC.zk self-custody rug: drop the backing of any tracked lock outpoint this tx spends (mirror
        // the guest's fold_cbtc_lock_spends, run after the vin scan, before the envelope folds). No witness.
        state.foldCbtcLockSpends(tx.vins || []);
        let burnInsert = null;
        let burnDeposit = null;
        let cbtcLock = null;
        let swapVar = null;
        let swapRoute = null;
        let harvest = null;
        let protocolFee = null;
        let lpRemove = null;
        let lpAdd = null;
        let swapBatch = null;
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
        } else if (tx.env && tx.env.type === 'unsupported') {
          // A Tacit envelope the guest FOLDS (AMM lp/swap/route/batch, farm, protocol-fee claim, cBTC
          // lock, bid, crossout, AXFER) but the JS scan does not yet mirror. The guest reads fold
          // witnesses for it; this scan emits none, so the batch's witness stream would desync → a wrong,
          // un-chainable digest. Surface it (loud) so the attester refuses rather than attest a divergent
          // root. Removing an entry here = implementing that fold in the scan state + this assembler.
          unsupportedEnvelopes.push({ txid: tx.txid, opcode: tx.env.opcode });
        } else if (tx.env && tx.env.type === 'cbtc_lock') {
          // cBTC.zk sats-lock: fold the lock (gate + track + append the owner-free note). The opening sigma
          // (rx/ry/z) is now ON-CHAIN in the 0x66 envelope (option a) — the guest parses it, so the only witness
          // the assembler emits per 0x66 is the note's append path. The sigma still feeds the fold via `tx.env`
          // (the parser populates it from the envelope). lockTxid = the lock tx's txid.
          const w = state.foldCbtcLock({ asset: tx.env.asset, cx: tx.env.cx, cy: tx.env.cy, vBtc: tx.env.vBtc, lockVout: tx.env.lockVout, lockTxid: tx.txid, sigRx: tx.env.sigRx, sigRy: tx.env.sigRy, sigZ: tx.env.sigZ });
          // The guest reads note_path for ANY parseable 0x66 before the fold; emit it even on a skip (the
          // guest discards it then) so the witness stream stays aligned.
          cbtcLock = { notePath: w ? w.notePath : state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'swap_var') {
          // Track-B swap_var: the taker spends one pool note (detected above); fold the receipt + advance
          // the pool reserves. Witness = the receipt note-path the guest reads after the 0x32 envelope.
          // (Sentinel-change only for now; non-sentinel change onboarding is a follow-up.)
          if (openings.length === 1) {
            const sw = state.foldSwapVar(tx.env, inOutpoints[0], inAssets[0], outpointKey(tx.txid, 1));
            if (sw) swapVar = { receiptPath: sw.notePath };
          }
        } else if (tx.env && tx.env.type === 'swap_route') {
          // Track-B swap_route (0x33): the trader's single detected input (c_in must match the spend) flows
          // through 2–4 pools → one receipt note (vout 1). Witness (per 0x33): the receipt's append path.
          if (openings.length === 1 && compressXY(openings[0].cx, openings[0].cy).toLowerCase() === String(tx.env.cIn).toLowerCase()) {
            const rw = state.foldSwapRoute(tx.env, inOutpoints[0], inAssets[0], outpointKey(tx.txid, 1));
            if (rw) swapRoute = { receiptPath: rw.receiptPath };
          }
        } else if (tx.env && (tx.env.type === 'harvest' || tx.env.type === 'farm_refund')) {
          // Track-B harvest (0x3B) / farm-refund (0x3E): onboard the decree-minted reward/refund note (vout 1)
          // drawn from the C0-backed farm treasury. No input spend — the note is derived from the public (amount, r).
          const hw = state.foldHarvest(tx.env.farmId, tx.env.amount, tx.env.r, outpointKey(tx.txid, 1));
          if (hw) harvest = { notePath: hw.notePath };
        } else if (tx.env && tx.env.type === 'protocol_fee_claim') {
          // Track-B protocol-fee claim (0x31): crystallize the pool's swap-driven fee accrual + onboard the
          // claim note (vout 1) as an LP-share note. No input spend — the note is minted by decree.
          const pw = state.foldProtocolFeeClaim(tx.env.poolId, tx.env.amount, tx.env.cSecp, tx.env.blinding, outpointKey(tx.txid, 1));
          if (pw) protocolFee = { notePath: pw.notePath };
        } else if (tx.env && tx.env.type === 'farm_init') {
          // Track-B farm-init (0x34): the launcher's single detected reward-asset spend funds the treasury under
          // the swap-shape kernel; register the farm (a degenerate pool keyed by farm_id). No note → no witness.
          if (openings.length === 1 && hx(b32(inAssets[0])) === hx(b32(tx.env.rewardAsset))) {
            const cIn = compressXY(openings[0].cx, openings[0].cy);
            const farmId = ammDeriveFarmId(tx.env.poolId, tx.env.launcherPubkey, tx.env.rewardAsset, tx.env.farmNonce);
            state.foldFarmInit(farmId, tx.env.rewardAsset, tx.env.rewardTotal, inOutpoints[0], cIn, tx.env.cChangeOrSentinel, tx.env.kernelSig);
          }
        } else if (tx.env && tx.env.type === 'lp_remove') {
          // Track-B lp_remove (0x2E): the LP's detected LP-share spends are burned; onboard the two withdrawn
          // notes (vout 1, 2) + draw down reserves/shares. The two recv blindings r_recv_a/b are now ON-CHAIN
          // (option a; the guest parses them) — so the only witnesses per 0x2E are the two recv append paths.
          const lw = state.foldLpRemove(tx.env, inOutpoints, openings, outpointKey(tx.txid, 1), outpointKey(tx.txid, 2));
          // The guest reads BOTH recv paths for any parseable 0x2E before the fold (e.g. an untracked-pool
          // lp_remove legitimately skips) — emit both even on a skip (discarded then) to keep the stream aligned.
          lpRemove = lw ? { recvAPath: lw.recvAPath, recvBPath: lw.recvBPath } : { recvAPath: state.notePathPeek(), recvBPath: state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'lp_add') {
          // Track-B lp_add / POOL_INIT (0x2D): the LP's detected per-asset spends fund the pool (insert for
          // POOL_INIT, grow for LP-add); onboard the minted LP-share note (vout 1). The share blinding share_r is
          // now ON-CHAIN (option a; the guest parses it) — so the only witness per 0x2D is the share append path.
          const spends = openings.map((o, i) => ({ cx: o.cx, cy: o.cy, asset: inAssets[i], outpoint: inOutpoints[i] }));
          const aw = state.foldLpAdd(tx.env, spends, tx.env.shareR, outpointKey(tx.txid, 1));
          // The guest reads share_path for any parseable 0x2D before the fold; emit it even on a skip (discarded
          // then) so the witness stream stays aligned.
          lpAdd = { sharePath: aw ? aw.sharePath : state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'swap_batch') {
          // Track-C swap_batch (0x2F): every receipt onboarded as a real note + reserves advanced, gated by the
          // BN254 Groth16 + the aggregate identity + per-receipt xcurve. The fold (BabyJubJub / snarkjs deps) is
          // injected as `batch.swapBatchFold` so confidential-pool.js stays lean; the hook is async — its Groth16
          // verify runs against the pool's CURRENT (fold-point) reserves, so a prior same-block op that moved them
          // is reflected. The guest reads n receipt paths UNCONDITIONALLY (dispatch r_path()×n) before folding, so
          // the witness must carry n paths whether the fold onboards or skips; on a skip the guest discards them
          // (no append → digest unchanged), so the frontier path ×n keeps the stream aligned.
          if (typeof batch.swapBatchFold === 'function') {
            const n = tx.env.nIntents | 0;
            const sw = await batch.swapBatchFold(tx.env, tx.txid, openings.map((o) => ({ cx: o.cx, cy: o.cy })));
            swapBatch = { receiptPaths: (sw && sw.receiptPaths) ? sw.receiptPaths : Array.from({ length: n }, () => state.notePathPeek()) };
          } else {
            // No verify hook wired (no vk) — the guest WOULD fold this; surface it so the attester refuses rather
            // than emit a witness short n paths (a desync). Liveness, never a wrong digest.
            unsupportedEnvelopes.push({ txid: tx.txid, opcode: 0x2f });
          }
        }
        txsOut.push({ txData: tx.txData, openings, spentInserts, burnInsert, outputs, burnDeposit, cbtcLock, swapVar, swapRoute, harvest, protocolFee, lpRemove, lpAdd, swapBatch });
      }
      blocksOut.push({ txs: txsOut });
      blockIndex++;
    }
    return { prior, anchorHeight: batch.anchorHeight | 0, headers: batch.headers || [], blocks: blocksOut, newDigest: state.digest(), nonConserving, unreflectedValueEntry, unsupportedEnvelopes };
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
    CBTC_ZK_ASSET_ID, CBTC_LOCK_DOMAIN, cbtcLockContext,
    cxferKernelVerify, verifyCxferConservation,
    protocolFeeShares, crystallizeProtocolFee, ammDeriveLpAssetId, ammDeriveFarmId, ammCanonicalPair, ammDerivePoolIdFull, lpRemoveKernelVerify, lpAddKernelVerify, lpAddShares, swapBatchAggregateIdentity, AMM_MINIMUM_LIQUIDITY, isqrt,
    _internal: { keccak, concat, b32, beBytes, hx },
  };
}
