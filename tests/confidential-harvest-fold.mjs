#!/usr/bin/env node
// harvest / farm-refund (T_LP_HARVEST 0x3B, T_FARM_REFUND 0x3E) fold — JS mirror of cxfer-core fold_harvest.
// A reward/refund note minted by DECREE, DERIVED from the public (amount, r), drawn from a C0-backed farm
// treasury. Validates accept (note onboarded + treasury debited) + gates (unknown farm / not-c0-backed /
// zero / over-treasury) + determinism + no-mutation-on-reject. End-to-end guest-digest parity is confirmed
// by gen-reflection-harvest-synth.mjs under reflect-exec. Run: node tests/confidential-harvest-fold.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const REWARD_ASSET = '0x' + 'c3'.repeat(32), FARM_ID = '0x' + '44'.repeat(32);
const OUT_TXID = '0x' + '55'.repeat(32);
const treasury = 1000000n, rewardAmount = 25000n;
const rHex = '0x' + (0xF00Dn).toString(16).padStart(64, '0');
const outpoint = pool.outpointKey(OUT_TXID, 1);

// A C0-backed farm treasury (a degenerate pool keyed by farm_id; asset_a = the reward asset).
function seed({ c0 = true, reserve = treasury } = {}) {
  const st = pool.makeScanReflectionState();
  st.setHeight(100);
  st.pools.load([{ poolId: FARM_ID, assetA: REWARD_ASSET, assetB: '0x' + '00'.repeat(32), reserveA: reserve.toString(), reserveB: '0', totalShares: '0', c0Backed: c0, protocolFeeBps: 0, kLast: '0', protocolFeeAccrued: '0' }]);
  return st;
}

// ── accept ──
{
  const st = seed();
  const g0 = st.digest();
  const w = st.foldHarvest(FARM_ID, rewardAmount.toString(), rHex, outpoint);
  ok(w && w.notePath, 'valid harvest folds (returns the reward note-path witness)');
  eq(st.counts().note, 1, 'reward note onboarded to the tree');
  eq(BigInt(st.pools.get(FARM_ID).reserveA), treasury - rewardAmount, 'treasury debited by the reward');
  ok(st.digest() !== g0, 'digest advanced');
}

// ── determinism (JS self-consistency) ──
{
  const a = seed(), b = seed();
  a.foldHarvest(FARM_ID, rewardAmount.toString(), rHex, outpoint);
  b.foldHarvest(FARM_ID, rewardAmount.toString(), rHex, outpoint);
  eq(a.digest(), b.digest(), 'deterministic: same harvest → same digest');
}

// ── gates reject (null = skip; assert NO mutation) ──
const rejects = (label, st, call) => {
  const noteBefore = st.counts().note;
  const f = st.pools.get(FARM_ID);
  const reserveBefore = f ? BigInt(f.reserveA) : -1n;
  eq(call(), null, label + ' → skip');
  eq(st.counts().note, noteBefore, label + ': no note onboarded');
  if (reserveBefore >= 0n) eq(BigInt(st.pools.get(FARM_ID).reserveA), reserveBefore, label + ': treasury unchanged');
};
{ const st = pool.makeScanReflectionState(); st.setHeight(100); rejects('unknown farm', st, () => st.foldHarvest(FARM_ID, rewardAmount.toString(), rHex, outpoint)); }
{ const st = seed({ c0: false }); rejects('farm not c0-backed', st, () => st.foldHarvest(FARM_ID, rewardAmount.toString(), rHex, outpoint)); }
{ const st = seed(); rejects('zero reward', st, () => st.foldHarvest(FARM_ID, '0', rHex, outpoint)); }
{ const st = seed({ reserve: 100n }); rejects('reward > treasury (no inflation)', st, () => st.foldHarvest(FARM_ID, rewardAmount.toString(), rHex, outpoint)); }

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
