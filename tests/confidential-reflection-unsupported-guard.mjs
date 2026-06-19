#!/usr/bin/env node
// Parser parity + fail-loud guard: malformed Tacit envelopes must mirror the Rust guest as plain/no-fold
// traffic (no witness read), while an explicit "parseable guest-folded but unmirrored" marker still lands in
// `unsupportedEnvelopes` and makes the attester refuse. The guest is authoritative, so this is liveness,
// never soundness. Run: node tests/confidential-reflection-unsupported-guard.mjs

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
const varint = (n) => n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 0xff, (n >> 8) & 0xff] : [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

// Build a minimal TACIT Taproot tx whose witness envelope carries `body` after the "TACIT"+v1 frame, so
// extractTaprootEnvelope returns [body] and env[0] == body[0] (the opcode). Mirrors the on-wire shape the
// extractor walks (segwit marker, 1 in / 1 out, a 2-item witness whose item1 is the envelope script).
function tacitTx(body) {
  const payload = [0x54, 0x41, 0x43, 0x49, 0x54, 0x01, ...body]; // "TACIT" ‖ v1 ‖ body
  const pd = payload.length <= 75
    ? [payload.length, ...payload]
    : payload.length <= 255
      ? [0x4c, payload.length & 0xff, ...payload]
      : [0x4d, payload.length & 0xff, (payload.length >> 8) & 0xff, ...payload];
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
    ...varint(script.length), ...script,          // item1 (the envelope script)
    0, 0, 0, 0,                                   // locktime
  ];
  return hexs(tx);
}

// ── Part A: classifyConfidentialTx — the worker's injected classifier ──
// lp_add (0x2D) / lp_remove (0x2E) / cBTC (0x66) now ROUTE for a well-formed envelope (the opening blindings ride
// the wire — option a). A MALFORMED stub (too short for the parser) falls through to null/plain, matching the
// guest's "parse None, read no witnesses" behavior.
const lp = classifyConfidentialTx(tacitTx([0x2D, 1, 2, 3, 4])); // T_LP_ADD (malformed stub)
eq(lp?.type ?? null, null, 'malformed lp_add (0x2D) → null/plain (valid ones route — see amm-classify)');
eq(classifyConfidentialTx(tacitTx([0x66, 9, 9]))?.type ?? null, null, 'malformed cBTC lock (0x66) → null/plain (valid ones route)');
eq(classifyConfidentialTx(tacitTx([0x2E, 0]))?.type ?? null, null, 'malformed lp_remove (0x2E) → null/plain (valid ones route)');
// swap_batch (0x2F) now ROUTES (see tests/confidential-amm-classify.mjs for a full envelope → swap_batch). A
// MALFORMED stub falls through to null/plain (parser returns null), matching the guest.
eq(classifyConfidentialTx(tacitTx([0x2F, 0]))?.type ?? null, null, 'malformed swap_batch (0x2F) → null/plain (valid ones route)');
// The on-chain AMM ops (swap_var 0x32 / swap_route 0x33 / harvest 0x3B / farm_refund 0x3E / protocol_fee 0x31 /
// farm_init 0x34) NOW ROUTE to their folds — see tests/confidential-amm-classify.mjs (a full envelope parses to
// the fold env; a malformed stub still falls through to 'unsupported', which is fine — the guest re-parses txData).
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

