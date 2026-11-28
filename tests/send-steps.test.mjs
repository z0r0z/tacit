// A send inside the pool says what it is doing in steps (dapp/index.html sendStep, noteFor, stealthSendNow).
//
// 2026-11-19: sending tETH showed one sentence at a time ("Splitting a note to 0.001 tETH first…", then "Locking it to a one-time address…") with nothing to say there were two
// things to wait for. A send that must first cut a note of the exact size is two steps (a split, then the lock), each a proof and a settle; one with the note in hand is one step and
// says none.
//
// Run: node tests/send-steps.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { frontPage } from './lib/front-page.mjs';

const page = frontPage(join(dirname(fileURLToPath(import.meta.url)), '..', 'dapp/index.html'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = (label, fn) => { try { fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };
const between = (from, to) => { const a = page.indexOf(from), b = page.indexOf(to, a); if (a < 0 || b < 0) throw new Error(`cannot find ${JSON.stringify(from)}`); return page.slice(a, b); };

const sendStep = new Function(`${between('const sendStep =', 'async function noteFor')}\nreturn sendStep;`)();

test('a send that must split first is "Step 1 of 2" then "Step 2 of 2"', () => {
  ok(sendStep(true, 1) === 'Step 1 of 2 · ' && sendStep(true, 2) === 'Step 2 of 2 · ', `${sendStep(true, 1)} / ${sendStep(true, 2)}`);
});

test('a send with the note in hand says no step at all', () => {
  ok(sendStep(false, 1) === '' && sendStep(false, 2) === '', 'a one-step send was numbered');
});

test('the split line carries its step, and the lock line carries the next one', () => {
  const nf = between('async function noteFor(', 'const inUse =');
  ok(/run\.say\(status, `\$\{stepNote\}\$\{doing\}…`\);/.test(nf), 'noteFor does not put the step on its line');
  ok(/stepNote = ''\) \{/.test(nf), 'noteFor must keep working for every other caller with no step');
  const sn = between('async function stealthSendNow(', 'async function assetOutNow(');
  ok(/const split = !!P\.scan\?\.\[k\]\?\.notes && !freeNotes\(P\.scan\[k\]\.notes\)\.some\(\(n\) => BigInt\(n\.value\) === units\);/.test(sn), 'the split is not worked out from the notes held');
  ok(/noteFor\(run, t, priv, units, \(n\) => BigInt\(n\.value\) === units, status, k, sendStep\(split, 1\)\)/.test(sn), 'the split step is not passed to noteFor');
  ok(/run\.say\(status, `\$\{sendStep\(split, 2\)\}Locking it to a one-time address only they can open…`\)/.test(sn), 'the lock line has no step');
});

test('no other caller of noteFor is numbered by this change', () => {
  const callers = page.split('\n').filter((l) => /\bnoteFor\(run,/.test(l) && !/^async function/.test(l.trim()));
  ok(callers.length >= 2, `callers ${callers.length}`);
  ok(callers.filter((l) => /sendStep\(/.test(l)).length === 1, 'only the pool send passes a step');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
