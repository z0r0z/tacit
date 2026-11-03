// Proof mining as the points service pays it (src/lib/points-mine-service.js), fed by the API's own proof pool (worker/src/proof-pool.js)
// on a fake KV: miners prove wraps there on a day, and once that day is over (and the settle grace has passed) the campaign reads the day's
// tally, shares the day's amount by points under the cap and credits each miner once, as ledger adjustments from its own pocket. Every
// reason a credit waits (the API unreadable or the day not over there, the pocket, the distributor's funding) holds the day, never drops it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { parseLpSchedule, WAD } from '../src/lib/points-lp.js';
import { createMine, readTally, mergeTallies, allocateMineDay, dayId, CREDIT_PREFIX } from '../src/lib/points-mine-service.js';
import { makeProofPool, wrapExpect, readWrapStdin, PROOF_POOL } from '../../worker/src/proof-pool.js';
import { makeProverBoard, PROVER_BOARD } from '../../worker/src/prover-board.js';
import { stdinFor } from '../../dapp/sp1-stdin.js';

const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222';
const tac = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const DAY = 86400, D0 = 20800, T = (day, hour = 0) => day * DAY + hour * 3600;
const WRAP_OP = JSON.parse(readFileSync(new URL('../../tests/fixtures/sp1-stdin/wrap.op.json', import.meta.url), 'utf8'));

test('the rules: a tally is read only for its own day once the API calls it over; a day\'s amount is shared by points under the cap', () => {
  const body = { day: D0, over: true, pointsPerProof: 20, miners: [{ miner: B, proofs: 1, points: 20 }, { miner: A.toUpperCase().replace('0X', '0x'), proofs: 3, points: 40 }, { miner: '0x' + '33'.repeat(20), proofs: 1, points: 0 }] };
  assert.deepEqual(readTally(body, D0), [{ miner: A, proofs: 3, points: 40 }, { miner: B, proofs: 1, points: 20 }]);
  assert.throws(() => readTally(body, D0 + 1), /another day/);
  assert.throws(() => readTally({ ...body, over: false }, D0), /not over/);
  assert.throws(() => readTally({ ...body, miners: [{ miner: A, points: 1 }, { miner: A, points: 2 }] }, D0), /twice/);
  assert.throws(() => readTally({ ...body, miners: [{ miner: A, points: 1.5 }] }, D0), /points/);
  assert.throws(() => readTally({ ...body, miners: [{ miner: 'me', points: 1 }] }, D0), /not an address/);
  const tally = readTally(body, D0);
  // A quiet day: each point at the cap, the rest stays in the pocket.
  assert.deepEqual(allocateMineDay({ tally, dailyWei: tac(10), capWeiPerPoint: tac(0.05) }), [{ address: A, wei: tac(2) }, { address: B, wei: tac(1) }]);
  // A busy day: the amount shared by points, rounded down.
  assert.deepEqual(allocateMineDay({ tally, dailyWei: tac(1.5), capWeiPerPoint: tac(0.05) }), [{ address: A, wei: tac(1) }, { address: B, wei: tac(0.5) }]);
  assert.deepEqual(allocateMineDay({ tally: [], dailyWei: tac(10), capWeiPerPoint: tac(0.05) }), []);
});

