// Parity guard for the membership-gated reflection dedup (commitment-collision DoS class).
//
// An attacker can mint two notes that share a commitment (equal value+blinding) → they share a single
// nullifier ν. Spending or bridging-out BOTH in one batch makes the reflection fold ν twice. A naive IMT
// re-insert has no straddling low node → returns None → the guest `.expect()` PANICS → the forward-only
// reflection bricks permanently (a fund-strand DoS). The guest folds a duplicate as a membership-GATED
// no-op (sentinel: low_key/low_value == ν, impossible for a real insert), and the JS producer MUST emit
// that exact sentinel — else a dup block can't be produced and the DoS still stands end-to-end.
//
// This asserts the producer (makeScanReflectionState, the engine worker/reflection-attest.js runs) emits
// the sentinel for a duplicate, doesn't throw, and is a no-op — for BOTH the burn set (gap A) and the
// spent set (the 44216b3 fix), using the pool's own ν primitive so there is no mirror drift.
//
// Run: node tests/confidential-reflection-dedup.test.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const _cat = (arrs) => { const t = arrs.reduce((n, a) => n + a.length, 0); const o = new Uint8Array(t); let i = 0; for (const a of arrs) { o.set(a, i); i += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const { nullifier, commitXY, makeScanReflectionState } = pool;

// Two equal-commitment notes → one shared ν (the collision an attacker crafts).
const { cx, cy } = commitXY(1000n, 0x9e3779b97f4a7c15n);
const nu = nullifier(cx, cy);
const dest1 = '0x' + '22'.repeat(32);
const dest2 = '0x' + '33'.repeat(32); // a different dest on the second bridge-out — must be IGNORED (first wins)

// ── burn set (gap A: fold_burn membership-gated dedup) ──
{
  const st = makeScanReflectionState();
  const w1 = st.foldBurn(nu, dest1);
  assert.notStrictEqual(w1.bLowKey, nu, 'first bridge-out is a real insert (low_key < ν, not the sentinel)');
  const digAfter1 = st.digest();
  let w2;
  assert.doesNotThrow(() => { w2 = st.foldBurn(nu, dest2); }, 'duplicate bridge-out must NOT throw (this was the DoS)');
  assert.strictEqual(w2.bLowKey, nu, 'duplicate bridge-out emits the membership sentinel (low_key == ν)');
  assert.strictEqual(w2.bLowValue, dest1, 'sentinel proves ν → dest1 (the FIRST bridge-out wins; second dest ignored)');
  assert.strictEqual(st.digest(), digAfter1, 'duplicate bridge-out is a no-op (burn root / digest unchanged)');
}

// ── spent set (44216b3: fold_spent membership-gated dedup) — same shape, regression guard ──
{
  const st = makeScanReflectionState();
  const w1 = st.foldSpent(nu);
  assert.notStrictEqual(w1.sLowValue, nu, 'first spend is a real insert (low_value < ν, not the sentinel)');
  const digAfter1 = st.digest();
  let w2;
  assert.doesNotThrow(() => { w2 = st.foldSpent(nu); }, 'duplicate spend must NOT throw');
  assert.strictEqual(w2.sLowValue, nu, 'duplicate spend emits the membership sentinel (low_value == ν)');
  assert.strictEqual(st.digest(), digAfter1, 'duplicate spend is a no-op (spent root / digest unchanged)');
}

console.log('PASS: reflection dedup parity — burn-set (gap A) + spent-set (44216b3)');
