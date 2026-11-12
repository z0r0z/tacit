// node reviewdigest.test.mjs -- which community suggestions go to the review channel, how they are worded, and once a day
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { trivial, shortAddr, pick, toDigest, makeDigestPoster } from './reviewdigest.mjs';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
let t0 = Date.parse('2026-11-13T01:00:00Z');
const rec = (o) => ({ t: t0++, miner: A, file: 'dapp/a.js', commit: 'abcdef0123', window: '1-90', line: 10, why: 'the index is off by one', old: 'for (let i = 0; i <= xs.length; i++) f(xs[i]);', new: 'for (let i = 0; i < xs.length; i++) f(xs[i]);', status: 'syntax-ok', review: 'new', ...o });

// --- what counts as a change
check('moved whitespace is trivial', trivial('a = 1;', 'a  =  1 ;'));
check('an edited comment is trivial', trivial('a = 1; // one', 'a = 1; // two') && trivial('/* x */ a = 1;', 'a = 1;'));
check('a changed token is not trivial', !trivial('a = 1;', 'a = 2;'));
check('an addresses is shortened to its ends and anything else is dropped', shortAddr(A) === '0xaaaa…aaaa' && shortAddr('0xabc') === '' && shortAddr('x\u001b[2J') === '' && shortAddr(undefined) === '');

// --- which are picked
{
  const rows = [
    rec({}),
    rec({ status: 'no-apply', line: 20 }),
    rec({ status: 'syntax-error', line: 30 }),
    rec({ review: 'rejected', line: 40 }),
    rec({ review: 'useful', line: 50 }),
    rec({ old: 'a = 1;', new: ' a  =  1 ;', line: 60 }),
    rec({ why: '   ', line: 70 }),
    rec({ line: undefined }),
    null,
  ];
  const got = pick(rows);
  check('only new suggestions that apply, parse and change something are picked', got.length === 1 && got[0].r.line === 10);
}
{
  // the winners here are the OLDEST rows, so a ranking by recency alone would put them last
  const rows = [
    rec({ t: 1, file: 'dapp/y.js', line: 100, miner: A }),
    rec({ t: 2, file: 'dapp/y.js', line: 102, miner: B, old: 'x = 1;', new: 'x = 2;' }),   // another reviewer, the same spot in y.js
    rec({ t: 3, file: 'dapp/x.js', line: 100, miner: A }),
  ];
  const got = pick(rows);
  check('two reviewers on the same spot rank above one, however recent the one is', got[0].r.file === 'dapp/y.js' && got[0].n === 2 && got[1].n === 1);
  check('the same spot is posted once however many say it', got.filter((x) => x.r.file === 'dapp/y.js').length === 1 && got.length === 2);
}
{
  const same = { old: 'a = 1;', new: 'a = 2;' };
  const rows = [rec({ t: 1, line: 10, ...same, fresh: true }), rec({ t: 2, line: 200, ...same })];
  check('code that just changed comes first among equals, however recent the other is', pick(rows)[0].r.line === 10);
  const small = rec({ t: 1, line: 400, old: 'a = 1;', new: 'a = 2;' }), big = rec({ t: 2, line: 300, old: 'x'.repeat(900), new: 'y'.repeat(900) });
  check('a smaller change comes before a larger one, however recent the larger is', pick([big, small])[0].r.line === 400);
  check('among equals the newer comes first', pick([rec({ t: 1, line: 10, ...same }), rec({ t: 2, line: 200, ...same })])[0].r.line === 200);
}
{
  const rows = Array.from({ length: 12 }, (_, i) => rec({ file: `dapp/f${i % 6}.js`, line: 10 + 50 * Math.floor(i / 6) + i, old: `v${i} = 1;`, new: `v${i} = 2;` }));
  const got = pick(rows, { max: 8, perFile: 2 });
  const per = {}; got.forEach((x) => { per[x.r.file] = (per[x.r.file] || 0) + 1; });
  check('at most max in all', got.length === 8 && pick(rows, { max: 3 }).length === 3);
  check('at most perFile from one file', Math.max(...Object.values(per)) <= 2);
  const lots = Array.from({ length: 5 }, (_, i) => rec({ line: 10 + 40 * i, old: `w${i} = 1;`, new: `w${i} = 2;` }));
  check('one file does not fill the digest', pick(lots).length === 2);
}

