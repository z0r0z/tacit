// The exits the leader pays out are kept until the contract owes each address nothing: a node a block behind that reads 0 owed, a send that failed, a
// slow one and a restart do not leave a holder waiting (block 815, 2026-11-22: 151.9 TAC waited two days), and no call can hold the block loop.
//   node tests/tacit-leader-exits.test.mjs
import assert from 'node:assert';
import { exitsIn, makeExitLedger, payExits } from '../tacit-leader/exits.mjs';
import { hexOf } from '../tacit-leader/abi.mjs';

const word = (n) => { const b = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const exit = (asset, amount, to) => [...word(asset), ...word(amount), ...word(BigInt(to))];
const list = (...xs) => new Uint8Array(xs.flatMap((x) => exit(...x)));
const T0 = 1_000_000;
const clock = (t = T0) => ({ now: () => t, set: (x) => { t = x; }, add: (x) => { t += x; } });

// the list a block carries: asset ‖ amount ‖ address, 96 bytes each; the address is the last 20 bytes
assert.deepEqual(exitsIn(list([1, 15192920294n, addr(0x149c2a08)])), [addr(0x149c2a08)], 'block 815\'s one exit');
assert.deepEqual(exitsIn(list([1, 5n, addr(7)], [1, 6n, addr(8)], [1, 7n, addr(7)])), [addr(7), addr(8)], 'each address once');
assert.deepEqual(exitsIn('0x'), []);
assert.deepEqual(exitsIn(hexOf(list([1, 5n, addr(9)]))), [addr(9)], 'hex, as the node and the archive give it');
assert.deepEqual(exitsIn(new Uint8Array(95)), [], 'a partial item is no exit');

// a fresh exit: a node a block behind reads 0 owed, and the exit is NOT let go, so it is paid when a later read shows it
{
  const c = clock(), ledger = makeExitLedger({ rest: 300_000 }), paid = [], logs = [];
  let reads = 0;
  const owed = async () => (++reads === 1 ? 0n : 15192920294n * 10n ** 10n);       // (the first read is of a node that has not seen the block)
  const pay = async (to) => { paid.push(to); return '0xtx'; };
  assert.equal(ledger.owe([addr(1)], { now: c.now() }), 1);
  let r = await payExits({ ledger, owed, pay, now: c.now, log: (x) => logs.push(x) });
  assert.deepEqual(paid, [], 'a zero read just after a landing is not believed');
  assert.equal(ledger.size(), 1);
  assert.deepEqual(ledger.due(c.now()), [], 'and it is not read again at once');
  c.add(10_000);
  assert.deepEqual(ledger.due(c.now()), [addr(1)], 'but after 10 s');
  r = await payExits({ ledger, owed, pay, now: c.now, log: (x) => logs.push(x) });
  assert.deepEqual(paid, [addr(1)], 'the second read shows it, and it is paid');
  assert.equal(r.paid, 1); assert.equal(ledger.size(), 0);
  assert.deepEqual(logs, [{ paidOut: addr(1), tx: '0xtx' }]);
}

// a fresh exit that really is paid already (anyone may withdraw) is let go once the rest has passed, not before
{
  const c = clock(), ledger = makeExitLedger({ rest: 60_000 });
  ledger.owe([addr(2)], { now: c.now() });
  for (const t of [0, 10_000, 30_000, 50_000]) { c.set(T0 + t); if (ledger.due(c.now()).length) assert.equal(ledger.zero(addr(2), c.now()), false, `read again at +${t}`); }
  c.set(T0 + 61_000);
  assert.equal(ledger.zero(addr(2), c.now()), true, 'let go after the rest');
  assert.equal(ledger.size(), 0);
}

// an exit read back from the archive at a start is not fresh: a zero read lets it go at once, a read owed pays it
{
  const c = clock(), ledger = makeExitLedger(), paid = [];
  ledger.owe([addr(3), addr(4)], { now: c.now(), fresh: false });
  const owed = async (to) => (to === addr(4) ? 996n * 10n ** 18n : 0n);
  await payExits({ ledger, owed, pay: async (to) => { paid.push(to); return '0x'; }, now: c.now });
  assert.deepEqual(paid, [addr(4)]);
  assert.equal(ledger.size(), 0, 'the paid one and the one owed nothing are both gone');
}

// a payout that fails is tried again after a rest that doubles, and let go after 12 failures
{
  const c = clock(), ledger = makeExitLedger(), logs = [];
  let calls = 0;
  const pay = async () => { calls++; throw new Error('estimateGas: node a block behind'); };
  const owed = async () => 5n;
  ledger.owe([addr(5)], { now: c.now(), fresh: false });
  await payExits({ ledger, owed, pay, now: c.now, log: (x) => logs.push(x) });
  assert.equal(calls, 1); assert.equal(logs[0].tries, 1); assert.match(logs[0].error, /node a block behind/);
  assert.deepEqual(ledger.due(c.now()), [], 'not at once');
  c.add(29_000); assert.deepEqual(ledger.due(c.now()), [], 'not before 30 s');
  c.add(1_000); assert.deepEqual(ledger.due(c.now()), [addr(5)], '30 s');
  await payExits({ ledger, owed, pay, now: c.now, log: (x) => logs.push(x) });
  c.add(59_000); assert.deepEqual(ledger.due(c.now()), [], 'then 60 s');
  c.add(1_000); assert.deepEqual(ledger.due(c.now()), [addr(5)]);
  for (let i = 2; i < 30 && ledger.size(); i++) { c.add(11 * 60_000); await payExits({ ledger, owed, pay, now: c.now, log: (x) => logs.push(x) }); }
  assert.equal(ledger.size(), 0, 'let go after 12 failures');
  assert.equal(logs.at(-1).gaveUp, true); assert.equal(logs.at(-1).tries, 12);
  assert.equal(calls, 12);
}

// a payout that failed, and was mined all the same (a slow node), is not paid twice: the next read finds nothing owed and lets it go at once
{
  const c = clock(), ledger = makeExitLedger({ rest: 300_000 }), paid = [];
  let o = 5n;
  const owed = async () => o;
  ledger.owe([addr(6)], { now: c.now() });                                   // (fresh)
  await payExits({ ledger, owed, pay: async () => { throw new Error('not mined in time'); }, now: c.now });
  o = 0n;                                                                    // (it was mined after all)
  c.add(30_000);
  await payExits({ ledger, owed, pay: async (to) => { paid.push(to); return '0x'; }, now: c.now });
  assert.deepEqual(paid, []); assert.equal(ledger.size(), 0, 'one a payout was tried for is not held for the rest');
}

// a read that never answers does not hold the pass: the others are done, and the stuck one is tried again later
{
  const c = clock(), ledger = makeExitLedger(), paid = [], logs = [];
  ledger.owe([addr(10), addr(11)], { now: c.now(), fresh: false });
  const owed = (to) => (to === addr(10) ? new Promise(() => {}) : Promise.resolve(3n));
  const t = Date.now();
  const r = await payExits({ ledger, owed, pay: async (to) => { paid.push(to); return '0x'; }, now: c.now, log: (x) => logs.push(x), readMs: 40 });
  assert.ok(Date.now() - t < 2000, 'the pass returned');
  assert.deepEqual(paid, [addr(11)], 'the other was paid');
  assert.equal(r.left, 1); assert.match(logs[0].error, /reading what is owed took over/);
}

// a payout that is slow is not sent a second time while the first is still out (the leader's sends queue behind each other)
{
  const c = clock(), ledger = makeExitLedger(), sent = [];
  let release;
  const slow = new Promise((ok) => { release = ok; });
  const pay = (to) => { sent.push(to); return slow.then(() => '0xslow'); };
  ledger.owe([addr(12)], { now: c.now(), fresh: false });
  await payExits({ ledger, owed: async () => 9n, pay, now: c.now, payMs: 30 });
  assert.equal(sent.length, 1);
  c.add(60 * 60_000);                                                        // (long after any rest)
  assert.deepEqual(ledger.due(c.now()), [], 'not due while its payout is still out');
  await payExits({ ledger, owed: async () => 9n, pay, now: c.now, payMs: 30 });
  assert.equal(sent.length, 1, 'not sent twice');
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ledger.due(c.now()), [addr(12)], 'due again once the call has settled');
}

