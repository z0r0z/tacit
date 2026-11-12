// The daily review's tools: which files and commits are reviewed, the numbered diff, the ranking and caps of the digest, and the selector and digest
// commands run for real against a throwaway git repository and a stand-in for the API.
//
// Run: `node tests/nudger-tools.test.mjs`

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inScope, numberedDiff, parseSpan, buildDigest, mergeFindings } from '../tools/nudger/lib.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

// ---- scope
ok('code under dapp, worker/src, server and helpdesk is in scope', ['dapp/tacit.js', 'dapp/pay/app.js', 'worker/src/index.js', 'server/harness.mjs', 'helpdesk/lease.mjs'].every(inScope));
ok('tests, docs, data directories, vendored and minified files are not', ['tests/x.mjs', 'docs/a.md', 'dapp/index.html', 'dapp/vendor/noble.js', 'dapp/evm-pool/data.js', 'dapp/btc-pool/x.js', 'dapp/airdrop/a.js', 'dapp/tacit.min.js', 'contracts/a.js', 'worker/src/x.json'].every((f) => !inScope(f)));

// ---- spans
ok('spans parse as minutes, hours and days, and anything else is an error', parseSpan('90m') === 5_400_000 && parseSpan('24h') === 86_400_000 && parseSpan('7d') === 604_800_000
  && ['24', 'h', '1w', '-1h', ''].every((s) => { try { parseSpan(s); return false; } catch { return true; } }));

// ---- the numbered diff
const diff = `diff --git a/x.js b/x.js\nindex 1..2 100644\n--- a/x.js\n+++ b/x.js\n@@ -10,3 +10,4 @@ function f() {\n   const a = 1;\n-  return a;\n+  const b = 2;\n+  return a + b;\n   }\n`;
const nd = numberedDiff(diff);
ok('lines carry their new-file number, removed lines carry none, and the header lines are gone', nd.text.split('\n')[0] === '@@ line 10 @@ function f() {' && nd.text.includes('   11 +  const b = 2;') && nd.text.includes('      -  return a;') && !/diff --git|index /.test(nd.text));
ok('a change counts its added and removed lines', nd.changed === 3, nd.changed);
const stamp = numberedDiff('@@ -1,2 +1,2 @@\n-import a from "/a.js?cb=aaaaaaaa";\n+import a from "/a.js?cb=bbbbbbbb";\n x\n');
ok('a line whose only change is a cache-bust stamp is not a change', stamp.changed === 0, stamp.changed);
const moved = numberedDiff('@@ -1,2 +1,2 @@\n-one\n-two\n+two\n+one\n');
ok('lines that only moved are not a change', moved.changed === 0, moved.changed);

