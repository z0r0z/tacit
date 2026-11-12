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
const vote = (id, node, v, o = {}) => ({ t: 1, id, node, miner: '0x' + node, tier: 'small', model: 'm1', choice: v === 'real' ? 'B' : v === 'false' ? 'A' : 'unsure', side: 'B', vote: v, grounded: true, ...o });
const examRow = (node, outcome, o = {}) => ({ t: 1, role: 'skeptic', node, tier: 'small', outcome, lens: 'bounds', ...o });
const rep = (n, outcome, node) => Array.from({ length: n }, () => examRow(node, outcome));
// the two versions a skeptic job shows, by letter
const versions = (j) => { const m = j.messages[1].content.match(/Version A:\n([\s\S]*?)\n\nVersion B:\n([\s\S]*?)\n\nSurrounding code:/); return m ? { A: m[1], B: m[2] } : null; };
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
  check('a filed finding becomes a skeptic job for another machine', j && j.kind === 'check' && j.meta.check === true && j.meta.fid === 'f1' && j.max_tokens === 300 && j.temperature === 0 && !j.meta.exam);
  const vs = versions(j);
  check('the job holds the two versions, the proposed one on the side the job says, and the numbered code around the line, and not what the scout thought', vs.A === 'if (a >= b)' && vs.B === 'if (a > b)' && j.meta.side === 'B' && j.messages[1].content.includes('3:   if (a >= b) return 1;') && j.meta.codeText.includes('3:   if (a >= b) return 1;') && !j.messages[1].content.includes('boundary is off by one') && j.meta.shown.includes('if (a > b)') && j.meta.shown.includes('3:   if (a >= b) return 1;'));
  const flipped = await mkFeed({ rand: () => 0, examEvery: 0 }).next({ node: 'nodeQ', tier: 'small', model: 'm2' });
  check('the order is chosen by the gateway: with a low draw the proposed version is A', flipped.meta.side === 'A' && versions(flipped).A === 'if (a > b)' && versions(flipped).B === 'if (a >= b)');
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
  check('with examEvery 1 every ask is an exam, and it looks like any other skeptic job', t && t.kind === 'check' && t.meta.exam && t.meta.check === true && t.max_tokens === 300 && t.messages.length === 2 && t.messages[0].role === 'system');
  check('a true claim shows the code with the planted bug and offers the original line as the proposed version', t.meta.exam.truth === true && /Lines around 3/.test(t.messages[1].content) && t.meta.codeText.includes('3:   if (a > b) return 1;') && versions(t)[t.meta.side] === 'if (a >= b) return 1;' && versions(t)[t.meta.side === 'A' ? 'B' : 'A'] === 'if (a > b) return 1;');
  let seq = [0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99]; let k = 0;
  const f = await mkFeed({ rand: () => (k++ === 0 ? 0 : 0.99), examEvery: 1 }).next({ node: 'n' });
  const g = await makeCheckFeed({ source: () => SRC, sample: () => ({ file: 'dapp/a.js', commit: 'abc', start: 1, end: 6, lens: 'bounds' }), ...F, examEvery: 1, rand: (() => { const v = [0.5, 0, 0.9, 0.9, 0.9]; let i = 0; return () => v[i++ % v.length]; })() }).next({ node: 'n' });
  check('a false claim shows the original code and proposes the bug as the fix', [f, g].some((j) => j && j.meta.exam && j.meta.exam.truth === false && j.meta.codeText.includes('3:   if (a >= b) return 1;') && versions(j)[j.meta.side] === 'if (a > b) return 1;'));
  check('exam jobs carry which lens and kind they were planted as', t.meta.exam.lens === 'bounds' && typeof t.meta.exam.kind === 'string');
  const none = makeCheckFeed({ source: () => SRC, sample: () => null, ...F, examEvery: 1, rand: () => 0 });
  check('with nothing to plant in, an exam falls back to real work or nothing', (await none.next({ node: 'n' })) === null);
  const never = makeCheckFeed({ source: () => SRC, sample: () => ({ file: 'dapp/a.js', commit: 'abc', start: 1, end: 6, lens: 'bounds' }), ...F, examEvery: 0, rand: () => 0 });
  check('examEvery 0 turns exams off', (await never.next({ node: 'n' })) === null);
  put(F.inbox, [find({ id: 'real1' })]);
  const real = await mkFeed({ rand: () => 0.99, examEvery: 4 }).next({ node: 'q' });
  check('most asks are real work when there is some', real && !real.meta.exam && real.meta.fid === 'real1');
}

