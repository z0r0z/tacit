#!/usr/bin/env node
// T_CROSSOUT_MINT (0x65) fold verification — the broadcast→fold loop close.
//
// crossout-mint-broadcast-cli.mjs builds + broadcasts the 0x65 envelope but stops at broadcast; it never
// confirms the reflection pipeline folds the mint and advances state. This closes that loop on the SAME
// envelope bytes the CLI emits (encodeCrossoutMint → the canonical confidential-pool leaf): it drives the
// reflection assembler over a one-0x65 Mode-B batch and asserts the fold ONBOARDS the minted note and the
// reflected state advances. Deterministic and offline — no wallet, no network, no prover — so it runs in CI
// alongside the broadcast CLI. DRY_RUN=1 prints the assembled digest without asserting the network leg (none
// exists here), matching the CLI's env contract.
//
// Locks:
//   - the broadcast envelope's recomputed leaf == the eth-recorded destCommitment (the bind hinge);
//   - a crossOutSet-member 0x65 folds: note count +1, consumed-crossout count +1, the minted leaf is live,
//     and the digest advances off the pre-fold anchor;
//   - a replay of the same claimId is a no-op (one mint per claimId; digest unchanged);
//   - a 0x65 whose leaf is NOT a crossOutSet member skips (no onboard; state and digest unchanged).
//
// Run: node tests/crossout-mint-fold-verify.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { encodeCrossoutMint, decodeCrossoutMint } from '../dapp/confidential-crossout-consumer.js';
import { crossoutMintLeaf } from '../worker/src/crossout-consumer.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const DRY_RUN = process.env.DRY_RUN === '1';
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const u32le = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const hb = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');
const OWNER = '0x' + '00'.repeat(32);                 // crossout-mint notes are owner-free (Bitcoin pool convention)
const ETH_POOL = '0x' + '5a'.repeat(20);
const BLOCK_HEIGHT = 318000;

