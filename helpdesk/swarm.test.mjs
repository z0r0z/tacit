// node swarm.test.mjs -- the whole review, end to end: a git repo, the scan and check feeds, the lease protocol and three machines of two sizes. A scout files a finding from a
// lens snippet, a bigger and a smaller machine check it, the gateway lets it through, the digest carries it; planted bugs grade scouts and skeptics on the way.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeLeases } from './lease.mjs';
import { makeScanFeed } from './scanfeed.mjs';
import { makeCheckFeed, readRows } from './checkfeed.mjs';
import { makeDigestPoster } from './reviewdigest.mjs';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };

const d = mkdtempSync(path.join(tmpdir(), 'swarm-')), repo = path.join(d, 'r'); mkdirSync(path.join(repo, 'dapp'), { recursive: true });
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
const SRC = [
  'export function pick(a, b) {',
  '  if (a >= b) return 1;',
  '  return 0;',
  '}',
  'export async function load(u) {',
  '  const r = await fetch(u);',
  '  return r.json();',
  '}',
  'export const wide = (x) => BigInt(x) * 10n;',
  'export function tail(h) { return h.slice(2); }',
  'export function sats(v) { return v / 1e8; }',
  'export function show(el, t) { el.textContent = t; el.innerHTML = t; }',
  'export const save = (k, v) => localStorage.setItem(k, v);',
  'export const chain = (net, chainId) => net === "x" && chainId;',
].join('\n') + '\n';
git('init', '-q', '-b', 'main'); writeFileSync(path.join(repo, 'dapp/a.js'), SRC); git('add', '.'); git('commit', '-qm', 'one');

const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const P = { inbox: path.join(d, 'inbox.jsonl'), results: path.join(d, 'results.jsonl'), exam: path.join(d, 'exam.jsonl'), checks: path.join(d, 'checks.jsonl'), cursor: path.join(d, 'cur.json') };
const scan = makeScanFeed({ repo, ref: 'main', inbox: P.inbox, results: P.results, cursorFile: P.cursor, refreshMs: 1e9, lenses: true, examFile: P.exam, rand: mulberry(7) });
const checkFeed = makeCheckFeed({ source: scan.source, sample: scan.sample, inbox: P.inbox, checks: P.checks, exam: P.exam, panel: 3, quorum: 2, examEvery: 0, rand: mulberry(11) });
const handed = [];   // every job the feeds made, with who it was made for
const spy = (name, feed) => ({ ...feed, next: async (ctx) => { const j = await feed.next(ctx); if (j) handed.push({ feed: name, job: j, ctx }); return j; } });
const L = makeLeases({ scan: spy('scan', scan), check: spy('check', checkFeed), scanPerHour: 1000, waitMs: 30, points: { answer: 1, canary: 1, scan: 1, check: 2 }, clientMaxPerDay: 1000 });

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const small = { ram: 16, vram: 6, cores: 8, os: 'linux', arch: 'x64', unified: false }, big = { ram: 64, vram: 24, cores: 16, os: 'linux', arch: 'x64', unified: false };
const M = { A: { miner: A, ip: '1.1.1.1', hw: small, model: 'qwen3.5-4b' }, B: { miner: B, ip: '2.2.2.2', hw: big, model: 'qwen3.5-35b' }, C: { miner: C, ip: '3.3.3.3', hw: small, model: 'gemma-3-4b' } };
const ask = async (who) => { const j = await L.lease({ ...M[who], kinds: ['scan'] }); return j; };
const reply = (who, j, text) => L.submit({ id: j.id, lease: j.lease, miner: M[who].miner, ip: M[who].ip, text });
const last = () => handed[handed.length - 1];

