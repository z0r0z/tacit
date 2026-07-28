#!/usr/bin/env node
// Generational-resume (authenticated migration) reflect-exec fixtures. A successor generation resumes the
// SHARED Bitcoin reflection from a DRAINED predecessor: the guest's first cycle (rebaseMode=1) reads the
// predecessor's final attested state, drain-gates it against the witnessed on-chain counters, then REBASES —
// preserving every global accumulator (note tree, spent set, burn set, consumed-outpoint gate, consumed-
// cross-out replay gate, pools, cBTC backing, farms, height) and RESETTING only the generation-local liveness
// fields (consumed_count → 0, folded_crossout_count → 0, eth_refl_digest → [0;32]). The successor genesis it
// lands on is what the deploy pins as reflectionResumeDigest_, and the contract binds the whole rebase to the
// predecessor's exposed getters via rebasedFromDigest.
//
// Emits three fixtures into ops/box-artifacts/h02-migration-fixtures/ for reflect-exec on the box:
//   1. positive.json   — DIGEST_MATCH (the rebase preserves-vs-resets correctly).
//   2. undrained.json  — guest ABORTS (the in-guest drain assertion rejects an un-drained predecessor).
//   3. mismatch.json   — the CONTRACT rejects (rebasedFromDigest / resume digest don't match the predecessor).
//
//   node tests/gen-h02-migration-fixtures.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const OUT_DIR = 'ops/box-artifacts/h02-migration-fixtures';
const BLOCK_HEIGHT = 412000;

// Seed a NON-EMPTY, DRAINED predecessor: nonzero PRESERVED globals (a pool, a live cBTC.zk lock + backing) and
// nonzero generation-local liveness fields (consumed_count, folded_crossout_count, eth_refl_digest). "Drained"
// means the reflection has folded every recorded consume/cross-out, so its folded counts EQUAL the on-chain
// bitcoinConsumedCount / crossOutCount — which is exactly what the drain gate asserts. Returns a fresh state so
// each fixture starts from an identical predecessor.
const PRED_CONSUMED = 4n;      // predecessor reflection consumed_count == on-chain bitcoinConsumedCount (drained)
const PRED_CROSSOUT = 3n;      // predecessor reflection folded_crossout_count == on-chain crossOutCount (drained)
const ETH_REFL = '0x' + 'a7'.repeat(32); // a nonzero eth-reflection accumulator anchor (reset to [0;32] by rebase)
function makePredecessor() {
  const state = pool.makeScanReflectionState();
  state.setHeight(BLOCK_HEIGHT - 1);
  // PRESERVED global: a C0-backed pool with a live fee tier + protocol-fee skim (every PoolReserveState field).
  const reserveA = 5_000_000n, reserveB = 9_000_000n;
  state.pools.load([{
    poolId: '0x' + '31'.repeat(32), assetA: '0x' + 'a1'.repeat(32), assetB: '0x' + 'b2'.repeat(32),
    reserveA: reserveA.toString(), reserveB: reserveB.toString(), totalShares: '6708203',
    c0Backed: true, feeBps: 30, protocolFeeBps: 20, kLast: (reserveA * reserveB).toString(), protocolFeeAccrued: '11',
  }]);
  // PRESERVED global: a live self-custody cBTC.zk lock (bumps cbtc_backing_sats). Value opening on a fresh
  // blinding so (cx,cy) is a real curve point foldCbtcLock accepts.
  const vBtc = 654321n;
  const r = BigInt('0x' + Buffer.from(keccak_256(Buffer.from('h02-pred-lock'))).toString('hex')) % (2n ** 250n);
  const { cx, cy } = pool.commitXY(vBtc, r);
  const lockTxid = '0x' + 'c3'.repeat(32);
  const folded = state.foldCbtcLock({ asset: pool.CBTC_ZK_ASSET_ID, cx, cy, vBtc, lockVout: 1, lockTxid });
  if (!folded) throw new Error('predecessor cBTC lock seed failed');
  // Generation-local liveness fields (RESET by the rebase). Nonzero so the reset is genuinely exercised.
  state.setConsumedCount(PRED_CONSUMED);
  state.setFoldedCrossoutCount(PRED_CROSSOUT);
  state.setEthReflDigest(ETH_REFL);
  return state;
}

// A plain (non-TACIT, non-segwit) block that folds nothing — the successor's first cycle resumes cleanly, so
// the guest's committed newDigest == the assembler's rebased digest with no confounding effect.
function plainBatch() {
  const dummyPrev = Buffer.alloc(32, 0xd9);
  const tx = cat([
    [0x02, 0x00, 0x00, 0x00],
    varint(1), dummyPrev, u32le(0), [0x00], [0xff, 0xff, 0xff, 0xff],
    varint(1), Buffer.alloc(8), [0x00],
    Buffer.alloc(4),
  ]);
  const txid = computeTxid(tx);
  const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
  const header = mineHeader(computeMerkleRoot([cbTxid, txid]));
  const txSpec = {
    txData: '0x' + tx.toString('hex'), txid: '0x' + Buffer.from(txid).toString('hex'),
    vins: [{ prevTxid: '0x' + dummyPrev.toString('hex'), vout: 0 }], env: null,
  };
  return { anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }] };
}

