// worker-relay/src/lib/job-picker.js: the settle relay takes relayed settles before prove-only jobs, and still gives prove-only jobs a turn.
//   node --test tests/job-picker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { makeJobPicker } from '../worker-relay/src/lib/job-picker.js';

// A queue of jobs by kind; confidentialJob({ mode }) hands out the oldest of that kind, like the API's nextJob.
function queue({ settle = 0, prove = 0 } = {}) {
  const q = { settle: Array.from({ length: settle }, (_, i) => `s${i + 1}`), prove: Array.from({ length: prove }, (_, i) => `p${i + 1}`), calls: [] };
  q.confidentialJob = async ({ mode = null } = {}) => {
    q.calls.push(mode);
    const kind = mode || (q.settle.length ? 'settle' : 'prove');
    const id = q[kind].shift();
    return id ? { jobId: id, mode: kind } : {};
  };
  return q;
}
const drain = async (pick, n, opts) => { const out = []; for (let i = 0; i < n; i++) out.push((await pick(opts))?.jobId || null); return out; };

test('a settle is taken before an older prove-only job', async () => {
  const q = queue({ settle: 2, prove: 3 });
  const pick = makeJobPicker({ confidentialJob: q.confidentialJob, proveTurnEvery: 4 });
  assert.deepStrictEqual(await drain(pick, 5), ['s1', 's2', 'p1', 'p2', 'p3']);
});

test('prove-only jobs get a turn after every `proveTurnEvery` settles, and are not starved', async () => {
  const q = queue({ settle: 9, prove: 2 });
  const pick = makeJobPicker({ confidentialJob: q.confidentialJob, proveTurnEvery: 3 });
  assert.deepStrictEqual(await drain(pick, 11), ['s1', 's2', 's3', 'p1', 's4', 's5', 's6', 'p2', 's7', 's8', 's9']);
});

test('a turn with no prove-only job waiting is not wasted: the next settle goes on', async () => {
  const q = queue({ settle: 5, prove: 0 });
  const pick = makeJobPicker({ confidentialJob: q.confidentialJob, proveTurnEvery: 2 });
  assert.deepStrictEqual(await drain(pick, 5), ['s1', 's2', 's3', 's4', 's5']);
});

test('with no settle waiting, prove-only jobs are taken as before; an empty queue answers nothing', async () => {
  const q = queue({ settle: 0, prove: 2 });
  const pick = makeJobPicker({ confidentialJob: q.confidentialJob });
  assert.deepStrictEqual(await drain(pick, 3), ['p1', 'p2', null]);
});

test('short of funds, or gathering for company: only prove-only jobs, as the relay always did', async () => {
  for (const opts of [{ short: true }, { gather: 1000 }]) {
    const q = queue({ settle: 3, prove: 1 });
    const pick = makeJobPicker({ confidentialJob: q.confidentialJob });
    assert.deepStrictEqual(await drain(pick, 2, opts), ['p1', null]);
    assert.deepStrictEqual(q.calls, ['prove', 'prove']);
    assert.strictEqual(q.settle.length, 3, 'no settle was claimed');
  }
});

test('proveTurnEvery 0 turns the turn-taking off (settles first, always)', async () => {
  const q = queue({ settle: 6, prove: 1 });
  const pick = makeJobPicker({ confidentialJob: q.confidentialJob, proveTurnEvery: 0 });
  assert.deepStrictEqual(await drain(pick, 7), ['s1', 's2', 's3', 's4', 's5', 's6', 'p1']);
});

test('batched settles count toward the turn: a prove-only job is due after `proveTurnEvery` batches', async () => {
  const q = queue({ settle: 0, prove: 2 });
  const pick = makeJobPicker({ confidentialJob: q.confidentialJob, proveTurnEvery: 3 });
  for (let i = 0; i < 2; i++) { pick.settled(); assert.strictEqual(pick.proveDue(), false); }
  pick.settled();
  assert.strictEqual(pick.proveDue(), true);
  assert.strictEqual((await pick.proveTurn()).jobId, 'p1');
  assert.strictEqual(pick.proveDue(), false, 'the turn resets the count');
});

test('a prove-only job is due once `proveTurnSecs` pass while settles keep coming, whatever the count', async () => {
  let t = 0;
  const q = queue({ settle: 50, prove: 3 });
  const pick = makeJobPicker({ confidentialJob: q.confidentialJob, proveTurnEvery: 0, proveTurnSecs: 120, now: () => t });
  assert.strictEqual(pick.proveDue(), false, 'nothing is due at the start');
  pick.settled(); t += 119_000;
  assert.strictEqual(pick.proveDue(), false);
  t += 1_000;
  assert.strictEqual(pick.proveDue(), true, 'two minutes of settles: a prove-only turn');
  assert.strictEqual((await pick()).jobId, 'p1', 'and the picker gives it');
  assert.strictEqual(pick.proveDue(), false);
  t += 500_000;
  assert.strictEqual(pick.proveDue(), false, 'no settle since: nothing is waiting behind settles, so no turn is forced');
});

