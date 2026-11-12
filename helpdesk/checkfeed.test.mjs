// node checkfeed.test.mjs -- skeptic jobs for filed findings, planted claims that grade them, the weighted vote, and what is recorded
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeCheckFeed, skillTable, weightOf, decide, examSummary, readRows } from './checkfeed.mjs';
import { findingId } from './codecheck/roles.mjs';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };

const dir = mkdtempSync(path.join(tmpdir(), 'cf-'));
const F = { inbox: path.join(dir, 'inbox.jsonl'), checks: path.join(dir, 'checks.jsonl'), exam: path.join(dir, 'exam.jsonl') };
const put = (file, rows) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const SRC = ['// header', 'function f(a, b) {', '  if (a >= b) return 1;', '  const t = a + b;', '  return t > 10 ? 2 : 0;', '}'].join('\n');
const find = (o = {}) => { const base = { t: 1000, id: 'f1', miner: '0xaa', node: 'nodeP', tier: 'small', model: 'm1', file: 'dapp/a.js', commit: 'abc', window: '1-6', line: 3, why: 'boundary is off by one', old: 'if (a >= b)', new: 'if (a > b)', status: 'syntax-ok', review: 'new' }; return { ...base, ...o }; };
const vote = (id, node, v, o = {}) => ({ t: 1, id, node, miner: '0x' + node, tier: 'small', model: 'm1', verdict: v, vote: v, grounded: true, ...o });
const examRow = (node, outcome, o = {}) => ({ t: 1, role: 'skeptic', node, tier: 'small', outcome, lens: 'bounds', ...o });
const rep = (n, outcome, node) => Array.from({ length: n }, () => examRow(node, outcome));
const mkFeed = (o = {}) => makeCheckFeed({ source: () => SRC, sample: () => ({ file: 'dapp/a.js', commit: 'abc', start: 1, end: 6, lens: 'bounds' }), ...F, rand: () => 0.99, ...o });

// --- skill and weight
{
  const none = skillTable([...rep(5, 'right', 'n1')]);
  check('a machine with fewer than six graded answers has no skill on record, so it counts as 1', !none.has('n1') && weightOf({ node: 'n1', tier: 'small' }, none) === 1);
  const t = skillTable([...rep(9, 'right', 'good'), ...rep(1, 'wrong', 'good'), ...rep(7, 'right', 'ok'), ...rep(3, 'wrong', 'ok'), ...rep(6, 'right', 'weak'), ...rep(4, 'wrong', 'weak'), ...rep(5, 'right', 'coin'), ...rep(5, 'wrong', 'coin'), ...rep(2, 'right', 'bad'), ...rep(8, 'wrong', 'bad')]);
  check('right 90% of the time counts for 1.5, 70% for 1, 60% for 1, 50% for 0 (chance), below chance for 0', t.get('good') === 1.5 && t.get('ok') === 1 && t.get('weak') === 1 && t.get('coin') === 0 && t.get('bad') === 0);
  check('between chance and 60% counts for half', skillTable([...rep(11, 'right', 'x'), ...rep(9, 'wrong', 'x')]).get('x') === 0.5);
  check('unsure answers are neither right nor wrong', !skillTable([...rep(20, 'unsure', 'u'), ...rep(5, 'right', 'u')]).has('u'));
  check('scout results and rows with no machine are not skeptic skill', skillTable([...rep(10, 'right', 'z').map((r) => ({ ...r, role: 'scout' })), ...rep(10, 'right', undefined)]).size === 0);
  check('a big machine starts at 1.5 and carries its skill on top', weightOf({ node: 'g', tier: 'big' }, new Map()) === 1.5 && weightOf({ node: 'g', tier: 'big' }, new Map([['g', 0.5]])) === 0.75);
}

