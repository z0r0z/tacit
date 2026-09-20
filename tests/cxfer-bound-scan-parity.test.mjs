// T_CXFER_BOUND (0x39) wire parity for the holdings scanner.
//
// The generation-bound CXFER is the note class the Ethereum fast lane can spend: its reflected leaf is
// btc_note_leaf_bound(asset‖Cx‖Cy‖auth_key‖chain_binding) rather than the legacy btc_note_leaf(…). Until
// dapp/tacit.js grew a branch for it, scanHoldings recognized 0x22/0x23 but not 0x39, so a holder who
// received a bound note saw nothing in their wallet — tests/recovery-parity.test.mjs reported it as the
// one GAPS entry.
//
// The scanner's decoder has to agree with the encoder byte for byte, and the two live in different files
// (dapp/tacit.js vs dapp/burn-deposit-bitcoin.js), so a textual guardrail is not enough. This test lifts
// decodeCXferBoundPayload out of the dapp bundle and round-trips it against the real encoder, then pins
// the field offsets against the wire spec that cxfer-core::bitcoin::parse_cxfer_bound_envelope implements:
//
//   0x39 ‖ target(32) ‖ asset_id(32) ‖ kernel_sig(64) ‖ N(1∈{1,2,4,8})
//        ‖ N×(commitment(33) ‖ amount_ct(8)) ‖ rpLen(2 LE) ‖ rangeproof
//
// Run: node tests/cxfer-bound-scan-parity.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeCxferBoundEnvelope } from '../dapp/burn-deposit-bitcoin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

let pass = 0, fail = 0;
const test = (label, fn) => {
  try { fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: ${a} !== ${b}`); };
const hexToBytes = (h) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// Lift the decoder out of the bundle rather than importing it (tacit.js needs browser globals).
const dappSrc = readFileSync(join(REPO_ROOT, 'dapp/tacit.js'), 'utf8');
const fnStart = dappSrc.indexOf('function decodeCXferBoundPayload(payload) {');
if (fnStart < 0) throw new Error('decodeCXferBoundPayload not found in dapp/tacit.js');
// Walk braces to the function's end so the extraction survives edits inside it.
let depth = 0, i = dappSrc.indexOf('{', fnStart), end = -1;
for (; i < dappSrc.length; i++) {
  if (dappSrc[i] === '{') depth++;
  else if (dappSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const decodeCXferBoundPayload = new Function(
  `const T_CXFER_BOUND = 0x39; ${dappSrc.slice(fnStart, end)} return decodeCXferBoundPayload;`,
)();

const TARGET = new Uint8Array(32).fill(0x7c);
const ASSET  = new Uint8Array(32).fill(0xab);
const KSIG   = new Uint8Array(64).fill(0x5e);
const mkOutputs = (n) => Array.from({ length: n }, (_, k) => ({
  commitment: Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x10 + k)]),
  amountCt: Uint8Array.from(new Uint8Array(8).fill(0x30 + k)),
}));
const RP = Uint8Array.from(new Uint8Array(200).fill(0xee));

const build = (n, rp = RP) => hexToBytes(encodeCxferBoundEnvelope({
  target: TARGET, asset: ASSET, kernelSig: KSIG, outputs: mkOutputs(n), rangeProof: rp,
}));

console.log('T_CXFER_BOUND (0x39) scanner wire parity:\n');

for (const n of [1, 2, 4, 8]) {
  test(`round-trips a ${n}-output bound envelope built by the real encoder`, () => {
    const dec = decodeCXferBoundPayload(build(n));
    if (!dec) throw new Error('decoder returned null');
    eq(dec.kind, 'cxferbound', 'kind');
    eq(bytesToHex(dec.targetChainBinding), bytesToHex(TARGET), 'target_chain_binding');
    eq(bytesToHex(dec.assetId), bytesToHex(ASSET), 'asset_id');
    eq(bytesToHex(dec.kernelSig), bytesToHex(KSIG), 'kernel_sig');
    eq(dec.outputs.length, n, 'output count');
    const want = mkOutputs(n);
    for (let k = 0; k < n; k++) {
      eq(bytesToHex(dec.outputs[k].commitment), bytesToHex(want[k].commitment), `output[${k}].commitment`);
      eq(bytesToHex(dec.outputs[k].encryptedAmount), bytesToHex(want[k].amountCt), `output[${k}].encryptedAmount`);
    }
    eq(bytesToHex(dec.rangeproof), bytesToHex(RP), 'rangeproof');
  });
}

test('the decoded shape matches what the scanner consumes (assetId + outputs[vout].{commitment,encryptedAmount})', () => {
  const dec = decodeCXferBoundPayload(build(2));
  // These are exactly the fields the holdings identification and recovery branches read.
  if (!(dec.assetId instanceof Uint8Array) || dec.assetId.length !== 32) throw new Error('assetId shape');
  for (const o of dec.outputs) {
    if (!(o.commitment instanceof Uint8Array) || o.commitment.length !== 33) throw new Error('commitment shape');
    if (!(o.encryptedAmount instanceof Uint8Array) || o.encryptedAmount.length !== 8) throw new Error('encryptedAmount shape');
  }
});

test('field offsets match the cxfer-core wire spec', () => {
  const env = build(1);
  eq(env[0], 0x39, 'opcode');
  eq(bytesToHex(env.slice(1, 33)), bytesToHex(TARGET), 'target at [1,33)');
  eq(bytesToHex(env.slice(33, 65)), bytesToHex(ASSET), 'asset at [33,65)');
  eq(bytesToHex(env.slice(65, 129)), bytesToHex(KSIG), 'kernel_sig at [65,129)');
  eq(env[129], 1, 'N at [129]');
});

test('rejects a plain T_CXFER (0x23) envelope — domains stay disjoint', () => {
  const env = build(1);
  env[0] = 0x23;
  if (decodeCXferBoundPayload(env) !== null) throw new Error('accepted a 0x23 payload');
});

test('rejects a truncated envelope', () => {
  const env = build(2);
  if (decodeCXferBoundPayload(env.slice(0, env.length - 1)) !== null) throw new Error('accepted a truncated payload');
});

test('rejects trailing bytes past the declared rangeproof length', () => {
  const env = build(1);
  const padded = new Uint8Array(env.length + 1);
  padded.set(env); padded[env.length] = 0xff;
  if (decodeCXferBoundPayload(padded) !== null) throw new Error('accepted trailing bytes');
});

test('rejects a non-aggregation output count', () => {
  const env = build(2);
  env[129] = 3; // N must be one of {1,2,4,8}
  if (decodeCXferBoundPayload(env) !== null) throw new Error('accepted N=3');
});

test('a zero-length rangeproof still parses (length is explicit, not inferred)', () => {
  const dec = decodeCXferBoundPayload(build(1, new Uint8Array(0)));
  if (!dec) throw new Error('decoder returned null');
  eq(dec.rangeproof.length, 0, 'rangeproof length');
});

test('the scanner dispatches 0x39 in both the identification and recovery branches', () => {
  const idBranch = dappSrc.includes('env.opcode === T_CXFER_BOUND ? decodeCXferBoundPayload(env.payload)');
  if (!idBranch) throw new Error('no decodeCXferBoundPayload dispatch in the scan branches');
  const n = dappSrc.split('env.opcode === T_CXFER_BOUND ? decodeCXferBoundPayload(env.payload)').length - 1;
  if (n < 2) throw new Error(`expected the dispatch in identification AND recovery, found ${n}`);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
