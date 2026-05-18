// Slot-secret deterministic derivation: Phase 1 of cBTC.zk privkey-only
// recovery. Helpers replace crypto.getRandomValues for (secret, ν) at the
// 8 slot-builder call sites so a fresh wallet can re-derive them from
// (priv, anchorOutpoint, outputIndex). See SPEC-CBTC-ZK §5.21-§5.25 and
// the block comment at dapp/tacit.js::_deriveSlotSecret.
//
// This test covers the CRYPTOGRAPHIC PROPERTIES of the helpers in isolation.
// Phase 2 (plumbing into builders) and Phase 3 (scanSlots) land separately.

import { JSDOM } from 'jsdom';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

const dapp = await import('../dapp/tacit.js');
const { _deriveSlotSecret, _deriveSlotNullifierPreimage, _slotOutpointBytes } = dapp;

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const r = fn();
    if (r === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}: ${r}`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

function eqBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const PRIV_A = new Uint8Array(32).fill(0xa1);
const PRIV_B = new Uint8Array(32).fill(0xb2);

const TXID_A = 'aa' + '11'.repeat(31);
const TXID_B = 'bb' + '22'.repeat(31);

// ---- Outpoint helper ----------------------------------------------------

test('_slotOutpointBytes: 36 B (txid_LE 32 + vout_LE 4)', () => {
  const op = _slotOutpointBytes(TXID_A, 0);
  return op.length === 36 || `len ${op.length}`;
});

test('_slotOutpointBytes: txid is little-endian (reversed from hex display)', () => {
  const op = _slotOutpointBytes(TXID_A, 0);
  // First byte of LE encoding = last hex byte of display. TXID_A ends with 0x11.
  return op[0] === 0x11 || `op[0] = 0x${op[0].toString(16)}`;
});

test('_slotOutpointBytes: vout is u32 LE in trailing 4 bytes', () => {
  const op = _slotOutpointBytes(TXID_A, 0x12345678);
  return op[32] === 0x78 && op[33] === 0x56 && op[34] === 0x34 && op[35] === 0x12
    || `trailing bytes ${[op[32], op[33], op[34], op[35]].map(x => x.toString(16))}`;
});

test('_slotOutpointBytes: rejects non-hex txid', () => {
  try { _slotOutpointBytes('not-hex', 0); return 'should have thrown'; }
  catch { return true; }
});

test('_slotOutpointBytes: rejects out-of-range vout', () => {
  try { _slotOutpointBytes(TXID_A, -1); return 'should have thrown for negative'; }
  catch {}
  try { _slotOutpointBytes(TXID_A, 0x100000000); return 'should have thrown for >u32'; }
  catch { return true; }
});

// ---- Deterministic + per-input-independent ------------------------------

test('secret derivation: deterministic (same inputs → same output)', () => {
  const anchor = _slotOutpointBytes(TXID_A, 0);
  const s1 = _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor });
  const s2 = _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor });
  return eqBytes(s1, s2) || 'derivation not deterministic';
});

test('nullifier derivation: deterministic', () => {
  const anchor = _slotOutpointBytes(TXID_A, 0);
  const n1 = _deriveSlotNullifierPreimage({ privkey: PRIV_A, anchorOutpoint: anchor });
  const n2 = _deriveSlotNullifierPreimage({ privkey: PRIV_A, anchorOutpoint: anchor });
  return eqBytes(n1, n2) || 'derivation not deterministic';
});

test('secret derivation: different privkey → different secret', () => {
  const anchor = _slotOutpointBytes(TXID_A, 0);
  const sA = _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor });
  const sB = _deriveSlotSecret({ privkey: PRIV_B, anchorOutpoint: anchor });
  return !eqBytes(sA, sB) || 'priv collision';
});

test('secret derivation: different anchor txid → different secret', () => {
  const anchor1 = _slotOutpointBytes(TXID_A, 0);
  const anchor2 = _slotOutpointBytes(TXID_B, 0);
  const s1 = _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor1 });
  const s2 = _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor2 });
  return !eqBytes(s1, s2) || 'anchor txid collision';
});

test('secret derivation: different anchor vout → different secret', () => {
  const anchor1 = _slotOutpointBytes(TXID_A, 0);
  const anchor2 = _slotOutpointBytes(TXID_A, 1);
  const s1 = _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor1 });
  const s2 = _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor2 });
  return !eqBytes(s1, s2) || 'vout collision';
});

test('secret derivation: different outputIndex (SPLIT) → different secret', () => {
  const anchor = _slotOutpointBytes(TXID_A, 0);
  const s0 = _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor, outputIndex: 0 });
  const s1 = _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor, outputIndex: 1 });
  const s2 = _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor, outputIndex: 2 });
  if (eqBytes(s0, s1) || eqBytes(s0, s2) || eqBytes(s1, s2)) return 'outputIndex collision';
  return true;
});

// ---- Domain separation: secret ≠ nullifier ------------------------------

test('secret ≠ nullifier for same (priv, anchor, index) — domain-separated', () => {
  const anchor = _slotOutpointBytes(TXID_A, 0);
  const secret    = _deriveSlotSecret(           { privkey: PRIV_A, anchorOutpoint: anchor });
  const nullifier = _deriveSlotNullifierPreimage({ privkey: PRIV_A, anchorOutpoint: anchor });
  return !eqBytes(secret, nullifier) || 'secret == nullifier (domain separation broken)';
});

// ---- Independence across slots (per-(priv, anchor) → independent) -------

test('two different slots from same priv have independent secret + nullifier pairs', () => {
  const anchor1 = _slotOutpointBytes(TXID_A, 0);
  const anchor2 = _slotOutpointBytes(TXID_A, 1);
  const s1 = _deriveSlotSecret({           privkey: PRIV_A, anchorOutpoint: anchor1 });
  const n1 = _deriveSlotNullifierPreimage({ privkey: PRIV_A, anchorOutpoint: anchor1 });
  const s2 = _deriveSlotSecret({           privkey: PRIV_A, anchorOutpoint: anchor2 });
  const n2 = _deriveSlotNullifierPreimage({ privkey: PRIV_A, anchorOutpoint: anchor2 });
  if (eqBytes(s1, s2) || eqBytes(n1, n2) || eqBytes(s1, n2) || eqBytes(n1, s2)) {
    return 'inter-slot collision';
  }
  return true;
});

// ---- Input validation ---------------------------------------------------

test('_deriveSlotSecret: rejects bad privkey length', () => {
  const anchor = _slotOutpointBytes(TXID_A, 0);
  try { _deriveSlotSecret({ privkey: new Uint8Array(16), anchorOutpoint: anchor }); return 'should throw'; }
  catch { return true; }
});

test('_deriveSlotSecret: rejects bad anchor length', () => {
  try { _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: new Uint8Array(32) }); return 'should throw'; }
  catch { return true; }
});

test('_deriveSlotSecret: rejects out-of-range outputIndex', () => {
  const anchor = _slotOutpointBytes(TXID_A, 0);
  try { _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor, outputIndex: -1 }); return 'should throw'; }
  catch {}
  try { _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor, outputIndex: 256 }); return 'should throw'; }
  catch { return true; }
});

// ---- Cross-check against canonical HMAC -----------------------------------

test('secret derivation matches canonical HMAC-SHA256 over (domain || anchor || index)', () => {
  const anchor = _slotOutpointBytes(TXID_A, 0);
  const domain = new TextEncoder().encode('tacit-slot-secret-v1');
  const expected = hmac(sha256, PRIV_A, concatBytes(domain, anchor, new Uint8Array([0])));
  const actual = _deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: anchor });
  return eqBytes(actual, expected) || `expected ${bytesToHex(expected)}, got ${bytesToHex(actual)}`;
});

test('nullifier derivation matches canonical HMAC-SHA256 over (domain || anchor || index)', () => {
  const anchor = _slotOutpointBytes(TXID_A, 0);
  const domain = new TextEncoder().encode('tacit-slot-nullifier-v1');
  const expected = hmac(sha256, PRIV_A, concatBytes(domain, anchor, new Uint8Array([0])));
  const actual = _deriveSlotNullifierPreimage({ privkey: PRIV_A, anchorOutpoint: anchor });
  return eqBytes(actual, expected) || `expected ${bytesToHex(expected)}, got ${bytesToHex(actual)}`;
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
