// Stealth-receive JS mirror (dapp/confidential-stealth.js) validated against:
//   (1) independently-built cxfer-core preimages + keccak (byte-parity of stealth_lock_leaf / stealth_claim_msg),
//   (2) the one-time-address round-trip (sender and recipient agree on ownerPub; scan recognizes only the
//       recipient), and (3) the claim-signature round-trip — the recipient's recovered one-time key produces a
//       BIP-340 signature `verifySchnorr` accepts (so the guest's `bip340_verify` will), and a non-recipient
//       key does not. Pins the JS layout + the stealth crypto to the guest. Run: node tests/confidential-stealth.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { signSchnorr, verifySchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';
import assert from 'node:assert';
import { webcrypto } from 'node:crypto';

const keccak256 = (b) => keccak_256(b);
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const enc = new TextEncoder();
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const cat = (...a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
const fromHex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const rand = () => { const b = new Uint8Array(32); (globalThis.crypto || webcrypto).getRandomValues(b); return hx(b); };

// (1) byte-parity with cxfer-core preimages.
{
  const asset = '0x' + 'aa'.repeat(32), cx = '0x' + '10'.repeat(32), cy = '0x' + '11'.repeat(32);
  const ownerPub = '0x' + '61'.repeat(32), locker = '0x' + '41'.repeat(32);
  const amount = 1_000_000n, deadline = 1_700_000_000n;
  const expLeaf = hx(keccak_256(cat(enc.encode('tacit-stealth-lock-v1'), b32(asset), b32(cx), b32(cy), b32(ownerPub), be(amount, 8), be(deadline, 8), b32(locker))));
  assert.equal(stealth.stealthLockLeaf(asset, cx, cy, ownerPub, amount, deadline, locker), expLeaf, 'stealth_lock_leaf byte-parity');

  const cb = '0x' + '11'.repeat(32), lockLeaf = expLeaf;
  const mCx = '0x' + '20'.repeat(32), mCy = '0x' + '21'.repeat(32), mOwner = '0x' + '00'.repeat(32);
  const fee = 1_000n;
  const expMsg = hx(keccak_256(cat(enc.encode('tacit-stealth-claim-v1'), b32(cb), b32(lockLeaf), b32(mCx), b32(mCy), b32(mOwner), be(amount, 8), be(fee, 8))));
  assert.equal(hx(stealth.stealthClaimMsg(cb, lockLeaf, mCx, mCy, mOwner, amount, fee)), expMsg, 'stealth_claim_msg byte-parity');
  ok('stealth_lock_leaf + stealth_claim_msg byte-parity with cxfer-core');
}

// (2) one-time-address round-trip + scan.
const b = rand();                                                          // recipient static spend priv
const B = hx(secp.ProjectivePoint.BASE.multiply(BigInt(b)).toRawBytes(true)); // recipient static spend pub
const e = rand();                                                          // sender ephemeral priv
const { ephemeralPub, ownerPub } = stealth.oneTimeAddress({ recipientSpendPub: B, ephemeralPriv: e });
{
  const rec = stealth.recoverOneTimeKey({ recipientSpendPriv: b, ephemeralPub });
  assert.equal(rec.ownerPub, ownerPub, 'sender and recipient derive the SAME one-time pubkey');
  assert.equal(stealth.scanLock({ recipientSpendPriv: b, ephemeralPub, ownerPub }), true, 'recipient recognizes their lock');
  assert.equal(stealth.scanLock({ recipientSpendPriv: rand(), ephemeralPub, ownerPub }), false, 'a non-recipient does not recognize it');
  ok('one-time address: sender/recipient agree on ownerPub; scan matches only the recipient');
}

// (3) claim-signature round-trip — the recovered one-time key signs a claim the guest accepts; a wrong key can't.
{
  const cb = '0x' + '12'.repeat(32), lockLeaf = '0x' + '72'.repeat(32);
  const mCx = '0x' + '20'.repeat(32), mCy = '0x' + '21'.repeat(32), mOwner = '0x' + '00'.repeat(32);
  const amount = 500_000n, fee = 1_000n;
  const rec = stealth.recoverOneTimeKey({ recipientSpendPriv: b, ephemeralPub });
  const claimMsg = stealth.stealthClaimMsg(cb, lockLeaf, mCx, mCy, mOwner, amount, fee);
  const sig = stealth.signClaim({ oneTimePriv: rec.oneTimePriv, claimMsg });
  assert.equal(verifySchnorr(fromHex(sig), claimMsg, b32(ownerPub)), true, 'recipient one-time-key claim sig verifies under ownerPub (guest bip340_verify accepts)');
  // the sender knows ownerPub + the shared secret but NOT `b`, so the base spend key alone cannot claim:
  const wrongSig = hx(signSchnorr(claimMsg, b32(b)));
  assert.equal(verifySchnorr(fromHex(wrongSig), claimMsg, b32(ownerPub)), false, 'the base spend key (not the one-time key) cannot claim');
  ok('claim signature: recovered one-time key is accepted; a non-one-time key is rejected');
}

console.log(`confidential-stealth: all ${n} checks passed`);