// --- the vote
{
  const sk = new Map(), D = (rows, o) => decide(rows, sk, o);
  check('no votes is pending', D([]).state === 'pending');
  check('two real votes from two machines confirm', D([vote('f', 'a', 'real'), vote('f', 'b', 'real')]).state === 'confirmed');
  check('one real vote is not enough', D([vote('f', 'a', 'real')]).state === 'pending');
  check('two false votes refute', D([vote('f', 'a', 'false'), vote('f', 'b', 'false')]).state === 'refuted');
  check('real against false is not a confirmation', D([vote('f', 'a', 'real'), vote('f', 'b', 'real'), vote('f', 'c', 'false')]).state === 'confirmed' && D([vote('f', 'a', 'real'), vote('f', 'b', 'false')]).state === 'pending');
  check('two real and two false is refuted, not confirmed (the doubt wins a tie)', D([vote('f', 'a', 'real'), vote('f', 'b', 'real'), vote('f', 'c', 'false'), vote('f', 'd', 'false')], { panel: 9 }).state === 'refuted');
  check('a full panel with no decision is unclear', D([vote('f', 'a', 'real'), vote('f', 'b', 'unsure'), vote('f', 'c', 'unsure')]).state === 'unclear');
  check('unsure counts toward the panel but toward neither side', (() => { const r = D([vote('f', 'a', 'unsure'), vote('f', 'b', 'unsure')]); return r.state === 'pending' && r.n === 2 && r.yes === 0 && r.no === 0; })());
  check('a machine votes once: its latest answer stands', D([vote('f', 'a', 'real'), vote('f', 'a', 'real'), vote('f', 'b', 'unsure')]).yes === 1 && D([vote('f', 'a', 'false'), vote('f', 'a', 'real')]).yes === 1);
  check('a big machine counts 1.5, so a big and a small machine confirm', D([vote('f', 'a', 'real', { tier: 'big' }), vote('f', 'b', 'real')]).state === 'confirmed' && D([vote('f', 'a', 'real', { tier: 'big' })]).yes === 1.5);
  check('a machine with no skill carries no weight', D([vote('f', 'a', 'real'), vote('f', 'b', 'real')], {}).state === 'confirmed' && decide([vote('f', 'a', 'real'), vote('f', 'b', 'real')], new Map([['a', 0], ['b', 0]])).state === 'pending');
  check('the quorum and the panel are settings', D([vote('f', 'a', 'real'), vote('f', 'b', 'real')], { quorum: 3 }).state === 'pending' && D([vote('f', 'a', 'unsure')], { panel: 1 }).state === 'unclear');
}

