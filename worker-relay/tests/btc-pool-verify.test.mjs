// Halo2 verifier for the Bitcoin shielded pool: pin loading and verdicts on the stored proof vectors.
//   node worker-relay/tests/btc-pool-verify.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { makeBtcPoolVerifier, loadBtcPoolKey, vkDigest, DEFAULT_PIN_PATH } from '../src/lib/btc-pool-verify.js';
import { HALO2_PROOF_LEN, HALO2_SYSTEM_ID } from '../../dapp/btc-pool-halo2-prover.js';

const PIN = JSON.parse(readFileSync(DEFAULT_PIN_PATH, 'utf8'));
const PIN_DIR = dirname(DEFAULT_PIN_PATH);
const VK_PATH = join(PIN_DIR, PIN.vk);
const VK = new Uint8Array(readFileSync(VK_PATH));
const VECTORS = JSON.parse(readFileSync(new URL('../../tests/vectors/btc-pool-halo2-proofs.json', import.meta.url), 'utf8'));
const unhex = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));

const dir = mkdtempSync(join(tmpdir(), 'btc-pool-verify-'));
// A different key: the pinned bytes with one byte flipped near the end.
const OTHER_VK = Uint8Array.from(VK);
OTHER_VK[OTHER_VK.length - 40] ^= 1;
const OTHER_VK_PATH = join(dir, 'other_vk.bin');
writeFileSync(OTHER_VK_PATH, OTHER_VK);
// A mainnet copy of the pin with its files beside it.
const MAINNET_PIN_PATH = join(dir, 'pin.json');
writeFileSync(MAINNET_PIN_PATH, JSON.stringify({ ...PIN, network: 'mainnet' }));
for (const f of [PIN.vk, PIN.params, PIN.wasm]) copyFileSync(join(PIN_DIR, f), join(dir, f));
// A pin whose params hash is wrong.
const BADPARAMS_DIR = mkdtempSync(join(tmpdir(), 'btc-pool-verify-'));
writeFileSync(join(BADPARAMS_DIR, 'pin.json'), JSON.stringify({ ...PIN, params_sha256: '00'.repeat(32) }));
for (const f of [PIN.vk, PIN.params, PIN.wasm]) copyFileSync(join(PIN_DIR, f), join(BADPARAMS_DIR, f));

const quiet = () => {};
const tests = [];
const test = (n, f) => tests.push([n, f]);

test('default pin: dapp/btc-pool/pin.json names the key, its BLAKE2b-512 and the pinned files', async () => {
  const k = loadBtcPoolKey({ env: {} });
  assert.equal(k.vkHash, PIN.vk_hash);
  assert.equal(k.vkFile, VK_PATH);
  assert.deepEqual(k.vk, VK);
  assert.equal(vkDigest(VK), PIN.vk_hash);
  assert.equal(PIN.system, HALO2_SYSTEM_ID);
  assert.equal(PIN.proof_bytes, HALO2_PROOF_LEN);
  const v = makeBtcPoolVerifier({ env: {}, log: quiet });
  assert.equal(v.enabled, true);
  assert.equal(v.reason, null);
  assert.equal(v.vkHash, PIN.vk_hash);
  assert.equal(v.system.id, HALO2_SYSTEM_ID);
  assert.equal(v.system.wireLen, HALO2_PROOF_LEN);
  assert.equal(typeof v.verify, 'function');
  assert.equal(await v.ready(), true);
});

test('stored proof vectors use the pinned key', () => {
  assert.equal(VECTORS.vk_hash, PIN.vk_hash);
  assert.ok(VECTORS.cases.some((c) => c.valid) && VECTORS.cases.some((c) => !c.valid));
});

test('hash mismatch disables verification, verify is null', () => {
  const logs = [];
  const v = makeBtcPoolVerifier({ env: { BTC_POOL_VK_HASH: '00'.repeat(64) }, log: (m) => logs.push(m) });
  assert.equal(v.enabled, false);
  assert.equal(v.verify, null);
  assert.equal(v.system, null);
  assert.match(v.reason, /not the pinned/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /DISABLED/);
  // A replaced key file without a matching hash.
  const w = makeBtcPoolVerifier({ env: { BTC_POOL_VK: OTHER_VK_PATH }, log: quiet });
  assert.equal(w.enabled, false);
  assert.match(w.reason, /not the pinned/);
  // Params that differ from their pin.
  const x = makeBtcPoolVerifier({ env: { BTC_POOL_PIN: join(BADPARAMS_DIR, 'pin.json') }, log: quiet });
  assert.equal(x.enabled, false);
  assert.match(x.reason, /params-k13.bin does not match/);
});

test('malformed hash or missing key file disables verification', () => {
  const a = makeBtcPoolVerifier({ env: { BTC_POOL_VK_HASH: '0x12' }, log: quiet });
  assert.equal(a.enabled, false);
  assert.match(a.reason, /malformed/);
  const a2 = makeBtcPoolVerifier({ env: { BTC_POOL_VK_HASH: 'ab'.repeat(32) }, log: quiet });
  assert.equal(a2.enabled, false, 'a 32-byte hash is not a BLAKE2b-512');
  const b = makeBtcPoolVerifier({ env: { BTC_POOL_VK: join(dir, 'missing.bin') }, log: quiet });
  assert.equal(b.enabled, false);
  assert.match(b.reason, /unavailable/);
  const c = makeBtcPoolVerifier({ env: { BTC_POOL_PIN: join(dir, 'nope.json') }, log: quiet });
  assert.equal(c.enabled, false);
});

