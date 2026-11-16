// The hops the leader owes the confidential pool are kept until the contract says each is sent on: one send that failed is tried again, a restart and
// a block another leader landed do not lose one, a hop the pool refuses is let be, and an idle leader makes no calls.
//   node tests/tacit-leader-hops.test.mjs
import assert from 'node:assert';
import { hopsIn, hopKey, makeHopLedger, sweepHops } from '../tacit-leader/hops.mjs';
import { hexOf } from '../tacit-leader/abi.mjs';
import { archiveEntry, loadArchive } from '../tacit-leader/archive.mjs';

const word = (n) => { const b = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const commit = (n) => hexOf(new Uint8Array(32).fill(n));
const list = (...hs) => new Uint8Array(hs.flatMap(([v, c]) => [...word(0x18449ee5), ...word(v), ...Buffer.from(c.slice(2), 'hex')]));

// a hop of a block's list, and the key the contract files it under: a real one (block 178, landed 2026-11-13, held by hops() on 2026-11-16)
const REAL = { value: '19974748073', commit: '0xddca35c9d5a758c694872666f89729368827b2a9abfc8bd56a3ccb33c30afa9e' };
assert.equal(hopKey(REAL), '0xcdfc11b72d015aaf150ed996615d83e57f6fe7f9670fd95fdf52b4a33e7fddf1', 'keccak256(abi.encode(value, commit))');
assert.deepEqual(hopsIn(list([19974748073n, REAL.commit])), [REAL]);
assert.deepEqual(hopsIn(list([5n, commit(1)], [6n, commit(2)])).map((h) => h.value), ['5', '6']);
assert.deepEqual(hopsIn('0x'), [], 'a block with no hops');
assert.deepEqual(hopsIn(hexOf(list([7n, commit(3)]))).map((h) => h.value), ['7'], 'hex, as the node and the archive give it');

const file = () => { let text = null; return { read: () => text, write: (t) => { text = t; }, get text() { return text; } }; };
const T0 = 1_000_000;
const make = (f = file()) => ({ f, ledger: makeHopLedger(f) });
const fakeChain = (held) => {
  const calls = { waiting: 0, sent: [] };
  return { calls, held,
    waiting: async (h) => { calls.waiting++; return held.get(h.key) ?? 0n; },
    sendOn: (fn) => async (group) => { calls.sent.push(group.map((h) => h.value)); return fn ? fn(group) : []; } };
};

// owed once however often it is learned; kept in the file, so a restart still owes it
{
  const { f, ledger } = make();
  assert.equal(ledger.owe(hopsIn(list([5n, commit(1)])), { at: T0, height: 7 }), 1);
  assert.equal(ledger.owe(hopsIn(list([5n, commit(1)])), { at: T0 + 1 }), 0, 'the same hop learned again (the leader\'s own block, then the log of it)');
  assert.equal(makeHopLedger(f).items().length, 1, 'a restarted leader reads it back');
  assert.equal(makeHopLedger(f).items()[0].height, 7);
  assert.equal(makeHopLedger({ read: () => '{not json', write() {} }).items().length, 0, 'a file that does not read is no list');
}

// a hop the contract still holds is sent; one it no longer holds (sent on by anyone) is dropped with no send
{
  const { ledger } = make();
  const hs = hopsIn(list([5n, commit(1)], [6n, commit(2)]));
  ledger.owe(hs, { at: T0 });
  const c = fakeChain(new Map([[hopKey(hs[0]), 1n]]));          // the second is already gone
  const r = await sweepHops({ ledger, waiting: c.waiting, sendOn: c.sendOn(), now: T0 });
  assert.deepEqual(c.calls.sent, [['5']], 'only the one the contract still holds is sent, in one transaction');
  assert.equal(r.sent, 1);
  assert.equal(ledger.items().length, 1, 'the one already sent on is dropped');
  // it is asked about again after a rest, and dropped once the contract holds none
  const calls = c.calls.waiting;
  await sweepHops({ ledger, waiting: c.waiting, sendOn: c.sendOn(), now: T0 + 5_000 });
  assert.equal(c.calls.waiting, calls, 'within the rest after a send it is not asked about, so a node a block behind is not trusted');
  c.held.set(hopKey(hs[0]), 0n);
  await sweepHops({ ledger, waiting: c.waiting, sendOn: c.sendOn(), now: T0 + 200_000 });
  assert.equal(ledger.items().length, 0, 'sent on: nothing owed');
  assert.deepEqual(c.calls.sent, [['5']], 'and it was never sent twice');
}

// THE BUG: the one send failed (the estimate of a node a block behind said NoSuchHop), and nothing tried again. It is tried again, after a rest that grows
{
  const { ledger } = make();
  ledger.owe(hopsIn(list([199n, commit(9)])), { at: T0 });
  const held = new Map([[hopKey({ value: '199', commit: commit(9) }), 1n]]), c = fakeChain(held);
  let fails = 3;
  const sendOn = async (g) => { c.calls.sent.push(g.map((h) => h.value)); if (fails-- > 0) throw new Error('execution reverted: NoSuchHop'); return []; };
  const logs = [];
  await sweepHops({ ledger, waiting: c.waiting, sendOn, now: T0, log: (o) => logs.push(o) });
  assert.equal(c.calls.sent.length, 1);
  assert.equal(logs.at(-1).hopFailed, commit(9));
  await sweepHops({ ledger, waiting: c.waiting, sendOn, now: T0 + 5_000 });
  assert.equal(c.calls.sent.length, 1, 'not again within the first rest (10 s)');
  await sweepHops({ ledger, waiting: c.waiting, sendOn, now: T0 + 11_000 });
  assert.equal(c.calls.sent.length, 2);
  await sweepHops({ ledger, waiting: c.waiting, sendOn, now: T0 + 11_000 + 15_000 });
  assert.equal(c.calls.sent.length, 2, 'the rest doubled: 20 s after the second failure');
  await sweepHops({ ledger, waiting: c.waiting, sendOn, now: T0 + 11_000 + 21_000 });
  assert.equal(c.calls.sent.length, 3);
  const r = await sweepHops({ ledger, waiting: c.waiting, sendOn, now: T0 + 11_000 + 21_000 + 41_000 });
  assert.equal(c.calls.sent.length, 4, 'and the fourth try goes through');
  assert.equal(r.sent, 1);
  // a long run of failures rests at most ten minutes
  const { ledger: l2 } = make();
  l2.owe(hopsIn(list([1n, commit(5)])), { at: T0 });
  const c2 = fakeChain(new Map([[hopKey({ value: '1', commit: commit(5) }), 1n]]));
  let t = T0;
  for (let i = 0; i < 20; i++) { await sweepHops({ ledger: l2, waiting: c2.waiting, sendOn: async () => { throw new Error('no'); }, now: t }); t += 11 * 60_000; }
  assert.ok(l2.items()[0].retryAt - (t - 11 * 60_000) <= 10 * 60_000, 'the rest is capped at ten minutes');
  assert.equal(l2.items()[0].tries, 20);
}

// a block another leader landed is left to that leader for a while (at is later), and then sent if it is still held
{
  const { ledger } = make();
  const hs = hopsIn(list([8n, commit(4)]));
  ledger.owe(hs, { at: T0 + 120_000 });
  const c = fakeChain(new Map([[hopKey(hs[0]), 1n]]));
  await sweepHops({ ledger, waiting: c.waiting, sendOn: c.sendOn(), now: T0 + 60_000 });
  assert.equal(c.calls.sent.length, 0);
  assert.equal(c.calls.waiting, 0, 'not even asked about');
  await sweepHops({ ledger, waiting: c.waiting, sendOn: c.sendOn(), now: T0 + 130_000 });
  assert.deepEqual(c.calls.sent, [['8']]);
}

// a group that cannot be sent as one (one of its hops reverts the batch) goes one by one, and the one that fails alone is rested
{
  const { ledger } = make();
  const hs = hopsIn(list([1n, commit(1)], [2n, commit(2)], [3n, commit(3)]));
  ledger.owe(hs, { at: T0 });
  const c = fakeChain(new Map(hs.map((h) => [hopKey(h), 1n])));
  const sendOn = async (g) => { c.calls.sent.push(g.map((h) => h.value)); if (g.length > 1 || g[0].value === '2') throw new Error('revert'); return []; };
  const r = await sweepHops({ ledger, waiting: c.waiting, sendOn, now: T0 });
  assert.deepEqual(c.calls.sent, [['1', '2', '3'], ['1'], ['2'], ['3']]);
  assert.equal(r.sent, 2);
  assert.equal(ledger.items().find((h) => h.value === '2').tries, 1);
  assert.equal(ledger.items().find((h) => h.value === '1').tries, undefined);
}

// a hop the pool refused (it takes a commitment once) stays with the contract: it is let be, not sent again and again at the leader's cost
{
  const { ledger } = make();
  const hs = hopsIn(list([4n, commit(6)]));
  ledger.owe(hs, { at: T0 });
  const c = fakeChain(new Map([[hopKey(hs[0]), 1n]]));
  const logs = [];
  await sweepHops({ ledger, waiting: c.waiting, sendOn: c.sendOn(() => [hopKey(hs[0])]), now: T0, log: (o) => logs.push(o) });
  assert.equal(logs.at(-1).hopRefused, commit(6));
  const r = await sweepHops({ ledger, waiting: c.waiting, sendOn: c.sendOn(), now: T0 + 3600e3 });
  assert.equal(c.calls.sent.length, 1, 'an hour later still not sent again');
  assert.equal(r.left, 0, 'nothing left to try');
}

// a read of the contract that fails does not send anything and does not lose the hop
{
  const { ledger } = make();
  const hs = hopsIn(list([4n, commit(7)]));
  ledger.owe(hs, { at: T0 });
  const sent = [];
  await sweepHops({ ledger, waiting: async () => { throw new Error('rpc down'); }, sendOn: async (g) => { sent.push(g); return []; }, now: T0 });
  assert.equal(sent.length, 0);
  assert.equal(ledger.items().length, 1);
}

// idle: nothing owed, or nothing due, makes no calls at all
{
  const { ledger } = make();
  let calls = 0;
  const probe = async () => { calls++; return 1n; };
  assert.deepEqual(await sweepHops({ ledger, waiting: probe, sendOn: probe, now: T0 }), { sent: 0, left: 0 });
  assert.equal(calls, 0);
}


// the archive keeps a block's hops, so a restart can find what was owed (a block the leader built itself keeps the node's hex; one it read from the logs, this)
{
  const w = (n) => new Uint8Array(32).fill(n);
  const pv = new Uint8Array([...w(1), ...w(2), ...new Uint8Array(32 * 17)]);
  const lists = { leaves: new Uint8Array(32), memos: new Uint8Array(8), nullifiers: [], hops: list([12n, commit(8)]) };
  const entry = JSON.parse(JSON.stringify(archiveEntry(pv, lists, 55)));
  assert.deepEqual(hopsIn(entry.lists.hops).map((h) => h.value), ['12'], 'the hops of a block are in its file');
  assert.equal('hops' in JSON.parse(JSON.stringify(archiveEntry(pv, { ...lists, hops: new Uint8Array(0) }))).lists, false, 'a block with none writes none');
  assert.deepEqual(hopsIn(JSON.parse(JSON.stringify(archiveEntry(pv, { ...lists, hops: undefined }))).lists.hops), [], 'nor does one read without the field');
  assert.ok(loadArchive(1, () => JSON.stringify(entry)).ok, 'a file with hops is still a chain file');
}

console.log('tacit-leader-hops: ok');
