#!/usr/bin/env node
// Mines candidate tasks for the PR yardstick from git history. Read-only: it only runs `git log`.
//
//   node tools/yardstick/mine.mjs > candidates.jsonl
//   REPO=/path/to/clone REF=origin/main SINCE=2026-08-01 node tools/yardstick/mine.mjs
//
// A candidate is a commit that changes some in-scope source AND a test in the same commit: the test is the
// grader, the parent commit is the starting point, the commit's own source change is the (hidden) reference
// fix. validate.mjs then keeps only those whose test fails on the parent and passes on the commit.
//
// Why history instead of invented bugs: the tasks are what Tacit's maintainers actually had to fix, and they
// are recent, so a model trained before them cannot have memorised the answers.
import { execFileSync } from 'node:child_process';

const REPO = process.env.REPO || process.cwd();
const REF = process.env.REF || 'origin/main';
const SINCE = process.env.SINCE || '2026-08-01';
const MAX_SRC_FILES = Number(process.env.MAX_SRC_FILES || 4);
const MAX_SRC_LINES = Number(process.env.MAX_SRC_LINES || 200);

const isTest = (f) => /(^|\/)tests?\//.test(f) || /\.test\.m?js$/.test(f);
const isRunnableTest = (f) => isTest(f) && /\.m?js$/.test(f) && !/(^|\/)(lib|fixtures?|helpers?|data)\//.test(f);
// Generated or stamped files that change with every build: never part of what a fix means.
const isGenerated = (f) => /^dapp\/.*\.html$/.test(f) || f === 'dapp/sw.js' || /(^|\/)package-lock\.json$/.test(f) || /\.md$/.test(f);
const isSource = (f) =>
  /^(dapp|worker|worker-relay|server|helpdesk|tools|build)\/.*\.(m?js|cjs)$/.test(f) &&
  !isTest(f) && !/\.min\.js$|(^|\/)(vendor|circuits|node_modules|generated)\//.test(f) && !f.startsWith('tools/yardstick/');

const FIX = /\b(fix(es|ed)?|bug|wrong|broken|crash(es)?|stuck|hang|hangs|stale|missing|never|no longer|stops?|refus(e|es|ed)|does not|doesn't|fails?|failed|leak|race|overflow|lost|hidden|reject|regression)\b/i;

const raw = execFileSync('git', ['-C', REPO, 'log', REF, `--since=${SINCE}`, '--no-merges', '--numstat', '--format=@@%H%x09%P%x09%ad%x09%s', '--date=short'],
  { encoding: 'utf8', maxBuffer: 512 << 20 });

let seen = 0;
const out = [];
for (const block of raw.split('@@').slice(1)) {
  const [head, ...rest] = block.split('\n');
  const [hash, parents, date, ...subj] = head.split('\t');
  const parent = (parents || '').split(' ')[0];
  const subject = subj.join('\t');
  if (!parent) continue;
  seen++;
  const files = rest.filter(Boolean).map((l) => { const [a, d, f] = l.split('\t'); return { f, a: Number(a) || 0, d: Number(d) || 0, bin: a === '-' }; });
  const live = files.filter((x) => !isGenerated(x.f));
  const src = live.filter((x) => isSource(x.f));
  const tests = live.filter((x) => isTest(x.f));
  const other = live.filter((x) => !isSource(x.f) && !isTest(x.f));
  if (other.length) continue;                                  // contracts, circuits, data: out of scope
  if (!src.length || src.length > MAX_SRC_FILES) continue;
  const runnable = tests.filter((x) => isRunnableTest(x.f));
  if (!runnable.length || runnable.length > 3) continue;
  const srcLines = src.reduce((n, x) => n + x.a + x.d, 0);
  if (srcLines < 2 || srcLines > MAX_SRC_LINES) continue;
  if (/^revert\b/i.test(subject)) continue;
  out.push({
    id: hash.slice(0, 10), commit: hash, parent, date, subject,
    kind: FIX.test(subject) ? 'fix' : 'change',
    src: src.map((x) => x.f), srcLines,
    tests: tests.map((x) => x.f), runTests: runnable.map((x) => x.f),
  });
}
for (const c of out) console.log(JSON.stringify(c));
const fix = out.filter((c) => c.kind === 'fix').length;
console.error(`scanned ${seen} commits since ${SINCE}: ${out.length} candidates (${fix} fix-like, ${out.length - fix} other changes)`);