// --- a scout: lens snippets, then an exam, are handed out in the planned order
let found = null; const seq = [];
for (let i = 0; i < 8; i++) {
  const j = await ask('A'); if (!j) continue;
  const h = last(); seq.push(h.job.meta.exam ? 'exam' : h.job.meta.lens ? 'site:' + h.job.meta.lens : 'window');
  if (i === 0) check('a node sees an ordinary scan job: the kind is scan and nothing marks a lens, a role or an exam', j.kind === 'scan' && !('meta' in j) && !('exam' in j) && j.messages.length === 2 && j.max_tokens <= 500);
  if (!found && !h.job.meta.exam && h.job.meta.lens === 'bounds') { found = { j, h }; continue; }   // kept, answered below
  await reply('A', j, JSON.stringify({ findings: [] }));
}
check('the feed handed out lens snippets, whole windows and an exam', seq.some((s) => s.startsWith('site:')) && seq.includes('window') && seq.includes('exam'));
check('a lens snippet asks one question about that lens, with the Tacit primer', found && /ONE kind of problem: boundaries and thresholds/.test(found.j.messages[0].content) && /sats \(8 decimals\)/.test(found.j.messages[0].content) && found.j.messages[1].content.includes('2:   if (a >= b) return 1;'));
const exams = readRows(P.exam).filter((r) => r.role === 'scout');
check('an exam a scout answered with nothing is graded a miss, with its machine, size and model', exams.length >= 1 && exams[0].outcome === 'miss' && exams[0].tier === 'small' && exams[0].model === 'qwen3.5-4b' && typeof exams[0].node === 'string' && exams[0].miner === A && exams[0].fp === 0);
check('and it was not filed as a finding', !existsSync(P.inbox) || readRows(P.inbox).length === 0);

// --- an exam answered correctly is graded restored
{
  let done = false;
  for (let i = 0; i < 40 && !done; i++) {
    const j = await ask('C'); if (!j) continue; const h = last();
    if (h.job.meta.exam) { const e = h.job.meta.exam; await reply('C', j, JSON.stringify({ findings: [{ line: e.line, why: 'x', old: e.mut, new: e.orig }] })); done = true; }
    else await reply('C', j, JSON.stringify({ findings: [] }));
  }
  const r = readRows(P.exam).filter((x) => x.role === 'scout' && x.miner === C);
  check('a patch that puts the original line back is graded restored', done && r.length === 1 && r[0].outcome === 'restored' && r[0].fp === 0 && r[0].lens && r[0].kind);
  let near = false;
  for (let i = 0; i < 40 && !near; i++) {
    const j = await ask('C'); if (!j) continue; const h = last();
    if (h.job.meta.exam) { const e = h.job.meta.exam; await reply('C', j, JSON.stringify({ findings: [{ line: e.line + 1, why: 'x', old: 'return 0;', new: 'return 1;' }] })); near = true; }
    else await reply('C', j, JSON.stringify({ findings: [] }));
  }
  const r2 = readRows(P.exam).filter((x) => x.role === 'scout' && x.miner === C);
  check('a finding one line away is near', near && r2.length === 2 && r2[1].outcome === 'near' && r2[1].n === 1 && r2[1].fp === 0);
  const asks = async (offset) => { for (let i = 0; i < 60; i++) { const j = await ask('C'); if (!j) continue; const h = last(); if (h.job.meta.exam) { const e = h.job.meta.exam; await reply('C', j, JSON.stringify({ findings: [{ line: e.line + offset, why: 'x', old: 'return 0;', new: 'return 1;' }] })); return true; } await reply('C', j, JSON.stringify({ findings: [] })); } return false; };
  await asks(2); await asks(3); await asks(40);
  const r3 = readRows(P.exam).filter((x) => x.role === 'scout' && x.miner === C).slice(2);
  check('two lines away is still near; three lines away is a miss, and the finding counts against the reviewer', r3.length === 3 && r3[0].outcome === 'near' && r3[1].outcome === 'miss' && r3[1].fp === 1 && r3[2].outcome === 'miss' && r3[2].fp === 1);
}

// --- every exam the scouts were given asks about the lens whose own mistake was planted
{
  const { MUTATIONS } = await import('./codecheck/mutate.mjs');
  for (let i = 0; i < 200 && handed.filter((h) => h.job.meta.exam).length < 25; i++) { const j = await ask('C'); if (j) await reply('C', j, JSON.stringify({ findings: [] })); }
  const ex = handed.filter((h) => h.feed === 'scan' && h.job.meta.exam).map((h) => h.job.meta.exam);
  check('every planted bug is a mistake of the lens it was asked about (never a generic one)', ex.length >= 25 && ex.every((e) => MUTATIONS.find((m) => m.kind === e.kind)?.lens === e.lens));
  check('and the exams cover more than one lens', new Set(ex.map((e) => e.lens)).size >= 3);
}

