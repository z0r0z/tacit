// How many of the forced queue's entries a block takes (TacitBlocks `land`, `force`).
//
// The queue is taken in order and the contract asks one thing of every block: once the entry the block stops before is FORCE_DELAY old, the block
// must have taken `maxForced` entries (or the whole queue). An entry that does not verify still costs the block program a check of its own, so a block
// that takes many such entries at once costs the most to prove. A leader that takes the queue a few entries a block as it comes, oldest first, never
// reaches that rule with a long run of waiting entries; it still takes every entry the rule needs, so the guarantee does not move. Pure, so tested:
// tests/tacit-leader-queue.test.mjs.

/// { take, overdue, ready, avail } for a block built at `now` (seconds) from entry `done`.
///   queuedAt(i)  when entry i was posted (seconds; the contract's `queuedAt`, which never decreases with i)
///   forceDelay   the contract's FORCE_DELAY
///   margin       how far past `now` the block may land (its proving time): an entry that turns FORCE_DELAY old by then counts as due
///   perBlock     the most a block takes beyond what is due; 0 takes everything up to maxForced, as a leader without this pacing would
///   softAge      an entry younger than this (seconds) is left for the next block unless it is due
export function queueTake({ done, queued, queuedAt, now, forceDelay, maxForced = 16, perBlock = 4, softAge = 30, margin = 0 }) {
  const avail = Math.max(0, Math.min(queued - done, maxForced));
  if (perBlock <= 0) return { take: avail, overdue: 0, ready: avail, avail };
  let overdue = 0;
  while (overdue < avail && queuedAt(done + overdue) + forceDelay <= now + margin) overdue++;
  let ready = 0;
  while (ready < avail && now - queuedAt(done + ready) >= softAge) ready++;
  return { take: Math.min(avail, Math.max(overdue, Math.min(ready, perBlock))), overdue, ready, avail };
}

/// Whether anyone may land now whatever the turn: an entry has waited FORCE_DELAY + WINDOW (the contract's `backlogged`).
export function backlogged({ done, queued, queuedAt, now, forceDelay, window }) {
  return done < queued && now >= queuedAt(done) + forceDelay + window;
}