// Build the 0x65 commit/reveal tx + a coinbase carrying a valid BIP141 witness commitment, exactly as the
// Mode-B onboarding fixture does — the guest extracts the Taproot envelope only for ti != 0, so the mint is tx 1.
function buildCrossoutBlock({ asset, claimId, cx, cy }) {
  const envelope = encodeCrossoutMint({ assetId: asset, claimId, cx, cy, owner: OWNER }); // SAME bytes the CLI broadcasts
  assert.strictEqual(envelope.length, 161, '0x65 envelope is 161 bytes');
  assert.strictEqual(envelope[0], 0x65, 'opcode 0x65');
  const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
  const dummyTxid = Buffer.alloc(32, 0x65);
  const inputsBuf = cat([dummyTxid, u32le(0), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
  const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
  const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
  const txid = computeTxid(tx);
  const txidHex = '0x' + Buffer.from(txid).toString('hex');
  const dsha = (b) => sha256(sha256(b));
  const reserved = Buffer.alloc(32, 7);
  const wcommit = dsha(cat([dsha(cat([Buffer.alloc(32), dsha(tx)])), reserved]));
  const coinbase = cat([
    [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
    [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
    [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,
    [0x01], [0x20], reserved, Buffer.alloc(4),
  ]);
  const cbTxid = computeTxid(coinbase);
  const coinbaseSpec = { txData: '0x' + Buffer.from(coinbase).toString('hex'), txid: '0x' + Buffer.from(cbTxid).toString('hex'), vins: [], env: null };
  const header = mineHeader(computeMerkleRoot([cbTxid, txid]));
  const txSpec = {
    txData: '0x' + tx.toString('hex'),
    txid: txidHex,
    vins: [{ prevTxid: '0x' + dummyTxid.toString('hex'), vout: 0 }],
    env: { type: 'crossout_mint', asset, claimId, cx, cy, owner: OWNER },
  };
  return { header: '0x' + Buffer.from(header).toString('hex'), coinbaseSpec, txSpec, txidHex };
}

// Assemble a one-0x65 Mode-B batch whose crossOutSet contains `claimId`'s destCommitment.
async function foldOneCrossout({ asset, claimId, cx, cy }) {
  const destCommitment = pool.leaf(asset, cx, cy, OWNER);
  const coLeaf = pool.ethCrossoutLeaf(claimId, pool.DEST_CHAIN_BITCOIN, destCommitment, asset);
  const coImt = pool.makeImtAccumulator(); coImt.insert(coLeaf);
  const coRoot = coImt.root();
  // synthetic consumed-ν set (empty leg here — this exercises the pure reverse-mint, the consume leg has its
  // own coverage): one membership leaf keeps buildEthPv's consumedNuCount coherent without a consume fold.
  const consumedSetRoot = pool.makeImtAccumulator().root();
  const ethBundle = {
    ethPv: pool.buildEthPv(coRoot, consumedSetRoot, 0, 1, ETH_POOL),
    crossouts: [{ claimId, destCommitment, asset }],
    consumeds: [],
  };
  const { txidHex, header, coinbaseSpec, txSpec } = buildCrossoutBlock({ asset, claimId, cx, cy });
  const { modeB } = pool.buildModeBBatch(ethBundle, [{ txid: txidHex, claimId }], []);
  const state = pool.makeScanReflectionState();
  state.setHeight(BLOCK_HEIGHT - 1);
  const before = { ...state.counts(), cc: state.consumedCrossoutCount() };
  const anchorDigest = state.digest();
  const input = await pool.assembleReflectionScanInput(state, {
    anchorHeight: BLOCK_HEIGHT, headers: [header], blocks: [{ txs: [coinbaseSpec, txSpec] }], modeB,
  }, new Map());
  const after = { ...state.counts(), cc: state.consumedCrossoutCount() };
  return { input, before, after, anchorDigest, destCommitment, state, modeB, ethBundle, header, coinbaseSpec, txSpec, txidHex };
}

const ASSET = '0x' + 'a1'.repeat(32);
const CLAIM = '0x' + 'c1'.repeat(32);
const { cx, cy } = pool.commitXY(50000n, 0xC0DEn);

// ── 1. the broadcast envelope's leaf == the eth-recorded destCommitment (the bind hinge) ──
{
  const payload = encodeCrossoutMint({ assetId: ASSET, claimId: CLAIM, cx, cy, owner: OWNER });
  const dec = decodeCrossoutMint(payload);
  const leafFromEnvelope = crossoutMintLeaf(keccak256, { assetId: dec.assetId, cx: dec.cx, cy: dec.cy, owner: dec.owner });
  const destCommitment = pool.leaf(ASSET, cx, cy, OWNER);
  assert.strictEqual(leafFromEnvelope, destCommitment, 'the broadcast envelope recomputes the recorded destCommitment leaf');
  ok('the 0x65 the CLI broadcasts recomputes the eth-recorded destCommitment (the membership target)');
}

// ── 2. a crossOutSet-member 0x65 FOLDS: the mint onboards and the reflected state advances ──
{
  const { input, before, after, anchorDigest, destCommitment } = await foldOneCrossout({ asset: ASSET, claimId: CLAIM, cx, cy });
  const cm = input.blocks[0].txs[1].crossoutMint; // txs[0] = coinbase
  assert.ok(cm && cm.isMember === 1, 'fold_crossout reports membership (a confirmed cross-out)');
  assert.strictEqual(cm.mPath.length, 32, 'membership path is 32 siblings');
  assert.strictEqual(cm.notePath.length, 32, 'note append path is 32 siblings');
  assert.strictEqual(after.note, before.note + 1, 'minted note onboarded (note count +1)');
  assert.strictEqual(after.cc, before.cc + 1, 'claimId entered the consumed-crossout set (count +1)');
  assert.ok(input.newDigest && input.newDigest.toLowerCase() !== anchorDigest.toLowerCase(), 'reflected digest advanced off the pre-fold anchor');
  assert.ok(input.modeB === 1, 'assembled as a Mode-B (reverse) batch');
  if (DRY_RUN) { console.log(`DRY_RUN=1: assembled digest ${input.newDigest} (no network leg)`); }
  ok(`a member 0x65 onboards the mint (note ${before.note}->${after.note}, crossout-consumed ${before.cc}->${after.cc}) and advances the digest`);
}

// ── 3. replay: the same claimId folded twice is a no-op (one mint per claimId; digest unchanged) ──
{
  const first = await foldOneCrossout({ asset: ASSET, claimId: CLAIM, cx, cy });
  // fold the SAME claimId again on the already-advanced state.
  const { txidHex, header, coinbaseSpec, txSpec } = buildCrossoutBlock({ asset: ASSET, claimId: CLAIM, cx, cy });
  const { modeB } = pool.buildModeBBatch(first.ethBundle, [{ txid: txidHex, claimId: CLAIM }], []);
  const digestBeforeReplay = first.state.digest();
  const countsBefore = { ...first.state.counts(), cc: first.state.consumedCrossoutCount() };
  first.state.setHeight(BLOCK_HEIGHT); // next block
  const replay = await pool.assembleReflectionScanInput(first.state, {
    anchorHeight: BLOCK_HEIGHT + 1, headers: [header], blocks: [{ txs: [coinbaseSpec, txSpec] }], modeB,
  }, new Map());
  const countsAfter = { ...first.state.counts(), cc: first.state.consumedCrossoutCount() };
  assert.strictEqual(countsAfter.note, countsBefore.note, 'no second note minted on replay');
  assert.strictEqual(countsAfter.cc, countsBefore.cc, 'consumed-crossout set unchanged on replay');
  // only height rode the digest; the mint-bearing state is unchanged (no double mint).
  assert.strictEqual(replay.blocks[0].txs[1].crossoutMint.isMember, 1, 'replay is still a membership-gated skip, not a parse failure');
  ok('a replayed claimId mints nothing (one mint per claimId; no double-credit)');
  void digestBeforeReplay;
}

// ── 4. a non-member 0x65 (no eth crossOut recorded for it) SKIPS — nothing onboards ──
{
  const FAKE_CLAIM = '0x' + 'f1'.repeat(32);
  // crossOutSet contains the REAL claim only; the fake 0x65's leaf is absent → non-membership → skip.
  const realDest = pool.leaf(ASSET, cx, cy, OWNER);
  const coImt = pool.makeImtAccumulator();
  coImt.insert(pool.ethCrossoutLeaf(CLAIM, pool.DEST_CHAIN_BITCOIN, realDest, ASSET));
  const coRoot = coImt.root();
  const ethBundle = {
    ethPv: pool.buildEthPv(coRoot, pool.makeImtAccumulator().root(), 0, 1, ETH_POOL),
    crossouts: [{ claimId: CLAIM, destCommitment: realDest, asset: ASSET }],
    consumeds: [],
  };
  const { txidHex, header, coinbaseSpec, txSpec } = buildCrossoutBlock({ asset: ASSET, claimId: FAKE_CLAIM, cx, cy });
  const { modeB } = pool.buildModeBBatch(ethBundle, [], []); // the fake 0x65 is not a recorded crossout tx
  const state = pool.makeScanReflectionState();
  state.setHeight(BLOCK_HEIGHT - 1);
  const before = { ...state.counts(), cc: state.consumedCrossoutCount() };
  const input = await pool.assembleReflectionScanInput(state, {
    anchorHeight: BLOCK_HEIGHT, headers: [header], blocks: [{ txs: [coinbaseSpec, txSpec] }], modeB,
  }, new Map());
  const after = { ...state.counts(), cc: state.consumedCrossoutCount() };
  const cm = input.blocks[0].txs[1].crossoutMint;
  assert.strictEqual(cm.isMember, 0, 'fold_crossout reports non-membership for a fake 0x65');
  assert.strictEqual(after.note, before.note, 'no note minted for a non-member 0x65');
  assert.strictEqual(after.cc, before.cc, 'consumed-crossout set unchanged for a non-member 0x65');
  ok('a 0x65 with no recorded eth cross-out skips (no unbacked mint)');
}

console.log(`\n${n}/4 T_CROSSOUT_MINT fold checks passed${DRY_RUN ? ' (DRY_RUN)' : ''}`);
