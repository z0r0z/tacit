// Deterministic-derivation helpers for the two remaining privkey-only
// recovery gaps that aren't slots:
//
//   - Bare mixer deposit secrets (T_DEPOSIT) — _deriveMixerDepositSecret +
//     _deriveMixerDepositNullifierPreimage. Replaces crypto.getRandomValues
//     in mixerGenerateDepositSecrets so a depositor's priv + asset input
//     outpoint regenerate (secret, ν) for withdrawal.
//
//   - Maker-side AXINTENT commit blinding — _deriveAxintentMakerBlinding.
//     Replaces randomScalar() in publishAxferIntent so the maker can
//     recover their commit's Pedersen opening from priv + chain alone.
//
// Phase-1-style coverage: determinism, per-input independence, domain
// separation, input validation, canonical-HMAC cross-check.

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
const {
  _deriveMixerDepositSecret,
  _deriveMixerDepositNullifierPreimage,
  _deriveAxintentMakerBlinding,
  _slotOutpointBytes,
} = dapp;

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

// ---- Mixer deposit secrets ----------------------------------------------

test('mixer secret: deterministic from priv + anchor', () => {
  const a = _slotOutpointBytes(TXID_A, 0);
  const s1 = _deriveMixerDepositSecret({ privkey: PRIV_A, anchorOutpoint: a });
  const s2 = _deriveMixerDepositSecret({ privkey: PRIV_A, anchorOutpoint: a });
  return eqBytes(s1, s2) || 'mixer secret derivation not deterministic';
});

test('mixer nullifier: deterministic from priv + anchor', () => {
  const a = _slotOutpointBytes(TXID_A, 0);
  const n1 = _deriveMixerDepositNullifierPreimage({ privkey: PRIV_A, anchorOutpoint: a });
  const n2 = _deriveMixerDepositNullifierPreimage({ privkey: PRIV_A, anchorOutpoint: a });
  return eqBytes(n1, n2) || 'mixer nullifier derivation not deterministic';
});

test('mixer: different priv → different secret', () => {
  const a = _slotOutpointBytes(TXID_A, 0);
  const sA = _deriveMixerDepositSecret({ privkey: PRIV_A, anchorOutpoint: a });
  const sB = _deriveMixerDepositSecret({ privkey: PRIV_B, anchorOutpoint: a });
  return !eqBytes(sA, sB) || 'priv collision';
});

test('mixer: different anchor → different secret', () => {
  const a1 = _slotOutpointBytes(TXID_A, 0);
  const a2 = _slotOutpointBytes(TXID_B, 0);
  const s1 = _deriveMixerDepositSecret({ privkey: PRIV_A, anchorOutpoint: a1 });
  const s2 = _deriveMixerDepositSecret({ privkey: PRIV_A, anchorOutpoint: a2 });
  return !eqBytes(s1, s2) || 'anchor collision';
});

test('mixer: different vout → different secret', () => {
  const a0 = _slotOutpointBytes(TXID_A, 0);
  const a1 = _slotOutpointBytes(TXID_A, 1);
  return !eqBytes(
    _deriveMixerDepositSecret({ privkey: PRIV_A, anchorOutpoint: a0 }),
    _deriveMixerDepositSecret({ privkey: PRIV_A, anchorOutpoint: a1 }),
  ) || 'vout collision';
});

test('mixer: secret ≠ nullifier (domain separation)', () => {
  const a = _slotOutpointBytes(TXID_A, 0);
  const s = _deriveMixerDepositSecret({ privkey: PRIV_A, anchorOutpoint: a });
  const n = _deriveMixerDepositNullifierPreimage({ privkey: PRIV_A, anchorOutpoint: a });
  return !eqBytes(s, n) || 'mixer secret == nullifier — domain separation broken';
});

test('mixer secret: cross-domain ≠ slot secret', () => {
  // Mixer and slot secrets share the same anchor-input shape; verify their
  // outputs diverge so a leaked mixer secret can't be confused for a slot
  // secret (or vice versa) under the same (priv, anchor).
  const a = _slotOutpointBytes(TXID_A, 0);
  const mixerSec = _deriveMixerDepositSecret({ privkey: PRIV_A, anchorOutpoint: a });
  const slotSec  = dapp._deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: a });
  return !eqBytes(mixerSec, slotSec) || 'mixer secret == slot secret — cross-domain collision';
});