// --- real jobs
{
  put(F.inbox, [find()]); writeFileSync(F.checks, '');
  const feed = mkFeed();
  const j = await feed.next({ node: 'nodeQ', tier: 'small', model: 'm2' });
  check('a filed finding becomes a skeptic job for another machine', j && j.kind === 'check' && j.meta.check === true && j.meta.fid === 'f1' && j.max_tokens === 200 && j.temperature === 0 && !j.meta.exam);
  check('the job holds the claim, the change and the numbered code around the line', j.messages[1].content.includes('Claim (line 3): boundary is off by one') && j.messages[1].content.includes('- if (a >= b)') && j.messages[1].content.includes('+ if (a > b)') && j.messages[1].content.includes('3:   if (a >= b) return 1;') && j.meta.codeText.includes('3:   if (a >= b) return 1;'));
  check('the proposer is never asked to check its own finding', (await feed.next({ node: 'nodeP', tier: 'small', model: 'm1' })) === null);
  put(F.checks, [vote('f1', 'nodeQ', 'unsure')]);
  check('a machine that has voted is not asked again', (await feed.next({ node: 'nodeQ', tier: 'small' })) === null && (await feed.next({ node: 'nodeR', tier: 'small' })) !== null);
  put(F.checks, [vote('f1', 'a', 'real'), vote('f1', 'b', 'real')]);
  check('a finding that is decided is not handed out again', (await feed.next({ node: 'nodeR', tier: 'small' })) === null);
  put(F.checks, [vote('f1', 'a', 'unsure'), vote('f1', 'b', 'unsure'), vote('f1', 'c', 'unsure')]);
  check('nor one whose panel is full', (await feed.next({ node: 'nodeR', tier: 'small' })) === null);
  writeFileSync(F.checks, '');
  put(F.inbox, [find({ status: 'no-apply' }), find({ id: 'f2', status: 'syntax-error' }), find({ id: 'f3', review: 'rejected' })]);
  check('only findings that apply, parse and are still new are checked', (await feed.next({ node: 'nodeR', tier: 'small' })) === null);
  put(F.inbox, [{ ...find(), id: undefined }]);
  check('an older finding with no id is still checked, under the id it would have been given', (await feed.next({ node: 'nodeR' }))?.meta.fid === findingId('dapp/a.js', 'if (a >= b)', 'if (a > b)'));
  put(F.inbox, [find({ line: null, window: '1-6' })]);
  check('a finding with no line is shown by its window', (await feed.next({ node: 'nodeR' }))?.meta.codeText.includes('1: // header'));
  const near = mkFeed({ source: () => SRC.replace('return t > 10 ? 2 : 0;', 'return ' + '1 + '.repeat(8000) + '1;') });
  put(F.inbox, [find({ line: 5, window: '1-6' })]);
  check('a finding whose code is too big for a node is left alone', (await near.next({ node: 'nodeR' })) === null);
  const far = mkFeed({ source: () => SRC + Array.from({ length: 80 }, (_, i) => `// pad ${i}`).join('\n') + '\nconst big = ' + '1 + '.repeat(8000) + '1;\n' });
  put(F.inbox, [find()]);
  check('but one with the long line far outside its snippet is checked', (await far.next({ node: 'nodeR' })) !== null);
  const bigExam = makeCheckFeed({ source: () => SRC.replace('const t = a + b;', 'const t = ' + '1 + '.repeat(8000) + '1;'), sample: () => ({ file: 'dapp/a.js', commit: 'abc', start: 1, end: 6, lens: 'bounds' }), ...F, examEvery: 1, rand: () => 0 });
  put(F.inbox, []); 
  check('an exam whose snippet is too big for a node is not handed out', (await bigExam.next({ node: 'n' })) === null);
  const gone = mkFeed({ source: () => { throw new Error('no such commit'); } });
  put(F.inbox, [find()]);
  check('a finding whose code cannot be read is skipped, not fatal', (await gone.next({ node: 'nodeR' })) === null);
}
{
  // which finding first: fresh code, a model that has not voted, the part-way ones, the oldest
  put(F.inbox, [find({ id: 'old', t: 1 }), find({ id: 'new', t: 9 }), find({ id: 'fresh', t: 5, fresh: true }), find({ id: 'half', t: 7 })]);
  put(F.checks, [vote('half', 'a', 'real', { model: 'm9' })]);
  const feed = mkFeed(); const order = [];
  for (let i = 0; i < 3; i++) { const j = await feed.next({ node: 'n' + i, tier: 'small', model: 'm9' }); order.push(j?.meta.fid); put(F.checks, [vote('half', 'a', 'real', { model: 'm9' }), ...order.map((id) => vote(id, 'n' + order.indexOf(id), 'unsure', { model: 'm9' }))]); }
  check('fresh code first, then the oldest first; one this model has already voted on waits', order.join() === 'fresh,old,new');
  put(F.inbox, [find({ id: 'plain', t: 1 }), find({ id: 'partway', t: 9 })]); put(F.checks, [vote('partway', 'a', 'unsure')]);
  check('one already part-way to a decision comes before an untouched one', (await mkFeed().next({ node: 'z', model: 'mm' })).meta.fid === 'partway');
}

// --- exam jobs
{
  writeFileSync(F.inbox, ''); writeFileSync(F.checks, '');
  const mk = (r) => mkFeed({ rand: r, examEvery: 1 });
  const t = await mk(() => 0).next({ node: 'n' });   // rand 0: exam, claim true
  check('with examEvery 1 every ask is an exam, and it looks like any other skeptic job', t && t.kind === 'check' && t.meta.exam && t.meta.check === true && t.max_tokens === 200 && t.messages.length === 2 && t.messages[0].role === 'system');
  check('a true claim shows the code with the planted bug and proposes the original line', t.meta.exam.truth === true && /Claim \(line 3\):/.test(t.messages[1].content) && t.meta.codeText.includes('3:   if (a > b) return 1;') && t.messages[1].content.includes('+ if (a >= b) return 1;'));
  let seq = [0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99]; let k = 0;
  const f = await mkFeed({ rand: () => (k++ === 0 ? 0 : 0.99), examEvery: 1 }).next({ node: 'n' });
  const g = await makeCheckFeed({ source: () => SRC, sample: () => ({ file: 'dapp/a.js', commit: 'abc', start: 1, end: 6, lens: 'bounds' }), ...F, examEvery: 1, rand: (() => { const v = [0.5, 0, 0.9, 0.9, 0.9]; let i = 0; return () => v[i++ % v.length]; })() }).next({ node: 'n' });
  check('a false claim shows the original code and proposes the bug as the fix', [f, g].some((j) => j && j.meta.exam && j.meta.exam.truth === false && j.meta.codeText.includes('3:   if (a >= b) return 1;') && !/\n\+ if \(a >= b\)/.test(j.messages[1].content)));
  check('exam jobs carry which lens and kind they were planted as', t.meta.exam.lens === 'bounds' && typeof t.meta.exam.kind === 'string');
  const none = makeCheckFeed({ source: () => SRC, sample: () => null, ...F, examEvery: 1, rand: () => 0 });
  check('with nothing to plant in, an exam falls back to real work or nothing', (await none.next({ node: 'n' })) === null);
  const never = makeCheckFeed({ source: () => SRC, sample: () => ({ file: 'dapp/a.js', commit: 'abc', start: 1, end: 6, lens: 'bounds' }), ...F, examEvery: 0, rand: () => 0 });
  check('examEvery 0 turns exams off', (await never.next({ node: 'n' })) === null);
  put(F.inbox, [find({ id: 'real1' })]);
  const real = await mkFeed({ rand: () => 0.99, examEvery: 4 }).next({ node: 'q' });
  check('most asks are real work when there is some', real && !real.meta.exam && real.meta.fid === 'real1');
}

