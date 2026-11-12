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
const resultsFile = path.join(d, 'results.jsonl');
const mk = () => makeScanFeed({ repo, ref: 'main', inbox: path.join(d, 'inbox.jsonl'), results: resultsFile, cursorFile: path.join(d, 'cur.json'), refreshMs: 0, maxLines: 300 });
let f = mk();
const first = []; for (let i = 0; i < 4; i++) first.push((await f.next()).meta.file + ':' + (await Promise.resolve(0)));
check('files over the line cap are left out (and the cap is configurable)', !first.some((x) => x.startsWith('dapp/big.js')));
check('windows rotate through the eligible files', new Set(first.map((x) => x.split(':')[0])).size === 2);
// new commit: b.js changes, a.js does not -> b's window comes first
writeFileSync(path.join(repo, 'dapp/b.js'), body('b', 30).replace('b3 = 3', 'b3 = 99')); git('commit', '-qam', 'two');
const j = await f.next(); check('a new commit is picked up while running, and the changed file is reviewed first', j.meta.file === 'dapp/b.js' && j.meta.commit === git('rev-parse', 'HEAD').trim());
check('a window of changed code is marked fresh, one from the rotation is not', j.meta.fresh === true && first.length === 4 && (await f.next()).meta.fresh === false);
// dedupe: the same finding filed twice -> one line, even after a restart and after a reviewer marked it
const find = JSON.stringify({ findings: [{ line: 4, why: 'x', old: 'const b3 = 99;', new: 'const b3 = 100;' }] });
await f.onResult(j, find, '0xaa'); await f.onResult(j, find, '0xbb');
const lines = () => readFileSync(path.join(d, 'inbox.jsonl'), 'utf8').trim().split('\n');
check('the same suggestion is filed once, not once per pass', lines().length === 1);
check('a fresh window files its suggestion as fresh', JSON.parse(lines()[0]).fresh === true);
const stats = () => readFileSync(resultsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check('every window looked at is counted once, with who looked and how many findings', stats().length === 2 && stats()[0].miner === '0xaa' && stats()[0].n === 1 && stats()[1].miner === '0xbb' && typeof stats()[0].t === 'number');
await f.onResult(j, JSON.stringify({ findings: [] }), '0xdd');
check('a window with nothing to suggest is still counted', stats().length === 3 && stats()[2].n === 0);
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
// A reply may spell control characters as \\u001b: they come out of a finding once it is decoded, and the inbox viewer prints none of what a node wrote.
{
  const { parseFindings, plain } = await import('./codecheck/scan.mjs');
  const reply = JSON.stringify({ findings: [{ line: 3, why: 'x \u001b]0;title\u0007\u001b[2J y', old: 'let a = 1;', new: 'let a = 2; // \u001b[8mhidden\u001b[0m \u202eevil\tkept', extra: 'dropped' }] });
  const [f] = parseFindings(reply);
  check('a decoded finding has no control or direction characters', f && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/.test(f.why + f.old + f.new) && f.new.includes('\tkept') && f.line === 3);
  check('only the fields asked for are kept', !('extra' in f) && Object.keys(f).sort().join() === 'line,new,old,why');
  check('plain leaves ordinary text, tabs and newlines alone', plain('a\tb\nc 1: ok') === 'a\tb\nc 1: ok');
  const inbox = path.join(d, 'inbox.jsonl');
  writeFileSync(inbox, JSON.stringify({ t: 1, miner: '0xabc\u001b[2J', file: 'dapp/a.js', commit: 'abc', window: '1-9', line: 3, why: 'x \u001b]0;title\u0007 y', old: 'let a = 1;', new: 'let a = 2; // \u001b[8mhidden', status: 'syntax-ok', review: 'new' }) + '\n');
  const out = execFileSync('node', [path.join(path.dirname(new URL(import.meta.url).pathname), 'inbox.mjs')], { encoding: 'utf8', env: { ...process.env, INBOX: inbox } });
  check('the inbox viewer shows the finding without an escape sequence', out.includes('let a = 2;') && !out.includes('\u001b') && !out.includes('\u0007'));
}
// lens snippets: a snippet too big for a node (a very long line) is passed over, the next one is handed out
{
  const d2 = mkdtempSync(path.join(tmpdir(), 'sft2-')); const repo2 = path.join(d2, 'r'); mkdirSync(path.join(repo2, 'dapp'), { recursive: true });
  const git2 = (...a) => execFileSync('git', ['-C', repo2, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git2('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo2, 'dapp/long.js'), 'const x = Number(' + '1 + '.repeat(8000) + '1);\nconst pad = 1;\n');
  writeFileSync(path.join(repo2, 'dapp/ok.js'), 'const y = Number(2);\nconst z = 3;\n');
  git2('add', '.'); git2('commit', '-qm', 'one');
  const f2 = makeScanFeed({ repo: repo2, ref: 'main', inbox: path.join(d2, 'i.jsonl'), cursorFile: path.join(d2, 'c.json'), refreshMs: 0, lenses: true });
  const files = []; for (let i = 0; i < 12; i++) { const j = await f2.next(); if (j?.meta.site) files.push(j.meta.file); }
  check('a snippet with a line too long for a node is passed over for the next, which is handed out', files.length >= 4 && files.every((x) => x === 'dapp/ok.js'));
  rmSync(d2, { recursive: true, force: true });
}
// exams: a planted bug is handed out only where the snippet fits what a node takes
{
  const d3 = mkdtempSync(path.join(tmpdir(), 'sft3-')); const repo3 = path.join(d3, 'r'); mkdirSync(path.join(repo3, 'dapp'), { recursive: true });
  const git3 = (...a) => execFileSync('git', ['-C', repo3, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git3('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo3, 'dapp/long.js'), 'const x = BigInt(1);\nconst huge = "' + 'q'.repeat(30000) + '";\n');
  writeFileSync(path.join(repo3, 'dapp/ok.js'), 'const y = BigInt(2);\nconst z = 3;\n');
  git3('add', '.'); git3('commit', '-qm', 'one');
  const exam = path.join(d3, 'exam.jsonl'); let seed = 5; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const f3 = makeScanFeed({ repo: repo3, ref: 'main', inbox: path.join(d3, 'i.jsonl'), cursorFile: path.join(d3, 'c.json'), refreshMs: 0, lenses: true, examFile: exam, rand });
  const planted = []; for (let i = 0; i < 80; i++) { const j = await f3.next(); if (j?.meta.exam) planted.push(j); }
  check('a planted bug is handed out only in a snippet a node can take', planted.length >= 3 && planted.every((j) => j.meta.file === 'dapp/ok.js' && JSON.stringify(j.messages).length <= 20000));
  rmSync(d3, { recursive: true, force: true });
}
// scout replies that are not strict JSON: code with its own double quotes, raw newlines, escapes of both kinds
{
  const { parseFindings, looseFindings, sampleOf } = await import('./codecheck/scan.mjs');
  const one = (txt) => parseFindings(txt)[0];
  const quoted = one('{"findings":[{"line":79,"why":"needs 2 chars","old":"if (!/^[A-Z0-9]{2,11}$/.test(s)) return "bad";","new":"if (!/^[A-Z0-9]{1,11}$/.test(s)) return "bad";"}]}');
  check('a finding whose code has unescaped double quotes is read, field by field', quoted && quoted.line === 79 && quoted.why === 'needs 2 chars' && quoted.old === 'if (!/^[A-Z0-9]{2,11}$/.test(s)) return "bad";' && quoted.new === 'if (!/^[A-Z0-9]{1,11}$/.test(s)) return "bad";');
  const nl = one('{"findings":[{"line":5,"why":"x","old":"const a = 1;\nconst b = 2;","new":"const a = 1;\nconst b = 3;"}]}');
  check('so is one with raw newlines in the code', nl && nl.old === 'const a = 1;\nconst b = 2;' && nl.new === 'const a = 1;\nconst b = 3;');
  const esc = one('{"findings":[{"line":5,"why":"x","old":"a = "q";\\nb = 1;","new":"a = "q";\\nb = 2;"}]}');
  check('a two-character \\n escape in a reply that is not valid JSON comes out as a newline', esc && esc.old === 'a = "q";\nb = 1;' && esc.new === 'a = "q";\nb = 2;');
  const mixed = one('{"findings":[{"line":5,"why":"x","old":"s = \\"a\\"; t = "b";","new":"s = \\"a\\"; t = \\"c\\";"}]}');
  check('escaped quotes among unescaped ones come out as quotes', mixed && mixed.old === 's = "a"; t = "b";' && mixed.new === 's = "a"; t = "c";');
  const fenced = one('Here you go:\n```json\n{"findings":[{"line":3,"why":"w \\"quoted\\" word","old":"x = "y";","new":"x = "z";"}]}\n```');
  check('inside a code fence and prose', fenced && fenced.why === 'w "quoted" word' && fenced.old === 'x = "y";');
  check('a loosely read finding is cleaned and filtered like any other (control characters out, a no-op change dropped, line numbers off the old text)', (() => { const f = parseFindings('{"findings":[{"line":3,"why":"w\u001b[2J","old":"7: a = "q";","new":"a = "r";"},{"line":4,"why":"w","old":"b = 1;","new":"b = 1;"}]}'); return f.length === 1 && !f[0].why.includes('\u001b') && f[0].old === 'a = "q";'; })());
  check('a reply that ran out before it closed is no finding, and neither is prose or an empty list', parseFindings('{"findings":[{"line":57,"why":"The check allows values up to 10000, but the comment imp').length === 0 && parseFindings('Looks fine.').length === 0 && parseFindings('{"findings":[]}').length === 0 && looseFindings('{"findings":[]}').length === 0);
  check('valid JSON is read as before, and a findings field that is not a list is none', parseFindings('{"findings":[{"line":2,"why":"w","old":"a","new":"b"}]}').length === 1 && parseFindings('{"findings":"none"}').length === 0 && parseFindings('{"findings":{"line":1}}').length === 0);
  check('at most three findings are read, loosely too', parseFindings('{"findings":[' + Array.from({ length: 5 }, (_, i) => `{"line":${i},"why":"w","old":"a${i} = "x";","new":"b${i} = "x";"}`).join(',') + ']}').length === 3);
  check('a sample is the whole reply when it is short, and its start and its end when it is not', sampleOf('short') === 'short' && (() => { const t = 'S'.repeat(200) + 'END-OF-REPLY-' + 'E'.repeat(30); const s = sampleOf(t); return s.length === 160 && s.startsWith('SSSS') && s.endsWith('E'.repeat(30)) && s.includes(' … '); })());
  check('a sample has its control characters taken out', !sampleOf('a\u001b[2Jb\u202ec').includes('\u001b') && !sampleOf('a\u202ec').includes('\u202e'));
}
// an invalid reply is kept, as invalid, beside the exam results
{
  const d4 = mkdtempSync(path.join(tmpdir(), 'sft4-')); const exam = path.join(d4, 'exam.jsonl');
  const f4 = makeScanFeed({ repo, ref: 'main', inbox: path.join(d4, 'i.jsonl'), cursorFile: path.join(d4, 'c.json'), refreshMs: 0, lenses: true, examFile: exam });
  f4.onInvalid({ meta: { lens: 'units', exam: { line: 3 } } }, 'I think the code is fine.\u001b[2J', '0xaa', { node: 'n1', tier: 'small', model: 'm1' });
  f4.onInvalid({ meta: { file: 'dapp/a.js' } }, 'prose', '0xbb', {});
  const rows = readFileSync(exam, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('an invalid scout reply is kept with its lens (or window), whether it was an exam, who sent it and the start of it', rows.length === 2 && rows[0].role === 'scout' && rows[0].lens === 'units' && rows[0].exam === true && rows[0].outcome === 'invalid' && rows[0].tier === 'small' && rows[0].model === 'm1' && rows[0].miner === '0xaa' && rows[0].sample === 'I think the code is fine.[2J' && !rows[0].sample.includes('\u001b') && rows[1].lens === 'window' && rows[1].exam === false);
  const said = []; const f5 = makeScanFeed({ repo, ref: 'main', inbox: path.join(d4, 'i3.jsonl'), cursorFile: path.join(d4, 'c3.json'), refreshMs: 0, lenses: true, examFile: exam, say: (m) => said.push(m) });
  f5.onInvalid({ meta: { lens: 'bounds' } }, 'Sure ' + 'x'.repeat(300), '0xaa', { tier: 'small', model: 'qwen-4b' });
  check('an invalid scout reply is said, with the size, the model and the start of it', said.length === 1 && said[0].startsWith('invalid scout reply (small, qwen-4b): "Sure x') && said[0].length < 260);
  const plainFeed = makeScanFeed({ repo, ref: 'main', inbox: path.join(d4, 'i2.jsonl'), cursorFile: path.join(d4, 'c2.json'), refreshMs: 0 });
  plainFeed.onInvalid({ meta: {} }, 'x', '0xaa', {});
  check('a feed with no exam file keeps nothing and does not fail', readFileSync(exam, 'utf8').trim().split('\n').length === 3);
  rmSync(d4, { recursive: true, force: true });
}
rmSync(d, { recursive: true, force: true });
console.log(fails ? `${fails} scanfeed test(s) failed` : 'scanfeed: all tests passed'); process.exit(fails ? 1 : 0);