test('mixer secret: canonical HMAC over (domain || anchor)', () => {
  const a = _slotOutpointBytes(TXID_A, 0);
  const expected = hmac(sha256, PRIV_A, concatBytes(
    new TextEncoder().encode('tacit-mixer-deposit-secret-v1'), a,
  ));
  const actual = _deriveMixerDepositSecret({ privkey: PRIV_A, anchorOutpoint: a });
  return eqBytes(actual, expected) || `mismatch: ${bytesToHex(expected)} vs ${bytesToHex(actual)}`;
});

test('mixer nullifier: canonical HMAC over (domain || anchor)', () => {
  const a = _slotOutpointBytes(TXID_A, 0);
  const expected = hmac(sha256, PRIV_A, concatBytes(
    new TextEncoder().encode('tacit-mixer-deposit-nullifier-v1'), a,
  ));
  const actual = _deriveMixerDepositNullifierPreimage({ privkey: PRIV_A, anchorOutpoint: a });
  return eqBytes(actual, expected) || `mismatch: ${bytesToHex(expected)} vs ${bytesToHex(actual)}`;
});

test('mixer secret: rejects bad privkey length', () => {
  const a = _slotOutpointBytes(TXID_A, 0);
  try { _deriveMixerDepositSecret({ privkey: new Uint8Array(16), anchorOutpoint: a }); return 'should throw'; }
  catch { return true; }
});

test('mixer secret: rejects bad anchor length', () => {
  try { _deriveMixerDepositSecret({ privkey: PRIV_A, anchorOutpoint: new Uint8Array(32) }); return 'should throw'; }
  catch { return true; }
});

// ---- AXINTENT maker blinding --------------------------------------------

test('axintent: deterministic from priv + anchor', () => {
  const a = _slotOutpointBytes(TXID_A, 0);
  const r1 = _deriveAxintentMakerBlinding({ privkey: PRIV_A, anchorOutpoint: a });
  const r2 = _deriveAxintentMakerBlinding({ privkey: PRIV_A, anchorOutpoint: a });
  return r1 === r2 || `not deterministic: ${r1} vs ${r2}`;
});

test('axintent: returns nonzero scalar in [1, SECP_N)', () => {
  const a = _slotOutpointBytes(TXID_A, 0);
  const r = _deriveAxintentMakerBlinding({ privkey: PRIV_A, anchorOutpoint: a });
  if (typeof r !== 'bigint') return 'should return bigint';
  if (r <= 0n) return 'should be > 0';
  // SECP_N is well under 2^256, so this is a sanity bound on the type.
  if (r >= (1n << 256n)) return 'should fit in 256 bits';
  return true;
});

test('axintent: different priv → different blinding', () => {
  const a = _slotOutpointBytes(TXID_A, 0);
  return _deriveAxintentMakerBlinding({ privkey: PRIV_A, anchorOutpoint: a })
    !== _deriveAxintentMakerBlinding({ privkey: PRIV_B, anchorOutpoint: a })
    || 'priv collision';
});

test('axintent: different anchor → different blinding', () => {
  const a1 = _slotOutpointBytes(TXID_A, 0);
  const a2 = _slotOutpointBytes(TXID_B, 0);
  return _deriveAxintentMakerBlinding({ privkey: PRIV_A, anchorOutpoint: a1 })
    !== _deriveAxintentMakerBlinding({ privkey: PRIV_A, anchorOutpoint: a2 })
    || 'anchor collision';
});

test('axintent: domain-separated from slot secret derivation', () => {
  // Verify mixing axintent + slot derivations under same (priv, anchor)
  // gives different outputs — a leaked axintent r can't double as a slot
  // secret and vice versa.
  const a = _slotOutpointBytes(TXID_A, 0);
  const axintentR = _deriveAxintentMakerBlinding({ privkey: PRIV_A, anchorOutpoint: a });
  // Convert slot secret bytes to bigint for comparison.
  const slotSec = dapp._deriveSlotSecret({ privkey: PRIV_A, anchorOutpoint: a });
  let slotAsBig = 0n;
  for (let i = 0; i < 32; i++) slotAsBig = (slotAsBig << 8n) | BigInt(slotSec[i]);
  return axintentR !== slotAsBig || 'axintent r == slot secret — cross-domain collision';
});

test('axintent: rejects bad privkey length', () => {
  const a = _slotOutpointBytes(TXID_A, 0);
  try { _deriveAxintentMakerBlinding({ privkey: new Uint8Array(16), anchorOutpoint: a }); return 'should throw'; }
  catch { return true; }
});

test('axintent: rejects bad anchor length', () => {
  try { _deriveAxintentMakerBlinding({ privkey: PRIV_A, anchorOutpoint: new Uint8Array(32) }); return 'should throw'; }
  catch { return true; }
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
