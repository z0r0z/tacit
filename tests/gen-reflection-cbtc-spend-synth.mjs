#!/usr/bin/env node
// Build a full-scan reflection input that TRACKS a cBTC.zk lock (block 0) then SPENDS its outpoint (block 1) —
// the self-custody rug path. The guest's fold_cbtc_lock_spends removes the lock from cbtc_locks and drops
// cbtc_backing_sats (both ride digest()), so this is the reflect-exec guest↔JS digest-parity check for the
// cbtc-lock-spend fold (the other half of gen-reflection-cbtc, which only covers the lock TRACK). Two blocks
// in one scan ⇒ no resume-of-locks needed; each block carries a coinbase (the guest extracts envelopes only
// for ti != 0).
//   node tests/gen-reflection-cbtc-spend-synth.mjs > /tmp/cbtc-spend-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx, dsha256 } from './btc-mini.mjs';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const ASSET = pool.CBTC_ZK_ASSET_ID;
const BLOCK_HEIGHT = 308500;
const vBtc = 123456n;
const r = 0xC0FFEEn;
const lockVout = 1;
const { cx, cy } = pool.commitXY(vBtc, r);

// ── Block 0: the cBTC.zk lock tx (0x66), identical shape to gen-reflection-cbtc ──
const dummyTxid = Buffer.alloc(32, 0xcc);
const inputsBuf = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const makeTx = (envelope) => {
  const tapscript = cat([
    [0x20], Buffer.alloc(32), [0xac], [0x00, 0x63],
    [0x05], Buffer.from('TACIT'), [0x01, 0x01],
    [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope,
    [0x68],
  ]);
  const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
  return cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf,
    [0x02], Buffer.alloc(8), [0x00], u64le(vBtc), [0x00], // vout0 (note slot, 0 sats) + vout1 (the lock, v_btc sats)
    wit0, Buffer.alloc(4)]);
};
const noSig = cat([[0x66], hb(ASSET), u32le(lockVout), hb(cx), hb(cy)]);
const lockTxid = computeTxid(makeTx(noSig)); // witness-stripped → independent of the envelope sigma
const lockTxidHex = '0x' + Buffer.from(lockTxid).toString('hex');
const ctx = pool.cbtcLockContext(ASSET, lockTxidHex, lockVout);
const sg = pool.openingSigma(vBtc, r, ctx, pool.deriveOpeningNonce(r, ctx, 'cbtc-lock'));
const R = secp.ProjectivePoint.fromHex(sg.R.replace(/^0x/, '')).toAffine();
const sigRx = '0x' + R.x.toString(16).padStart(64, '0');
const sigRy = '0x' + R.y.toString(16).padStart(64, '0');
const lockEnv = cat([[0x66], hb(ASSET), u32le(lockVout), hb(cx), hb(cy), hb(sigRx), hb(sigRy), hb(sg.z)]);
const lockTx = makeTx(lockEnv);
const cb0 = makeCoinbaseForEnvTx(lockTx);
const header0 = mineHeader(computeMerkleRoot([cb0.cbTxid, lockTxid]));

// ── Block 1: a plain tx whose input SPENDS the lock outpoint (lockTxid:lockVout) → fold_cbtc_lock_spends ──
const spendIn = cat([lockTxid, u32le(lockVout), [0x00], [0xff, 0xff, 0xff, 0xff]]);
const spendTx = cat([[0x02, 0x00, 0x00, 0x00], varint(1), spendIn, varint(1), Buffer.alloc(8), [0x00], Buffer.alloc(4)]); // non-segwit, no envelope
const spendTxid = computeTxid(spendTx);
const cb1 = makeCoinbaseForEnvTx(spendTx);
const header1 = mineHeader(computeMerkleRoot([cb1.cbTxid, spendTxid]), 0x1f00ffff, dsha256(header0)); // chain to block 0

const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);

const lockSpec = {
  txData: '0x' + lockTx.toString('hex'), txid: lockTxidHex,
  vins: [{ prevTxid: '0x' + dummyTxid.toString('hex'), vout: 0 }],
  env: { type: 'cbtc_lock', asset: ASSET, lockVout, cx, cy, vBtc, sigRx, sigRy, sigZ: sg.z },
};
const spendSpec = {
  txData: '0x' + spendTx.toString('hex'), txid: '0x' + Buffer.from(spendTxid).toString('hex'),
  vins: [{ prevTxid: lockTxidHex, vout: lockVout }], env: null,
};

const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT,
  headers: ['0x' + Buffer.from(header0).toString('hex'), '0x' + Buffer.from(header1).toString('hex')],
  blocks: [{ txs: [cb0.coinbaseSpec, lockSpec] }, { txs: [cb1.coinbaseSpec, spendSpec] }],
}, new Map());

const locked = !!input.blocks[0].txs[1].cbtcLock;
const spent = (input.blocks[1].txs[1].cbtcLockSpends || input.blocks[1].cbtcLockSpends || []);
console.error(`cBTC lock+spend: locked=${locked} backingPost=${state.cbtcBackingSats()} locksLen=${state.cbtcLocks.len()} newDigest=${input.newDigest}`);
if (!locked) { console.error('FATAL: lock was not folded in block 0'); process.exit(1); }
if (state.cbtcBackingSats() !== 0n || state.cbtcLocks.len() !== 0) { console.error('FATAL: lock spend did not drop backing/lock (fold_cbtc_lock_spends not exercised)'); process.exit(1); }
console.log(JSON.stringify(input));
