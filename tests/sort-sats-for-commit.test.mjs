// Unit test for sortSatsForCommit() — the sats UTXO ordering helper
// used at every commit-tx coin-selection site.
//
// Contract:
//   confirmed UTXOs come before unconfirmed
//   within each confirmation class, largest-value first
//   stable for ties (Array.prototype.sort isn't strictly stable but the
//   ordering rule is total so ties don't matter for correctness)
//   returns a new array (does not mutate the input)
//
// Reliability impact: with the previous value-only sort, a wallet
// holding a large unconfirmed UTXO + several small confirmed ones
// would consume the unconfirmed one first, inheriting that tx's
// mempool ancestor chain. Signet faucets routinely chain 25+ deep —
// confirmed-first prevents that cascade on every commit broadcast.

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

const C = (v) => ({ value: v, status: { confirmed: true } });
const U = (v) => ({ value: v, status: { confirmed: false } });
const M = (v) => ({ value: v });  // missing status object

group('Basic ordering');
{
  // All confirmed: largest first
  const r1 = dapp.sortSatsForCommit([C(100), C(300), C(200)]);
  ok('all confirmed → desc by value', r1.map(u => u.value).join(',') === '300,200,100');

  // All unconfirmed: largest first
  const r2 = dapp.sortSatsForCommit([U(100), U(300), U(200)]);
  ok('all unconfirmed → desc by value', r2.map(u => u.value).join(',') === '300,200,100');

  // Mixed: confirmed first, then unconfirmed; each desc by value
  const r3 = dapp.sortSatsForCommit([U(500), C(100), U(50), C(300), U(200)]);
  ok('mixed → confirmed desc, then unconfirmed desc',
    r3.map(u => u.value).join(',') === '300,100,500,200,50');
}

group('Confirmed UTXO beats larger unconfirmed (the avoid-mempool-chain win)');
{
  const r = dapp.sortSatsForCommit([U(1_000_000), C(100), C(50)]);
  // Even with a 1M unconfirmed UTXO and tiny confirmed ones, confirmed
  // should be picked first so the commit doesn't inherit the unconfirmed
  // ancestor's mempool position.
  ok('first picked is confirmed, not the larger unconfirmed',
    r[0].status.confirmed === true && r[0].value === 100);
  ok('second picked is the next confirmed',
    r[1].status.confirmed === true && r[1].value === 50);
  ok('unconfirmed only used as fallback', r[2].status.confirmed === false);
}

group('Missing status object (treated as unconfirmed — fail-safe)');
{
  // Some Esplora variants don't return the status object until first
  // confirmation. We treat any non-true confirmed flag as unconfirmed
  // so the picker errs on the side of NOT trusting a UTXO until we
  // see status.confirmed === true.
  const r = dapp.sortSatsForCommit([M(500), C(100), M(200)]);
  ok('missing-status acts like unconfirmed (confirmed wins)',
    r[0].value === 100 && r[0].status.confirmed === true);
  // Among the missing-status ones, larger first
  ok('missing-status fallback: 500 before 200',
    r[1].value === 500 && r[2].value === 200);
}

group('Input is not mutated');
{
  const input = [U(500), C(100), U(50), C(300)];
  const snapshot = input.map(u => u.value).join(',');
  const out = dapp.sortSatsForCommit(input);
  ok('input array unchanged after sort', input.map(u => u.value).join(',') === snapshot);
  ok('output is a new array', out !== input);
}

group('Edge inputs');
{
  ok('empty array → empty', dapp.sortSatsForCommit([]).length === 0);
  ok('null → empty', dapp.sortSatsForCommit(null).length === 0);
  ok('undefined → empty', dapp.sortSatsForCommit(undefined).length === 0);
  const single = dapp.sortSatsForCommit([C(42)]);
  ok('single-element → returns single', single.length === 1 && single[0].value === 42);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
