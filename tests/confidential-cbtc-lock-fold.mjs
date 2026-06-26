#!/usr/bin/env node
// cBTC.zk self-custody lock fold — JS mirror of cxfer-core fold_cbtc_lock / fold_cbtc_lock_spends, in the
// TRACK-NOT-MINT model (ops/DESIGN-confidential-defi-v1.md §3): the fold TRACKS the lock + accrues backing
// and returns the per-cycle {outpoint, vBtc, commitment} delta; it does NOT mint a note (the cBTC note is
// minted later by ConfidentialPool.mintCbtc/OP_CBTC_MINT, gated on the lock + a native-ETH escrow, where the
// value-opening is checked). Validates the gates (wrong-asset / vout-0 / non-curve commitment / duplicate
// skip), the digest binding (cbtc_locks root + backing ride digest()), and the rug path (a lock spend drops
// the backing + surfaces the spent outpoint). Run: node tests/confidential-cbtc-lock-fold.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

// ── Rust↔JS constant pin: the dapp's cBTC asset id MUST match the protocol (cxfer-core), else the asset
// gate silently desyncs from the guest (cf. the REFLECTION_GENESIS_DIGEST three-way pin). ──
const rustSrc = readFileSync(new URL('../contracts/sp1/confidential/cxfer-core/src/lib.rs', import.meta.url), 'utf8');
const rustAsset = '0x' + [...rustSrc.match(/CBTC_ZK_ASSET_ID: \[u8; 32\] = \[([\s\S]*?)\];/)[1].matchAll(/0x([0-9a-fA-F]{2})/g)].map((m) => m[1]).join('');
eq(pool.CBTC_ZK_ASSET_ID, rustAsset, 'CBTC_ZK_ASSET_ID == the protocol (cxfer-core) const, byte-for-byte');

const asset = pool.CBTC_ZK_ASSET_ID;
const lockTxid = '0x' + 'a7'.repeat(32);
const lockVout = 1;
const vBtc = 50000n;
const r = 0x1234567890abcdefn;
const { cx, cy } = pool.commitXY(vBtc, r);
const validLock = { asset, cx, cy, vBtc, lockVout, lockTxid };
const fresh = () => pool.makeScanReflectionState();
const expectOutpoint = pool.outpointKeyHex ? pool.outpointKeyHex(lockTxid, lockVout) : null;

// ── accept: TRACK (no mint) ──
const st = fresh();
const g0 = st.digest();
const d = st.foldCbtcLock(validLock);
ok(d && d.vBtc === vBtc && /^0x[0-9a-f]{64}$/.test(d.outpoint) && /^0x[0-9a-f]{64}$/.test(d.commitment),
  'valid lock tracks: returns the {outpoint, vBtc, commitment} delta');
eq(d.commitment, pool.commitmentHashHex ? pool.commitmentHashHex(cx, cy) : d.commitment, 'commitment == keccak(cx,cy)');
eq(st.cbtcBackingSats(), vBtc, 'backing == the locked sats');
eq(st.cbtcLocks.len(), 1, 'lock outpoint tracked');
eq(st.counts().note, 0, 'TRACK-not-mint: NO cBTC note appended (the contract mints it)');
ok(st.digest() !== g0, 'digest advanced past genesis (cbtc_locks root + backing ride digest)');

// ── determinism (JS self-consistency) ──
const st2 = fresh();
st2.foldCbtcLock(validLock);
eq(st2.digest(), st.digest(), 'deterministic: same lock → same digest');

// ── gates reject (each on a fresh state; null = skip, no mutation) ──
eq(fresh().foldCbtcLock({ ...validLock, asset: '0x' + '11'.repeat(32) }), null, 'wrong asset → skip');
eq(fresh().foldCbtcLock({ ...validLock, vBtc: 0n }), null, 'zero-value lock → skip');
eq(fresh().foldCbtcLock({ ...validLock, lockVout: 0 }), null, 'lock vout 0 → skip');
eq(fresh().foldCbtcLock({ ...validLock, cx: '0x' + '00'.repeat(31) + '01', cy: '0x' + '00'.repeat(31) + '01' }), null, 'off-curve commitment (1,1) → skip (matches the guest from_affine_xy)');
// duplicate outpoint → one lock backs one mint
const stDup = fresh();
stDup.foldCbtcLock(validLock);
eq(stDup.foldCbtcLock(validLock), null, 'duplicate lock outpoint → skip');

// ── self-custody rug: spending the lock outpoint drops the backing + surfaces the spent outpoint ──
const res = st.foldCbtcLockSpends([{ prevTxid: lockTxid, vout: lockVout }]);
eq(res.removed, vBtc, 'rug removed the locked sats');
ok(Array.isArray(res.spent) && res.spent.length === 1 && /^0x[0-9a-f]{64}$/.test(res.spent[0]), 'rug surfaces the spent outpoint');
eq(st.cbtcBackingSats(), 0n, 'backing dropped to 0 after the rug');
eq(st.cbtcLocks.len(), 0, 'lock outpoint removed');

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
