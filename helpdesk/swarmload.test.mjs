// node swarmload.test.mjs -- the review at the size of a community: thousands of open findings and votes, an exam file past its limit, twenty machines taking jobs
// as fast as they can. A lease and its answer must not get slower as the record grows (no file read again per job), and the files must stay bounded.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeLeases } from './lease.mjs';
import { makeScanFeed } from './scanfeed.mjs';
import { makeCheckFeed } from './checkfeed.mjs';
import { makeExamBook, makeVoteBook } from './swarmbook.mjs';
import { makePlantPool } from './codecheck/mutate.mjs';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };

const d = mkdtempSync(path.join(tmpdir(), 'load-')), repo = path.join(d, 'r'); mkdirSync(path.join(repo, 'dapp'), { recursive: true });
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
const FILES = ['a', 'b', 'c', 'd', 'e'], LINES = 300;
const lineOf = (f, i) => `  const ${f}${i} = Number(v${i}) / 1e8; if (${f}${i} >= ${i}) out.push(BigInt(${f}${i}));`;
git('init', '-q', '-b', 'main');
for (const f of FILES) writeFileSync(path.join(repo, `dapp/${f}.js`), `export function run(v, out) {\n${Array.from({ length: LINES }, (_, i) => lineOf(f, i)).join('\n')}\n}\n`);
git('add', '.'); git('commit', '-qm', 'one'); const commit = git('rev-parse', 'HEAD').trim().slice(0, 10);

