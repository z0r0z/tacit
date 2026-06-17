#!/usr/bin/env node
// Mode-B reflect-exec through the PRODUCTION indexer path (G3 end-to-end). Unlike gen-reflection-modeb-synth
// (which calls the assembler directly), this drives the worker's makeScanReflectionIndexer.assembleBlocks
// with a worker-shaped block (txidDisplay/rawHex/vins/decode) carrying a T_CROSSOUT_MINT (0x65) + an eth
// proof bundle — exercising the assembleBlocks wiring (collect the 0x65 txs → buildModeBBatch → stamp each
// env.membership → batch.modeB). A crossout-only batch (no consumed-ν, so no live-source resolution needed);
// the note onboards into an empty pool. The guest's committed newDigest MUST equal the indexer assembler's.
//   node tests/gen-reflection-modeb-indexer.mjs > /tmp/modeb-indexer-input.json
//   (then reflect-exec with REFLECT_ELF=<reflection ELF> to assert DIGEST_MATCH)

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
const pool = makeConfidentialPool(deps);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
const reverseHex = (h) => h.replace(/^0x/, '').match(/../g).reverse().join('');

const OWNER = '0x' + '00'.repeat(32);
const ZERO_ROOT = '0x' + '00'.repeat(32);
const BLOCK_HEIGHT = 319000;

// The cross-out MINT (0x65): a note whose dest_commitment is the lone crossOutSet member.
const ASSET_CO = '0x' + 'a1'.repeat(32);
const CLAIM = '0x' + 'c1'.repeat(32);
const { cx: coCx, cy: coCy } = pool.commitXY(50000n, 0xC0DEn);
const destCommitment = pool.leaf(ASSET_CO, coCx, coCy, OWNER);
const coLeaf = pool.ethCrossoutLeaf(CLAIM, pool.DEST_CHAIN_BITCOIN, destCommitment, ASSET_CO);
const coRoot = pool.merkleRootFrom(coLeaf, 0, pool.merklePath([coLeaf], 0));

const envelope = cat([[0x65], hb(ASSET_CO), hb(CLAIM), hb(coCx), hb(coCy), hb(OWNER)]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const dummyTxid = Buffer.alloc(32, 0x65);
const inputsBuf = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
const rawHex = tx.toString('hex');
const txidInternal = '0x' + Buffer.from(computeTxid(tx)).toString('hex');
const txidDisplay = reverseHex(txidInternal);          // the worker hands display-order txids
const header = mineHeader(computeMerkleRoot([computeTxid(tx)]));

// The worker block-tx shape: classifyConfidentialTx parses the 0x65 → a crossout_mint decode.
const decode = classifyConfidentialTx('0x' + rawHex);
if (!decode || decode.type !== 'crossout_mint') { console.error('FATAL: 0x65 did not classify to crossout_mint'); process.exit(1); }
const block = { txs: [{ txidDisplay, rawHex, vins: [{ prevTxidDisplay: reverseHex('0x' + dummyTxid.toString('hex')), vout: 0 }], decode }] };

// The eth proof bundle (eth_prove emits it alongside eth_pv.hex). One crossout, no consumed-ν.
const ethBundle = {
  ethPv: pool.buildEthPv(coRoot, ZERO_ROOT, 0),
  crossouts: [{ claimId: CLAIM, destCommitment, asset: ASSET_CO }],
  consumeds: [],
};

const idx = makeScanReflectionIndexer(deps);
const input = await idx.assembleBlocks([block], {
  headers: ['0x' + Buffer.from(header).toString('hex')], anchorHeight: BLOCK_HEIGHT, ethBundle, consumedSources: [],
});

const cm = input.blocks[0].txs[0].crossoutMint;
const checks = {
  modeB: input.modeB === 1,
  ethPvFromBundle: input.ethPv === ethBundle.ethPv,
  membershipStamped: !!cm && cm.setIndex === 0 && cm.setPath.length === 32 && cm.notePath.length === 32,
  onboarded: idx.liveCount() === 1,                    // the crossout note entered the live set
  noConsumed: !input.consumed || input.consumed.length === 0,
};
const allOk = Object.values(checks).every(Boolean);
console.error(`mode-b via indexer.assembleBlocks: ${JSON.stringify(checks)} liveCount=${idx.liveCount()} newDigest=${input.newDigest}`);
if (!allOk) { console.error('FATAL: indexer assembleBlocks did not assemble a mode_b=1 crossout onboard'); process.exit(1); }
console.log(JSON.stringify(input));
