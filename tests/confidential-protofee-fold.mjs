#!/usr/bin/env node
// protocol-fee claim (T_PROTOCOL_FEE_CLAIM 0x31) fold — JS mirror of cxfer-core fold_protocol_fee_claim
// (+ crystallize_protocol_fee / protocol_fee_shares / amm_derive_lp_asset_id). Validates accept (crystallize
// the swap-driven skim + exact-accrued claim + LP-share note onboarded + accrued reset) + gates (unknown pool
// / not-c0-backed / no-fee / claim != accrued / tampered blinding) + determinism, plus a Rust↔JS pin of the
// LP-asset domain and a guest-confirmed protocol_fee_shares vector. End-to-end guest-digest parity is
// confirmed by gen-reflection-protofee-synth.mjs under reflect-exec. Run: node tests/confidential-protofee-fold.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const beHex = (n, len = 32) => '0x' + BigInt(n).toString(16).padStart(len * 2, '0');
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const POOL_ID = '0x' + '31'.repeat(32), ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32);
const OUT = pool.outpointKey('0x' + '55'.repeat(32), 1);
const reserveA = 2000n, reserveB = 2000n, sPre = 1000000n, kLast = 1000000n, feeBps = 30, blinding = 0xABCDn;

// ── Rust↔JS pin: the LP-asset domain + the fee formula (else the claim note's asset / amount silently
// desyncs from the guest, cf. the REFLECTION_GENESIS_DIGEST three-way pin). ──
const rustDomain = readFileSync(new URL('../contracts/sp1/confidential/cxfer-core/src/lib.rs', import.meta.url), 'utf8').match(/AMM_LP_ASSET_DOMAIN: &\[u8\] = b"([^"]+)"/)[1];
const expectLp = '0x' + Buffer.from(sha256(Buffer.concat([Buffer.from(rustDomain), Buffer.from(POOL_ID.slice(2), 'hex')]))).toString('hex');
eq(pool.ammDeriveLpAssetId(POOL_ID), expectLp, 'ammDeriveLpAssetId == sha256(Rust AMM_LP_ASSET_DOMAIN ‖ pool_id)');
eq(pool.protocolFeeShares(sPre, kLast, reserveA * reserveB, feeBps).toString(), '1502', 'protocol_fee_shares vector == the reflect-exec guest-confirmed 1502');

const accrued = pool.protocolFeeShares(sPre, kLast, reserveA * reserveB, feeBps);
const { cx, cy } = pool.commitXY(accrued, blinding);
const claimCSecp = pool.compressXY(cx, cy);

// A C0-backed pool with a protocol-fee tier + a stale k_last (so a claim crystallizes a skim).
function seed({ c0 = true, bps = feeBps } = {}) {
  const st = pool.makeScanReflectionState();
  st.setHeight(100);
  st.pools.load([{ poolId: POOL_ID, assetA: ASSET_A, assetB: ASSET_B, reserveA: reserveA.toString(), reserveB: reserveB.toString(), totalShares: sPre.toString(), c0Backed: c0, protocolFeeBps: bps, kLast: kLast.toString(), protocolFeeAccrued: '0' }]);
  return st;
}

// ── accept ──
{
  const st = seed();
  const g0 = st.digest();
  const w = st.foldProtocolFeeClaim(POOL_ID, accrued.toString(), claimCSecp, beHex(blinding), OUT);
  ok(w && w.notePath, 'valid claim folds (returns the claim note-path witness)');
  eq(st.counts().note, 1, 'claim note onboarded as an LP-share note');
  const p = st.pools.get(POOL_ID);
  eq(BigInt(p.protocolFeeAccrued), 0n, 'accrued reset to 0 after the claim');
  eq(BigInt(p.totalShares), sPre + accrued, 'crystallize grew total_shares by the skim');
  ok(st.digest() !== g0, 'digest advanced');
}

// ── determinism ──
{
  const a = seed(), b = seed();
  a.foldProtocolFeeClaim(POOL_ID, accrued.toString(), claimCSecp, beHex(blinding), OUT);
  b.foldProtocolFeeClaim(POOL_ID, accrued.toString(), claimCSecp, beHex(blinding), OUT);
  eq(a.digest(), b.digest(), 'deterministic: same claim → same digest');
}

// ── gates reject (null = skip; assert NO mutation of the claim count) ──
const rejects = (label, st, call) => {
  const noteBefore = st.counts().note;
  eq(call(), null, label + ' → skip');
  eq(st.counts().note, noteBefore, label + ': no note onboarded');
};
{ const st = pool.makeScanReflectionState(); st.setHeight(100); rejects('unknown pool', st, () => st.foldProtocolFeeClaim(POOL_ID, accrued.toString(), claimCSecp, beHex(blinding), OUT)); }
{ const st = seed({ c0: false }); rejects('pool not c0-backed', st, () => st.foldProtocolFeeClaim(POOL_ID, accrued.toString(), claimCSecp, beHex(blinding), OUT)); }
{ const st = seed({ bps: 0 }); rejects('pool has no protocol fee', st, () => st.foldProtocolFeeClaim(POOL_ID, accrued.toString(), claimCSecp, beHex(blinding), OUT)); }
{ const st = seed(); rejects('claim > accrued (over-mint)', st, () => st.foldProtocolFeeClaim(POOL_ID, (accrued + 1n).toString(), claimCSecp, beHex(blinding), OUT)); }
{ const st = seed(); rejects('claim < accrued', st, () => st.foldProtocolFeeClaim(POOL_ID, (accrued - 1n).toString(), claimCSecp, beHex(blinding), OUT)); }
{ const st = seed(); rejects('tampered blinding (opening fails)', st, () => st.foldProtocolFeeClaim(POOL_ID, accrued.toString(), claimCSecp, beHex(0xDEADn), OUT)); }

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