// --- the digest the API takes
{
  const picked = pick([rec({ miner: A }), rec({ miner: B, line: 12, old: 'q = 1;', new: 'q = 2;' }), rec({ file: 'dapp/z.js', line: 5, miner: C, why: 'x'.repeat(500) })]);
  const d = toDigest(picked, { day: '2026-11-13', reviewed: 41 });
  check('the digest says the day, the windows looked at and that they are windows', d.day === '2026-11-13' && d.reviewed === 41 && d.unit === 'window');
  check('findings are community candidates, low, with ids that start from the day', d.findings.length === 2 && d.findings.every((f) => f.status === 'candidate' && f.severity === 'low') && d.findings[0].id === 'n261113-1' && d.findings[1].id === 'n261113-2');
  const f0 = d.findings.find((f) => f.file === 'dapp/a.js'), f1 = d.findings.find((f) => f.file === 'dapp/z.js');
  check('a reviewer is named by its short address, with how many more agreed (the newer of two on one spot speaks for it)', f0.by === '0xbbbb…bbbb +1 more' && f0.line === 12 && f1.by === '0xcccc…cccc');
  check('the claim and the change are one line each and cut to size', f1.claim.length === 300 && !/\n/.test(f1.evidence) && f1.evidence.startsWith('suggested change: for (let i = 0; i <= xs.length') && f1.evidence.includes(' -> ') && f0.evidence === 'suggested change: q = 1; -> q = 2;');
  check('a finding says where it is: the file, the line, the commit and the window', f1.line === 5 && f1.commit === 'abcdef0123' && f1.subject === 'window 1-90');
}

