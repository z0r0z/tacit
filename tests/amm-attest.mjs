// Preconfirmation layer for tacit — T_INTENT_ATTEST (opcode 0x30,
// SPEC.md §5.17). Scope-generic: AMM pools, orderbook pairs, and any
// future intent surface share this opcode via a 32-byte `scope_id`
// discriminator the indexer treats as opaque.
//
// The protocol layer (T_SWAP_BATCH, T_LP_ADD, T_LP_REMOVE for AMM;
// T_AXFER_VAR for orderbook) settles at the Bitcoin block clock
// (~10 min). For perceived-UX latency, the worker maintains a sparse
// Merkle tree of the **open intent set** per scope and attests to its
// root on a per-block cadence. Traders receive a Merkle membership
// proof for their intent within ~30 sec of submission; the worker
// periodically broadcasts a `T_INTENT_ATTEST` envelope on chain so the
// attestation chain is anchored to Bitcoin (equivocation detectable
// at depth-1).
//
// For AMM scope, scope_id == pool_id. For orderbook scope, scope_id =
// SHA256("tacit-orderbook-pair-v1" || asset_id_min || asset_id_max)
// (see SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md).
//
// Two layers, fully independent:
//
//   Soft confirm (preconf):
//     trader → worker → Merkle insert → signed attestation
//     trader gets {merkle_proof, root, worker_sig, ipfs_cid} in ~30 sec
//     worker broadcasts T_AMM_ATTEST per Bitcoin block to anchor the root
//
//   Hard confirm (settlement):
//     trader → settler RTT-1/RTT-2 → T_SWAP_BATCH envelope
//     trader's funds settle at L1 in ~10 min, no preconf trust needed
//
// If the preconf layer is offline or compromised, the hard-confirm path
// still works. Multi-worker support means single-worker failure doesn't
// degrade the network; traders register intents with ≥ 2 workers and
// settlers monitor all attestation chains.
//
// Wire format (T_INTENT_ATTEST, opcode 0x30):
//   opcode(1)             = 0x30
//   scope_id(32)          — opaque scope discriminator (AMM: pool_id;
//                           orderbook: SHA256(pair domain || asset_min ||
//                           asset_max); other surfaces define their own)
//   intent_pool_hash(32)  — SHA256(sorted_intent_id_0 || ... || sorted_intent_id_{N-1})
//                           — linear hash over the worker's open-intent set
//                           sorted lex-ascending. NOT an SMT root.
//   observed_height_LE(4) — u32, Bitcoin block height the snapshot is "as of"
//   timestamp_LE(8)       — u64, worker's wall-clock unix seconds at sign
//   intent_count_LE(2)    — u16, number of intents committed in this snapshot
//   snapshot_uri_len(1)   — u8, 0..255 (0 = no URI; informational only,
//                           never fetched by indexer / not consensus-bound)
//   snapshot_uri(snapshot_uri_len) — UTF-8 HTTP(S) endpoint or IPFS CID prefix
//   worker_pubkey(33)     — compressed secp256k1
//   worker_sig(64)        — BIP-340 over SHA256("tacit-intent-attest-v1"
//                                                || all preceding fields)
//
// Indexer ordering rule: per (scope_id, worker_pubkey, height), at most one
// canonical T_INTENT_ATTEST. Two valid attestations with same
// (worker, scope, height) but different roots = equivocation; worker is
// flagged compromised. Equivocation is detected per-scope, so a worker
// can attest to many scopes (AMM pools + orderbook pairs) independently.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import { signSchnorr, verifySchnorr } from './composition.mjs';
import { canonicalize } from './amm-jcs.mjs';

export const OPCODE_T_INTENT_ATTEST = 0x30;
// Legacy alias retained for any callers still importing the old name;
// new code SHOULD use OPCODE_T_INTENT_ATTEST.
export const OPCODE_T_AMM_ATTEST = OPCODE_T_INTENT_ATTEST;
export const SMT_DEPTH = 256;                                // intent_id is 32 bytes = 256 bits; leaves are full-key keyed
export const ATTEST_DOMAIN = new TextEncoder().encode('tacit-intent-attest-v1');
export const EMPTY_LEAF = sha256(new TextEncoder().encode('tacit-amm-empty-leaf-v1'));

