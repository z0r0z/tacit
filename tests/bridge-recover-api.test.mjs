// worker /bridge/recover: a claim is refused unless it checks out, one claim is kept per burn, the queue and its marks
// need the box token, and a claim marked sent stays sent.
import { test } from 'node:test';
import assert from 'node:assert';

const worker = await import('../worker/src/index.js');
const TOKEN = 'box-token-for-tests-0123456789';
const BURN = 'b1'.repeat(32);

function makeKv() {
  const data = new Map();
  return {
    _data: data,
    async get(key, kind) { const v = data.get(key); if (v === undefined) return null; return kind === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { data.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix }) { return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
  };
}
const env = () => ({ REGISTRY_KV: makeKv(), CONFIDENTIAL_BOX_TOKEN: TOKEN, ALLOWED_ORIGINS: '*' });
const call = (e, path, { method = 'GET', body, token } = {}) => worker.default.fetch(new Request(`http://localhost${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
}), e);
const claim = (over = {}) => ({ burnTxid: BURN, amount: '10000000000', blinding: '12345', pubkey: '02' + '11'.repeat(32), sig: '22'.repeat(64), ...over });

test('a claim whose signature does not match is refused and nothing is kept', async () => {
  const e = env();
  const r = await call(e, '/bridge/recover?network=mainnet', { method: 'POST', body: claim() });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /signature/);
  assert.equal([...e.REGISTRY_KV._data.keys()].some((k) => k.startsWith('bridge:recover:')), false);
  const s = await (await call(e, `/bridge/recover?network=mainnet&burn=${BURN}`)).json();
  assert.equal(s.status, 'none');
});

test('one claim per burn: a second submission reads back the first', async () => {
  const e = env();
  await e.REGISTRY_KV.put(`bridge:recover:mainnet:${BURN}`, JSON.stringify({ ...claim(), status: 'queued', at: 1 }));
  const r = await call(e, '/bridge/recover?network=mainnet', { method: 'POST', body: claim({ amount: '99', sig: '33'.repeat(64) }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, status: 'queued', txid: null });
  assert.equal(JSON.parse(await e.REGISTRY_KV.get(`bridge:recover:mainnet:${BURN}`)).amount, '10000000000', 'the kept claim is unchanged');
});

test('the queue and marks need the box token', async () => {
  const e = env();
  assert.equal((await call(e, '/bridge/recover/queue?network=mainnet')).status, 404);
  assert.equal((await call(e, '/bridge/recover/mark?network=mainnet', { method: 'POST', body: { burnTxid: BURN, status: 'sent' } })).status, 404);
  assert.equal((await call(e, '/bridge/recover/queue?network=mainnet', { token: 'wrong-token-of-the-same-size00' })).status, 404);
});

test('marks record the notes about to be spent, the payment, and a sent claim stays sent', async () => {
  const e = env();
  await e.REGISTRY_KV.put(`bridge:recover:mainnet:${BURN}`, JSON.stringify({ ...claim(), status: 'queued', at: 1 }));
  const q = await (await call(e, '/bridge/recover/queue?network=mainnet', { token: TOKEN })).json();
  assert.equal(q.claims.length, 1);
  assert.equal(q.claims[0].sig, '22'.repeat(64), 'the service gets the claim in full to check it again');
  const inputs = [{ txid: 'a1'.repeat(32), vout: 0 }, { txid: 'nothex', vout: 1 }];
  await call(e, '/bridge/recover/mark?network=mainnet', { method: 'POST', token: TOKEN, body: { burnTxid: BURN, status: 'sending', inputs } });
  let kept = JSON.parse(await e.REGISTRY_KV.get(`bridge:recover:mainnet:${BURN}`));
  assert.equal(kept.status, 'sending');
  assert.deepEqual(kept.inputs, [{ txid: 'a1'.repeat(32), vout: 0 }], 'only well-formed outpoints are kept');
  assert.ok(kept.sendingAt > 0);
  const sent = await (await call(e, '/bridge/recover/mark?network=mainnet', { method: 'POST', token: TOKEN, body: { burnTxid: BURN, status: 'sent', txid: 'ab'.repeat(32) } })).json();
  assert.deepEqual(sent, { ok: true, status: 'sent', txid: 'ab'.repeat(32) });
  await call(e, '/bridge/recover/mark?network=mainnet', { method: 'POST', token: TOKEN, body: { burnTxid: BURN, status: 'held', note: 'late' } });
  kept = JSON.parse(await e.REGISTRY_KV.get(`bridge:recover:mainnet:${BURN}`));
  assert.equal(kept.status, 'sent');
  assert.equal(kept.blinding, undefined, 'a sent claim keeps no opening');
  assert.equal(kept.sig, undefined, 'nor the signature');
  assert.equal(kept.amount, '10000000000');
  assert.equal(kept.pubkey, '02' + '11'.repeat(32), 'what was sent and to whom stays');
  assert.deepEqual(kept.inputs, [{ txid: 'a1'.repeat(32), vout: 0 }]);
  const again = await (await call(e, '/bridge/recover?network=mainnet', { method: 'POST', body: claim() })).json();
  assert.deepEqual(again, { ok: true, status: 'sent', txid: 'ab'.repeat(32) }, 'the claim is answered as sent when its holder asks again');
  const q2 = await (await call(e, '/bridge/recover/queue?network=mainnet', { token: TOKEN })).json();
  assert.equal(q2.claims.length, 1);
  assert.equal(q2.claims[0].status, 'sent', 'the service still reads what it sent');
  const pub = await (await call(e, `/bridge/recover?network=mainnet&burn=${BURN}`)).json();
  assert.deepEqual(pub, { ok: true, status: 'sent', txid: 'ab'.repeat(32) }, 'the public read says sent and where, nothing else');
});

test('a mark for a burn with no claim, or an unknown status, is refused', async () => {
  const e = env();
  assert.equal((await call(e, '/bridge/recover/mark?network=mainnet', { method: 'POST', token: TOKEN, body: { burnTxid: BURN, status: 'sent' } })).status, 404);
  assert.equal((await call(e, '/bridge/recover/mark?network=mainnet', { method: 'POST', token: TOKEN, body: { burnTxid: BURN, status: 'paid' } })).status, 400);
});

test('a claim moves one way: a send is refused for one already sent or held', async () => {
  const e = env();
  const put = (status) => e.REGISTRY_KV.put(`bridge:recover:mainnet:${BURN}`, JSON.stringify({ ...claim(), status, at: 1 }));
  const mark = (status) => call(e, '/bridge/recover/mark?network=mainnet', { method: 'POST', token: TOKEN, body: { burnTxid: BURN, status } });
  await put('sent');
  assert.equal((await mark('sending')).status, 409, 'a sent claim is never sent again');
  await put('held');
  assert.equal((await mark('sending')).status, 409, 'nor a held one');
  await put('queued');
  assert.equal((await mark('sent')).status, 409, 'a claim is sent only after it was being sent');
  assert.equal((await mark('sending')).status, 200);
  assert.equal((await mark('sending')).status, 200, 'the same send can be marked again when it resumes');
  assert.equal((await mark('held')).status, 200);
});

test('a held claim is checked again when its holder asks; any other keeps its answer', async () => {
  const e = env();
  await e.REGISTRY_KV.put(`bridge:recover:mainnet:${BURN}`, JSON.stringify({ ...claim(), status: 'held', at: 1 }));
  const r = await call(e, '/bridge/recover?network=mainnet', { method: 'POST', body: claim({ sig: '33'.repeat(64) }) });
  assert.equal(r.status, 400, 'it goes through the whole check again (this signature does not match)');
});
