// Where the settle relay stands (src/lib/prove-pause.js): the note its heartbeat carries, when it proves for the open board,
// and the pause it takes when a proof request cannot be paid for, until the credit covers one again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NOTE_HELD, NOTE_HELD_BOARD, NOTE_PAUSED, boardProving, standingNote, CREDIT_SHORT, creditShort, creditCovers, creditRefusal, makeProvePause,
} from '../src/lib/prove-pause.js';
import { retryPublic } from '../src/lib/private-prove.js';

const PROVE = 10n ** 18n;

test('the note says the open board only when relayed jobs are proved for it', () => {
  assert.equal(standingNote({ short: false, paused: false, board: false }), null, 'taking every job: no standing note');
  assert.equal(standingNote({ short: true, board: true }), NOTE_HELD_BOARD);
  assert.equal(standingNote({ short: true, board: false }), NOTE_HELD);
  assert.equal(standingNote({ paused: true, short: true, board: true }), NOTE_PAUSED, 'a pause outranks a short wallet');
  assert.equal(standingNote({ paused: true }), NOTE_PAUSED);
});

test('board proving needs the switch on and the last credit reading at its floor', () => {
  const minWei = 40n * PROVE;
  assert.equal(boardProving({ enabled: true, credit: { wei: 40n * PROVE, at: 1 }, minWei }), true);
  assert.equal(boardProving({ enabled: true, credit: { wei: 39n * PROVE, at: 1 }, minWei }), false, 'under the floor');
  assert.equal(boardProving({ enabled: true, credit: null, minWei }), false, 'nothing read yet');
  assert.equal(boardProving({ enabled: false, credit: { wei: 100n * PROVE, at: 1 }, minWei }), false, 'switched off');
  assert.equal(boardProving({ enabled: true, credit: null, minWei, ownProver: true }), true, 'the prover board makes the proofs: no credit needed');
  assert.equal(boardProving({ enabled: true, credit: { wei: 0n, at: 1 }, minWei, ownProver: true }), true, 'nor any credit left');
  assert.equal(boardProving({ enabled: false, credit: null, minWei, ownProver: true }), false, 'still off when switched off');
});

test('the notes are public: nothing about gas, credit or balances, and each reads as what it is', () => {
  for (const n of [NOTE_HELD, NOTE_HELD_BOARD, NOTE_PAUSED]) assert.doesNotMatch(n, /gas|ETH|PROVE|credit|wallet|funds|balance|\d/i, n);
  assert.match(NOTE_HELD_BOARD, /on the open board/);
  assert.doesNotMatch(NOTE_HELD, /open board/);
  assert.match(NOTE_PAUSED, /not proving/);
  assert.doesNotMatch(NOTE_HELD + NOTE_HELD_BOARD, /not proving/);
});

test('the API reads each note as the state it means', () => {
  // The regexes relayState matches, taken from the worker source so the two cannot drift apart.
  const src = readFileSync(new URL('../../worker/src/index.js', import.meta.url), 'utf8');
  const re = (name) => new RegExp(src.match(new RegExp(`const ${name} = \\/(.+)\\/i;`))[1], 'i');
  const [pause, hold, board, busy] = ['RELAY_PAUSE_NOTE', 'RELAY_HOLD_NOTE', 'RELAY_BOARD_NOTE', 'RELAY_BUSY_NOTE'].map(re);
  // heartbeat() stores `${kind}: ${detail}`.
  const stored = (d) => `settle: ${d}`;
  assert.ok(pause.test(stored(NOTE_PAUSED)) && !hold.test(stored(NOTE_PAUSED)), 'paused');
  assert.ok(!pause.test(stored(NOTE_HELD)) && hold.test(stored(NOTE_HELD)) && !board.test(stored(NOTE_HELD)), 'held, board off');
  assert.ok(hold.test(stored(NOTE_HELD_BOARD)) && board.test(stored(NOTE_HELD_BOARD)), 'held, board on');
  assert.ok(busy.test(stored('proving 0xabc unwrap')) && !hold.test(stored('proving 0xabc unwrap')), 'a job being proved is busy');
  for (const d of ['idle — queue empty', 'settled 0xabc', 'sending 0xabc swap', 'taking jobs again', 'queue drained']) {
    assert.ok(![pause, hold, busy].some((r) => r.test(stored(d))), `"${d}" reads as ok`);
  }
});

test('a refusal for want of credit is recognised, from the mark lib/prover.js sets or the network\'s words', () => {
  const e = new Error('exec:swap produced no proof (code=101): ENOENT'); e.creditShort = true;
  assert.ok(creditShort(e));
  assert.ok(creditShort(new Error('groth16 proof failed: status: ResourceExhausted, message: "…", details: [], metadata: MetadataMap { headers: {} }')));
  assert.ok(creditShort(new Error('succinct RequestProof: RESOURCE_EXHAUSTED - insufficient balance')));
  assert.ok(creditShort(new Error('Insufficient credits for this request')));
  assert.ok(creditShort(new Error('account is out of credit')));
  assert.ok(!creditShort(new Error('exec:swap timed out after 360000ms')));
  assert.ok(!creditShort(new Error('exec:swap produced no proof (code=101): …request is unexecutable')));
  assert.ok(!creditShort(null));
  assert.ok(CREDIT_SHORT.test('thread \'main\' panicked at exec-swap.rs:271:10:\ngroth16 proof failed: status: ResourceExhausted, message: "x"'), 'the panic line the exec binaries print on stderr');
});

test('a request the account cannot pay for is not sent again in public', () => {
  const e = new Error('exec:swap produced no proof (code=101): ENOENT'); e.creditShort = true;
  assert.equal(retryPublic(e), false);
  assert.equal(retryPublic(new Error('exec:swap produced no proof (code=101): ENOENT')), true, 'unmarked, it is tried in public as before');
});

