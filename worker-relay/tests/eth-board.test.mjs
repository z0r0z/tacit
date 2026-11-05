// lib/eth-board.js: the Ethereum-state proof on the prover board before the network, with eth_prove, the API and the board
// stood in for (the board lane itself is the real lib/board-prover.js over a fake API).
// Run: node --test worker-relay/tests/eth-board.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEthBoard, boardProves, finishVerdict } from '../src/lib/eth-board.js';
import { makeBoardProver } from '../src/lib/board-prover.js';

const EXPECT = '5a'.repeat(448);
const PROOF = Buffer.alloc(64, 9).toString('base64');

function rig({ script = [], capable = true, built = { stdin: new Uint8Array([1, 2, 3]), expectPv: EXPECT }, finish = async () => true, postOk = true } = {}) {
  const calls = { post: [], cancel: [], finish: [], build: 0, capable: 0 };
  let t = 0, i = 0;
  const now = () => t;
  const lane = makeBoardProver({
    post: async (b) => { calls.post.push(b); return postOk ? { ok: true, jobId: '0xeth0000000001', status: 'queued' } : { ok: false, error: 'program must be one of confidential' }; },
    status: async () => script[Math.min(i++, script.length - 1)] || { status: 'queued' },
    cancel: async (jobId, reason) => { calls.cancel.push({ jobId, reason }); },
    verify: async () => { throw new Error('the settle check must not run for an eth-state proof'); },
    now, sleep: async (ms) => { t += ms; }, waitMs: 300_000, pollMs: 2000,
  });
  const eth = makeEthBoard({
    capable: async () => { calls.capable++; if (capable instanceof Error) throw capable; return capable; },
    buildInput: async () => { calls.build++; if (built instanceof Error) throw built; t += 40_000; return built; },
    lane,
    finish: async (p) => { calls.finish.push(p); return finish(p); },
    cycleLimit: '3000000000', gasLimit: '3000000000', waitMs: 300_000, now,
  });
  return { eth, calls, now: () => t };
}
const proved = (pv = `0x${EXPECT}`, worker = 'tacit-a5000') => ({ status: 'proved', worker, publicValues: pv, proof: PROOF });

test('the board proves it: the input is posted as the eth-state program, finished by eth_prove, and the lane says who proved it', async () => {
  const { eth, calls } = rig({ script: [{ status: 'queued' }, { status: 'claimed', worker: 'tacit-a5000' }, proved()] });
  const r = await eth.prove();
  assert.equal(r.ok, true); assert.equal(r.worker, 'tacit-a5000'); assert.equal(r.jobId, '0xeth0000000001');
  assert.equal(calls.post.length, 1);
  const p = calls.post[0];
  assert.equal(p.program, 'eth-state'); assert.equal(p.mode, 'compressed'); assert.equal(p.class, 'eth-state');
  assert.equal(p.stdin, Buffer.from([1, 2, 3]).toString('base64'));
  assert.equal(p.cycleLimit, 3e9); assert.equal(p.gasLimit, 3e9);
  assert.deepEqual(calls.finish, [PROOF], 'eth_prove finishes with the proof the worker sent');
  assert.equal(calls.cancel.length, 0);
});

test('no worker that proves it: nothing is built or posted, and the network takes it at once', async () => {
  for (const capable of [false, new Error('summary unreadable')]) {
    const { eth, calls } = rig({ capable });
    const r = await eth.prove();
    assert.equal(r.ok, false); assert.match(r.reason, /no worker that proves the Ethereum-state input/);
    assert.equal(calls.build, 0); assert.equal(calls.post.length, 0);
    assert.equal(r.ms, 0, 'it cost no lane time');
  }
});

test('an input that was not built goes to the network without posting', async () => {
  for (const built of [new Error('eth_prove stdin run gave no input (code=1)'), { stdin: new Uint8Array(0), expectPv: EXPECT }, { stdin: new Uint8Array([1]), expectPv: 'not-hex' }]) {
    const { eth, calls } = rig({ built });
    const r = await eth.prove();
    assert.equal(r.ok, false); assert.match(r.reason, /the input was not built/);
    assert.equal(calls.post.length, 0);
  }
});

test('a proof of another input is refused before eth_prove is run on it, and counts against the worker', async () => {
  const { eth, calls } = rig({ script: [proved('0x' + '00'.repeat(448), 'eve')] });
  const r = await eth.prove();
  assert.equal(r.ok, false); assert.match(r.reason, /did not pass the check/);
  assert.equal(calls.finish.length, 0);
  assert.deepEqual(calls.cancel, [{ jobId: '0xeth0000000001', reason: 'bad' }]);
});

