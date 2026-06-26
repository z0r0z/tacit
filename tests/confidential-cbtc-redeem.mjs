// Validates the JS cBTC redeem mirror (dapp/confidential-pool.js foldCbtcRedeem) — the digest-side companion
// to the cargo-tested cxfer-core fold_cbtc_redeem. Exercises the new fold's scope + every gate: a valid
// single-tx redeem retires the lock (never slashable); a forged burn / un-unlocked / untracked / mismatched
// redeem is rejected and leaves the lock tracked (so a bare spend folds it as a rug). The positive-burn
// kernel parity (guest↔JS) is the reflect-exec DIGEST_MATCH harness's job; here we pin the gating + scope.
// Run: node tests/confidential-cbtc-redeem.mjs
import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

const cp = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const st = cp.makeScanReflectionState();

const CBTC = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
const lockTxid = '0x' + '22'.repeat(32);
const lockVout = 1;
const vBtc = 100000n;
const G = secp.ProjectivePoint.BASE.toAffine(); // a real curve point for the lock's pre-committed commitment
const cx = '0x' + G.x.toString(16).padStart(64, '0');
const cy = '0x' + G.y.toString(16).padStart(64, '0');

// Track the lock → backing accrued (the OP_CBTC_MINT gate is set; the lock is now slashable-on-bare-spend).
assert.ok(st.foldCbtcLock({ asset: CBTC, cx, cy, vBtc: Number(vBtc), lockVout, lockTxid }), 'lock folds');
assert.strictEqual(st.cbtcBackingSats(), vBtc, 'backing accrued');

const txVins = [{ prevTxid: lockTxid, vout: lockVout }]; // the redeem tx unlocks the lock
const inOutpoints = [['0x' + '11'.repeat(32), 0]];
const inPoints = [secp.ProjectivePoint.BASE];
const badSig = '0x' + '00'.repeat(64);

// Every spoof must REJECT (null) and leave the lock tracked (backing unchanged ⇒ still slashable as a rug).
assert.strictEqual(st.foldCbtcRedeem({ lockTxid, lockVout, vBtc, txVins, inOutpoints, inPoints, kernelSig: badSig }), null, 'forged burn rejected');
assert.strictEqual(st.foldCbtcRedeem({ lockTxid, lockVout, vBtc, txVins: [], inOutpoints, inPoints, kernelSig: badSig }), null, 'no in-tx unlock rejected');
assert.strictEqual(st.foldCbtcRedeem({ lockTxid, lockVout, vBtc: 0n, txVins, inOutpoints, inPoints, kernelSig: badSig }), null, 'zero value rejected');
assert.strictEqual(st.foldCbtcRedeem({ lockTxid, lockVout, vBtc: vBtc + 1n, txVins, inOutpoints, inPoints, kernelSig: badSig }), null, 'value mismatch rejected');
const otherTxid = '0x' + 'ff'.repeat(32);
assert.strictEqual(st.foldCbtcRedeem({ lockTxid: otherTxid, lockVout: 5, vBtc, txVins: [{ prevTxid: otherTxid, vout: 5 }], inOutpoints, inPoints, kernelSig: badSig }), null, 'untracked lock rejected');

assert.strictEqual(st.cbtcBackingSats(), vBtc, 'a rejected redeem never retires the lock / touches backing');
console.log('confidential cBTC redeem mirror: scope + gating OK');