// ---- Canonical on-chain intent_pool_hash (AMM.md §"Intent-pool hash") ----
//
// The on-chain T_INTENT_ATTEST envelope commits to a LINEAR SHA256 over the
// worker's sorted open-intent set:
//
//   intent_pool_hash = SHA256(sorted_iid_0 || sorted_iid_1 || ... || sorted_iid_{N-1})
//
// where each `sorted_iid_i` is a 32-byte intent_id sorted lex-ascending. This
// is byte-identical across implementations and is what the indexer hashes
// when verifying inclusion. Empty pool: `intent_pool_hash = SHA256("")` per
// spec — useful for liveness attestations with no open intents.
//
// (The OpenIntentSMT class below is a separate in-memory data structure for
// off-chain efficient membership-proof generation; its root is NOT what
// goes in the on-chain envelope.)
export function computeIntentPoolHash(intentIds) {
  if (!Array.isArray(intentIds)) throw new Error('intentIds must be Array');
  // Sort lex-ascending in 32-byte form.
  const sorted = intentIds
    .map(id => id instanceof Uint8Array ? id : hexToBytes(id))
    .map(id => { if (id.length !== 32) throw new Error('intent_id must be 32 bytes'); return id; })
    .sort((a, b) => {
      for (let i = 0; i < 32; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
      return 0;
    });
  // Reject duplicates (same defense-in-depth as validator's strict-ascending).
  for (let i = 1; i < sorted.length; i++) {
    let cmp = 0;
    for (let j = 0; j < 32; j++) { if (sorted[i][j] !== sorted[i-1][j]) { cmp = sorted[i][j] - sorted[i-1][j]; break; } }
    if (cmp === 0) throw new Error(`duplicate intent_id at index ${i}`);
  }
  if (sorted.length === 0) return sha256(new Uint8Array(0));
  return sha256(concatBytes(...sorted));
}

// =========================================================================
// Sparse Merkle Tree (SMT)
// =========================================================================
//
// Keyed by intent_id (32-byte). Leaves store intent_msg_hash (32-byte).
// Inner nodes = SHA256(left_child || right_child).
// Empty subtree at depth d = EMPTY_NODE[d] (precomputed below).
//
// The full SMT has 2^32 possible leaf positions; we store only non-empty
// leaves explicitly in a `Map<intent_id_hex, intent_msg_hash>`. Proofs are
// computed lazily by walking the tree.

function bitAt(bytes, bitIndex) {
  const byte = bytes[bitIndex >> 3];
  return (byte >> (7 - (bitIndex & 7))) & 1;
}

// Precompute the empty-subtree hash at each depth.
function computeEmptyNodes() {
  const nodes = new Array(SMT_DEPTH + 1);
  nodes[SMT_DEPTH] = EMPTY_LEAF;
  for (let d = SMT_DEPTH - 1; d >= 0; d--) {
    nodes[d] = sha256(concatBytes(nodes[d + 1], nodes[d + 1]));
  }
  return nodes;
}
const EMPTY_NODES = computeEmptyNodes();

// Open-intent Sparse Merkle Tree (SMT).
//
// Depth = 256 (each leaf is at a unique intent_id position). Storage is
// sparse — only non-empty leaves materialized in a Map; empty subtrees use
// precomputed EMPTY_NODES.
//
// Methods:
//   insert(intentId, intentMsgHash)  — insert/update a leaf
//   remove(intentId)                 — remove (used on cancel)
//   has(intentId)                    — check presence
//   getRoot()                        — compute current root (Uint8Array(32))
//   getProof(intentId)               — Merkle inclusion proof (256 siblings)
//   size                             — number of non-empty leaves
//
// verifySMTProof(...) — static module function below.
export class OpenIntentSMT {
  constructor() {
    this.leaves = new Map();                               // hex(intent_id) → intent_msg_hash bytes
    this._rootCache = null;
  }

  _invalidate() { this._rootCache = null; }

  insert(intentId, intentMsgHash) {
    const id = intentId instanceof Uint8Array ? intentId : hexToBytes(intentId);
    if (id.length !== 32) throw new Error('intentId must be 32 bytes');
    const msgHash = intentMsgHash instanceof Uint8Array ? intentMsgHash : hexToBytes(intentMsgHash);
    if (msgHash.length !== 32) throw new Error('intentMsgHash must be 32 bytes');
    this.leaves.set(bytesToHex(id), new Uint8Array(msgHash));
    this._invalidate();
  }

  remove(intentId) {
    const id = intentId instanceof Uint8Array ? intentId : hexToBytes(intentId);
    this.leaves.delete(bytesToHex(id));
    this._invalidate();
  }

  has(intentId) {
    const id = intentId instanceof Uint8Array ? intentId : hexToBytes(intentId);
    return this.leaves.has(bytesToHex(id));
  }

  get size() { return this.leaves.size; }

  // Materialize the keys array once per computation to avoid hex re-conversion.
  _keysBytes() {
    return [...this.leaves.entries()].map(([k, v]) => ({ keyBytes: hexToBytes(k), value: v }));
  }

  // Recursive node computation: at depth d with the path so far described by
  // the `match` filter (an array of {keyBytes, value} that fall under the
  // current prefix), aggregate left + right subtree roots.
  _nodeAt(match, depth) {
    if (depth === SMT_DEPTH) {
      // At leaf depth, `match` should have at most one entry (full key).
      if (match.length === 0) return EMPTY_LEAF;
      // The leaf hash IS the intent_msg_hash (canonical SMT leaf form).
      return match[0].value;
    }
    if (match.length === 0) return EMPTY_NODES[depth];
    // Partition `match` by bit at `depth`.
    const left = [], right = [];
    for (const entry of match) {
      if (bitAt(entry.keyBytes, depth) === 0) left.push(entry);
      else right.push(entry);
    }
    const leftHash  = this._nodeAt(left,  depth + 1);
    const rightHash = this._nodeAt(right, depth + 1);
    return sha256(concatBytes(leftHash, rightHash));
  }

  getRoot() {
    if (this._rootCache) return this._rootCache;
    this._rootCache = this._nodeAt(this._keysBytes(), 0);
    return this._rootCache;
  }

  // Inclusion proof: 256 sibling hashes ordered from depth 0 (top) to depth 255 (leaf-adjacent).
  getProof(intentId) {
    const id = intentId instanceof Uint8Array ? intentId : hexToBytes(intentId);
    if (id.length !== 32) throw new Error('intentId must be 32 bytes');
    const all = this._keysBytes();
    const path = new Array(SMT_DEPTH);
    let current = all;
    for (let depth = 0; depth < SMT_DEPTH; depth++) {
      const left = [], right = [];
      for (const entry of current) {
        if (bitAt(entry.keyBytes, depth) === 0) left.push(entry);
        else right.push(entry);
      }
      const targetBit = bitAt(id, depth);
      // The sibling at this depth is the subtree of the OPPOSITE branch from `id`.
      const sibling = targetBit === 0
        ? this._nodeAt(right, depth + 1)
        : this._nodeAt(left,  depth + 1);
      path[depth] = sibling;
      // Continue with the branch containing `id`.
      current = targetBit === 0 ? left : right;
    }
    return path;
  }
}

// Static proof verifier.
//
// Walk from leaf up to root: starting with `leaf = intent_msg_hash`, at each
// depth (256 → 1), take the sibling from proof[depth-1], and hash with
// position dictated by `bitAt(intentId, depth-1)`.
//
// (Proof index `i` corresponds to `depth = i+1`'s sibling — i.e., the sibling
//  at the level just above leaf is `proof[255]`, the sibling at the level
//  just below root is `proof[0]`.)
export function verifySMTProof({ intentId, intentMsgHash, proof, root }) {
  const id = intentId instanceof Uint8Array ? intentId : hexToBytes(intentId);
  if (id.length !== 32) return false;
  const leaf = intentMsgHash instanceof Uint8Array ? intentMsgHash : hexToBytes(intentMsgHash);
  if (leaf.length !== 32) return false;
  if (!Array.isArray(proof) || proof.length !== SMT_DEPTH) return false;
  let node = leaf;
  for (let depth = SMT_DEPTH - 1; depth >= 0; depth--) {
    const sibling = proof[depth];
    if (!(sibling instanceof Uint8Array) || sibling.length !== 32) return false;
    const branch = bitAt(id, depth);
    node = (branch === 0)
      ? sha256(concatBytes(node, sibling))
      : sha256(concatBytes(sibling, node));
  }
  const rootBytes = root instanceof Uint8Array ? root : hexToBytes(root);
  if (rootBytes.length !== 32) return false;
  for (let i = 0; i < 32; i++) if (node[i] !== rootBytes[i]) return false;
  return true;
}

// =========================================================================
// T_AMM_ATTEST envelope codec
// =========================================================================

function u16LE(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff, true); return b; }
function u32LE(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function u64LE(n) {
  const b = new Uint8Array(8);
  let x = BigInt(n);
  if (x < 0n || x >= 1n << 64n) throw new Error('u64 overflow');
  for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
function readU16LE(b, o) { return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(o, true); }
function readU32LE(b, o) { return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true); }
function readU64LE(b, o) {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(b[o + i]);
  return n;
}
function asBytes(x, len, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes (got ${b.length})`);
  return b;
}

// Build the canonical pre-sig payload bytes (everything BEFORE worker_sig).
export function buildAttestPreSig({
  scopeId, poolId,
  intentPoolHash, root,            // `root` accepted as legacy alias
  height, timestamp, intentCount,
  snapshotUri, ipfsCid,            // `ipfsCid` accepted as legacy alias
  workerPubkey,
}) {
  const scope = scopeId ?? poolId;
  if (scope == null) throw new Error('scopeId (or poolId alias) is required');
  const sid = asBytes(scope, 32, 'scopeId');
  const iph = asBytes(intentPoolHash ?? root, 32, 'intentPoolHash');
  const wpk = asBytes(workerPubkey, 33, 'workerPubkey');
  // snapshot_uri is informational; spec range is 0..255 bytes UTF-8.
  const uri = snapshotUri ?? ipfsCid ?? '';
  const uriBytes = new TextEncoder().encode(uri);
  if (uriBytes.length > 255) throw new Error('snapshot_uri length must be 0..255 bytes');
  return concatBytes(
    new Uint8Array([OPCODE_T_INTENT_ATTEST]),
    sid, iph,
    u32LE(height),
    u64LE(timestamp),
    u16LE(intentCount),
    new Uint8Array([uriBytes.length]), uriBytes,
    wpk,
  );
}

// Worker-side: sign the attestation under workerPrivkey.
export function signAttestation({
  scopeId, poolId, intentPoolHash, root,
  height, timestamp, intentCount,
  snapshotUri, ipfsCid,
  workerPrivkey,
}) {
  const wpk = secp.ProjectivePoint.fromPrivateKey(workerPrivkey).toRawBytes(true);
  const preSig = buildAttestPreSig({
    scopeId: scopeId ?? poolId,
    intentPoolHash: intentPoolHash ?? root,
    height, timestamp, intentCount,
    snapshotUri: snapshotUri ?? ipfsCid,
    workerPubkey: wpk,
  });
  const msgHash = sha256(concatBytes(ATTEST_DOMAIN, preSig));
  return signSchnorr(msgHash, workerPrivkey);
}

// Encode full envelope payload (pre-sig bytes + sig).
export function encodeAttest(args) {
  const wpk = args.workerPubkey || (args.workerPrivkey
    ? secp.ProjectivePoint.fromPrivateKey(args.workerPrivkey).toRawBytes(true)
    : null);
  if (!wpk) throw new Error('encodeAttest: workerPubkey or workerPrivkey required');
  const preSig = buildAttestPreSig({ ...args, workerPubkey: wpk });
  const sig = args.workerSig
    ? asBytes(args.workerSig, 64, 'workerSig')
    : signAttestation({ ...args });
  return concatBytes(preSig, sig);
}

// Decode envelope payload to fields.
export function decodeAttest(payload) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  if (payload.length < 1 + 32 + 32 + 4 + 8 + 2 + 1 + 33 + 64) throw new Error('truncated');
  let off = 0;
  if (payload[off++] !== OPCODE_T_INTENT_ATTEST) throw new Error(`expected opcode 0x${OPCODE_T_INTENT_ATTEST.toString(16)}`);
  const scopeId = payload.slice(off, off + 32); off += 32;
  const intentPoolHash = payload.slice(off, off + 32); off += 32;
  const height = readU32LE(payload, off); off += 4;
  const timestamp = readU64LE(payload, off); off += 8;
  const intentCount = readU16LE(payload, off); off += 2;
  const uriLen = payload[off++];
  // snapshot_uri_len: 0..255 per spec; 0 = no URI (informational field only).
  if (off + uriLen + 33 + 64 > payload.length) throw new Error('truncated: snapshot_uri/pubkey/sig');
  const snapshotUri = new TextDecoder('utf-8').decode(payload.slice(off, off + uriLen)); off += uriLen;
  const workerPubkey = payload.slice(off, off + 33); off += 33;
  const workerSig = payload.slice(off, off + 64); off += 64;
  if (off !== payload.length) throw new Error('trailing bytes after payload');
  // Return canonical names + legacy aliases (`root`, `ipfsCid`, `poolId`)
  // for backward-compatible field access.
  return {
    scopeId, poolId: scopeId,
    intentPoolHash, root: intentPoolHash,
    height, timestamp, intentCount,
    snapshotUri, ipfsCid: snapshotUri,
    workerPubkey, workerSig,
  };
}

// Verify a decoded attestation's worker_sig.
export function verifyAttestSig(decoded) {
  const preSig = buildAttestPreSig(decoded);
  const msgHash = sha256(concatBytes(ATTEST_DOMAIN, preSig));
  return verifySchnorr(decoded.workerSig, msgHash, decoded.workerPubkey.subarray(1));  // x-only
}

// =========================================================================
// IPFS pinning blob (worker side)
// =========================================================================
//
// Worker pins a JCS-canonical JSON blob containing the open-intent leaves.
// Anyone can re-pin (content-addressed). The on-chain T_INTENT_ATTEST commits
// the intent_pool_hash and the snapshot_uri so the worker can't equivocate.

export function buildPinningBlob({ scopeId, poolId, intentPoolHash, root, height, timestamp, intentMap }) {
  const scope = scopeId ?? poolId;
  const iph = intentPoolHash ?? root;
  // intentMap: Map<intent_id_hex, intent_msg_hash_hex> or { intent_id_hex: hash_hex }
  const entries = intentMap instanceof Map
    ? [...intentMap.entries()]
    : Object.entries(intentMap);
  // Sort by intent_id_hex ascending for canonical ordering.
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return canonicalize({
    tacit_intent_attest: {
      scope_id: typeof scope === 'string' ? scope : bytesToHex(scope),
      intent_pool_hash: typeof iph === 'string' ? iph : bytesToHex(iph),
      height,
      timestamp: typeof timestamp === 'bigint' ? Number(timestamp) : timestamp,
      leaves: entries.map(([id, hash]) => ({
        intent_id: id,
        intent_msg_hash: typeof hash === 'string' ? hash : bytesToHex(hash),
      })),
    },
  });
}

// =========================================================================
// Indexer branch: validateAmmAttest
// =========================================================================
//
// State the indexer tracks:
//   attestationChain: Map<`${poolId_hex}:${workerPubkey_hex}:${height}`, decoded>
//   equivocationFlags: Set<workerPubkey_hex>
//
// Validation rules (per decoded envelope):
//   1. Wire format well-formed (decodeAttest succeeded)
//   2. worker_sig verifies (verifyAttestSig)
//   3. envelope_height >= decoded.height (worker can't claim future state)
//   4. If an existing attestation exists at the same (scopeId, workerPubkey, height)
//      with a DIFFERENT root → equivocation flag the worker, reject this envelope
//   5. Otherwise: accept; record canonical attestation

export function validateAmmAttest({
  payload, envelopeHeight, indexerState,
}) {
  let env;
  try { env = decodeAttest(payload); }
  catch (e) { return { valid: false, reason: `decode error: ${e.message}` }; }

  if (!verifyAttestSig(env)) return { valid: false, reason: 'worker_sig verification failed' };

  if (env.height > envelopeHeight) {
    return { valid: false, reason: `claimed height ${env.height} > envelope height ${envelopeHeight}` };
  }

  const key = `${bytesToHex(env.scopeId)}:${bytesToHex(env.workerPubkey)}:${env.height}`;
  const existing = indexerState.attestationChain.get(key);
  if (existing) {
    // Same (worker, pool, height) seen before. Check root match.
    if (bytesToHex(existing.root) !== bytesToHex(env.root)) {
      // EQUIVOCATION
      indexerState.equivocationFlags.add(bytesToHex(env.workerPubkey));
      return {
        valid: false,
        reason: `equivocation detected: worker ${bytesToHex(env.workerPubkey).slice(0, 16)}... signed two roots at height ${env.height}`,
        equivocation: true,
        workerFlagged: env.workerPubkey,
      };
    }
    // Same root, duplicate broadcast — accept idempotently.
    return { valid: true, idempotent: true, decoded: env };
  }

  // First attestation at this (pool, worker, height).
  indexerState.attestationChain.set(key, env);
  return { valid: true, decoded: env };
}

// Initialize empty indexer state.
export function newIndexerAttestState() {
  return {
    attestationChain: new Map(),
    equivocationFlags: new Set(),
  };
}

// =========================================================================
// Soft-confirm verification (trader side)
// =========================================================================
//
// Given a worker-supplied soft-confirm bundle, verify:
//   (a) The Merkle proof reconstructs the worker's claimed root
//   (b) The worker's signature is valid under workerPubkey
//   (c) Timestamp is not too stale (TTL check)
//   (d) Trusted-worker pubkey list (caller-supplied) includes this worker
//   (e) Worker is not already flagged for equivocation (caller-supplied set)
//
// Returns { ok: bool, reason?: string, status: 'soft_confirmed' | 'stale' | 'forged' | 'equivocator' | 'untrusted_worker' }

export function verifySoftConfirm({
  intentId, intentMsgHash, merkleProof,
  scopeId, poolId,                                         // poolId accepted as alias
  intentPoolHash, root,                                    // root accepted as alias
  height, timestamp, intentCount,
  snapshotUri, ipfsCid,                                    // ipfsCid accepted as alias
  workerPubkey, workerSig,
  trustedWorkers,                                         // Set<workerPubkey_hex>
  equivocators,                                            // Set<workerPubkey_hex>
  ttlSeconds = 300,                                        // default 5 min
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const wpkHex = bytesToHex(workerPubkey instanceof Uint8Array ? workerPubkey : hexToBytes(workerPubkey));
  const scope = scopeId ?? poolId;
  const iph = intentPoolHash ?? root;
  const uri = snapshotUri ?? ipfsCid ?? '';

  if (equivocators && equivocators.has(wpkHex)) {
    return { ok: false, status: 'equivocator', reason: 'worker is flagged for equivocation' };
  }
  if (trustedWorkers && !trustedWorkers.has(wpkHex)) {
    return { ok: false, status: 'untrusted_worker', reason: 'worker not in trusted set' };
  }

  // Timestamp freshness.
  const ts = typeof timestamp === 'bigint' ? Number(timestamp) : timestamp;
  if (nowSeconds - ts > ttlSeconds) {
    return { ok: false, status: 'stale', reason: `attestation older than TTL (${nowSeconds - ts}s > ${ttlSeconds}s)` };
  }

  // Worker signature.
  const decoded = {
    scopeId: scope instanceof Uint8Array ? scope : hexToBytes(scope),
    intentPoolHash: iph instanceof Uint8Array ? iph : hexToBytes(iph),
    height, timestamp: ts, intentCount,
    snapshotUri: uri,
    workerPubkey: workerPubkey instanceof Uint8Array ? workerPubkey : hexToBytes(workerPubkey),
    workerSig: workerSig instanceof Uint8Array ? workerSig : hexToBytes(workerSig),
  };
  if (!verifyAttestSig(decoded)) {
    return { ok: false, status: 'forged', reason: 'worker signature does not verify' };
  }

  // Merkle proof — verified against the SMT root the worker supplied
  // off-chain (as part of the soft-confirm bundle), NOT against the on-chain
  // intent_pool_hash. The on-chain commitment is a flat SHA256 over sorted
  // intent_ids (see computeIntentPoolHash); the SMT is an off-chain helper
  // for efficient membership proofs and its root is a separate quantity.
  if (merkleProof !== undefined && merkleProof !== null) {
    const smtRoot = merkleProof.smtRoot ?? decoded.intentPoolHash;
    const proofPath = Array.isArray(merkleProof) ? merkleProof : merkleProof.path;
    if (!verifySMTProof({ intentId, intentMsgHash, proof: proofPath, root: smtRoot })) {
      return { ok: false, status: 'forged', reason: 'Merkle proof does not reconstruct root' };
    }
  }

  return { ok: true, status: 'soft_confirmed' };
}
