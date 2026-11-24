// dapp/rescan-gate.js: when opening the Bitcoin sheet looks again for shielded TAC sent to the open key.
import { makeRescanGate } from '../dapp/rescan-gate.js';

let fails = 0;
const ok = (c, m) => { if (c) console.log('ok  ', m); else { fails++; console.log('FAIL', m); } };

let t = 1_000_000;
const gate = () => makeRescanGate({ every: 600e3, retry: 120e3, now: () => t });
const A = '02' + 'aa'.repeat(32), B = '03' + 'bb'.repeat(32);
const run = (g, p, failed = false) => { g.begin(p); g.end(failed); };

{
  const g = gate();
  ok(g.next(A) === 'rescan', 'a key that has had its first look is looked at again on open');
  ok(g.next(A, { searched: false }) === 'deep', 'a key that has not had its first look gets that look instead');
  ok(g.next(null) === null && g.next('') === null, 'with no key open there is nothing to look for');
  ok(g.next(A, { looking: true }) === null && g.next(A, { searched: false, looking: true }) === null, 'a look already running elsewhere is not doubled');
}
{
  const g = gate();
  t = 0; run(g, A);
  t = 599e3; ok(g.next(A) === null, 'not again within ten minutes');
  t = 600e3; ok(g.next(A) === 'rescan', 'again once ten minutes have passed');
  ok(g.next(B) === 'rescan', 'another key is not held back by the first');
}
{
  const g = gate();
  t = 0; g.begin(A);
  ok(g.running && g.next(A) === null && g.next(B) === null, 'while one look runs no other starts, for any key');
  g.end(false);
  ok(!g.running && g.next(A) === null, 'it ends, and the key waits out the ten minutes from when it began');
}
{
  const g = gate();
  t = 0; run(g, A, true);
  t = 119e3; ok(g.next(A) === null, 'after a look that could not read every transfer, not within two minutes');
  t = 120e3; ok(g.next(A) === 'rescan', 'but again after two, not ten');
}
{
  const g = gate();
  t = 0; g.begin(A); t = 700e3; g.end(true);
  ok(g.next(A) === null && (t = 700e3 + 120e3, g.next(A) === 'rescan'), 'a long look that failed rests two minutes from when it ended');
}
{
  const g = makeRescanGate();
  ok(g.next(A) === 'rescan' && (g.begin(A), g.end(false), g.next(A) === null), 'the defaults read the clock and wait');
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
