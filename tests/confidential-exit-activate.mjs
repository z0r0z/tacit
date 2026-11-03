#!/usr/bin/env node
// Relayed L2 exit activation: the settle queue carrying an exit recipe (worker/src/confidential-settle.js) and the
// relay's pure checks before it pays for activateExit (worker-relay/src/lib/exit-activate.js).
//
// Run: node tests/confidential-exit-activate.mjs

import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { encodeFunctionData } from '../worker-relay/node_modules/viem/_esm/index.js';
import { makeConfidentialSettler } from '../worker/src/confidential-settle.js';
import { ROUTER_EXIT_ABI, recipeArgs, exitCheck, activationCover, pvWithdrawals } from '../worker-relay/src/lib/exit-activate.js';

const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
const now = () => 1000;
const instantSleep = () => Promise.resolve();
function freshStore() {
  const jobs = new Map(); let pending = [];
  return {
    getPending: async () => pending.slice(),
    putPending: async (ids) => { pending = ids.slice(); },
    getJob: async (id) => (jobs.has(id) ? JSON.parse(JSON.stringify(jobs.get(id))) : null),
    putJob: async (id, job) => { jobs.set(id, JSON.parse(JSON.stringify(job))); },
  };
}
const settler = () => makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const ETH_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const ZERO = '0x0000000000000000000000000000000000000000';
const ESCROW = '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e';
const RECIPE = {
  exitedAsset: ETH_ID, feeAsset: ZERO, finalRecipient: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
  deadline: '1900000000', nonce: '77',
  calls: [{ target: '0x3154Cf16ccdb4C6d922629664174b904d80F2C35', value: '990000000000000', token: ZERO, amount: '0', push: false,
    data: '0x9a2ac6d5' + '00'.repeat(96) }],
  sweepTokens: [ZERO], minOuts: ['0'],
};
const unwrapOp = (over = {}) => ({ chainBinding: '0xcb', spendRoot: '0xroot', asset: ETH_ID, recipient: ESCROW, value: '1000000', fee: '20000', ...over });
const TX = (b) => '0x' + b.repeat(32);

// ───────────────── queue ─────────────────
{
  const q = settler();
  const { jobId } = await q.submitJob({ type: 'unwrap', op: unwrapOp(), memos: [], exit: RECIPE });
  const job = await q.nextJob();
  assert.strictEqual(job.jobId, jobId);
  assert.strictEqual(job.exit.finalRecipient, RECIPE.finalRecipient.toLowerCase());
  assert.strictEqual(job.exit.calls[0].target, RECIPE.calls[0].target.toLowerCase());
  assert.strictEqual(job.exit.calls[0].push, false);
  assert.deepStrictEqual(job.exit.minOuts, ['0']);
  const st = await q.jobStatus(jobId);
  assert.strictEqual(st.activation, 'pending');
  assert.strictEqual(st.activateTx, null);
  ok('a relayed unwrap carries its normalized exit recipe to the relay, and status reports the activation pending');
}

{
  const q = settler();
  const picked = await (async () => {
    await q.submitJob({ type: 'sendunwrap', op: unwrapOp(), memos: ['0x01'], exit: RECIPE });
    return q.nextBatch({ types: ['sendunwrap'] });
  })();
  assert.strictEqual(picked.length, 1);
  assert.strictEqual(picked[0].exit.nonce, '77');
  ok('a batched claim hands the recipe over too');
}

{
  const q = settler();
  await assert.rejects(q.submitJob({ type: 'transfer', op: { spendRoot: '0xr', chainBinding: '0xcb', fee: 0 }, exit: RECIPE }), /rides only on a relayed unwrap or sendunwrap/);
  await assert.rejects(q.submitJob({ type: 'unwrap', op: unwrapOp(), mode: 'prove', exit: RECIPE }), /rides only on a relayed unwrap or sendunwrap/);
  const bad = [
    'recipe',
    { ...RECIPE, finalRecipient: '0x1234' },
    { ...RECIPE, exitedAsset: '0x1234' },
    { ...RECIPE, minOuts: [] },
    { ...RECIPE, calls: [] },
    { ...RECIPE, calls: new Array(9).fill(RECIPE.calls[0]) },
    { ...RECIPE, calls: [{ ...RECIPE.calls[0], push: 'false' }] },
    { ...RECIPE, calls: [{ ...RECIPE.calls[0], data: '0xabc' }] },
    { ...RECIPE, calls: [{ ...RECIPE.calls[0], value: '1e18' }] },
    { ...RECIPE, deadline: '-1' },
  ];
  for (const exit of bad) await assert.rejects(q.submitJob({ type: 'unwrap', op: unwrapOp(), exit }), /exit recipe has a bad/);
  assert.strictEqual(await q.pendingCount(), 0, 'nothing was queued');
  ok('a recipe on a non-exit or prove-only job, or a malformed recipe, is refused before anything is queued');
}

