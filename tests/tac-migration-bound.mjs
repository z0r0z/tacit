#!/usr/bin/env node
// One-time migration of a legacy (generation-unbound) TAC note into the current generation's bound note
// format. buildTacMigration spends a legacy TAC note into a single T_CXFER_BOUND (0x39) TAC output note of
// the SAME amount, homed to a supplied target chain-binding, conserving under the same tacit-kernel-v1 kernel
// a v1 CXFER uses. This test asserts the built envelope round-trips through the committed 0x39 parser (target
// + asset + commitment preserved), that the output commitment commits the input amount, that the tx passes
// the guest-mirror conservation gate, and that the builder is gated to the legacy TAC asset only.
//
// Run: node tests/tac-migration-bound.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { buildTacMigration, encodeCxferBoundEnvelope, parseCxferBoundEnvelope } from '../dapp/burn-deposit-bitcoin.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { pedersenCommit, pointToBytes } from '../dapp/bulletproofs.js';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m)); // signSchnorr / bppRangeProve nonces
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

let failures = 0;
const eq = (a, b, msg) => { if (a !== b) { console.error(`FAIL ${msg}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${msg}`); };
const ok = (c, msg) => { if (!c) { console.error(`FAIL ${msg}`); failures++; } else console.log(`ok   ${msg}`); };
const lc = (s) => s.toLowerCase();
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const reverseHex = (h) => '0x' + Buffer.from(hexToBytes(h)).reverse().toString('hex');

const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b'; // sole legacy-bridge asset
const NOT_TAC = '0x' + '11'.repeat(32);
const TARGET = '0x' + '7c'.repeat(32); // launch generation chainBinding (caller-supplied CREATE3 artifact)

const note = {
  assetId: TAC,
  amount: 123456789n,
  blinding: 0x0badc0de00000000000000000000000000000000000000000000000000001234n,
  outpoint: { txid: '0x' + 'ab'.repeat(32), vout: 3 }, // display (big-endian) txid
};

// 1. gated to the legacy TAC asset only.
let threw = false;
try { buildTacMigration({ note: { ...note, assetId: NOT_TAC }, targetChainBinding: TARGET }); } catch { threw = true; }
ok(threw, 'non-TAC asset is refused (migration gated to the legacy bridge asset)');

// 2. build the migration + round-trip through the committed 0x39 parser.
const res = buildTacMigration({ note, targetChainBinding: TARGET });
const parsed = parseCxferBoundEnvelope(res.envelope);
ok(parsed != null, 'envelope parses as a T_CXFER_BOUND (0x39) note');
eq(lc(parsed.target), lc(TARGET), 'parsed target_chain_binding == launch generation binding');
eq(lc(parsed.asset), lc(TAC), 'parsed asset == legacy TAC');
eq(parsed.commitments.length, 1, 'exactly one output note');
eq(lc(parsed.commitments[0]), lc(res.outCommitment), 'parsed output commitment == builder commitment');

// 3. amount preserved: the output commitment commits the input amount under the fresh output blinding.
const cCheck = '0x' + Buffer.from(pointToBytes(pedersenCommit(note.amount, res.outBlinding))).toString('hex');
eq(lc(cCheck), lc(res.outCommitment), 'output commitment commits the preserved amount (v·H + r·G)');

// 4. guest-mirror conservation: in = the legacy TAC note commitment, out = the bound note, same amount.
//    verifyCxferConservation keys inputs by INTERNAL-order txid (extractInputs convention), so reverse the
//    display txid the builder consumed.
// Rebuild the input commitment point under the pool's injected secp (cxferKernelVerify sums points with it).
const cIn = secp.ProjectivePoint.fromHex(Buffer.from(pointToBytes(pedersenCommit(note.amount, note.blinding))).toString('hex'));
const conserves = pool.verifyCxferConservation({
  asset: TAC,
  inputOutpoints: [[reverseHex(note.outpoint.txid), note.outpoint.vout]],
  inputPoints: [cIn],
  outsCompressed: parsed.commitments,
  rangeProof: parsed.rangeProof,
  kernelSig: parsed.kernelSig,
});
ok(conserves, 'tx conserves under tacit-kernel-v1 + range proof (guest-mirror gate)');

// 5. encoder is the exact inverse of the parser for an arbitrary payload.
const rt = encodeCxferBoundEnvelope({
  target: TARGET, asset: TAC, kernelSig: res.kernelSig,
  outputs: [{ commitment: res.outCommitment, amountCt: '0x' + '00'.repeat(8) }],
  rangeProof: parsed.rangeProof,
});
eq(lc(rt), lc(res.envelope), 'encodeCxferBoundEnvelope reproduces the builder envelope byte-for-byte');

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nAll TAC migration tests passed.');
