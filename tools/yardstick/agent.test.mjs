#!/usr/bin/env node
// The agent loop against a scripted fake model (no real model needed):
//   REPO=/path/to/a/throwaway/clone node tools/yardstick/agent.test.mjs
// Checks: old tool results are cut once the window is ~60% full (and only in what is SENT: the transcript keeps the
// full text), an identical repeated call is refused, a run that calls finish ends as 'finish', and the saved patch
// and transcript exist. RUN IN A THROWAWAY CLONE: the loop checks out other commits there.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO;
if (!REPO || !existsSync(join(REPO, '.git'))) { console.error('set REPO to a throwaway clone (clone.sh makes one)'); process.exit(2); }
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// the dev item whose tests run fastest: grading runs them, and this test is about the loop, not about the tests
const rd = (f) => readFileSync(join(HERE, 'data', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ms = new Map(rd('validated.jsonl').map((v) => [v.id, v.passMs]));
const item = rd('dev.jsonl').filter((c) => c.modes.includes('symptom')).sort((a, b) => ms.get(a.id) - ms.get(b.id))[0];
const tmp = mkdtempSync(join(tmpdir(), 'ys-agent-test-'));
writeFileSync(join(tmp, 'items.jsonl'), JSON.stringify({ ...item, srcLines: 1 }) + '\n');

const bodies = [];
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw); bodies.push(body);
    const t = bodies.length;
    // a real server reports what it was sent: ~2,600 tokens per full tool result, so compaction brings the count back down
    const full = body.messages.filter((m) => m.role === 'tool' && !m.content.startsWith('[elided')).length;
    const call = t <= 9 ? { name: 'read_file', args: { path: 'dapp/tacit.js', start: 300 * t, end: 300 * t + 249 } }
      : t === 10 ? { name: 'read_file', args: { path: 'dapp/tacit.js', start: 300 * 9, end: 300 * 9 + 249 } }   // the same call as turn 9
      : { name: 'finish', args: { summary: 'done' } };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `c${t}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }],
      usage: { prompt_tokens: 500 + 2600 * full, completion_tokens: 12 }, timings: { prompt_n: 100, prompt_ms: 100, predicted_n: 12, predicted_ms: 300 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const out = join(tmp, 'out.jsonl');
// async spawn: this process hosts the fake model, so it must not block while the agent runs
const run = (args, opts) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, opts); let so = '', se = '';
  p.stdout.on('data', (d) => (so += d)); p.stderr.on('data', (d) => (se += d));
  const t = setTimeout(() => p.kill('SIGKILL'), 900000);
  p.on('close', (status, signal) => { clearTimeout(t); resolve({ status, signal, stdout: so, stderr: se }); });
});
const r = await run([join(HERE, 'agent.mjs'), join(tmp, 'items.jsonl'), out, '--mode', 'symptom', '--turns', '20', '--tag', 'fake'],
  { env: { ...process.env, REPO, MODEL_URL: `http://127.0.0.1:${port}` } });
server.close();
if (r.status !== 0) console.log(`agent exited status=${r.status} signal=${r.signal}\n`, r.stdout, r.stderr);
const rec = JSON.parse(readFileSync(out, 'utf8').split('\n').find(Boolean));

ok(r.status === 0, 'the loop runs to the end');
ok(rec.finish === 'finish', `ends as finish (got ${rec.finish})`);
ok(rec.turns === 11, `11 turns (got ${rec.turns})`);
ok(rec.compactions >= 1, `old results were compacted (${rec.compactions}x)`);
ok(rec.repeats === 1, `the repeated call was refused once (got ${rec.repeats})`);
const last = bodies[bodies.length - 1].messages;
const firstRead = last.find((m) => m.role === 'tool');
ok(firstRead.content.startsWith('[elided'), 'what is sent no longer carries the first file read in full');
ok(last.filter((m) => m.role === 'tool' && !m.content.startsWith('[elided')).length <= 5, 'only the most recent results are kept in full');
const transcript = JSON.parse(readFileSync(join(tmp, 'transcripts-fake', `${item.id}.0.json`), 'utf8'));
const fullFirst = transcript.find((m) => m.role === 'tool');
ok(!fullFirst.content.startsWith('[elided') && fullFirst.content.length > 500, 'the saved transcript keeps the full first read');
ok(existsSync(join(tmp, 'patches-fake', `${item.id}.0.patch`)), 'a patch file is written (empty here: the fake model edits nothing)');
ok(rec.solved === false, 'no edit means not solved');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