const P = { inbox: path.join(d, 'inbox.jsonl'), checks: path.join(d, 'checks.jsonl'), exam: path.join(d, 'exam.jsonl'), results: path.join(d, 'results.jsonl'), cursor: path.join(d, 'cur.json'), ledger: path.join(d, 'ledger.jsonl') };
// 3000 open findings, each about a real line; 3000 votes on them; 150,000 exam rows already on file
const findings = Array.from({ length: 3000 }, (_, k) => { const f = FILES[k % 5], i = k % LINES; return { t: k, id: `f${k}`, miner: '0x' + 'a'.repeat(40), node: `p${k % 7}`, file: `dapp/${f}.js`, commit, window: `${i + 1}-${i + 3}`, line: i + 2, why: 'w', old: `${f}${i} >= ${i}`, new: `${f}${i} > ${i}`, status: 'syntax-ok', review: 'new' }; });
writeFileSync(P.inbox, findings.map((r) => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(P.checks, Array.from({ length: 3000 }, (_, k) => JSON.stringify({ t: k, id: `f${k % 3000}`, node: `v${k % 10}`, miner: '0x' + 'b'.repeat(40), tier: 'small', vote: 'unsure', choice: 'unsure' })).join('\n') + '\n');
writeFileSync(P.exam, Array.from({ length: 150000 }, (_, k) => JSON.stringify({ t: k, role: k % 3 ? 'skeptic' : 'scout', node: `n${k % 40}`, miner: '0x' + 'c'.repeat(40), tier: 'small', lens: 'bounds', kind: 'ge-to-gt', truth: !!(k % 2), choice: 'A', outcome: k % 3 ? (k % 5 ? 'right' : 'wrong') : (k % 4 ? 'miss' : 'near'), fp: 0 })).join('\n') + '\n');

const t0 = Date.now();
const book = makeExamBook({ file: P.exam }), votes = makeVoteBook({ file: P.checks });
const openMs = Date.now() - t0;
check(`the exam file past its limit is cut back to the newest 100,000 rows when opened (${openMs} ms)`, book.lines() === 100000 && readFileSync(P.exam, 'utf8').trim().split('\n').length === 100000);
let scan = null; let seed = 11; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pool = makePlantPool({ sample: () => scan.sample(), source: (c, f) => scan.source(c, f), size: 40, rand });
scan = makeScanFeed({ repo, ref: 'main', inbox: P.inbox, results: P.results, resultsEveryMs: 60000, cursorFile: P.cursor, refreshMs: 1e9, lenses: true, examBook: book, pool, rand });
const checkFeed = makeCheckFeed({ source: scan.source, sample: scan.sample, inbox: P.inbox, checks: votes, exam: book, pool, examEvery: 4, rand });
pool.fill(20);
const L = makeLeases({ ledger: P.ledger, scan, check: checkFeed, checkShare: 0.5, rand, scanPerHour: 100000, waitMs: 10, points: { answer: 1, canary: 1, scan: 1, check: 1 }, clientMaxPerDay: 30, payable: (kind, ctx) => book.payable(kind, ctx.node) });

const machines = Array.from({ length: 20 }, (_, k) => ({ miner: '0x' + String(k).padStart(2, '0').repeat(20), ip: `10.0.0.${k + 1}`, hw: { ram: k % 2 ? 64 : 16, vram: k % 2 ? 24 : 6, cores: 8, os: 'linux', arch: 'x64' }, model: k % 3 ? 'qwen3.5-4b' : 'gemma-3-4b' }));
const reply = (j) => (/JUDGE/.test(j.messages[0].content) ? JSON.stringify({ choice: rand() < 0.5 ? 'A' : 'B', line: 2, quote: 'export function run(v, out) {', why: 'x' }) : '{"findings":[]}');
const ROUNDS = 1500; let done = 0, kinds = { check: 0, scan: 0 }, empty = 0;
const t1 = Date.now();
for (let r = 0; r < ROUNDS; r++) {
  const m = machines[r % machines.length];
  const j = await L.lease({ miner: m.miner, ip: m.ip, kinds: ['scan'], hw: m.hw, model: m.model }); if (!j) { empty++; continue; }
  kinds[/JUDGE/.test(j.messages[0].content) ? 'check' : 'scan']++;
  const s = await L.submit({ id: j.id, lease: j.lease, miner: m.miner, ip: m.ip, text: reply(j) }); if (s.ok) done++;
}
const ms = Date.now() - t1, per = ms / ROUNDS;
console.log(`     ${ROUNDS} rounds in ${ms} ms (${per.toFixed(2)} ms each): ${kinds.check} checks, ${kinds.scan} scans, ${empty} empty`);
check('every round got a job and its answer was taken', done === ROUNDS && empty === 0);
check('both roles were handed out', kinds.check > 100 && kinds.scan > 100);
check(`a lease and its answer stay fast with 100,000 exam rows, 3,000 findings and 3,000 votes on record (${per.toFixed(1)} ms each, under 25)`, per < 25);
const t2 = Date.now(); const s1 = checkFeed.summary(); const s2 = checkFeed.summary(); const sumMs = Date.now() - t2;
check(`the stats are worked out quickly, and not again when nothing has changed (${sumMs} ms)`, sumMs < 1500 && s1 === s2 && s1.findings.pending + s1.findings.unclear + s1.findings.confirmed + s1.findings.refuted === 3000 && Array.isArray(s1.reviewers));
check('the exam answers went to the book', book.lines() > 100000 && book.summary().skeptic.n + book.summary().scout.n > 0);
scan.flush();
check('the windows looked at take one line, not one per job', readFileSync(P.results, 'utf8').trim().split('\n').length === 1 && JSON.parse(readFileSync(P.results, 'utf8')).windows > 100);
const ledgerLines = readFileSync(P.ledger, 'utf8').trim().split('\n').length;
check(`the ledger holds only paid work: with a cap of 30 points a client a day, at most 600 lines for ${ROUNDS} jobs (${ledgerLines})`, ledgerLines > 0 && ledgerLines <= 20 * 30);
check(`the exam file stays under its limit plus what came in (${(statSync(P.exam).size / 1e6).toFixed(1)} MB)`, book.lines() <= 200000);
L.close(); rmSync(d, { recursive: true, force: true });
console.log(fails ? `${fails} load test(s) failed` : 'swarm load: all tests passed'); process.exit(fails ? 1 : 0);
