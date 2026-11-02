// Task rewards (src/lib/points-tasks.js, points-tasks-service.js and the store's task tables): the price of gas and of TAC, the
// reward, what a transaction completes, and when a credit may be applied. The whole package against a mainnet fork is in
// points-tasks-fork.test.mjs.
//   node worker-relay/tests/points-tasks.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, pad } from 'viem';
import { openStore } from '../src/lib/points-store.js';
import { fundingStatus } from '../src/lib/points-funding.js';
import { createTasks } from '../src/lib/points-tasks-service.js';
import {
  WAD, CREATEX, CONTRACT_CREATION, ASSET_REGISTERED, guardedSalt, slowGasPrice, tacPerEthAt, stepReward, stepsCompleted, checkJob, jobGas, holdReason,
} from '../src/lib/points-tasks.js';

const TAC = WAD;
const GWEI = 10n ** 9n;
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`;

// ── a step read by hand ──
{
  const hash = `0x${'ab'.repeat(32)}`, me = A(9), input = `0x${'cd'.repeat(32)}`;
  const step = { id: '01-role', kind: 'review', to: A(0), gas: 22000, approved: [hash], minWei: '60', maxWei: '60' };
  const reviewed = checkJob({ id: 'reviewed', chainId: 1, opensAt: 1, steps: [step] });
  const done = (tx) => stepsCompleted(reviewed, tx, { status: 'success', logs: [] }).map((d) => d.step.id);
  assert.deepEqual(done({ hash, from: me, to: me, input }), ['01-role'], 'the listed transaction, sent to itself and naming a Bitcoin transaction');
  assert.deepEqual(done({ hash: `0x${'ef'.repeat(32)}`, from: me, to: me, input }), [], 'a transaction not reviewed is nothing');
  assert.deepEqual(done({ hash, from: me, to: A(8), input }), [], 'nor one sent to another account');
  assert.deepEqual(done({ hash, from: me, to: me, input: '0x' }), [], 'nor one that names nothing');
  assert.deepEqual(stepsCompleted(reviewed, { hash, from: me, to: me, input }, { status: 'reverted', logs: [] }), [], 'nor a failed one');
  assert.throws(() => checkJob({ id: 'reviewed', chainId: 1, steps: [{ ...step, minWei: '10' }] }), /review fields/, 'a reviewed step pays one sum');
  assert.throws(() => checkJob({ id: 'reviewed', chainId: 1, steps: [{ ...step, approved: ['0x12'] }] }), /review fields/, 'and lists whole hashes');
  console.log('ok - a reviewed step is the listed transaction and nothing else');
}

// ── the price of gas ──
{
  const tx = (g) => ({ gasPrice: g });
  const block = { baseFeePerGas: 30n * GWEI, transactions: [tx(31n * GWEI), tx(31n * GWEI + 500_000_000n), tx(40n * GWEI), tx(60n * GWEI), tx(30n * GWEI), tx(33n * GWEI), tx(34n * GWEI), tx(35n * GWEI), tx(36n * GWEI), tx(37n * GWEI)] };
  assert.equal(slowGasPrice(block), 30n * GWEI + GWEI, 'the base fee plus the tenth percentile of the tips paid');
  assert.equal(slowGasPrice({ baseFeePerGas: 20n * GWEI, transactions: [] }), 20n * GWEI + 10_000_000n, 'a block nobody tipped in pays the floor');
  assert.equal(slowGasPrice({ baseFeePerGas: GWEI, transactions: ['0xhash', tx(GWEI + 5n * GWEI)] }, { pct: 0, cap: GWEI }), 2n * GWEI, 'a tip is held to the cap, and a hash-only transaction is skipped');
  assert.equal(slowGasPrice({ baseFeePerGas: GWEI, transactions: [tx(GWEI + 1n)] }), GWEI + 10_000_000n, 'a dust tip is lifted to the floor');
  console.log('ok - slow gas price: base fee plus a low percentile of tips, floored and capped');
}

// ── the price of TAC ──
{
  const q = (t, perEth) => ({ t, tacPerEth: BigInt(perEth) * TAC });
  const hour = [q(0, 10_000), q(600, 10_000), q(1200, 10_000), q(1800, 10_000), q(2400, 10_000)];
  assert.equal(tacPerEthAt(hour, 1250), 10_000n * TAC);
  assert.equal(tacPerEthAt([...hour, q(3000, 20_000)], 3000), 10_000n * TAC, 'a sudden dump of TAC (more per ETH) is held to the median');
  assert.equal(tacPerEthAt([...hour, q(3000, 5_000)], 3000), 5_000n * TAC, 'a rise in the TAC price pays less at once');
  assert.equal(tacPerEthAt(hour, 2400 + 7200 + 1), null, 'no sample within two hours prices nothing');
  assert.equal(tacPerEthAt(hour, 2400 + 7200), 10_000n * TAC, 'two hours exactly still does');
  assert.equal(tacPerEthAt([], 5), null);
  assert.equal(tacPerEthAt([q(100, 7_000), q(130, 9_000)], 120), 8_000n * TAC, 'the nearer sample (9,000) is held to the median of what came before it (8,000)');
  assert.equal(tacPerEthAt([q(100, 7_000), q(130, 9_000)], 105), 7_000n * TAC, 'and the nearer one can be the earlier');
  console.log('ok - TAC price: nearest sample, never above the six-hour median');
}

// ── the reward ──
{
  const gas = 31_160_000, p = { jobGas: gas, tacPerEth: 10_000n * TAC, tipBps: 10_000n, floorWei: 150n * TAC, capWei: 2_500n * TAC };
  const whole = (gasPriceWei) => stepReward({ ...p, gas, gasPriceWei });
  assert.equal(whole(66_000_000n), 150n * TAC, 'at 0.066 gwei the gas is ~21 TAC, doubled by the tip, so the floor pays');
  assert.equal(whole(GWEI), 623n * TAC + 20n * WAD / 100n, 'at 1 gwei: 311.6 TAC of gas, with a 100% tip');
  assert.equal(whole(100n * GWEI), 2_500n * TAC, 'a spike is capped');
  assert.equal(stepReward({ ...p, gas: gas / 2, gasPriceWei: GWEI }), 311n * TAC + 60n * WAD / 100n, 'half the gas, half the reward');
  assert.equal(stepReward({ ...p, gas: gas / 4, gasPriceWei: 66_000_000n }), 37n * TAC + 50n * WAD / 100n, 'a step takes its share of the floor');
  assert.equal(whole(GWEI) % (WAD / 100n), 0n, 'rounded down to 0.01 TAC');
  assert.equal(stepReward({ ...p, gas, gasPriceWei: GWEI, tipBps: 0n }), 311n * TAC + 60n * WAD / 100n, 'no tip is the gas alone');
  assert.throws(() => stepReward({ ...p, gas: gas + 1, gasPriceWei: GWEI }), /part of its job/);
  assert.throws(() => stepReward({ ...p, gas: 0, gasPriceWei: GWEI }), /part of its job/);
  console.log('ok - reward: gas in TAC with a tip, between the job\'s floor and cap, shared out by gas');
}

// ── what a transaction completes ──
const SALT = `0x${'00'.repeat(20)}01${'ab'.repeat(11)}`;
const EXPECTED = A(0x1234);
const job = checkJob({
  id: 'demo', chainId: 1, opensAt: 1000, steps: [
    { id: '01-a', kind: 'createx', to: CREATEX, gas: 1_000_000, expected: EXPECTED, salt: SALT, initCodeHash: `0x${'11'.repeat(32)}` },
    { id: '02-reg', kind: 'register', to: A(0x77), gas: 100_000, asset: `0x${'cc'.repeat(32)}` },
    { id: '03-pair', kind: 'pair', to: A(0x77), gas: 130_000, dataHash: keccak256('0xbbf9684c01') },
  ],
});
{
  const creation = { address: CREATEX, topics: [CONTRACT_CREATION, pad(EXPECTED, { size: 32 }), guardedSalt(1, SALT)], logIndex: 3 };
  const ok = (logs, tx = { from: A(9), to: CREATEX, input: '0x' }) => stepsCompleted(job, tx, { status: 'success', logs }).map((d) => d.step.id);
  assert.deepEqual(ok([creation]), ['01-a'], 'CreateX\'s log for the planned address and salt');
  assert.deepEqual(ok([{ ...creation, address: A(5) }]), [], 'the same log from another contract is nothing');
  assert.deepEqual(ok([{ ...creation, topics: [CONTRACT_CREATION, pad(A(0x1235), { size: 32 }), guardedSalt(1, SALT)] }]), [], 'another address is nothing');
  assert.deepEqual(ok([{ ...creation, topics: [CONTRACT_CREATION, pad(EXPECTED, { size: 32 }), guardedSalt(5, SALT)] }]), [], 'another chain\'s salt is nothing');
  assert.deepEqual(stepsCompleted(job, { from: A(9), input: '0x' }, { status: 'reverted', logs: [creation] }), [], 'a failed transaction is nothing');
  const reg = { address: A(0x77), topics: [ASSET_REGISTERED, `0x${'cc'.repeat(32)}`], logIndex: 0 };
  assert.deepEqual(ok([reg]), ['02-reg']);
  assert.deepEqual(ok([{ ...reg, topics: [ASSET_REGISTERED, `0x${'cd'.repeat(32)}`] }]), [], 'another asset');
  assert.deepEqual(ok([creation, reg]), ['01-a', '02-reg'], 'one transaction can complete several steps');
  assert.deepEqual(ok([], { from: A(9), to: A(0x77), input: '0xbbf9684c01' }), ['03-pair'], 'the planned call to the pool');
  assert.deepEqual(ok([], { from: A(9), to: A(0x78), input: '0xbbf9684c01' }), [], 'the same call to another contract');
  assert.deepEqual(ok([], { from: A(9), to: A(0x77), input: '0xbbf9684c02' }), [], 'other call data');
  assert.equal(jobGas(job), 1_230_000);
  assert.throws(() => checkJob({ ...job, steps: [{ ...job.steps[0], gas: 0 }] }), /gas/);
  assert.throws(() => checkJob({ ...job, steps: [job.steps[0], job.steps[0]] }), /step id/);
  assert.throws(() => checkJob({ ...job, steps: [{ ...job.steps[0], kind: 'other' }] }), /kind/);
  assert.throws(() => checkJob({ ...job, steps: [{ ...job.steps[0], salt: '0x12' }] }), /createx fields/);
  console.log('ok - a step is shown by its own log or call, from a successful transaction only');
}

// ── when a credit may wait ──
{
  const status = (extra) => fundingStatus({ heldWei: 8_000n * TAC, claimedWei: 0n, ledgerWei: 4_000n * TAC + extra, budgetFor: () => 1_111n * TAC, nextDay: 100, graceSecs: 1800 });
  const base = { wei: 100n * TAC, creditedWei: 0n, budgetWei: 1_000n * TAC, nowSec: 50, endSec: 100, status, reserveDays: 2 };
  assert.equal(holdReason(base), null);
  assert.equal(holdReason({ ...base, nowSec: 101 }), 'ended');
  assert.equal(holdReason({ ...base, endSec: 0 }), 'ended');
  assert.equal(holdReason({ ...base, creditedWei: 901n * TAC }), 'budget');
  assert.equal(holdReason({ ...base, creditedWei: 900n * TAC }), null, 'the budget is a ceiling on the total, reached exactly');
  assert.equal(holdReason({ ...base, wei: 1_778n * TAC, budgetWei: 5_000n * TAC }), null, '4,000 TAC of headroom less 1,778 still covers two 1,111 TAC days');
  assert.equal(holdReason({ ...base, wei: 1_779n * TAC, budgetWei: 5_000n * TAC }), 'funding', 'a credit that leaves under two days of the pot covered waits');
  assert.equal(holdReason({ ...base, status: () => null }), 'funding unread', 'an unreadable distributor is not read as funded');
  assert.equal(holdReason({ ...base, status: () => fundingStatus({ heldWei: 1n, claimedWei: 0n, ledgerWei: 5n, budgetFor: () => TAC, nextDay: 1, graceSecs: 0 }) }), 'funding', 'a ledger already past the funding');
  console.log('ok - a credit waits for the budget and for the funding to keep covering the regular pot');
}

// ── the store ──
const dir = mkdtempSync(join(tmpdir(), 'tasks-'));
try {
  const store = openStore(join(dir, 'points.db'));
  const claim = (id, address, wei) => ({ id, job: 'demo', step: id.split(':')[2], address, txHash: `0x${'ee'.repeat(32)}`, blockNumber: 5, blockTime: 2000, wei, quote: { gasPriceWei: '1' } });
  assert.equal(store.saveTaskClaim(claim('task:demo:01-a', `0x${'AB'.repeat(20)}`, 40n * TAC)), true);
  assert.equal(store.saveTaskClaim(claim('task:demo:01-a', `0x${'CD'.repeat(20)}`, 99n * TAC)), false, 'a step is claimed once, by whoever claims it first');
  assert.equal(store.taskClaim('task:demo:01-a').address, `0x${'ab'.repeat(20)}`);
  assert.equal(store.taskClaim('task:demo:01-a').wei, 40n * TAC);
  assert.deepEqual(store.pendingTaskClaims().map((c) => c.id), ['task:demo:01-a']);
  assert.equal(store.creditedWithPrefix('task:'), 0n, 'nothing is credited until it is');
  assert.equal(store.creditTaskClaim('task:demo:01-a'), true);
  assert.equal(store.creditTaskClaim('task:demo:01-a'), false, 'and then once');
  assert.equal(store.creditTaskClaim('task:demo:nope'), false);
  assert.equal(store.rewardFor(`0x${'ab'.repeat(20)}`), String(40n * TAC));
  assert.equal(store.creditedWithPrefix('task:'), 40n * TAC);
  assert.equal(store.pendingTaskClaims().length, 0);
  assert.equal(store.listAdjustments()[0].id, 'task:demo:01-a', 'a credit is an ordinary ledger adjustment');

  store.saveTaskQuote({ t: 100, venue: 'precision', tacPerEth: 5n, gasPrice: 7n }, 0);
  store.saveTaskQuote({ t: 200, venue: 'tacit-amm', tacPerEth: 6n, gasPrice: 8n }, 150);
  assert.deepEqual(store.taskQuotes(0, 1000).map((r) => r.t), [200], 'old samples are dropped');
  assert.equal(store.latestTaskQuote().venue, 'tacit-amm');
  console.log('ok - the store: a step is claimed once, credited once, as a ledger adjustment');

  // ── the service, with a chain that is a few objects ──
  const mk = (over = {}) => {
    const sent = { tx: { from: A(0xaa), to: CREATEX, input: '0x' }, receipt: { status: 'success', blockNumber: 100n, logs: [{ address: CREATEX, topics: [CONTRACT_CREATION, pad(EXPECTED, { size: 32 }), guardedSalt(1, SALT)], logIndex: 0 }] } };
    const client = {
      getChainId: async () => 1,
      getTransaction: async ({ hash }) => { if (hash !== `0x${'01'.repeat(32)}`) throw new Error('not found'); return sent.tx; },
      getTransactionReceipt: async ({ hash }) => { if (hash !== `0x${'01'.repeat(32)}`) throw new Error('not found'); return sent.receipt; },
      getBlockNumber: async () => over.head ?? 200n,
      getBlock: async () => ({ timestamp: 5000n, baseFeePerGas: 20n * GWEI, transactions: [] }),
    };
    const s2 = openStore(join(dir, `svc-${Math.random()}.db`));
    for (const t of [4000, 4500, 5000, 5500]) s2.saveTaskQuote({ t, venue: 'precision', tacPerEth: 10_000n * TAC, gasPrice: 20n * GWEI + 10_000_000n }, 0);
    let held = over.held ?? 50_000n * TAC;
    const tasks = createTasks({
      store: s2, jobs: [{ ...job, opensAt: over.opensAt ?? 1000 }], client, log: () => {}, quote: async (a) => [{ venue: 'precision', amountIn: a, amountOut: a * 10_000n }],
      cfg: { budgetWei: over.budget ?? 1_000n * TAC, endSec: over.endSec ?? 9_999_999_999, tipBps: 10_000n, floorWei: 150n * TAC, capWei: 2_500n * TAC, reserveDays: 2, confirmations: 12 },
      budgetFor: () => 1_111n * TAC, graceSecs: 1800, nowSec: () => over.now ?? 6000,
      fundingInputs: async () => ({ heldWei: held, claimedWei: 0n, nextDay: 100 }),
    });
    return { tasks, store: s2, setHeld: (v) => { held = v; }, hash: `0x${'01'.repeat(32)}` };
  };
  const one = (r) => r.body.results[0];

  {
    const { tasks, store: s, hash } = mk();
    const r = one(await tasks.claim({ txHashes: [hash] }, { client: 'x' }));
    assert.equal(r.status, 'ok');
    assert.equal(r.steps[0].address, A(0xaa), 'credited to the sender');
    assert.equal(r.steps[0].status, 'queued');
    // 1,000,000 gas of a 1,230,000 job at 20.01 gwei: 0.02001 ETH, 200.1 TAC, doubled to 400.2, within the floor and cap shares
    assert.equal(BigInt(r.steps[0].wei), 400n * TAC + 20n * WAD / 100n);
    assert.equal(s.creditedWithPrefix('task:'), 0n);
    await tasks.cycle();
    assert.equal(s.creditedWithPrefix('task:'), 400n * TAC + 20n * WAD / 100n);
    assert.equal(s.rewardFor(A(0xaa)), String(400n * TAC + 20n * WAD / 100n));
    console.log('ok - a claim is priced at its block and credited on the next cycle');
  }
  {
    const { tasks, hash } = mk({ head: 105n });
    assert.deepEqual([one(await tasks.claim({ txHashes: [hash] }, { client: 'x' })).status, one(await tasks.claim({ txHashes: [hash] }, { client: 'x' })).confirmationsLeft], ['confirming', 6]);
    const { tasks: t2 } = mk({ opensAt: 6000 });
    assert.equal(one(await t2.claim({ txHashes: [`0x${'01'.repeat(32)}`] }, { client: 'y' })).steps[0].status, 'not open', 'a step mined before the job opened earns nothing');
    const { tasks: t3 } = mk({ opensAt: 0 });
    assert.equal(one(await t3.claim({ txHashes: [`0x${'01'.repeat(32)}`] }, { client: 'z' })).steps[0].status, 'not open', 'a job with no opening time is closed');
    const { tasks: t4 } = mk({ endSec: 5999 });
    assert.equal(one(await t4.claim({ txHashes: [`0x${'01'.repeat(32)}`] }, { client: 'w' })).steps[0].status, 'ended', 'nothing is claimed after the end');
    assert.equal(one(await t4.claim({ txHashes: [`0x${'02'.repeat(32)}`] }, { client: 'w' })).status, 'not found');
    assert.equal((await t4.claim({ txHashes: ['0x12'] }, { client: 'w' })).status, 400);
    assert.equal((await t4.claim({}, { client: 'w' })).status, 400);
    assert.equal((await t4.claim({ txHashes: Array(26).fill(`0x${'01'.repeat(32)}`) }, { client: 'w' })).status, 400);
    console.log('ok - confirmations, the opening time, the end and bad input are refused');
  }
  {
    const { tasks, store: s, setHeld, hash } = mk({ held: 2_600n * TAC });
    await tasks.claim({ txHashes: [hash] }, { client: 'x' });
    await tasks.cycle();
    assert.equal(s.creditedWithPrefix('task:'), 0n, 'with less than two days of the pot to spare the credit waits');
    assert.equal(s.pendingTaskClaims().length, 1, 'and is kept');
    setHeld(2_700n * TAC);
    await tasks.cycle();
    assert.equal(s.creditedWithPrefix('task:'), 400n * TAC + 20n * WAD / 100n, 'a top-up releases it');
    console.log('ok - a credit that would leave the pot short waits for the top-up');
  }
  {
    const { tasks, store: s, hash } = mk({ budget: 100n * TAC });
    await tasks.claim({ txHashes: [hash] }, { client: 'x' });
    await tasks.cycle();
    assert.equal(s.creditedWithPrefix('task:'), 0n, 'a credit over the tasks budget waits');
    assert.equal(s.pendingTaskClaims().length, 1);
    const v = tasks.view();
    assert.equal(v.budget.remainingWei, '0', 'and counts against what is left of it');
    console.log('ok - the tasks budget is a ceiling');
  }
  {
    const off = createTasks({ store, jobs: [job], client: {}, quote: async () => [], cfg: { budgetWei: 0n, endSec: 5 }, fundingInputs: async () => null, budgetFor: () => 0n });
    assert.equal(off.enabled, false);
    assert.deepEqual(off.view(), { enabled: false });
    assert.equal((await off.claim({ txHashes: [`0x${'01'.repeat(32)}`] })).status, 404);
    await off.cycle();
    console.log('ok - with no budget the whole thing is off');
  }
  // the committed job files agree
  const service = JSON.parse(readFileSync(new URL('../src/lib/points-tasks-jobs.json', import.meta.url), 'utf8'));
  const page = JSON.parse(readFileSync(new URL('../../dapp/tasks/jobs.json', import.meta.url), 'utf8'));
  service.jobs.forEach(checkJob);
  for (const sj of service.jobs) {
    const pj = page.jobs.find((j) => j.id === sj.id);
    assert.ok(pj, `${sj.id} is on the page`);
    assert.equal(pj.opensAt, sj.opensAt);
    assert.deepEqual(pj.steps.map(({ id, chainId, kind, to, gas, expected, salt, bound, initCodeHash, asset, dataHash, poolId, minSize, minWei, maxWei }) => ({ id, chainId, kind, to, gas, expected, salt, bound, initCodeHash, asset, dataHash, poolId, minSize, minWei, maxWei })),
      sj.steps.map(({ id, chainId, kind, to, gas, expected, salt, bound, initCodeHash, asset, dataHash, poolId, minSize, minWei, maxWei }) => ({ id, chainId, kind, to, gas, expected, salt, bound, initCodeHash, asset, dataHash, poolId, minSize, minWei, maxWei })), 'the page and the service state the same steps');
  }
  console.log('ok - the service and the page state the same steps');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
