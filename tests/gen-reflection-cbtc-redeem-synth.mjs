#!/usr/bin/env node
// Build a FULL-SCAN reflection prover input around a SYNTHETIC single-tx cBTC REDEMPTION (T_CBTC_REDEEM 0x67):
// one block [coinbase, 0x66 lock, 0x67 redeem] where the redeem tx UNLOCKS the just-folded lock AND BURNS a
// seeded cBTC note (Σ C_in = v_btc·H, the audited CXFER burn kernel). The reflection guest must fold_cbtc_redeem
// it — retiring the lock off the live set BEFORE the rug scan — and land on the SAME newDigest the JS assembler
// computes (the reflect-exec guest↔JS digest-parity check for the redeem). Mirrors gen-reflection-cxfer-synth.mjs
// (coinbase + BIP141 witness commitment) + gen-reflection-cbtc-synth.mjs (the 0x66 lock).
//   node tests/gen-reflection-cbtc-redeem-synth.mjs > /tmp/cbtc-redeem-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const dsha = (b) => sha256(sha256(b));
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const G = secp.ProjectivePoint.BASE;
const N = secp.CURVE.n;
const bytesToBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

// BIP-340 sign with private scalar d (even-y key/nonce; mirrors gen-reflection-cxfer-synth.mjs).
function taggedHash(tag, msg) { const th = sha256(new TextEncoder().encode(tag)); return sha256(_cat([th, th, msg])); }
function bip340Sign(msg, dIn) {
  let d = dIn % N; if (d === 0n) throw new Error('zero key');
  if (G.multiply(d).toAffine().y & 1n) d = N - d;
  const Px = be(G.multiply(d).toAffine().x);
  let k = bytesToBig(sha256(_cat([be(d), msg]))) % N; if (k === 0n) k = 1n;
  if (G.multiply(k).toAffine().y & 1n) k = N - k;
  const Rx = be(G.multiply(k).toAffine().x);
  const e = bytesToBig(taggedHash('BIP0340/challenge', _cat([Rx, Px, msg]))) % N;
  return _cat([Rx, be((k + e * d) % N)]);
}

const ASSET = pool.CBTC_ZK_ASSET_ID;                 // the one canonical cBTC.zk id
const ASSET_HEX = ASSET;
const ZERO_OWNER = '0x' + '00'.repeat(32);           // cBTC notes are owner-free (bearer)
const BLOCK_HEIGHT = 308100;
const vBtc = 123456n;

// ── The cBTC NOTE that the redeem burns (seeded into the prior live set at a synthetic outpoint). ──
const rNote = 0xBEEF01n;
const Cnote = pool.commit ? pool.commit(vBtc, rNote) : null; // (commit exposed below via commitXY)
const noteXY = pool.commitXY(vBtc, rNote);
const noteTxid = Buffer.alloc(32, 0xd1); // synthetic prior outpoint of the cBTC note
const noteVout = 0;

// ── The LOCK (folded by a 0x66 tx in the block; the redeem then unlocks it). ──
const rLock = 0xC0FFEEn;
const lockXY = pool.commitXY(vBtc, rLock);
const lockVout = 1;

// 0x66 lock tx (mirrors gen-reflection-cbtc-synth.mjs): a self-custody lock output (v_btc sats) at vout 1, the
// owner-free note commitment in the envelope, the locker's opening sigma as the witness — witness-stripped txid.
const lockDummyIn = Buffer.alloc(32, 0xcc);
const lockInputs = cat([lockDummyIn, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const tapWrap = (envelope) => cat([
  [0x20], Buffer.alloc(32), [0xac], [0x00, 0x63],
  [0x05], Buffer.from('TACIT'), [0x01, 0x01],
  [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope,
  [0x68],
]);
const witEnv = (envelope) => { const t = tapWrap(envelope); return cat([[0x03], [0x40], Buffer.alloc(0x40), varint(t.length), t, [0x21], Buffer.alloc(0x21, 0xc0)]); };
const makeLockTx = (envelope) => cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), lockInputs,
  [0x02], Buffer.alloc(8), [0x00], u64le(vBtc), [0x00], // vout0 (0 sats) + vout1 (the lock, v_btc sats)
  witEnv(envelope), Buffer.alloc(4),
]);
const lockNoSig = cat([[0x66], hb(ASSET), u32le(lockVout), hb(lockXY.cx), hb(lockXY.cy)]);
const lockTxidBuf = computeTxid(makeLockTx(lockNoSig)); // witness-stripped → independent of the sigma
const lockTxidHex = '0x' + Buffer.from(lockTxidBuf).toString('hex');
const lockCtx = pool.cbtcLockContext(ASSET, lockTxidHex, lockVout);
const lockSg = pool.openingSigma(vBtc, rLock, lockCtx, pool.deriveOpeningNonce(rLock, lockCtx, 'cbtc-lock'));
const lockR = secp.ProjectivePoint.fromHex(lockSg.R.replace(/^0x/, '')).toAffine();
const lockSigRx = '0x' + lockR.x.toString(16).padStart(64, '0');
const lockSigRy = '0x' + lockR.y.toString(16).padStart(64, '0');
const lockEnv = cat([[0x66], hb(ASSET), u32le(lockVout), hb(lockXY.cx), hb(lockXY.cy), hb(lockSigRx), hb(lockSigRy), hb(lockSg.z)]);
const lockTx = makeLockTx(lockEnv);

