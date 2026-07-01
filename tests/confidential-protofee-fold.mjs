#!/usr/bin/env node
// protocol-fee claim (T_PROTOCOL_FEE_CLAIM 0x31) fold — JS mirror of cxfer-core fold_protocol_fee_claim
// (+ crystallize_protocol_fee / protocol_fee_shares / amm_derive_lp_asset_id). Validates accept (crystallize
// the swap-driven skim + exact-accrued claim + LP-share note onboarded + accrued reset) + gates (unknown pool
// / not-c0-backed / no-fee / claim != accrued / tampered blinding) + determinism, plus a Rust↔JS pin of the
// LP-asset domain and a guest-confirmed protocol_fee_shares vector. End-to-end guest-digest parity is
// confirmed by gen-reflection-protofee-synth.mjs under reflect-exec. Run: node tests/confidential-protofee-fold.mjs
//
// RECIPIENT AUTH (round-6): pool_id is DERIVED from the bound fee recipient — poolIdWithProtocolFee(assetA,
// assetB, feeBps, claimerPub, pfBps) — and the fold verifies a BIP-340 sig by that claimer binding the claim +
// vout-0 dest spk. Each claim is signed for its OWN (amount, cSecp, blinding, spk) so the negative cases
// exercise the amount/opening gate (not the sig gate, which the fold checks first).

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const beHex = (n, len = 32) => '0x' + BigInt(n).toString(16).padStart(len * 2, '0');
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32);
const OUT = pool.outpointKey('0x' + '55'.repeat(32), 1);
const reserveA = 2000n, reserveB = 2000n, sPre = 1000000n, kLast = 1000000n, feeBps = 30, pfBps = 30, blinding = 0xABCDn;

// ── recipient auth: a real secp key committed into pool_id + a BIP-340 claim sig over (claim, dest spk) ──
const enc = new TextEncoder();
const PFEE_CLAIM_DOM = enc.encode('tacit-amm-protocol-fee-claim-v1');
const cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const hb = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
const be = (n, len) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const CLAIMER_PRIV_HEX = '2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40';
const CLAIMER_PRIV = hb(CLAIMER_PRIV_HEX);
const CLAIMER_PUB = '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(BigInt('0x' + CLAIMER_PRIV_HEX)).toRawBytes(true)).toString('hex');
const CLAIM_SPK = cat([Uint8Array.from([0x00, 0x14]), new Uint8Array(20).fill(0x7c)]); // P2WPKH-shaped vout-0 dest
const POOL_ID = pool.poolIdWithProtocolFee(ASSET_A, ASSET_B, feeBps, CLAIMER_PUB, pfBps);
// Sign a claim tuple exactly as the fold recomputes it (cxfer-core PFEE_CLAIM_DOM message).
const signClaim = (amount, cSecp, blindingHex) => '0x' + Buffer.from(signSchnorr(keccak_256(cat([PFEE_CLAIM_DOM, hb(POOL_ID), be(amount, 8), hb(cSecp), be(BigInt(blindingHex), 32), CLAIM_SPK])), CLAIMER_PRIV)).toString('hex');
const fold = (st, amount, cSecp, blindingHex) => st.foldProtocolFeeClaim(POOL_ID, CLAIMER_PUB, feeBps, String(amount), cSecp, blindingHex, signClaim(amount, cSecp, blindingHex), CLAIM_SPK, OUT);

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
function seed({ c0 = true, bps = pfBps } = {}) {
  const st = pool.makeScanReflectionState();
  st.setHeight(100);
  st.pools.load([{ poolId: POOL_ID, assetA: ASSET_A, assetB: ASSET_B, reserveA: reserveA.toString(), reserveB: reserveB.toString(), totalShares: sPre.toString(), c0Backed: c0, protocolFeeBps: bps, kLast: kLast.toString(), protocolFeeAccrued: '0' }]);
  return st;
}

// ── accept ──
{
  const st = seed();
  const g0 = st.digest();
  const w = fold(st, accrued, claimCSecp, beHex(blinding));
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
  fold(a, accrued, claimCSecp, beHex(blinding));
  fold(b, accrued, claimCSecp, beHex(blinding));
  eq(a.digest(), b.digest(), 'deterministic: same claim → same digest');
}

// ── gates reject (null = skip; assert NO mutation of the claim count) ──
const rejects = (label, st, call) => {
  const noteBefore = st.counts().note;
  eq(call(), null, label + ' → skip');
  eq(st.counts().note, noteBefore, label + ': no note onboarded');
};
{ const st = pool.makeScanReflectionState(); st.setHeight(100); rejects('unknown pool', st, () => fold(st, accrued, claimCSecp, beHex(blinding))); }
{ const st = seed({ c0: false }); rejects('pool not c0-backed', st, () => fold(st, accrued, claimCSecp, beHex(blinding))); }
{ const st = seed({ bps: 0 }); rejects('pool has no protocol fee', st, () => fold(st, accrued, claimCSecp, beHex(blinding))); }
{ const st = seed(); rejects('claim > accrued (over-mint)', st, () => fold(st, accrued + 1n, claimCSecp, beHex(blinding))); }
{ const st = seed(); rejects('claim < accrued', st, () => fold(st, accrued - 1n, claimCSecp, beHex(blinding))); }
{ const st = seed(); rejects('tampered blinding (opening fails)', st, () => fold(st, accrued, claimCSecp, beHex(0xDEADn))); }

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
