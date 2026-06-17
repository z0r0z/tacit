#!/usr/bin/env node
// Mode-B reverse-reflection reflect-exec (ETH→BTC). Unlike the forward crossout gen (mode_b=0, every 0x65
// skips), this drives the guest's mode_b=1 path end-to-end: a SYNTHETIC eth-reflection PV (the genesis
// sync-committee anchor + a crossOutSetRoot + a consumedNuSetRoot) is verify_sp1_proof-bound by the guest
// (a DEFERRED claim — the SP1 executor records (vkey, sha256(pv)) but does NOT need the inner Compressed
// proof at exec time), so the fold logic runs without a real recursive proof. The batch:
//   (1) FAST LANE: folds one eth-consumed ν (a Bitcoin note spent by an Ethereum value-exit) into the spent
//       set BEFORE the block scan — removes the source UTXO from `live` (Ethereum-senior void) + marks ν spent.
//   (2) CROSS-OUT MINT: a T_CROSSOUT_MINT (0x65) whose note IS a crossOutSet member → fold_crossout ONBOARDS
//       it (note tree + live).
// The JS assembler mirrors both folds; the guest's committed newDigest MUST equal the assembler's — the
// reflect-exec parity proof for the Mode-B mirrors (foldConsumed + foldCrossout + the mode_b=1 assembler).
//   node tests/gen-reflection-modeb-synth.mjs > /tmp/modeb-reflect-input.json
//   (then reflect-exec with REFLECT_ELF=<reflection ELF> over the JSON to assert DIGEST_MATCH)

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

const OWNER = '0x' + '00'.repeat(32);                         // crossout / consumed notes are owner-free
const BLOCK_HEIGHT = 318000;

// ── (1) Seed a PRIOR live note (onboarded in some earlier cycle) — the consume source ──
const ASSET_SRC = '0x' + 'a2'.repeat(32);
const { cx: srcCx, cy: srcCy } = pool.commitXY(80000n, 0x5EEDn);
const srcTxid = '0x' + 'd1'.repeat(32);
const srcVout = 0;
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.foldOutput(pool.leaf(ASSET_SRC, srcCx, srcCy, OWNER), pool.outpointKey(srcTxid, srcVout), pool.commitmentHash(srcCx, srcCy), ASSET_SRC);
const before = state.counts();

// The eth consumed-ν set: leaf = keccak(ν ‖ spendRoot); a single-member append-only keccak tree.
const nu = pool.nullifier(srcCx, srcCy);
const spendRoot = '0x' + '7e'.repeat(32);
const consumedLeaf = pool.ethConsumedLeaf(nu, spendRoot);
const consumedSetPath = pool.merklePath([consumedLeaf], 0);
const consumedSetRoot = pool.merkleRootFrom(consumedLeaf, 0, consumedSetPath);

// ── (2) The cross-out MINT (0x65): a note whose dest_commitment is a crossOutSet member ──
const ASSET_CO = '0x' + 'a1'.repeat(32);
const CLAIM = '0x' + 'c1'.repeat(32);
const { cx: coCx, cy: coCy } = pool.commitXY(50000n, 0xC0DEn);
const destCommitment = pool.leaf(ASSET_CO, coCx, coCy, OWNER);             // owner=0 — the Bitcoin reflected leaf
const crossoutLeaf = pool.ethCrossoutLeaf(CLAIM, pool.DEST_CHAIN_BITCOIN, destCommitment, ASSET_CO);
const crossoutSetPath = pool.merklePath([crossoutLeaf], 0);
const crossoutSetRoot = pool.merkleRootFrom(crossoutLeaf, 0, crossoutSetPath);

// 0x65 envelope: opcode ‖ asset(32) ‖ claim_id(32) ‖ Cx(32) ‖ Cy(32) ‖ owner(32) = 161 bytes.
const envelope = cat([[0x65], hb(ASSET_CO), hb(CLAIM), hb(coCx), hb(coCy), hb(OWNER)]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const dummyTxid = Buffer.alloc(32, 0x65);
const inputsBuf = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]); // vout 0 = the mint slot
const txid = computeTxid(tx);
const header = mineHeader(computeMerkleRoot([txid]));

const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + dummyTxid.toString('hex'), vout: 0 }],
  env: { type: 'crossout_mint', asset: ASSET_CO, claimId: CLAIM, cx: coCx, cy: coCy, owner: OWNER, membership: { setIndex: 0, setPath: crossoutSetPath } },
};

const modeB = {
  crossoutSetRoot, consumedSetRoot,
  consumed: [{ cx: srcCx, cy: srcCy, srcTxid, srcVout, spendRoot, setPath: consumedSetPath }],
};

const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [txSpec] }], modeB,
}, new Map());

// Expected state transition: src consumed (live −1, spent +1, consumedCount 0→1), crossout onboarded
// (note +1, live +1) ⇒ net note +1, live unchanged, spent +1, consumedCount 1.
const after = state.counts();
const cm = input.blocks[0].txs[0].crossoutMint;
const ethPvLen = (input.ethPv || '').replace(/^0x/, '').length / 2;
const checks = {
  modeB: input.modeB === 1,
  ethPv352: ethPvLen === 352,
  consumed1: Array.isArray(input.consumed) && input.consumed.length === 1,
  crossoutWitness: !!cm && cm.setPath.length === 32 && cm.notePath.length === 32 && cm.setIndex === 0,
  noteUp1: after.note === before.note + 1,
  liveSame: after.live === before.live,        // −1 consume +1 mint
  spentUp1: after.spent === before.spent + 1,
};
const allOk = Object.values(checks).every(Boolean);
console.error(`mode-b reverse: ${JSON.stringify(checks)} (note ${before.note}->${after.note} live ${before.live}->${after.live} spent ${before.spent}->${after.spent}) newDigest=${input.newDigest}`);
if (!allOk) { console.error('FATAL: mode-b assembler did not fold consume+crossout as expected'); process.exit(1); }
console.log(JSON.stringify(input));