{
  const q = settler();
  const { jobId } = await q.submitJob({ type: 'sendunwrap', op: unwrapOp(), memos: ['0x01'], exit: RECIPE });
  await q.nextJob();
  await q.ackJob(jobId, { txHash: TX('aa') });
  let st = await q.jobStatus(jobId);
  assert.strictEqual(st.status, 'settled');
  assert.strictEqual(st.activation, 'pending');
  await q.ackJob(jobId, { activateError: 'the fee is below the settle plus activation cost' });
  st = await q.jobStatus(jobId);
  assert.strictEqual(st.activation, 'failed');
  assert.match(st.activateError, /below the settle plus activation cost/);
  const r = await q.ackJob(jobId, { activateTx: TX('bb') });
  assert.strictEqual(r.activateTx, TX('bb'));
  st = await q.jobStatus(jobId);
  assert.strictEqual(st.activation, 'done');
  assert.strictEqual(st.activateTx, TX('bb'));
  assert.strictEqual(st.activateError, null);
  assert.strictEqual(st.txHash, TX('aa'), 'the settle tx is untouched');
  await q.ackJob(jobId, { activateError: 'late' });
  await q.ackJob(jobId, { activateTx: TX('cc') });
  st = await q.jobStatus(jobId);
  assert.strictEqual(st.activateTx, TX('bb'), 'a recorded activation is final');
  assert.strictEqual(st.activation, 'done');
  ok('activation acks after the settle: an error can be followed by a tx, a tx is final');
}

{
  const q = settler();
  const { jobId } = await q.submitJob({ type: 'unwrap', op: unwrapOp(), exit: RECIPE });
  await q.nextJob();
  await q.ackJob(jobId, { txHash: TX('aa'), activateTx: TX('ee') });
  const st = await q.jobStatus(jobId);
  assert.strictEqual(st.status, 'settled');
  assert.strictEqual(st.activateTx, TX('ee'));
  ok('one ack may carry both the settle and the activation');
}

{
  const q = settler();
  const { jobId } = await q.submitJob({ type: 'unwrap', op: unwrapOp({ recipient: '0x' + '11'.repeat(20) }) });
  await q.nextJob();
  await q.ackJob(jobId, { txHash: TX('aa') });
  await q.ackJob(jobId, { activateTx: TX('bb') });
  let st = await q.jobStatus(jobId);
  assert.strictEqual(st.activation, null);
  assert.strictEqual(st.activateTx, null);

  const q2 = settler();
  const j2 = await q2.submitJob({ type: 'unwrap', op: unwrapOp(), exit: RECIPE });
  await q2.nextJob();
  await q2.ackJob(j2.jobId, { txHash: TX('aa'), activateTx: 'not-a-hash' });
  assert.strictEqual((await q2.jobStatus(j2.jobId)).activation, 'pending');
  await q2.ackJob(j2.jobId, { activateTx: '0x' + 'DD'.repeat(32) });
  st = await q2.jobStatus(j2.jobId);
  assert.strictEqual(st.activateTx, TX('dd'));
  ok('a job without a recipe ignores activation acks, and only a 32-byte tx hash is recorded');
}

