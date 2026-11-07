// The tacit chain's lock format, byte for byte the block program's (vectors from `tacit-block lock-vectors`), and the swap's
// signatures end to end: the recipient's pre-signature adapted to T, the claim the block verifies with BIP-340, and the secret the
// other party reads from it.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { poseidon2, poseidon3, poseidon4 } from 'poseidon-lite';
import { secp } from '../dapp/vendor/tacit-deps.min.js';
import { verifySchnorr } from '../dapp/bulletproofs.js';
import * as adaptor from '../dapp/adaptor-signature.js';
import {
  makeTacitChainLock, lockBytes, lockOp, claimMessage, LOCK_TAG, presignClaim, verifyClaimPresign, completeClaim, secretFromClaim,
  claimTooLate, SETTLE_CLAIM, SETTLE_REFUND, TIME_WINDOW,
} from '../dapp/tacit-chain-lock.js';

const poseidon = (xs) => ({ 2: poseidon2, 3: poseidon3, 4: poseidon4 })[xs.length](xs);
const V = JSON.parse(readFileSync(new URL('./vectors/tacit-chain-lock-vectors.json', import.meta.url)));
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const big = (h) => BigInt(h);
const L = makeTacitChainLock({ poseidon });
const lock = {
  recipient: V.lock.recipient,
  deadline: V.lock.deadline,
  claimTo: { npk: big(V.lock.claimTo.npk), rho: big(V.lock.claimTo.rho), memo: V.lock.claimTo.memo },
  refundTo: { npk: big(V.lock.refundTo.npk), rho: big(V.lock.refundTo.rho), memo: V.lock.refundTo.memo },
};
const path = Array.from({ length: 32 }, (_, i) => 1000n + BigInt(i));

test('lock bytes, tag, leaf and nullifier are the program\'s', () => {
  assert.equal(hx(lockBytes(lock)), V.lockBytes);
  assert.equal('0x' + LOCK_TAG.toString(16).padStart(64, '0'), V.lockTag);
  const leaf = L.leaf(big(V.asset), V.value, lock);
  assert.equal('0x' + leaf.toString(16).padStart(64, '0'), V.leaf);
  assert.equal('0x' + L.nullifier(leaf, 5).toString(16).padStart(64, '0'), V.nullifierAt5);
  assert.equal(hx(claimMessage(V.chain, leaf)), V.claimMessage);
  assert.equal('0x' + L.pathRoot(leaf, 5, path).toString(16).padStart(64, '0'), V.pathRootFromLeaf);
  assert.equal(hx(lockOp(lock, '0x' + '88'.repeat(32))), V.opBytes);
});

test('settles and a forced refund are the program\'s', () => {
  const s = { asset: big(V.asset), value: V.value, lock, index: 5, root: 99n, path };
  assert.equal(hx(L.settleBytes({ ...s, kind: SETTLE_CLAIM, sig: '0x' + '66'.repeat(64) })), V.claimBytes);
  assert.equal(hx(L.settleBytes({ ...s, kind: SETTLE_REFUND })), V.refundBytes);
  assert.equal(hx(L.forcedSettle({ ...s, kind: SETTLE_REFUND }, new Uint8Array(64).fill(0x77))), V.forcedRefund);
  assert.throws(() => L.settleBytes({ ...s, kind: SETTLE_REFUND, sig: '0x' + '66'.repeat(64) }));
  assert.throws(() => L.settleBytes({ ...s, kind: SETTLE_CLAIM }));
});

test('a claim adapted to T: the chain\'s BIP-340 check takes it and the other party reads t', () => {
  const dRecipient = 0x1234567890abcdefn;
  const { Px } = adaptor.evenSigningKey(dRecipient);
  const leaf = L.leaf(big(V.asset), V.value, { ...lock, recipient: Px });
  const t = 0xfeedfacecafebeefn;
  const T = adaptor.adaptorPoint(t);
  const pre = presignClaim(dRecipient, V.chain, leaf, T);
  assert.ok(verifyClaimPresign({ recipient: Px, chain: V.chain, leaf, R: pre.R, T, sTilde: pre.sTilde }));
  assert.ok(!verifyClaimPresign({ recipient: Px, chain: V.chain, leaf: leaf + 1n, R: pre.R, T, sTilde: pre.sTilde }));
  const sig = completeClaim(pre, t);
  assert.ok(verifySchnorr(sig, claimMessage(V.chain, leaf), Px), 'the claim verifies as plain BIP-340, as the block program checks it');
  assert.equal(secretFromClaim(sig, pre), t);
  assert.ok(secp.ProjectivePoint.BASE.multiply(secretFromClaim(sig, pre)).equals(T));
});

test('a claim too close to its deadline is not made', () => {
  const now = 1_800_000_000;
  assert.ok(!claimTooLate(now + 3600 + TIME_WINDOW, now, 3600));
  assert.ok(claimTooLate(now + 3600 + TIME_WINDOW - 1, now, 3600));
});
