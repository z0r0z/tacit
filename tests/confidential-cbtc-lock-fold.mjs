#!/usr/bin/env node
// cBTC.zk sats-lock fold — JS mirror of cxfer-core fold_cbtc_lock / fold_cbtc_lock_spends. Validates the
// fold LOGIC + GATES (accept a valid lock; reject wrong-asset / vout-0 / value-mismatch / bad-sigma) and
// the self-custody rug path (spending the lock drops the backing), plus JS determinism. The fold is built
// on already-parity-validated primitives (leaf / foldOutput / outpointKey / commitmentHash / u64be /
// verifyOpeningSigma); end-to-end guest-digest parity for the lock-CONTEXT encoding is confirmed by the
// reflect-exec fixture in the live-wiring step. Run: node tests/confidential-cbtc-lock-fold.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const asset = pool.CBTC_ZK_ASSET_ID;
const lockTxid = '0x' + 'a7'.repeat(32);
const lockVout = 1;
const vBtc = 50000n;
const r = 0x1234567890abcdefn;
const { cx, cy } = pool.commitXY(vBtc, r);

// The locker's opening sigma over the lock-bound context, split into the affine (rx,ry) the guest reads.
function sigFor(amount, blinding) {
  const ctx = pool.cbtcLockContext(asset, lockTxid, lockVout);
  const sg = pool.openingSigma(amount, blinding, ctx, pool.deriveOpeningNonce(blinding, ctx, 'cbtc-lock'));
  const R = secp.ProjectivePoint.fromHex(sg.R.replace(/^0x/, '')).toAffine();
  return { sigRx: '0x' + R.x.toString(16).padStart(64, '0'), sigRy: '0x' + R.y.toString(16).padStart(64, '0'), sigZ: sg.z };
}
const validLock = { asset, cx, cy, vBtc, lockVout, lockTxid, ...sigFor(vBtc, r) };
const fresh = () => pool.makeScanReflectionState();

// ── accept ──
const st = fresh();
const g0 = st.digest();
const w = st.foldCbtcLock(validLock);
ok(w && w.notePath, 'valid lock folds (returns the note-path witness)');
eq(st.cbtcBackingSats(), vBtc, 'backing == the locked sats');
eq(st.cbtcLocks.len(), 1, 'lock outpoint tracked');
eq(st.counts().note, 1, 'owner-free cBTC note appended to the tree');
ok(st.digest() !== g0, 'digest advanced past genesis');

// ── determinism (JS self-consistency) ──
const st2 = fresh();
st2.foldCbtcLock(validLock);
eq(st2.digest(), st.digest(), 'deterministic: same lock → same digest');

// ── gates reject (each on a fresh state; null = skip, no mutation) ──
eq(fresh().foldCbtcLock({ ...validLock, asset: '0x' + '11'.repeat(32) }), null, 'wrong asset → skip');
eq(fresh().foldCbtcLock({ ...validLock, lockVout: 0 }), null, 'lock vout 0 → skip (would collide with the note outpoint)');
eq(fresh().foldCbtcLock({ ...validLock, vBtc: vBtc + 1n }), null, 'value mismatch (sig over vBtc, fold claims vBtc+1) → skip');
eq(fresh().foldCbtcLock({ ...validLock, sigZ: '0x' + 'de'.repeat(32) }), null, 'tampered sigma z → skip');

// ── self-custody rug: spending the lock outpoint drops the backing ──
const removed = st.foldCbtcLockSpends([{ prevTxid: lockTxid, vout: lockVout }]);
eq(removed, vBtc, 'rug removed the locked sats');
eq(st.cbtcBackingSats(), 0n, 'backing dropped to 0 after the rug');
eq(st.cbtcLocks.len(), 0, 'lock outpoint removed');

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
