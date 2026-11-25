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
  assert.equal(applyEnv(BASE, { FB_LP_MAILBOX_POLL_SECS: '1' }).mailboxPollSecs, 1); assert.equal(applyEnv(BASE, { FB_LP_MAILBOX_POLL_SECS: '2.5' }).mailboxPollSecs, 2.5);
  assert.equal('mailboxPollSecs' in applyEnv(BASE, {}), false, 'unset leaves the daemon\'s own default (3 s)');
  assert.equal(applyEnv(BASE, { FB_LP_NAME: 'x'.repeat(80) }).name.length, 40, 'a name is kept to what the ad takes');
});

test('the switch: a most below the least is taken as it is (the provider then quotes nothing and finishes its open swaps)', () => {
  const c = applyEnv(BASE, { FB_LP_MAX_AMOUNT: '0' });
  assert.equal(c.quote.maxAmount, '0'); assert.ok(BigInt(c.quote.maxAmount) < BigInt(c.quote.minAmount));
});

test('a value that is set and is not valid stops the start, naming it', () => {
  for (const [env, name] of [[{ PORT: 'abc' }, 'PORT'], [{ PORT: '70000' }, 'PORT'], [{ FB_LP_MAX_AMOUNT: '1000.5' }, 'FB_LP_MAX_AMOUNT'], [{ FB_LP_MAX_AMOUNT: '-1' }, 'FB_LP_MAX_AMOUNT'], [{ FB_LP_MIN_AMOUNT: '10 TAC' }, 'FB_LP_MIN_AMOUNT'], [{ FB_LP_FEE_BPS: '600' }, 'FB_LP_FEE_BPS'], [{ FB_LP_FEE_BPS: '0.3' }, 'FB_LP_FEE_BPS'], [{ FB_LP_FLAT_FEE: 'x' }, 'FLAT_FEE'], [{ FB_LP_MAILBOX_POLL_SECS: '0' }, 'MAILBOX_POLL'], [{ FB_LP_MAILBOX_POLL_SECS: '0.5' }, 'MAILBOX_POLL'], [{ FB_LP_MAILBOX_POLL_SECS: '60' }, 'MAILBOX_POLL'], [{ FB_LP_MAILBOX_POLL_SECS: 'fast' }, 'MAILBOX_POLL']]) {
    assert.throws(() => applyEnv(BASE, env), (e) => e.message.includes(name), JSON.stringify(env));
  }
});

test('the Bitcoin explorers can be set: https only, in the order given, a trailing slash dropped, and a bad value never echoes the (possibly keyed) URL', () => {
  const c = applyEnv({ ...BASE, btcBases: ['https://old.example/api'] }, { FB_LP_BTC_BASES: ' https://keyed.example/v1/KEY/api/ , https://mempool.space/api, ' });
  assert.deepEqual(c.btcBases, ['https://keyed.example/v1/KEY/api', 'https://mempool.space/api']);
  assert.deepEqual(applyEnv({ ...BASE, btcBases: ['https://old.example/api'] }, {}).btcBases, ['https://old.example/api'], 'unset: the config\'s list stands');
  assert.deepEqual(applyEnv({ ...BASE, btcBases: ['https://old.example/api'] }, { FB_LP_BTC_BASES: '  ' }).btcBases, ['https://old.example/api'], 'blank is unset');
  for (const bad of ['http://plain.example/api', 'mempool.space/api', 'https://', 'https://ok.example/api, ftp://x', ',']) {
    assert.throws(() => applyEnv(BASE, { FB_LP_BTC_BASES: bad }), (e) => e.message.includes('FB_LP_BTC_BASES') && !e.message.includes('plain.example') && !e.message.includes('ftp'), bad);
  }
});

