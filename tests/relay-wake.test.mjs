// A relay with nothing to do waits on GET /confidential/wake (worker/src/index.js) instead of a fixed pause: a job accepted wakes it at
// once, a quiet API answers when the wait runs out, and the route is the relay's alone (box token). worker-relay/src/settle-relay.js
// idleWait falls back to its SETTLE_POLL_SECS pause on an API without the route.
//   node --test tests/relay-wake.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.fetch = async () => new Response('{}', { status: 404 });
const worker = await import('../worker/src/index.js');
const BOX = 'box-token-for-the-test-0123456789';
function memKv() {
  const m = new Map();
  return { get: async (k, t) => { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }) };
}
const kv = memKv(), env = { CONFIDENTIAL_SETTLE: '1', REGISTRY_KV: kv, CONFIDENTIAL_KV: kv, CONFIDENTIAL_BOX_TOKEN: BOX, PROVE_RL_BURST: '1000', FREE_RELAY_GAS_TTL_MS: '0', OP_SHAPE_CHECK: '0' };   // placeholder ops: the shape doors are not under test here
let ip = 0, n = 0;
const call = (path, init = {}) => worker.default.fetch(new Request(`https://api.test${path}`, { ...init, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `198.51.100.${++ip % 250}`, ...(init.headers || {}) } }), env, { waitUntil() {} });
const wake = (secs, auth = true) => call(`/confidential/wake?wait=${secs}`, { headers: auth ? { Authorization: `Bearer ${BOX}` } : {} });
const submit = () => call('/confidential/submit', { method: 'POST', body: JSON.stringify({ type: 'farmbond', op: { fee: 0, n: ++n }, memos: [] }) });

test('a job accepted wakes a waiting relay at once', async () => {
  const t0 = Date.now(), w = wake(10);
  await new Promise((r) => setTimeout(r, 200));
  const s = await submit();
  assert.equal(s.status, 200, 'the job is accepted');
  const r = await w;
  assert.deepEqual(await r.json(), { woke: true });
  assert.ok(Date.now() - t0 < 3000, `woken in ${Date.now() - t0} ms, not after the wait`);
});

test('with nothing coming in, the wait runs out and says so', async () => {
  const t0 = Date.now(), r = await wake(1);
  assert.deepEqual(await r.json(), { woke: false });
  assert.ok(Date.now() - t0 >= 900, 'it waited');
});

test('the wait is capped, and only the relay may wait', async () => {
  assert.equal((await wake(1, false)).status, 404);
  const t0 = Date.now(), w = wake(9999);
  await new Promise((r) => setTimeout(r, 100));
  await submit();
  assert.deepEqual(await (await w).json(), { woke: true }, 'a long wait is still woken');
  assert.ok(Date.now() - t0 < 3000);
});