// ───────────────── relay checks ─────────────────
{
  const sig = 'activateExit((bytes32,address,address,uint64,uint256,(address,uint256,address,uint256,bool,bytes)[],address[],uint256[]))';
  const sel = '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig))).subarray(0, 4).toString('hex');
  assert.strictEqual(sel, '0x1699fd5b');
  const act = encodeFunctionData({ abi: ROUTER_EXIT_ABI, functionName: 'activateExit', args: [recipeArgs(RECIPE)] });
  assert.strictEqual(act.slice(0, 10), sel);
  const esc = encodeFunctionData({ abi: ROUTER_EXIT_ABI, functionName: 'escrowAddressFor', args: [recipeArgs(RECIPE)] });
  assert.strictEqual(esc.slice(0, 10), '0x2bf0cda2');
  // Both encode the recipe identically after the selector: it is the one argument, and escrowAddressFor's
  // salt is keccak(abi.encode(recipe)) — the same bytes.
  assert.strictEqual(act.slice(10), esc.slice(10));
  const a = recipeArgs(RECIPE);
  assert.strictEqual(a.deadline, 1900000000n);
  assert.strictEqual(a.calls[0].value, 990000000000000n);
  assert.strictEqual(a.finalRecipient.toLowerCase(), RECIPE.finalRecipient.toLowerCase());
  ok('the relay encodes activateExit / escrowAddressFor with the router\'s canonical recipe signature');
}

{
  const job = { jobId: 'j', type: 'unwrap', op: unwrapOp(), exit: RECIPE };
  const at = { nowSecs: 1_800_000_000, ethAssetId: ETH_ID };
  assert.ok(exitCheck({ job, escrow: '0x' + ESCROW.slice(2).toUpperCase(), ...at }).ok);
  assert.match(exitCheck({ job, escrow: '0x' + '77'.repeat(20), ...at }).reason, /does not map to the recipient the proof paid/);
  assert.match(exitCheck({ job, escrow: null, ...at }).reason, /does not map/);
  assert.match(exitCheck({ job: { ...job, op: unwrapOp({ asset: '0x' + '42'.repeat(32) }) }, escrow: ESCROW, ...at }).reason, /ETH exits only/);
  assert.match(exitCheck({ job: { ...job, exit: { ...RECIPE, exitedAsset: '0x' + '42'.repeat(32) } }, escrow: ESCROW, ...at }).reason, /ETH exits only/);
  assert.match(exitCheck({ job, escrow: ESCROW, nowSecs: 1_900_000_000 - 60, ethAssetId: ETH_ID }).reason, /expires too soon/);
  assert.match(exitCheck({ job: { ...job, type: 'transfer' }, escrow: ESCROW, ...at }).reason, /not an exit/);
  assert.match(exitCheck({ job: { ...job, exit: null }, escrow: ESCROW, ...at }).reason, /no exit recipe/);
  ok('exitCheck: only this proof\'s own ETH recipe, with time left to run it');
}

{
  const job = { jobId: 'j', type: 'unwrap', op: unwrapOp(), exit: RECIPE }; // fee 20000 units = 2e14 wei
  const base = { job, weiPerUnit: 10n ** 10n, gasCap: 1_500_000n };
  const gp = 200_000_000n; // 0.2 gwei: settle 400k (8e13) + activation 500k (1e14) = 1.8e14
  const fits = { ...base, settleCostWei: 400_000n * gp, gasEstimate: 500_000n, gasPriceWei: gp };
  let c = activationCover(fits);
  assert.ok(c.ok);
  assert.strictEqual(c.gas, 650_000n, 'the estimate plus 30%');
  assert.strictEqual(c.feeWei, 2n * 10n ** 14n);
  assert.strictEqual(c.cost, 180_000_000_000_000n);
  assert.ok(activationCover({ ...fits, marginBps: 1000n }).ok, '1.98e14 still fits');
  assert.match(activationCover({ ...fits, marginBps: 2000n }).reason, /below the settle plus activation cost/);
  assert.match(activationCover({ ...fits, gasPriceWei: gp * 2n }).reason, /below/);
  assert.match(activationCover({ ...fits, job: { ...job, op: unwrapOp({ fee: '0' }) } }).reason, /below/);
  assert.match(activationCover({ ...base, settleCostWei: 0n, gasEstimate: 1_600_000n, gasPriceWei: 1n }).reason, /over the 1500000 cap/);
  c = activationCover({ ...base, settleCostWei: 0n, gasEstimate: 1_400_000n, gasPriceWei: 1n });
  assert.ok(c.ok);
  assert.strictEqual(c.gas, 1_500_000n, 'the limit never exceeds the cap');
  ok('activationCover: the bound fee must pay the mined settle plus the activation, under the gas cap');
}