test('pin for another network disables verification', () => {
  const a = makeBtcPoolVerifier({ network: 'mainnet', env: {}, log: quiet });
  assert.equal(a.enabled, false);
  assert.equal(a.verify, null);
  assert.match(a.reason, /is for signet, not mainnet/);
  const b = makeBtcPoolVerifier({ network: 'signet', env: { BTC_POOL_PIN: MAINNET_PIN_PATH }, log: quiet });
  assert.equal(b.enabled, false);
  assert.match(b.reason, /is for mainnet, not signet/);
  assert.throws(() => loadBtcPoolKey({ env: {}, network: 'mainnet' }), /is for signet/);
  const c = makeBtcPoolVerifier({ network: 'mainnet', env: { BTC_POOL_PIN: MAINNET_PIN_PATH }, log: quiet });
  assert.equal(c.enabled, true);
  assert.equal(c.vkHash, PIN.vk_hash);
});

test('BTC_POOL_VK and BTC_POOL_VK_HASH override the pin', () => {
  const h = vkDigest(OTHER_VK);
  assert.notEqual(h, PIN.vk_hash);
  const k = loadBtcPoolKey({ env: { BTC_POOL_VK: OTHER_VK_PATH, BTC_POOL_VK_HASH: '0x' + h.toUpperCase() } });
  assert.equal(k.vkFile, OTHER_VK_PATH);
  assert.equal(k.vkHash, h);
  const v = makeBtcPoolVerifier({ env: { BTC_POOL_VK: OTHER_VK_PATH, BTC_POOL_VK_HASH: h }, log: quiet });
  assert.equal(v.enabled, true);
  assert.equal(v.vkHash, h);
  const w = makeBtcPoolVerifier({ env: { BTC_POOL_VK: join(dir, PIN.vk) }, log: quiet });
  assert.equal(w.enabled, true);
  assert.equal(w.vkHash, PIN.vk_hash);
  const x = makeBtcPoolVerifier({ network: 'mainnet', env: { BTC_POOL_VK_HASH: PIN.vk_hash }, log: quiet });
  assert.equal(x.enabled, true);
});

test('stored Halo2 cases verify to their expected verdict', async () => {
  const v = makeBtcPoolVerifier({ env: {}, log: quiet });
  for (const c of VECTORS.cases) {
    const proof = unhex(c.proof);
    assert.equal(proof.length, HALO2_PROOF_LEN);
    assert.equal(await v.verify({ proof, publics: c.publics }), c.valid, c.name);
  }
});

test('tampered publics or proof, wrong-length wire, wrong public count are rejected', async () => {
  const v = makeBtcPoolVerifier({ env: {}, log: quiet });
  const c = VECTORS.cases.find((x) => x.valid);
  const proof = unhex(c.proof);
  assert.equal(await v.verify({ proof, publics: c.publics }), true);
  for (let i = 0; i < c.publics.length; i++) {
    const p = [...c.publics];
    p[i] = (BigInt(p[i]) + 1n).toString();
    assert.equal(await v.verify({ proof, publics: p }), false, `public ${i}`);
  }
  for (const at of [0, 31, 64, 700, 1400, 2047, 2079]) {
    const t = Uint8Array.from(proof);
    t[at] ^= 1;
    assert.equal(await v.verify({ proof: t, publics: c.publics }), false, `proof byte ${at}`);
  }
  const other = VECTORS.cases.find((x) => x.valid && x !== c);
  assert.equal(await v.verify({ proof: unhex(other.proof), publics: c.publics }), false, 'proof of another statement');
  assert.equal(await v.verify({ proof: proof.slice(0, HALO2_PROOF_LEN - 1), publics: c.publics }), false);
  assert.equal(await v.verify({ proof: Uint8Array.from([...proof, 0]), publics: c.publics }), false, 'trailing byte');
  assert.equal(await v.verify({ proof: new Uint8Array(0), publics: c.publics }), false);
  assert.equal(await v.verify({ proof: c.proof, publics: c.publics }), false, 'hex string is not a wire');
  assert.equal(await v.verify({ proof, publics: c.publics.slice(1) }), false);
  assert.equal(await v.verify({ proof, publics: c.publics.map((x, i) => (i === 0 ? '-1' : x)) }), false, 'negative public');
  const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  assert.equal(await v.verify({ proof, publics: c.publics.map((x, i) => (i === 0 ? (BigInt(x) + p).toString() : x)) }), false, 'non-canonical public');
  assert.equal(await v.verify({ proof: new Uint8Array(HALO2_PROOF_LEN), publics: c.publics }), false, 'zero wire');
});

let passed = 0;
const t0 = performance.now();
try {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('  ok -', n); } catch (e) { console.error('  FAIL -', n); console.error(e); process.exitCode = 1; }
  }
} finally { rmSync(dir, { recursive: true, force: true }); rmSync(BADPARAMS_DIR, { recursive: true, force: true }); }
console.log(`${passed}/${tests.length} passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
