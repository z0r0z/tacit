// A reviewed task step is approved at run time: one authenticated call, no push and no deploy, and the service names the claim itself.
//   node worker-relay/tests/tasks-approve.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/lib/points-store.js';
import { createTasks, adminKeyOk } from '../src/lib/points-tasks-service.js';
import { checkJob, stepsCompleted, evidenceText } from '../src/lib/points-tasks.js';

const TAC = 10n ** 18n, GWEI = 10n ** 9n;
const textInput = (s) => `0x${Buffer.from(s, 'latin1').toString('hex').padEnd(64, '0')}`;
const me = '0x7a719d6f9c478f85de6cdfbcfd80ec09bf2a116b';
const STEP = { id: '01-filer', kind: 'review', to: '0x0000000000000000000000000000000000000000', gas: 22000, approved: [], minWei: String(100n * TAC), maxWei: String(100n * TAC), evidence: { text: true, pattern: '^CL[0-9]{3,}$' } };
const JOB = { id: 'cg', chainId: 1, opensAt: 1000, steps: [STEP] };
const H = (n) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;

// ── the key ──
{
  const key = 'k'.repeat(40);
  assert.equal(adminKeyOk(`Bearer ${key}`, key), true);
  assert.equal(adminKeyOk(`Bearer ${key}x`, key), false, 'a longer guess');
  assert.equal(adminKeyOk(`Bearer ${key.slice(0, -1)}`, key), false, 'a shorter one');
  assert.equal(adminKeyOk(key, key), false, 'no Bearer');
  assert.equal(adminKeyOk(undefined, key), false, 'no header');
  assert.equal(adminKeyOk('Bearer short', 'short'), false, 'a key under 32 characters is no key');
  assert.equal(adminKeyOk('Bearer ', ''), false, 'and an unset one never opens the route');
  console.log('ok - the admin key: exact, 32 characters at least, nothing without one');
}

// ── what a claim must name ──
{
  assert.equal(evidenceText(textInput('CL1811260010')), 'CL1811260010');
  assert.equal(evidenceText(`0x${'ab'.repeat(32)}`).length, 32, 'with no zero byte the whole thing is the text');
  const hash = H(0xaa);
  const job = checkJob({ ...JOB, steps: [{ ...STEP, approved: [hash] }] });
  const ok = { status: 'success', logs: [] };
  const claim = (input, over = {}) => stepsCompleted(job, { hash, from: me, to: me, input, ...over }, ok).map((d) => d.step.id);
  assert.deepEqual(claim(textInput('CL1811260010')), ['01-filer'], 'an id that looks like CoinGecko\'s');
  assert.deepEqual(claim(textInput('cl1811260010')), [], 'in capitals');
  assert.deepEqual(claim(textInput('hello')), [], 'not any text');
  assert.deepEqual(claim(`0x${'ab'.repeat(32)}`), [], 'nor a transaction id');
  const loose = checkJob({ ...JOB, steps: [{ ...STEP, evidence: undefined, approved: [hash] }] });
  assert.deepEqual(stepsCompleted(loose, { hash, from: me, to: me, input: `0x${'ab'.repeat(32)}` }, ok).map((d) => d.step.id), ['01-filer'], 'a step with no evidence takes any 32 bytes, as before');
  assert.throws(() => checkJob({ ...JOB, steps: [{ ...STEP, evidence: { text: false, pattern: '^a$' } }] }), /evidence/);
  assert.throws(() => checkJob({ ...JOB, steps: [{ ...STEP, evidence: { text: true, pattern: '(' } }] }), /evidence/, 'a pattern that is not one');
  assert.throws(() => checkJob({ ...JOB, steps: [{ ...STEP, evidence: { text: true } }] }), /evidence/);
  const shipped = JSON.parse(readFileSync(new URL('../src/lib/points-tasks-jobs.json', import.meta.url), 'utf8')).jobs.map(checkJob);
  assert.ok(shipped.find((j) => j.id === 'coingecko-listing').steps[0].evidence, 'the CoinGecko job asks for an id');
  console.log('ok - a step may ask for an id of a given shape, and the shipped job does');
}

