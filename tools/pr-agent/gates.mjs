// The gates between what the agent did and a person's time. Everything here is mechanical: a patch reaches a human only if every gate passes, and a patch that fails one is
// reported as a suggestion (what was found, which gate said no), never as a PR. Nothing here asks a model anything.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { NO_WRITE, NO_READ, isTestPath, makeHands, scrubbedEnv } from './engine.mjs';

export const DEFAULTS = { maxFiles: 5, maxLines: 150, maxRelated: 6, requireFailBefore: true };
const isRunnableTest = (p) => isTestPath(p) && /\.m?js$/.test(p) && !/(^|\/)(lib|fixtures?|helpers?|data)\//.test(p) && !/(^|\/)_/.test(p.split('/').pop());

// Syntax of one changed file as the code that runs it reads it: dapp/*.js are browser ES modules, which `node --check` on a .js file would read as CommonJS, so it is checked as .mjs.
function syntaxOf(repo, rel) {
  const tmp = mkdtempSync(join(tmpdir(), 'prg-')); const f = join(tmp, rel.endsWith('.cjs') ? 'x.cjs' : 'x.mjs');
  try { writeFileSync(f, readFileSync(join(repo, rel))); const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); return { ok: r.status === 0, note: (r.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 220) }; }
  finally { rmSync(tmp, { recursive: true, force: true }); }
}

// checkPatch: the model's edits are in the working tree (not committed); HEAD is the base. -> { ok, gates:[{gate, ok, note}], patch, files, lines, weakTest }
export function checkPatch({ repo, noweb, buildCmd = '', limits = {}, say = () => {} }) {
  const L = { ...DEFAULTS, ...limits };
  const { runTest, git } = makeHands({ repo, noweb });
  const gates = []; const add = (gate, ok, note = '') => { gates.push({ gate, ok: !!ok, note }); return !!ok; };
  const stage = () => git('add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude)*/node_modules');
  const snapshot = () => { stage(); const names = git('diff', '--cached', '--name-only').stdout.split('\n').filter(Boolean);
    const rows = git('diff', '--cached', '--numstat').stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
    return { names, rows, lines: rows.reduce((n, r) => n + (Number(r[0]) || 0) + (Number(r[1]) || 0), 0), binary: rows.filter((r) => r[0] === '-').map((r) => r[2]), patch: git('diff', '--cached', '--no-color').stdout || '' }; };

  let snap = snapshot();
  if (!add('has a change', snap.names.length > 0, snap.names.length ? `${snap.names.length} file(s)` : 'nothing was edited')) return { ok: false, gates, patch: '', files: [], lines: 0, weakTest: false };
  const refuse = snap.names.filter((p) => NO_WRITE.test(p) || NO_READ.test(p));
  const ok1 = add('stays out of protected files', !refuse.length && !snap.binary.length, refuse.length ? `touches ${refuse.slice(0, 3).join(', ')}` : snap.binary.length ? `binary change: ${snap.binary[0]}` : '');
  const ok2 = add('small', snap.names.length <= L.maxFiles && snap.lines <= L.maxLines, `${snap.names.length} file(s), ${snap.lines} changed lines (limits ${L.maxFiles} / ${L.maxLines})`);
  const code = snap.names.filter((p) => /\.(m?js|cjs)$/.test(p) && existsSync(join(repo, p)));
  const bad = code.map((p) => [p, syntaxOf(repo, p)]).filter(([, r]) => !r.ok);
  const ok3 = add('parses', !bad.length, bad.length ? `${bad[0][0]}: ${bad[0][1].note}` : `${code.length} file(s) checked`);
  const base = { ok: ok1 && ok2 && ok3, weakTest: false };
  if (!base.ok) { for (const g of ['new tests pass', 'new tests fail without the fix', 'related tests still pass', 'build']) add(g, false, 'skipped: an earlier gate failed'); return { ...base, gates, patch: snap.patch, files: snap.names, lines: snap.lines }; }

  const newTests = snap.names.filter((p) => isRunnableTest(p) && existsSync(join(repo, p)));
  const srcChanged = snap.names.filter((p) => !isTestPath(p) && existsSync(join(repo, p)));
  // 1. tests the agent added or changed must pass with its change
  const newRuns = newTests.map((p) => runTest(p));
  add('new tests pass', newRuns.every((r) => r.ok), newTests.length ? newRuns.map((r) => `${r.rel}: ${r.ok ? 'pass' : r.timedOut ? 'timed out' : 'FAIL'}`).join('; ') : 'none added');
  // 2. existing tests that mention the changed files
  const related = new Set();
  for (const p of srcChanged) {
    const r = git('grep', '-l', '-F', '-e', basename(p), '--', 'tests', 'worker-relay/tests', 'helpdesk/*.test.mjs', ':(exclude)tests/lib');
    for (const t of (r.stdout || '').split('\n').filter(Boolean)) if (isRunnableTest(t) && !newTests.includes(t)) related.add(t);
  }
  const relList = [...related].sort().slice(0, L.maxRelated);
  const relRuns = relList.map((t) => runTest(t));
  const relFailed = relRuns.filter((r) => !r.ok);
  // 3. the same source changes put back to the base: a test the agent added must FAIL there (or it proves nothing), and a related test that fails there too was already broken
  let failsOnBase = [], brokenBefore = [];
  if (newTests.length || relFailed.length) {
    const stashed = srcChanged.length && git('stash', 'push', '-q', '--', ...srcChanged).status === 0;
    try {
      failsOnBase = newTests.filter((p) => !runTest(p).ok);
      brokenBefore = relFailed.filter((r) => !runTest(r.rel).ok).map((r) => r.rel);
    } finally { if (stashed) { const pop = git('stash', 'pop', '-q'); if (pop.status !== 0) throw new Error('could not restore the working tree after checking the base: ' + (pop.stderr || '').slice(0, 200)); } }
  }
  const newBroken = relFailed.filter((r) => !brokenBefore.includes(r.rel));
  add('related tests still pass', !newBroken.length, relList.length ? `${relList.length} run${brokenBefore.length ? `, ${brokenBefore.length} already failing before` : ''}${newBroken.length ? `; NEW failure: ${newBroken[0].rel}` : ''}` : 'no related test found');
  const weak = newTests.filter((p) => !failsOnBase.includes(p));
  base.weakTest = weak.length > 0;
  add('new tests fail without the fix', !newTests.length ? !L.requireFailBefore : !weak.length, !newTests.length ? (L.requireFailBefore ? 'no test was added for the change' : 'no test added') : weak.length ? `${weak[0]} passes without the fix, so it proves nothing` : `${newTests.length} test(s) fail on the base`);
  // 4. a change to the dapp must still build (the build restamps cache-bust tokens and CSP hashes, which become part of the patch)
  if (buildCmd && snap.names.some((p) => p.startsWith('dapp/') && !isTestPath(p))) {
    const b = spawnSync('sh', ['-c', buildCmd], { cwd: repo, encoding: 'utf8', timeout: 300000, maxBuffer: 32 << 20, env: scrubbedEnv() });
    add('build', b.status === 0, b.status === 0 ? 'built and verified' : `exit ${b.status}: ${(b.stderr || b.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 200)}`);
    snap = snapshot();
  } else add('build', true, buildCmd ? 'no dapp change' : 'not run');
  return { ok: gates.every((g) => g.ok), gates, patch: snap.patch, files: snap.names, lines: snap.lines, weakTest: base.weakTest };
}
