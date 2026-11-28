// The page names the wait for a prover (dapp/confidential-relay.js waitForSettle/waitForProof, dapp/activity.js makeFollow, dapp/index.html boardWord / paceTick).
//
// 2026-11-19: a withdrawal waited 54 s for the GPU box (restarting its GPU server) under one bar. The relay now says where the job stands at the board ('queued',
// 'starting', 'claimed': worker/src/confidential-settle.js stageJob, on the job's status as `stage`), and the line under the bar says it: "waiting for a prover",
// "a prover is getting ready", "a prover has it". A change of that word reaches the page's update hook without announcing the status again; a job followed in Activity
// (after a reload) carries it too; and it shows only while the job is being proved.
//
// The relay client runs against the real in-memory queue, the box simulated by saying stages between polls.
//
// Run: node tests/board-stage-page.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialSettler } from '../worker/src/confidential-settle.js';
import { frontPage } from './lib/front-page.mjs';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const ET = new EventTarget();
globalThis.addEventListener = ET.addEventListener.bind(ET); globalThis.removeEventListener = ET.removeEventListener.bind(ET); globalThis.dispatchEvent = ET.dispatchEvent.bind(ET);
const { makeConfidentialRelay } = await import('../dapp/confidential-relay.js');
const A = await import('../dapp/activity.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = frontPage(join(ROOT, 'dapp/index.html'));
const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };
const between = (from, to) => { const a = page.indexOf(from), b = page.indexOf(to, a); if (a < 0 || b < 0) throw new Error(`cannot find ${JSON.stringify(from)}`); return page.slice(a, b); };

function store() {
  const jobs = new Map(); let pending = [];
  return { getPending: async () => pending.slice(), putPending: async (ids) => { pending = ids.slice(); }, getJob: async (id) => (jobs.has(id) ? JSON.parse(JSON.stringify(jobs.get(id))) : null), putJob: async (id, j) => { jobs.set(id, JSON.parse(JSON.stringify(j))); } };
}
const fetchOver = (q) => async (urlStr, opts = {}) => {
  const url = new URL(urlStr, 'http://relay.test');
  const reply = (status, obj) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), text: async () => JSON.stringify(obj) });
  if (url.pathname === '/confidential/submit' && opts.method === 'POST') { const b = JSON.parse(opts.body); return reply(200, { ok: true, ...(await q.submitJob({ type: b.type, op: b.op, memos: b.memos })) }); }
  if (url.pathname === '/confidential/status') { const st = await q.jobStatus(url.searchParams.get('id')); return st ? reply(200, st) : reply(404, { error: 'unknown job' }); }
  return reply(404, { error: 'no route' });
};
const swapOp = { reserveAPre: 1000, reserveBPre: 1000, intents: [{ amountIn: 100 }] };

await test('waitForSettle passes each change of the board\'s word to onUpdate, once, and the status only when it changes', async () => {
  const q = makeConfidentialSettler({ storage: store(), hash });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: fetchOver(q) });
  const { jobId } = await relay.submitOp({ type: 'swap', op: swapOp, memos: ['0xaa'] });
  await q.nextJob();
  // the box: says a word between polls (the relay's sleep is its poll), then settles
  const script = [() => q.stageJob(jobId, 'queued'), () => {}, () => q.stageJob(jobId, 'starting'), () => q.stageJob(jobId, 'starting'), () => q.stageJob(jobId, 'claimed'), () => q.ackJob(jobId, { txHash: '0xcafe' })];
  let i = 0;
  const seen = [], announced = [];
  addEventListener('tacit:job', (e) => announced.push(e.detail.status));
  const final = await relay.waitForSettle(jobId, { intervalMs: 0, sleep: async () => { const f = script[i++]; if (f) await f(); }, onUpdate: (s) => seen.push(`${s.status}:${s.stage || ''}`) });
  ok(final.status === 'settled' && final.txHash === '0xcafe', 'did not settle');
  ok(JSON.stringify(seen) === JSON.stringify(['proving:', 'proving:queued', 'proving:starting', 'proving:claimed', 'settled:']), `onUpdate saw ${JSON.stringify(seen)}`);
  ok(announced.filter((s) => s === 'proving').length === 1, `the status was announced again on a stage change: ${announced}`);
});

await test('both waits carry the stage clause (the proof wait too)', () => {
  const src = readFileSync(join(ROOT, 'dapp/confidential-relay.js'), 'utf8');
  ok((src.match(/else if \(staged && onUpdate\) onUpdate\(st\)/g) || []).length === 2, 'waitForSettle and waitForProof must both pass a stage change on');
});

await test('a job followed in Activity (a reload) carries the board\'s word on its entry', async () => {
  const J = A.makeJournal({ pub: () => null });
  const F = A.makeFollow({ journal: J, jobStatus: async () => ({ status: 'proving', stage: 'starting' }), receipt: async () => null, receiptOnce: async () => null, btcConfirmed: async () => false, own: () => false });
  J.put('job:z', { kind: 'job', status: 'pending' }); F.job('job:z');
  await new Promise((r) => setTimeout(r, 30));
  ok(J.get('job:z').board === 'starting', `entry ${JSON.stringify(J.get('job:z'))}`);
});

await test('the page keeps the word on the entry for a relayed job', () => {
  ok(/actPut\('job:' \+ st\.jobId, \{ ahead: [^}]*board: st\.stage \?\? undefined \}\)/.test(page), 'spStage does not put the stage on a relayed job');
});

// boardWord, cut out of the page
const words = new Function('opParts', 'ended', `${between('const BOARD_WORDS', 'const leftWords')}\nreturn { boardWord, BOARD_WORDS };`)(
  (op) => op.parts, (x) => ['settled', 'failed', 'confirmed'].includes(x.status));

await test('the word shows for a job being proved, and in the words a person reads', () => {
  ok(words.boardWord({ kind: 'job', status: 'proving', board: 'queued' }) === 'waiting for a prover', 'queued');
  ok(words.boardWord({ kind: 'job', status: 'proving', board: 'starting' }) === 'a prover is getting ready', 'starting');
  ok(words.boardWord({ kind: 'job', status: 'proving', board: 'claimed' }) === 'a prover has it', 'claimed');
});

await test('it shows only while the job is being proved, and only for a word the page knows', () => {
  for (const status of ['pending', 'proven', 'sending', 'settled', 'failed']) ok(words.boardWord({ kind: 'job', status, board: 'claimed' }) === null, `shown while ${status}`);
  ok(words.boardWord({ kind: 'job', status: 'proving', board: '<img onerror=x>' }) === null, 'an unknown word was shown');
  ok(words.boardWord({ kind: 'job', status: 'proving' }) === null && words.boardWord(null) === null, 'a word from nowhere');
});

await test('an action of several jobs shows the word of the one being proved', () => {
  const op = { kind: 'op', parts: [{ it: { status: 'settled', board: 'claimed' } }, { it: { status: 'proving', board: 'starting' } }, { it: null }] };
  ok(words.boardWord(op) === 'a prover is getting ready', `got ${words.boardWord(op)}`);
  ok(words.boardWord({ kind: 'op', parts: [{ it: { status: 'settled' } }] }) === null, 'a finished action showed one');
});

await test('the line under the bar joins the word to the time left, or to "taking longer than usual"', () => {
  ok(/const bw = boardWord\(actGet\(b\.dataset\.pace\)\), w = `\$\{bw \? `\$\{bw\}, ` : ''\}\$\{pc\.late \? 'taking longer than usual' : leftWords\(pc\.left\)\}`/.test(page), 'paceTick does not join them');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
