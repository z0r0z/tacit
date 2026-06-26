// Pins two PRIVACY invariants that live in the dapp prover (out of the guest's reach) and were flagged by the
// privacy audit as "trusted but untested":
//   F2 — asset-keyed blinding: deriveNote folds the assetId into the blinding, so two notes of DIFFERENT assets
//        can never collide to the same Pedersen commitment (Cx,Cy) — hence never to the same nullifier
//        (nu = keccak(Cx‖Cy‖"spent")). A collision would be a cross-asset linkage + lock/grief surface.
//   F4 — stealth unlinkability: each send uses a FRESH ephemeral key, so two sends to the SAME recipient yield
//        DIFFERENT one-time addresses (unlinkable on-chain), the recipient recovers the right spend key for each
//        (round-trip), and the sender cannot derive that key.
// Run: node tests/confidential-privacy-invariants.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const stealth = makeConfidentialStealth({ keccak256, secp, curveOrder: secp.CURVE.n });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const seed = '0x' + '11'.repeat(32);
const assetA = '0x' + 'aa'.repeat(32);
const assetB = '0x' + 'bb'.repeat(32);
const commitOf = (assetId, index) => {
  const note = pool.deriveNote(seed, assetId, index);
  const c = pool.commitXY(1000n, note.blinding);
  return { blinding: note.blinding, ...c, nu: pool.nullifier(c.cx, c.cy) };
};

// ── F2 — asset-keyed blinding ──
{
  const a = commitOf(assetA, 0);
  const b = commitOf(assetB, 0); // same seed, same index, same VALUE — only the asset differs
  assert.notStrictEqual(a.blinding, b.blinding, 'F2: blinding must depend on assetId');
  assert.ok(a.cx !== b.cx || a.cy !== b.cy, 'F2: cross-asset commitment must not collide');
  assert.notStrictEqual(a.nu, b.nu, 'F2: cross-asset nullifier must not collide');
  ok('F2: same (seed,index,value) but different asset ⇒ distinct blinding, commitment, nullifier');

  // and the derivation is deterministic (recover-from-seed-alone) + index-separated within one asset.
  assert.strictEqual(commitOf(assetA, 0).blinding, a.blinding, 'F2: deriveNote must be deterministic');
  assert.notStrictEqual(commitOf(assetA, 1).blinding, a.blinding, 'F2: per-index blindings must differ');
  ok('F2: deriveNote is deterministic (seed-recoverable) and index-separated');
}

// ── F4 — fresh-ephemeral stealth unlinkability + round-trip ──
{
  const bToBig = (u8) => BigInt('0x' + Buffer.from(u8).toString('hex'));
  const recipientSpendPriv = (bToBig(keccak256(new TextEncoder().encode('recipient-spend'))) % secp.CURVE.n) || 1n;
  const recipientSpendPub = '0x' + Buffer.from(secp.getPublicKey(recipientSpendPriv, true)).toString('hex');
  const send = (ephScalar) => {
    const ephemeralPriv = '0x' + ephScalar.toString(16).padStart(64, '0');
    const s = stealth.oneTimeAddress({ recipientSpendPub, ephemeralPriv });
    const r = stealth.recoverOneTimeKey({ recipientSpendPriv, ephemeralPub: s.ephemeralPub });
    return { ...s, ...r };
  };
  const send1 = send(0x1234n);
  const send2 = send(0x9abcn); // a different ephemeral = a different send

  // unlinkability: two sends to the same recipient share no on-chain identifier
  assert.notStrictEqual(send1.ownerPub, send2.ownerPub, 'F4: fresh ephemeral ⇒ distinct one-time address');
  assert.notStrictEqual(send1.ephemeralPub, send2.ephemeralPub, 'F4: distinct ephemeral pubkeys');
  ok('F4: two sends to the same recipient yield unlinkable one-time addresses');

  // round-trip: the recipient recovers a key whose pubkey is exactly the locked one-time address
  for (const s of [send1, send2]) {
    assert.strictEqual(s.ownerPub, stealth.recoverOneTimeKey({ recipientSpendPriv, ephemeralPub: s.ephemeralPub }).ownerPub,
      'F4: recovered one-time pubkey must equal the locked address');
    const recoveredPub = '0x' + Buffer.from(secp.getPublicKey(BigInt(s.oneTimePriv), true)).toString('hex').slice(2);
    assert.strictEqual(recoveredPub.slice(2), s.ownerPub.replace(/^0x/, ''), 'F4: recovered priv ⇒ the one-time pubkey');
  }
  ok('F4: recipient recovers the correct one-time spending key for each send (x-only round-trip)');

  // the sender (knows ownerPub + ephemeral, not the recipient spend priv) cannot derive the spend key:
  // a wrong recipient priv recovers a different key — confirms the key is gated on the recipient secret.
  const wrongPriv = (BigInt(recipientSpendPriv) + 1n) % secp.CURVE.n;
  assert.notStrictEqual(stealth.recoverOneTimeKey({ recipientSpendPriv: wrongPriv, ephemeralPub: send1.ephemeralPub }).ownerPub,
    send1.ownerPub, 'F4: one-time key is gated on the recipient spend secret');
  ok('F4: one-time spending key is unrecoverable without the recipient spend secret');
}

console.log(`\n${n}/${n} confidential privacy-invariant checks passed`);
