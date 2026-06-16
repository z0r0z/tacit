#!/usr/bin/env node
// Fail-loud guard: the reflection scan must SURFACE (never silently treat as plain) any Tacit envelope
// the guest folds but the JS scan does not yet mirror (AMM lp/swap/route/batch, farm, protocol-fee claim,
// cBTC lock, bid, crossout, AXFER). classifyConfidentialTx tags them {type:'unsupported'}; the assembler
// collects them in `unsupportedEnvelopes`; the attester REFUSES the batch — so the relay halts loud rather
// than attest a divergent (witness-desynced) root. The guest is authoritative, so this is liveness, never
// soundness. Run: node tests/confidential-reflection-unsupported-guard.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { makeScanReflectionAttester } from '../worker/src/reflection-attest.js';
import { conservingZeroCxfer } from './_conserving-cxfer.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };
const hexs = (a) => Buffer.from(a).toString('hex');

// Build a minimal TACIT Taproot tx whose witness envelope carries `body` after the "TACIT"+v1 frame, so
// extractTaprootEnvelope returns [body] and env[0] == body[0] (the opcode). Mirrors the on-wire shape the
// extractor walks (segwit marker, 1 in / 1 out, a 2-item witness whose item1 is the envelope script).
function tacitTx(body) {
  const payload = [0x54, 0x41, 0x43, 0x49, 0x54, 0x01, ...body]; // "TACIT" ‖ v1 ‖ body
  const pd = payload.length <= 75 ? [payload.length, ...payload] : [0x4c, payload.length & 0xff, ...payload];
  const script = [0x20, ...Array(32).fill(0xab), 0xac, 0x00, 0x63, ...pd, 0x68]; // PUSH32 xonly CHECKSIG FALSE IF <payload> ENDIF
  const tx = [
    2, 0, 0, 0,                                   // version
    0x00, 0x01,                                   // segwit marker + flag
    1,                                            // inCount
    ...Array(32).fill(0), 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, // input: prevTxid, vout, scriptSigLen=0, sequence
    1,                                            // outCount
    0, 0, 0, 0, 0, 0, 0, 0, 0,                     // output: value=0, scriptPubKeyLen=0
    2,                                            // witness item count
    1, 0x00,                                      // item0 (signature, skipped)
    script.length, ...script,                     // item1 (the envelope script)
    0, 0, 0, 0,                                   // locktime
  ];
  return hexs(tx);
}

// ── Part A: classifyConfidentialTx — the worker's injected classifier ──
const lp = classifyConfidentialTx(tacitTx([0x2D, 1, 2, 3, 4])); // T_LP_ADD
eq(lp && lp.type, 'unsupported', 'lp_add (0x2D) → unsupported');
eq(lp && lp.opcode, 0x2D, 'lp_add opcode surfaced for the operator');
eq(classifyConfidentialTx(tacitTx([0x66, 9, 9]))?.type, 'unsupported', 'cBTC lock (0x66) → unsupported');
eq(classifyConfidentialTx(tacitTx([0x32, 0]))?.type, 'unsupported', 'swap_var (0x32) → unsupported');
eq(classifyConfidentialTx(tacitTx([0x33, 0]))?.type, 'unsupported', 'swap_route (0x33) → unsupported');
eq(classifyConfidentialTx(tacitTx([0x31, 0]))?.type, 'unsupported', 'protocol_fee_claim (0x31) → unsupported');
eq(classifyConfidentialTx(tacitTx([0x3E, 0]))?.type, 'unsupported', 'farm_refund (0x3E) → unsupported');
// AXFER (atomic settlement) folds via the SAME parse_cxfer_envelope_full → fold_cxfer as cxfer, so the JS
// mirrors it as 'cxfer' (identical fold → digest parity). A minimal valid cxfer body: opcode ‖ asset(32) ‖
// kernelSig(64) ‖ N=1 ‖ commitment(33) ‖ amount_ct(8) ‖ rpLen=0.
const cxferBody = (op) => [op, ...Array(32).fill(0xa5), ...Array(64).fill(0x11), 0x01, ...Array(33).fill(0x02), ...Array(8).fill(0), 0x00, 0x00];
eq(classifyConfidentialTx(tacitTx(cxferBody(0x22)))?.type, 'cxfer', 'cxfer (0x22) → cxfer');
eq(classifyConfidentialTx(tacitTx(cxferBody(0x26)))?.type, 'cxfer', 'AXFER (0x26) → cxfer (mirrored: same fold as cxfer)');
eq(classifyConfidentialTx(tacitTx(cxferBody(0x3d)))?.type, 'cxfer', 'AXFER (0x3D) → cxfer (mirrored)');
eq(classifyConfidentialTx(tacitTx([0x21, 0]))?.type ?? null, null, 'cetch (0x21) → null (created-not-folded, safe as plain)');
eq(classifyConfidentialTx(tacitTx([0x24, 0]))?.type ?? null, null, 'cmint (0x24) → null (created-not-folded, safe as plain)');
eq(classifyConfidentialTx(tacitTx([0x2b, ...Array(128).fill(7)]))?.type, 'burn', 'burn (0x2b) still classifies (whitelist before guard)');
eq(classifyConfidentialTx('00'.repeat(20)) ?? null, null, 'non-TACIT tx → null (no false positive)');

// ── Part B: the attester REFUSES a batch carrying an unsupported (guest-folded) envelope ──
const dtx = (b) => '0x' + b.toString(16).padStart(2, '0') + 'ff'.repeat(31);
const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const assetId = v(0xa55e7);
let store = null;
const storage = { load: async () => store, save: async (s) => { store = JSON.parse(JSON.stringify(s)); } };
const getHeaders = async (hs) => hs.map((h) => '0x' + h.toString(16).padStart(2, '0').repeat(40));
const prove = async () => ({ vkey: '0xvk', publicValues: '0xpv', proofBytes: '0xpf' });
const submit = async () => '0xtxhash';

const run = async () => {
  // An LP tx the JS scan can't fold yet (tagged as classifyConfidentialTx would tag it).
  const BAD = { 500: { txs: [{ txidDisplay: dtx(0x10), rawHex: 'aa'.repeat(60), vins: [], decode: { type: 'unsupported', opcode: 0x2D } }] } };
  const attBad = makeScanReflectionAttester({ deps, storage, prove, submit, getBlockTxs: async (h) => BAD[h] || { txs: [] }, getHeaders, genesisHeight: 500 });
  await attBad.setTip(500);
  let threw = false;
  try { await attBad.assembleJob(); } catch (e) { threw = /unmirrored guest-folded/.test(e.message); }
  ok(threw, 'attester REFUSES a batch with an unsupported (guest-folded) envelope');

  // Control: a clean cxfer batch still assembles (the guard does not over-trip).
  store = null;
  const OK = { 600: { txs: [{ txidDisplay: dtx(0x20), rawHex: 'bb'.repeat(60), vins: [], decode: { type: 'cxfer', assetId, ...conservingZeroCxfer(assetId, [5n]) } }] } };
  const attOk = makeScanReflectionAttester({ deps, storage, prove, submit, getBlockTxs: async (h) => OK[h] || { txs: [] }, getHeaders, genesisHeight: 600 });
  await attOk.setTip(600);
  const job = await attOk.assembleJob();
  ok(job && job.blocks === 1, 'a clean cxfer batch still assembles (guard does not over-trip)');

  console.log(failures ? `\n${failures} FAIL` : '\nall ok');
  process.exit(failures ? 1 : 0);
};
run();
