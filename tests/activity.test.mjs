// dapp/activity.js, the Activity journal every page reads: what has ended, what is still going (a bridge's burn that settled is still going
// until its Bitcoin step has landed), and a journal that cannot be read is an empty one.
//   node tests/activity.test.mjs
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const ET = new EventTarget();
globalThis.addEventListener = ET.addEventListener.bind(ET); globalThis.removeEventListener = ET.removeEventListener.bind(ET); globalThis.dispatchEvent = ET.dispatchEvent.bind(ET);
const A = await import('../dapp/activity.js');

const put = (items) => mem.set(A.ACT_KEY, JSON.stringify({ items, cleared: 0 }));
const pub = '02' + 'ab'.repeat(32), burn = '0x' + 'cd'.repeat(32);

assert.deepEqual(A.readActivity(), { items: [], cleared: 0 }, 'no journal: nothing in it');
mem.set(A.ACT_KEY, '{not json'); assert.deepEqual(A.readActivity().items, [], 'a journal that cannot be read is empty');

put([
  { id: 'job:1', kind: 'job', status: 'proving' },
  { id: 'job:2', kind: 'job', status: 'settled' },
  { id: 'tx:1:0x1', kind: 'tx', status: 'pending' },
  { id: 'tx:1:0x2', kind: 'tx', status: 'confirmed', in: 'op:9' },                 // a step inside another entry: not listed on its own
  { id: 'btc:3', kind: 'btc', status: 'stale' },
  { id: 'x', kind: 'nonsense', status: 'whatever' },                                 // an unknown kind is dropped on reading
  { kind: 'job', status: 'proving' },                                                // so is one with no id
]);
const items = A.readActivity().items;
assert.equal(items.length, 5, 'entries of a known kind with an id are read');
assert.equal(A.ended(items[0]), false); assert.equal(A.ended(items[1]), true); assert.equal(A.ended(items[4]), true, 'a stale Bitcoin transaction has ended');
assert.deepEqual(A.activityCount(), { total: 4, live: 2 }, 'four shown, two still going');

// a settled burn for a bridge to Bitcoin: going until the bridge journal says minted
put([{ id: 'op:7', kind: 'op', status: 'settled', hash: burn, pub }]);
assert.deepEqual(A.activityCount(), { total: 1, live: 0 }, 'with no bridge row it has ended');
mem.set(`tacit-crossout-bridge-v1:mainnet:${pub}`, JSON.stringify([{ stage: 'covered', settle: { txHash: burn.slice(2).toUpperCase() } }]));
assert.deepEqual(A.activityCount(), { total: 1, live: 1 }, 'its bridge still on its way: going (the hash matched with or without 0x, in any case)');
mem.set(`tacit-crossout-bridge-v1:mainnet:${pub}`, JSON.stringify([{ stage: 'minted', settle: { txHash: burn } }]));
assert.deepEqual(A.activityCount(), { total: 1, live: 0 }, 'minted on Bitcoin: done (the row is read again when it changes)');

