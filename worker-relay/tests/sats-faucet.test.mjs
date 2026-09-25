// sats-faucet drip route against a mocked tacit module: address validation, limits, lock, CORS.
//   node tests/sats-faucet.test.mjs   (from worker-relay/)

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { configFromEnv, decodeSignetAddress, makeFaucet, makeHandler, makeLock, clientIp, HttpError } from '../src/sats-faucet.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
const ASSET_OUT = { txid: 'a'.repeat(64), vout: 0, value: 546 };

const ADDR_Q = 'tb1qd4hzm4wh6q73ty9l68tvlh3w5ddmp6z9lep4pl';
const ADDR_WSH = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';
const ADDR_P = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';
const ADDR_P2 = 'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47zagq';

function mockTacit({ utxos, broadcastMs = 0 }) {
  const sent = [];
  let active = 0, maxActive = 0;
  const tacit = {
    NET: { name: 'signet', api: 'http://127.0.0.1:1' },
    DUST: 546,
    wallet: { pub: new Uint8Array(33).fill(2), address: () => 'tb1qfaucet' },
    scanHoldings: async () => new Map([['aa', { utxos: [{ utxo: ASSET_OUT, amount: 1n, blinding: 1n }] }]]),
    getUtxos: async () => [...utxos.map((u) => ({ ...u })), { ...ASSET_OUT, status: { confirmed: true } }, { txid: 'b'.repeat(64), vout: 9, value: 5000, status: { confirmed: true } }],
    // The real classifier: holdings-listed outpoints and the dust band are never sats.
    selectSatsUtxosSafe: (all, holdings) => {
      const ex = new Set();
      for (const h of holdings.values()) for (const u of h.utxos || []) ex.add(`${u.utxo.txid}:${u.utxo.vout}`);
      return all.filter((u) => !ex.has(`${u.txid}:${u.vout}`) && u.value > 546);
    },
    getFeeRate: async () => 1,
    feeFor: (vb, rate) => Math.max(500, Math.ceil(vb * rate)),
    p2wpkhScript: () => Uint8Array.from([0, 20, ...new Uint8Array(20)]),
    signP2wpkhInput: () => [],
    serializeTx: (tx) => tx,
    txid: (tx) => createHash('sha256').update(JSON.stringify(tx.inputs)).digest('hex'),
    broadcast: async (tx) => {
      active++; maxActive = Math.max(maxActive, active);
      await sleep(broadcastMs);
      sent.push(tx);
      active--;
    },
  };
  // A spent UTXO stays listed by the indexer for a while; the faucet must not reselect it.
  const deps = { bytesToHex: (x) => x };
  return { tacit, deps, sent, maxActive: () => maxActive };
}

function memStore(init = {}) {
  let s = JSON.parse(JSON.stringify(init));
  return { load: () => JSON.parse(JSON.stringify(s)), save: (x) => { s = JSON.parse(JSON.stringify(x)); }, peek: () => s };
}

const cfgOf = (env = {}) => configFromEnv({ FAUCET_ASSET_ID: 'ab'.repeat(32), FAUCET_DRIP_SATS: '10000', FAUCET_DRIP_DAILY: '50', FAUCET_DRIP_FLOOR_SATS: '50000', ...env });
const utxo = (n, value, confirmed = true) => ({ txid: n.repeat(64), vout: 0, value, status: { confirmed } });

