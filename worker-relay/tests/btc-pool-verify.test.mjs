// Native Groth16 verifier for the Bitcoin shielded pool: pin loading and verdicts on the stored proof vectors.
//   node worker-relay/tests/btc-pool-verify.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { makeBtcPoolVerifier, loadBtcPoolKey, DEFAULT_PIN_PATH } from '../src/lib/btc-pool-verify.js';
import { vkHash, PROOF_WIRE_LEN, GROTH16_SYSTEM_ID } from '../../dapp/btc-pool-zk-prover.js';

const PIN = JSON.parse(readFileSync(DEFAULT_PIN_PATH, 'utf8'));
const VK_PATH = join(dirname(DEFAULT_PIN_PATH), PIN.vk);
const VK = JSON.parse(readFileSync(VK_PATH, 'utf8'));
const VECTORS = JSON.parse(readFileSync(new URL('../../tests/vectors/btc-pool-zk-vectors.json', import.meta.url), 'utf8')).groth16;
const unhex = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));

const dir = mkdtempSync(join(tmpdir(), 'btc-pool-verify-'));
// A different key: the pinned one with its IC points swapped.
const OTHER_VK = { ...VK, IC: [VK.IC[1], VK.IC[0], ...VK.IC.slice(2)] };
const OTHER_VK_PATH = join(dir, 'other_vk.json');
writeFileSync(OTHER_VK_PATH, JSON.stringify(OTHER_VK));
const MAINNET_PIN_PATH = join(dir, 'pin.json');
writeFileSync(MAINNET_PIN_PATH, JSON.stringify({ ...PIN, network: 'mainnet' }));
writeFileSync(join(dir, PIN.vk), JSON.stringify(VK));

const quiet = () => {};
const tests = [];
const test = (n, f) => tests.push([n, f]);

test('default pin: dapp/btc-pool/pin.json names the key and its vk_hash', () => {
  const k = loadBtcPoolKey({ env: {} });
  assert.equal(k.vkHash, PIN.vk_hash);
  assert.equal(k.vkFile, VK_PATH);
  assert.deepEqual(k.vk, VK);
  assert.equal(vkHash(VK), PIN.vk_hash);
  const v = makeBtcPoolVerifier({ env: {}, log: quiet });
  assert.equal(v.enabled, true);
  assert.equal(v.reason, null);
  assert.equal(v.vkHash, PIN.vk_hash);
  assert.equal(v.system.id, GROTH16_SYSTEM_ID);
  assert.equal(typeof v.verify, 'function');
});

test('stored proof vectors use the pinned dev key', () => {
  assert.equal(vkHash(VECTORS.vk), PIN.vk_hash);
  assert.ok(VECTORS.cases.some((c) => c.valid) && VECTORS.cases.some((c) => !c.valid));
});

test('hash mismatch disables verification, verify is null', () => {
  const logs = [];
  const v = makeBtcPoolVerifier({ env: { BTC_POOL_VK_HASH: '00'.repeat(32) }, log: (m) => logs.push(m) });
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
  // Explicit arguments.
  const x = makeBtcPoolVerifier({ vk: VK, vkHash: 'ab'.repeat(32), log: quiet });
  assert.equal(x.enabled, false);
  assert.equal(x.verify, null);
});

test('malformed hash or missing key file disables verification', () => {
  const a = makeBtcPoolVerifier({ env: { BTC_POOL_VK_HASH: '0x12' }, log: quiet });
  assert.equal(a.enabled, false);
  assert.match(a.reason, /malformed/);
  const b = makeBtcPoolVerifier({ env: { BTC_POOL_VK: join(dir, 'missing.json') }, log: quiet });
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
  // The same pin file on its own network loads.
  const c = makeBtcPoolVerifier({ network: 'mainnet', env: { BTC_POOL_PIN: MAINNET_PIN_PATH }, log: quiet });
  assert.equal(c.enabled, true);
  assert.equal(c.vkHash, PIN.vk_hash);
});

test('BTC_POOL_VK and BTC_POOL_VK_HASH override the pin', () => {
  const h = vkHash(OTHER_VK);
  assert.notEqual(h, PIN.vk_hash);
  const k = loadBtcPoolKey({ env: { BTC_POOL_VK: OTHER_VK_PATH, BTC_POOL_VK_HASH: '0x' + h.toUpperCase() } });
  assert.equal(k.vkFile, OTHER_VK_PATH);
  assert.equal(k.vkHash, h);
  const v = makeBtcPoolVerifier({ env: { BTC_POOL_VK: OTHER_VK_PATH, BTC_POOL_VK_HASH: h }, log: quiet });
  assert.equal(v.enabled, true);
  assert.equal(v.vkHash, h);
  // Pinned key file at another path, pinned hash.
  const w = makeBtcPoolVerifier({ env: { BTC_POOL_VK: join(dir, PIN.vk) }, log: quiet });
  assert.equal(w.enabled, true);
  assert.equal(w.vkHash, PIN.vk_hash);
  // An explicit hash also stands in for the pin's network.
  const x = makeBtcPoolVerifier({ network: 'mainnet', env: { BTC_POOL_VK_HASH: PIN.vk_hash }, log: quiet });
  assert.equal(x.enabled, true);
});

test('stored Groth16 cases verify to their expected verdict', async () => {
  const v = makeBtcPoolVerifier({ env: {}, log: quiet });
  for (const c of VECTORS.cases) {
    const proof = unhex(c.proof);
    assert.equal(proof.length, PROOF_WIRE_LEN);
    assert.equal(await v.verify({ proof, publics: c.publics }), c.valid, c.name);
  }
});

test('tampered publics or proof, wrong-length wire, wrong public count are rejected', async () => {
  const v = makeBtcPoolVerifier({ env: {}, log: quiet });
  const c = VECTORS.cases.find((x) => x.valid);
  const proof = unhex(c.proof);
  assert.equal(await v.verify({ proof, publics: c.publics }), true);
  for (let i = 0; i < c.publics.length; i += 3) {
    const p = [...c.publics];
    p[i] = (BigInt(p[i]) + 1n).toString();
    assert.equal(await v.verify({ proof, publics: p }), false, `public ${i}`);
  }
  for (const at of [0, 31, 100, 200, 255]) {
    const t = Uint8Array.from(proof);
    t[at] ^= 1;
    assert.equal(await v.verify({ proof: t, publics: c.publics }), false, `proof byte ${at}`);
  }
  // A valid proof of another statement.
  const other = VECTORS.cases.find((x) => x.valid && x !== c);
  assert.equal(await v.verify({ proof: unhex(other.proof), publics: c.publics }), false);
  assert.equal(await v.verify({ proof: proof.slice(0, PROOF_WIRE_LEN - 1), publics: c.publics }), false);
  assert.equal(await v.verify({ proof: Uint8Array.from([...proof, 0]), publics: c.publics }), false);
  assert.equal(await v.verify({ proof: new Uint8Array(0), publics: c.publics }), false);
  assert.equal(await v.verify({ proof: c.proof, publics: c.publics }), false, 'hex string is not a wire');
  assert.equal(await v.verify({ proof, publics: c.publics.slice(1) }), false);
  assert.equal(await v.verify({ proof: new Uint8Array(PROOF_WIRE_LEN), publics: c.publics }), false, 'zero wire');
});

let passed = 0;
const t0 = performance.now();
try {
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('  ok -', n); } catch (e) { console.error('  FAIL -', n); console.error(e); process.exitCode = 1; }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`${passed}/${tests.length} passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
