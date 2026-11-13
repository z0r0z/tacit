// GET /confidential/relay and the submit refusals it backs, through the worker's own fetch: the settle relay's heartbeat (its
// status, and the standing note the relay beats) read into one state a page steers by, with nothing about why; a prove-only job
// refused while nobody would prove it; and every accepted submit told where the relay stands.
// Run: node tests/relay-state-route.test.mjs
import worker from '../worker/src/index.js';
import { NOTE_HELD, NOTE_HELD_BOARD, NOTE_PAUSED } from '../worker-relay/src/lib/prove-pause.js';

let fails = 0;
const ok = (c, m, d = '') => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c || !d ? '' : ` — ${d}`)); if (!c) fails++; };
const kv = () => { const m = new Map(); return { m, async get(k, t) { if (!m.has(k)) return null; return t === 'json' ? JSON.parse(m.get(k)) : m.get(k); }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } }; };

// Nothing here should reach a network; anything that tries fails at once.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => { if (/^https?:\/\/(?!api\.tacit)/.test(String(url))) throw new Error('offline'); return realFetch(url, opts); };

const env = { REGISTRY_KV: kv(), PROVER_HEARTBEAT_TOKEN: 'tok', CONFIDENTIAL_SETTLE: '1', OP_SHAPE_CHECK: '0' };   // placeholder ops: the shape doors are not under test here
const call = (path, init = {}) => worker.fetch(new Request(`https://api.tacit.finance${path}`, { ...init, headers: { Origin: 'https://some-page.example', ...(init.headers || {}) } }), env, { waitUntil() {} });
// The relay's heartbeat() stores `${kind}: ${detail}`; the standing notes are passed as the detail.
const beat = (detail, extra = {}) => call('/prover-heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok', network: 'mainnet', kind: 'settle', prover_alive: true, note: `settle: ${detail}`, ...extra }) });
const read = async () => { const r = await call('/confidential/relay'); return { r, j: await r.json() }; };
const submit = (body) => call('/confidential/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let { r, j } = await read();
ok(r.status === 200 && j.state === 'down' && j.proving === false && j.settling === false && j.board === false && j.ageSeconds === null, 'no heartbeat ever recorded reads as down', JSON.stringify(j));
ok(r.headers.get('access-control-allow-origin') === '*', 'any page may read it (open CORS)', r.headers.get('access-control-allow-origin'));
ok(r.headers.get('cache-control') === 'max-age=10', 'cached for ten seconds', r.headers.get('cache-control'));
let s = await submit({ type: 'transfer', op: { n: 1 }, mode: 'prove' });
let sj = await s.json();
ok(s.status === 503 && sj.code === 'relay_paused' && sj.retryAfter === 300 && s.headers.get('retry-after') === '300', 'a prove-only job is refused while no relay has ever beaten', `${s.status} ${JSON.stringify(sj)}`);
ok(s.headers.get('access-control-allow-origin') === '*', 'and the refusal is readable from any page');

await beat('idle — queue empty');
({ r, j } = await read());
ok(j.state === 'ok' && j.proving && j.settling && !j.board && Number.isInteger(j.ageSeconds), 'an idle relay is ok', JSON.stringify(j));
ok(JSON.stringify(Object.keys(j).sort()) === JSON.stringify(['ageSeconds', 'board', 'failing', 'proving', 'settling', 'state']), 'and the answer is the six fields, nothing else', Object.keys(j).join(','));
s = await submit({ type: 'transfer', op: { n: 2 }, mode: 'prove' }); sj = await s.json();
ok(s.status === 200 && sj.ok && sj.jobId && sj.relay === 'ok', 'an accepted submit says where the relay stands', JSON.stringify(sj));

await beat('proving 0xabc unwrap');
({ j } = await read());
ok(j.state === 'busy' && j.proving && j.settling, 'proving a job is busy', JSON.stringify(j));

await beat(NOTE_HELD);
({ j } = await read());
ok(j.state === 'held' && j.proving && !j.settling && !j.board, 'held, board off', JSON.stringify(j));
s = await submit({ type: 'transfer', op: { n: 3 }, mode: 'prove' }); sj = await s.json();
ok(s.status === 200 && sj.relay === 'held', 'a held relay still takes a prove-only job, and says it is held', JSON.stringify(sj));
s = await submit({ type: 'unwrap', op: { opDeadline: Math.floor(Date.now() / 1000) + 3600 }, mode: 'settle' }); sj = await s.json();
ok(s.status === 429 && sj.code === 'relay_held', 'a held relay turns away an expiring relayed settle as before', `${s.status} ${sj.code}`);

await beat(NOTE_HELD_BOARD);
({ j } = await read());
ok(j.state === 'held' && j.board === true && !j.settling, 'held, board on', JSON.stringify(j));

await beat('idle — queue empty', { gas_wei: '1000' });
({ j } = await read());
ok(j.state === 'held' && j.proving && !j.settling && !j.board, 'a settle key under its gas floor reads as held, not down', JSON.stringify(j));
ok(!JSON.stringify(j).includes('1000') && !/gas|note|reason/i.test(JSON.stringify(j)), 'with no balance, note or reason in the answer', JSON.stringify(j));

await beat(NOTE_PAUSED);
({ j } = await read());
ok(j.state === 'paused' && !j.proving && !j.settling && !j.board, 'not proving reads as paused', JSON.stringify(j));
s = await submit({ type: 'transfer', op: { n: 4 }, mode: 'prove' }); sj = await s.json();
ok(s.status === 503 && sj.code === 'relay_paused' && /your own prover account/.test(sj.error), 'a prove-only job is refused while paused', `${s.status} ${JSON.stringify(sj)}`);
s = await submit({ type: 'unwrap', op: { opDeadline: Math.floor(Date.now() / 1000) + 3600 }, mode: 'settle' }); sj = await s.json();
ok(s.status === 503 && sj.code === 'relay_paused', 'and so is an expiring relayed settle', `${s.status} ${sj.code}`);

await beat('idle — queue empty', { prover_alive: false });
({ j } = await read());
ok(j.state === 'down' && !j.proving, 'a dead loop process is down', JSON.stringify(j));

await beat('proving 0xabc unwrap');
const key = 'prover:heartbeat:mainnet:settle';
const rec = JSON.parse(env.REGISTRY_KV.m.get(key)); rec.ts -= 11 * 60_000; env.REGISTRY_KV.m.set(key, JSON.stringify(rec));
({ j } = await read());
ok(j.state === 'down' && j.ageSeconds >= 660, 'a heartbeat older than ten minutes is down, whatever its note said', JSON.stringify(j));

ok((await call('/confidential/relay', { method: 'POST' })).status !== 200, 'it is a read-only route');

globalThis.fetch = realFetch;
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