// A proof posted from the holder's own machine: no op, so its one withdrawal and its fee legs are read from the public values.
{
  const w = (v) => BigInt(v).toString(16).padStart(64, '0');
  // abi.encode(PublicValues) far enough for the reads: head words 1..8, `withdrawals` (head word 7) and `fees` (head word 8) after it
  const pv = (recipient, feeUnits, extra = []) => {
    const head = Array.from({ length: 31 }, () => w(0)); head[0] = w(32);
    const wAt = 31 * 32, wl = [w(1 + extra.length), w(ETH_ID), w(recipient), w(1000000), ...extra.flatMap((e) => [w(ETH_ID), w(e), w(1)])];
    const fAt = wAt + wl.length * 32, fl = [w(1), w(ETH_ID), w(feeUnits)];
    head[7] = w(wAt - 32); head[8] = w(fAt - 32);
    return '0x' + [...head, ...wl, ...fl].join('').slice(0, (31 + wl.length + fl.length) * 64);
  };
  const job = (p) => ({ type: 'unwrap', op: null, publicValues: p, exit: RECIPE });
  const got = pvWithdrawals(pv(ESCROW, 20000));
  assert.deepStrictEqual(got.map((x) => [x.assetId, x.recipient]), [[ETH_ID, ESCROW]]);
  assert.ok(exitCheck({ job: job(pv(ESCROW, 20000)), escrow: ESCROW, nowSecs: 1000, ethAssetId: ETH_ID }).ok, 'the recipe maps to the withdrawal the proof pays');
  assert.match(exitCheck({ job: job(pv('0x' + '12'.repeat(20), 20000)), escrow: ESCROW, nowSecs: 1000, ethAssetId: ETH_ID }).reason, /does not map/);
  assert.match(exitCheck({ job: job(pv(ESCROW, 20000, ['0x' + '34'.repeat(20)])), escrow: ESCROW, nowSecs: 1000, ethAssetId: ETH_ID }).reason, /exactly one withdrawal/);
  assert.match(exitCheck({ job: job('0x1234'), escrow: ESCROW, nowSecs: 1000, ethAssetId: ETH_ID }).reason, /could not be read/);
  const gp = 200_000_000n, fits = { settleCostWei: 400_000n * gp, gasEstimate: 500_000n, gasPriceWei: gp, weiPerUnit: 10n ** 10n, gasCap: 1_500_000n, ethAssetId: ETH_ID };
  const c = activationCover({ ...fits, job: job(pv(ESCROW, 20000)) });
  assert.ok(c.ok && c.feeWei === 2n * 10n ** 14n, 'the tETH fee leg pays for the settle and the activation');
  assert.match(activationCover({ ...fits, job: job(pv(ESCROW, 1000)) }).reason, /below/);
  ok('a posted exit: its withdrawal and fee are read from the public values; a recipe for another recipient, a second withdrawal or unreadable values are refused');
}

{
  const q = makeConfidentialSettler({ storage: { ...freshStore(), getOpen: async () => [], putOpen: async () => {} }, hash, now, sleep: instantSleep, verifyPosted: async () => ({ ok: true }) });
  const r = await q.submitJob({ type: 'unwrap', mode: 'preproven', publicValues: '0x' + 'ab'.repeat(64), proof: '0x' + 'cd'.repeat(32), memos: [], exit: RECIPE });
  const st = await q.jobStatus(r.jobId);
  assert.strictEqual(st.activation, 'pending', 'the posted job carries its recipe');
  await assert.rejects(() => q.submitJob({ type: 'transfer', mode: 'preproven', publicValues: '0x' + 'ef'.repeat(64), proof: '0x' + 'cd'.repeat(32), memos: [], exit: RECIPE }), /rides only on an unwrap or sendunwrap/);
  ok('submitJob: a posted unwrap may carry its recipe; any other posted type may not');
}

console.log(`\n${n} exit-activation checks passed.`);