test('eth_prove refuses the proof: bad, to the network; eth_prove could not check it: no mark, to the network', async () => {
  let x = rig({ script: [proved()], finish: async () => false });
  let r = await x.eth.prove();
  assert.equal(r.ok, false); assert.deepEqual(x.calls.cancel, [{ jobId: '0xeth0000000001', reason: 'bad' }]);
  x = rig({ script: [proved()], finish: async () => 'unchecked' });
  r = await x.eth.prove();
  assert.equal(r.ok, false); assert.match(r.reason, /could not be checked here/);
  assert.deepEqual(x.calls.cancel, [{ jobId: '0xeth0000000001', reason: 'unchecked' }]);
});

test('nobody proves it within the wait: cancelled, to the network, and the wait is all it cost past building the input', async () => {
  const x = rig({ script: [{ status: 'claimed', worker: 'tacit-a5000' }] });
  const r = await x.eth.prove();
  assert.equal(r.ok, false); assert.match(r.reason, /within 300 s/);
  assert.deepEqual(x.calls.cancel, [{ jobId: '0xeth0000000001', reason: 'timeout' }]);
  assert.ok(r.ms <= 40_000 + 300_000 + 2000, `bounded: ${r.ms} ms`);
});

test('an API that does not know the program yet (before its deploy) misses without waiting', async () => {
  const x = rig({ postOk: false });
  const r = await x.eth.prove();
  assert.equal(r.ok, false); assert.match(r.reason, /not posted: program must be one of confidential/);
  assert.equal(r.ms, 40_000, 'only the input build was spent');
});

test('boardProves: a worker that proves the program and polled within the window', () => {
  const sum = (workers) => ({ queued: 0, workers });
  assert.equal(boardProves(sum([{ name: 'a', lastSeenSeconds: 3, programs: ['confidential', 'eth-state'] }]), 'eth-state'), true);
  assert.equal(boardProves(sum([{ name: 'a', lastSeenSeconds: 3, programs: ['confidential'] }]), 'eth-state'), false, 'an older worker');
  assert.equal(boardProves(sum([{ name: 'a', lastSeenSeconds: 3 }]), 'eth-state'), false, 'an older API (no programs on the summary)');
  assert.equal(boardProves(sum([{ name: 'a', lastSeenSeconds: 31, programs: ['eth-state'] }]), 'eth-state'), false, 'not seen lately');
  assert.equal(boardProves(sum([{ name: 'a', lastSeenSeconds: null, programs: ['eth-state'] }]), 'eth-state'), false);
  assert.equal(boardProves(null, 'eth-state'), false);
  assert.equal(boardProves(sum([{ name: 'a', lastSeenSeconds: 75, programs: ['eth-state'] }]), 'eth-state', 120), true, 'a worker mid-proof, with a wider window');
});

test('finishVerdict: FINISH_OK with exit 0 is accepted, FINISH_REFUSED with exit 3 refused, anything else unchecked', () => {
  assert.equal(finishVerdict({ code: 0, out: 'FINISH_CHECKED sp1_version=v6.1.0\nWROTE …\nFINISH_OK\n' }), true);
  assert.equal(finishVerdict({ code: 3, out: 'FINISH_REFUSED its public values are not this candidate\'s\n' }), false);
  assert.equal(finishVerdict({ code: 0, out: 'no line' }), 'unchecked');
  assert.equal(finishVerdict({ code: 101, out: 'thread main panicked' }), 'unchecked');
  assert.equal(finishVerdict({ code: null, out: '' }), 'unchecked');
  assert.equal(finishVerdict({ code: 3, out: 'FINISH_OK' }), 'unchecked');
});

test('an input build that failed on its own error is tried once more before the network; a second failure goes to the network', async () => {
  const slept = [], logs = [];
  const mk = (results) => {
    let i = 0;
    return makeEthBoard({
      capable: async () => true,
      buildInput: async () => { const r = results[i++]; if (r instanceof Error) throw r; return r; },
      lane: { prove: async () => ({ worker: 'tacit-a5000', jobId: '0x1' }) },
      finish: async () => true, cycleLimit: 1, gasLimit: 1, waitMs: 1000, retryMs: 5000,
      sleep: async (ms) => { slept.push(ms); }, log: (m) => logs.push(m),
    });
  };
  const flaky = () => Object.assign(new Error('eth_prove stdin run gave no input (code=1): Error: [debug get_proof failed] header not found'), { retry: true });
  const good = { stdin: new Uint8Array([1]), expectPv: EXPECT };
  let r = await mk([flaky(), good]).prove();
  assert.equal(r.ok, true); assert.deepEqual(slept, [5000]);
  assert.match(logs[0], /the input was not built \(.*header not found\); trying again in 5 s/);

  slept.length = 0;
  r = await mk([flaky(), flaky(), good]).prove();
  assert.equal(r.ok, false); assert.match(r.reason, /the input was not built \(2 tries\): .*header not found/);
  assert.deepEqual(slept, [5000]);

  slept.length = 0;
  r = await mk([new Error('eth_prove:stdin timed out after 900000ms'), good]).prove();
  assert.equal(r.ok, false, 'a timeout is not run again'); assert.match(r.reason, /timed out/); assert.deepEqual(slept, []);
});
