// A transaction a wallet speeds up or cancels is sent again at the same nonce and its first hash never confirms: the Activity list and the
// pages waiting on it must follow what took its place (dapp/activity.js lookReplaced, and makeFollow.tx around it).
//   node tests/tx-replaced.test.mjs
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const ET = new EventTarget();
globalThis.addEventListener = ET.addEventListener.bind(ET); globalThis.removeEventListener = ET.removeEventListener.bind(ET); globalThis.dispatchEvent = ET.dispatchEvent.bind(ET);
const A = await import('../dapp/activity.js');

import { chain, whenLooked } from './fake-eth-chain.mjs';
const me = '0x' + 'aa'.repeat(20), pool = '0x' + 'bb'.repeat(20), other = '0x' + 'cc'.repeat(20);
const call = { to: pool, value: 5, input: '0x1234abcd' + '00'.repeat(500) };
const orig = { hash: '0x' + '01'.repeat(32), from: me, nonce: 0, ...call };

// ── one look at a transaction that is waiting: it is remembered, once ──
{
  const c = chain(); c.send(orig);
  const v = await A.lookReplaced({ read: c.read, hash: orig.hash, seen: undefined });
  assert.deepEqual(Object.keys(v), ['seen']); assert.equal(v.seen.from, me); assert.equal(v.seen.nonce, '0'); assert.equal(v.seen.to, pool); assert.equal(v.seen.value, '5');
  assert.deepEqual(await A.lookReplaced({ read: c.read, hash: orig.hash, seen: v.seen }), {}, 'still waiting in the pool: nothing to say');
  assert.ok(JSON.stringify(v.seen).length < 300, 'what is kept in the journal is small however big the call is');
}

// ── sped up: the same call at a higher fee, mined some blocks later ──
{
  const c = chain(); c.send(orig);
  const { seen } = await A.lookReplaced({ read: c.read, hash: orig.hash });
  c.mempool.delete(orig.hash);                                                                    // the wallet replaced it: this node dropped the first
  c.calls.length = 0;
  assert.deepEqual(await A.lookReplaced({ read: c.read, hash: orig.hash, seen }), { idle: true }, 'dropped but the nonce is free: nothing took its place (the wallet may send it again)');
  assert.deepEqual(c.calls, ['eth_getTransactionByHash', 'eth_getTransactionCount'], 'which costs two reads, so waiting a long time does not search the blocks again and again');
  const fast = { hash: '0x' + '02'.repeat(32), from: me, nonce: 0, ...call };
  c.mine({ hash: '0x' + '03'.repeat(32), from: other, nonce: 0, to: me, block: 990 }, 990); c.mine(fast, 990); c.mine({ hash: '0x' + '04'.repeat(32), from: me, nonce: 1, to: pool, block: 995 }, 995);
  c.calls.length = 0;
  const v = await A.lookReplaced({ read: c.read, hash: orig.hash, seen });
  assert.deepEqual(v, { found: { hash: fast.hash, same: true } }, 'what took the nonce is the same call, so it stands for the first');
  assert.ok(c.calls.length < 22, `found in a few reads, not a scan of the blocks (${c.calls.length})`);
}

// ── cancelled (or changed): another call at the nonce means the first never ran ──
for (const [what, rep] of [['a cancel', { to: me, value: 0, input: '0x' }], ['another target', { ...call, to: other }], ['another amount', { ...call, value: 6 }], ['other data', { ...call, input: '0x1234abcd' + '00'.repeat(499) + '01' }]]) {
  const c = chain(); c.send(orig);
  const { seen } = await A.lookReplaced({ read: c.read, hash: orig.hash });
  c.mempool.delete(orig.hash);
  const t = { hash: '0x' + '05'.repeat(32), from: me, nonce: 0, ...rep }; c.mine(t, 998);
  assert.deepEqual(await A.lookReplaced({ read: c.read, hash: orig.hash, seen }), { found: { hash: t.hash, same: false } }, `${what}: found, and not the same`);
}

// ── it was mined itself and the node answering has not caught up: the same transaction, not a replacement ──
{
  const c = chain(); c.send(orig);
  const { seen } = await A.lookReplaced({ read: c.read, hash: orig.hash });
  c.mine(orig, 999);
  const real = c.read; c.read = async (m, p) => (m === 'eth_getTransactionByHash' ? null : real(m, p));       // this node has lost the lookup, not the chain
  assert.deepEqual(await A.lookReplaced({ read: c.read, hash: orig.hash, seen }), { found: { hash: orig.hash, same: true } });
}

