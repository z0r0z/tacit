// A block takes the forced queue a few entries at a time, oldest first, and always every entry the contract's overdue rule needs.
//   node tests/tacit-leader-queue.test.mjs
import assert from 'node:assert';
import { backlogged, queueTake } from '../tacit-leader/queue.mjs';

const DELAY = 3600, MAX = 16;
// the contract's rule for a block that lands at `at` having taken `take` entries from `done`: reverts QueueOverdue when the entry it stops before is
// FORCE_DELAY old and fewer than MAX were taken
const overdueRule = ({ done, queued, queuedAt, at, take }) => { const d = done + take; return d < queued && at >= queuedAt(d) + DELAY && take < MAX; };
const at = (times) => (i) => times[i];

// nothing waiting
assert.equal(queueTake({ done: 4, queued: 4, queuedAt: at([]), now: 10_000, forceDelay: DELAY }).take, 0);

// young entries wait for the soft age; once older, a block takes a few of them, not all
{
  const t = Array.from({ length: 10 }, () => 1000);
  assert.equal(queueTake({ done: 0, queued: 10, queuedAt: at(t), now: 1010, forceDelay: DELAY }).take, 0, 'younger than the soft age: left');
  const r = queueTake({ done: 0, queued: 10, queuedAt: at(t), now: 1040, forceDelay: DELAY });
  assert.equal(r.take, 4, 'a few a block');
  assert.equal(r.ready, 10);
  assert.equal(queueTake({ done: 0, queued: 3, queuedAt: at(t), now: 1040, forceDelay: DELAY }).take, 3, 'fewer waiting than a block takes');
  assert.equal(queueTake({ done: 0, queued: 10, queuedAt: at(t), now: 1040, forceDelay: DELAY, perBlock: 2 }).take, 2);
  assert.equal(queueTake({ done: 0, queued: 40, queuedAt: at(Array(40).fill(1000)), now: 1040, forceDelay: DELAY, perBlock: 0 }).take, MAX, 'perBlock 0: everything up to the contract\'s limit, as before');
}

// the entries the rule needs are taken whatever the pacing: a run of overdue entries is taken whole (up to MAX)
{
  const t = Array.from({ length: 30 }, (_, i) => 100 + i);
  for (const now of [100 + DELAY - 1, 100 + DELAY, 100 + DELAY + 5, 100 + DELAY + 12, 100 + DELAY + 29, 100 + DELAY + 500]) {
    for (const perBlock of [1, 4, 8]) {
      const r = queueTake({ done: 0, queued: 30, queuedAt: at(t), now, forceDelay: DELAY, perBlock });
      assert.ok(!overdueRule({ done: 0, queued: 30, queuedAt: at(t), at: now, take: r.take }), `lands at ${now}, takes ${r.take}: the overdue rule holds`);
    }
  }
  assert.equal(queueTake({ done: 0, queued: 30, queuedAt: at(t), now: 100 + DELAY + 5, forceDelay: DELAY }).take, 6, 'six are overdue: all six, more than a block\'s few');
  assert.equal(queueTake({ done: 0, queued: 30, queuedAt: at(t), now: 100 + DELAY + 500, forceDelay: DELAY }).take, MAX, 'a long overdue run: the contract\'s limit');
}

// a block that lands later than it was built: entries about to turn due are taken now (margin)
{
  const t = [0, 50, 100, 5000, 5001];
  const now = 3650;                                     // entries 0 and 1 are overdue now (0 + 3600, 50 + 3600 <= 3650); entry 2 turns due at 3700
  const bare = queueTake({ done: 0, queued: 5, queuedAt: at(t), now, forceDelay: DELAY, perBlock: 1, softAge: 1e9 });
  assert.equal(bare.take, 2);
  const margin = queueTake({ done: 0, queued: 5, queuedAt: at(t), now, forceDelay: DELAY, perBlock: 1, softAge: 1e9, margin: 120 });
  assert.equal(margin.take, 3, 'entry 2 is due by the time the block lands');
  assert.ok(!overdueRule({ done: 0, queued: 5, queuedAt: at(t), at: now + 120, take: margin.take }), 'so the landing, 120 s later, is not refused');
  assert.ok(overdueRule({ done: 0, queued: 5, queuedAt: at(t), at: now + 120, take: bare.take }), 'where without the margin it would have been');
}

// from the middle of the queue
{
  const t = Array.from({ length: 12 }, (_, i) => 1000 + i);
  const r = queueTake({ done: 7, queued: 12, queuedAt: at(t), now: 2000, forceDelay: DELAY });
  assert.equal(r.take, 4);
  assert.equal(r.avail, 5);
}

// backlogged: anyone may land once the oldest waiting entry is FORCE_DELAY + WINDOW old
{
  const t = [1000, 1010];
  const b = (now, done = 0, queued = 2) => backlogged({ done, queued, queuedAt: at(t), now, forceDelay: DELAY, window: 600 });
  assert.equal(b(1000 + DELAY + 599), false);
  assert.equal(b(1000 + DELAY + 600), true);
  assert.equal(b(1000 + DELAY + 600, 2, 2), false, 'an empty queue is never backlogged');
  assert.equal(b(1010 + DELAY + 599, 1, 2), false, 'the oldest waiting is the one at `done`');
}

console.log('tacit-leader queue: ok');