const bytes = (n, v = 0) => Array(n).fill(v);
const u32le = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
const burnBody = () => [0x2b, ...bytes(128, 0x07)];
const crossoutBody = () => [0x65, ...bytes(160, 0x08)];
const cbtcBody = () => [0x66, ...bytes(32, 0x09), ...u32le(0), ...bytes(32, 0x0a), ...bytes(32, 0x0b), ...bytes(32, 0x0c), ...bytes(32, 0x0d), ...bytes(32, 0x0e)];
const swapVarBody = ({ withIntent = true, badDirection = false } = {}) => {
  const b = bytes(269 + 64 + (withIntent ? 64 : 0));
  b[0] = 0x32;
  b[33] = badDirection ? 2 : 0;
  return b;
};
const farmInitBody = ({ withLauncher = true } = {}) => {
  const HDR = 1 + 32 + 32 + 33 + 32 + 8 + 8 + 4 + 4 + 33;
  const b = bytes(HDR + 2 + 64 + (withLauncher ? 64 : 0));
  b[0] = 0x34;
  return b;
};
const swapRouteBody = ({ withIntent = true, trailing = false, sameAsset = false, badHopDirection = false, zeroRp = false } = {}) => {
  const b = [0x33, 0x02, ...bytes(32, 0x01), ...bytes(32, sameAsset ? 0x01 : 0x02), ...bytes(8 + 4 + 33)];
  for (let i = 0; i < 2; i++) {
    b.push(...bytes(32, 0x20 + i), badHopDirection && i === 1 ? 2 : i, ...bytes(2), ...bytes(8), ...bytes(8), ...bytes(8), ...bytes(8));
  }
  b.push(...bytes(36), ...bytes(33, 0x02), ...bytes(33, 0x03), ...bytes(32, 0x04));
  b.push(zeroRp ? 0 : 1, 0);
  if (!zeroRp) b.push(0xaa);
  b.push(...bytes(64, 0x05));
  if (withIntent) b.push(...bytes(64, 0x06));
  if (trailing) b.push(0xff);
  return b;
};

eq(classifyConfidentialTx(tacitTx([...burnBody(), 0xff]))?.type ?? null, null, 'burn trailing byte → null/plain (guest exact-length rejects)');
eq(classifyConfidentialTx(tacitTx(crossoutBody()))?.type, 'crossout_mint', 'crossout_mint exact length → crossout_mint');
eq(classifyConfidentialTx(tacitTx([...crossoutBody(), 0xff]))?.type ?? null, null, 'crossout_mint trailing byte → null/plain (guest exact-length rejects)');
eq(classifyConfidentialTx(tacitTx(cbtcBody()))?.type, 'cbtc_lock', 'cBTC lock exact length + real vout → cbtc_lock');
eq(classifyConfidentialTx(tacitTx([...cbtcBody(), 0xff]))?.type ?? null, null, 'cBTC lock trailing byte → null/plain (guest exact-length rejects)');
eq(classifyConfidentialTx(tacitTx(swapVarBody()))?.type, 'swap_var', 'swap_var with kernel+intent sig → swap_var');
eq(classifyConfidentialTx(tacitTx(swapVarBody({ withIntent: false })))?.type ?? null, null, 'swap_var missing intent sig → null/plain');
eq(classifyConfidentialTx(tacitTx(swapVarBody({ badDirection: true })))?.type ?? null, null, 'swap_var bad direction → null/plain');
eq(classifyConfidentialTx(tacitTx(swapRouteBody()))?.type, 'swap_route', 'swap_route exact end + intent sig → swap_route');
eq(classifyConfidentialTx(tacitTx(swapRouteBody({ withIntent: false })))?.type ?? null, null, 'swap_route missing intent sig → null/plain');
eq(classifyConfidentialTx(tacitTx(swapRouteBody({ trailing: true })))?.type ?? null, null, 'swap_route trailing byte → null/plain');
eq(classifyConfidentialTx(tacitTx(swapRouteBody({ sameAsset: true })))?.type ?? null, null, 'swap_route same input/output asset → null/plain');
eq(classifyConfidentialTx(tacitTx(swapRouteBody({ badHopDirection: true })))?.type ?? null, null, 'swap_route bad hop direction → null/plain');
eq(classifyConfidentialTx(tacitTx(swapRouteBody({ zeroRp: true })))?.type ?? null, null, 'swap_route zero range proof length → null/plain');
eq(classifyConfidentialTx(tacitTx(farmInitBody()))?.type, 'farm_init', 'farm_init with kernel+launcher sig → farm_init');
eq(classifyConfidentialTx(tacitTx(farmInitBody({ withLauncher: false })))?.type ?? null, null, 'farm_init missing launcher sig → null/plain');

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