// ── nothing found, nothing said ──
{
  const c = chain(); c.send(orig);
  const { seen } = await A.lookReplaced({ read: c.read, hash: orig.hash });
  assert.deepEqual(await A.lookReplaced({ read: c.read, hash: '0x' + '09'.repeat(32), seen: undefined }), {}, 'never seen in the pool: nothing to go on');
  c.down = true; assert.deepEqual(await A.lookReplaced({ read: c.read, hash: orig.hash, seen }), {}, 'an unreachable node says nothing');
  c.down = false; c.mempool.delete(orig.hash);
  c.mine({ hash: '0x' + '06'.repeat(32), from: me, nonce: 0, ...call }, 700); c.head = 1000;
  assert.deepEqual(await A.lookReplaced({ read: c.read, hash: orig.hash, seen }), { moved: true }, 'a replacement older than the state a node keeps is not found, and nothing throws: but the nonce is known to have been taken');
  assert.deepEqual(await A.traceTx({ read: c.read, hash: orig.hash, seen }), { unknown: true, moved: true });
  assert.deepEqual(await A.lookReplaced({ read: c.read, hash: orig.hash, seen: { ...seen, nonce: '7' } }), { idle: true }, 'a nonce no mined transaction has reached yet is not a replacement');
}

// ── a contract creation (no target) is told apart the same way ──
{
  const c = chain(), mk = { hash: '0x' + '07'.repeat(32), from: me, nonce: 0, to: null, value: 0, input: '0x6080' }; c.send(mk);
  const { seen } = await A.lookReplaced({ read: c.read, hash: mk.hash }); assert.equal(seen.to, '');
  c.mempool.delete(mk.hash); c.mine({ ...mk, hash: '0x' + '08'.repeat(32) }, 997);
  assert.equal((await A.lookReplaced({ read: c.read, hash: mk.hash, seen })).found.same, true);
}

// ── what became of a transaction a page stopped waiting for ──
{
  const trace = (c, seen = null, hash = orig.hash) => A.traceTx({ read: c.read, hash, seen });
  const kept = { from: me, nonce: '0', to: pool, value: '5', data: A.fingerprint(call.input) };
  const fast = { hash: '0x' + '0f'.repeat(32), from: me, nonce: 0, ...call }, cancel = { hash: '0x' + '0e'.repeat(32), from: me, nonce: 0, to: me, value: 0, input: '0x' };
  let c = chain(); c.mine(orig, 990);
  const r = (await trace(c)).landed; assert.equal(r.transactionHash, orig.hash, 'mined: its own receipt');
  c = chain(); c.mine({ ...orig, status: '0x0' }, 990); assert.equal((await trace(c)).landed.status, '0x0', 'a revert is a receipt too: the caller reads its status');
  c = chain(); c.send(orig); assert.deepEqual(await trace(c), { pending: true }, 'still held by a node, with nothing kept of it');
  assert.deepEqual(await trace(c, kept), { pending: true }, 'and with its place in line not taken');
  c = chain(); c.send(orig); c.mine(fast, 990);
  assert.equal((await trace(c)).landed.transactionHash, fast.hash, 'a node that still holds the first while a speed-up has taken its place: the speed-up landed (read from the node\'s own copy, nothing kept needed)');
  c = chain(); c.send(orig); c.mine(cancel, 990); assert.deepEqual(await trace(c), { replaced: cancel.hash }, 'and a cancel: it never ran');
  c = chain(); c.send(orig); c.mempool.delete(orig.hash); c.mine(fast, 990);
  assert.equal((await trace(c, kept)).landed.transactionHash, fast.hash, 'no node holds the first, a speed-up took its nonce: that one landed');
  assert.deepEqual(await trace(c), { unknown: true }, 'without what was kept there is no telling');
  c = chain(); c.send(orig); c.mempool.delete(orig.hash); c.mine(cancel, 990); assert.deepEqual(await trace(c, kept), { replaced: cancel.hash });
  c = chain(); c.send(orig); c.mempool.delete(orig.hash); assert.deepEqual(await trace(c, kept), { dropped: true }, 'no node holds it and nothing took its nonce: dropped');
  assert.deepEqual(await trace(c, { ...kept, nonce: '7' }), { dropped: true });
  c = chain(); c.send(orig); c.mempool.delete(orig.hash); c.mine(fast, 990); const real = c.read;
  c.read = async (m, p) => { if (m === 'eth_getTransactionCount') throw new Error('not served'); return real(m, p); };
  assert.deepEqual(await trace(c, kept), { unknown: true }, 'a node that does not serve the nonce leaves it unknown, not dropped');
  c.read = async (m, p) => { if (m === 'eth_getTransactionReceipt' && p[0] === fast.hash) return null; return real(m, p); };
  assert.deepEqual(await trace(c, kept), { pending: true }, 'the speed-up is found but its receipt is not served yet: look again');
  c = chain(); c.send(orig); c.mine(orig, 990); const r2 = c.read; c.read = async (m, p) => (m === 'eth_getTransactionReceipt' ? null : r2(m, p));
  assert.deepEqual(await trace(c), { pending: true }, 'mined, and this node\'s receipt a moment behind');
  c = chain(); c.down = true; await assert.rejects(trace(c, kept), /could not be read/, 'nothing readable: the caller is told, not given a guess');
}

