// The tacit chain's locks, as a wallet builds and settles them: the chain's half of an atomic swap with another chain (the fast
// bridge's adaptor swap, against the Bitcoin pool or any chain with Schnorr signatures). Byte for byte the block program's
// (contracts/sp1/confidential/tacit-block/common/src/lock.rs); vectors: tests/vectors/tacit-chain-lock-vectors.json, written by
// `tacit-block lock-vectors`.
//
//   lock bytes  = recipient (x-only, 32) ‖ deadline (u64 BE, unix seconds) ‖ claimTo ‖ refundTo      each to = npk ‖ rho ‖ memo hash
//   leaf        = Poseidon(LOCK_TAG, asset, value, F("tacit-block-lock-v1", lock bytes))
//   nullifier   = Poseidon(LOCK_NF_TAG, leaf, index)
//   claim msg   = SHA-256("tacit-block-claim-v1" ‖ chain ‖ leaf), signed by the recipient with BIP-340
//   F(tag, m)   = (SHA-256(tag ‖ m ‖ 0) ‖ SHA-256(tag ‖ m ‖ 1)) read little-endian, mod p     LOCK_TAG = F("tacit-block-lock-leaf-v1")
//
// The recipient pre-signs its claim adapted to the swap's point T (adaptor-signature.js) and hands the pre-signature to the other
// leg's party before it locks; the claim the block publishes then gives that party t = s − s̃, and no one else anything.
//
// A block names a time T and lands only within TIME_WINDOW of it: a claim is taken while T + TIME_WINDOW is at most the deadline, a
// refund from the deadline on. A claim posted to the landing contract's queue (`forcedSettle`) is taken within its FORCE_DELAY, so a
// wallet claims with at least FORCE_DELAY + TIME_WINDOW to spare (`claimTooLate`).

import { sha256, concatBytes } from './vendor/tacit-deps.min.js';
import * as adaptor from './adaptor-signature.js';

export const P_FR = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
export const TIME_WINDOW = 3600;
export const MEMO_LEN = 832;
export const TREE_DEPTH = 32;
export const OP_LOCK = 2;
export const SETTLE_CLAIM = 1;
export const SETTLE_REFUND = 2;
export const SETTLE_MARK = new Uint8Array(32).fill(0xff);

const te = new TextEncoder();
const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const fromBe = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const fromLe = (b) => b.reduceRight((a, x) => (a << 8n) | BigInt(x), 0n);
const bytes = (x, n, what) => {
  const b = x instanceof Uint8Array ? x : Uint8Array.from(String(x).replace(/^0x/, '').match(/../g).map((h) => parseInt(h, 16)));
  if (b.length !== n) throw new Error(`tacit-chain-lock: ${what} is not ${n} bytes`);
  return b;
};
const fe = (x, what) => { const v = BigInt(x); if (v < 0n || v >= P_FR) throw new Error(`tacit-chain-lock: ${what} is not a field element`); return v; };

/// F(tag, parts…): 64 hashed bytes, little-endian, reduced mod p (the program's Fr::from_uniform_bytes).
export function fieldOf(tag, ...parts) {
  const wide = new Uint8Array(64);
  for (let i = 0; i < 2; i++) wide.set(sha256(concatBytes(te.encode(tag), ...parts, Uint8Array.of(i))), 32 * i);
  return fromLe(wide) % P_FR;
}

export const LOCK_TAG = fieldOf('tacit-block-lock-leaf-v1');
export const LOCK_NF_TAG = fieldOf('tacit-block-lock-nf-v1');

const toBytes = (t, what) => concatBytes(be(fe(t.npk, `${what}.npk`), 32), be(fe(t.rho, `${what}.rho`), 32), bytes(t.memo, 32, `${what}.memo`));

/// A lock's terms as the program serializes them (232 bytes).
export function lockBytes({ recipient, deadline, claimTo, refundTo }) {
  return concatBytes(bytes(recipient, 32, 'recipient'), be(deadline, 8), toBytes(claimTo, 'claimTo'), toBytes(refundTo, 'refundTo'));
}

/// The operation a spend's body names to put its exit's value in the lock, its leaf published with the memo `memoHash` names.
export const lockOp = (lock, memoHash) => concatBytes(Uint8Array.of(OP_LOCK), lockBytes(lock), bytes(memoHash, 32, 'memo hash'));

