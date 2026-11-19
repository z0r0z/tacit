// The settle relay reports the prover board's stage for every proof it waits on (src/settle-relay.js stageReport, src/lib/prover.js withStageReport / boardQuiet).
//
// Each place the relay asks for a proof goes through withStageReport with the ids of the jobs the proof is for, so the holder's page can say "waiting for a prover" and
// "a prover is starting up" for any of them: a call site added later without it would leave that job with one bar, silently.
//
//   node worker-relay/tests/stage-report.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const relay = readFileSync(join(here, '../src/settle-relay.js'), 'utf8');
const prover = readFileSync(join(here, '../src/lib/prover.js'), 'utf8');
const client = readFileSync(join(here, '../src/lib/worker-client.js'), 'utf8');
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

test('every proof the settle relay asks for is wrapped in withStageReport, with the jobs it is for', () => {
  const calls = relay.split('\n').filter((l) => /\bprove(Settle|Mixed|Sealed)\(\{/.test(l) && !/^import|^\/\//.test(l.trim()) && !/^\s*\/\//.test(l));
  assert.equal(calls.length, 5, `${calls.length} prove calls found: the single, batch, mixed, prove-only and sealed ones (a new one needs the report too, and this count)`);
  for (const l of calls) assert.match(l, /withStageReport\(stageReport\(.+\), \(\) => prove(Settle|Mixed|Sealed)\(/, `not wrapped: ${l.trim().slice(0, 140)}`);
});

test('a batch reports for each of its jobs', () => {
  assert.match(relay, /withStageReport\(stageReport\(jobs\.map\(\(x\) => x\.jobId\)\), \(\) => proveSettle\(\{ type: 'batchtransfer'/);
  assert.match(relay, /withStageReport\(stageReport\(jobs\.map\(\(x\) => x\.jobId\)\), \(\) => proveMixed\(/);
  assert.match(relay, /const stageReport = \(ids\) => \(stage\) => \{ for \(const jobId of ids\) confidentialStage\(\{ jobId, stage \}\)\.catch\(\(\) => \{\}\); \};/);
});

test('the board lane is handed the report, on both ways in, and the quiet check', () => {
  assert.equal((prover.match(/onStage: stageStore\.getStore\(\)\?\.report/g) || []).length, 2, 'viaBoard and proveSealed');
  assert.match(prover, /alive: boardAlive, quiet: boardQuiet,/);
});

test('boardQuiet is true only when Tacit\'s own worker has not polled for more than 8 s, and never for community machines or an unreadable board', () => {
  const body = prover.slice(prover.indexOf('export async function boardQuiet'), prover.indexOf("// → true (the pool takes it), 'stale'"));
  const make = (workers) => new Function('boardSummary', 'Date', `let quietAt = 0, quietWas = false;\n${body}\nreturn boardQuiet;`.replace('export async function', 'async function'))(async () => (workers ? { workers } : null), { now: (() => { let t = 0; return () => (t += 10_000); })() });
  return Promise.all([
    make([{ name: 'tacit-a5000', lastSeenSeconds: 3 }])().then((v) => assert.equal(v, false, 'polling now')),
    make([{ name: 'tacit-a5000', lastSeenSeconds: 40 }])().then((v) => assert.equal(v, true, 'quiet')),
    make([{ name: 'c-0x1', community: true, lastSeenSeconds: 60 }, { name: 'tacit-a5000', lastSeenSeconds: 2 }])().then((v) => assert.equal(v, false, 'a quiet community machine counts')),
    make([{ name: 'c-0x1', community: true, lastSeenSeconds: 60 }])().then((v) => assert.equal(v, false, 'no Tacit worker was ever seen')),
    make([{ name: 'tacit-a5000', lastSeenSeconds: null }])().then((v) => assert.equal(v, false, 'never seen')),
    make(null)().then((v) => assert.equal(v, false, 'unreadable board')),
  ]).then(() => { console.log('ok - (quiet cases)'); });
});

test('the stage goes to its own route and is never waited on', () => {
  assert.match(client, /export async function confidentialStage\(\{ jobId, stage \}\) \{\s*try \{ await postJson\('\/confidential\/stage', \{ jobId, stage \}, \{ timeoutMs: 8_000 \}\); \} catch/);
});

console.log(`${n} passed`);
