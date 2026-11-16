// lib/board-breaker.js: skip the prover board for an op type after a run of claimed-and-silent proofs. Run: node --test worker-relay/tests/board-breaker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardBreaker, typeOf } from '../src/lib/board-breaker.js';

const clock = (t0 = 1_000_000) => { let t = t0; const now = () => t; now.tick = (ms) => { t += ms; }; return now; };

test('three stalls in a row for one op type rest the board for it for ten minutes, and only for it', () => {
  const now = clock();
  const b = makeBoardBreaker({ stalls: 3, restMs: 600_000, now });
  assert.equal(b.resting('farmunbond'), null);
  assert.equal(b.stalled('farmunbond'), false); assert.equal(b.stalled('farmunbond'), false);
  assert.equal(b.resting('farmunbond'), null, 'two stalls: the board is still tried');
  assert.equal(b.stalled('farmunbond'), true, 'the third trips it');
  assert.equal(b.resting('farmunbond'), 600);
  assert.equal(b.resting('swap'), null, 'another op type is not held back');
  now.tick(240_000);
  assert.equal(b.resting('farmunbond'), 360);
  now.tick(360_000);
  assert.equal(b.resting('farmunbond'), null, 'the rest is over: the board is tried again');
});

test('after the rest one more stall rests it again at once; one board proof clears the count', () => {
  const now = clock();
  const b = makeBoardBreaker({ stalls: 3, restMs: 600_000, now });
  for (let i = 0; i < 3; i++) b.stalled('lp');
  now.tick(600_001);
  assert.equal(b.resting('lp'), null);
  assert.equal(b.stalled('lp'), true, 'the fourth stall: rest again');
  assert.equal(b.resting('lp'), 600);
  now.tick(600_001);
  b.proved('lp');
  assert.equal(b.stalled('lp'), false); assert.equal(b.stalled('lp'), false);
  assert.equal(b.resting('lp'), null, 'a proof from the board started the count over');
});

test('a proof between stalls breaks the run; only a worker that went silent counts', () => {
  const b = makeBoardBreaker({ stalls: 3, restMs: 600_000, now: clock() });
  b.stalled('wrap'); b.stalled('wrap'); b.proved('wrap'); b.stalled('wrap'); b.stalled('wrap');
  assert.equal(b.resting('wrap'), null);
  assert.equal(b.stalled('wrap'), true);
});

test('a batch label counts as its type, and a label with no type still has a name', () => {
  assert.equal(typeOf('mixed(4)'), 'mixed'); assert.equal(typeOf('market wrap'), 'market wrap'); assert.equal(typeOf('swap'), 'swap'); assert.equal(typeOf(''), 'op'); assert.equal(typeOf(null), 'op');
  const b = makeBoardBreaker({ stalls: 2, restMs: 1000, now: clock() });
  b.stalled('mixed(3)'); b.stalled('mixed(5)');
  assert.ok(b.resting('mixed(2)') > 0);
});

test('off with 0 stalls or 0 rest: never rests', () => {
  for (const o of [{ stalls: 0, restMs: 600_000 }, { stalls: 3, restMs: 0 }]) {
    const b = makeBoardBreaker({ ...o, now: clock() });
    for (let i = 0; i < 10; i++) assert.equal(b.stalled('swap'), false);
    assert.equal(b.resting('swap'), null);
  }
});

test('snapshot says what is resting', () => {
  const now = clock();
  const b = makeBoardBreaker({ stalls: 1, restMs: 60_000, now });
  b.stalled('swap');
  assert.deepEqual(b.snapshot(), [{ type: 'swap', stalls: 1, restingSecs: 60 }]);
});

// prover.js is read as text: importing it pulls in the relay's config, which wants a live environment.
import { readFileSync } from 'node:fs';
const prover = readFileSync(new URL('../src/lib/prover.js', import.meta.url), 'utf8');
const viaBoard = prover.slice(prover.indexOf('async function viaBoard'), prover.indexOf('export async function proveSealed'));

test('viaBoard wiring: the breaker is asked before the board and told after it; a refused op is thrown, only a board miss goes on to the network', () => {
  assert.ok(viaBoard.length > 200, 'viaBoard is there to read');
  assert.ok(/const resting = boardBreaker\.resting\(label\)/.test(viaBoard) && /return \{ proof: null, spentMs: 0 \}/.test(viaBoard.slice(viaBoard.indexOf('resting'))), 'a resting type skips the board at no cost');
  assert.ok(viaBoard.indexOf('boardBreaker.resting') < viaBoard.indexOf('lane.prove('), 'and is asked before the job is posted');
  assert.ok(/boardBreaker\.proved\(label\)/.test(viaBoard), 'a board proof clears the count');
  assert.ok(/e\.stalled && boardBreaker\.stalled\(label\)/.test(viaBoard), 'only a claimed-and-silent miss counts');
  assert.ok(/if \(e\.code !== 'board_miss'\) throw e/.test(viaBoard), 'an op_refused error is thrown, never turned into a network request');
});

test('verifySettle hands an op refusal on as op:<name> <selector>, and the knobs are in the config', () => {
  assert.ok(/verdict === 'op' \? `op:\$\{effect\.name\} \$\{effect\.selector\}`/.test(prover), 'verifySettle answers op:Name 0xselector');
  const cfg = readFileSync(new URL('../src/lib/config.js', import.meta.url), 'utf8');
  assert.ok(/proverBoardBreakerStalls: num\('PROVER_BOARD_BREAKER_STALLS', 3\)/.test(cfg) && /proverBoardBreakerSecs: num\('PROVER_BOARD_BREAKER_SECS', 600\)/.test(cfg));
});