// --- the order is shuffled, so a constant answer is at chance and a reader is not
{
  const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  writeFileSync(F.inbox, ''); writeFileSync(F.checks, '');
  const quoteOf = (j) => j.meta.codeText.split('\n').map((l) => l.replace(/^\d+:\s?/, '').trim()).find((l) => l.length >= 8);
  const run = async (name, choose, n = 80) => {
    writeFileSync(F.exam, ''); const feed = mkFeed({ rand: mulberry(42), examEvery: 1 }); const sides = { A: 0, B: 0 };
    for (let i = 0; i < n; i++) { const j = await feed.next({ node: name, tier: 'small' }); if (!j) continue; sides[j.meta.side]++; await feed.onResult(j, JSON.stringify({ choice: choose(j), line: 3, quote: quoteOf(j), why: 'x' }), '0x' + name, { node: name, tier: 'small' }); }
    const rows = readRows(F.exam), right = rows.filter((r) => r.outcome === 'right').length;
    return { rows, acc: right / rows.length, skill: skillTable(rows).get(name), sides, truths: rows.filter((r) => r.truth).length };
  };
  const other = (s) => (s === 'A' ? 'B' : 'A');
  const reader = await run('reader', (j) => (j.meta.exam.truth ? j.meta.side : other(j.meta.side)));
  const alwaysA = await run('alwaysA', () => 'A'), alwaysB = await run('alwaysB', () => 'B'), alwaysProposed = await run('yes', (j) => j.meta.side), neverProposed = await run('no', (j) => other(j.meta.side)), same = await run('same', () => 'same');
  check('the proposed version is shown as A about half the time, and the claims are true about half the time', reader.sides.A > 25 && reader.sides.B > 25 && reader.truths > 25 && reader.truths < 55);
  check('a judge that reads, choosing the right version in either order, is right every time and carries the most weight', reader.acc === 1 && reader.skill === 1.5);
  check('a machine that always says A, or always B, is at chance and counts for little or nothing', alwaysA.acc > 0.3 && alwaysA.acc < 0.7 && alwaysB.acc > 0.3 && alwaysB.acc < 0.7 && (alwaysA.skill ?? 1) <= 0.5 && (alwaysB.skill ?? 1) <= 0.5);
  check('so is a machine that always takes the proposed version (a yes-man) or always the other (a no-man)', alwaysProposed.acc > 0.3 && alwaysProposed.acc < 0.7 && neverProposed.acc > 0.3 && neverProposed.acc < 0.7 && (alwaysProposed.skill ?? 1) <= 0.5 && (neverProposed.skill ?? 1) <= 0.5);
  check('and one that always says the versions are the same is wrong half the time as well: "same" is a vote against the change', same.acc > 0.3 && same.acc < 0.7);
  check('the summary shows which letter each machine picked', (() => { const s = examSummary(alwaysA.rows); return s.skeptic.choices.A === alwaysA.rows.length && !s.skeptic.choices.B; })());
  check('and every exam row keeps the choice and the side the proposed text was shown on', alwaysA.rows.every((r) => r.choice === 'A' && (r.side === 'A' || r.side === 'B')));
}
// --- recording
{
  writeFileSync(F.inbox, ''); writeFileSync(F.checks, ''); writeFileSync(F.exam, '');
  let clock = 5000; const feed = mkFeed({ now: () => clock });
  const who = { node: 'nQ', tier: 'big', model: 'qwen-35b' };
  const code = '3:   if (a >= b) return 1;\n4:   const t = a + b;';
  const job = { meta: { check: true, fid: 'f1', codeText: code, shown: code, side: 'B' } };   // the proposed text was shown as B
  const reply = (v, q) => JSON.stringify({ choice: v === 'real' ? 'B' : v === 'false' ? 'A' : v, line: 3, quote: q, why: 'w' });
  await feed.onResult(job, reply('real', 'if (a >= b) return 1;'), '0xaa', who);
  await feed.onResult(job, reply('real', 'something that is not there'), '0xbb', { node: 'nR', tier: 'small' });
  const withVersions = { meta: { check: true, fid: 'f2', codeText: code, shown: code + '\nif (a > b) return 1;', side: 'B' } };
  await feed.onResult(withVersions, JSON.stringify({ choice: 'A', line: 3, quote: 'if (a > b) return 1;', why: 'w' }), '0xdd', { node: 'nT' });
  await feed.onResult(job, 'not a verdict', '0xcc', { node: 'nS' });
  const rows = readRows(F.checks).filter((r) => r.id === 'f1');
  check('a quote taken from one of the two versions counts, as it is in what the skeptic was shown (A, with the proposed text as B, is a false vote)', (() => { const r = readRows(F.checks).find((x) => x.id === 'f2'); return r && r.vote === 'false' && r.grounded === true && r.choice === 'A'; })());
  check('a verdict is recorded with who gave it, its tier and model, and whether its quote was in the code', rows.length === 2 && rows[0].id === 'f1' && rows[0].node === 'nQ' && rows[0].tier === 'big' && rows[0].model === 'qwen-35b' && rows[0].vote === 'real' && rows[0].grounded === true && rows[0].t === 5000);
  check('an ungrounded verdict is recorded as unsure; a reply that is no verdict is not recorded', rows[1].choice === 'B' && rows[1].vote === 'unsure' && rows[1].grounded === false);
  const ex = (truth) => ({ meta: { check: true, exam: { truth, lens: 'bounds', kind: 'ge-to-gt' }, codeText: code, shown: code, side: 'B' } });
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
  check('exam answers never count as votes on a finding', readRows(F.checks).length === 3 && readRows(F.checks).every((r) => ['f1', 'f2'].includes(r.id)));
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
// --- findings from before machines were recorded: the address stands in for the machine
{
  const legacy = { ...find({ id: 'L1', miner: '0xAbCd', node: undefined, tier: undefined, model: undefined }) }; delete legacy.node;
  put(F.inbox, [legacy]); writeFileSync(F.checks, '');
  const feed = mkFeed();
  check('a finding with no machine recorded is not given to its proposer\'s address, in any case', (await feed.next({ node: 'nodeX', miner: '0xabcd' })) === null && (await feed.next({ node: 'nodeY', miner: '0xABCD' })) === null);
  check('but is given to another address', (await feed.next({ node: 'nodeX', miner: '0x1234' }))?.meta.fid === 'L1');
  check('a finding with no machine and a machine that names no address is given (nothing says they are the same)', (await feed.next({ node: 'nodeX' }))?.meta.fid === 'L1');
  put(F.checks, [vote('L1', 'nodeP', 'real', { miner: '0xabcd' }), vote('L1', 'nodeQ', 'real', { miner: '0x1111' })]);
  check('votes from the proposer\'s own address do not count: one other vote is not a confirmation', feed.decision('L1').state === 'pending' && feed.decision('L1').n === 1 && feed.decision('L1').yes === 1);
  put(F.checks, [vote('L1', 'nodeP', 'real', { miner: '0xabcd' }), vote('L1', 'nodeQ', 'real', { miner: '0x1111' }), vote('L1', 'nodeR', 'real', { miner: '0x2222' })]);
  check('two other machines still confirm it', feed.decision('L1').state === 'confirmed' && feed.decision('L1').n === 2);
  put(F.inbox, [find({ id: 'K1', node: 'nodeP', miner: '0xaa' })]);
  put(F.checks, [vote('K1', 'nodeP', 'real'), vote('K1', 'nodeQ', 'real')]);
  check('on a finding whose machine is known, that machine\'s vote is ignored too', feed.decision('K1').n === 1 && feed.decision('K1').state === 'pending');
  put(F.inbox, [find({ id: 'S1', node: 'nodeP', miner: '0xaa' })]); put(F.checks, [vote('S1', 'nodeX', 'real', { miner: '0xaa' }), vote('S1', 'nodeY', 'real', { miner: '0xbb' })]);
  check('another machine of the same address is another machine when the proposer is known', feed.decision('S1').state === 'confirmed' && feed.decision('S1').n === 2);
  const s = feed.summary();
  check('the summary counts findings the same way', s.findings.confirmed === 1);
}
// --- invalid replies are said, and the summary shows accuracy on true and on false claims
{
  const lines = []; const feed = mkFeed({ say: (m) => lines.push(m) });
  await feed.onInvalid({ meta: { check: true, fid: 'f1', codeText: 'x' } }, 'Okay so ' + 'q'.repeat(300), '0xaa', { node: 'n', tier: 'big', model: 'qwen-4b' });
  check('an invalid skeptic reply is said, with the size, the model and the start of it', lines.length === 1 && lines[0].startsWith('invalid skeptic reply (big, qwen-4b): "Okay so ') && lines[0].length < 260);
  const s = examSummary([
    { role: 'skeptic', truth: true, outcome: 'right', kind: 'ge-to-gt', lens: 'bounds' }, { role: 'skeptic', truth: true, outcome: 'right', kind: 'ge-to-gt', lens: 'bounds' },
    { role: 'skeptic', truth: false, outcome: 'wrong', kind: 'drop-await', lens: 'async' }, { role: 'skeptic', truth: false, outcome: 'wrong', kind: 'drop-await', lens: 'async' }, { role: 'skeptic', truth: false, outcome: 'right', kind: 'drop-await', lens: 'async' },
    { role: 'scout', outcome: 'restored', kind: 'scale', lens: 'units', fp: 0 }, { role: 'skeptic', outcome: 'invalid', truth: true }]);
  check('skeptics are broken down by whether the claim was true: a machine that says yes to everything shows as right on true and wrong on false', s.skeptic.byTruth.true.right === 2 && s.skeptic.byTruth.true.n === 2 && s.skeptic.byTruth.false.wrong === 2 && s.skeptic.byTruth.false.right === 1 && s.skeptic.byTruth.false.n === 3);
  check('and by the kind of bug planted, for scouts and skeptics', s.skeptic.byKind['ge-to-gt'].right === 2 && s.skeptic.byKind['drop-await'].wrong === 2 && s.scout.byKind.scale.restored === 1);
  check('an invalid reply is in none of those', !('undefined' in s.skeptic.byTruth) && Object.keys(s.skeptic.byTruth).sort().join() === 'false,true' && s.skeptic.invalid === 1 && s.skeptic.n === 5);
}
// --- reading
{
  writeFileSync(F.checks, '{"a":1}\nnot json\n{"torn":'); check('a torn or foreign line is skipped', readRows(F.checks).length === 1);
  appendFileSync(F.checks, '\n{"b":2}\n'); check('a file is read again once it has grown', readRows(F.checks).length === 2);
  check('a missing file or no file is no rows', readRows(path.join(dir, 'nope')).length === 0 && readRows(null).length === 0);
}
rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} checkfeed test(s) failed` : 'checkfeed: all tests passed'); process.exit(fails ? 1 : 0);