// --- once a day
const dir = mkdtempSync(path.join(tmpdir(), 'rd-'));
try {
  const inbox = path.join(dir, 'inbox.jsonl'), results = path.join(dir, 'results.jsonl'), stateFile = path.join(dir, 'state.json');
  const day = (iso) => Date.parse(iso);
  const calls = []; let reply = { ok: true, status: 200, text: async () => '{"ok":true}' };
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return reply; };
  let clock = day('2026-11-13T00:30:00Z');
  const mk = (o = {}) => makeDigestPoster({ api: 'https://api.example', secret: 's3cret', inbox, results, stateFile, now: () => clock, fetchImpl, ...o });
  const put = (file, rows) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  put(inbox, [rec({ t: day('2026-11-12T09:00:00Z') }), rec({ t: day('2026-11-12T10:00:00Z'), line: 90, old: 'k = 1;', new: 'k = 2;' })]);
  put(results, Array.from({ length: 30 }, (_, i) => ({ t: day('2026-11-12T08:00:00Z') + i, miner: A, n: 0 })));

  const p = mk();
  const r1 = await p.tick();
  check('a digest goes to the API with the secret, as JSON', calls.length === 1 && calls[0].url === 'https://api.example/nudger/digest' && calls[0].init.method === 'POST' && calls[0].init.headers.Authorization === 'Bearer s3cret' && calls[0].init.headers['Content-Type'] === 'application/json');
  check('it carries the findings and the windows counted', r1.posted === 2 && r1.reviewed === 30 && calls[0].body.findings.length === 2 && calls[0].body.reviewed === 30 && calls[0].body.day === '2026-11-13');
  check('the day is recorded so a restart does not post it again', JSON.parse(readFileSync(stateFile, 'utf8')).lastDay === '2026-11-13' && (await mk().tick()) === null && calls.length === 1);
  clock = day('2026-11-13T18:00:00Z');
  check('later the same day nothing more is posted', (await p.tick()) === null && calls.length === 1);

  // the next day only what came in since
  put(inbox, [rec({ t: day('2026-11-12T09:00:00Z') }), rec({ t: day('2026-11-13T05:00:00Z'), line: 150, old: 'm = 1;', new: 'm = 2;' })]);
  writeFileSync(results, readFileSync(results, 'utf8') + Array.from({ length: 7 }, (_, i) => JSON.stringify({ t: day('2026-11-13T04:00:00Z') + i, miner: B, n: 0 })).join('\n') + '\n');   // the older lines stay: only the new ones are counted
  clock = day('2026-11-14T00:10:00Z');
  const r2 = await p.tick();
  check('the next day carries only what came in since the last digest', r2.posted === 1 && r2.reviewed === 7 && calls.length === 2 && calls[1].body.findings[0].line === 150);

  // a refusal leaves the day open
  clock = day('2026-11-15T00:10:00Z'); reply = { ok: false, status: 500, text: async () => 'boom' };
  const r3 = await p.tick();
  check('a refusal is reported and the day stays open', r3.error.includes('500') && JSON.parse(readFileSync(stateFile, 'utf8')).lastDay === '2026-11-14');
  reply = { ok: true, status: 200, text: async () => '{}' };
  const r4 = await p.tick();
  check('and the next tick tries again', r4.posted === 0 && calls.length === 4 && JSON.parse(readFileSync(stateFile, 'utf8')).lastDay === '2026-11-15');
  check('a quiet day still posts, so the channel shows the reviewers ran', calls[3].body.findings.length === 0);

  // two ticks while the first still waits on the API: one post
  rmSync(stateFile); calls.length = 0; clock = day('2026-11-17T01:00:00Z');
  { let release; const slow = new Promise((r) => { release = r; });
    const p2 = mk({ fetchImpl: async (u, i) => { calls.push({ url: u, init: i, body: JSON.parse(i.body) }); await slow; return reply; } });
    const a = p2.tick(), b = p2.tick(); release();
    const [ra, rb] = await Promise.all([a, b]);
    check('a tick that overlaps one still waiting on the API posts nothing', calls.length === 1 && rb === null && ra.posted >= 0);
    check('and once it is done the day is not posted again', (await p2.tick()) === null && calls.length === 1); }

  // the hour
  rmSync(stateFile); rmSync(inbox); rmSync(results); calls.length = 0; clock = day('2026-11-16T05:59:00Z');
  const late = mk({ hourUtc: 6 });
  check('nothing is posted before the hour', (await late.tick()) === null && calls.length === 0);
  clock = day('2026-11-16T06:00:00Z');
  check('and it is posted from the hour on', (await late.tick()).posted === 0 && calls.length === 1);

  // no files yet
  for (const f of [inbox, results, stateFile]) rmSync(f, { force: true }); calls.length = 0;
  check('with nothing filed and nothing counted it still posts a quiet day', (await mk().tick()).reviewed === 0 && calls.length === 1);
  writeFileSync(inbox, 'not json\n' + JSON.stringify(rec({ t: day('2026-11-16T07:00:00Z') })) + '\n{"torn":'); rmSync(stateFile);
  check('a torn or foreign line in the inbox is skipped', (await mk().tick()).posted === 1);
} finally { rmSync(dir, { recursive: true, force: true }); }

