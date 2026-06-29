#!/usr/bin/env node
// Mode-B reverse-reflection reflect-exec (ETH→BTC). Drives the guest's mode_b=1 path end-to-end AND tests
// the production fixture-assembly helper `buildModeBBatch` (the G3 indexer→fixture handoff). A SYNTHETIC
// eth-reflection PV (`buildEthPv`: the genesis sync-committee anchor + a crossOutSetRoot + a
// consumedNuSetRoot) stands in for the real eth proof — verify_sp1_proof is a DEFERRED claim in the SP1
// executor (records (vkey, sha256(pv)) but does NOT need the inner Compressed proof at exec time), so the
// fold logic runs without a real recursive proof. The batch:
//   (1) FAST LANE: folds one eth-consumed ν (a Bitcoin note spent by an Ethereum value-exit) into the spent
//       set BEFORE the block scan — removes the source UTXO from `live` (Ethereum-senior) + marks ν spent.
//   (2) CROSS-OUT MINT: a T_CROSSOUT_MINT (0x65) whose note IS a crossOutSet member → fold_crossout ONBOARDS.
// `buildModeBBatch` rebuilds the eth sets from the bundle + derives each leaf's FINAL membership path (the
// same code the worker's assembleBlocks runs); the JS assembler mirrors both folds; the guest's committed
// newDigest MUST equal the assembler's — the reflect-exec parity proof for the Mode-B mirrors + the handoff.
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
// The eth ConfidentialPool address the synthetic proof attests (eth_pv word 2). The guest requires a
// nonzero CANONICAL 20-byte address (reflect.rs: ep != 0 && high-12 zero) and checks word0 ==
// eth_refl_genesis_digest(ethPool), so the synthetic PV must carry it (a zeroed ethPool is the mode_b==0
// sentinel the guest rejects). buildEthPv derives pool20 + words 0/1/2 from it; on-chain it's gated
// == address(this), immaterial for an execute-mode digest-parity fixture.
const ETH_POOL = '0x' + '5a'.repeat(20);

// ── (1) Seed a PRIOR live note (onboarded in some earlier cycle) — the consume source ──
const ASSET_SRC = '0x' + 'a2'.repeat(32);
const { cx: srcCx, cy: srcCy } = pool.commitXY(80000n, 0x5EEDn);
const srcTxid = '0x' + 'd1'.repeat(32);
const srcVout = 0;
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.foldOutput(pool.leaf(ASSET_SRC, srcCx, srcCy, OWNER), pool.outpointKey(srcTxid, srcVout), pool.commitmentHash(srcCx, srcCy), ASSET_SRC);
const before = state.counts();

// ── The eth-reflection attested sets (synthetic: one consumed ν + one cross-out). buildModeBBatch rebuilds
// these leaves from the bundle below and derives the membership paths — exactly what the worker runs. ──
const nu = pool.nullifier(srcCx, srcCy);
const spendRoot = '0x' + '7e'.repeat(32);
const cnRoot = pool.merkleRootFrom(pool.ethConsumedLeaf(nu, spendRoot), 0, pool.merklePath([pool.ethConsumedLeaf(nu, spendRoot)], 0));

const ASSET_CO = '0x' + 'a1'.repeat(32);
const CLAIM = '0x' + 'c1'.repeat(32);
const { cx: coCx, cy: coCy } = pool.commitXY(50000n, 0xC0DEn);
const destCommitment = pool.leaf(ASSET_CO, coCx, coCy, OWNER);             // owner=0 — the Bitcoin reflected leaf
const coLeaf = pool.ethCrossoutLeaf(CLAIM, pool.DEST_CHAIN_BITCOIN, destCommitment, ASSET_CO);
const coImt = pool.makeImtAccumulator(); coImt.insert(coLeaf);
const coRoot = coImt.root();          // the cross-out set is an indexed-Merkle tree