// ---- the digest
const commits = [{ sha: 'a'.repeat(40), subject: 'one' }, { sha: 'b'.repeat(40), subject: 'two' }];
const F = (commit, verdict, severity, i) => ({ commit, file: 'dapp/x.js', line: i, claim: `claim ${commit[0]}${verdict[0]}${severity[0]}${i}`, severity, verdict, evidence: 'e' });
const d = buildDigest([
  F('a'.repeat(40), 'REFUTED', 'high', 1), F('a'.repeat(40), 'REAL', 'low', 2), F('a'.repeat(40), 'REAL', 'high', 3), F('a'.repeat(40), 'REAL', 'med', 4),
  F('b'.repeat(40), 'REAL', 'med', 5), F('b'.repeat(40), 'UNCERTAIN', 'high', 6), F('b'.repeat(40), 'UNCERTAIN', 'low', 7), F('a'.repeat(40), 'UNCERTAIN', 'med', 8),
], commits, { day: '2026-11-12' });
ok('refuted findings never reach the digest', !d.findings.some((f) => f.claim.includes('arh')));
ok('verified findings come first, each by severity, then those that hinge on an outside fact', d.findings.map((f) => `${f.status}:${f.severity}`).join() === 'real:high,real:med,real:med,real:low,outside:high,outside:low', d.findings.map((f) => `${f.status}:${f.severity}`).join());
const many = buildDigest(Array.from({ length: 10 }, (_, i) => F((i < 6 ? 'a' : 'b').repeat(40), 'REAL', 'med', i)), commits, { day: '2026-11-12' });
ok('no commit supplies more than three, and the verified ones stop at six', many.findings.filter((f) => f.commit === 'a'.repeat(40)).length === 3 && many.findings.length === 6 && many.findings.filter((f) => f.commit === 'b'.repeat(40)).length === 3);
const sized = [{ sha: 'x'.repeat(40), subject: 'big', changed: 100 }, { sha: 'y'.repeat(40), subject: 'small', changed: 50 }];
const G = (commit, pos, claim) => ({ commit, pos, file: 'dapp/x.js', line: pos, claim, severity: 'low', verdict: 'REAL', evidence: 'e' });
const tie = buildDigest([G('x'.repeat(40), 1, 'big second'), G('y'.repeat(40), 0, 'small first'), G('x'.repeat(40), 0, 'big first'), G('y'.repeat(40), 1, 'small second')], sized, { day: '2026-11-12', maxReal: 3 });
ok('among equal severities each commit\'s first finding comes before any second one, the larger commit first', tie.findings.map((f) => f.claim).join() === 'big first,small first,big second', tie.findings.map((f) => f.claim).join());
ok('ids run n<YYMMDD>-<k> in digest order, and each carries its commit\'s subject', d.findings.map((f) => f.id).join() === 'n261112-1,n261112-2,n261112-3,n261112-4,n261112-5,n261112-6' && d.findings[0].subject === 'one' && d.reviewed === 2);
ok('with nothing raised the digest is empty and still says how many commits were reviewed', buildDigest([], commits, { day: '2026-11-12' }).findings.length === 0 && buildDigest([], commits, { day: '2026-11-12' }).reviewed === 2);

// ---- pairing a reviewer's findings with a verifier's verdicts
const fs3 = [{ file: 'dapp/a.js', line: 4, why: 'first' }, { file: 'dapp/a.js', line: 9, why: 'second' }, { file: 'dapp/b.js', line: 1, why: 'third' }, { why: 7 }];
const vs3 = [{ n: 1, verdict: 'REAL', severity: 'med', evidence: 'a.js:4' }, { n: 2, verdict: 'REFUTED', severity: 'low', evidence: 'guarded' }, { n: 3, verdict: 'MAYBE', severity: 'low', evidence: '' }, { n: 4, verdict: 'REAL', severity: 'low', evidence: 'x' }];
const merged = mergeFindings('c'.repeat(40), fs3, vs3);
ok('findings are paired with verdicts by position; the reviewer\'s sentence becomes the claim', merged.length === 2 && merged[0].claim === 'first' && merged[0].verdict === 'REAL' && merged[0].severity === 'med' && merged[0].file === 'dapp/a.js' && merged[0].line === 4 && merged[1].verdict === 'REFUTED');
const worded = mergeFindings('c', [{ file: 'a.js', line: 1, why: 'reviewer wording, partly wrong' }, { file: 'a.js', line: 2, why: 'kept' }], [{ n: 1, verdict: 'REAL', severity: 'med', claim: 'what is really wrong', evidence: 'e' }, { n: 2, verdict: 'REAL', severity: 'low', claim: '   ', evidence: 'e' }]);
ok('the verifier\'s own sentence replaces the reviewer\'s when it gave one, and a blank one does not', worded[0].claim === 'what is really wrong' && worded[1].claim === 'kept' && worded[0].pos === 0 && worded[1].pos === 1);
ok('a verdict that is not one of the three, a finding with no sentence, and missing input are left out, not guessed', merged.every((m) => m.claim !== 'third') && mergeFindings('c', fs3, []).length === 0 && mergeFindings('c', null, vs3).length === 0 && mergeFindings('c', fs3, 'nope').length === 0);