// --- with the skeptics: only what they confirmed, whenever it was filed
{
  const state = (id, o = {}) => ({ state: 'confirmed', yes: 2, no: 0, n: 2, counts: { real: 2, false: 0, unsure: 0 }, ...o });
  const rows = [rec({ id: 'a', line: 10, t: 50 }), rec({ id: 'b', line: 60, old: 'k = 1;', new: 'k = 2;', t: 60 }), rec({ id: 'c', line: 110, old: 'm = 1;', new: 'm = 2;', t: 70 }), rec({ id: 'd', line: 160, old: 'q = 1;', new: 'q = 2;', lens: 'units', window: '150-170', t: 1 })];   // d, the oldest, has the heaviest votes
  const verdicts = { a: state('a'), b: state('b', { state: 'refuted', yes: 0, no: 2 }), c: state('c', { state: 'pending', yes: 1, n: 1 }), d: state('d', { yes: 4.5, n: 3, counts: { real: 3, false: 0, unsure: 0 } }) };
  const got = pick(rows, { decide: (r) => verdicts[r.id] });
  check('with skeptics, only confirmed findings are picked', got.length === 2 && got.every((x) => x.d.state === 'confirmed'));
  check('the weight of the votes ranks them, not the age or the number of scouts', got[0].r.id === 'd' && got[1].r.id === 'a');
  const d = toDigest(got, { day: '2026-11-13', reviewed: 9 });
  const fd = d.findings.find((f) => f.line === 160), fa = d.findings.find((f) => f.line === 10);
  check('a lens finding says its lens and the vote; a window finding says its window and the vote', fd.subject === 'units and decimals, lines 150-170 · 3 of 3 checkers say real' && fa.subject === 'window 1-90 · 2 of 2 checkers say real');
  check('without skeptics the subject is the window alone', toDigest(pick([rec({})]), { day: '2026-11-13', reviewed: 1 }).findings[0].subject === 'window 1-90');
  check('a subject stays inside what the API keeps', toDigest([{ r: rec({ lens: 'units', window: '1'.repeat(300) }), n: 1, d: state('x') }], { day: '2026-11-13', reviewed: 1 }).findings[0].subject.length <= 140);
}
{
  const dir2 = mkdtempSync(path.join(tmpdir(), 'rd2-'));
  try {
    const inbox = path.join(dir2, 'i.jsonl'), results = path.join(dir2, 'r.jsonl'), stateFile = path.join(dir2, 's.json');
    const put = (rows) => writeFileSync(inbox, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); writeFileSync(results, '');
    const calls = []; let clock = Date.parse('2026-11-13T07:00:00Z'); let reply = { ok: true, status: 200, text: async () => '{}' };
    const fetchImpl = async (u, i) => { calls.push(JSON.parse(i.body)); return reply; };
    const confirmed = new Set();
    const decide = (r) => (confirmed.has(r.id) ? { state: 'confirmed', yes: 2, no: 0, n: 2, counts: { real: 2, false: 0, unsure: 0 } } : { state: 'pending', yes: 0, no: 0, n: 0, counts: { real: 0, false: 0, unsure: 0 } });
    const p = makeDigestPoster({ api: 'https://x', secret: 's', inbox, results, stateFile, decide, now: () => clock, fetchImpl });
    put([rec({ t: 1, id: 'a' }), rec({ t: 2, id: 'b', line: 80, old: 'k = 1;', new: 'k = 2;' })]);
    const r1 = await p.tick();
    check('nothing confirmed yet: a quiet day is posted, so the channel shows the work ran', r1.posted === 0 && calls.length === 1 && calls[0].findings.length === 0);
    confirmed.add('a'); clock = Date.parse('2026-11-14T07:00:00Z');
    const r2 = await p.tick();
    check('a finding filed before the last digest but confirmed after it is posted', r2.posted === 1 && calls[1].findings[0].line === 10);
    confirmed.add('b'); clock = Date.parse('2026-11-15T07:00:00Z');
    const r3 = await p.tick();
    check('and is not posted again the next day, while a newly confirmed one is', r3.posted === 1 && calls[2].findings[0].line === 80);
    check('the ids posted are kept in the state file', JSON.parse(readFileSync(stateFile, 'utf8')).posted.join() === 'a,b');
    confirmed.add('c'); put([rec({ t: 3, id: 'c', line: 120, old: 'z = 1;', new: 'z = 2;' })]); clock = Date.parse('2026-11-16T07:00:00Z'); reply = { ok: false, status: 502, text: async () => 'down' };
    const r4 = await p.tick();
    check('a refusal posts nothing and keeps the finding for the next try', r4.error && !JSON.parse(readFileSync(stateFile, 'utf8')).posted.includes('c'));
    reply = { ok: true, status: 200, text: async () => '{}' };
    check('then it goes out', (await p.tick()).posted === 1);
    const idless = rec({ t: 4, line: 200, old: 'w = 1;', new: 'w = 2;' }); delete idless.id; put([idless]);
    const seen = []; const p2 = makeDigestPoster({ api: 'https://x', secret: 's', inbox, results, stateFile: path.join(dir2, 's2.json'), decide: (r) => { seen.push(r.id); return decide(r); }, now: () => clock, fetchImpl });
    await p2.tick();
    check('an older finding with no id is judged under the id it would have been given', /^[0-9a-f]{10}$/.test(seen[0]));
  } finally { rmSync(dir2, { recursive: true, force: true }); }
}

console.log(fails ? `${fails} reviewdigest test(s) failed` : 'reviewdigest: all tests passed'); process.exit(fails ? 1 : 0);
