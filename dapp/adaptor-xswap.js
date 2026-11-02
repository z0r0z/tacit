// Cross-chain adaptor swap between a Bitcoin Tacit note and an Ethereum pool note: the terms the two parties
// exchange, the checks each runs before committing its own leg, and how the Bitcoin locker finds its lock again
// from its key and the chain. The Bitcoin lock is dapp/adaptor-btc-lock.js; the Ethereum lock is
// OP_ADAPTOR_LOCK / _CLAIM / _REFUND (SPEC §5.3), whose claim kernel over (L − O) is pre-signed with
// dapp/adaptor-signature.js.
//
// The order is the same in both directions:
//   1. The Bitcoin locker holds t and locks first, into a Taproot output keyed P_claimer + T: the far leg, refundable
//      after `csvBlocks`. A recovery hint in the same transaction lets it find the lock again from its key alone.
//   2. The Ethereum locker waits for confirmations, checks that lock (verifyBtcLockOffer) and the windows
//      (checkEvmDeadline), locks its pool note to (T, deadline, recipient = the Bitcoin locker's claim key) and
//      pre-signs the claim kernel locked to T (makeEvmOffer).
//   3. The Bitcoin locker checks that (verifyEvmOffer) and claims on Ethereum with z = s~ + t (completeEvmClaim).
//   4. The Ethereum locker reads z from the settle, extracts t and opens the Bitcoin lock (openBtcLock).
// BTC -> ETH: the user locks Bitcoin, the LP locks Ethereum. ETH -> BTC: the LP locks Bitcoin, the user Ethereum.
// The second locker never locks before the first lock is confirmed, so the holder of t cannot take a leg alone.
//
// A claim's proof carries z in its public values, so a claim that is sent and then fails to land before the
// deadline still publishes t: the counterparty opens the Bitcoin lock while the Ethereum lock refunds to its
// locker. completeEvmClaim therefore refuses to build a claim with less than `minClaimSecs` left.

