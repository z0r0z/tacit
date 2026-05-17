// Parity tests: dapp/amm-bjj.js + dapp/amm-sigma.js MUST produce byte-identical
// output to tests/amm-bjj.mjs + tests/amm-sigma-xcurve.mjs.
//
// Why this matters: the dapp will construct T_LP_ADD POOL_INIT payloads with
// (shareCSecp, shareCBJJ, shareXcurveSigma). The worker verifier deserializes
// those bytes and re-runs verifyXCurve. If the dapp's BJJ pedersen produces
// a different packed-point than the test reference, the worker rejects every
// pool-init the dapp tries to broadcast.
//
// Coverage:
//   1. BJJ generator parity (H_BJJ, G_BJJ) — packed-point bytes match
//   2. BJJ pedersen commit parity for representative (amount, blinding) pairs
//   3. XCurve sigma proof+verify parity (dapp prove → worker verify, vice versa)
//   4. XCurve domain string consistency (challenge matches)

import { JSDOM } from 'jsdom';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }

const dappBJJ = await import('../dapp/amm-bjj.js');
const dappSigma = await import('../dapp/amm-sigma.js');
const refBJJ = await import('./amm-bjj.mjs');
const refSigma = await import('./amm-sigma-xcurve.mjs');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(t) { console.log(`\n${t}:`); }

function bytesEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ============== BJJ generator parity ==============
group('BJJ generator parity');
{
  const dappH = dappBJJ.packPoint(dappBJJ.H_BJJ());
  const refH = refBJJ.packPoint(refBJJ.H_BJJ());
  ok('H_BJJ packed bytes match', bytesEq(dappH, refH));
  const dappG = dappBJJ.packPoint(dappBJJ.G_BJJ());
  const refG = refBJJ.packPoint(refBJJ.G_BJJ());
  ok('G_BJJ packed bytes match', bytesEq(dappG, refG));
}

// ============== BJJ pedersen parity ==============
group('pedersenBJJ commit parity');
{
  const cases = [
    [0n, 0n],                  // padded-slot identity
    [1n, 1n],                  // smallest non-trivial
    [10_000n, 0xdeadbeefn],    // realistic
    [(1n << 63n) - 1n, (1n << 200n) | 7n],  // near-bounds
    [100_000_000n, 0n],        // 1 BTC, zero blinding (note: legal in non-strict)
  ];
  for (const [a, r] of cases) {
    const dC = dappBJJ.packPoint(dappBJJ.pedersenBJJ(a, r));
    const rC = refBJJ.packPoint(refBJJ.pedersenBJJ(a, r));
    ok(`pedersenBJJ(${a}, ${r}) packed-byte parity`, bytesEq(dC, rC));
  }
}

// ============== XCurve sigma — dapp prove → ref verify ==============
group('XCurve sigma: dapp prove → ref verify');
{
  // Use a deterministic RNG seed so the test is reproducible.
  let i = 0;
  const seed = new Uint8Array(40 * 8 + 32 * 16).fill(0);
  for (let j = 0; j < seed.length; j++) seed[j] = (j * 17 + 3) & 0xff;
  const detRng = (len) => seed.subarray(i, (i += len));
  const a = 12_345_678n;
  const r_secp = 0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789n;
  const r_BJJ  = 0x123456789abcdef123456789abcdef123456789abcdef123456789abcdef1234n;
  const { proof, C_secp_bytes, C_BJJ_bytes } = dappSigma.proveXCurveRaw({ a, r_secp, r_BJJ, rng: detRng });
  ok('dapp proof length is 169', proof.length === 169);
  ok('C_secp_bytes is 33', C_secp_bytes.length === 33);
  ok('C_BJJ_bytes is 32', C_BJJ_bytes.length === 32);
  ok('ref verifyXCurve accepts dapp proof',
    refSigma.verifyXCurve(proof, C_secp_bytes, C_BJJ_bytes) === true);
  ok('dapp verifyXCurve accepts dapp proof',
    dappSigma.verifyXCurve(proof, C_secp_bytes, C_BJJ_bytes) === true);
}

// ============== XCurve sigma — ref prove → dapp verify ==============
group('XCurve sigma: ref prove → dapp verify');
{
  let i = 0;
  const seed = new Uint8Array(40 * 8 + 32 * 16).fill(0);
  for (let j = 0; j < seed.length; j++) seed[j] = (j * 31 + 5) & 0xff;
  const detRng = (len) => seed.subarray(i, (i += len));
  const a = 999n;
  const r_secp = 0x111111111111111111111111111111111111111111111111111111111111111fn;
  const r_BJJ  = 0x2222222222222222222222222222222222222222222222222222222222222222n;
  const { proof, C_secp_bytes, C_BJJ_bytes } = refSigma.proveXCurve({ a, r_secp, r_BJJ, rng: detRng });
  ok('dapp verifyXCurve accepts ref proof',
    dappSigma.verifyXCurve(proof, C_secp_bytes, C_BJJ_bytes) === true);
}

// ============== Domain tag pinning ==============
group('Domain tag pinning');
{
  // Both sides MUST hash with 'tacit-amm-xcurve-v1'. If either drifts, the
  // FS challenge will differ and proofs round-trip-fail. Indirect check:
  // dapp's challenge() and ref's challenge() must produce identical results.
  const Cs = new Uint8Array(33).fill(0x02);
  const Cb = new Uint8Array(32).fill(0x42);
  const As = new Uint8Array(33).fill(0x02);
  const Ab = new Uint8Array(32).fill(0x55);
  const dE = dappSigma.challenge(Cs, Cb, As, Ab);
  const rE = refSigma.challenge(Cs, Cb, As, Ab);
  ok('FS challenge parity (domain tag agreement)', dE === rE);
}

// ============== summary ==============
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