assert.ok(Object.values(A.JOB_LABEL).every((x) => typeof x === 'string' && x.length > 0), 'every relay job has a name');
// ── the journal a page writes ──
mem.clear();
const said = [], changed = [];
let trims = 0;
const J = A.makeJournal({ pub: () => 'PUB', onTrim: () => trims++, onStatus: (it, prev) => said.push(`${it.id}:${prev}->${it.status}`), onChange: () => changed.push(1) });
J.put('job:a', { kind: 'job', label: 'Private transfer', status: 'pending' });
assert.equal(J.get('job:a').pub, 'PUB', 'a new entry records the open key');
J.put('job:a', { status: 'proving' }); J.put('job:a', { status: 'pending' });
assert.equal(J.get('job:a').status, 'proving', 'a status never goes back');
assert.ok(J.get('job:a').prov, 'proving is remembered');
J.put('job:a', { status: 'settled', hash: '0x1', label: 'renamed' });
assert.equal(J.get('job:a').status, 'settled'); assert.equal(J.get('job:a').label, 'Private transfer', 'a later patch does not rename it');
assert.ok(J.get('job:a').end > 0, 'its end is stamped');
assert.deepEqual(said, ['job:a:null->pending', 'job:a:pending->proving', 'job:a:proving->settled'], 'onStatus once per change, not for a refused step back');
assert.equal(changed.length, 4, 'onChange after every put');
J.put('job:b', { kind: 'job', status: 'failed' }); J.put('job:b', { status: 'settled' });
assert.ok(J.get('job:b').flip, 'a failure that turns out settled is marked');
J.write(); assert.equal(JSON.parse(mem.get(A.ACT_KEY)).items.length, 2, 'written to the shared key');
for (let i = 0; i < 25; i++) J.put(`tx:1:0x${i}`, { kind: 'tx', status: 'confirmed', at: 1000 + i });
assert.equal(A.listed(J.state.items).length, A.ACT_MAX, `kept to the newest ${A.ACT_MAX}`); assert.ok(trims > 0, 'onTrim before letting go');
J.state.items = J.state.items.filter((x) => x.kind !== 'tx');                       // the page may replace the list in place
assert.equal(J.get('tx:1:0x24'), undefined, 'and the journal reads what the page left');
assert.equal(A.ahead('settled', 'failed'), true, 'settled wins over a failure'); assert.equal(A.ahead('open', 'sending'), true); assert.equal(A.ahead('pending', 'proving'), false);
// a proved job whose pool has moved on is a failure (its send reverts every time), and nothing else turns a proved job into one by accident
assert.equal(A.ahead('failed', 'proven'), true, 'a proved job can be ended as failed'); assert.equal(A.ahead('proven', 'failed'), false, 'and a failed one is not proved again');
assert.equal(A.ahead('failed', 'settled'), false, 'a settled job is never failed'); assert.equal(A.ahead('unknown', 'proven'), false, 'an unknown answer does not unprove it');
J.put('job:dead', { kind: 'job', status: 'proven' }); J.put('job:dead', { status: 'failed', err: 'The pool moved.' });
assert.equal(J.get('job:dead').status, 'failed', 'the journal ends a proved job on a failure'); assert.equal(J.get('job:dead').err, 'The pool moved.');
J.put('job:dead', { status: 'proven' }); assert.equal(J.get('job:dead').status, 'failed', 'a later proved answer does not bring the offer back');
assert.ok(A.ENDS.job.includes('failed') && A.actDone(J.get('job:dead')), 'and it is finished');

// ── following ──
const tick = () => new Promise((r) => setTimeout(r, 20));
let asked = 0, finished = [];
const F = A.makeFollow({ journal: J, jobStatus: async () => { asked++; return { status: 'settled', txHash: '0xfeed' }; },
  receipt: async () => ({ status: '0x1' }), receiptOnce: async () => null, btcConfirmed: async () => true,
  own: (id) => id.startsWith('job:spn:'), onOwn: (id) => finished.push('own:' + id), finished: (f, h) => finished.push(`${f}@${h}`) });
J.put('job:c', { kind: 'job', status: 'pending' }); F.job('job:c'); F.job('job:c');
await tick();
assert.equal(J.get('job:c').status, 'settled'); assert.equal(J.get('job:c').hash, '0xfeed'); assert.equal(asked, 1, 'one follower per entry');
J.put('tx:1:0xaa', { kind: 'tx', status: 'pending', hash: '0xaa', chain: 1, finishes: ['op:1'] }); F.tx('tx:1:0xaa'); await tick();
assert.equal(J.get('tx:1:0xaa').status, 'confirmed'); assert.deepEqual(finished, ['op:1@0xaa'], 'a confirmed transaction finishes what it names');
J.put('tx:1:0xbb', { kind: 'tx', status: 'stale', hash: '0xbb', chain: 1 }); F.tx('tx:1:0xbb', true); await tick();
assert.equal(J.get('tx:1:0xbb').status, 'stale', 'asked once with no receipt: left as it was');
J.put('btc:dd', { kind: 'btc', status: 'pending', hash: 'dd' }); F.btc('btc:dd'); await tick();
assert.equal(J.get('btc:dd').status, 'confirmed');
F.job('job:spn:9'); assert.deepEqual(finished.at(-1), 'own:job:spn:9', 'a job proved on this device goes back to the page');
J.put('job:old', { kind: 'job', status: 'pending', at: Date.now() - 2 * 86400e3 }); F.job('job:old'); await tick();
assert.equal(J.get('job:old').status, 'unknown', 'a day with no answer ends it as unknown');

// ── the relay's state ──
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => ({ ok: /\/confidential\/relay$/.test(u), status: /\/confidential\/relay$/.test(u) ? 200 : 404, json: async () => ({ state: 'paused' }) });
let moved = 0;
const R = A.makeRelayState({ api: 'https://api.example', onChange: () => moved++ });
assert.equal(await R.now(), 'paused'); assert.equal(R.why(), 'paused', 'kept for 15 s'); assert.equal(moved, 1);
assert.deepEqual(await R.jobStatus('x'), { status: 'unknown' }, 'a job the relay has not heard of is unknown');
globalThis.fetch = realFetch;