// the pass sends at most `sends` and reads at most `reads` at a time; the rest stay due for the next pass
{
  const c = clock(), ledger = makeExitLedger(), paid = [];
  ledger.owe([addr(20), addr(21), addr(22)], { now: c.now(), fresh: false });
  await payExits({ ledger, owed: async () => 1n, pay: async (to) => { paid.push(to); return '0x'; }, now: c.now, sends: 2 });
  assert.equal(paid.length, 2); assert.equal(ledger.size(), 1, 'the third waits');
  await payExits({ ledger, owed: async () => 1n, pay: async (to) => { paid.push(to); return '0x'; }, now: c.now, sends: 2 });
  assert.equal(paid.length, 3); assert.equal(ledger.size(), 0);
  const many = makeExitLedger(); many.owe(Array.from({ length: 30 }, (_, i) => addr(100 + i)), { now: c.now(), fresh: false });
  let seen = 0;
  await payExits({ ledger: many, owed: async () => { seen++; return 0n; }, pay: async () => '0x', now: c.now, reads: 12 });
  assert.equal(seen, 12, 'an archive\'s worth of addresses is read a dozen a step, not all at once');
  assert.equal(many.size(), 18);
}

// the pass stops starting new ones when its time is up
{
  const c = clock(), ledger = makeExitLedger(), seen = [];
  ledger.owe([addr(30), addr(31), addr(32)], { now: c.now(), fresh: false });
  await payExits({ ledger, owed: async (to) => { seen.push(to); c.add(40_000); return 0n; }, pay: async () => '0x', now: c.now, budgetMs: 60_000 });
  assert.equal(seen.length, 2, 'two reads of 40 s each use the minute; the third waits');
  assert.equal(ledger.size(), 1);
}

// listing an address again (a second exit for it) makes it due at once, and fresh
{
  const c = clock(), ledger = makeExitLedger({ rest: 300_000 });
  ledger.owe([addr(40)], { now: c.now() });
  assert.equal(ledger.zero(addr(40), c.now()), false);
  c.add(1_000);
  assert.deepEqual(ledger.due(c.now()), []);
  assert.equal(ledger.owe([addr(40)], { now: c.now() }), 0, 'not new');
  assert.deepEqual(ledger.due(c.now()), [addr(40)], 'due at once');
}

console.log('tacit-leader-exits: ok');