// ---- the commands, on a throwaway repository
const root = mkdtempSync(join(tmpdir(), 'nudger-test-'));
const repo = join(root, 'repo'), work = join(root, 'work');
mkdirSync(repo);
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const write = (f, s) => { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), s); };
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
git('init', '-q', '-b', 'main');
write('dapp/old.js', lines(40, 'o')); git('add', '-A'); execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'old work'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } });
const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD').trim(); };
write('dapp/big.js', lines(60, 'b')); const big = commit('a big change');
write('dapp/small.js', lines(5, 's')); commit('a small change');
write('tests/only.mjs', lines(80, 't')); commit('tests only');
write('dapp/stamped.js', 'import a from "/a.js?cb=aaaaaaaa";\n' + lines(50, 'q')); const stamped = commit('a new page');
write('dapp/stamped.js', 'import a from "/a.js?cb=bbbbbbbb";\n' + lines(50, 'q')); commit('build: refreshed page stamps');   // only the cache-bust stamp changes
write('worker/src/mid.js', lines(35, 'm')); const mid = commit('a middle change');

const node = (script, args, env = {}) => spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const sel = node('tools/nudger/select.mjs', ['--repo', repo, '--ref', 'main', '--out', work, '--snapshots']);
ok('the selector runs', sel.status === 0, sel.stderr.slice(0, 200));
const idx = JSON.parse(readFileSync(`${work}/commits.json`, 'utf8'));
ok('it takes the commits with enough real change in scope, largest first', idx.commits.map((c) => c.subject).join() === 'a big change,a new page,a middle change', idx.commits.map((c) => c.subject));
ok('and leaves out the old, the small, the tests-only and the stamp-only', !idx.commits.some((c) => /old work|small|tests only|build: refreshed/.test(c.subject)));
ok('each commit has its review file: the message and the numbered diff', /^Commit message:\na big change/.test(readFileSync(`${work}/review-1.txt`, 'utf8')) && readFileSync(`${work}/review-1.txt`, 'utf8').includes('    1 +export const b0 = 0;'));
ok('each commit has a snapshot of the code as it stood, with no history, and a later file is absent from an earlier snapshot', existsSync(`${work}/snap/1/dapp/big.js`) && !existsSync(`${work}/snap/1/.git`) && existsSync(`${work}/snap/3/worker/src/mid.js`) && !existsSync(`${work}/snap/1/worker/src/mid.js`));
ok('the index names the commit and its files', idx.commits[0].sha === big && idx.commits[0].files.join() === 'dapp/big.js' && idx.commits[1].sha === stamped && idx.commits[2].sha === mid);
rmSync(work, { recursive: true });
node('tools/nudger/select.mjs', ['--repo', repo, '--ref', 'main', '--out', work, '--max', '1']);
const capped = JSON.parse(readFileSync(`${work}/commits.json`, 'utf8'));
ok('--max caps the commits and says what it skipped', capped.commits.length === 1 && capped.skipped.some((s) => /over the cap/.test(s.reason)));
ok('--snapshots is opt-in', !existsSync(`${work}/snap`));
ok('a bad span is refused with a message', node('tools/nudger/select.mjs', ['--repo', repo, '--out', work, '--since', 'forever']).status !== 0);

