// btc-pool-verify wrapper against a mock verifier binary.
//   node tests/btc-pool-verify.test.mjs   (from worker-relay/)

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBtcPoolVerifier, loadBtcPoolVkey, runVerifier, DEFAULT_PIN_PATH } from '../src/lib/btc-pool-verify.js';

const dir = mkdtempSync(join(tmpdir(), 'btc-pool-verify-'));
const seen = join(dir, 'stdin.json');
const bin = join(dir, 'btc-pool-verify');
writeFileSync(bin, `#!/usr/bin/env node
let s = '';
process.stdin.on('data', (c) => { s += c; });
process.stdin.on('end', () => {
  require('fs').writeFileSync(${JSON.stringify(seen)}, s);
  const mode = JSON.parse(s).proof.slice(2, 4);
  if (mode === '01') { process.stdout.write('{"ok":true}\\n'); }
  else if (mode === '02') { process.stdout.write(JSON.stringify({ ok: false, reason: 'selector mismatch' })); }
  else if (mode === '03') { process.stderr.write('panic'); process.exit(101); }
  else if (mode === '04') { process.stdout.write('not json'); }
  else if (mode === '05') { process.stdout.write('{"ok":"yes"}'); }
  else if (mode === '06') { setTimeout(() => {}, 10000); }
});
`);
chmodSync(bin, 0o755);
writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');

const tests = [];
const test = (n, f) => tests.push([n, f]);
const VKEY = '0x' + 'ab'.repeat(32);
const pv = new Uint8Array(96).fill(2);

test('pinned vkey is read from elf-vkey-pin.json', () => {
  const pin = JSON.parse(readFileSync(DEFAULT_PIN_PATH, 'utf8')).btc_pool_vkey;
  assert.equal(loadBtcPoolVkey({ env: {} }), pin.toLowerCase());
  assert.equal(loadBtcPoolVkey({ env: { BTC_POOL_VKEY: VKEY } }), VKEY);
  assert.throws(() => loadBtcPoolVkey({ env: { BTC_POOL_VKEY: '0x12' } }), /malformed/);
});

test('accept: ok true, stdin carries proof, public_values and vkey as 0x-hex', async () => {
  const v = makeBtcPoolVerifier({ bin, vkey: VKEY, log: () => {} });
  assert.ok(v.enabled);
  assert.equal(await v.verify({ proof: Uint8Array.of(1, 9), publicValues: pv }), true);
  const got = JSON.parse(readFileSync(seen, 'utf8'));
  assert.deepEqual(got, { proof: '0x0109', public_values: '0x' + '02'.repeat(96), vkey: VKEY });
});

test('reject: ok false is a verdict, not an error', async () => {
  const v = makeBtcPoolVerifier({ bin, vkey: VKEY, log: () => {} });
  assert.equal(await v.verify({ proof: Uint8Array.of(2), publicValues: pv }), false);
  assert.deepEqual(await runVerifier(bin, { proof: '0x02', public_values: '0x', vkey: VKEY }), { ok: false, reason: 'selector mismatch' });
});

test('internal errors throw: non-zero exit, non-JSON, unexpected shape, timeout', async () => {
  const v = makeBtcPoolVerifier({ bin, vkey: VKEY, log: () => {}, timeoutMs: 1500 });
  await assert.rejects(v.verify({ proof: Uint8Array.of(3), publicValues: pv }), /exited 101: panic/);
  await assert.rejects(v.verify({ proof: Uint8Array.of(4), publicValues: pv }), /non-JSON/);
  await assert.rejects(v.verify({ proof: Uint8Array.of(5), publicValues: pv }), /unexpected shape/);
  await assert.rejects(v.verify({ proof: Uint8Array.of(6), publicValues: pv }), /timed out/);
});

test('fails closed when the binary is missing or unset', () => {
  const logs = [];
  const a = makeBtcPoolVerifier({ bin: join(dir, 'nope'), vkey: VKEY, log: (m) => logs.push(m) });
  assert.equal(a.enabled, false); assert.equal(a.verify, null); assert.match(a.reason, /missing/);
  const b = makeBtcPoolVerifier({ bin: '', vkey: VKEY, log: (m) => logs.push(m) });
  assert.equal(b.enabled, false); assert.match(b.reason, /not set/);
  const c = makeBtcPoolVerifier({ bin: seen, vkey: VKEY, log: (m) => logs.push(m) });
  assert.equal(c.enabled, false, 'not executable');
  assert.equal(logs.length, 3);
  assert.ok(logs.every((m) => /DISABLED/.test(m)));
});

let passed = 0;
for (const [n, f] of tests) {
  try { await f(); passed++; console.log('  ok -', n); } catch (e) { console.error('  FAIL -', n); console.error(e); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} passed`);