test('the reverse side: off unless asked for, each knob in its own field, a config\'s values kept, and a value that is set and is not valid stops the start', () => {
  assert.equal('reverse' in applyEnv(BASE, {}), false, 'unset: nothing about it is in the config, so it is off');
  assert.equal(applyEnv(BASE, { FB_LP_REVERSE: 'off' }).reverse.enabled, false);
  assert.equal(applyEnv(BASE, { FB_LP_REVERSE: ' ON ' }).reverse.enabled, true);
  const c = applyEnv(BASE, { FB_LP_REVERSE: 'on', FB_LP_REVERSE_FEE_BPS: '45', FB_LP_REVERSE_FLAT_FEE: '20000000', FB_LP_REVERSE_MIN_AMOUNT: '2000000000', FB_LP_REVERSE_MAX_AMOUNT: '5000000000', FB_LP_REVERSE_MAX_OPEN: '3', FB_LP_REVERSE_MAX_TAC: '1500.5' });
  assert.deepEqual(c.reverse, { enabled: true, feeBps: 45, flatFee: '20000000', minAmount: '2000000000', maxAmount: '5000000000', maxOpen: 3, maxTac: '1500.5' });
  assert.deepEqual(c.quote, BASE.quote, 'the forward terms are not the reverse ones');
  assert.deepEqual(applyEnv({ ...BASE, reverse: { enabled: true, feeBps: 10, maxOpen: 5 } }, { FB_LP_REVERSE_MAX_OPEN: '4' }).reverse, { enabled: true, feeBps: 10, maxOpen: 4 }, 'a knob over a config keeps the config\'s other values, and does not switch it on');
  for (const [env, name] of [[{ FB_LP_REVERSE: 'yes' }, 'FB_LP_REVERSE'], [{ FB_LP_REVERSE: '1' }, 'FB_LP_REVERSE'], [{ FB_LP_REVERSE_FEE_BPS: '501' }, 'REVERSE_FEE_BPS'], [{ FB_LP_REVERSE_FEE_BPS: '0.5' }, 'REVERSE_FEE_BPS'], [{ FB_LP_REVERSE_FLAT_FEE: '-1' }, 'REVERSE_FLAT_FEE'], [{ FB_LP_REVERSE_MIN_AMOUNT: '1e9' }, 'REVERSE_MIN_AMOUNT'], [{ FB_LP_REVERSE_MAX_AMOUNT: '1.5' }, 'REVERSE_MAX_AMOUNT'], [{ FB_LP_REVERSE_MAX_OPEN: '0' }, 'REVERSE_MAX_OPEN'], [{ FB_LP_REVERSE_MAX_OPEN: '21' }, 'REVERSE_MAX_OPEN'], [{ FB_LP_REVERSE_MAX_OPEN: '2.5' }, 'REVERSE_MAX_OPEN'], [{ FB_LP_REVERSE_MAX_TAC: '0' }, 'REVERSE_MAX_TAC'], [{ FB_LP_REVERSE_MAX_TAC: '-5' }, 'REVERSE_MAX_TAC'], [{ FB_LP_REVERSE_MAX_TAC: '1.123456789' }, 'REVERSE_MAX_TAC'], [{ FB_LP_REVERSE_MAX_TAC: '1,000' }, 'REVERSE_MAX_TAC'], [{ FB_LP_REVERSE_MAX_TAC: 'lots' }, 'REVERSE_MAX_TAC']]) {
    assert.throws(() => applyEnv(BASE, env), (e) => e.message.includes(name), JSON.stringify(env));
  }
  const before = JSON.stringify(BASE); applyEnv(BASE, { FB_LP_REVERSE: 'on' }); assert.equal(JSON.stringify(BASE), before, 'the config handed in is not changed');
});

test('reverse proceeds and fee limits override exactly, do not switch reverse on, and reject invalid values', () => {
  const c = applyEnv(BASE, { FB_LP_REVERSE_MIN_PROCEEDS_BPS: ' 10500 ', FB_LP_REVERSE_MAX_FEE_RATE: '2.5' });
  assert.deepEqual(c.reverse, { minProceedsBps: 10500, maxFeeRate: 2.5 });
  assert.equal(c.reverse.enabled, undefined, 'a limit is not the enable switch');
  assert.equal(applyEnv(BASE, { FB_LP_REVERSE_MAX_FEE_RATE: '.5' }).reverse.maxFeeRate, 0.5);
  const configured = { ...BASE, reverse: { enabled: false, feeBps: 40, rebalance: { enabled: true, maxDailyTac: '25' } } };
  assert.deepEqual(applyEnv(configured, { FB_LP_REVERSE_MIN_PROCEEDS_BPS: '', FB_LP_REVERSE_MAX_FEE_RATE: ' ' }), configured, 'blank limits leave the whole nested config unchanged');
  for (const [env, name] of [
    [{ FB_LP_REVERSE_MIN_PROCEEDS_BPS: '9999' }, 'MIN_PROCEEDS_BPS'], [{ FB_LP_REVERSE_MIN_PROCEEDS_BPS: '1000001' }, 'MIN_PROCEEDS_BPS'],
    [{ FB_LP_REVERSE_MIN_PROCEEDS_BPS: '10000.5' }, 'MIN_PROCEEDS_BPS'], [{ FB_LP_REVERSE_MIN_PROCEEDS_BPS: '1e4' }, 'MIN_PROCEEDS_BPS'],
    [{ FB_LP_REVERSE_MAX_FEE_RATE: '0' }, 'REVERSE_MAX_FEE_RATE'], [{ FB_LP_REVERSE_MAX_FEE_RATE: '-1' }, 'REVERSE_MAX_FEE_RATE'],
    [{ FB_LP_REVERSE_MAX_FEE_RATE: '1e2' }, 'REVERSE_MAX_FEE_RATE'], [{ FB_LP_REVERSE_MAX_FEE_RATE: 'Infinity' }, 'REVERSE_MAX_FEE_RATE'],
    [{ FB_LP_REVERSE_MAX_FEE_RATE: 'fast' }, 'REVERSE_MAX_FEE_RATE'],
  ]) assert.throws(() => applyEnv(BASE, env), (e) => e.message.includes(name), JSON.stringify(env));
});