// The API's proof pool and prover board and the campaign on one clock (seconds), the campaign reading the pool's /prover/pool/credits
// answer, and the board's /prover/board/credits when it is given that feed too.
function world(over = {}) {
  const clock = { t: T(D0, 1) }, dir = mkdtempSync(join(tmpdir(), 'mine-')), said = [], m = new Map();
  const kv = { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
  const pool = makeProofPool({ kv, cfg: { ...PROOF_POOL, proofsPerMinerDay: 2 }, now: () => clock.t * 1000, verify: async () => ({ ok: true }) });
  const days = new Map(), bw = {}, jobs = new Map(); let pend = [];
  const board = makeProverBoard({ now: () => clock.t * 1000, cfg: { ...PROVER_BOARD, proofsPerMinerDay: 2 }, storage: {
    getPending: async () => pend.slice(), putPending: async (ids) => { pend = ids.slice(); }, getJob: async (id) => (jobs.has(id) ? JSON.parse(jobs.get(id)) : null), putJob: async (id, j) => { jobs.set(id, JSON.stringify(j)); },
    getWorkers: async () => JSON.parse(JSON.stringify(bw)), putWorkers: async (w) => { Object.assign(bw, w); }, getDay: async (d) => (days.has(d) ? JSON.parse(days.get(d)) : null), putDay: async (d, r) => { days.set(d, JSON.stringify(r)); } } });
  const feed = { down: false, boardDown: false, asked: [] };
  const fetchJson = async (url) => {
    feed.asked.push(url);
    const u = new URL(url), onBoard = u.pathname === '/prover/board/credits';
    if (feed.down || (onBoard && feed.boardDown)) throw new Error('api.tacit.finance answered 502');
    const r = await (onBoard ? board : pool).credits(Number(u.searchParams.get('day')));
    if (r.status !== 200) throw new Error(`answered ${r.status}`);
    return JSON.parse(JSON.stringify(r.body));
  };
  const store = openStore(join(dir, 'points.db'));
  const s = createMine({
    store, fetchJson, budgetFor: () => 1111n * WAD, graceSecs: 1800, nowSec: () => clock.t, log: (...x) => said.push(x.join(' ')),
    fundingInputs: over.fundingInputs ?? (async () => ({ heldWei: 100_000n * WAD, claimedWei: 0n, nextDay: D0 + 1 })),
    cfg: { schedule: parseLpSchedule(`${D0}:daily=10,cap=0.05`), feedUrl: 'https://api.tacit.finance/prover/pool/credits', pocketWei: 500n * WAD, endSec: T(D0 + 60), ...over.cfg },
  });
  let n = 0;
  // A page asks for a wrap and `miner` proves it.
  const prove = async (miner) => {
    const bytes = stdinFor('wrap', { ...WRAP_OP, value: String(1500 + ++n) }), e = wrapExpect(readWrapStdin(bytes));
    await pool.request({ type: 'wrap', stdin: '0x' + Buffer.from(bytes).toString('hex'), expect: e, client: `page${n}` });
    const l = (await pool.lease({ miner, client: miner })).body;
    const w = (x) => BigInt(x).toString(16).padStart(64, '0'), head = Array.from({ length: 32 }, () => w(0));
    head[0] = w(32); head[2] = e.chainBinding.slice(2); head[28] = e.memoRoot.slice(2); head[5] = w(31 * 32); head[6] = w(33 * 32);
    const pv = '0x' + head.join('') + w(1) + e.leaf.slice(2) + w(1) + e.depositId.slice(2);
    return (await pool.submit({ id: l.id, lease: l.lease, publicValues: pv, proof: '0x' + 'ab'.repeat(260) })).body;
  };
  // A community machine's proof of a public board job, which the relay takes.
  const race = async (miner) => {
    const c = { name: `c-${miner}`, classes: ['public'], community: true };
    const p = await board.post({ class: 'public', stdin: Buffer.from(`board ${++n}`).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: clock.t + 600 });
    await board.claim({ worker: c, classes: ['public'] });
    await board.result({ worker: c, jobId: p.jobId, publicValues: '0x' + '55'.repeat(64), proof: '0x' + '66'.repeat(260) });
    return board.raceVerdict({ jobId: p.jobId, worker: c.name, ok: true });
  };
  const credits = () => store.listAdjustments().filter((a) => a.id.startsWith(CREDIT_PREFIX)).map((a) => ({ id: a.id, address: a.address, wei: BigInt(a.wei) }));
  return { s, store, clock, said, feed, prove, race, credits, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a day: proofs that passed at the API are paid once the day is over, once, by points under the cap; the day keeps its record', async () => {
  const { s, clock, said, feed, prove, credits, done } = world();
  try {
    assert.deepEqual(await prove(A), { ok: true, points: 20 });
    assert.deepEqual(await prove(A), { ok: true, points: 20 });
    assert.deepEqual(await prove(A), { ok: true, points: 0 }, 'past the API\'s daily cap: kept, not credited');
    assert.deepEqual(await prove(B), { ok: true, points: 20 });
    await s.cycle();
    assert.equal(feed.asked.length, 0, 'the day is not over: nothing is asked');
    clock.t = T(D0 + 1) + 1799;
    await s.cycle();
    assert.equal(feed.asked.length, 0, 'nor within the grace');
    clock.t = T(D0 + 1) + 1800;
    await s.cycle();
    assert.deepEqual(credits(), [{ id: dayId(D0, A), address: A, wei: tac(2) }, { id: dayId(D0, B), address: B, wei: tac(1) }]);
    assert.ok(said.some((x) => x.includes(`mining day ${D0}`)));
    await s.cycle(); clock.t += DAY; await s.cycle();
    assert.equal(credits().length, 2, 'a paid day is never paid again; a day with no proofs pays nothing');
    const kept = s.dayRecord(D0);
    assert.match(kept.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(kept.record.tally, [{ miner: A, proofs: 3, points: 40 }, { miner: B, proofs: 1, points: 20 }]);
    assert.deepEqual(kept.record.terms, { dailyWei: String(tac(10)), capWeiPerPoint: String(tac(0.05)) });
    const v = s.view({ address: A });
    assert.deepEqual(v.pocket, { totalWei: String(500n * WAD), creditedWei: String(tac(3)), remainingWei: String(500n * WAD - tac(3)) });
    assert.deepEqual(v.account, { address: A, creditedWei: String(tac(2)) });
    assert.equal(v.lastPaidDay, D0 + 1);
    assert.equal(s.credited(), tac(3));
  } finally { done(); }
});

test('waits: the API unreadable, the pocket, the distributor\'s funding; each holds the day and pays it in full once it clears', async () => {
  let held = 100_000n * WAD;
  const { s, clock, said, feed, prove, credits, done } = world({ cfg: { pocketWei: tac(1.5) }, fundingInputs: async () => ({ heldWei: held, claimedWei: 0n, nextDay: D0 + 1 }) });
  try {
    await prove(A); await prove(B);
    await s.cycle();                          // running through the day, as the service does (it pays from the day it started)
    clock.t = T(D0 + 1, 1);
    feed.down = true;
    await s.cycle();
    assert.deepEqual(credits(), []);
    assert.ok(said.some((x) => /wait: feed/.test(x)));
    feed.down = false;
    await s.cycle();
    assert.deepEqual(credits(), [], 'the day would pay 2 TAC from a pocket of 1.5: it waits whole, never in part');
    assert.ok(said.some((x) => /wait: pocket/.test(x)));
    held = 1111n * WAD;                       // one day of the regular pot covered: under the two the campaign leaves
    const again = world({ fundingInputs: async () => ({ heldWei: held, claimedWei: 0n, nextDay: D0 + 1 }) });
    try {
      await again.prove(A);
      await again.s.cycle();
      again.clock.t = T(D0 + 1, 1);
      await again.s.cycle();
      assert.deepEqual(again.credits(), []);
      assert.ok(again.said.some((x) => /wait: funding/.test(x)));
      held = 100_000n * WAD;
      await again.s.cycle();
      assert.deepEqual(again.credits(), [{ id: dayId(D0, A), address: A, wei: tac(1) }]);
    } finally { again.done(); }
  } finally { done(); }
});

test('two feeds: the pool\'s and the board\'s tallies for a day are summed per address, each under its own cap; one unreadable holds the day', async () => {
  const POOL = 'https://api.tacit.finance/prover/pool/credits', BOARD = 'https://api.tacit.finance/prover/board/credits';
  assert.deepEqual(mergeTallies([[{ miner: A, proofs: 1, points: 20 }], [{ miner: A, proofs: 2, points: 40 }, { miner: B, proofs: 1, points: 20 }]]),
    [{ miner: A, proofs: 3, points: 60 }, { miner: B, proofs: 1, points: 20 }]);
  const { s, clock, said, feed, prove, race, credits, done } = world({ cfg: { feedUrl: [POOL, BOARD] } });
  try {
    await prove(A); await prove(A); await prove(A);      // the pool: 40 points (its cap is two proofs)
    await race(A); await race(A); await race(A);         // the board: 40 more, under its own cap
    await race(B);                                       // B proves on the board only
    await s.cycle();
    clock.t = T(D0 + 1, 1);
    feed.boardDown = true;
    await s.cycle();
    assert.deepEqual(credits(), [], 'the board unreadable: the day waits, the pool\'s half is not paid alone');
    assert.ok(said.some((x) => /wait: feed/.test(x)));
    feed.boardDown = false;
    await s.cycle();
    assert.deepEqual(credits(), [{ id: dayId(D0, A), address: A, wei: tac(4) }, { id: dayId(D0, B), address: B, wei: tac(1) }]);
    const kept = s.dayRecord(D0).record;
    assert.deepEqual(kept.tally, [{ miner: A, proofs: 6, points: 80 }, { miner: B, proofs: 1, points: 20 }]);
    assert.deepEqual(kept.feed, [POOL, BOARD]);
    assert.ok(feed.asked.includes(`${BOARD}?day=${D0}`) && feed.asked.includes(`${POOL}?day=${D0}`));
  } finally { done(); }
});

test('off unless a feed, a schedule, a pocket and an end are all set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mine-off-'));
  try {
    const store = openStore(join(dir, 'points.db'));
    const base = { store, fetchJson: async () => { throw new Error('never'); }, fundingInputs: async () => null, budgetFor: () => 0n };
    const cfg = { schedule: parseLpSchedule(`${D0}:daily=10,cap=0.05`), feedUrl: 'https://x/prover/pool/credits', pocketWei: 1n, endSec: T(D0 + 1) };
    assert.equal(createMine({ ...base, cfg }).enabled, true);
    for (const k of ['schedule', 'feedUrl', 'pocketWei', 'endSec']) {
      const off = createMine({ ...base, cfg: { ...cfg, [k]: k === 'schedule' ? [] : k === 'pocketWei' ? 0n : k === 'endSec' ? 0 : '' } });
      assert.equal(off.enabled, false, `without ${k}`);
      assert.deepEqual(off.view(), { enabled: false });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