// ── the service ──
const dir = mkdtempSync(join(tmpdir(), 'tasks-approve-'));
try {
  const mk = (over = {}) => {
    const input = over.input ?? textInput('CL1811260010');
    const client = {
      getChainId: async () => 1,
      getTransaction: async ({ hash }) => { if (!(over.hashes ?? [H(1)]).includes(hash)) throw new Error('not found'); return { hash, from: over.from ?? me, to: over.from ?? me, input }; },
      getTransactionReceipt: async ({ hash }) => { if (!(over.hashes ?? [H(1)]).includes(hash)) throw new Error('not found'); return { status: 'success', blockNumber: 100n, logs: [] }; },
      getBlockNumber: async () => state.head,
      getBlock: async () => ({ timestamp: 5000n, baseFeePerGas: 20n * GWEI, transactions: [] }),
    };
    const state = { head: over.head ?? 200n };
    const store = over.store ?? openStore(join(dir, `svc-${Math.random()}.db`));
    for (const t of [4000, 4500, 5000, 5500]) store.saveTaskQuote({ t, venue: 'precision', tacPerEth: 10_000n * TAC, gasPrice: 20n * GWEI + 10_000_000n }, 0);
    const tasks = createTasks({
      store, jobs: [checkJob(JSON.parse(JSON.stringify(JOB)))], client, log: () => {}, quote: async (a) => [{ venue: 'precision', amountIn: a, amountOut: a * 10_000n }],
      cfg: { budgetWei: over.budget ?? 1_000n * TAC, endSec: 9_999_999_999, tipBps: 10_000n, floorWei: 150n * TAC, capWei: 2_500n * TAC, reserveDays: 2, confirmations: 12 },
      budgetFor: () => 1_111n * TAC, graceSecs: 1800, nowSec: () => 6000,
      fundingInputs: async () => ({ heldWei: 50_000n * TAC, claimedWei: 0n, nextDay: 100 }),
    });
    return { tasks, store, state };
  };
  const one = (r) => r.body.results[0];
  const body = (txHash, over = {}) => ({ job: 'cg', step: '01-filer', txHash, ...over });

  {
    const { tasks, store } = mk();
    assert.equal(one(await tasks.claim({ txHashes: [H(1)] }, { client: 'x' })).status, 'no step', 'a claim nobody has approved is nothing');
    const r = await tasks.approve(body(H(1)), { client: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.steps[0].status, 'queued', 'approving names the claim at once');
    assert.equal(r.body.result.steps[0].address, me, 'for the account that sent it');
    assert.equal(BigInt(r.body.result.steps[0].wei), 100n * TAC, 'the step\'s fixed sum');
    assert.equal(store.creditedWithPrefix('task:'), 0n);
    await tasks.cycle();
    assert.equal(store.creditedWithPrefix('task:'), 100n * TAC, 'and the next cycle credits it');
    assert.equal(store.rewardFor(me), String(100n * TAC));
    console.log('ok - approving a claim names it and the next cycle credits it');
  }
  {
    const { tasks, store } = mk({ hashes: [H(1), H(2)], from: me });
    await tasks.approve(body(H(1)), { client: 'admin' });
    const again = await tasks.approve(body(H(2)), { client: 'admin' });
    assert.equal(again.status, 409, 'a step pays once, whoever is approved next');
    assert.equal(store.pendingTaskClaims().length, 1);
    console.log('ok - a second approval for a claimed step is refused');
  }
  {
    const { tasks, store } = mk({ input: textInput('hello') });
    const r = await tasks.approve(body(H(1)), { client: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.status, 'no step', 'an approval cannot make a claim of the wrong shape count');
    await tasks.cycle();
    assert.equal(store.creditedWithPrefix('task:'), 0n);
    console.log('ok - an approval does not override what the step asks of a claim');
  }
  {
    const { tasks, store, state } = mk({ head: 105n });
    const r = await tasks.approve(body(H(1)), { client: 'admin' });
    assert.equal(r.body.result.status, 'confirming', 'approved before it is twelve blocks deep');
    assert.equal(store.pendingTaskClaims().length, 0);
    state.head = 200n;
    await tasks.cycle();
    assert.equal(store.creditedWithPrefix('task:'), 100n * TAC, 'the service names it itself once it is, with no second call');
    console.log('ok - an approval that could not be named yet is named on a later cycle');
  }
  {
    const first = mk();
    await first.tasks.approve(body(H(1)), { client: 'admin' });
    const second = mk({ store: openStore(join(dir, `svc-keep.db`)) });
    await second.tasks.approve(body(H(1), {}), { client: 'admin' });
    const restarted = createTasks({ store: second.store, jobs: [checkJob(JSON.parse(JSON.stringify(JOB)))], client: { getChainId: async () => 1 }, quote: async () => [], cfg: { budgetWei: 1_000n * TAC, endSec: 9_999_999_999, tipBps: 10_000n, floorWei: 150n * TAC, capWei: 2_500n * TAC }, fundingInputs: async () => null, budgetFor: () => 0n });
    assert.deepEqual(JSON.parse(second.store.getMeta('tasks.approvals')), { 'cg/01-filer': [H(1)] }, 'kept in the store');
    assert.equal(restarted.enabled, true);
    console.log('ok - approvals are kept in the store, so a restart does not lose them');
  }
  {
    const { tasks } = mk();
    for (const bad of [{ job: 'nope', step: '01-filer', txHash: H(1) }, { job: 'cg', step: 'nope', txHash: H(1) }, { job: 'cg', step: '01-filer', txHash: '0x12' }, { job: 'cg', step: '01-filer', txHash: H(1), chainId: 999 }, {}, null]) {
      assert.equal((await tasks.approve(bad, { client: 'admin' })).status, 400, `refuses ${JSON.stringify(bad)}`);
    }
    const off = createTasks({ store: openStore(join(dir, 'off.db')), jobs: [checkJob(JSON.parse(JSON.stringify(JOB)))], client: {}, quote: async () => [], cfg: { budgetWei: 0n, endSec: 5 }, fundingInputs: async () => null, budgetFor: () => 0n });
    assert.equal((await off.approve(body(H(1)), {})).status, 404, 'nothing with tasks off');
    const flood = mk();
    await flood.tasks.approve(body(H(1)), { client: 'bot' });
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await flood.tasks.approve(body(H(1)), { client: 'bot' })).status);
    assert.ok(codes.includes(429), 'a flood is slowed');
    console.log('ok - bad input, a disabled service and a flood are refused');
  }
  {
    // A transaction listed in the job file still works as before, with no runtime approval.
    const listed = { ...JOB, steps: [{ ...STEP, approved: [H(1)] }] };
    const store = openStore(join(dir, 'listed.db'));
    for (const t of [4000, 4500, 5000, 5500]) store.saveTaskQuote({ t, venue: 'precision', tacPerEth: 10_000n * TAC, gasPrice: 20n * GWEI + 10_000_000n }, 0);
    const client = { getChainId: async () => 1, getTransaction: async () => ({ hash: H(1), from: me, to: me, input: textInput('CL1811260010') }), getTransactionReceipt: async () => ({ status: 'success', blockNumber: 100n, logs: [] }), getBlockNumber: async () => 200n, getBlock: async () => ({ timestamp: 5000n, baseFeePerGas: 20n * GWEI, transactions: [] }) };
    const tasks = createTasks({ store, jobs: [checkJob(listed)], client, log: () => {}, quote: async (a) => [{ venue: 'precision', amountIn: a, amountOut: a * 10_000n }], cfg: { budgetWei: 1_000n * TAC, endSec: 9_999_999_999, tipBps: 10_000n, floorWei: 150n * TAC, capWei: 2_500n * TAC, reserveDays: 2, confirmations: 12 }, budgetFor: () => 1_111n * TAC, graceSecs: 1800, nowSec: () => 6000, fundingInputs: async () => ({ heldWei: 50_000n * TAC, claimedWei: 0n, nextDay: 100 }) });
    assert.equal(one(await tasks.claim({ txHashes: [H(1)] }, { client: 'x' })).steps[0].status, 'queued');
    console.log('ok - a hash listed in the job file is claimed as before');
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