// the verifier's input and the digest's own pairing of findings with verdicts, per commit
writeFileSync(`${work}/findings-1.json`, JSON.stringify({ findings: [{ file: 'dapp/big.js', line: 3, why: 'the first finding' }, { file: 'dapp/big.js', line: 8, why: 'the  second\nfinding' }] }));
const vi = node('tools/nudger/verify-input.mjs', ['--out', work, '--n', '1']);
const vtxt = existsSync(`${work}/verify-1.txt`) ? readFileSync(`${work}/verify-1.txt`, 'utf8') : '';
ok('the verifier\'s input names the snapshot, carries the commit as the reviewer saw it, and numbers the findings', vi.status === 0 && vtxt.startsWith(`Snapshot root: ${work}/snap/1\n`) && vtxt.includes('Commit message:\na big change') && vtxt.includes('F1 (dapp/big.js:3): the first finding') && vtxt.includes('F2 (dapp/big.js:8): the second finding'), vtxt.slice(0, 200));
ok('with no findings it writes nothing and exits 3', node('tools/nudger/verify-input.mjs', ['--out', work, '--n', '2']).status === 3 && !existsSync(`${work}/verify-2.txt`));
writeFileSync(`${work}/verdicts-1.json`, JSON.stringify([{ n: 1, verdict: 'REAL', severity: 'high', evidence: 'big.js:3 shows it' }, { n: 2, verdict: 'REFUTED', severity: 'low', evidence: 'guarded at big.js:5' }]));
const paired = node('tools/nudger/digest.mjs', ['--out', work, '--day', '2026-11-12']);
ok('the digest pairs findings-<n> with verdicts-<n> itself, and keeps only what survived', paired.status === 0 && paired.stdout.includes('the first finding') && !paired.stdout.includes('second finding') && JSON.parse(readFileSync(`${work}/digest.json`, 'utf8')).findings[0].severity === 'high', paired.stdout.slice(0, 300));

// the digest command, dry then posted to a stand-in API
writeFileSync(`${work}/verdicts.json`, JSON.stringify([{ commit: big, file: 'dapp/big.js', line: 7, claim: 'a finding about the big change', severity: 'med', verdict: 'REAL', evidence: 'big.js:7' }]));
const dry = node('tools/nudger/digest.mjs', ['--out', work, '--day', '2026-11-12']);
ok('without --post the digest is shown and nothing is sent', dry.status === 0 && dry.stdout.includes('a finding about the big change') && dry.stdout.includes('[ Useful ] [ Noise ] [ Already known ]') && /not posted/.test(dry.stdout), dry.stdout.slice(0, 300));
let got = null;
const api = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got = { auth: req.headers.authorization, url: req.url, body: JSON.parse(b) }; res.writeHead(200); res.end('{"ok":true}'); }); });
await new Promise((r) => api.listen(0, r));
// asynchronous: the stand-in API answers on this process's event loop, which a synchronous spawn would block
const post = await new Promise((r) => { let stdout = '', stderr = ''; const c = spawn('node', ['tools/nudger/digest.mjs', '--out', work, '--day', '2026-11-12', '--post'], { env: { ...process.env, NUDGER_SECRET: 'k'.repeat(40), NUDGER_API: `http://127.0.0.1:${api.address().port}` } }); c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d)); c.on('close', (status) => r({ status, stdout, stderr })); });
ok('--post sends the digest to /nudger/digest with the secret as a bearer token', post.status === 0 && got?.url === '/nudger/digest' && got.auth === `Bearer ${'k'.repeat(40)}` && got.body.findings[0].id === 'n261112-1' && got.body.findings[0].subject === 'a big change', got);
got = null;
const ping = await new Promise((r) => { let stdout = ''; const c = spawn('node', ['tools/nudger/digest.mjs', '--ping'], { env: { ...process.env, NUDGER_SECRET: 'k'.repeat(40), NUDGER_API: `http://127.0.0.1:${api.address().port}` } }); c.stdout.on('data', (d) => (stdout += d)); c.on('close', (status) => r({ status, stdout })); });
ok('--ping sends {"ping":true} with the secret and needs no commits file', ping.status === 0 && got?.url === '/nudger/digest' && got.auth === `Bearer ${'k'.repeat(40)}` && got.body.ping === true && /HTTP 200/.test(ping.stdout), got);
ok('and never prints the secret', !post.stdout.includes('k'.repeat(40)) && !post.stderr.includes('k'.repeat(40)));
ok('--post without a secret refuses', node('tools/nudger/digest.mjs', ['--out', work, '--day', '2026-11-12', '--post'], { NUDGER_SECRET: '' }).status === 2);
writeFileSync(`${work}/verdicts.json`, '[]');
ok('a quiet day shows the one-line message', /Nothing worth a look today: 1 commit /.test(node('tools/nudger/digest.mjs', ['--out', work, '--day', '2026-11-12']).stdout));
api.close(); rmSync(root, { recursive: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