export function claimMessage(chain, leaf) {
  return sha256(concatBytes(te.encode('tacit-block-claim-v1'), bytes(chain, 32, 'chain'), be(fe(leaf, 'leaf'), 32)));
}

/// `poseidon(inputs: bigint[]) → bigint`, circomlib's (poseidon-lite in tests).
export function makeTacitChainLock({ poseidon }) {
  if (typeof poseidon !== 'function') throw new Error('tacit-chain-lock: poseidon(inputs[]) → bigint required');
  const H = (xs) => BigInt(poseidon(xs.map((x) => BigInt(x))));

  const leaf = (asset, value, lock) => H([LOCK_TAG, fe(asset, 'asset'), BigInt(value), fieldOf('tacit-block-lock-v1', lockBytes(lock))]);
  const nullifier = (lf, index) => H([LOCK_NF_TAG, lf, BigInt(index)]);

  /// The root a path leads to from `lf` at `index` (siblings from the leaf up).
  function pathRoot(lf, index, path) {
    if (path.length !== TREE_DEPTH) throw new Error('tacit-chain-lock: a path is 32 siblings');
    let h = BigInt(lf);
    path.forEach((sib, d) => { h = (BigInt(index) >> BigInt(d)) & 1n ? H([sib, h]) : H([h, sib]); });
    return h;
  }

  /// A claim or refund as a block takes it: kind ‖ asset ‖ value (u64) ‖ lock ‖ index (u64) ‖ root ‖ path ‖ a claim's signature.
  function settleBytes({ kind, asset, value, lock, index, root, path, sig = null }) {
    if (kind !== SETTLE_CLAIM && kind !== SETTLE_REFUND) throw new Error('tacit-chain-lock: kind');
    if ((kind === SETTLE_CLAIM) !== (sig != null)) throw new Error('tacit-chain-lock: a claim carries a signature, a refund none');
    if (path.length !== TREE_DEPTH) throw new Error('tacit-chain-lock: a path is 32 siblings');
    return concatBytes(
      Uint8Array.of(kind), be(fe(asset, 'asset'), 32), be(value, 8), lockBytes(lock), be(index, 8), be(fe(root, 'root'), 32),
      ...path.map((p, i) => be(fe(p, `path[${i}]`), 32)), ...(sig ? [bytes(sig, 64, 'signature')] : []),
    );
  }

  /// A claim or refund posted to the landing contract's queue: SETTLE_MARK ‖ the settle ‖ the memo of the note it makes.
  const forcedSettle = (settle, memo) => concatBytes(SETTLE_MARK, settleBytes(settle), bytes(memo, MEMO_LEN, 'memo'));

  return { leaf, nullifier, pathRoot, settleBytes, forcedSettle };
}

// ── the swap's signatures ──

/// The recipient pre-signs its claim of `leaf` on `chain`, adapted to T. The other leg's party checks it with `verifyClaimPresign`
/// before locking, keeps `sTilde`, `R` and `T`, and reads t from the claim the block publishes (`secretFromClaim`).
export function presignClaim(dRecipient, chain, leaf, T, nonce = null) {
  const msg = claimMessage(chain, leaf);
  return adaptor.presign(dRecipient, msg, T, nonce ?? adaptor.deriveNonce(dRecipient, msg, T));
}

export function verifyClaimPresign({ recipient, chain, leaf, R, T, sTilde }) {
  return adaptor.verifyPresign({ Px: bytes(recipient, 32, 'recipient'), msg32: claimMessage(chain, leaf), R, T, sTilde });
}

/// The claim's signature (R'.x ‖ s), from the pre-signature and t.
export function completeClaim(pre, t) {
  return adaptor.completedSig(pre.RxPub, adaptor.complete(pre.sTilde, t, pre.R, pre.T));
}

/// t, from the claim signature a block published and the pre-signature the party kept.
export function secretFromClaim(sig, { sTilde, R, T }) {
  return adaptor.extract(sTilde, fromBe(bytes(sig, 64, 'signature').slice(32)), R, T);
}

/// Whether a claim made now could miss its deadline even through the queue.
export const claimTooLate = (deadline, nowSecs, forceDelaySecs) => nowSecs + forceDelaySecs + TIME_WINDOW > Number(deadline);
