#!/usr/bin/env node
// Keeps the candidates whose test really separates the fix from the bug.
//
//   WORK=/tmp/ys/repo node tools/yardstick/validate.mjs candidates.jsonl validated.jsonl [--limit N] [--kind fix|change|all] [--timeout 45]
//
// For each candidate commit C with parent P:
//   1. run C's changed tests on C            -> must PASS (if not, the test needs something this box does not have)
//   2. run the same tests on P + C's tests    -> at least one must FAIL (that is the bug, or the missing feature)
//   3. run both once more                     -> the same answers (no flaky tests)
// Tests run offline (tools/noweb.cjs), at low priority, one at a time, with HOME pointed at a scratch folder.
// Resumable: ids already in the output file are skipped. Appends one JSON line per candidate that validated, and
// one line per rejection to <out>.rejected.jsonl with the reason.
import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = process.env.WORK;
if (!WORK || !existsSync(join(WORK, '.git'))) { console.error('set WORK to a clone made by clone.sh'); process.exit(2); }
const NOWEB = process.env.NOWEB || resolve(HERE, '..', 'noweb.cjs');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const [inFile, outFile] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const LIMIT = Number(flag('--limit', 1e9));
const KIND = flag('--kind', 'all');
const TIMEOUT = Number(flag('--timeout', 45)) * 1000;
const HOME = resolve(WORK, '..', 'home'); mkdirSync(HOME, { recursive: true });

const git = (...a) => spawnSync('git', ['-C', WORK, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
const checkout = (rev) => { const r = git('checkout', '-q', '-f', '--detach', rev); git('clean', '-fdq', '-e', 'node_modules'); return r.status === 0; };
// Tests that need a browser, a forked chain or the live network cannot be a yardstick on a laptop or a runner.
const HEAVY = /playwright|puppeteer|chromium|launchPersistentContext|anvil|--fork-url|foundry|\bforge\b/i;

function run(file) {
  const t0 = Date.now();
  const r = spawnSync('nice', ['-n', '10', process.execPath, '--require', NOWEB, file], {
    cwd: WORK, encoding: 'utf8', timeout: TIMEOUT, killSignal: 'SIGKILL', maxBuffer: 32 << 20,
    env: { ...process.env, CI: '1', HOME, NODE_NO_WARNINGS: '1' },
  });
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  return { file, ok: r.status === 0 && !timedOut, timedOut: !!timedOut, ms: Date.now() - t0, tail: text.split('\n').slice(-40).join('\n').slice(-1800) };
}
const runAll = (files) => files.map(run);
const failKind = (txt) => /ERR_MODULE_NOT_FOUND|Cannot find module|does not provide an export named|ERR_PACKAGE_PATH_NOT_EXPORTED/.test(txt) ? 'api-shape' : 'behavior';

const done = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
const rejFile = `${outFile}.rejected.jsonl`;
const rejDone = new Set(existsSync(rejFile) ? readFileSync(rejFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
const rows = readFileSync(inFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((c) => (KIND === 'all' || c.kind === KIND) && !done.has(c.id) && !rejDone.has(c.id)).slice(0, LIMIT);
const reject = (c, why, extra = {}) => { appendFileSync(rejFile, JSON.stringify({ id: c.id, why, ...extra }) + '\n'); console.log(`  - ${c.id} ${why}`); };

let nOk = 0, nRej = 0; const t00 = Date.now();
for (const [i, c] of rows.entries()) {
  console.log(`[${i + 1}/${rows.length}] ${c.id} ${c.date} ${c.kind} ${c.subject.slice(0, 70)}`);
  if (!checkout(c.commit)) { reject(c, 'checkout-failed'); nRej++; continue; }
  const present = c.runTests.filter((f) => existsSync(join(WORK, f)));
  if (!present.length) { reject(c, 'test-file-missing'); nRej++; continue; }
  const heavy = present.find((f) => HEAVY.test(readFileSync(join(WORK, f), 'utf8')));
  if (heavy) { reject(c, 'heavy-test', { file: heavy }); nRej++; continue; }

  const fixRun = runAll(present);
  const bad = fixRun.find((r) => !r.ok);
  if (bad) { reject(c, bad.timedOut ? 'fix-run-timeout' : 'fix-run-fails', { file: bad.file, tail: bad.tail.slice(-400) }); nRej++; continue; }

  if (!checkout(c.parent)) { reject(c, 'checkout-parent-failed'); nRej++; continue; }
  for (const f of c.tests) git('checkout', '-q', c.commit, '--', f);          // C's tests (and fixtures) onto the parent
  const parRun = runAll(present);
  const failed = parRun.filter((r) => !r.ok && !r.timedOut);
  if (!failed.length) { reject(c, parRun.some((r) => r.timedOut) ? 'parent-run-timeout' : 'parent-passes'); nRej++; continue; }

  const par2 = runAll(failed.map((r) => r.file));                              // same answer again?
  if (par2.some((r) => r.ok)) { reject(c, 'flaky-on-parent'); nRej++; continue; }
  checkout(c.commit);
  const fix2 = runAll(present);
  if (fix2.some((r) => !r.ok)) { reject(c, 'flaky-on-fix'); nRej++; continue; }

  const txt = failed.map((r) => r.tail).join('\n');
  const rec = {
    ...c, failingTests: failed.map((r) => r.file), failKind: failKind(txt),
    failOut: failed[0].tail.slice(-1500), passMs: fixRun.reduce((n, r) => n + r.ms, 0),
  };
  appendFileSync(outFile, JSON.stringify(rec) + '\n'); nOk++;
  console.log(`  + validated (${rec.failKind}, ${rec.failingTests.length} failing test file(s), ${rec.passMs} ms)`);
}
checkout('ys-main');
console.log(`done: ${nOk} validated, ${nRej} rejected, ${Math.round((Date.now() - t00) / 1000)} s`);
