#!/usr/bin/env node
// node tools/nudger/select.mjs --out DIR [--repo .] [--ref origin/main] [--since 24h] [--max 6] [--min-lines 30] [--snapshots]
//
// Picks the commits worth a review from the last --since on --ref: those that change at least --min-lines real lines of in-scope code, largest first, at most
// --max of them. Writes into DIR:
//   commits.json     [{ n, sha, subject, files, changed }] and the commits it skipped, with the reason
//   review-<n>.txt   the commit message and the numbered diff of each in-scope file: what the first reviewer reads
//   snap/<n>/        with --snapshots, the code as it stood at that commit (no .git, no history): what the verifier searches
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { inScope, numberedDiff, parseSpan } from './lib.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1]; };
const out = arg('out'), repo = arg('repo', '.'), max = Number(arg('max', 6)), minLines = Number(arg('min-lines', 30));
const MAX_DIFF_LINES = 1200;   // a diff longer than this is not reviewed whole
if (!out) { console.error('usage: select.mjs --out DIR [--repo .] [--ref origin/main] [--since 24h] [--max 6] [--min-lines 30] [--snapshots]'); process.exit(2); }
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
const has = (ref) => { try { git('rev-parse', '--verify', '-q', ref); return true; } catch { return false; } };
const ref = arg('ref', has('origin/main') ? 'origin/main' : 'HEAD');
const since = new Date(Date.now() - parseSpan(arg('since', '24h'))).toISOString();

function select() {
  const picked = [], skipped = [];
  for (const sha of git('log', ref, '--no-merges', `--since=${since}`, '--format=%H').split('\n').filter(Boolean)) {
    const subject = git('log', '-1', '--format=%s', sha).trim();
    const files = git('diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha).split('\n').filter(inScope);
    if (!files.length) continue;
    const sections = []; let changed = 0, lines = 0;
    for (const f of files) {
      const d = numberedDiff(git('show', '--format=', '-U5', sha, '--', f));
      changed += d.changed; lines += d.lines;
      sections.push(`File: ${f}\n\n${d.text}`);
    }
    if (changed < minLines) continue;
    if (lines > MAX_DIFF_LINES) { skipped.push({ sha, subject, reason: `diff of ${lines} lines is too long to review whole` }); continue; }
    picked.push({ sha, subject, files, changed, message: git('log', '-1', '--format=%s%n%n%b', sha).trim().slice(0, 900), sections });
  }
  picked.sort((a, b) => b.changed - a.changed);
  for (const c of picked.slice(max)) skipped.push({ sha: c.sha, subject: c.subject, reason: `over the cap of ${max} commits a day` });
  return { commits: picked.slice(0, max), skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { commits, skipped } = select();
  mkdirSync(out, { recursive: true });
  const snapshots = process.argv.includes('--snapshots');
  const SKIP = ['dapp/evm-pool', 'dapp/btc-pool', 'dapp/airdrop', 'dapp/vendor', '*.webp', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.svg', '*.mp4', '*.webm', '*.woff2', '*.wasm', '*.pdf', '*.br', '*.gz'];
  const index = commits.map((c, i) => {
    const n = i + 1;
    writeFileSync(`${out}/review-${n}.txt`, `Commit message:\n${c.message}\n\n${c.sections.join('\n\n')}\n`);
    if (snapshots) {
      const root = `${out}/snap/${n}`; mkdirSync(root, { recursive: true });
      const dirs = ['dapp', 'worker/src', 'server', 'helpdesk', 'tests', 'tools'].filter((p) => git('ls-tree', '--name-only', c.sha, '--', p).trim());
      execFileSync('tar', ['-x', '-C', root, ...SKIP.flatMap((s) => ['--exclude', s])], { input: execFileSync('git', ['-C', repo, 'archive', c.sha, '--', ...dirs], { maxBuffer: 512 << 20 }) });
    }
    return { n, sha: c.sha, subject: c.subject, files: c.files, changed: c.changed };
  });
  writeFileSync(`${out}/commits.json`, JSON.stringify({ since, ref, commits: index, skipped }, null, 1));
  console.log(`${index.length} commit${index.length === 1 ? '' : 's'} to review since ${since} on ${ref}; ${skipped.length} skipped`);
  for (const c of index) console.log(`  ${c.n}. ${c.sha.slice(0, 9)} ${c.changed} lines  ${c.subject.slice(0, 80)}`);
  for (const s of skipped) console.log(`  skipped ${s.sha.slice(0, 9)}: ${s.reason}`);
}