import { secp, sha256, keccak_256, concatBytes, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';
import { G, SECP_N, modN, pedersenCommit, bytes32ToBigint, bigintToBytes32 } from './bulletproofs.js';
import * as adaptor from './adaptor-signature.js';
import { deriveLock, claimSecret } from './adaptor-btc-lock.js';

const te = new TextEncoder();
const Pt = secp.ProjectivePoint;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const hx = (b) => bytesToHex(b);
const bx = (h) => (h instanceof Uint8Array ? h : hexToBytes(strip(h)));
const hs = (x) => (x instanceof Uint8Array ? hx(x) : strip(x)); // bytes or hex in, bare lowercase hex out
const pt = (h) => Pt.fromHex(strip(h));
const toBig = (x) => (typeof x === 'bigint' ? x : bytes32ToBigint(bx(x)));
const taggedHash = (tag, ...msgs) => { const t = sha256(te.encode(tag)); return sha256(concatBytes(t, t, ...msgs)); };
const u32le = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
const beN = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const fromBe = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const xonlyOk = (h) => { try { Pt.fromHex('02' + strip(h)); return strip(h).length === 64; } catch { return false; } };
const pointOk = (h) => { try { return !pt(h).equals(Pt.ZERO); } catch { return false; } };

// ── secrets ──
// The swap id is the outpoint the Bitcoin locker moves into the lock (display-order txid ‖ vout LE): unique, and
// visible in the locker's own history, so every secret below can be derived again from the key and the chain.
export const swapIdOf = (txid, vout) => concatBytes(bx(txid), u32le(vout));

function scalarOf(seed, tag, swapId) {
  for (let i = 0; ; i++) {
    const k = bytes32ToBigint(taggedHash('tacit-xswap-v1', seed, te.encode(tag), swapId, Uint8Array.of(i)));
    if (k > 0n && k < SECP_N) return k;
  }
}

// t and T (the Bitcoin locker's), the Bitcoin lock output's blinding, and the Ethereum claim output's blinding (the
// Bitcoin locker is also the Ethereum recipient).
export function deriveSwapSecrets({ seed, swapId }) {
  if (!(seed instanceof Uint8Array) || seed.length < 32) throw new Error('xswap: seed must be at least 32 bytes');
  const t = scalarOf(seed, 't', swapId);
  return {
    t, T: G.multiply(t),
    rLock: scalarOf(seed, 'r-btc-lock', swapId),
    rOut: scalarOf(seed, 'r-evm-out', swapId),
  };
}

// The blinding of the Ethereum locker's note L. It follows the swap id and the whole adaptor point (both y parities),
// so every lock of one key holds its own L; the claim kernel is over (L, O), which is why an L is never shared between
// locks. `swapId` comes from the chain (swapIdFromLockTx), never from an offer.
export function evmLockBlinding({ seed, swapId, T }) {
  if (!(seed instanceof Uint8Array) || seed.length < 32) throw new Error('xswap: seed must be at least 32 bytes');
  return scalarOf(seed, 'r-evm-lock-v2', concatBytes(swapId, typeof T?.toRawBytes === 'function' ? T.toRawBytes(true) : bx(T)));
}

// The swap id of a Bitcoin lock transaction as the chain shows it: the first note input (vin[1]; vin[0] is the
// envelope's commit output). `tx` is an esplora transaction.
export function swapIdFromLockTx(tx) {
  const i = tx?.vin?.[1];
  if (!i) throw new Error('xswap: the lock transaction spends no note');
  return swapIdOf(i.txid, i.vout);
}

// ── recovery hint ──
// An OP_RETURN in the lock transaction carrying the claimer key, the CSV and the value, sealed to the locker:
// 0x6a ‖ 47 ‖ "TXS1" ‖ (claimerPub(33) ‖ csv(2 BE) ‖ value(8 BE)) xor keystream(seed, swapId).
const HINT_MAGIC = te.encode('TXS1');
const HINT_LEN = 43;
function hintStream(seed, swapId) {
  const a = taggedHash('tacit-xswap-hint-v1', seed, swapId, Uint8Array.of(0));
  const b = taggedHash('tacit-xswap-hint-v1', seed, swapId, Uint8Array.of(1));
  return concatBytes(a, b).slice(0, HINT_LEN);
}
const xor = (a, b) => a.map((x, i) => x ^ b[i]);

export function lockHintScript({ seed, swapId, claimerPub, csvBlocks, value }) {
  const cp = typeof claimerPub === 'string' ? bx(claimerPub) : claimerPub;
  if (cp.length !== 33) throw new Error('xswap: claimerPub must be 33 bytes');
  const plain = concatBytes(cp, beN(csvBlocks, 2), beN(value, 8));
  const data = concatBytes(HINT_MAGIC, xor(plain, hintStream(seed, swapId)));
  return concatBytes(Uint8Array.of(0x6a, data.length), data);
}

export function readLockHint({ seed, swapId, script }) {
  const s = typeof script === 'string' ? bx(script) : script;
  if (s.length !== 2 + HINT_MAGIC.length + HINT_LEN || s[0] !== 0x6a || s[1] !== HINT_MAGIC.length + HINT_LEN) return null;
  if (hx(s.slice(2, 6)) !== hx(HINT_MAGIC)) return null;
  const plain = xor(s.slice(6), hintStream(seed, swapId));
  const claimerPub = hx(plain.slice(0, 33));
  if (!pointOk(claimerPub)) return null;
  return { claimerPub, csvBlocks: Number(fromBe(plain.slice(33, 35))), value: fromBe(plain.slice(35, 43)) };
}

// Find a lock this key made, from the transaction that spent the note `swapId` names. `outputs` are that
// transaction's outputs as { script } bytes or { scriptpubkey } hex. Null when it holds no lock of ours.
export function recoverBtcLock({ prims, seed, swapId, lockerXonly, outputs }) {
  const spks = outputs.map((o) => hx(o.script || bx(o.scriptpubkey)));
  for (const spk of spks) {
    const hint = readLockHint({ seed, swapId, script: spk });
    if (!hint) continue;
    const sec = deriveSwapSecrets({ seed, swapId });
    let lock;
    try { lock = deriveLock({ prims, claimerPub: hint.claimerPub, T: sec.T, lockerXonly, csvBlocks: hint.csvBlocks }); } catch { continue; }
    const vout = spks.indexOf(hx(lock.spk));
    if (vout >= 0) return { vout, lock, ...hint, rLock: sec.rLock, t: sec.t };
  }
  return null;
}

// ── windows ──
// Earliest time the Bitcoin refund could be mined, assuming every block until then comes `fastBlockSecs` apart:
// the refund is minable at height lockHeight + csvBlocks.
export function btcRefundOpensAt({ lockHeight, csvBlocks, tipHeight, nowSecs, fastBlockSecs = 300 }) {
  return nowSecs + Math.max(0, lockHeight + csvBlocks - 1 - tipHeight) * fastBlockSecs;
}

// The Ethereum locker's check before it locks: the Bitcoin locker must have time to claim, and after the last
// moment it could, the Ethereum locker must have `claimSlackSecs` to see z and get its Bitcoin claim mined
// before the Bitcoin refund opens. Returns the reasons it fails (empty = fine).
export function checkEvmDeadline({ deadline, nowSecs, btcRefundOpens, minClaimSecs = 1800, claimSlackSecs = 7200 }) {
  const reasons = [];
  if (deadline - nowSecs < minClaimSecs) reasons.push('deadline leaves too little time to claim on Ethereum');
  if (btcRefundOpens < deadline + claimSlackSecs) reasons.push('the Bitcoin lock could be refunded too soon after the Ethereum deadline');
  return reasons;
}

// ── step 1 → 2: the Bitcoin lock offer ──
// What the Bitcoin locker sends once its lock is broadcast: the lock's terms and opening, and what it wants on
// Ethereum (its claim key and the blinding of the output it will claim into).
export function makeBtcLockOffer({ swapId, asset, value, rLock, txid, vout, csvBlocks, lockerXonly, T, claimerPub, evm }) {
  return {
    v: 1, swapId: hx(swapId),
    btc: { asset: hs(asset), value: String(value), rLock: hx(bigintToBytes32(toBig(rLock))), txid: strip(txid), vout, csvBlocks, lockerXonly: hs(lockerXonly) },
    T: hx(T.toRawBytes(true)), claimerPub: hs(claimerPub),
    evm: { asset: hs(evm.asset), amount: String(evm.amount), recipient: hs(evm.recipient), rOut: hx(bigintToBytes32(toBig(evm.rOut))) },
  };
}

// The Ethereum locker's check of a Bitcoin lock offer. `chain` holds what it read itself: the output's
// scriptPubKey and Tacit commitment, whether the validator accepts it as a note of the offered asset, its
// confirmations, and the outpoints the lock transaction spends as notes (`noteInputs`, in order). `expect` is its
// own quote. Every field of `chain` is read from the chain by the caller; nothing in the offer stands in for one.
export function verifyBtcLockOffer(offer, { prims, myClaimerPub, expect, chain, minConfs = 1, minCsv = 72 }) {
  const reasons = [];
  const o = offer || {};
  const b = o.btc || {}, e = o.evm || {};
  if (o.v !== 1) reasons.push('unknown offer version');
  if (strip(o.claimerPub) !== hs(myClaimerPub)) reasons.push('the lock is not keyed to my claim key');
  if (strip(b.asset) !== hs(expect.btcAsset) || BigInt(b.value) !== BigInt(expect.btcValue)) reasons.push('the Bitcoin side differs from the quote');
  if (strip(e.asset) !== hs(expect.evmAsset) || BigInt(e.amount) !== BigInt(expect.evmAmount)) reasons.push('the Ethereum side differs from the quote');
  if (!(b.csvBlocks >= minCsv)) reasons.push(`refund timelock under ${minCsv} blocks`);
  if (!pointOk(o.T)) reasons.push('T is not a point');
  if (!xonlyOk(e.recipient)) reasons.push('recipient is not an x-only key');
  let lock = null;
  if (!reasons.length) {
    try { lock = deriveLock({ prims, claimerPub: o.claimerPub, T: pt(o.T), lockerXonly: bx(b.lockerXonly), csvBlocks: b.csvBlocks }); } catch (err) { reasons.push(err.message); }
  }
  if (lock && hx(lock.spk) !== hs(chain.spk)) reasons.push('the output does not pay the lock these terms make');
  if (hx(pedersenCommit(BigInt(b.value), toBig(b.rLock)).toRawBytes(true)) !== hs(chain.commitment)) reasons.push('the opening does not match the note');
  if (chain.validNote !== true) reasons.push('the output is not a valid note of the asset');
  if (!(chain.confirmations >= minConfs)) reasons.push(`fewer than ${minConfs} confirmation(s)`);
  const first = chain.noteInputs && chain.noteInputs[0];
  if (!first) reasons.push('the lock transaction\'s note inputs were not read');
  else if (hs(o.swapId || '') !== hx(swapIdOf(first.txid, first.vout))) reasons.push('the swap id is not the outpoint the lock transaction spends');
  return { ok: reasons.length === 0, reasons, lock };
}

// ── step 2 → 3: the Ethereum offer ──
const affine = (P) => { const u = P.toRawBytes(false); return [u.slice(1, 33), u.slice(33, 65)]; };

// The lock-set leaf the guest builds at OP_ADAPTOR_LOCK (cxfer-core adaptor_lock_leaf).
export function adaptorLockLeafRaw({ asset, lx, ly, tx, ty, deadline, recipient, locker }) {
  return keccak_256(concatBytes(te.encode('tacit-adaptor-lock-v1'), bx(asset), bx(lx), bx(ly), bx(tx), bx(ty), beN(deadline, 8), bx(recipient), bx(locker)));
}
export function adaptorLockLeaf({ asset, L, T, deadline, recipient, locker }) {
  const [lx, ly] = affine(L), [tx, ty] = affine(T);
  return adaptorLockLeafRaw({ asset, lx: hx(lx), ly: hx(ly), tx: hx(tx), ty: hx(ty), deadline, recipient, locker });
}

// After its OP_ADAPTOR_LOCK settles, the Ethereum locker sends the lock's terms and its pre-signature of the claim
// kernel over (L − O), locked to T. O is the output the recipient asked for: commit(amount, rOut).
export function makeEvmOffer({ asset, amount, rEvmLock, T, deadline, recipient, locker, rOut }) {
  const L = pedersenCommit(BigInt(amount), toBig(rEvmLock));
  const O = pedersenCommit(BigInt(amount), toBig(rOut));
  const excess = modN(toBig(rEvmLock) - toBig(rOut));
  const lockLeaf = adaptorLockLeaf({ asset: hs(asset), L, T, deadline, recipient: hs(recipient), locker: hs(locker) });
  const nonce = adaptor.evmKernelNonce({ excess, inC: [L], outC: [O], T, context: lockLeaf });
  const pre = adaptor.evmKernelPresign({ excess, inC: [L], outC: [O], T, nonce });
  return {
    v: 1, asset: hs(asset), amount: String(amount), L: hx(L.toRawBytes(true)), T: hx(T.toRawBytes(true)), deadline,
    recipient: hs(recipient), locker: hs(locker), lockLeaf: hx(lockLeaf),
    presign: { R: hx(pre.R.toRawBytes(true)), sTilde: hx(bigintToBytes32(pre.sTilde)) },
  };
}

// The Bitcoin locker's check of an Ethereum offer before it reveals anything. `inLockSet` is whether it found
// `offer.lockLeaf` among the pool's lock leaves itself. A valid pre-signature over (L − O) also proves L holds
// exactly `amount`: otherwise L − O would have an H component and nobody could sign for it.
export function verifyEvmOffer(offer, { mine, expect, inLockSet, nowSecs, minClaimSecs = 1800 }) {
  const reasons = [];
  const o = offer || {};
  if (o.v !== 1) reasons.push('unknown offer version');
  if (strip(o.T) !== hx(mine.T.toRawBytes(true))) reasons.push('the lock is not on my adaptor point');
  if (strip(o.recipient) !== hs(mine.recipient)) reasons.push('the lock does not pay my claim key');
  if (strip(o.asset) !== hs(expect.evmAsset) || BigInt(o.amount) !== BigInt(expect.evmAmount)) reasons.push('the Ethereum side differs from the quote');
  if (!pointOk(o.L) || !pointOk(o.presign?.R)) reasons.push('malformed points');
  if (!reasons.length) {
    const L = pt(o.L);
    const leaf = adaptorLockLeaf({ asset: o.asset, L, T: mine.T, deadline: o.deadline, recipient: o.recipient, locker: o.locker });
    if (hx(leaf) !== strip(o.lockLeaf)) reasons.push('the terms do not make the stated lock leaf');
    if (inLockSet !== true) reasons.push('the lock leaf is not in the pool');
    const O = pedersenCommit(BigInt(o.amount), toBig(mine.rOut));
    if (!adaptor.evmKernelVerifyPresign({ inC: [L], outC: [O], R: pt(o.presign.R), T: mine.T, sTilde: toBig(o.presign.sTilde) })) {
      reasons.push('the pre-signature does not verify (or the locked note holds a different amount)');
    }
  }
  if (!(o.deadline - nowSecs >= minClaimSecs)) reasons.push('too little time left to claim');
  return { ok: reasons.length === 0, reasons };
}

// ── step 3: the Ethereum claim kernel ──
// The completed kernel { R: R + T, z } the claim carries; z is what publishes t. Refuses near the deadline.
export function completeEvmClaim({ offer, t, rOut, nowSecs, minClaimSecs = 1800 }) {
  if (offer.deadline - nowSecs < minClaimSecs) throw new Error('xswap: too close to the deadline to claim; a claim that misses it still publishes t');
  const pre = { R: pt(offer.presign.R), T: adaptor.adaptorPoint(toBig(t)), sTilde: toBig(offer.presign.sTilde) };
  const { R, z } = adaptor.evmKernelComplete(pre, toBig(t));
  const L = pt(offer.L), O = pedersenCommit(BigInt(offer.amount), toBig(rOut));
  const e = adaptor.evmKernelChallenge([L], [O], R);
  if (!G.multiply(z).equals(R.add(L.add(O.negate()).multiply(e)))) throw new Error('xswap: completed kernel does not verify');
  return { R: hx(R.toRawBytes(true)), z: hx(bigintToBytes32(z)), O: hx(O.toRawBytes(true)) };
}

// ── step 4: open the Bitcoin lock ──
// The Ethereum locker reads z from the claim's settle, recovers t with its own pre-signature, and derives the key
// that spends the Bitcoin lock (claimSecret throws if it does not open it).
export function openBtcLock({ offer, z, dClaimer, lock }) {
  const t = adaptor.evmKernelExtract(toBig(offer.presign.sTilde), toBig(z));
  return { t, sk: claimSecret({ dClaimer, t, lock }) };
}
