#!/usr/bin/env node
// Build a full-scan reflection prover input around a SYNTHETIC cBTC.zk sats-lock (T_CBTC_LOCK 0x66) tx so
// the reflection guest folds it and MUST land on the same newDigest the JS assembler computes — the
// reflect-exec guest↔JS digest-parity check for the cBTC fold. One easy-PoW 1-tx block: a lock output
// (v_btc sats) at vout 1, the owner-free note commitment in the envelope, the locker's opening sigma as the
// witness. Mirrors gen-reflection-cxfer-synth.mjs.
//   node tests/gen-reflection-cbtc-synth.mjs > /tmp/cbtc-reflect-input.json

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
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const ASSET = pool.CBTC_ZK_ASSET_ID;       // the one canonical cBTC.zk id (foldCbtcLock gates on it)
const BLOCK_HEIGHT = 308000;
const vBtc = 123456n;
const r = 0xC0FFEEn;
const lockVout = 1;
const { cx, cy } = pool.commitXY(vBtc, r);

// 0x66 envelope: opcode ‖ asset(32) ‖ lock_vout(4 LE) ‖ Cx(32) ‖ Cy(32) — parse_cbtc_lock_envelope.
const envelope = cat([[0x66], hb(ASSET), u32le(lockVout), hb(cx), hb(cy)]);
// Taproot tapscript carrying "TACIT"+v1 ‖ envelope (extract_taproot_envelope strips the frame).
const tapscript = cat([
  [0x20], Buffer.alloc(32), [0xac], [0x00, 0x63],
  [0x05], Buffer.from('TACIT'), [0x01, 0x01],
  [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope,
  [0x68],
]);
const dummyTxid = Buffer.alloc(32, 0xcc); // a non-pool input (no live-set hit, no cBTC-lock spend)
const inputsBuf = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
  varint(1), inputsBuf,
  [0x02], Buffer.alloc(8), [0x00], u64le(vBtc), [0x00], // vout0 (note slot, 0 sats) + vout1 (the lock, v_btc sats)
  wit0,
  Buffer.alloc(4),
]);
const txid = computeTxid(tx);
const txidHex = '0x' + Buffer.from(txid).toString('hex');
const header = mineHeader(computeMerkleRoot([txid]));

// The locker's opening sigma over the lock-bound context (asset ‖ lock_txid ‖ lock_vout), split into R(x,y).
const ctx = pool.cbtcLockContext(ASSET, txidHex, lockVout);
const sg = pool.openingSigma(vBtc, r, ctx, pool.deriveOpeningNonce(r, ctx, 'cbtc-lock'));
const R = secp.ProjectivePoint.fromHex(sg.R.replace(/^0x/, '')).toAffine();
const sigRx = '0x' + R.x.toString(16).padStart(64, '0');
const sigRy = '0x' + R.y.toString(16).padStart(64, '0');

const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: txidHex,
  vins: [{ prevTxid: '0x' + dummyTxid.toString('hex'), vout: 0 }],
  env: { type: 'cbtc_lock', asset: ASSET, lockVout, cx, cy, vBtc, sigRx, sigRy, sigZ: sg.z },
};
const input = pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [txSpec] }],
}, new Map());

const folded = !!input.blocks[0].txs[0].cbtcLock;
console.error(`cBTC lock: v_btc=${vBtc} lockVout=${lockVout} folded=${folded} newDigest=${input.newDigest}`);
if (!folded) { console.error('FATAL: cBTC lock was not folded (gate failed) — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