// ── a page's own wait for a receipt ──
{
  const later = (ms, f) => new Promise((r) => setTimeout(() => { f(); r(); }, ms));
  const wait = (c, o = {}) => A.waitMined({ read: c.read, hash: orig.hash, probeMs: 10, every: 5, timeoutMs: 2000, ...o });
  const fast = { hash: '0x' + '0f'.repeat(32), from: me, nonce: 0, ...call }, cancel = { hash: '0x' + '0e'.repeat(32), from: me, nonce: 0, to: me, value: 0, input: '0x' };
  let c = chain(); c.send(orig); later(8, () => c.mine(orig, 999));
  const r1 = await wait(c, { probeMs: 1000 }); assert.equal(r1.rc.transactionHash, orig.hash); assert.ok(c.calls.every((m) => m === 'eth_getTransactionReceipt'), 'a transaction that lands soon costs nothing beyond its receipt');
  c = chain(); c.send(orig); whenLooked(c, () => { c.mempool.delete(orig.hash); c.mine(fast, 990); });
  assert.equal((await wait(c)).rc.transactionHash, fast.hash, 'a speed-up: the receipt of what took its place');
  c = chain(); c.send(orig); whenLooked(c, () => { c.mempool.delete(orig.hash); c.mine(cancel, 990); });
  assert.deepEqual(await wait(c), { replaced: cancel.hash }, 'a cancel: it never ran');
  c = chain(); c.send(orig); whenLooked(c, () => { c.mempool.delete(orig.hash); c.mine({ ...fast, status: '0x0' }, 990); });
  assert.equal((await wait(c)).rc.status, '0x0', 'a revert is a receipt: the caller reads its status');
  c = chain(); c.send(orig);
  const t = await wait(c, { timeoutMs: 120 }); assert.equal(t.timeout, true); assert.equal(t.seen?.nonce, '0', 'the time runs out with what the wait learned, for traceTx');
  c = chain(); c.send(orig); let stopped = false; later(30, () => { stopped = true; });
  assert.deepEqual(await wait(c, { stop: () => stopped }), { stopped: true }, 'a page that has moved on ends its wait');
  c = chain(); c.send(orig); const real = c.read; let n = 0;
  c.read = async (m, p) => { if (m === 'eth_getTransactionReceipt' && ++n < 3) throw new Error('node busy'); return real(m, p); }; later(40, () => c.mine(orig, 999));
  assert.equal((await wait(c, { read: c.read })).rc.transactionHash, orig.hash, 'a read that fails is asked again, not taken for the end');
  let slept = 0; c = chain(); c.send(orig); c.mine(orig, 999);
  assert.equal((await A.waitMined({ read: c.read, hash: orig.hash, sleep: async () => { slept++; } })).rc.transactionHash, orig.hash); assert.equal(slept, 0, 'a receipt already there is returned before any sleep');
}

