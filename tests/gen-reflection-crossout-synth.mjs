#!/usr/bin/env node
// Forward-batch reflect-exec for T_CROSSOUT_MINT (0x65, Mode-B reverse). In a mode_b=0 batch the guest reads
// the 0x65 witnesses (the cross-out IMT presence proof, note_path, consumed insert) but fold_crossout returns
// at the forward sentinel (crossout_set_root=0), onboarding nothing. The JS assembler mirrors that — emits the
// witnesses + skips — so
// newDigest is unchanged (only height advances) and MUST equal the guest's: the reflect-exec parity check for
// the forward crossout skip (so a confirmed reverse-mint, or a crafted 0x65, no longer makes the forward
// attester refuse the block). The mode_b=1 ONBOARDING is the separate reverse-prove path.
//   node tests/gen-reflection-crossout-synth.mjs > /tmp/crossout-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const ASSET = '0x' + 'a1'.repeat(32), CLAIM = '0x' + 'c1'.repeat(32), OWNER = '0x' + '00'.repeat(32);
const BLOCK_HEIGHT = 317000;
const { cx, cy } = pool.commitXY(50000n, 0xC0DEn); // the would-be mint note (skipped in a forward batch)

// 0x65 envelope: opcode ‖ asset(32) ‖ claim_id(32) ‖ Cx(32) ‖ Cy(32) ‖ owner(32) = 161 bytes.
const envelope = cat([[0x65], hb(ASSET), hb(CLAIM), hb(cx), hb(cy), hb(OWNER)]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const dummyTxid = Buffer.alloc(32, 0x65);
const inputsBuf = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]); // vout 0 = the mint slot (0 sats)
const txid = computeTxid(tx);
const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
const header = mineHeader(computeMerkleRoot([cbTxid, txid]));

const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
const before = state.counts(); // genesis baseline (spent/burn sets carry a sentinel leaf, so these aren't 0)
const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + dummyTxid.toString('hex'), vout: 0 }],
  env: { type: 'crossout_mint', asset: ASSET, claimId: CLAIM, cx, cy, owner: OWNER },
};
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }],
}, new Map());

const cm = input.blocks[0].txs[1].crossoutMint;
// skip ⇒ note/spent/live/burn unchanged vs the genesis baseline; only height advanced.
const c = state.counts();
const unchanged = c.note === before.note && c.spent === before.spent && c.live === before.live && c.burn === before.burn;
console.error(`crossout_mint forward skip: witness=${!!cm} mPath=${cm ? cm.mPath.length : 0} notePath=${cm ? cm.notePath.length : 0} stateUnchanged=${unchanged} (note ${before.note}->${c.note} spent ${before.spent}->${c.spent} burn ${before.burn}->${c.burn}) newDigest=${input.newDigest}`);
if (!cm || cm.mPath.length !== 32 || cm.notePath.length !== 32) { console.error('FATAL: crossout witness not emitted with the 2 32-sibling paths'); process.exit(1); }
if (!unchanged) { console.error('FATAL: crossout was NOT a skip — it mutated state (a forward batch must onboard nothing)'); process.exit(1); }
console.log(JSON.stringify(input));
