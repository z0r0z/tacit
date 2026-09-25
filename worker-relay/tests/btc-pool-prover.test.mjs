// btc-pool-prover service against a mock btc-pool-prove binary and a mock btc-pool-verify binary.
//   node tests/btc-pool-prover.test.mjs   (from worker-relay/)

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import { createProver, validateWitness, expectedPublicValues, clientKey, makeBudget } from '../src/btc-pool-prover.js';
import { makeBtcPoolVerifier } from '../src/lib/btc-pool-verify.js';

const VKEY = '0x' + 'ab'.repeat(32);
const SECRET = '0x' + '5e'.repeat(32);
const h = (b, n) => '0x' + b.repeat(n);

const baseWitness = () => ({
  body: '0x6d' + '11'.repeat(200),
  root: h('22', 32),
  inputs: [{
    cx: h('01', 32), cy: h('02', 32), value: '1000', blinding: h('03', 32), spend_key: h('04', 32),
    nk_pub: '0x02' + '05'.repeat(32), nk_note: h('06', 32), leaf_index: 7,
    path: Array.from({ length: 32 }, () => h('07', 32)), sig: h('08', 64),
  }],
  outputs: [{ value: '1', blinding: h('09', 32) }],
});
const withMode = (mode) => { const w = baseWitness(); w.outputs[0].value = String(mode); return w; };
const PV = '0x' + '00'.repeat(31) + '01' + '22'.repeat(32) + keccak256(baseWitness().body).slice(2);

// ── mock binaries ──
const dir = mkdtempSync(join(tmpdir(), 'btc-pool-prover-'));
const calls = join(dir, 'calls.jsonl');
const proveBin = join(dir, 'btc-pool-prove');
writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
// Mode = outputs[0].value: 1 ok, 2 guest rejects, 3 wrong vkey, 4 proof the verifier rejects, 5 slow ok,
// 6 network crash that prints the key, 7 network exit 2, 8 wrong public values from the network.
writeFileSync(proveBin, `#!/usr/bin/env node
const fs = require('fs');
let s = '';
process.stdin.on('data', (c) => { s += c; });
process.stdin.on('end', () => {
  const w = JSON.parse(s);
  const mode = Number(w.outputs[0].value);
  const PM = process.env.PROVE_MODE;
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ mode: PM, argv: process.argv, env: process.env, t0: Date.now(), stdin: s }) + '\\n');
  const pv = ${JSON.stringify(PV)};
  const done = (o) => { fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ end: PM, t1: Date.now() }) + '\\n'); if (o) process.stdout.write(JSON.stringify(o) + '\\n'); };
  if (PM === 'execute') {
    if (mode === 2) { process.stderr.write('btc-pool-prove: guest rejected the witness: btc-pool: spend signature invalid\\n'); process.exit(2); }
    return done({ public_values: pv, cycles: 527328 });
  }
  if (PM !== 'network') process.exit(3);
  if (mode === 6) { process.stderr.write('connecting with key ' + process.env.NETWORK_PRIVATE_KEY + '\\n'); process.exit(1); }
  if (mode === 7) { process.stderr.write('btc-pool-prove: groth16 proof: network error\\n'); process.exit(2); }
  const out = { proof: '0x01' + 'cd'.repeat(100), public_values: pv, vkey: ${JSON.stringify(VKEY)} };
  if (mode === 3) out.vkey = '0x' + 'ee'.repeat(32);
  if (mode === 4) out.proof = '0x02' + 'cd'.repeat(100);
  if (mode === 8) out.public_values = '0x' + '00'.repeat(96);
  if (mode === 5) return setTimeout(() => done(out), 600);
  done(out);
});
`);
chmodSync(proveBin, 0o755);
const verifyBin = join(dir, 'btc-pool-verify');
const verifyLog = join(dir, 'verify.jsonl');
writeFileSync(verifyBin, `#!/usr/bin/env node
let s = '';
process.stdin.on('data', (c) => { s += c; });
process.stdin.on('end', () => {
  const i = JSON.parse(s);
  require('fs').appendFileSync(${JSON.stringify(verifyLog)}, s + '\\n');
  const ok = i.proof.startsWith('0x01') && i.vkey === ${JSON.stringify(VKEY)} && i.public_values === ${JSON.stringify(PV)};
  process.stdout.write(JSON.stringify(ok ? { ok: true } : { ok: false, reason: 'bad proof' }));
});
`);
chmodSync(verifyBin, 0o755);
const verifier = makeBtcPoolVerifier({ bin: verifyBin, vkey: VKEY, log: () => {} });

const readCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const readVerifies = () => (existsSync(verifyLog) ? readFileSync(verifyLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => { rmSync(calls, { force: true }); rmSync(verifyLog, { force: true }); };

async function serve(opts = {}) {
  const logs = [];
  const p = createProver({
    proveBin, verifier, vkey: VKEY, networkPrivateKey: SECRET, networkRpcUrl: 'https://rpc.example',
    baseEnv: { PATH: process.env.PATH }, log: (...a) => logs.push(a.join(' ')), rateMax: 100, ...opts,
  });
  const server = createServer(p.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (w, { ip = '203.0.113.1', headers = {}, raw } = {}) => fetch(`${base}/btc-pool/prove`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: raw ?? JSON.stringify(w),
  });
  return { p, server, base, post, logs, close: () => new Promise((r) => server.close(r)) };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test('validateWitness canonicalises and rejects every malformed shape', () => {
  const w = baseWitness();
  w.inputs[0].cx = w.inputs[0].cx.slice(2).toUpperCase();
  w.inputs[0].value = 1000;
  const v = validateWitness(w);
  assert.equal(v.inputs[0].cx, h('01', 32));
  assert.equal(v.inputs[0].value, '1000');
  assert.equal(v.inputs[0].leaf_index, '7');
  assert.equal(expectedPublicValues(v), PV);
  const bads = [
    [(x) => { x.extra = 1; }, /unexpected field extra/],
    [(x) => { delete x.root; }, /missing root/],
    [(x) => { x.body = '0x6c' + '11'.repeat(10); }, /opcode/],
    [(x) => { x.body = '0x6d' + '11'.repeat(2000); }, /body length/],
    [(x) => { x.body = '0x6dz1'; }, /not hex/],
    [(x) => { x.root = h('22', 31); }, /root must be 32 bytes/],
    [(x) => { x.inputs = []; }, /inputs must hold/],
    [(x) => { x.inputs = [x.inputs[0], x.inputs[0], x.inputs[0]]; }, /inputs must hold/],
    [(x) => { x.outputs = Array(5).fill(x.outputs[0]); }, /outputs must hold/],
    [(x) => { x.inputs[0].path.pop(); }, /path must hold 32/],
    [(x) => { x.inputs[0].path[3] = h('07', 33); }, /path\[3\] must be 32 bytes/],
    [(x) => { x.inputs[0].sig = h('08', 63); }, /sig must be 64 bytes/],
    [(x) => { x.inputs[0].nk_pub = '0x04' + '05'.repeat(32); }, /compressed point/],
    [(x) => { x.inputs[0].nk_note = h('00', 32); }, /non-zero/],
    [(x) => { x.inputs[0].value = '18446744073709551616'; }, /out of range/],
    [(x) => { x.inputs[0].value = -1; }, /non-negative/],
    [(x) => { x.inputs[0].value = 1.5; }, /non-negative/],
    [(x) => { x.inputs[0].leaf_index = 2 ** 32; }, /leaf_index out of range/],
    [(x) => { x.inputs[0].spend_sk = h('01', 32); }, /unexpected field spend_sk/],
    [(x) => { x.outputs[0].memo = 'x'; }, /unexpected field memo/],
    [(x) => { x.outputs[0] = null; }, /must be an object/],
  ];
  for (const [mut, re] of bads) { const x = baseWitness(); mut(x); assert.throws(() => validateWitness(x), re); }
});

test('happy path: execute then network, verified locally, returns {proof, public_values, vkey}', async () => {
  reset();
  const s = await serve();
  try {
    const r = await s.post(withMode(1));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(Object.keys(j).sort(), ['proof', 'public_values', 'vkey']);
    assert.equal(j.vkey, VKEY); assert.equal(j.public_values, PV); assert.ok(j.proof.startsWith('0x01'));
    const c = readCalls().filter((x) => x.mode);
    assert.deepEqual(c.map((x) => x.mode), ['execute', 'network']);
    assert.equal(JSON.parse(c[1].stdin).inputs[0].leaf_index, '7', 'child gets the canonical witness');
    assert.equal(readVerifies().length, 1, 'verified before returning');
    assert.equal(s.p.status().budget.used, 1);
  } finally { await s.close(); }
});

test('secrets: never in argv, only in the network child env, redacted from logs and responses', async () => {
  reset();
  const s = await serve();
  try {
    assert.equal((await s.post(withMode(1))).status, 200);
    const r = await s.post(withMode(6), { ip: '203.0.113.2' });
    assert.equal(r.status, 502);
    const text = await r.text();
    assert.ok(!text.includes(SECRET.slice(2)));
    const c = readCalls().filter((x) => x.mode);
    for (const x of c) assert.ok(!x.argv.join(' ').includes(SECRET.slice(2)), 'argv carries no secret');
    for (const x of c.filter((y) => y.mode === 'execute')) {
      assert.equal(x.env.NETWORK_PRIVATE_KEY, undefined); assert.equal(x.env.NETWORK_RPC_URL, undefined);
    }
    for (const x of c.filter((y) => y.mode === 'network')) {
      assert.equal(x.env.NETWORK_PRIVATE_KEY, SECRET); assert.equal(x.env.NETWORK_RPC_URL, 'https://rpc.example');
    }
    // macOS injects __CF_* into every process; everything else must come from the allow-list.
    assert.deepEqual(Object.keys(c[0].env).filter((k) => !k.startsWith('__CF')).sort(), ['PATH', 'PROVE_MODE'], 'child env is an allow-list');
    assert.ok(s.logs.length > 0);
    for (const l of s.logs) assert.ok(!l.includes(SECRET.slice(2)), `log leaks key: ${l}`);
    assert.ok(s.logs.some((l) => l.includes('[redacted]')), 'the crash stderr was logged, redacted');
    for (const l of s.logs) assert.ok(!l.includes(h('06', 32).slice(2)), 'witness (nk_note) is never logged');
  } finally { await s.close(); }
});

test('bad witness is rejected at execute: 422, no network run, no budget spent', async () => {
  reset();
  const s = await serve({ dailyBudget: 1 });
  try {
    const r = await s.post(withMode(2));
    assert.equal(r.status, 422);
    assert.match((await r.json()).reason, /spend signature invalid/);
    assert.deepEqual(readCalls().filter((x) => x.mode).map((x) => x.mode), ['execute']);
    assert.equal(s.p.status().budget.used, 0);
    assert.equal((await s.post(withMode(1), { ip: '203.0.113.9' })).status, 200);
  } finally { await s.close(); }
});

test('verify before return: wrong vkey, verifier rejection, wrong public values, network exit 2 are all 502', async () => {
  reset();
  const s = await serve();
  try {
    let ip = 10;
    for (const mode of [3, 4, 8, 7]) {
      const r = await s.post(withMode(mode), { ip: `198.51.100.${ip++}` });
      assert.equal(r.status, 502, `mode ${mode}`);
      assert.deepEqual(await r.json(), { error: 'proving failed' });
    }
    const v = readVerifies();
    assert.equal(v.length, 1, 'only the proof with the pinned vkey and matching public values reaches the verifier');
    assert.ok(v[0].proof.startsWith('0x02'));
    assert.equal(s.p.status().stats.failed, 4);
  } finally { await s.close(); }
});

test('HTTP hardening: size cap, content type, JSON, origin, CORS, health, 404', async () => {
  const s = await serve({ bodyMax: 4096 });
  try {
    assert.equal((await s.post(null, { raw: JSON.stringify({ ...baseWitness(), pad: 'x'.repeat(5000) }) })).status, 413);
    assert.equal((await s.post(null, { raw: '{not json' })).status, 400);
    const bad = baseWitness(); bad.inputs[0].path.pop();
    const r400 = await s.post(bad);
    assert.equal(r400.status, 400); assert.match((await r400.json()).error, /path must hold 32/);
    assert.equal((await s.post(baseWitness(), { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await s.post(baseWitness(), { headers: { origin: 'https://evil.example' } })).status, 403);
    const pre = await fetch(`${s.base}/btc-pool/prove`, { method: 'OPTIONS', headers: { origin: 'https://tacit.finance', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://tacit.finance');
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
    const loc = await fetch(`${s.base}/health`, { headers: { origin: 'http://localhost:5173' } });
    assert.equal(loc.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const evil = await fetch(`${s.base}/health`, { headers: { origin: 'https://tacit.finance.evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const hj = await (await fetch(`${s.base}/health`)).json();
    assert.equal(hj.network, 'signet'); assert.equal(hj.vkey, VKEY); assert.equal(hj.concurrency, 2);
    assert.ok(!JSON.stringify(hj).includes(SECRET.slice(2)));
    assert.equal((await fetch(`${s.base}/btc-pool/prove`)).status, 405);
    assert.equal((await fetch(`${s.base}/nope`)).status, 404);
  } finally { await s.close(); }
});

test('rate limit is keyed on the right-most X-Forwarded-For hop', async () => {
  assert.equal(clientKey({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 9.9.9.9' }, socket: {} }), '9.9.9.9');
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
  reset();
  const s = await serve({ rateMax: 2 });
  try {
    assert.equal((await s.post(withMode(1), { ip: '1.1.1.1, 9.9.9.9' })).status, 200);
    assert.equal((await s.post(withMode(1), { ip: '2.2.2.2, 9.9.9.9' })).status, 200);
    const r = await s.post(withMode(1), { ip: '3.3.3.3, 9.9.9.9' });
    assert.equal(r.status, 429, 'spoofed left hops do not escape the limit');
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal((await s.post(withMode(1), { ip: '9.9.9.9, 8.8.8.8' })).status, 200, 'another client is unaffected');
  } finally { await s.close(); }
});

test('global concurrency cap and queue cap; one in-flight request per client', async () => {
  reset();
  const s = await serve({ concurrency: 2, queueMax: 1 });
  try {
    const rs = await Promise.all([1, 2, 3, 4].map((i) => s.post(withMode(5), { ip: `192.0.2.${i}` })));
    const codes = rs.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 200, 200, 503]);
    const busy = rs.find((r) => r.status === 503);
    assert.deepEqual(await busy.json(), { error: 'prover busy' });
    // Overlap of network children never exceeds the cap.
    const ev = readCalls().filter((x) => x.mode === 'network' || x.end === 'network').map((x) => (x.mode ? [x.t0, 1] : [x.t1, -1])).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, max = 0;
    for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
    assert.ok(max <= 2, `max concurrent network proofs ${max}`);
    assert.equal(ev.filter((e) => e[1] === 1).length, 3);

    const same = await Promise.all([s.post(withMode(5), { ip: '192.0.2.50' }), s.post(withMode(5), { ip: '192.0.2.50' })]);
    assert.deepEqual(same.map((r) => r.status).sort(), [200, 429]);
    assert.equal(s.p.status().running, 0); assert.equal(s.p.status().queued, 0);
  } finally { await s.close(); }
});

test('daily budget: exhausted -> 503 with Retry-After, resets at the UTC day', async () => {
  reset();
  let t = Date.UTC(2026, 8, 26, 23, 0, 0);
  const s = await serve({ dailyBudget: 2, now: () => t });
  try {
    assert.equal((await s.post(withMode(1), { ip: '192.0.2.61' })).status, 200);
    assert.equal((await s.post(withMode(1), { ip: '192.0.2.62' })).status, 200);
    const r = await s.post(withMode(1), { ip: '192.0.2.63' });
    assert.equal(r.status, 503);
    assert.equal(Number(r.headers.get('retry-after')), 3600);
    assert.equal(readCalls().filter((x) => x.mode === 'network').length, 2, 'no network run past the budget');
    t += 3600 * 1000;
    assert.equal((await s.post(withMode(1), { ip: '192.0.2.63' })).status, 200);
    assert.deepEqual(s.p.status().budget, { day: '2026-09-27', used: 1, limit: 2 });
  } finally { await s.close(); }
  const b = makeBudget({ limit: 1 });
  assert.equal(b.take(), true); assert.equal(b.take(), false);
});

test('optional root check against the indexer', async () => {
  reset();
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return { ok: true, json: async () => ({ roots: [{ height: 1, root: h('22', 32) }] }) }; };
  const s = await serve({ rootsUrl: 'http://indexer.example', fetchImpl });
  try {
    assert.equal((await s.post(withMode(1), { ip: '192.0.2.71' })).status, 200);
    const w = withMode(1); w.root = h('33', 32);
    assert.equal((await s.post(w, { ip: '192.0.2.72' })).status, 422);
    assert.equal(fetches, 1, 'roots are cached');
    assert.equal(readCalls().filter((x) => x.mode).length, 2, 'unknown root never reaches the binary');
  } finally { await s.close(); }
});

test('client that disconnects while queued never runs', async () => {
  reset();
  const s = await serve({ concurrency: 1, queueMax: 4 });
  try {
    const first = s.post(withMode(5), { ip: '192.0.2.81' });
    await new Promise((r) => setTimeout(r, 100));
    const ac = new AbortController();
    const second = s.post(withMode(5), { ip: '192.0.2.82', headers: {} }).catch(() => null);
    void second;
    const third = fetch(`${s.base}/btc-pool/prove`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.83' }, body: JSON.stringify(withMode(5)) }).catch(() => 'aborted');
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    assert.equal(await third, 'aborted');
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    await new Promise((r) => setTimeout(r, 100));
    const execs = readCalls().filter((x) => x.mode === 'execute').length;
    assert.equal(execs, 2, 'the aborted request never spawned');
    assert.equal(s.p.status().queued, 0); assert.equal(s.p.status().running, 0);
  } finally { await s.close(); }
});

test('refuses to start without the verifier, the pinned vkey or the network key', () => {
  const base = { proveBin, verifier, vkey: VKEY, networkPrivateKey: SECRET, log: () => {} };
  assert.throws(() => createProver({ ...base, verifier: { enabled: false, reason: 'x' } }), /btc-pool-verify unavailable/);
  assert.throws(() => createProver({ ...base, vkey: undefined }), /vkey/);
  assert.throws(() => createProver({ ...base, networkPrivateKey: '' }), /NETWORK_PRIVATE_KEY/);
});

let passed = 0;
for (const [n, f] of tests) {
  try { await f(); passed++; console.log('  ok -', n); } catch (e) { console.error('  FAIL -', n); console.error(e); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} passed`);