test('a credit reading covers a request only when it was read and is at the floor', () => {
  assert.equal(creditCovers(11n * PROVE / 10n, 11n * PROVE / 10n), true);
  assert.equal(creditCovers(PROVE, 11n * PROVE / 10n), false);
  assert.equal(creditCovers(null, 11n * PROVE / 10n), false);
});

// A clock and a credit the test moves by hand.
function rig({ credit = 0n } = {}) {
  let t = 1_000_000, reads = 0;
  const logs = [];
  const p = makeProvePause({
    readCredit: async () => { reads++; if (credit instanceof Error) throw credit; return credit; },
    minWei: 11n * PROVE / 10n, everyMs: 120_000, now: () => t, log: (m) => logs.push(m),
  });
  return { p, logs, tick: (ms) => { t += ms; }, set: (c) => { credit = c; }, reads: () => reads };
}

test('nothing but a refused request pauses proving, and a check while running reads nothing', async () => {
  const r = rig();
  assert.equal(r.p.paused(), false);
  assert.equal(await r.p.check(), false);
  assert.equal(r.reads(), 0, 'no credit is read while proving runs');
});

test('paused, the credit is read at most every two minutes, and proving resumes once it covers a request', async () => {
  const r = rig({ credit: PROVE / 2n });
  assert.equal(r.p.enter('ResourceExhausted'), true);
  assert.equal(r.p.enter('again'), false, 'a second refusal does not start it again');
  assert.equal(r.p.paused(), true);
  assert.match(r.logs[0], /proving paused/, 'the pause is logged');
  assert.equal(await r.p.check(), true);
  r.tick(119_000);
  assert.equal(await r.p.check(), true);
  assert.equal(r.reads(), 0, 'not read inside two minutes of the refusal');
  r.tick(1_000);
  assert.equal(await r.p.check(), true, 'half a PROVE does not cover a request');
  assert.equal(r.reads(), 1);
  r.tick(30_000);
  assert.equal(await r.p.check(), true);
  assert.equal(r.reads(), 1, 'read again only after another two minutes');
  r.set(2n * PROVE);
  r.tick(90_000);
  assert.equal(await r.p.check(), false, 'resumed');
  assert.equal(r.p.paused(), false);
  assert.match(r.logs.at(-1), /proving resumed/, 'the resume is logged');
});

test('the settle loop sends board proofs while paused, claims nothing, and says it is paused before it fails the job', () => {
  const src = readFileSync(new URL('../src/settle-relay.js', import.meta.url), 'utf8');
  const cyc = src.slice(src.indexOf('async function cycle()'), src.indexOf('// Settles acked failed whose broadcast may still land'));
  const at = (s) => { const i = cyc.indexOf(s); assert.ok(i >= 0, `cycle() has ${s}`); return i; };
  assert.ok(at('await pause.check()') < at('await openCycle()'), 'the pause is checked first');
  assert.ok(at('await openCycle()') < at('if (paused) return false;'), 'sending from the open board (gas, not PROVE) runs while paused');
  assert.ok(at('if (paused) return false;') < at('await batchCycle()') && at('if (paused) return false;') < at('await confidentialJob('), 'nothing is claimed while paused');
  assert.ok(at('await pauseOn(e);') < at('error: `prove failed: ${safeErr(e)}`'), 'the pause (and its note) comes before the failed ack');
  assert.match(src, /if \(!worked\) \{ if \(!standing\) await heartbeatIdle\(/, 'an idle beat never hides the standing note');
  assert.match(src, /async function settleOne\(j\) \{\n\s*if \(pause\.paused\(\)\)/, 'a batch member claimed before the pause is not proved');
});

test('a credit that cannot be read leaves the pause as it is', async () => {
  const r = rig({ credit: null });
  r.p.enter();
  r.tick(120_000);
  assert.equal(await r.p.check(), true, 'unread: still paused');
  r.set(new Error('exec:balance timed out'));
  r.tick(120_000);
  assert.equal(await r.p.check(), true, 'a read that throws: still paused');
  r.set(5n * PROVE);
  r.tick(120_000);
  assert.equal(await r.p.check(), false, 'resumed on the first reading that covers a request');
});

test('the network\'s refusal for want of credit yields what the account holds and what the request reserves', () => {
  const text = 'groth16 proof failed: status: ResourceExhausted, message: "insufficient balance 17.8126 PROVE for request cost 19.6030 PROVE", details: []';
  const r = creditRefusal(text);
  assert.equal(r.haveWei, 17_8126n * 10n ** 14n);
  assert.ok(r.needWei > 19_6030n * 10n ** 14n && r.needWei <= 19_6032n * 10n ** 14n, 'the need is rounded up past the four decimals printed');
  assert.ok(creditShort({ message: text }), 'and it is the same refusal the pause already recognises');
  assert.equal(creditRefusal('groth16 proof failed: request is unexecutable'), null);
  assert.equal(creditRefusal(undefined), null);
});

test('a credit that reads exactly the printed need does not resume a pause whose need was rounded up', async () => {
  const need = creditRefusal('insufficient balance 17.8126 PROVE for request cost 19.6030 PROVE').needWei;
  let at = 5000, credit = 19_6030n * 10n ** 14n;
  const p = makeProvePause({ readCredit: async () => credit, minWei: need, everyMs: 1000, now: () => at });
  p.enter(); at += 1000;
  assert.equal(await p.check(), true, 'the printed figure alone is not enough: the network held back a hair more');
  credit = need; at += 1000;
  assert.equal(await p.check(), false);
});