// ── a page other than the front one: no list of its own, so another tab's entries are never written over ──
mem.clear();
const SJ = A.makeJournal({ shared: true });
SJ.put('job:v1', { kind: 'job', label: 'Borrow 10 cUSD', status: 'pending' });
const front = JSON.parse(mem.get(A.ACT_KEY)); front.items.unshift({ id: 'tx:1:0xfront', kind: 'tx', status: 'pending', at: Date.now() + 1 }); mem.set(A.ACT_KEY, JSON.stringify(front));   // the front tab writes meanwhile
SJ.put('job:v1', { status: 'settled' });
const both = JSON.parse(mem.get(A.ACT_KEY)).items.map((x) => `${x.id}:${x.status}`).sort();
assert.deepEqual(both, ['job:v1:settled', 'tx:1:0xfront:pending'], 'the shared journal keeps what another tab wrote between its puts, and writes at once');

// ── the runner ──
mem.clear();
globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => (/status\?id=j9/.test(u) ? { status: 'settled', txHash: '0xab' } : { status: 'proving' }) });
const RN = A.makeRunner({ api: 'https://api.example', pub: () => 'PK' });
const w = RN.wait('Repay 900 cUSD');
assert.equal(w.timeoutMs, 20 * 60e3); assert.equal(typeof w.sleep, 'function');
w.onJob('j9');
let e9 = A.readActivity().items.find((x) => x.id === 'job:j9');
assert.equal(e9.label, 'Repay 900 cUSD'); assert.equal(e9.pub, 'PK', 'a job the page sets going is in the shared journal under its name, with the key');
dispatchEvent(new CustomEvent('tacit:job', { detail: { jobId: 'j9', type: 'cdpclose', status: 'proving' } }));
assert.equal(A.readActivity().items.find((x) => x.id === 'job:j9').status, 'proving', 'and moves on as the relay client announces it');
dispatchEvent(new CustomEvent('tacit:job', { detail: { jobId: 'j10', type: 'cdpmint', status: 'pending' } }));
assert.equal(A.readActivity().items.find((x) => x.id === 'job:j10').label, 'Borrow cUSD', 'a job announced without a name takes the relay type\'s');
await new Promise((r) => setTimeout(r, 30));
e9 = A.readActivity().items.find((x) => x.id === 'job:j9');
assert.equal(e9.status, 'settled'); assert.equal(e9.hash, '0xab', 'and is followed to its end');
globalThis.fetch = realFetch;

// a fast bridge under way, done, or returned is an Activity item of its own kind, followed from the fast route's records
{
  const fr = { id: 'sw1', phase: 'offered', ended: false, returned: false, amount: '100000000000', receive: '99690000000', created: 1_700_000_000, at: 1, title: 'Waiting for the pool lock', detail: 'The provider is locking TAC in the pool for you.', lockTxid: 'ab'.repeat(32) };
  const opts = { now: fr.created + 600, fmt: (v) => String(v / 100000000n), pub: 'PK' };
  const open = A.fastItem(fr, opts);
  assert.equal(open.id, 'fast:sw1'); assert.equal(open.patch.kind, 'fast'); assert.equal(open.patch.status, 'pending');
  assert.equal(open.patch.label, 'Fast bridge: 1000 TAC'); assert.equal(open.patch.at, fr.created * 1000, 'it is dated when the bridge was started'); assert.equal(open.patch.fa, 1);
  assert.equal(open.patch.lockTxid, 'ab'.repeat(32)); assert.equal(open.patch.err, undefined);
  assert.equal(A.fastItem({ ...fr, ended: true, phase: 'done', at: 3 }, opts).patch.status, 'settled', 'one that is done is settled');
  const back = A.fastItem({ ...fr, ended: true, returned: true, phase: 'refunded', at: 3, receive: '0' }, opts).patch;
  assert.equal(back.status, 'failed', 'one that came back to Bitcoin is not shown as done'); assert.match(back.err, /came back/);
  assert.equal(A.fastItem({ ...fr, ended: true, phase: 'done' }, { ...opts, now: fr.created + 90000 }), null, 'one that ended more than a day ago is not listed');
  assert.ok(A.fastItem({ ...fr }, { ...opts, now: fr.created + 90000 }), 'one still under way is, however old');
  assert.equal(A.fastItem(null), null);
  put([{ id: open.id, ...open.patch, at: open.patch.at }, { id: 'fast:sw2', kind: 'fast', status: 'settled', at: 1 }]);
  const got = A.readActivity().items;
  assert.equal(got.length, 2, 'the journal keeps entries of the fast kind');
  assert.equal(A.ended(got[0]), false); assert.equal(A.ended(got[1]), true, 'a pending one is under way and a settled one has ended');
  assert.deepEqual(A.activityCount(), { total: 2, live: 1 }, 'a bridge under way counts as live');
}

console.log('activity: all checks passed');