function build({ utxos = [utxo('1', 100_000), utxo('2', 100_000), utxo('3', 100_000)], env = {}, store = memStore(), broadcastMs = 0, clock = { t: 1_800_000_000 } } = {}) {
  const m = mockTacit({ utxos, broadcastMs });
  const faucet = makeFaucet({ tacit: m.tacit, deps: m.deps, cfg: cfgOf(env), store, logger: () => {}, now: () => clock.t, dripWaitMs: 0 });
  return { ...m, faucet, store, clock };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

// ── address validation ──
await test('decodes tb1q P2WPKH, tb1q P2WSH and tb1p P2TR to their scripts', () => {
  const q = decodeSignetAddress(ADDR_Q);
  assert.equal(q.script.length, 22); assert.equal(q.script[0], 0); assert.equal(q.script[1], 20);
  const w = decodeSignetAddress(ADDR_WSH);
  assert.equal(w.script.length, 34); assert.equal(w.script[0], 0);
  const p = decodeSignetAddress(ADDR_P);
  assert.equal(p.script.length, 34); assert.equal(p.script[0], 0x51); assert.equal(p.script[1], 32);
  assert.equal(decodeSignetAddress(ADDR_Q.toUpperCase()).address, ADDR_Q);
  assert.equal(decodeSignetAddress(`  ${ADDR_P2}  `).address, ADDR_P2);
});

await test('rejects mainnet, bad checksum, wrong encoding, mixed case and junk', () => {
  const bad = [
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    ADDR_Q.slice(0, -1) + (ADDR_Q.endsWith('l') ? 'q' : 'l'),
    'tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47', // v0 program with a bech32m checksum
    'tb1Qd4hzm4wh6q73ty9l68tvlh3w5ddmp6z9lep4pl',
    'tb1zw508d6qejxtdg4y5r3zarvaryvqyzf3du', // witness v2
    'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
    '', null, undefined, 42, 'tb1' + 'q'.repeat(100),
  ];
  for (const a of bad) assert.throws(() => decodeSignetAddress(a), (e) => e instanceof HttpError && e.status === 400, String(a));
});

await test('client IP is the right-most X-Forwarded-For hop', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, socket: {} }), '1.2.3.4');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }), '9.9.9.9');
});

// ── drips and limits ──
await test('a drip pays the address, excludes asset and dust UTXOs, returns change, and is recorded', async () => {
  const b = build();
  const r = await b.faucet.drip({ address: ADDR_P, ip: '1.1.1.1' });
  assert.equal(r.sats, 10_000);
  assert.equal(b.sent.length, 1);
  const tx = b.sent[0];
  assert.equal(hex(tx.outputs[0].script), hex(decodeSignetAddress(ADDR_P).script));
  assert.equal(tx.outputs[0].value, 10_000);
  for (const i of tx.inputs) { assert.notEqual(i.txid, ASSET_OUT.txid); assert.notEqual(i.txid, 'b'.repeat(64)); }
  const inSum = tx.inputs.length * 100_000;
  assert.ok(tx.outputs[1].value > 0 && inSum - tx.outputs[0].value - tx.outputs[1].value >= 500);
  assert.equal(b.faucet.status().drips_left_today, 49);
  assert.equal(b.faucet.status().drip_sats, 10_000);
  assert.equal(b.store.peek().drips.length, 1);
  assert.ok(!JSON.stringify(b.store.peek()).includes('1.1.1.1'), 'client IPs are stored hashed');
});

await test('one drip per address and per client per 24h', async () => {
  const b = build();
  await b.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' });
  await assert.rejects(b.faucet.drip({ address: ADDR_Q, ip: '2.2.2.2' }), (e) => e.status === 429 && /address/.test(e.message));
  await assert.rejects(b.faucet.drip({ address: ADDR_Q.toUpperCase(), ip: '3.3.3.3' }), (e) => e.status === 429);
  await assert.rejects(b.faucet.drip({ address: ADDR_P, ip: '1.1.1.1' }), (e) => e.status === 429 && /client/.test(e.message));
  await b.faucet.drip({ address: ADDR_P, ip: '2.2.2.2' });
  b.clock.t += 86_401;
  await b.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' });
  assert.equal(b.sent.length, 3);
});

await test('global daily budget', async () => {
  const b = build({ env: { FAUCET_DRIP_DAILY: '2' } });
  await b.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' });
  await b.faucet.drip({ address: ADDR_P, ip: '2.2.2.2' });
  assert.equal(b.faucet.status().drips_left_today, 0);
  await assert.rejects(b.faucet.drip({ address: ADDR_WSH, ip: '3.3.3.3' }), (e) => e.status === 429 && /budget/.test(e.message));
  b.clock.t += 86_401;
  assert.equal(b.faucet.status().drips_left_today, 2);
  await b.faucet.drip({ address: ADDR_WSH, ip: '3.3.3.3' });
});

