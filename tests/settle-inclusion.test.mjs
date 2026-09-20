// awaitInclusion: waiting for a settle to land, without sitting out a timeout on a transaction that can no
// longer land.
//
// Production, 2026-09-20: a relayed wrap was signed at nonce 2715 on the relayer key. Another sender's
// transaction took 2715 before it landed, so nothing the relay broadcast under that nonce could ever be
// included — but it waited a full receipt timeout, escalated at the SAME nonce, waited again, and only on the
// third round noticed. 6.5 minutes for a settle that then landed in 13 seconds. The wait must notice that the
// nonce is gone, and must never mistake its OWN landed transaction for someone else's.
//
// Time and the chain are faked, so the timings below are logical, not wall-clock.
//
// Run: node tests/settle-inclusion.test.mjs
import assert from 'node:assert';

Object.assign(process.env, {
  WORKER_BASE: 'http://127.0.0.1:1', BOX_TOKEN: 'x', RPC_URL: 'http://127.0.0.1:1',
  RELAY_KEY: '0x0000000000000000000000000000000000000000000000000000000000000001',
});
const { awaitInclusion } = await import('../worker-relay/src/settle-relay.js');

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

// A fake chain + clock. `events` maps a logical time (ms) to a state change; the clock advances only when the code sleeps.
function world({ events = [], confirmedNonce = 2715 } = {}) {
  let t = 0, nonce = confirmedNonce;
  const receipts = new Map();
  const apply = () => { for (const e of events) if (!e.done && t >= e.at) { e.done = true; e.fn({ setNonce: (n) => { nonce = n; }, land: (h, status = 'success') => receipts.set(h, { status }) }); } };
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; apply(); },
    getReceipt: async (h) => { apply(); return receipts.get(h) ?? null; },
    getConfirmedNonce: async () => { apply(); return nonce; },
    elapsed: () => t,
  };
}
const H = ['0xaaa', '0xbbb'];

console.log('awaitInclusion:\n');

await test('our broadcast lands: returns it immediately', async () => {
  const w = world({ events: [{ at: 8_000, fn: (c) => c.land('0xaaa') }] });
  const r = await awaitInclusion({ hashes: H, nonce: 2715, waitMs: 90_000, ...w });
  assert.deepStrictEqual(r, { state: 'landed', hash: '0xaaa' });
  assert.ok(w.elapsed() <= 12_000, `should return within a poll or two of landing, took ${w.elapsed()}ms`);
});

await test('another sender consumes our nonce: reports TAKEN within seconds, not after the full timeout', async () => {
  // The production case. Nonce 2715 is consumed at t=20s by someone else's tx; none of ours ever lands.
  const w = world({ events: [{ at: 20_000, fn: (c) => c.setNonce(2716) }] });
  const r = await awaitInclusion({ hashes: H, nonce: 2715, waitMs: 90_000, ...w });
  assert.strictEqual(r.state, 'taken');
  assert.ok(w.elapsed() < 30_000, `should notice within seconds of the nonce being consumed, took ${w.elapsed()}ms of a 90000ms budget`);
});

await test('our OWN tx consumed the nonce but its receipt lags: still reported as landed, never as taken', async () => {
  // The nonce advances at t=16s because OUR broadcast mined; the receipt only becomes visible 2s later. Calling
  // this "taken" would re-send a settle that has already landed.
  const w = world({ events: [
    { at: 16_000, fn: (c) => c.setNonce(2716) },
    { at: 18_000, fn: (c) => c.land('0xbbb') },
  ] });
  const r = await awaitInclusion({ hashes: H, nonce: 2715, waitMs: 90_000, ...w });
  assert.deepStrictEqual(r, { state: 'landed', hash: '0xbbb' });
});

await test('nothing happens: times out at the budget so the caller can escalate', async () => {
  const w = world();
  const r = await awaitInclusion({ hashes: H, nonce: 2715, waitMs: 90_000, ...w });
  assert.strictEqual(r.state, 'timeout');
  assert.ok(w.elapsed() >= 90_000 && w.elapsed() < 100_000, `should stop at the budget, stopped at ${w.elapsed()}ms`);
});

await test('a reverted broadcast is reported as reverted (terminal), not retried', async () => {
  const w = world({ events: [{ at: 5_000, fn: (c) => c.land('0xaaa', 'reverted') }] });
  const r = await awaitInclusion({ hashes: H, nonce: 2715, waitMs: 90_000, ...w });
  assert.deepStrictEqual(r, { state: 'reverted', hash: '0xaaa' });
});

await test('an earlier round\'s hash landing counts (replaced txs can still be the included one)', async () => {
  const w = world({ events: [{ at: 4_000, fn: (c) => c.land('0xaaa') }] });
  const r = await awaitInclusion({ hashes: ['0xaaa', '0xbbb'], nonce: 2715, waitMs: 90_000, ...w });
  assert.strictEqual(r.hash, '0xaaa');
});

await test('RPC hiccups do not decide anything: a failing receipt/nonce read is just "not yet"', async () => {
  const w = world({ events: [{ at: 12_000, fn: (c) => c.land('0xaaa') }] });
  let flaky = 0;
  const r = await awaitInclusion({
    hashes: H, nonce: 2715, waitMs: 90_000, now: w.now, sleep: w.sleep,
    getReceipt: async (h) => { if (flaky++ < 2) throw new Error('rpc down'); return w.getReceipt(h); },
    getConfirmedNonce: async () => { throw new Error('rpc down'); },
  });
  assert.strictEqual(r.state, 'landed');
});

await test('an already-consumed nonce is caught on the very first poll', async () => {
  const w = world({ confirmedNonce: 2716 });
  const r = await awaitInclusion({ hashes: H, nonce: 2715, waitMs: 90_000, ...w });
  assert.strictEqual(r.state, 'taken');
  assert.ok(w.elapsed() <= 4_000, `should not wait a poll cycle, took ${w.elapsed()}ms`);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
