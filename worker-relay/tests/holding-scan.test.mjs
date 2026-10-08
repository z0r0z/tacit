// An EVM pool's events read into the store (src/lib/holding-scan.js): a stretch at a time, asking for less when a node refuses a
// range, stopping on a rate limit, and moving the cursor only over blocks whose events are stored.
//   node worker-relay/tests/holding-scan.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { scanHoldingChain, rateLimited } from '../src/lib/holding-scan.js';

const h32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const log = (block, i, first) => ({ blockNumber: BigInt(block), logIndex: i, args: { firstIndex: BigInt(first), outLeaf0: h32(1), outLeaf1: h32(2), nf0: h32(0), nf1: h32(0), newRoot: h32(block) } });
const chainWith = (events, { maxRange = Infinity, failAt = null, head = 1000 } = {}) => {
  const calls = [];
  return {
    calls,
    getBlockNumber: async () => BigInt(head),
    getLogs: async ({ fromBlock, toBlock }) => {
      const from = Number(fromBlock), to = Number(toBlock);
      calls.push([from, to]);
      if (to - from + 1 > maxRange) throw Object.assign(new Error('range too large'), { shortMessage: 'range too large' });
      if (failAt && failAt(from, to)) throw Object.assign(new Error('rate limit reached'), { shortMessage: 'rate limit reached' });
      return events.filter((e) => Number(e.blockNumber) >= from && Number(e.blockNumber) <= to);
    },
  };
};

const dir = mkdtempSync(join(tmpdir(), 'holding-scan-'));
try {
  const store = openStore(join(dir, 'p.db'));
  const events = [log(120, 0, 0), log(120, 1, 2), log(450, 0, 4), log(980, 0, 6)];
  const base = { store, chainId: 8453, pool: '0x' + '11'.repeat(20), deployBlock: 100, confirmations: 20, pauseMs: 0 };

  assert.equal(rateLimited(new Error('request limit reached')), true);
  assert.equal(rateLimited(new Error('range too large')), false);

  // A node that takes only 100 blocks at a time: the span is halved until it works, then kept.
  const c1 = chainWith(events, { maxRange: 100 });
  const r1 = await scanHoldingChain({ ...base, client: c1, span: 800, maxSpan: 800 });
  assert.equal(r1.cursor, 980, 'read through the last final block (head 1000 less 20 confirmations)');
  assert.equal(store.holdingEvents(8453).length, 4);
  assert.deepEqual(store.holdingEvents(8453).map((e) => [e.block, e.logIndex, e.firstIndex]), [[120, 0, '0'], [120, 1, '2'], [450, 0, '4'], [980, 0, '6']]);
  assert.equal(store.loadHoldingCursor(8453), 980);
  assert.ok(c1.calls.some(([a, b]) => b - a + 1 <= 100), 'it asked for less once refused');
  console.log('ok - events are read into the store, the span shrinks for a node that refuses a range, and the cursor stops at the last final block');

  // Nothing new: no reads past the cursor, and a second run adds nothing.
  const c2 = chainWith(events);
  const r2 = await scanHoldingChain({ ...base, client: c2, span: 800 });
  assert.equal(c2.calls.length, 0);
  assert.equal(r2.stored, 0);
  assert.equal(store.holdingEvents(8453).length, 4);

  // A rate limit ends the stretch without moving the cursor over unread blocks.
  const store2 = openStore(join(dir, 'q.db'));
  const c3 = chainWith(events, { failAt: (from) => from > 450 });
  const msgs = [];
  const r3 = await scanHoldingChain({ ...base, store: store2, client: c3, span: 200, maxSpan: 200, log: (m) => msgs.push(m) });
  assert.ok(r3.cursor >= 300 && r3.cursor < 980, `the cursor stopped where the limit began (${r3.cursor})`);
  assert.equal(store2.loadHoldingCursor(8453), r3.cursor);
  assert.equal(store2.holdingEvents(8453).every((e) => e.block <= r3.cursor), true, 'no event past the cursor is stored');
  assert.match(msgs.join(), /rate limited/);
  // and resumes from there.
  const r4 = await scanHoldingChain({ ...base, store: store2, client: chainWith(events), span: 200, maxSpan: 200 });
  assert.equal(r4.cursor, 980);
  assert.equal(store2.holdingEvents(8453).length, 4);
  console.log('ok - a rate limit ends the stretch, nothing past the cursor is stored, and the next cycle resumes');

  // A stretch is bounded in time.
  const store3 = openStore(join(dir, 'r.db'));
  let t = 0;
  const r5 = await scanHoldingChain({ ...base, store: store3, client: chainWith(events), span: 100, maxSpan: 100, budgetMs: 2, now: () => (t += 1) });
  assert.ok(r5.cursor < 980, 'a time budget ends it early');
  console.log('ok - a stretch of reading is bounded in time');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
