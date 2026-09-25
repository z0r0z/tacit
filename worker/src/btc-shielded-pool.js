// Bitcoin-native shielded pool — Phase 3 indexer wiring (NEW, INERT module).
//
// Implements DESIGN-btc-shielded-pool.md's T_BTC_SHIELD (0x6C) / T_BTC_SPEND (0x6D): canonical envelope
// parsing, leaf/nullifier derivation, a Bitcoin-only Merkle tree + nullifier set maintained purely by
// replaying accepted envelopes, and the §10 acceptance-order state machine. Mirrors
// contracts/sp1/confidential/cxfer-core/src/btc_pool.rs field-for-field — see that file (ground truth) and
// DESIGN-btc-shielded-pool-security.md (the formal goals this acceptance order is required to uphold).
//
// NOT WIRED IN. This module is not imported by worker/src/index.js and nothing in the worker's request
// handlers, cron scan, or startup path references it. The fourth SP1 guest now has a real, pinned
// verifying key (contracts/sp1/confidential/elf-vkey-pin.json:btc_pool_vkey, ELF built and committed) and
// a real off-chain verifier (worker-relay/src/lib/btc-pool-verify.js — a free `eth_call` against the live,
// immutable SP1 Groth16 verifier every settle/reflection proof already trusts; this pool has no EVM
// contract of its own to call it from). `verifyBtcPoolSpendProof` below is still a deliberate stub that
// always fails closed: `acceptBtcSpendEnvelope`'s `verifyProof` option is how a caller supplies the real
// implementation, and this plain `worker` module (no EVM deps by design) is not that caller. Wiring this
// in for real still needs: (1) hook `parseBtcPoolEnvelope`/`BtcShieldedPoolState` into the same per-block
// replay loop `worker/src/index.js` already runs for every other opcode, in the same canonical
// transaction-index order (§10), passing `verifyProof: verifyBtcPoolSpendProof` from
// worker-relay/src/lib/btc-pool-verify.js at the call site, (2) claim 0x6C/0x6D in SPEC.md's opcode table
// per its own stated procedure (SPEC §3.9) — deliberately not done here (see DESIGN doc "Fit with the
// rest of Tacit V1"; out of scope for this phase).
//
// Crypto: @noble/secp256k1 + @noble/hashes, the same libraries worker/src/index.js itself imports (not
// dependency-injected — this module is worker-side, unlike the dapp's DI'd confidential-pool.js).

import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

export const T_BTC_SHIELD = 0x6c;
export const T_BTC_SPEND = 0x6d;

export const BTC_POOL_OUT_PAY = 0x00;
export const BTC_POOL_OUT_EXIT = 0x01;
export const BTC_POOL_MAX_IN = 2;
export const BTC_POOL_MAX_OUT = 2;

// Anchor window (design §10): W blocks of retained roots, Kmin the shallowest depth already defined when
// the anchor block is replayed.
export const BTC_POOL_ANCHOR_WINDOW = 144;
export const BTC_POOL_ANCHOR_KMIN = 1;

export const TREE_DEPTH = 32;

const BTC_POOL_NOTE_DOMAIN = new TextEncoder().encode('tacit-btc-pool-note-v1');
const BTC_POOL_NF_DOMAIN = new TextEncoder().encode('tacit-btc-pool-nf-v1');

// ── byte helpers (mirror the style already used throughout worker/src/index.js and dapp/*.js) ──
const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hx = (b) => '0x' + bytesToHex(b);
const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
const keccak256 = (b) => keccak_256(b);
const kn = (parts) => keccak256(concat(parts));