test('rebalance environment settings parse exactly and neither switch enables the other side', () => {
  const env = {
    FB_LP_REBALANCE: ' ON ', FB_LP_REBALANCE_LEASES: ' /var/lib/lp/rebalance-leases.json ',
    FB_LP_REBALANCE_MAX_NOTE_TAC: '0.00000001', FB_LP_REBALANCE_MAX_DAILY_TAC: '1500.12345678', FB_LP_REBALANCE_MAX_INVENTORY_TAC: '2000', FB_LP_REBALANCE_MAX_STUCK_TAC: '2500.00000001',
    FB_LP_REBALANCE_MAX_FEE_RATE: '3.25', FB_LP_REBALANCE_MIN_SOURCE_CONFS: '6', FB_LP_REBALANCE_STALL_SECS: '45',
  };
  const c = applyEnv(BASE, env);
  assert.deepEqual(c.reverse, { rebalance: {
    enabled: true, leases: '/var/lib/lp/rebalance-leases.json', maxNoteTac: '0.00000001', maxDailyTac: '1500.12345678', maxInventoryTac: '2000', maxStuckTac: '2500.00000001',
    maxFeeRate: 3.25, minSourceConfs: 6, stallSecs: 45,
  } });
  assert.equal(c.reverse.enabled, undefined, 'rebalance on does not switch reverse on');
  assert.deepEqual(c.quote, BASE.quote, 'the forward terms are untouched');
  const both = { ...BASE, reverse: { enabled: true, feeBps: 35, rebalance: { enabled: true, maxDailyTac: '75', tickSecs: 30 } } };
  assert.deepEqual(applyEnv(both, { FB_LP_REVERSE: 'off' }).reverse, { enabled: false, feeBps: 35, rebalance: { enabled: true, maxDailyTac: '75', tickSecs: 30 } }, 'reverse off leaves rebalance available for a dry-run sidecar');
  assert.deepEqual(applyEnv(both, { FB_LP_REBALANCE: 'off' }).reverse, { enabled: true, feeBps: 35, rebalance: { enabled: false, maxDailyTac: '75', tickSecs: 30 } }, 'rebalance off does not switch reverse off');
  assert.deepEqual(applyEnv(both, { FB_LP_REBALANCE_MAX_NOTE_TAC: '12.5' }).reverse.rebalance, { enabled: true, maxNoteTac: '12.5', maxDailyTac: '75', tickSecs: 30 }, 'one override keeps the other nested settings');
  assert.deepEqual(applyEnv(both, {}), both, 'unset leaves configured values alone');
  assert.deepEqual(applyEnv(both, { FB_LP_REBALANCE_LEASES: '  ' }), both, 'a blank path is unset, not a new path');
});

test('every invalid rebalance environment value fails startup and names its variable', () => {
  const bad = [
    ['FB_LP_REBALANCE', 'yes'], ['FB_LP_REBALANCE', '1'],
    ['FB_LP_REBALANCE_MAX_FEE_RATE', '0'], ['FB_LP_REBALANCE_MAX_FEE_RATE', '-2'], ['FB_LP_REBALANCE_MAX_FEE_RATE', '1e2'], ['FB_LP_REBALANCE_MAX_FEE_RATE', 'NaN'],
    ['FB_LP_REBALANCE_MIN_SOURCE_CONFS', '0'], ['FB_LP_REBALANCE_MIN_SOURCE_CONFS', '-1'], ['FB_LP_REBALANCE_MIN_SOURCE_CONFS', '1.5'], ['FB_LP_REBALANCE_MIN_SOURCE_CONFS', '1001'],
    ['FB_LP_REBALANCE_STALL_SECS', '0'], ['FB_LP_REBALANCE_STALL_SECS', '-1'], ['FB_LP_REBALANCE_STALL_SECS', '2.5'], ['FB_LP_REBALANCE_STALL_SECS', '86401'],
  ];
  for (const key of ['FB_LP_REBALANCE_MAX_NOTE_TAC', 'FB_LP_REBALANCE_MAX_DAILY_TAC', 'FB_LP_REBALANCE_MAX_INVENTORY_TAC', 'FB_LP_REBALANCE_MAX_STUCK_TAC']) {
    for (const value of ['0', '0.00000000', '-1', '1.123456789', '1.', '.5', '1e2', 'lots']) bad.push([key, value]);
  }
  for (const [key, value] of bad) assert.throws(() => applyEnv(BASE, { [key]: value }), (e) => e.message.includes(key), `${key}=${value}`);
});

let passed = 0;
for (const [name, fn] of tests) { try { fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} provider env checks passed`);
process.exit(process.exitCode || 0);
