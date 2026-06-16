#!/usr/bin/env node
// farm-init (T_FARM_INIT 0x34) fold — JS mirror of cxfer-core fold_farm_init. The launcher's single detected
// reward-asset spend funds a treasury under the SAME swap-shape kernel; the farm is registered as a degenerate
// pool keyed by farm_id (no note onboarded). Validates accept (treasury registered) + gates (zero / already
// registered / bad funding kernel / funding != claimed) + determinism + a Rust↔JS farm-id-domain pin + the
// init→harvest lifecycle. End-to-end guest-digest parity is confirmed by gen-reflection-farminit-synth.mjs
// under reflect-exec. Run: node tests/confidential-farminit-fold.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { swapVarKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const POOL_ID = '0x' + '77'.repeat(32), FARM_NONCE = '0x' + '01'.repeat(32);
const LAUNCHER_PUBKEY = '0x02' + 'ab'.repeat(32), REWARD_ASSET = '0x' + 'c3'.repeat(32);
const ZERO_OWNER = '0x' + '00'.repeat(32), SENTINEL = Buffer.alloc(33), SENTINEL_HEX = '0x' + '00'.repeat(33);
const seedTxidHex = '0x' + '88'.repeat(32), seedVout = 0;
const rewardTotal = 500000n, rIn = 0xBEEFn;

const cInXY = pool.commitXY(rewardTotal, rIn);
const cIn = pool.compressXY(cInXY.cx, cInXY.cy);
const kernelSig = '0x' + Buffer.from(swapVarKernelSig({ assetHex: REWARD_ASSET, txidHex: seedTxidHex, vout: seedVout, cChangeBytes: SENTINEL, deltaInTotal: rewardTotal, rIn })).toString('hex');
const farmId = pool.ammDeriveFarmId(POOL_ID, LAUNCHER_PUBKEY, REWARD_ASSET, FARM_NONCE);
const inOutpoint = [seedTxidHex, seedVout];

// ── Rust↔JS pin: the farm-id domain (else amm_derive_farm_id keys a different treasury than the guest). ──
const rustFarmDomain = readFileSync(new URL('../contracts/sp1/confidential/cxfer-core/src/lib.rs', import.meta.url), 'utf8').match(/AMM_FARM_INIT_DOMAIN: &\[u8\] = b"([^"]+)"/)[1];
const cc = (...hs) => Buffer.concat(hs.map((h) => Buffer.from(h.replace(/^0x/, ''), 'hex')));
const expectFarm = '0x' + Buffer.from(sha256(Buffer.concat([Buffer.from(rustFarmDomain), cc(POOL_ID, LAUNCHER_PUBKEY, REWARD_ASSET, FARM_NONCE)]))).toString('hex');
eq(farmId, expectFarm, 'ammDeriveFarmId == sha256(Rust AMM_FARM_INIT_DOMAIN ‖ pool_id ‖ launcher_pubkey ‖ reward_asset ‖ farm_nonce)');

// The launcher's funding note (a live UTXO of the reward asset). No farm yet — farm-init creates it.
function seed() {
  const st = pool.makeScanReflectionState();
  st.setHeight(100);
  const op = pool.outpointKey(seedTxidHex, seedVout);
  st.foldOutput(pool.leaf(REWARD_ASSET, cInXY.cx, cInXY.cy, ZERO_OWNER), op, pool.commitmentHash(cInXY.cx, cInXY.cy), REWARD_ASSET);
  return st;
}

// ── accept ──
{
  const st = seed();
  const g0 = st.digest();
  const r = st.foldFarmInit(farmId, REWARD_ASSET, rewardTotal.toString(), inOutpoint, cIn, SENTINEL_HEX, kernelSig);
  ok(r, 'valid farm-init folds (treasury registered)');
  const farm = st.pools.get(farmId);
  ok(farm, 'farm in the registry');
  eq(BigInt(farm.reserveA), rewardTotal, 'treasury = reward_total');
  eq(farm.assetA, REWARD_ASSET, 'treasury asset_a = the reward asset');
  eq(!!farm.c0Backed, true, 'treasury is C0-backed');
  ok(st.digest() !== g0, 'digest advanced');
}

// ── determinism ──
{
  const a = seed(), b = seed();
  a.foldFarmInit(farmId, REWARD_ASSET, rewardTotal.toString(), inOutpoint, cIn, SENTINEL_HEX, kernelSig);
  b.foldFarmInit(farmId, REWARD_ASSET, rewardTotal.toString(), inOutpoint, cIn, SENTINEL_HEX, kernelSig);
  eq(a.digest(), b.digest(), 'deterministic: same farm-init → same digest');
}

// ── gates reject ──
eq(seed().foldFarmInit(farmId, REWARD_ASSET, '0', inOutpoint, cIn, SENTINEL_HEX, kernelSig), null, 'zero treasury → skip');
{ const st = seed(); st.foldFarmInit(farmId, REWARD_ASSET, rewardTotal.toString(), inOutpoint, cIn, SENTINEL_HEX, kernelSig); eq(st.foldFarmInit(farmId, REWARD_ASSET, rewardTotal.toString(), inOutpoint, cIn, SENTINEL_HEX, kernelSig), null, 'already registered → skip'); }
eq(seed().foldFarmInit(farmId, REWARD_ASSET, rewardTotal.toString(), inOutpoint, cIn, SENTINEL_HEX, '0x' + 'de'.repeat(64)), null, 'bad funding kernel → skip');
eq(seed().foldFarmInit(farmId, REWARD_ASSET, (rewardTotal + 1n).toString(), inOutpoint, cIn, SENTINEL_HEX, kernelSig), null, 'funding != claimed total → kernel skip');

// ── lifecycle: init then harvest draws from the freshly-inited treasury ──
{
  const st = seed();
  st.foldFarmInit(farmId, REWARD_ASSET, rewardTotal.toString(), inOutpoint, cIn, SENTINEL_HEX, kernelSig);
  const rewardR = '0x' + (0x1234n).toString(16).padStart(64, '0');
  const hw = st.foldHarvest(farmId, '100000', rewardR, pool.outpointKey('0x' + '99'.repeat(32), 1));
  ok(hw && hw.notePath, 'harvest draws a reward note from the freshly-inited treasury');
  eq(BigInt(st.pools.get(farmId).reserveA), rewardTotal - 100000n, 'treasury debited by the harvest');
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
