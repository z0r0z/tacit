#!/usr/bin/env node
// Splits validated items into DEV (look at them, tune on them) and SEALED (only ever scored, never read while
// improving a prompt, a harness or a model choice), and writes a summary.
//
//   node tools/yardstick/split.mjs validated.jsonl OUTDIR
//
// The split is by a hash of the commit id, so it never changes when items are added: an item that was sealed
// stays sealed. Each file carries only what a solver may see; the reference fix is the commit itself and is
// never copied in.
//
// Two ways to pose an item:
//   tests-given  the solver sees the failing tests and must make them pass without editing them
//                (a red CI run: easiest, and the most mechanical)
//   symptom      the solver sees only the one-line request; the tests are hidden and grade the result
//                (a Discord request: what the bot will really get). Not offered when the test needs a symbol the
//                fix introduces (failKind 'api-shape'): nobody could guess its name.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [inFile, outDir] = process.argv.slice(2);
if (!inFile || !outDir) { console.error('usage: split.mjs validated.jsonl OUTDIR'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const items = readFileSync(inFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sealed = (id) => createHash('sha256').update(`tacit-yardstick-v1:${id}`).digest()[0] < 128;

const view = (c) => ({
  id: c.id, parent: c.parent, commit: c.commit, date: c.date, kind: c.kind,
  request: c.subject,                              // the one line a person would have written
  tests: c.failingTests,                           // graded by these, run on the solver's result
  overlay: c.tests,                                // every test file the commit changed (put on top of the result before grading)
  modes: c.failKind === 'api-shape' ? ['tests-given'] : ['tests-given', 'symptom'],
  failOut: c.failOut,                              // what the tests print on the parent (tests-given mode)
  scope: c.src,                                    // where the reference fix changed code: for scoring only, never shown
  srcLines: c.srcLines,
});
const dev = items.filter((c) => !sealed(c.id)).map(view);
const seal = items.filter((c) => sealed(c.id)).map(view);
const w = (name, rows) => writeFileSync(`${outDir}/${name}`, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
w('dev.jsonl', dev); w('sealed.jsonl', seal);

const count = (rows, f) => rows.filter(f).length;
const line = (name, rows) => `${name}: ${rows.length} items | fix ${count(rows, (r) => r.kind === 'fix')} change ${count(rows, (r) => r.kind === 'change')} | symptom-mode ${count(rows, (r) => r.modes.includes('symptom'))} | median reference size ${[...rows.map((r) => r.srcLines)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? '-'} lines`;
const summary = [line('dev', dev), line('sealed', seal)].join('\n');
writeFileSync(`${outDir}/SUMMARY.txt`, summary + '\n');
console.log(summary);