test('a due turn with no prove-only job waiting is spent, not asked for again every cycle', async () => {
  let t = 0;
  const q = queue({ settle: 0, prove: 0 });
  const pick = makeJobPicker({ confidentialJob: q.confidentialJob, proveTurnEvery: 0, proveTurnSecs: 60, now: () => t });
  pick.settled(); t = 61_000;
  assert.strictEqual(pick.proveDue(), true);
  assert.deepStrictEqual(await pick.proveTurn(), {});
  pick.settled();
  assert.strictEqual(pick.proveDue(), false);
  assert.deepStrictEqual(q.calls, ['prove']);
});

test('a missing client is refused', () => {
  assert.throws(() => makeJobPicker({}), /confidentialJob is required/);
});

test('a waiting swap holds the prove-only turn back until `proveHoldSecs` since the last, and then the turn comes', async () => {
  let t = 0; const now = () => t;
  const q = queue({ settle: 6, prove: 2 });
  const pick = makeJobPicker({ confidentialJob: q.confidentialJob, proveTurnEvery: 4, proveTurnSecs: 120, proveHoldSecs: 300, now });
  assert.deepStrictEqual(await drain(pick, 5, { pinned: true }), ['s1', 's2', 's3', 's4', 's5'], 'four settles are due a prove-only turn when nothing waits, not while a swap does');
  assert.strictEqual(pick.proveDue(), true, 'it is due as before for the unpinned rule');
  assert.strictEqual(pick.proveDue({ pinned: true }), false, 'but not while a swap waits');
  t = 200_000;
  assert.strictEqual(pick.proveDue({ pinned: true }), false, 'two minutes past the usual turn, still held for the swap');
  t = 300_000;
  assert.strictEqual(pick.proveDue({ pinned: true }), true, 'after proveHoldSecs the prove-only job is not starved');
  assert.strictEqual((await pick({ pinned: true }))?.jobId, 'p1');
  assert.strictEqual(pick.proveDue({ pinned: true }), false, 'its turn spent, the swap goes on first again');
});

test('proveHoldSecs 0: no prove-only turn at all while a swap waits, but the turn is as before when none does', async () => {
  let t = 0; const now = () => t;
  const q = queue({ settle: 8, prove: 1 });
  const pick = makeJobPicker({ confidentialJob: q.confidentialJob, proveTurnEvery: 2, proveTurnSecs: 60, now });
  t = 10 * 60_000;
  assert.deepStrictEqual(await drain(pick, 6, { pinned: true }), ['s1', 's2', 's3', 's4', 's5', 's6']);
  assert.strictEqual(pick.proveDue({ pinned: true }), false);
  assert.strictEqual(pick.proveDue(), true);
  assert.strictEqual((await pick())?.jobId, 'p1', 'with no swap waiting the turn comes');
});

test('a waiting swap does not make the picker take prove-only jobs when no settle is waiting, and an unpinned call is the old behavior', async () => {
  const q = queue({ settle: 0, prove: 2 });
  const pick = makeJobPicker({ confidentialJob: q.confidentialJob, proveHoldSecs: 300 });
  assert.deepStrictEqual(await drain(pick, 3, { pinned: true }), ['p1', 'p2', null], 'with no settle claimable the prove-only jobs go on, as always');
  const q2 = queue({ settle: 9, prove: 2 });
  const pick2 = makeJobPicker({ confidentialJob: q2.confidentialJob, proveTurnEvery: 3, proveHoldSecs: 300 });
  assert.deepStrictEqual(await drain(pick2, 5), ['s1', 's2', 's3', 'p1', 's4']);
});

test('settle-relay.js tells the picker when a swap waits, holds no company for it, and reads the hold from config', () => {
  const src = readFileSync(new URL('../worker-relay/src/settle-relay.js', import.meta.url), 'utf8');
  const cfg = readFileSync(new URL('../worker-relay/src/lib/config.js', import.meta.url), 'utf8');
  const cyc = src.slice(src.indexOf('async function cycle()'), src.indexOf('async function cycle()') + 3500);
  assert.match(src, /makeJobPicker\(\{[^}]*proveHoldSecs: CFG\.proveHoldSecs/, 'the picker gets the hold');
  assert.match(cfg, /proveHoldSecs: num\('PROVE_HOLD_SECS', 300\)/, 'five minutes by default');
  assert.match(cyc, /const pinned = Number\(q\?\.pendingPinned\) > 0;/, 'the queue says whether a swap waits');
  assert.match(cyc, /const gather = short \|\| pinned \? 0 : await gatherWait\(q\);/, 'a waiting swap is not held for company');
  assert.match(cyc, /pickJob\.proveDue\(\{ pinned \}\) \? await pickJob\.proveTurn\(\)/, 'the prove-only turn before a batch follows the same rule');
  assert.match(cyc, /await pickJob\(\{ short, gather, pinned \}\)/, 'and so does the pick');
});
