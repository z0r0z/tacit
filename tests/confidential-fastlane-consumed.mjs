#!/usr/bin/env node
// FAST LANE: the dapp/worker JS mirror `foldConsumed` (a Bitcoin-homed note consumed by an Ethereum
// value-exit, reverse-reflected back via Mode B) must reproduce the SAME state transition the
// reflection guest's cxfer-core `ScanReflection::fold_consumed` commits:
//   1. ν binds (Cx,Cy)            — ν == nullifier(Cx,Cy), so a note has exactly one nullifier
//   2. the source UTXO is voided  — removed from the live set (Ethereum-senior: a racing Bitcoin spend
//                                   this cycle finds the outpoint ABSENT and is itself voided)
//   3. ν enters the spent set     — folded so the note cannot be respent on Bitcoin
//   4. the consumed count advances — it rides digest(), so a resumed scan that drops it diverges
// and SKIPS (returns null, no state change) on each of the fold's gates. This host KAT drives the real
// exported state engine (makeScanReflectionState) with the pool's own ν / commitment / outpoint
// primitives, so it asserts the transition + the gates with zero risk of mirror drift — and needs no
// re-proven artifact. The full reflect-exec fixture (a real consume vs a voided racing spend vs a
// stale-proof rejection) is the post-prove step.
//
// Run: node tests/confidential-fastlane-consumed.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
// the pool's own primitives — foldConsumed recomputes ν / commitmentHash / outpointKey internally,
// so using the exported ones guarantees the KAT agrees with the engine byte-for-byte.
const { nullifier, commitmentHash, outpointKey, leaf, commitXY, makeScanReflectionState } = pool;

const ASSET = '0x' + 'a1'.repeat(32);
const OWNER = '0x' + '00'.repeat(32);
const TXID = '0x' + '11'.repeat(32);
const VOUT = 3;

// Seed (Cx,Cy) as a live UTXO at (txid,vout), exactly as a reflection output fold would (foldOutput
// takes the precomputed outpoint key + the commitment hash + the note's asset). foldConsumed checks
// ν↔(Cx,Cy) + the live binding, NOT the commitment's opening (that is the guest's range job), so a
// plain Pedersen commitment over any (value,blinding) is a sound input for this transition KAT.
const seedLive = (st, cx, cy, txid = TXID, vout = VOUT, asset = ASSET, owner = OWNER) =>
  st.foldOutput(leaf(asset, cx, cy, owner), outpointKey(txid, vout), commitmentHash(cx, cy), asset);

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`ok   ${msg}`); else { console.error(`FAIL ${msg}`); failures++; } };

// ── 1. the consume transition: void live + spend ν + advance count ──────────────────────────────
{
  const st = makeScanReflectionState();
  const { cx, cy } = commitXY(100n, 7n);
  seedLive(st, cx, cy);
  const nu = nullifier(cx, cy);
  const d0 = st.digest();
  const liveBefore = st.counts().live;

  const w = st.foldConsumed(nu, cx, cy, TXID, VOUT);
  ok(w != null, 'foldConsumed returns a spent-insert witness for a live, ν-bound note');
  ok(st.spentContains(nu), 'ν entered the spent set (the note cannot be respent on Bitcoin)');
  ok(st.live.get(outpointKey(TXID, VOUT)) == null, 'the source UTXO was voided live (Ethereum-senior)');
  ok(st.counts().live === liveBefore - 1, 'the live set shrank by exactly one');
  ok(st.getConsumedCount() === 1n, 'consumed count advanced 0 → 1');
  ok(st.digest() !== d0, 'digest() changed (spent + live + consumedCount all ride it)');

  // 2. the racing-spend void: a second consume of the same outpoint finds it absent → skip
  const cnt = st.getConsumedCount();
  const w2 = st.foldConsumed(nu, cx, cy, TXID, VOUT);
  ok(w2 == null, 'a second consume of the same outpoint is voided (the live UTXO is already gone)');
  ok(st.getConsumedCount() === cnt, 'the voided re-consume did not advance the count');
}

// ── 3. gate: ν must bind (Cx,Cy) ────────────────────────────────────────────────────────────────
{
  const st = makeScanReflectionState();
  const { cx, cy } = commitXY(200n, 9n);
  seedLive(st, cx, cy);
  const other = commitXY(201n, 10n);
  const wrongNu = nullifier(other.cx, other.cy); // a different note's ν
  const r = st.foldConsumed(wrongNu, cx, cy, TXID, VOUT);
  ok(r == null, 'a ν that does not bind the presented (Cx,Cy) is rejected');
  ok(!st.spentContains(wrongNu) && st.getConsumedCount() === 0n && st.counts().live === 1, 'no state change on the ν-mismatch skip');
}

// ── 4. gate: the source must be a live UTXO ─────────────────────────────────────────────────────
{
  const st = makeScanReflectionState();
  const { cx, cy } = commitXY(300n, 11n); // deliberately NOT seeded live
  const r = st.foldConsumed(nullifier(cx, cy), cx, cy, TXID, VOUT);
  ok(r == null, 'a note that is not a live UTXO is rejected (there is nothing to void)');
  ok(st.getConsumedCount() === 0n && !st.spentContains(nullifier(cx, cy)), 'no state change on the not-live skip');
}

// ── 5. gate: the live outpoint must be bound to the presented commitment (no cross-note consume) ─
{
  const st = makeScanReflectionState();
  const a = commitXY(400n, 12n); // the outpoint actually holds note A
  const b = commitXY(401n, 13n); // we present note B's ν + coords
  seedLive(st, a.cx, a.cy);
  const r = st.foldConsumed(nullifier(b.cx, b.cy), b.cx, b.cy, TXID, VOUT);
  ok(r == null, 'an outpoint bound to a different commitment is rejected (gate 1 passes, gate 2 binds)');
  ok(st.getConsumedCount() === 0n && !st.spentContains(nullifier(b.cx, b.cy)) && st.counts().live === 1, 'no state change on the binding mismatch');
}

// ── 6. resume safety: consumedCount rides digest() ──────────────────────────────────────────────
{
  const a = makeScanReflectionState();
  const b = makeScanReflectionState();
  ok(a.digest() === b.digest(), 'two fresh empty states share a digest');
  b.setConsumedCount(1);
  ok(a.digest() !== b.digest(), 'setConsumedCount changes digest() — a resumed scan MUST carry it (the guest pins it last) or guest↔JS diverge');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS — fast-lane foldConsumed mirror');
process.exit(failures ? 1 : 0);
