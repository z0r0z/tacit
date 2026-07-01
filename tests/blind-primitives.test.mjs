// JS self-consistency for the prover-blind primitives (mirror of the cxfer-core Rust KATs
// `opening_pok_blind_roundtrip_and_tamper` + `stealth_blind_leaf_domain_separated`). Confirms the dapp
// mirrors of `verify_opening_pok_blind` + `stealth_lock_leaf_blind` prove/verify and reject tampering, and
// that the blind leaf is domain-separated from the amount-bearing leaf. Run: node tests/blind-primitives.test.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { signSchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const transfer = makeConfidentialTransfer({ keccak256 });
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const ctxHex = '0x' + '33'.repeat(32);
const ctx2 = '0x' + '44'.repeat(32);

// ── value-hiding opening PoK ──
{
  const value = 1234n, r = randomScalar(), sv = randomScalar(), sr = randomScalar();
  const C = pool.prover.commit(value, r);
  const cx = '0x' + C.toAffine().x.toString(16).padStart(64, '0');
  const cy = '0x' + C.toAffine().y.toString(16).padStart(64, '0');
  const p = pool.openingPokBlind(value, r, ctxHex, sv, sr);
  assert(pool.verifyOpeningPokBlind(cx, cy, p.R, p.zV, p.zR, ctxHex), 'valid blind PoK verifies');
  assert(!pool.verifyOpeningPokBlind(cx, cy, p.R, p.zV, p.zR, ctx2), 'context tamper rejected');
  const bad = (BigInt(p.zV) + 1n).toString(16).padStart(64, '0');
  assert(!pool.verifyOpeningPokBlind(cx, cy, p.R, '0x' + bad, p.zR, ctxHex), 'z_v tamper rejected');
  // a PoK made for value v must not verify against a different-valued commitment (same r).
  const C2 = pool.prover.commit(value + 1n, r);
  const c2x = '0x' + C2.toAffine().x.toString(16).padStart(64, '0');
  const c2y = '0x' + C2.toAffine().y.toString(16).padStart(64, '0');
  assert(!pool.verifyOpeningPokBlind(c2x, c2y, p.R, p.zV, p.zR, ctxHex), 'wrong commitment rejected');
  ok('opening PoK blind: roundtrip + context/z/commitment tamper');
}

// ── blind stealth leaf domain separation ──
{
  const asset = '0x' + '01'.repeat(32), cx = '0x' + '02'.repeat(32), cy = '0x' + '03'.repeat(32);
  const owner = '0x' + '04'.repeat(32), locker = '0x' + '05'.repeat(32);
  const blind = stealth.stealthLockLeafBlind(asset, cx, cy, owner, 100, locker);
  assert.equal(blind, stealth.stealthLockLeafBlind(asset, cx, cy, owner, 100, locker), 'deterministic');
  for (const amt of [0, 1, 100, '18446744073709551615']) {
    assert.notEqual(blind, stealth.stealthLockLeaf(asset, cx, cy, owner, amt, 100, locker), `domain-separated vs amount ${amt}`);
  }
  assert.notEqual(blind, stealth.stealthLockLeafBlind(asset, cx, cy, owner, 101, locker), 'deadline bound');
  ok('blind stealth leaf: deterministic + domain-separated + deadline-bound');
}

console.log(`\n${n} blind-primitive checks passed`);
