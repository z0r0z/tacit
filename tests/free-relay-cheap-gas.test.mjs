// The free relayed settles open while gas is cheap (worker/src/index.js cheapGas): a bridge mint, a cBTC mint and a cUSD loan, repayment or
// top-up have no daily class allowance, every other allowance and the day's total are multiplied, the window stays open a while after gas
// was last cheap, and a relay short of prover credit, unreadable gas, or the rule switched off leave the allowances as they are.
//   node --test tests/free-relay-cheap-gas.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const worker = await import('../worker/src/index.js');
const BOX = 'box-token-for-the-test-0123456789';
const gwei = (g) => '0x' + Math.round(g * 1e9).toString(16);
let gasWei = gwei(0.05), gasDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  if (body && body.method === 'eth_gasPrice') return gasDown ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: gasWei }), { status: 200 });
  return new Response('{}', { status: 404 });
};
function memKv() {
  const m = new Map();
  return { get: async (k, t) => { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, list: async () => ({ keys: [], list_complete: true }), _m: m };
}
const day = () => new Date().toISOString().slice(0, 10);
// A fresh env per case: the gas reading is kept per env, and the counters per KV.
const fresh = (extra = {}) => { const kv = memKv(); return { kv, env: { CONFIDENTIAL_SETTLE: '1', REGISTRY_KV: kv, CONFIDENTIAL_KV: kv, CONFIDENTIAL_BOX_TOKEN: BOX, PROVE_RL_BURST: '1000', FREE_RELAY_GAS_TTL_MS: '0', ...extra } }; };
const fixture = (f) => JSON.parse(readFileSync(new URL(`../contracts/sp1/confidential/fixtures/${f}.json`, import.meta.url), 'utf8'));
const SHAPED = { cbtcmint: fixture('cbtc_mint_op'), cdpmint: fixture('cdp_mint_op'), cdptopup: fixture('cdp_topup_op') };
let ip = 0, n = 0;
const call = (env, path, init = {}) => worker.default.fetch(new Request(`https://api.test${path}`, { ...init, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `198.51.100.${++ip % 250}`, ...(init.headers || {}) } }), env, { waitUntil() {} });
// A fee-less op of a type with no door check of its own: what counts is the allowance it meets.
// The ops of the types the door checks are real-shaped (the prover's fixtures); each is made distinct by a field the door ignores.
const opFor = (type) => (SHAPED[type] ? { ...JSON.parse(JSON.stringify(SHAPED[type])), tag: ++n } : { fee: 0, n: ++n });
const submit = async (env, type) => { const r = await call(env, '/confidential/submit', { method: 'POST', body: JSON.stringify({ type, op: opFor(type), memos: [] }) }); return { status: r.status, body: await r.json() }; };
const many = async (env, type, k) => { const out = []; for (let i = 0; i < k; i++) out.push((await submit(env, type)).status); return out; };
const heartbeat = (kv, credit) => kv.put('prover:heartbeat:mainnet:settle', JSON.stringify({ ts: Date.now(), prover_alive: true, prover_credit: credit, note: 'settle: idle' }));

test('gas not cheap: the allowances are as set', async () => {
  gasWei = gwei(0.2);
  const { env } = fresh({ FREE_RELAY_CAP_ONBOARD: '2', FREE_RELAY_CAP_CUSD: '2' });
  assert.deepEqual(await many(env, 'cbtcmint', 3), [200, 200, 429]);
  assert.deepEqual(await many(env, 'cdpmint', 3), [200, 200, 429]);
});

test('gas under the line: bridge, cBTC and cUSD ops have no class allowance, the others are multiplied, and the total opens', async () => {
  gasWei = gwei(0.05);
  const { env } = fresh({ FREE_RELAY_CAP_ONBOARD: '2', FREE_RELAY_CAP_CUSD: '1', FREE_RELAY_CAP_FARM: '2', FREE_RELAY_DAILY_CAP: '10' });
  assert.deepEqual(await many(env, 'cbtcmint', 5), [200, 200, 200, 200, 200], 'cBTC mints beyond the allowance of two');
  assert.deepEqual(await many(env, 'cdpmint', 3), [200, 200, 200], 'cUSD loans beyond the allowance of one');
  assert.deepEqual(await many(env, 'cdpclose', 2), [200, 200], 'and a repayment is in the same class');
  assert.deepEqual(await many(env, 'cdptopup', 2), [200, 200], 'and a top-up');
  // farm: 2 x 4 = 8; the total 10 x 4 = 40 is not met by 12 so far
  const farm = await many(env, 'farmharvest', 9);
  assert.deepEqual(farm, [200, 200, 200, 200, 200, 200, 200, 200, 429], 'an allowance that is not sponsored is multiplied, not removed');
});

test('the day\'s total is multiplied too', async () => {
  gasWei = gwei(0.05);
  const { env } = fresh({ FREE_RELAY_DAILY_CAP: '3' });
  const codes = await many(env, 'cdpmint', 14);
  assert.equal(codes.filter((c) => c === 200).length, 12, `3 x 4 = 12 settles are taken (${codes})`);
  assert.equal(codes[12], 429);
});

test('the window stays open for a while after gas was last cheap, then closes', async () => {
  gasWei = gwei(0.05);
  const { env } = fresh({ FREE_RELAY_CAP_FARM: '1', FREE_RELAY_CHEAP_WINDOW_MS: '400', FREE_RELAY_CHEAP_MULT: '2' });
  assert.deepEqual(await many(env, 'farmharvest', 2), [200, 200], 'cheap: 1 x 2');
  gasWei = gwei(0.3);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal((await submit(env, 'farmharvest')).status, 429, 'gas is over the line and the window has passed: the allowance of one is long used');
  gasWei = gwei(0.05);
});

