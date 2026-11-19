// A settle an endpoint refuses because it reverts in the PENDING block (src/lib/landed-elsewhere.js isPendingRevert, errDetail, holdPendingRevert).
//
// 2026-11-19: MEV Blocker answered "Missing or invalid parameters." to a wrap's settle for minutes, its detail "Failed in pending block with: Reverted"; Flashbots Protect accepted
// the same transaction and never included it, so the relay waited out three 48 s rounds and 2 more minutes, failed the job, and the page showed an error before the retry landed.
// The refusal is a verdict on the transaction against the pending block (not a fault of the endpoint), and clears when the pending block moves: it is offered again every few
// seconds, and a settle that reverts against the latest block too is not waited for.
//
//   node worker-relay/tests/pending-revert.test.mjs

import assert from 'node:assert/strict';
import { isPendingRevert, isRevert, errDetail, holdPendingRevert } from '../src/lib/landed-elsewhere.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

// The error as viem raises it for MEV Blocker's answer (the one-line message, and the node's detail on it and on its cause).
const mevblocker = () => Object.assign(new Error('Missing or invalid parameters.\nDouble check you have provided the correct parameters.\n\nURL: https://rpc.mevblocker.io/fullprivacy\nRequest body: {"method":"eth_sendRawTransaction","params":["0x02f9' + 'ab'.repeat(600) + '"]}'),
  { name: 'InvalidParamsRpcError', shortMessage: 'Missing or invalid parameters.', details: 'Failed in pending block with: Reverted', cause: Object.assign(new Error('rpc'), { details: 'Failed in pending block with: Reverted' }) });

await test('MEV Blocker\'s pending-block refusal is told apart', () => {
  assert.equal(isPendingRevert(mevblocker()), true);
  assert.equal(isPendingRevert(Object.assign(new Error('x'), { cause: { details: 'failed in pending block with: Reverted' } })), true);
});

await test('other refusals are not taken for it', () => {
  assert.equal(isPendingRevert(new Error('HTTP request failed.')), false);
  assert.equal(isPendingRevert(Object.assign(new Error('fee cap'), { shortMessage: 'The fee cap (`maxFeePerGas` = 0.05 gwei) cannot be lower than the block base fee.', details: 'txIndex 0 error: fee cap less than block base fee' })), false);
  assert.equal(isPendingRevert(Object.assign(new Error('nonce too low'), { details: 'nonce too low' })), false);
  assert.equal(isPendingRevert(null), false);
  assert.equal(isPendingRevert(undefined), false);
});

await test('it is not a latest-block revert (isRevert), which ends the settle at once', () => {
  assert.equal(isRevert(mevblocker()), false);
});

await test('the log line carries the node\'s detail and cuts the signed transaction short', () => {
  const t = errDetail(mevblocker());
  assert.match(t, /Missing or invalid parameters/);
  assert.match(t, /Failed in pending block with: Reverted/);
  assert.ok(!/abab/.test(t), 'the raw transaction was logged');
  assert.ok(t.length <= 300);
  assert.equal(errDetail(new Error('plain')), 'plain');
  assert.equal(errDetail(undefined), 'undefined');
});

// a clock the sleeps move
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

await test('an endpoint that lets it through after a few polls ends the hold as accepted', async () => {
  const c = clock(), asked = [];
  const r = await holdPendingRevert({ stuck: ['mev'], holdMs: 90_000, pollMs: 4_000, ...c, dead: async () => null,
    resend: async (eps) => { asked.push(c.now()); return asked.length < 3 ? eps : []; } });
  assert.deepEqual(r, { state: 'accepted' });
  assert.deepEqual(asked, [4_000, 8_000, 12_000]);
});

await test('the same transaction is offered again only to the endpoints still refusing', async () => {
  const c = clock(), seen = [];
  const r = await holdPendingRevert({ stuck: ['a', 'b'], holdMs: 90_000, ...c, dead: async () => null,
    resend: async (eps) => { seen.push(eps.join()); return eps.filter((x) => x === 'b' && seen.length < 2); } });
  assert.deepEqual(seen, ['a,b', 'b']);
  assert.equal(r.state, 'accepted');
});

await test('a settle that reverts against the latest block too ends the hold at once, with that answer', async () => {
  const c = clock(), revert = new Error('execution reverted');
  let resent = 0;
  const r = await holdPendingRevert({ stuck: ['mev'], holdMs: 90_000, ...c, dead: async () => revert, resend: async (e) => { resent++; return e; } });
  assert.deepEqual(r, { state: 'dead', value: revert });
  assert.equal(resent, 0, 'sent again after it was dead');
  assert.equal(c.now(), 4_000);
});

await test('an endpoint that keeps refusing is given the hold and no more, then the rounds take over', async () => {
  const c = clock();
  const r = await holdPendingRevert({ stuck: ['mev'], holdMs: 90_000, pollMs: 4_000, ...c, dead: async () => null, resend: async (e) => e });
  assert.equal(r.state, 'timeout');
  assert.deepEqual(r.left, ['mev']);
  assert.ok(c.now() >= 90_000 && c.now() <= 94_000, `held ${c.now()} ms`);
});

await test('nothing stuck, or no time to hold, asks nothing', async () => {
  let asked = 0;
  const ask = { dead: async () => { asked++; return null; }, resend: async () => { asked++; return []; } };
  assert.deepEqual(await holdPendingRevert({ stuck: [], holdMs: 90_000, ...clock(), ...ask }), { state: 'accepted' });
  assert.equal((await holdPendingRevert({ stuck: ['mev'], holdMs: 0, ...clock(), ...ask })).state, 'timeout');
  assert.equal(asked, 0);
});

console.log(`${n} passed`);