// ── The BURN kernel over the cBTC note: P = C_note − v_btc·H = rNote·G ⇒ sign with key = rNote. ──
// message: sha256("tacit-kernel-v1" ‖ asset ‖ inN=1 ‖ (noteTxid‖voutLE) ‖ outN=0 ‖ burnedLE8=v_btc)
const kMsgParts = [new TextEncoder().encode('tacit-kernel-v1'), hb(ASSET), new Uint8Array([1]), noteTxid, u32le(noteVout), new Uint8Array([0]), u64le(vBtc)];
const kernelMsg = sha256(_cat(kMsgParts.map((x) => Uint8Array.from(x))));
const kernelSig = bip340Sign(kernelMsg, rNote);

// 0x67 redeem envelope: opcode ‖ lock_txid(32) ‖ lock_vout(4 LE) ‖ v_btc(8 LE) ‖ kernel_sig(64) = 109 bytes.
const redeemEnv = cat([[0x67], lockTxidBuf, u32le(lockVout), u64le(vBtc), kernelSig]);
// Redeem tx: vin0 = the cBTC note (carries the 0x67 envelope), vin1 = the lock UTXO (unlock). 1 dummy output.
const redeemInputs = cat([
  noteTxid, u32le(noteVout), [0x00], [0xfd, 0xff, 0xff, 0xff],   // vin0: the burned cBTC note
  lockTxidBuf, u32le(lockVout), [0x00], [0xfd, 0xff, 0xff, 0xff], // vin1: the lock unlock
]);
const redeemTx = cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(2), redeemInputs,
  [0x01], Buffer.alloc(8), [0x00],          // 1 output (0 sats, empty script)
  witEnv(redeemEnv), cat([[0x01], [0x00]]), // wit0 (the envelope) + wit1 (1 empty item for the lock vin)
  Buffer.alloc(4),
]);
const lockTxid2 = computeTxid(lockTx);
const redeemTxid = computeTxid(redeemTx);

// ── Coinbase with a valid BIP141 witness commitment over [coinbase=0, lock_wtxid, redeem_wtxid]. ──
const reserved = Buffer.alloc(32, 7);
const witnessRoot = computeMerkleRoot([Buffer.alloc(32), dsha(lockTx), dsha(redeemTx)]);
const wcommit = dsha(cat([witnessRoot, reserved]));
const coinbase = cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
  [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
  [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,
  [0x01], [0x20], reserved, Buffer.alloc(4),
]);
const cbTxid = computeTxid(coinbase);
const header = mineHeader(computeMerkleRoot([cbTxid, lockTxid2, redeemTxid]));

// ── Reflection: seed the prior live set with the cBTC note, then assemble [coinbase, lock, redeem]. ──
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
const coords = new Map();
const noteOutpoint = pool.outpointKey('0x' + noteTxid.toString('hex'), noteVout);
state.foldOutput(pool.leaf(ASSET_HEX, noteXY.cx, noteXY.cy, ZERO_OWNER), noteOutpoint, pool.commitmentHash(noteXY.cx, noteXY.cy), ASSET_HEX);
coords.set(noteOutpoint.toLowerCase(), { cx: noteXY.cx, cy: noteXY.cy });

const hxs = (b) => '0x' + Buffer.from(b).toString('hex');
const coinbaseSpec = { txData: hxs(coinbase), txid: hxs(cbTxid), vins: [], env: null };
const lockSpec = {
  txData: hxs(lockTx), txid: lockTxidHex,
  vins: [{ prevTxid: hxs(lockDummyIn), vout: 0 }],
  env: { type: 'cbtc_lock', asset: ASSET, lockVout, cx: lockXY.cx, cy: lockXY.cy, vBtc, sigRx: lockSigRx, sigRy: lockSigRy, sigZ: lockSg.z },
};
const redeemSpec = {
  txData: hxs(redeemTx), txid: hxs(redeemTxid),
  vins: [{ prevTxid: hxs(noteTxid), vout: noteVout }, { prevTxid: lockTxidHex, vout: lockVout }],
  env: { type: 'cbtc_redeem', lockTxid: lockTxidHex, lockVout, vBtc, kernelSig: hxs(kernelSig) },
};
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: [hxs(header)], blocks: [{ txs: [coinbaseSpec, lockSpec, redeemSpec] }],
}, coords);

const lockFolded = !!input.blocks[0].txs[1].cbtcLock;
console.error(`cBTC redeem: v_btc=${vBtc} lockVout=${lockVout} lockFolded=${lockFolded} spends=${input.blocks[0].txs[2].openings.length} newDigest=${input.newDigest}`);
if (!lockFolded) { console.error('FATAL: lock not folded'); process.exit(1); }
console.log(JSON.stringify(input));
