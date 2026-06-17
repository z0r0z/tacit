// Audit fix (vk-pinning coherence): bind the RUNTIME-authoritative inline
// verifying key to the pinned ceremony artifact.
//
// _fetchMixerVk short-circuits CANONICAL_VK_CID to the inlined
// _CANONICAL_VK_INLINE literal with NO content-hash check, so that literal —
// not the IPFS CID — is the live trust root for every mixer-proof verification.
// Nothing previously bound that literal to the pinned CID / sha256, so a
// hand-edit or merge corruption of the ~1-line JSON could silently ship a
// wrong vk while every other test (bundle file + on-chain Verifier still agree
// with each other) stayed green. This test closes that gap.
//
// Source-level extraction (no jsdom / no tacit.js import) so it runs fast and
// asserts on the exact bytes shipped in dapp/tacit.js.
//
// Run: node tests/mixer-vk-inline-pin.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); failed++; }
}

const src = readFileSync(path.join(ROOT, 'dapp', 'tacit.js'), 'utf8');

function extractConst(name, re) {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name} from dapp/tacit.js`);
  return m[1];
}

const inline = JSON.parse(extractConst('_CANONICAL_VK_INLINE', /const _CANONICAL_VK_INLINE = (\{.*?\});/s));
const vkCid = extractConst('CANONICAL_VK_CID', /const CANONICAL_VK_CID = '([^']+)'/);
const vkSha = extractConst('CANONICAL_VK_SHA256', /const CANONICAL_VK_SHA256 = '([0-9a-f]{64})'/);
const bundle = JSON.parse(readFileSync(path.join(ROOT, 'dapp', 'circuits', 'ceremony-bundle', 'verification_key.json'), 'utf8'));

// rfc4648 base32 (lower-case, no padding) decode for CIDv1 (drop the 'b' multibase prefix).
function base32Decode(s) {
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, val = 0; const out = [];
  for (const c of s) {
    const idx = A.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}

test('inline vk deep-equals the ceremony bundle on all verify-relevant keys', () => {
  for (const k of ['protocol', 'curve', 'nPublic', 'vk_alpha_1', 'vk_beta_2', 'vk_gamma_2', 'vk_delta_2', 'IC']) {
    assert.deepEqual(inline[k], bundle[k], `vk key "${k}" diverged between inline literal and ceremony bundle`);
  }
});

test('inline vk shape matches the circuit (nPublic == 5 public inputs, IC == nPublic+1)', () => {
  // withdraw.circom: public [root, nullifier_hash, denomination, r_leaf, bind_hash]
  assert.equal(inline.nPublic, 5, 'nPublic must be 5');
  assert.equal(inline.IC.length, 6, 'IC must have nPublic+1 = 6 entries');
  assert.equal(inline.protocol, 'groth16');
  assert.equal(inline.curve, 'bn128');
});

test('CANONICAL_VK_SHA256 is the real sha256 of the pinned bundle vk bytes', () => {
  const actual = createHash('sha256')
    .update(readFileSync(path.join(ROOT, 'dapp', 'circuits', 'ceremony-bundle', 'verification_key.json')))
    .digest('hex');
  assert.equal(actual, vkSha, 'bundle verification_key.json sha256 != CANONICAL_VK_SHA256 constant');
});

test('CANONICAL_VK_CID is a CIDv1(raw, sha256) addressing exactly CANONICAL_VK_SHA256', () => {
  assert.ok(vkCid.startsWith('bafkrei'), 'expected a CIDv1 raw-codec sha256 CID (bafkrei…)');
  const b = base32Decode(vkCid.slice(1)); // drop multibase 'b'
  assert.equal(b[0], 0x01, 'CID version must be 1');
  assert.equal(b[1], 0x55, 'codec must be raw (0x55)');
  assert.equal(b[2], 0x12, 'multihash must be sha2-256 (0x12)');
  assert.equal(b[3], 0x20, 'digest length must be 32');
  const embedded = Buffer.from(b.slice(4, 36)).toString('hex');
  assert.equal(embedded, vkSha, 'CID embedded digest != CANONICAL_VK_SHA256 — the pinned CID does not address the audited vk');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