test('a price that ticks over the line inside the window does not close it', async () => {
  gasWei = gwei(0.05);
  const { env } = fresh({ FREE_RELAY_CAP_ONBOARD: '1' });
  assert.deepEqual(await many(env, 'cbtcmint', 2), [200, 200]);
  gasWei = gwei(0.09);
  assert.deepEqual(await many(env, 'cbtcmint', 2), [200, 200], 'still open: gas was cheap a moment ago');
  gasWei = gwei(0.05);
});

test('a relay short of prover credit keeps the allowances as they are', async () => {
  gasWei = gwei(0.05);
  const { env, kv } = fresh({ FREE_RELAY_CAP_ONBOARD: '2' });
  await heartbeat(kv, '12.5');
  assert.deepEqual(await many(env, 'cbtcmint', 3), [200, 200, 429], 'under the 40 PROVE it keeps for its Bitcoin attests');
  const ok = fresh({ FREE_RELAY_CAP_ONBOARD: '2' });
  await heartbeat(ok.kv, '75');
  assert.deepEqual(await many(ok.env, 'cbtcmint', 4), [200, 200, 200, 200], 'with credit to spare it opens');
});

test('unreadable gas, or the rule switched off, leaves the allowances as they are', async () => {
  gasWei = gwei(0.05);
  gasDown = true;
  const a = fresh({ FREE_RELAY_CAP_ONBOARD: '1' });
  assert.deepEqual(await many(a.env, 'cbtcmint', 2), [200, 429], 'gas that cannot be read');
  gasDown = false;
  const b = fresh({ FREE_RELAY_CAP_ONBOARD: '1', FREE_RELAY_CHEAP_GWEI: '0' });
  assert.deepEqual(await many(b.env, 'cbtcmint', 2), [200, 429], 'FREE_RELAY_CHEAP_GWEI=0');
  const c = fresh({ FREE_RELAY_CAP_ONBOARD: '1', FREE_RELAY_CHEAP_GWEI: '0.04' });
  assert.deepEqual(await many(c.env, 'cbtcmint', 2), [200, 429], 'a line set lower than the gas of the moment');
});

test('the economics view reports the allowances in force and the state of the rule', async () => {
  gasWei = gwei(0.05);
  const { env } = fresh({ FREE_RELAY_CAP_ONBOARD: '2', FREE_RELAY_CAP_FARM: '3', FREE_RELAY_DAILY_CAP: '10', PROVER_HEARTBEAT_TOKEN: 'tok' });
  await submit(env, 'cbtcmint');
  const j = await (await call(env, '/relay/economics')).json();
  const s = j.sponsorship;
  assert.equal(s.cheapGas.on, true);
  assert.equal(s.cheapGas.limit, 0.06);
  assert.equal(s.cheapGas.mult, 4);
  assert.equal(s.total.cap, 40);
  assert.equal(s.classes.onboard.cap, null, 'a sponsored class shows no limit');
  assert.equal(s.classes.cusd.cap, null);
  assert.equal(s.classes.farm.cap, 12, 'the others show their multiplied allowance');
  gasWei = gwei(0.3);
  const closed = fresh({ FREE_RELAY_CAP_ONBOARD: '2', FREE_RELAY_CAP_FARM: '3', FREE_RELAY_DAILY_CAP: '10' });
  const k = (await (await call(closed.env, '/relay/economics')).json()).sponsorship;
  assert.equal(k.cheapGas.on, false);
  assert.equal(k.total.cap, 10);
  assert.equal(k.classes.onboard.cap, 2);
  assert.equal(k.classes.cusd.cap, null, 'a class with no allowance set stays unlimited');
  gasWei = gwei(0.05);
});

test('an op the relay declines to prove gives its settle back', async () => {
  gasWei = gwei(0.3);
  const { env, kv } = fresh({ FREE_RELAY_CAP_ONBOARD: '5' });
  const r = await submit(env, 'cbtcmint');
  assert.equal(r.status, 200);
  const used = (name) => Number(kv._m.get(`cps:budget:${name}:${day()}`) || 0);
  assert.equal(used('free:onboard'), 1);
  const ack = await call(env, '/confidential/ack', { method: 'POST', headers: { Authorization: `Bearer ${BOX}` }, body: JSON.stringify({ jobId: r.body.jobId, error: 'cBTC mint not proved: the pool has not recorded this lock yet; the reflection has to fold its Bitcoin block first' }) });
  assert.equal((await ack.json()).status, 'failed');
  assert.equal(used('free:onboard'), 0, 'declined before any proof: the allowance is whole again');
  assert.equal(used('free'), 0);
});

test.after(() => { globalThis.fetch = realFetch; });

test('a fast-bridge lock and claim are a class of their own: what else uses up the allowance of "other" does not stop them, and their own allowance holds', async () => {
  gasWei = gwei(0.2);
  const { env } = fresh({ FREE_RELAY_CAP_OTHER: '2', FREE_RELAY_CAP_FAST: '3' });
  assert.deepEqual(await many(env, 'transfer', 3), [200, 200, 429], 'the rest are taken up to their allowance of two');
  assert.deepEqual(await many(env, 'adaptorlock', 2), [200, 200], 'a lock still goes, whatever the rest used');
  assert.deepEqual(await many(env, 'adaptorclaim', 2), [200, 429], 'a claim shares the allowance of three with the locks, which then holds');
  const open = fresh({ FREE_RELAY_CAP_OTHER: '1' });
  assert.deepEqual(await many(open.env, 'adaptorlock', 4), [200, 200, 200, 200], 'with no allowance set for them only the day\'s total applies');
});