// --- recording
{
  writeFileSync(F.inbox, ''); writeFileSync(F.checks, ''); writeFileSync(F.exam, '');
  let clock = 5000; const feed = mkFeed({ now: () => clock });
  const who = { node: 'nQ', tier: 'big', model: 'qwen-35b' };
  const code = '3:   if (a >= b) return 1;\n4:   const t = a + b;';
  const job = { meta: { check: true, fid: 'f1', codeText: code } };
  const reply = (v, q) => JSON.stringify({ verdict: v, line: 3, quote: q, why: 'w' });
  await feed.onResult(job, reply('real', 'if (a >= b) return 1;'), '0xaa', who);
  await feed.onResult(job, reply('real', 'something that is not there'), '0xbb', { node: 'nR', tier: 'small' });
  await feed.onResult(job, 'not a verdict', '0xcc', { node: 'nS' });
  const rows = readRows(F.checks);
  check('a verdict is recorded with who gave it, its tier and model, and whether its quote was in the code', rows.length === 2 && rows[0].id === 'f1' && rows[0].node === 'nQ' && rows[0].tier === 'big' && rows[0].model === 'qwen-35b' && rows[0].vote === 'real' && rows[0].grounded === true && rows[0].t === 5000);
  check('an ungrounded verdict is recorded as unsure; a reply that is no verdict is not recorded', rows[1].verdict === 'real' && rows[1].vote === 'unsure' && rows[1].grounded === false);
  const ex = (truth) => ({ meta: { check: true, exam: { truth, lens: 'bounds', kind: 'ge-to-gt' }, codeText: code } });
  await feed.onResult(ex(true), reply('real', 'if (a >= b) return 1;'), '0xaa', who);
  await feed.onResult(ex(true), reply('false', 'if (a >= b) return 1;'), '0xaa', who);
  await feed.onResult(ex(false), reply('false', 'const t = a + b;'), '0xaa', who);
  await feed.onResult(ex(false), reply('real', 'const t = a + b;'), '0xaa', who);
  await feed.onResult(ex(true), reply('unsure', 'const t = a + b;'), '0xaa', who);
  await feed.onResult(ex(true), reply('real', 'invented line of code'), '0xaa', who);
  const er = readRows(F.exam);
  check('an exam answer is right when it matches what was planted, wrong when it does not', er.map((r) => r.outcome).slice(0, 4).join() === 'right,wrong,right,wrong');
  check('unsure, and a verdict with an invented quote, are unsure', er[4].outcome === 'unsure' && er[5].outcome === 'unsure' && er[5].grounded === false);
  check('an exam row names the role, lens, kind, truth and the machine', er[0].role === 'skeptic' && er[0].lens === 'bounds' && er[0].kind === 'ge-to-gt' && er[0].truth === true && er[0].node === 'nQ' && er[0].tier === 'big' && er[0].miner === '0xaa');
  check('exam answers never count as votes on a finding', readRows(F.checks).length === 2);
  check('the decision reads the recorded votes', feed.decision('f1').n === 2 && feed.decision('f1').yes === 1.5 && feed.decision('nope').state === 'pending');
  put(F.inbox, [find({ id: 'a' }), find({ id: 'b' }), find({ id: 'c', status: 'no-apply' })]);
  put(F.checks, [vote('a', 'x', 'real'), vote('a', 'y', 'real'), vote('b', 'x', 'false'), vote('b', 'y', 'false')]);
  const s = feed.summary();
  check('the summary counts findings by state (only those that apply) and gives the exam results', s.findings.confirmed === 1 && s.findings.refuted === 1 && s.findings.pending === 0 && s.exam.skeptic.n === 6 && s.exam.skeptic.right === 2 && s.exam.skeptic.wrong === 2 && s.exam.skeptic.unsure === 2);
}
// --- exam summary
{
  const s = examSummary([
    { role: 'scout', lens: 'units', tier: 'small', outcome: 'restored', fp: 0 }, { role: 'scout', lens: 'units', tier: 'small', outcome: 'miss', fp: 2 }, { role: 'scout', lens: 'bounds', tier: 'big', outcome: 'near', fp: 1 },
    { role: 'skeptic', lens: 'units', tier: 'big', outcome: 'right' }, { role: 'skeptic', lens: 'units', tier: 'small', outcome: 'wrong' }, { role: 'other', outcome: 'x' }, { role: 'skeptic', outcome: 'right' }]);
  check('scouts are counted by outcome, with the findings that were somewhere else', s.scout.n === 3 && s.scout.restored === 1 && s.scout.near === 1 && s.scout.miss === 1 && s.scout.fp === 3);
  check('and by lens and by tier', s.scout.byLens.units.n === 2 && s.scout.byLens.units.restored === 1 && s.scout.byLens.bounds.near === 1 && s.scout.byTier.small.n === 2 && s.scout.byTier.big.near === 1);
  check('skeptics likewise, a row with no lens or tier under ? and unknown, and an unknown role ignored', s.skeptic.n === 3 && s.skeptic.right === 2 && s.skeptic.wrong === 1 && s.skeptic.byLens['?'].right === 1 && s.skeptic.byTier.unknown.right === 1 && s.skeptic.byTier.big.right === 1);
}
// --- replies that were not a verdict
{
  writeFileSync(F.exam, '');
  const feed = mkFeed({ now: () => 7000 });
  await feed.onInvalid({ meta: { check: true, exam: { truth: true, lens: 'bounds', kind: 'ge-to-gt' }, codeText: 'x' } }, 'Sure!\u001b[2J here is my answer ' + 'z'.repeat(400), '0xaa', { node: 'nQ', tier: 'small', model: 'm1' });
  await feed.onInvalid({ meta: { check: true, fid: 'f1', codeText: 'x' } }, 'nope', '0xbb', { node: 'nR' });
  const rows = readRows(F.exam);
  check('an invalid reply is kept with its role, lens, whether it was an exam, the machine and the start of what came back', rows.length === 2 && rows[0].role === 'skeptic' && rows[0].lens === 'bounds' && rows[0].exam === true && rows[0].outcome === 'invalid' && rows[0].node === 'nQ' && rows[0].tier === 'small' && rows[0].model === 'm1' && rows[0].t === 7000 && rows[0].sample.startsWith('Sure!') && rows[0].sample.length === 160 && !rows[0].sample.includes('\u001b') && rows[1].exam === false && rows[1].sample === 'nope');
  check('invalid replies are not graded: they do not count in n, in a lens or tier total, or toward a machine\'s skill', (() => { const s = examSummary([...rows, examRow('nQ', 'right')]); return s.skeptic.invalid === 2 && s.skeptic.n === 1 && s.skeptic.right === 1 && s.skeptic.byTier.small.invalid === 1 && s.skeptic.byTier.small.n === 1 && s.skeptic.byLens.bounds.invalid === 1 && s.skeptic.byLens['?'].invalid === 1 && s.skeptic.byLens['?'].n === 0; })());
  check('and they carry no weight', skillTable(Array.from({ length: 20 }, () => ({ role: 'skeptic', node: 'k', outcome: 'invalid' }))).size === 0);
}
// --- reading
{
  writeFileSync(F.checks, '{"a":1}\nnot json\n{"torn":'); check('a torn or foreign line is skipped', readRows(F.checks).length === 1);
  appendFileSync(F.checks, '\n{"b":2}\n'); check('a file is read again once it has grown', readRows(F.checks).length === 2);
  check('a missing file or no file is no rows', readRows(path.join(dir, 'nope')).length === 0 && readRows(null).length === 0);
}
rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} checkfeed test(s) failed` : 'checkfeed: all tests passed'); process.exit(fails ? 1 : 0);