mkdirSync(OUT_DIR, { recursive: true });
const flip = (hx32) => { const b = Buffer.from(hx32.slice(2), 'hex'); b[0] ^= 0xff; return '0x' + b.toString('hex'); };

// ── 1. POSITIVE — resume-from-nonempty-predecessor (drained) ─────────────────────────────────────────────
{
  const state = makePredecessor();
  const predDigest = state.digest();
  const input = await pool.assembleReflectionScanInput(state, { ...plainBatch(), rebase: {} }, new Map());
  // Cross-check the preservation-vs-reset split in JS: an independent state carrying the SAME preserved globals
  // but zeroed generation-local fields must land on the exact successor genesis the assembler pinned.
  const check = makePredecessor();
  check.setConsumedCount(0n); check.setFoldedCrossoutCount(0n); check.setEthReflDigest('0x' + '00'.repeat(32));
  if (check.digest() !== input.reflectionResumeDigest) throw new Error('FATAL: successor-genesis preservation mismatch');
  if (input.rebaseMode !== 1) throw new Error('FATAL: rebaseMode not set');
  if (Number(PRED_CONSUMED) !== input.predecessorConsumedCount || Number(PRED_CROSSOUT) !== input.predecessorCrossOutCount)
    throw new Error('FATAL: drained-counter witness mismatch');
  if (input.rebasedFromDigest !== pool.generationalRebaseAnchor(predDigest, PRED_CONSUMED, PRED_CROSSOUT))
    throw new Error('FATAL: rebasedFromDigest anchor mismatch');
  writeFileSync(`${OUT_DIR}/positive.json`, JSON.stringify(input) + '\n');
  console.error(`positive: predDigest=${predDigest} resumeDigest=${input.reflectionResumeDigest} rebasedFrom=${input.rebasedFromDigest} newDigest=${input.newDigest}`);
}

// ── 2. NEGATIVE — un-drained predecessor (witnessed on-chain count != folded count) ──────────────────────
// The predecessor recorded a fast-lane consume its reflection has NOT folded (on-chain bitcoinConsumedCount >
// reflection consumed_count). The stdin writer witnesses the higher on-chain count; the guest's drain assertion
// `state.consumed_count == oc_consumed` then fails → the rebase (hence the migration) is rejected in-guest.
{
  const state = makePredecessor();
  const input = await pool.assembleReflectionScanInput(
    state, { ...plainBatch(), rebase: { predecessorConsumedCount: Number(PRED_CONSUMED) + 2 } }, new Map());
  input.expect = 'guest-abort';
  input.expectReason = 'predecessor not drained: unfolded fast-lane consumes (state.consumed_count != witnessed bitcoinConsumedCount)';
  writeFileSync(`${OUT_DIR}/undrained.json`, JSON.stringify(input) + '\n');
  console.error(`undrained: witnessed consumed=${input.predecessorConsumedCount} vs folded=${PRED_CONSUMED} → guest must abort`);
}

// ── 3. NEGATIVE — fabricated-resume-mismatch (contract rejects) ──────────────────────────────────────────
// The guest runs deterministically and commits priorDigest == the successor genesis and rebasedFromDigest ==
// keccak(predDigest ‖ drained counters). The CONTRACT then (a) re-derives rebasedFromDigest from the
// predecessor's getters and reverts if it differs, and (b) requires priorDigest == the pinned
// reflectionResumeDigest_. This fixture carries tampered expectations: a rebasedFromDigest that does NOT match
// the predecessor, and a resume digest that does NOT match the guest's deterministic rebase — the box asserts
// the guest's real committed values differ from these, i.e. the contract's gates reject them.
{
  const state = makePredecessor();
  const predDigest = state.digest();
  const input = await pool.assembleReflectionScanInput(state, { ...plainBatch(), rebase: {} }, new Map());
  input.expect = 'contract-reject';
  input.tamperedRebasedFromDigest = flip(input.rebasedFromDigest); // != keccak(predecessor getters) → StaleReflectionDigest
  input.tamperedResumeDigest = flip(input.reflectionResumeDigest); // != guest priorDigest → StaleReflectionDigest
  input.expectReason = 'rebasedFromDigest must equal keccak(predecessorDigest‖consumedCount‖crossOutCount); priorDigest must equal the pinned reflectionResumeDigest_';
  if (input.tamperedRebasedFromDigest === input.rebasedFromDigest || input.tamperedResumeDigest === input.reflectionResumeDigest)
    throw new Error('FATAL: tamper did not change the value');
  writeFileSync(`${OUT_DIR}/mismatch.json`, JSON.stringify(input) + '\n');
  console.error(`mismatch: real rebasedFrom=${input.rebasedFromDigest} tampered=${input.tamperedRebasedFromDigest}`);
}

console.error('wrote positive.json, undrained.json, mismatch.json to ' + OUT_DIR);
