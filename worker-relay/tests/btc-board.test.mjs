// The Bitcoin-state proof on the prover board (src/lib/btc-board.js): a proof is taken only when its public values carry the batch's
// prior and new digests in their places and the verifier takes it; no worker, an input that was not built or a board miss leaves the
// batch to the network; a good proof comes back as the network's would. The public values are a real groth16 proof's, made under the
// pool's BITCOIN_RELAY_VKEY (contracts/test/fixtures/reflection_burn_deposit_groth16.json).
// Run: node --test tests/btc-board.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBtcBoard, btcCheck, PV_WORD } from '../src/lib/btc-board.js';

const FX = JSON.parse(readFileSync(new URL('../../contracts/test/fixtures/reflection_burn_deposit_groth16.json', import.meta.url), 'utf8'));
const pv = FX.publicValues, proof = FX.proofBytes;
const w = (i) => '0x' + pv.slice(2 + i * 64, 2 + i * 64 + 64);
const PRIOR = w(PV_WORD.priorDigest), NEW = w(PV_WORD.newDigest);

test('the fixture is under the live key, and its digests are where the check reads them', () => {
  assert.equal(FX.vkey, '0x00bb158ba04f18a100f998af0e3b074b5368771f22b8b6e4fd1d66823a074bc5');
  assert.equal(PRIOR, '0xf8ead47e32eb263bae91804dffd76efb86fa1e7e8f380d44b6dd6e8e3fa293fc');
  assert.notEqual(PRIOR, NEW);
});

test('a proof is taken only for this batch, and only when the verifier takes it', async () => {
  let asked = 0;
  const yes = btcCheck({ priorDigest: PRIOR, newDigest: NEW, verify: async () => { asked++; return true; } });
  assert.equal(await yes({ publicValues: pv, proof }), true);
  assert.equal(asked, 1);
  assert.equal(await btcCheck({ priorDigest: PRIOR, newDigest: PRIOR, verify: async () => true })({ publicValues: pv, proof }), false, 'another batch\'s new digest');
  assert.equal(await btcCheck({ priorDigest: NEW, newDigest: NEW, verify: async () => true })({ publicValues: pv, proof }), false, 'another prior');
  assert.equal(await btcCheck({ priorDigest: PRIOR, newDigest: NEW, verify: async () => true })({ publicValues: pv.slice(0, 2 + 64 * 5), proof }), false, 'cut short');
  assert.equal(await btcCheck({ priorDigest: PRIOR, newDigest: NEW, verify: async () => true })({ publicValues: pv, proof: 'nope' }), false, 'not proof bytes');
  assert.equal(await btcCheck({ priorDigest: PRIOR, newDigest: NEW, verify: async () => false })({ publicValues: pv, proof }), false, 'the verifier refuses it');
  assert.equal(await btcCheck({ priorDigest: PRIOR, newDigest: NEW, verify: async () => 'unchecked' })({ publicValues: pv, proof }), 'unchecked');
});

function rig({ capable = true, stdin = new Uint8Array([1, 2, 3]), lane } = {}) {
  const posted = [];
  const board = makeBtcBoard({
    capable: async () => capable, buildInput: async () => { if (stdin instanceof Error) throw stdin; return stdin; },
    lane: lane || { prove: async (a) => { posted.push(a); return { publicValues: pv, proof, worker: 'tacit-a5000', jobId: 'pb_1' }; } },
    verify: async () => true, cycleLimit: 1e11, gasLimit: 1e11, waitMs: 3600_000,
  });
  return { board, posted };
}

test('a worker\'s proof comes back as the network\'s would, posted as public btc-state groth16 work', async () => {
  const { board, posted } = rig();
  const r = await board.prove({ priorDigest: PRIOR, newDigest: NEW });
  assert.equal(r.ok, true);
  assert.deepEqual([r.publicValues, r.proofBytes, r.worker], [pv, proof, 'tacit-a5000']);
  assert.deepEqual([posted[0].program, posted[0].mode, posted[0].cls, posted[0].timeoutMs], ['btc-state', 'groth16', 'public', 3600_000]);
  assert.equal(typeof posted[0].check, 'function');
});

test('no worker, no input or a board miss leaves the batch to the network', async () => {
  assert.match((await rig({ capable: false }).board.prove({})).reason, /no worker/);
  assert.match((await rig({ stdin: new Error('boom') }).board.prove({})).reason, /not built: boom/);
  assert.match((await rig({ stdin: new Uint8Array(0) }).board.prove({})).reason, /not built/);
  const miss = Object.assign(new Error('prover board: nobody'), { code: 'board_miss', reason: 'nobody took it within the wait' });
  const r = await rig({ lane: { prove: async () => { throw miss; } } }).board.prove({});
  assert.deepEqual([r.ok, r.reason], [false, 'nobody took it within the wait']);
});

test('an input over the board\'s limit is not posted, and says how big it was so a smaller batch can be asked for', async () => {
  const sized = (bytes, maxBytes) => {
    const posted = [];
    const board = makeBtcBoard({
      capable: async () => true, buildInput: async () => new Uint8Array(bytes), maxBytes,
      lane: { prove: async (a) => { posted.push(a); return { publicValues: pv, proof, worker: 'tacit-a5000', jobId: 'pb_1' }; } },
      verify: async () => true, cycleLimit: 1e11, gasLimit: 1e11, waitMs: 3600_000,
    });
    return { board, posted };
  };
  const big = sized(1001, 1000);
  const r = await big.board.prove({ priorDigest: PRIOR, newDigest: NEW });
  assert.deepEqual([r.ok, r.tooBig, big.posted.length], [false, { bytes: 1001, maxBytes: 1000 }, 0]);
  assert.match(r.reason, /over the board's 1000-byte limit/);
  const fits = sized(1000, 1000);
  assert.equal((await fits.board.prove({ priorDigest: PRIOR, newDigest: NEW })).ok, true);
  assert.equal(fits.posted.length, 1);
  const off = sized(5000, 0);
  assert.equal((await off.board.prove({ priorDigest: PRIOR, newDigest: NEW })).ok, true, 'no limit: posted as before');
  assert.equal((await rig().board.prove({})).tooBig, undefined);
});