// 0x65 envelope: opcode ‖ asset(32) ‖ claim_id(32) ‖ Cx(32) ‖ Cy(32) ‖ owner(32) = 161 bytes.
const envelope = cat([[0x65], hb(ASSET_CO), hb(CLAIM), hb(coCx), hb(coCy), hb(OWNER)]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const dummyTxid = Buffer.alloc(32, 0x65);
const inputsBuf = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]); // vout 0 = the mint slot
const txid = computeTxid(tx);
const txidHex = '0x' + Buffer.from(txid).toString('hex');
// Prepend a coinbase with a valid BIP141 witness commitment: the guest extracts the Taproot envelope only
// for ti != 0 (tx 0 is the coinbase), so the 0x65 mint MUST be a later tx. witnessRoot = dSHA256(coinbaseWtxid=0
// ‖ mintWtxid), mintWtxid = dSHA256(full mint tx); commitment = dSHA256(witnessRoot ‖ reserved).
const dsha = (b) => sha256(sha256(b));
const reserved = Buffer.alloc(32, 7);
const wcommit = dsha(cat([dsha(cat([Buffer.alloc(32), dsha(tx)])), reserved]));
const coinbase = cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],                                  // version, marker, flag
  [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff], // 1 coinbase input
  [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,        // 1 output: commitment
  [0x01], [0x20], reserved,                                                // witness: 32-byte reserved value
  Buffer.alloc(4),                                                         // locktime
]);
const cbTxid = computeTxid(coinbase);
const coinbaseSpec = { txData: '0x' + Buffer.from(coinbase).toString('hex'), txid: '0x' + Buffer.from(cbTxid).toString('hex'), vins: [], env: null };
const header = mineHeader(computeMerkleRoot([cbTxid, txid]));

// ── (G3) The eth proof bundle eth_prove emits alongside eth_pv.hex → the mode_b witnesses ──
const ethBundle = {
  ethPv: pool.buildEthPv(coRoot, cnRoot, 1, 1, ETH_POOL),   // synthetic eth proof PV; ethPool set (guest gates nonzero-canonical + word0==genesis(ethPool))
  crossouts: [{ claimId: CLAIM, destCommitment, asset: ASSET_CO }],
  consumeds: [{ nu, spendRoot }],
};
const { modeB } = pool.buildModeBBatch(
  ethBundle,
  [{ txid: txidHex, claimId: CLAIM }],
  [{ nu, cx: srcCx, cy: srcCy, srcTxid, srcVout }],
);

const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: txidHex,
  vins: [{ prevTxid: '0x' + dummyTxid.toString('hex'), vout: 0 }],
  env: { type: 'crossout_mint', asset: ASSET_CO, claimId: CLAIM, cx: coCx, cy: coCy, owner: OWNER },
};

const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }], modeB,
}, new Map());

// Expected state transition: src consumed (live −1, spent +1, consumedCount 0→1), crossout onboarded
// (note +1, live +1) ⇒ net note +1, live unchanged, spent +1, consumedCount 1.
const after = state.counts();
const cm = input.blocks[0].txs[1].crossoutMint; // txs[0] is the coinbase; the 0x65 mint is txs[1]
const ethPvLen = (input.ethPv || '').replace(/^0x/, '').length / 2;
const checks = {
  modeB: input.modeB === 1,
  ethPvFromBundle: input.ethPv === ethBundle.ethPv && ethPvLen === 352,
  consumed1: Array.isArray(input.consumed) && input.consumed.length === 1,
  crossoutWitness: !!cm && cm.isMember === 1 && cm.mPath.length === 32 && cm.notePath.length === 32 && cm.mIndex === 1,
  noteUp1: after.note === before.note + 1,
  liveSame: after.live === before.live,        // −1 consume +1 mint
  spentUp1: after.spent === before.spent + 1,
};
const allOk = Object.values(checks).every(Boolean);
console.error(`mode-b reverse (via buildModeBBatch): ${JSON.stringify(checks)} (note ${before.note}->${after.note} live ${before.live}->${after.live} spent ${before.spent}->${after.spent}) newDigest=${input.newDigest}`);
if (!allOk) { console.error('FATAL: mode-b assembler/handoff did not fold consume+crossout as expected'); process.exit(1); }
console.log(JSON.stringify(input));