function u32le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] * 0x1000000)) >>> 0;
}
function u32beBytes(v) {
  const x = Number(v) >>> 0;
  return Uint8Array.of((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
}

// ── leaf / nullifier (design §2, cxfer-core btc_pool.rs — byte-exact mirror) ──

// leaf = keccak(asset ‖ Cx ‖ Cy ‖ spend_key ‖ "tacit-btc-pool-note-v1")
export function btcPoolNoteLeaf(assetHex, cxHex, cyHex, spendKeyHex) {
  return hx(kn([hexToBytes(assetHex), hexToBytes(cxHex), hexToBytes(cyHex), hexToBytes(spendKeyHex), BTC_POOL_NOTE_DOMAIN]));
}

// nf_secret = keccak("tacit-btc-pool-nf-v1" ‖ sk_note) — indexer-side callers never have sk_note; this
// exists only for tests/fixtures that need to derive a nullifier the way a spending wallet would.
export function btcPoolNfSecret(skNoteHex) {
  return hx(kn([BTC_POOL_NF_DOMAIN, hexToBytes(skNoteHex)]));
}

// nullifier = keccak(leaf ‖ nf_secret ‖ "spent")
export function btcPoolNullifier(leafHex, nfSecretHex) {
  return hx(kn([hexToBytes(leafHex), hexToBytes(nfSecretHex), new TextEncoder().encode('spent')]));
}

// ── canonical_body / h_body (design §4 — the exact bytes the guest commits over; big-endian internal
// integers, matching T_CXFER's own kernel-message split of big-endian txid / little-endian vout). The
// indexer does not need this to accept an envelope (design §4: "the indexer... does not need to
// separately recompute h_body"), but the wallet needs it to build the witness and it is useful for tests
// asserting field coverage, so it is exported here too.
export function btcPoolCanonicalBody({ asset, nullifiers, outKind, outputs, exitVout, destSpkHash, hAnchor }) {
  const parts = [Uint8Array.of(T_BTC_SPEND), hexToBytes(asset), Uint8Array.of(nullifiers.length)];
  for (const nf of nullifiers) parts.push(hexToBytes(nf));
  parts.push(Uint8Array.of(outKind));
  if (outKind === BTC_POOL_OUT_PAY) {
    parts.push(Uint8Array.of(outputs.length));
    for (const o of outputs) {
      parts.push(hexToBytes(o.cx), hexToBytes(o.cy), hexToBytes(o.pkEph), hexToBytes(o.spendKey), hexToBytes(o.ctNote));
    }
  } else {
    parts.push(u32beBytes(exitVout || 0), hexToBytes(destSpkHash || '0x' + '00'.repeat(32)));
  }
  parts.push(u32beBytes(hAnchor));
  return concat(parts);
}
export function btcPoolHBody(fields) {
  return hx(keccak256(btcPoolCanonicalBody(fields)));
}

// ── canonical envelope parsing (design §3, §10 step 1: fixed widths, counts match, no trailing bytes) ──
//
// T_BTC_SHIELD (0x6C), fixed length: 0x6C ‖ asset(32) ‖ lock_vout(4 LE) ‖ Cx(32) ‖ Cy(32) ‖ pk_eph(32) ‖
// spend_key(32) ‖ opening_proof(64) = 1+32+4+32+32+32+32+64 = 229 bytes exact (no count fields — single
// note per shield envelope).
export const T_BTC_SHIELD_LEN = 229;
export function parseBtcShieldEnvelope(envBytesOrHex) {
  const e = typeof envBytesOrHex === 'string' ? hexToBytes(envBytesOrHex) : envBytesOrHex;
  if (!e || e.length !== T_BTC_SHIELD_LEN || e[0] !== T_BTC_SHIELD) return null;
  let p = 1;
  const asset = hx(e.slice(p, p + 32)); p += 32;
  const lockVout = u32le(e, p); p += 4;
  const cx = hx(e.slice(p, p + 32)); p += 32;
  const cy = hx(e.slice(p, p + 32)); p += 32;
  const pkEph = hx(e.slice(p, p + 32)); p += 32;
  const spendKey = hx(e.slice(p, p + 32)); p += 32;
  const openingProof = hx(e.slice(p, p + 64)); p += 64;
  if (p !== e.length) return null; // no trailing bytes (§10 step 1)
  return { type: 'btc_shield', opcode: T_BTC_SHIELD, asset, lockVout, cx, cy, pkEph, spendKey, openingProof };
}

// T_BTC_SPEND (0x6D), variable length per out_kind (design §3):
//   0x6D ‖ asset(32) ‖ n_in(1) ‖ nf[32×n_in] ‖ out_kind(1)
//     pay  (0x00): n_out(1) ‖ (Cx‖Cy‖pk_eph‖spend_key‖ct_note(56)) × n_out
//     exit (0x01): exit_vout(4 LE) ‖ exit_value(8 LE) ‖ dest_spk_hash(32)
//   ‖ h_anchor(4 LE) ‖ proof
//
// `proof`'s byte width is not yet fixed (design §"Still open" — pinned once the guest is compiled, Phase
// 2). This parser therefore takes the trailing bytes after h_anchor as `proof` verbatim and defers
// asserting an exact width to whoever wires in the real guest; every fixed-width field before it is
// still validated exactly, so a malformed header/count is still rejected here.
export function parseBtcSpendEnvelope(envBytesOrHex) {
  const e = typeof envBytesOrHex === 'string' ? hexToBytes(envBytesOrHex) : envBytesOrHex;
  if (!e || e.length < 1 || e[0] !== T_BTC_SPEND) return null;
  let p = 1;
  if (e.length < p + 32 + 1) return null;
  const asset = hx(e.slice(p, p + 32)); p += 32;
  const nIn = e[p]; p += 1;
  if (nIn < 1 || nIn > BTC_POOL_MAX_IN) return null;
  if (e.length < p + nIn * 32 + 1) return null;
  const nullifiers = [];
  for (let i = 0; i < nIn; i++) { nullifiers.push(hx(e.slice(p, p + 32))); p += 32; }
  const outKind = e[p]; p += 1;
  if (outKind !== BTC_POOL_OUT_PAY && outKind !== BTC_POOL_OUT_EXIT) return null;

  let outputs = [], exitVout = null, exitValue = null, destSpkHash = null;
  if (outKind === BTC_POOL_OUT_PAY) {
    if (e.length < p + 1) return null;
    const nOut = e[p]; p += 1;
    if (nOut < 1 || nOut > BTC_POOL_MAX_OUT) return null;
    const OUT_W = 32 + 32 + 32 + 32 + 56; // Cx,Cy,pk_eph,spend_key,ct_note
    if (e.length < p + nOut * OUT_W) return null;
    for (let i = 0; i < nOut; i++) {
      const cx = hx(e.slice(p, p + 32)); p += 32;
      const cy = hx(e.slice(p, p + 32)); p += 32;
      const pkEph = hx(e.slice(p, p + 32)); p += 32;
      const spendKey = hx(e.slice(p, p + 32)); p += 32;
      const ctNote = hx(e.slice(p, p + 56)); p += 56;
      outputs.push({ cx, cy, pkEph, spendKey, ctNote });
    }
  } else {
    if (e.length < p + 4 + 8 + 32) return null;
    exitVout = u32le(e, p); p += 4;
    let v = 0n; for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(e[p + j]); p += 8;
    exitValue = v;
    destSpkHash = hx(e.slice(p, p + 32)); p += 32;
  }
  if (e.length < p + 4) return null;
  const hAnchor = u32le(e, p); p += 4;
  const proof = hx(e.slice(p));
  if (nullifiers.length !== new Set(nullifiers.map((x) => x.toLowerCase())).size) return null; // pairwise distinct within envelope (§10 step 3)

  return {
    type: 'btc_spend', opcode: T_BTC_SPEND, asset, nIn, nullifiers, outKind,
    outputs, exitVout, exitValue: exitValue == null ? null : exitValue.toString(), destSpkHash, hAnchor, proof,
  };
}

export function parseBtcPoolEnvelope(envBytesOrHex) {
  const e = typeof envBytesOrHex === 'string' ? hexToBytes(envBytesOrHex) : envBytesOrHex;
  if (!e || e.length === 0) return null;
  if (e[0] === T_BTC_SHIELD) return parseBtcShieldEnvelope(e);
  if (e[0] === T_BTC_SPEND) return parseBtcSpendEnvelope(e);
  return null;
}

// ── Schnorr NIZK opening proof (T_BTC_SHIELD's `opening_proof`, design §3/§10 step 2) ──
//
// GENUINE GAP, flagged explicitly rather than silently assumed: the design doc says this reuses "the same
// Schnorr NIZK from T_BTC_WRAP" (DESIGN-btc-only-wrap.md, 0x6A/0x6B), but T_BTC_WRAP has no implementation
// anywhere in this repo yet (grepped dapp/*.js and worker/src/*.js — no T_BTC_WRAP/T_BTC_UNWRAP constants,
// no builder, no parser). There is therefore no existing NIZK to reuse byte-for-byte. What follows is a
// concrete, self-contained construction that satisfies the design's requirement ("binding C to the lock's
// public value") using the same sigma-protocol shape as everything else in this codebase's Bitcoin lane
// (BIP-340-style x-only point encoding, Fiat-Shamir via keccak) — but it has NOT been cross-checked against
// whatever T_BTC_WRAP eventually ships, and needs its own review before anything relies on it. If/when
// T_BTC_WRAP lands with its own opening-proof format, this should be reconciled with it, not left to
// silently diverge.
//
// Relation proved: knowledge of r such that C - v·H = r·G, for public commitment C=(Cx,Cy), public value
// v (the lock output's sats), and the module's fixed generator H (Pedersen `H` — see verifyPedersenOpening
// convention in cxfer-core: C = v·H + r·G). Standard Schnorr sigma protocol, Fiat-Shamir non-interactive:
//   k random, R = k·G, canonicalized to even y (negate k if R's y is odd — same x-only-encoding
//     requirement as sk_note's even-y canonicalization elsewhere in this design; R is only ever carried
//     as its x-coordinate below, so an odd-y R could never be reconstructed by the verifier)
//   e = keccak(dom ‖ Cx ‖ Cy ‖ v_be8 ‖ Rx) mod n         (R's x-only, even-y canonical form, BIP-340 style)
//   s = k + e·r  (mod n)
//   opening_proof = Rx(32) ‖ s(32)                        — 64 bytes, matching design §3's fixed width
// Verifier recomputes e from the public C, v, and the proof's Rx (assuming R has even y, same
// canonicalization the pool's own spend_key already requires — see cxfer-core btc_pool.rs), then checks
// s·G == R + e·(C - v·H).
const OPENING_PROOF_DOMAIN = new TextEncoder().encode('tacit-btc-pool-opening-v1');

// Pedersen H (NUMS point) — MUST match whatever generator cxfer-core's verify_pedersen_opening uses.
// Genuinely unresolved here: this module has no access to the Rust crate's exact H constant, and hardcoding
// a placeholder would be worse than leaving the gap explicit. `verifyBtcShieldOpeningProof` below therefore
// takes H as a required parameter rather than a baked-in constant, so a caller (or a future patch, once the
// real H is threaded through from cxfer-core) supplies the real value instead of this module silently using
// a wrong one.
export function verifyBtcShieldOpeningProof({ cxHex, cyHex, valueSats, openingProofHex, hPointHex }) {
  if (!hPointHex) throw new Error('btc-shielded-pool: verifyBtcShieldOpeningProof requires the real Pedersen H point (not baked in here — see comment above)');
  const proof = hexToBytes(openingProofHex);
  if (proof.length !== 64) return false;
  const rX = proof.slice(0, 32);
  const s = proof.slice(32, 64);
  const n = secp.CURVE.n;
  const sScalar = BigInt('0x' + bytesToHex(s)) % n;

  let C, H;
  try {
    H = secp.ProjectivePoint.fromHex(hPointHex.replace(/^0x/, ''));
  } catch { return false; }
  try {
    const cxBig = BigInt(cxHex), cyBig = BigInt(cyHex);
    C = new secp.ProjectivePoint(cxBig, cyBig, 1n);
    C.assertValidity();
  } catch { return false; }

  const vBe8 = (() => { const b = new Uint8Array(8); let v = BigInt(valueSats); for (let i = 7; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; })();
  const e = BigInt('0x' + bytesToHex(kn([OPENING_PROOF_DOMAIN, hexToBytes(cxHex), hexToBytes(cyHex), vBe8, rX]))) % n;

  let R;
  try { R = secp.ProjectivePoint.fromHex('02' + bytesToHex(rX)); } catch { return false; }

  if (sScalar === 0n) return false;
  const CminusVH = BigInt(valueSats) === 0n ? C : C.add(H.multiply(BigInt(valueSats)).negate());
  const lhs = secp.ProjectivePoint.BASE.multiply(sScalar);
  if (e === 0n) return lhs.equals(R);
  const rhs = R.add(CminusVH.multiply(e));
  return lhs.equals(rhs);
}

// ── Bitcoin-only Merkle tree (mirrors dapp/confidential-pool.js's `Tree`/`merkleRootFrom`, keccak
// incremental tree, zero-filled subtrees) — a fresh instance, disjoint from every other tree this codebase
// already maintains (design §2 domain separation; genuinely new state, design doc §8). ──
const ZERO32 = new Uint8Array(32);
const zeros = (() => {
  const z = [ZERO32];
  for (let i = 1; i < TREE_DEPTH; i++) z.push(keccak256(concat([z[i - 1], z[i - 1]])));
  return z;
})();

export class BtcPoolTree {
  constructor() { this.leaves = []; }
  insert(leafHex) { this.leaves.push(hexToBytes(leafHex)); return this.leaves.length - 1; }
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
  root() { return this.rootAndPath(0).root; } // rootAndPath already zero-fills correctly for an empty tree
  nextIndex() { return this.leaves.length; }
}

export function btcPoolMerkleRootFrom(leafHex, index, path) {
  let h = hexToBytes(leafHex);
  for (let i = 0; i < TREE_DEPTH; i++) {
    const sib = hexToBytes(path[i]);
    h = ((index >>> i) & 1) ? keccak256(concat([sib, h])) : keccak256(concat([h, sib]));
  }
  return hx(h);
}

// ── SP1/Groth16 proof verification stub (design §4/§12 step 2) ──
//
// EXPLICIT GAP, not papered over: there is no fourth SP1 guest built, no ELF hash pinned, and no
// Groth16 verifying key for this relation anywhere in this repo (Phase 2 of DESIGN-btc-shielded-pool.md
// §12 has not run). This function is the one place that gap is allowed to live — it is structured exactly
// like a real verifier would be called (proof bytes + the public statement fields the guest would commit,
// `BtcPoolSpendValues` per contracts/sp1/confidential/src/btc_pool.rs), but its body cannot do anything
// real yet. It always returns false (fails closed) rather than returning true or throwing an opaque error,
// so a caller that forgets to check the return value still rejects the envelope instead of accepting an
// unverified spend.
//
// The real implementation now exists (worker-relay/src/lib/btc-pool-verify.js:verifyBtcPoolSpendProof) —
// this stub remains the DEFAULT for `acceptBtcSpendEnvelope`'s injectable `verifyProof` option, since this
// plain `worker` module has no EVM/network access by design. Same (statement, proofHex) argument order as
// the real implementation, so swapping one for the other at a call site is a drop-in — never returns true.
export async function verifyBtcPoolSpendProof(_publicStatement, _proofHex) {
  return false; // STUB — this module never verifies for real. See comment above.
}

// ── §10 acceptance-order state machine ──
//
// `chainCtx` is the per-transaction real chain data the indexer already has available while replaying a
// block (mirrors the shape worker/src/index.js's own per-tx decode loop already carries for other ops):
//   { txOutputs: [{ valueSats: bigint, scriptPubKeyHash: '0x...' }, ...] }  — this transaction's own outputs
export function makeBtcShieldedPoolState() {
  return {
    tree: new BtcPoolTree(),
    nullifierSet: new Set(), // hex nullifier -> present means spent
    // Retained root history, keyed by the Bitcoin block height at which that root became the tree's root
    // (design §10 step 6: "record the block-level root" after the whole block is replayed). Anchor-window
    // lookups (§10 step 4) read from this map, never from `tree.root()` directly, so a spend's `h_anchor`
    // is checked against the root AS OF that height, not the indexer's live tip.
    rootsByHeight: new Map(),
  };
}

export function acceptBtcShieldEnvelope(state, parsedShield, { chainCtx, hPointHex } = {}) {
  if (!parsedShield || parsedShield.type !== 'btc_shield') return { accepted: false, reason: 'not a shield envelope' };
  const outputs = chainCtx && chainCtx.txOutputs;
  if (!outputs || parsedShield.lockVout >= outputs.length) {
    return { accepted: false, reason: 'lock_vout not a real output of this transaction' };
  }
  const lockOutput = outputs[parsedShield.lockVout];
  if (!lockOutput) return { accepted: false, reason: 'lock_vout not a real output of this transaction' };

  // §10 step 2: opening_proof verifies C against that output's real value.
  let openingOk = false;
  try {
    openingOk = verifyBtcShieldOpeningProof({
      cxHex: parsedShield.cx, cyHex: parsedShield.cy, valueSats: lockOutput.valueSats,
      openingProofHex: parsedShield.openingProof, hPointHex,
    });
  } catch (_e) { openingOk = false; }
  if (!openingOk) return { accepted: false, reason: 'opening_proof does not verify against the lock output value' };

  // Only now: append the new leaf (§10 step 6). Nothing above mutated `state`.
  const leaf = btcPoolNoteLeaf(parsedShield.asset, parsedShield.cx, parsedShield.cy, parsedShield.spendKey);
  const index = state.tree.insert(leaf);
  return { accepted: true, leaf, leafIndex: index };
}

export async function acceptBtcSpendEnvelope(state, parsedSpend, { chainCtx, verifyProof = verifyBtcPoolSpendProof } = {}) {
  if (!parsedSpend || parsedSpend.type !== 'btc_spend') return { accepted: false, reason: 'not a spend envelope' };

  // §10 step 2a (exit only): exit_vout names a real output of this transaction, and its real value/script
  // must match exit_value/dest_spk_hash exactly. Both halves load-bearing (design §3/§10, security doc G3).
  if (parsedSpend.outKind === BTC_POOL_OUT_EXIT) {
    const outputs = chainCtx && chainCtx.txOutputs;
    const out = outputs && outputs[parsedSpend.exitVout];
    if (!out) return { accepted: false, reason: 'exit_vout not a real output of this transaction' };
    if (String(out.valueSats) !== String(parsedSpend.exitValue)) {
      return { accepted: false, reason: 'exit_vout value does not match exit_value' };
    }
    if (String(out.scriptPubKeyHash).toLowerCase() !== String(parsedSpend.destSpkHash).toLowerCase()) {
      return { accepted: false, reason: 'exit_vout scriptPubKey does not match dest_spk_hash' };
    }
  }

  // §10 step 3: every nf absent from the replayed nullifier set (pairwise-distinct-within-envelope was
  // already checked by the parser).
  for (const nf of parsedSpend.nullifiers) {
    if (state.nullifierSet.has(nf.toLowerCase())) {
      return { accepted: false, reason: 'nullifier already spent' };
    }
  }

  // §10 step 4: h_anchor inside the valid-root window; root derived from the indexer's own replayed
  // history (not supplied by the envelope).
  const heights = [...state.rootsByHeight.keys()].filter((h) => h <= parsedSpend.hAnchor);
  if (heights.length === 0) return { accepted: false, reason: 'h_anchor has no retained root (below Kmin or unknown height)' };
  const anchorHeight = Math.max(...heights);
  if (anchorHeight < parsedSpend.hAnchor - BTC_POOL_ANCHOR_WINDOW) {
    return { accepted: false, reason: 'h_anchor outside the retained anchor window' };
  }
  const root = state.rootsByHeight.get(anchorHeight);
  if (!root) return { accepted: false, reason: 'no root retained at h_anchor' };

  // §10 step 5: proof verifies against that root, and the guest's committed statement matches the
  // published envelope field-by-field. `verifyProof` may be a real, async on-chain check (see
  // worker-relay/src/lib/btc-pool-verify.js) or the fail-closed stub below — always awaited, since a real
  // check is inherently a network call and awaiting a non-Promise value from the stub is a no-op.
  const publicStatement = {
    asset: parsedSpend.asset, root, hAnchor: parsedSpend.hAnchor, outKind: parsedSpend.outKind,
    nullifiers: parsedSpend.nullifiers, outputs: parsedSpend.outputs,
    hasExitVout: parsedSpend.outKind === BTC_POOL_OUT_EXIT,
    exitVout: parsedSpend.exitVout, exitValue: parsedSpend.exitValue, destSpkHash: parsedSpend.destSpkHash,
  };
  const proofOk = await verifyProof(publicStatement, parsedSpend.proof);
  if (!proofOk) return { accepted: false, reason: 'proof does not verify' };

  // §10 step 6, only now: append new leaves (pay) or none (exit), insert nullifiers.
  const newLeaves = [];
  if (parsedSpend.outKind === BTC_POOL_OUT_PAY) {
    for (const o of parsedSpend.outputs) {
      const leaf = btcPoolNoteLeaf(parsedSpend.asset, o.cx, o.cy, o.spendKey);
      state.tree.insert(leaf);
      newLeaves.push(leaf);
    }
  }
  for (const nf of parsedSpend.nullifiers) state.nullifierSet.add(nf.toLowerCase());

  return { accepted: true, newLeaves, nullifiers: parsedSpend.nullifiers };
}

// Called once after a whole block has been replayed (§10 step 6: "record the block-level root... after the
// whole block has been replayed, not per-envelope"). A reorg simply drops every entry at/after the
// invalidated height (§10 "Two indexers replaying... a reorg invalidates roots for the replaced heights").
export function commitBtcPoolBlockRoot(state, height) {
  state.rootsByHeight.set(height, state.tree.root());
}
export function rollbackBtcPoolFromHeight(state, height) {
  for (const h of [...state.rootsByHeight.keys()]) if (h >= height) state.rootsByHeight.delete(h);
  // NOTE: this only rolls back the retained root INDEX, not the tree/nullifier-set contents themselves —
  // a real integration needs to rebuild `tree`/`nullifierSet` from a full re-replay of the new active chain
  // from the fork point, the same reorg-handling requirement every other opcode's indexer state already has
  // (worker/src/index.js's own reorg handling is the pattern to follow here; not duplicated in this module
  // since it is chain-scan infrastructure, not pool-specific logic).
}