// --- a scout files a real finding
const finding = { line: 2, why: 'the boundary is off by one: the value equal to the limit is rejected', old: 'if (a >= b) return 1;', new: 'if (a > b) return 1;' };
{
  const job = found.j, r = await reply('A', job, JSON.stringify({ findings: [finding, { ...finding, old: 'return 0;', new: 'return 9;' }] }));
  const rows = readRows(P.inbox);
  check('a lens scout files one finding at most, with its id, lens and who proposed it', r.points === 1 && rows.length === 1 && /^[0-9a-f]{10}$/.test(rows[0].id) && rows[0].lens === 'bounds' && rows[0].status === 'syntax-ok' && rows[0].review === 'new' && rows[0].tier === 'small' && rows[0].model === 'qwen3.5-4b' && typeof rows[0].node === 'string' && rows[0].miner === A);
}
const fid = readRows(P.inbox)[0].id;

// --- skeptics
{
  check('the machine that proposed it is not asked to check it', await (async () => { for (let i = 0; i < 6; i++) { const j = await ask('A'); if (!j) continue; const h = last(); if (h.feed === 'check') return false; await reply('A', j, JSON.stringify({ findings: [] })); } return true; })());
  const jb = await ask('B'); const hb = last();
  check('another machine is given a skeptic job for it, which it sees as a scan', jb && jb.kind === 'scan' && hb.feed === 'check' && hb.job.meta.fid === fid && /SKEPTIC/.test(jb.messages[0].content) && jb.messages[1].content.includes('Claim (line 2)') && jb.messages[1].content.includes('- if (a >= b) return 1;') && jb.messages[1].content.includes('+ if (a > b) return 1;'));
  const bad = await reply('B', jb, 'Looks right to me!');
  check('a reply that is not a verdict earns nothing and records no vote', bad.points === 0 && readRows(P.checks).length === 0);
  const jb2 = await ask('B'); const hb2 = last();
  check('the machine is asked again, having not voted', hb2.feed === 'check' && hb2.job.meta.fid === fid);
  const quote = 'if (a >= b) return 1;';
  const ok = await reply('B', jb2, JSON.stringify({ verdict: 'real', line: 2, quote, why: 'the boundary value is rejected' }));
  check('a verdict is paid at the check rate and recorded with the machine, its size and model', ok.points === 2 && (() => { const v = readRows(P.checks); return v.length === 1 && v[0].id === fid && v[0].tier === 'big' && v[0].model === 'qwen3.5-35b' && v[0].vote === 'real' && v[0].grounded; })());
  check('one real vote from a big machine is not yet a confirmation', checkFeed.decision(fid).state === 'confirmed' ? false : checkFeed.decision(fid).state === 'pending' || checkFeed.decision(fid).yes === 1.5);
  const again = await ask('B'); const ha = again && last();
  check('a machine does not vote twice on a finding', !again || ha.feed !== 'check' || ha.job.meta.fid !== fid);
  if (again) await reply('B', again, JSON.stringify({ findings: [] }));
  const jc = await ask('C'); const hc = last();
  check('a second machine, a different model, is asked next', hc.feed === 'check' && hc.job.meta.fid === fid && hc.ctx.model === 'gemma-3-4b');
  await reply('C', jc, JSON.stringify({ verdict: 'real', line: 2, quote: 'if (a >= b) return 1;', why: 'agree' }));
  const dec = checkFeed.decision(fid);
  check('a big and a small machine saying real confirm it (1.5 + 1 against a quorum of 2)', dec.state === 'confirmed' && dec.yes === 2.5 && dec.no === 0 && dec.counts.real === 2);
  const n0 = handed.length; const jd = await L.lease({ miner: '0x' + 'd4'.repeat(20), ip: '4.4.4.4', hw: small, model: 'qwen3.5-4b', kinds: ['scan'] });
  check('a decided finding is not handed to anyone else', handed.slice(n0).every((h) => h.feed !== 'check'));
  if (jd) await L.submit({ id: jd.id, lease: jd.lease, miner: '0x' + 'd4'.repeat(20), ip: '4.4.4.4', text: '{"findings":[]}' });
}

