// worker-relay/src/lib/job-picker.js: the settle relay takes relayed settles before prove-only jobs, and still gives prove-only jobs a turn.
//   node --test tests/job-picker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
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
