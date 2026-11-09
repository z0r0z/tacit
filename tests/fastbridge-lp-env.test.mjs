// What an operator can set in the environment of the fast bridge provider (fastbridge-lp/lib/env-config.mjs): the knobs over the config file,
// and a value that is not valid stops the process at start instead of being guessed at.
//   node tests/fastbridge-lp-env.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { applyEnv } from '../fastbridge-lp/lib/env-config.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const BASE = { port: 8787, dataDir: 'fastbridge-lp/data', name: 'Tacit', boards: ['https://a.example'], quote: { minAmount: '1000000000', maxAmount: '100000000000', feeBps: 30, flatFee: '10000000', validSecs: 600 } };

test('nothing set leaves the config as it is, and the config given is not changed', () => {
  const before = JSON.stringify(BASE);
  assert.deepEqual(applyEnv(BASE, {}), BASE);
  assert.deepEqual(applyEnv(BASE, { PORT: '', FB_LP_NAME: '  ', FB_LP_MAX_AMOUNT: '' }), BASE, 'a variable that is empty is not set');
  applyEnv(BASE, { FB_LP_MAX_AMOUNT: '5', PORT: '1' });
  assert.equal(JSON.stringify(BASE), before);
});

test('each knob sets its own field and no other', () => {
  const c = applyEnv(BASE, { PORT: '10000', FB_LP_DATA_DIR: '/var/lib/lp', FB_LP_NAME: 'House', FB_LP_BOARDS: 'https://b.example, https://c.example,', FB_LP_MIN_AMOUNT: '2000000000', FB_LP_MAX_AMOUNT: '50000000000', FB_LP_FEE_BPS: '25', FB_LP_FLAT_FEE: '5000000' });
  assert.deepEqual([c.port, c.dataDir, c.name, c.boards], [10000, '/var/lib/lp', 'House', ['https://b.example', 'https://c.example']]);
  assert.deepEqual(c.quote, { minAmount: '2000000000', maxAmount: '50000000000', feeBps: 25, flatFee: '5000000', validSecs: 600 });
  assert.deepEqual(applyEnv(BASE, { FB_LP_BOARDS: '' }).boards, [], 'an empty list takes the boards off');
  assert.equal(applyEnv(BASE, { FB_LP_NAME: 'x'.repeat(80) }).name.length, 40, 'a name is kept to what the ad takes');
});

test('the switch: a most below the least is taken as it is (the provider then quotes nothing and finishes its open swaps)', () => {
  const c = applyEnv(BASE, { FB_LP_MAX_AMOUNT: '0' });
  assert.equal(c.quote.maxAmount, '0'); assert.ok(BigInt(c.quote.maxAmount) < BigInt(c.quote.minAmount));
});

test('a value that is set and is not valid stops the start, naming it', () => {
  for (const [env, name] of [[{ PORT: 'abc' }, 'PORT'], [{ PORT: '70000' }, 'PORT'], [{ FB_LP_MAX_AMOUNT: '1000.5' }, 'FB_LP_MAX_AMOUNT'], [{ FB_LP_MAX_AMOUNT: '-1' }, 'FB_LP_MAX_AMOUNT'], [{ FB_LP_MIN_AMOUNT: '10 TAC' }, 'FB_LP_MIN_AMOUNT'], [{ FB_LP_FEE_BPS: '600' }, 'FB_LP_FEE_BPS'], [{ FB_LP_FEE_BPS: '0.3' }, 'FB_LP_FEE_BPS'], [{ FB_LP_FLAT_FEE: 'x' }, 'FLAT_FEE']]) {
    assert.throws(() => applyEnv(BASE, env), (e) => e.message.includes(name), JSON.stringify(env));
  }
});

let passed = 0;
for (const [name, fn] of tests) { try { fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} provider env checks passed`);
process.exit(process.exitCode || 0);