// --- a skeptic exam: grounded verdicts on planted claims are graded
{
  const exFeed = makeCheckFeed({ source: scan.source, sample: scan.sample, inbox: P.inbox, checks: P.checks, exam: P.exam, examEvery: 1, rand: mulberry(3) });
  const L2 = makeLeases({ check: exFeed, scanPerHour: 1000, waitMs: 30, points: { answer: 1, canary: 1, scan: 1, check: 1 }, clientMaxPerDay: 1000 });
  const jobs = [];
  for (let i = 0; i < 6; i++) {
    const j = await L2.lease({ ...M.B, kinds: ['scan'] }); if (!j) continue;
    const code = j.messages[1].content.split('\n\nCode:\n')[1]; const line = code.split('\n').map((l) => l.replace(/^\d+:\s?/, '')).find((l) => l.trim().length > 12);
    const claimNew = (j.messages[1].content.match(/\n\+ (.+)/) || [])[1];
    jobs.push({ claimNew, code });
    await L2.submit({ id: j.id, lease: j.lease, miner: B, ip: M.B.ip, text: JSON.stringify({ verdict: code.includes(claimNew) ? 'false' : 'real', line: 1, quote: line.trim(), why: 'x' }) });
  }
  const invalid = readRows(P.exam).filter((r) => r.role === 'skeptic' && r.outcome === 'invalid');
  check('the skeptic reply that was not a verdict was kept as invalid, with the start of what it said', invalid.length === 1 && invalid[0].exam === false && invalid[0].sample === 'Looks right to me!' && invalid[0].tier === 'big' && invalid[0].model === 'qwen3.5-35b' && invalid[0].miner === B);
  const rows = readRows(P.exam).filter((r) => r.role === 'skeptic' && r.outcome !== 'invalid');
  check('skeptic exams are graded, with the lens, the kind, whether the claim was true, and the machine', rows.length >= 4 && rows.every((r) => r.lens && r.kind && typeof r.truth === 'boolean' && r.tier === 'big' && r.outcome && r.node));
  const sum = exFeed.summary();
  check('the summary counts them by lens and by tier, and the invalid reply apart from them', sum.exam.skeptic.n === rows.length && sum.exam.skeptic.byTier.big.n === rows.length && sum.exam.skeptic.invalid === 1);
  check('both a true and a false claim were made', rows.some((r) => r.truth === true) && rows.some((r) => r.truth === false));
  check('a skeptic that reads the code (says real when the claim is true, false when it is not) is right on both', rows.filter((r) => r.outcome === 'right').length >= rows.length - 2);
}

// --- the digest carries only what the skeptics confirmed
{
  const posts = [];
  const poster = makeDigestPoster({ api: 'https://x', secret: 's', inbox: P.inbox, results: P.results, stateFile: path.join(d, 'digest.json'), hourUtc: 0, decide: (r) => checkFeed.decision(r.id), now: () => Date.parse('2026-11-13T08:00:00Z'),
    fetchImpl: async (u, i) => { posts.push(JSON.parse(i.body)); return { ok: true, status: 200, text: async () => '{}' }; } });
  const r = await poster.tick();
  check('the digest holds the one confirmed finding, credited to its scout, and says how the skeptics voted', r.posted === 1 && posts[0].findings.length === 1 && posts[0].findings[0].by === '0xa1a1…a1a1' && /^boundaries and thresholds, lines \d+-\d+ · 2 of 2 checkers say real$/.test(posts[0].findings[0].subject) && posts[0].findings[0].line === 2 && posts[0].reviewed >= 1);
}
rmSync(d, { recursive: true, force: true });
console.log(fails ? `${fails} swarm test(s) failed` : 'swarm: all tests passed'); process.exit(fails ? 1 : 0);