// ── a row that ran out of time is looked at again from what was kept of it ──
{
  mem.clear();
  const J2 = A.makeJournal({}), fin = [];
  const mk = (h, extra = {}) => J2.put('tx:1:' + h, { kind: 'tx', status: 'stale', hash: h, chain: 1, finishes: ['op:1'], ...extra });
  let t = {};
  const F2 = A.makeFollow({ journal: J2, jobStatus: async () => ({}), btcConfirmed: async () => false, receipt: async () => null, receiptOnce: async () => null, finished: (f, h) => fin.push(h), trace: async () => t });
  const tick2 = () => new Promise((r) => setTimeout(r, 20));
  mk('0xs1'); t = { landed: { status: '0x1', transactionHash: '0xs2' } }; F2.tx('tx:1:0xs1', true); await tick2();
  assert.equal(J2.get('tx:1:0xs1').status, 'confirmed'); assert.equal(J2.get('tx:1:0xs1').hash, '0xs2'); assert.deepEqual(fin, ['0xs2'], 'a stale row a speed-up landed for is confirmed, and what it finishes is told');
  mk('0xs3'); t = { replaced: '0xs4' }; F2.tx('tx:1:0xs3', true); await tick2();
  assert.equal(J2.get('tx:1:0xs3').status, 'failed'); assert.equal(J2.get('tx:1:0xs3').replaced, true);
  mk('0xs5'); t = { dropped: true }; F2.tx('tx:1:0xs5', true); await tick2(); assert.equal(J2.get('tx:1:0xs5').why, 'dropped'); assert.equal(J2.get('tx:1:0xs5').status, 'stale');
  mk('0xs6'); t = { unknown: true, moved: true }; F2.tx('tx:1:0xs6', true); await tick2(); assert.equal(J2.get('tx:1:0xs6').why, 'moved');
  mk('0xs7'); t = { unknown: true }; F2.tx('tx:1:0xs7', true); await tick2(); assert.equal(J2.get('tx:1:0xs7').why, undefined, 'no telling: as it was');
}

// ── in the Activity list ──
const tick = () => new Promise((r) => setTimeout(r, 20));
const J = A.makeJournal({});
const got = []; let finished = [];
const reply = {};
const F = A.makeFollow({ journal: J, jobStatus: async () => ({ status: 'pending' }), btcConfirmed: async () => false, finished: (f, h) => finished.push(`${f}@${h}`),
  receipt: async (h, chain, note) => { got.push([h, chain, note]); return reply[h] ?? null; }, receiptOnce: async (h) => reply[h] ?? null });
J.put('tx:1:0xaa', { kind: 'tx', status: 'pending', hash: '0xaa', chain: 1, finishes: ['op:1'], seen: { from: me, nonce: '3', to: pool, value: '0', data: '1:1' } });
reply['0xaa'] = { status: '0x1', transactionHash: '0xbb' };
F.tx('tx:1:0xaa'); await tick();
assert.equal(J.get('tx:1:0xaa').status, 'confirmed'); assert.equal(J.get('tx:1:0xaa').hash, '0xbb', 'a sped-up transaction shows the hash that landed');
assert.deepEqual(finished, ['op:1@0xbb'], 'and what it finishes is told that one');
assert.equal(got[0][2].seen.nonce, '3', 'what was kept of it is given back to the watch (it survives a reload)');
got[0][2].keep({ from: me, nonce: '3', to: pool, value: '1', data: '1:1' }); assert.equal(J.get('tx:1:0xaa').seen.value, '1', 'and what the watch learns is written to the journal');

J.put('tx:1:0xcc', { kind: 'tx', status: 'pending', hash: '0xcc', chain: 1, finishes: ['op:2'] });
reply['0xcc'] = { status: '0x0', replaced: true, transactionHash: '0xdd' };
F.tx('tx:1:0xcc'); await tick();
assert.equal(J.get('tx:1:0xcc').status, 'failed'); assert.equal(J.get('tx:1:0xcc').err, A.REPLACED_TEXT); assert.equal(J.get('tx:1:0xcc').hash, '0xdd', 'a cancelled one points at the transaction that took its place'); assert.equal(J.get('tx:1:0xcc').replaced, true, 'and is marked, so the list says Replaced rather than Reverted');
assert.deepEqual(finished, ['op:1@0xbb'], 'and finishes nothing');

J.put('tx:1:0xee', { kind: 'tx', status: 'pending', hash: '0xee', chain: 1 });
reply['0xee'] = { status: '0x0' }; F.tx('tx:1:0xee'); await tick();
assert.equal(J.get('tx:1:0xee').err, 'The transaction reverted.'); assert.equal(J.get('tx:1:0xee').hash, '0xee', 'a plain revert is as it was');

// ── the hash that goes on to the relay or a record ──
const mapped = new Map([['0x11', '0x12']]);
assert.equal(A.landedHash('0xAA', J, new Map()), '0xbb', 'a sped-up transaction that was followed to its end: the hash it went in under (found in the journal, so after a reload too)');
assert.equal(A.landedHash('0xcc', J, new Map()), '0xcc', 'a cancelled one has no such hash: what took its place did not do what it was sent for');
assert.equal(A.landedHash('0x11', J, mapped), '0x12', 'one seen replaced while the page lives (before the journal has it)');
assert.equal(A.landedHash('0xzz', J, mapped), '0xzz', 'one nothing is known of is itself'); assert.equal(A.landedHash(null, J, mapped), null); assert.equal(A.landedHash('0xaa', null, null), '0xaa', 'with no journal or map');
console.log('ok');