await test('limits survive a restart through the state file', async () => {
  const store = memStore();
  const clock = { t: 1_800_000_000 };
  await build({ store, clock }).faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' });
  const again = build({ store, clock });
  await assert.rejects(again.faucet.drip({ address: ADDR_Q, ip: '5.5.5.5' }), (e) => e.status === 429);
  await assert.rejects(again.faucet.drip({ address: ADDR_P, ip: '1.1.1.1' }), (e) => e.status === 429);
  assert.equal(again.faucet.status().drips_left_today, 49);
});

await test('refuses to drip below the listing floor, and nothing is recorded', async () => {
  const b = build({ utxos: [utxo('1', 55_000)] });
  await assert.rejects(b.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' }), (e) => e.status === 503 && /low/.test(e.message));
  assert.equal(b.sent.length, 0);
  assert.equal(b.faucet.status().drips_left_today, 50);
  const ok = build({ utxos: [utxo('1', 70_000)] });
  await ok.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' });
});

await test('concurrent drips are serialised and never select the same UTXO', async () => {
  const b = build({ utxos: [utxo('1', 100_000), utxo('2', 100_000), utxo('3', 100_000), utxo('4', 100_000)], broadcastMs: 30 });
  const rs = await Promise.all([
    b.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' }),
    b.faucet.drip({ address: ADDR_P, ip: '2.2.2.2' }),
    b.faucet.drip({ address: ADDR_WSH, ip: '3.3.3.3' }),
  ]);
  assert.equal(new Set(rs.map((r) => r.txid)).size, 3);
  assert.equal(b.maxActive(), 1);
  const used = b.sent.flatMap((tx) => tx.inputs.map((i) => `${i.txid}:${i.vout}`));
  assert.equal(new Set(used).size, used.length, 'an outpoint was spent twice');
});

await test('concurrent requests for one address give exactly one drip', async () => {
  const b = build({ broadcastMs: 20 });
  const rs = await Promise.allSettled([1, 2, 3].map((n) => b.faucet.drip({ address: ADDR_Q, ip: `${n}.0.0.1` })));
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(b.sent.length, 1);
});

await test('lock runs tasks one at a time and survives a failing task', async () => {
  const lock = makeLock();
  let active = 0, max = 0;
  const task = (fail) => lock(async () => { active++; max = Math.max(max, active); await sleep(5); active--; if (fail) throw new Error('x'); return 1; });
  const rs = await Promise.allSettled([task(false), task(true), task(false)]);
  assert.deepEqual(rs.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(max, 1);
});

// ── HTTP ──
await test('HTTP: CORS allow-list on POST, open GET, JSON errors, right-most XFF', async () => {
  const b = build();
  const server = createServer(makeHandler(b.faucet, { corsOrigins: ['https://tacit.finance', 'http://localhost:8765'], logger: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/faucet/sats`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  try {
    let r = await fetch(`${base}/faucet/sats`, { method: 'OPTIONS', headers: { Origin: 'https://tacit.finance', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://tacit.finance');
    assert.match(r.headers.get('access-control-allow-headers'), /Content-Type/i);
    r = await fetch(`${base}/faucet/sats`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    r = await post(JSON.stringify({ address: ADDR_Q }), { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await post('not json', { Origin: 'http://localhost:8765' });
    assert.equal(r.status, 400);
    r = await post('x'.repeat(5000));
    assert.equal(r.status, 413);
    r = await post(JSON.stringify({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }));
    assert.equal(r.status, 400);
    r = await post(JSON.stringify({ address: ADDR_Q }), { Origin: 'http://localhost:8765', 'X-Forwarded-For': '6.6.6.6, 1.2.3.4' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8765');
    assert.match((await r.json()).txid, /^[0-9a-f]{64}$/);
    r = await post(JSON.stringify({ address: ADDR_P }), { 'X-Forwarded-For': '7.7.7.7, 1.2.3.4' });
    assert.equal(r.status, 429);
    r = await fetch(`${base}/faucet/sats`);
    assert.equal(r.status, 405);
    r = await fetch(`${base}/faucet/status`, { headers: { Origin: 'https://anything.example' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const st = await r.json();
    assert.equal(st.drip_sats, 10_000);
    assert.equal(st.drips_left_today, 49);
  } finally {
    server.close();
  }
});

console.log(`\n${passed} passed`);
