#!/usr/bin/env node
// swapBatchPublicSignals — the 123 Groth16 public signals re-derived from the envelope + the pool's tracked
// reserves (mirror cxfer-core swap_batch_public_signals). Structural validation: the 11 globals are exactly the
// envelope/registry fields, and the seven N_MAX=16 arrays carry each intent's/receipt's (direction, min_out,
// tip) + the BabyJubJub (u,v) recovered by unpackPoint, with unused slots padded by the BJJ identity (0,1). The
// EXACT circom-signal order vs the circuit is confirmed end-to-end at the gen (fullProve publicSignals ==
// these), with the head zkey. Run: node tests/confidential-swapbatch-publics.mjs

import { pedersenBJJ, packPoint, P_FR, mod } from '../dapp/amm-bjj.js';
import { swapBatchPublicSignals } from '../dapp/confidential-swapbatch.js';
import { createHash } from 'node:crypto';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const bytesToBig = (b) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
const hb32 = (h) => Buffer.from(String(h).replace(/^0x/, '').padStart(64, '0'), 'hex');
const packHex = (v, r) => '0x' + Buffer.from(packPoint(pedersenBJJ(v, r))).toString('hex');
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };

const poolId = '0x' + '2f'.repeat(32);
const reserveA = 1000000n, reserveB = 2000000n;
const ins = [{ v: 700n, r: 0x11n, dir: 0, minOut: 600n, tip: 5n }, { v: 300n, r: 0x22n, dir: 1, minOut: 250n, tip: 7n }];
const outs = [{ v: 1900n, r: 0x33n }, { v: 3600n, r: 0x44n }];
const env = {
  nIntents: 2, deltaANetSign: 0, deltaANetMag: '1500', deltaBNetSign: 1, deltaBNetMag: '2500',
  feeBps: 30, tipAAmount: '11', tipBAmount: '22',
  intents: ins.map((x) => ({ direction: x.dir, cInBjj: packHex(x.v, x.r), minOut: x.minOut.toString(), tipAmount: x.tip.toString() })),
  receipts: outs.map((x) => ({ cOutBjj: packHex(x.v, x.r) })),
};

const s = swapBatchPublicSignals(env, poolId, reserveA, reserveB);
eq(Array.isArray(s) && s.length, 123, '123 public signals');

// ── 11 globals ──
eq(s[0], mod(bytesToBig(sha256(hb32(poolId))), P_FR), 'pool_id_fr = SHA256(pool_id) mod r');
eq(s[1], reserveA, 'R_A_pre'); eq(s[2], reserveB, 'R_B_pre');
eq(s[3], 0n, 'δa sign'); eq(s[4], 1500n, 'δa mag'); eq(s[5], 1n, 'δb sign'); eq(s[6], 2500n, 'δb mag');
eq(s[7], 11n, 'tip_a'); eq(s[8], 22n, 'tip_b'); eq(s[9], 30n, 'fee_bps'); eq(s[10], 2n, 'n_intents');

// ── the seven 16-slot arrays (base 11) ──
const arr = (k) => s.slice(11 + k * 16, 11 + k * 16 + 16);
const [direction, cInU, cInV, minOut, tip, cOutU, cOutV] = [0, 1, 2, 3, 4, 5, 6].map(arr);
const inP = ins.map((x) => pedersenBJJ(x.v, x.r)), outP = outs.map((x) => pedersenBJJ(x.v, x.r));

eq(direction[0], 0n, 'direction[0]'); eq(direction[1], 1n, 'direction[1]'); eq(direction[2], 0n, 'direction[2] pad');
eq(cInU[0], inP[0][0], 'C_in_u[0] = unpack(c_in_bjj).u'); eq(cInV[0], inP[0][1], 'C_in_v[0] = .v');
eq(cInU[1], inP[1][0], 'C_in_u[1]'); eq(cInV[1], inP[1][1], 'C_in_v[1]');
eq(cInU[2], 0n, 'C_in_u[2] pad = 0'); eq(cInV[2], 1n, 'C_in_v[2] pad = 1 (BJJ identity)');
eq(minOut[0], 600n, 'min_out[0]'); eq(minOut[1], 250n, 'min_out[1]'); eq(minOut[2], 0n, 'min_out[2] pad');
eq(tip[0], 5n, 'tip[0]'); eq(tip[1], 7n, 'tip[1]'); eq(tip[2], 0n, 'tip[2] pad');
eq(cOutU[0], outP[0][0], 'C_out_u[0] = unpack(c_out_bjj).u'); eq(cOutV[0], outP[0][1], 'C_out_v[0] = .v');
eq(cOutU[1], outP[1][0], 'C_out_u[1]'); eq(cOutV[1], outP[1][1], 'C_out_v[1]');
eq(cOutU[2], 0n, 'C_out_u[2] pad = 0'); eq(cOutV[2], 1n, 'C_out_v[2] pad = 1');

// ── guards ──
eq(swapBatchPublicSignals({ ...env, nIntents: 0 }, poolId, reserveA, reserveB), null, 'n_intents 0 → null');
eq(swapBatchPublicSignals({ ...env, receipts: [env.receipts[0]] }, poolId, reserveA, reserveB), null, 'intents/receipts length mismatch → null');
{ const bad = { ...env, intents: [{ ...env.intents[0], cInBjj: '0x' + 'ff'.repeat(32) }, env.intents[1]] }; eq(swapBatchPublicSignals(bad, poolId, reserveA, reserveB), null, 'non-canonical C_in_BJJ → null'); }

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
