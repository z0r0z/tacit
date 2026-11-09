// node scanfeed.test.mjs -- the code-check feeder against a throwaway git repo: rotation, new commits first, dedupe, restart
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeScanFeed } from './scanfeed.mjs';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const d = mkdtempSync(path.join(tmpdir(), 'sft-')); const repo = path.join(d, 'r'); mkdirSync(path.join(repo, 'dapp'), { recursive: true });
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
const body = (tag, n) => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i} + 1;`).join('\n') + '\n';
git('init', '-q', '-b', 'main'); writeFileSync(path.join(repo, 'dapp/a.js'), body('a', 120)); writeFileSync(path.join(repo, 'dapp/b.js'), body('b', 30)); writeFileSync(path.join(repo, 'dapp/big.js'), body('z', 400));
git('add', '.'); git('commit', '-qm', 'one');
const mk = () => makeScanFeed({ repo, ref: 'main', inbox: path.join(d, 'inbox.jsonl'), cursorFile: path.join(d, 'cur.json'), refreshMs: 0, maxLines: 300 });
let f = mk();
const first = []; for (let i = 0; i < 4; i++) first.push((await f.next()).meta.file + ':' + (await Promise.resolve(0)));
check('files over the line cap are left out (and the cap is configurable)', !first.some((x) => x.startsWith('dapp/big.js')));
check('windows rotate through the eligible files', new Set(first.map((x) => x.split(':')[0])).size === 2);
// new commit: b.js changes, a.js does not -> b's window comes first
writeFileSync(path.join(repo, 'dapp/b.js'), body('b', 30).replace('b3 = 3', 'b3 = 99')); git('commit', '-qam', 'two');
const j = await f.next(); check('a new commit is picked up while running, and the changed file is reviewed first', j.meta.file === 'dapp/b.js' && j.meta.commit === git('rev-parse', 'HEAD').trim());
// dedupe: the same finding filed twice -> one line, even after a restart and after a reviewer marked it
const find = JSON.stringify({ findings: [{ line: 4, why: 'x', old: 'const b3 = 99;', new: 'const b3 = 100;' }] });
await f.onResult(j, find, '0xaa'); await f.onResult(j, find, '0xbb');
const lines = () => readFileSync(path.join(d, 'inbox.jsonl'), 'utf8').trim().split('\n');
check('the same suggestion is filed once, not once per pass', lines().length === 1);
writeFileSync(path.join(d, 'inbox.jsonl'), lines().map((l) => JSON.stringify({ ...JSON.parse(l), review: 'rejected' })).join('\n') + '\n');
f = mk(); await f.next(); await f.onResult({ meta: { file: 'dapp/b.js', commit: j.meta.commit, start: 1, end: 30 } }, find, '0xcc');   // the same file, the same finding, a new process
check('a restart does not re-file it, and a rejection sticks', lines().length === 1 && JSON.parse(lines()[0]).review === 'rejected');
// a restart picks up what changed while it was down
writeFileSync(path.join(repo, 'dapp/a.js'), body('a', 120).replace('a5 = 5', 'a5 = 55')); git('commit', '-qam', 'three');
f = mk(); const j3 = await f.next(); check('after a restart, files changed while it was down come first', j3.meta.file === 'dapp/a.js');
// fetch: a clone that is not updated by anyone else sees new commits at the origin
{ const clone = path.join(d, 'clone'); execFileSync('git', ['clone', '-q', repo, clone]); const gitO = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  const ff = makeScanFeed({ repo: clone, ref: 'origin/main', inbox: path.join(d, 'i2.jsonl'), cursorFile: path.join(d, 'c2.json'), refreshMs: 0, fetch: true, maxLines: 300 }); await ff.next();
  writeFileSync(path.join(repo, 'dapp/b.js'), body('b', 30).replace('b7 = 7', 'b7 = 77')); gitO('commit', '-qam', 'four');
  const jf = await ff.next(); check('with fetch on, a checkout picks up new commits from its origin and reviews the changed file first', jf.meta.commit === gitO('rev-parse', 'HEAD').trim() && jf.meta.file === 'dapp/b.js'); }
rmSync(d, { recursive: true, force: true });
console.log(fails ? `${fails} scanfeed test(s) failed` : 'scanfeed: all tests passed'); process.exit(fails ? 1 : 0);
