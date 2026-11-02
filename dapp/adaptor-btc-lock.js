// Bitcoin leg of a confidential cross-chain adaptor swap: a Tacit note locked in a Taproot output that the
// CLAIMER can spend only after learning the swap secret t, and the LOCKER can take back after a relative
// timelock. Pairs with the Ethereum leg in dapp/adaptor-swap.js (the keccak claim kernel, lane 'evm').
//
//   output key   Q = lift(P_claimer + T) + TapTweak(x(P_claimer + T) ‖ leafHash)·G        (BIP-341, one leaf)
//   key path     the claimer signs with d_claimer + t. T = t·G is the adaptor point of the Ethereum leg, so
//                the claim there, which publishes t, is what opens this output.
//   refund leaf  <csv> OP_CHECKSEQUENCEVERIFY OP_DROP <locker_xonly> OP_CHECKSIG
//
// Why the lock is a key tweak and not an adapted kernel signature: nothing locks a plain Tacit UTXO, since its
// owner can spend it elsewhere, and a transfer's kernel_sig sits inside the commit's leaf script, so it must be
// final before the commit output exists. A key that already contains T needs neither signature adaptation nor
// anything on the Tacit side: the lock and the claim are ordinary transfers. The locker shares the locked
// note's opening (value, blinding) so that whichever party spends it can sign its own kernel.
//
// Pure: the Taproot helpers come in as `prims` (dapp/bitcoin-taproot-wallet.js `prims`).

import { secp, sha256, concatBytes, bytesToHex } from './vendor/tacit-deps.min.js';
import { G, SECP_N, modN, bigintToBytes32, bytes32ToBigint } from './bulletproofs.js';

const te = new TextEncoder();
const taggedHash = (tag, ...msgs) => { const t = sha256(te.encode(tag)); return sha256(concatBytes(t, t, ...msgs)); };
const toBig = (x) => (typeof x === 'bigint' ? x : bytes32ToBigint(x));

const OP_CSV = 0xb2, OP_DROP = 0x75, OP_CHECKSIG = 0xac;

// Minimal script-number push of a positive block count (BIP-68 relative locktime in blocks, 1..65535).
function pushBlocks(n) {
  if (!Number.isInteger(n) || n < 1 || n > 0xffff) throw new Error('adaptor-btc-lock: csvBlocks must be 1..65535');
  if (n <= 16) return Uint8Array.of(0x50 + n);
  const b = [];
  for (let x = n; x > 0; x >>= 8) b.push(x & 0xff);
  if (b[b.length - 1] & 0x80) b.push(0);
  return Uint8Array.of(b.length, ...b);
}

// The locker's way out: spendable by `lockerXonly` once the input is `csvBlocks` blocks old (nSequence = csvBlocks).
export function refundLeaf({ lockerXonly, csvBlocks }) {
  if (!(lockerXonly instanceof Uint8Array) || lockerXonly.length !== 32) throw new Error('adaptor-btc-lock: lockerXonly must be 32 bytes');
  return concatBytes(pushBlocks(csvBlocks), Uint8Array.of(OP_CSV, OP_DROP, 0x20), lockerXonly, Uint8Array.of(OP_CHECKSIG));
}

// Everything both parties must agree on for the lock output. `claimerPub` is a point or a 33-byte key (bytes or
// hex), `T` the adaptor point. Recompute from the offer and compare `spk` before locking the other leg.
export function deriveLock({ prims, claimerPub, T, lockerXonly, csvBlocks }) {
  const P = typeof claimerPub?.add === 'function' ? claimerPub
    : secp.ProjectivePoint.fromHex(typeof claimerPub === 'string' ? claimerPub.replace(/^0x/, '') : bytesToHex(claimerPub));
  const I = P.add(T);
  if (I.equals(secp.ProjectivePoint.ZERO)) throw new Error('adaptor-btc-lock: T cancels the claimer key');
  const ib = I.toRawBytes(true);
  const internalXonly = ib.slice(1);
  const leaf = refundLeaf({ lockerXonly, csvBlocks });
  const leafHash = prims.tapLeafHash(leaf);
  const { Q_xonly, parity } = prims.tweakedOutputKey(internalXonly, leafHash);
  return {
    internalXonly, internalOddY: ib[0] === 0x03, leaf, leafHash, csvBlocks,
    outputXonly: Q_xonly, parity, spk: prims.p2trScript(Q_xonly),
    controlBlock: prims.controlBlock(internalXonly, parity),
  };
}

// The private key that signs the key-path spend of the lock output: d_claimer + t, adjusted for the internal
// key's parity and tweaked. Throws unless it opens the output, so a wrong or half-extracted t is caught here and
// not by a rejected broadcast. Sign the BIP-341 key-path sighash with it (BIP-340 handles the output's parity).
export function claimSecret({ dClaimer, t, lock }) {
  let d = modN(toBig(dClaimer) + toBig(t));
  if (lock.internalOddY) d = modN(SECP_N - d);
  const tweak = bytes32ToBigint(taggedHash('TapTweak', lock.internalXonly, lock.leafHash));
  if (tweak >= SECP_N) throw new Error('adaptor-btc-lock: tap tweak >= N');
  const sk = modN(d + tweak);
  if (sk === 0n || bytesToHex(G.multiply(sk).toRawBytes(true).slice(1)) !== bytesToHex(lock.outputXonly)) {
    throw new Error('adaptor-btc-lock: this secret does not open the lock');
  }
  return bigintToBytes32(sk);
}
