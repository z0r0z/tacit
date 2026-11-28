#!/usr/bin/env node
// A small coding-agent loop for the yardstick: the model proposes (through OpenAI-style tool calls), this file is
// the hands (reads, searches, edits and test runs inside a checkout), and the commit's own tests are the judge.
//
//   REPO=/root/repo MODEL_URL=http://127.0.0.1:8080 node tools/yardstick/agent.mjs ITEMS.jsonl OUT.jsonl \
//        [--mode symptom|tests-given] [--limit N] [--offset N] [--attempts K] [--max-src-lines N] [--turns 20] [--temp 0.2] [--tag name]
//   ... --oracle                      no model: apply the reference fix and grade it (checks the grader itself)
//
// RUN THIS ONLY IN A THROWAWAY CHECKOUT ON A THROWAWAY BOX: the model's edits and the tests it runs execute here.
// The model is untrusted. It never sees the reference fix or (in symptom mode) the tests; it cannot write outside the
// checkout, to .git, node_modules, contracts/ or key material; every test run is offline (tools/noweb.cjs).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.env.REPO || process.cwd());
const MODEL_URL = (process.env.MODEL_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const NOWEB = process.env.NOWEB || resolve(HERE, '..', 'noweb.cjs');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--oracle'].includes(argv[i - 1])));
const [ITEMS, OUT] = pos;
const MODE = flag('--mode', 'symptom');
const LIMIT = Number(flag('--limit', 1e9)), OFFSET = Number(flag('--offset', 0));
const ATTEMPTS = Number(flag('--attempts', 1));
const MAX_SRC = Number(flag('--max-src-lines', 1e9));
const MAX_TURNS = Number(flag('--turns', 20));
const TEMP = Number(flag('--temp', 0.2));
const TAG = flag('--tag', 'model');
const ORACLE = has('--oracle');
const CTX = Number(flag('--ctx', 32768));
const MAX_TOK = Number(flag('--max-tokens', 2048));
const WALL_MS = Number(flag('--wall-min', 20)) * 60000;
const THINK = process.env.THINK === '1';
const HINTS = has('--hints');   // tests-given only: also show the source files the failing tests import (the location a finding or a touch-up task would already name)
if (!ITEMS || !OUT) { console.error('usage: agent.mjs ITEMS.jsonl OUT.jsonl [flags]'); process.exit(2); }

const git = (...a) => spawnSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
const reset = (rev) => { git('checkout', '-q', '-f', '--detach', rev); git('clean', '-fdq', '-e', 'node_modules'); };

// ---- the hands ----------------------------------------------------------------------------------------------------
const DENY = /(^|\/)(\.git|node_modules)(\/|$)|^contracts\/|^tools\/yardstick\/|\.zkey$|\.env(\.|$)|(^|\/)(secrets?|keys?)\//i;
const isTestPath = (p) => /(^|\/)tests?\//.test(p) || /\.test\.m?js$/.test(p);
function safe(p, { write = false, hideTests = false } = {}) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.startsWith('/') || p.split('/').includes('..')) throw new Error('path must be relative to the repository root and stay inside it');
  const clean = p.replace(/^\.\//, '');
  if (DENY.test(clean)) throw new Error(`${clean} is not available`);
  if (write && MODE === 'tests-given' && isTestPath(clean)) throw new Error('the tests may not be edited in this task');
  if (hideTests && MODE === 'symptom' && ORACLE === false && false) throw new Error('hidden');
  return { rel: clean, abs: join(REPO, clean) };
}
// The in-repo source files a test imports, resolved from the test's own path: where the tests are about. Derived from the test only, never from the fix.
function importedSources(item, max = 2, perFile = 220, total = 14000) {
  const out = []; let used = 0;
  for (const t of item.testSources) {
    const dir = dirname(t.path);
    for (const m of t.text.matchAll(/(?:from|import\(|require\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const rel = join(dir, m[1]).split(sep).join('/');
      if (!/\.(m?js|cjs)$/.test(rel) || isTestPath(rel) || DENY.test(rel) || out.some((o) => o.rel === rel) || !existsSync(join(REPO, rel))) continue;
      const lines = readFileSync(join(REPO, rel), 'utf8').split('\n'), shown = lines.slice(0, perFile).map((l, i) => `${i + 1}\t${l.length > 300 ? l.slice(0, 300) + ' …' : l}`).join('\n');
      if (used + shown.length > total) continue;
      used += shown.length; out.push({ rel, n: lines.length, shown });
      if (out.length >= max) return out;
    }
  }
  return out;
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n... [${s.length - n} more characters cut]` : s);

const tools = {
  read_file({ path, start, end }) {
    const { abs, rel } = safe(path);
    if (!existsSync(abs) || statSync(abs).isDirectory()) throw new Error(`${rel} is not a file`);
    const lines = readFileSync(abs, 'utf8').split('\n');
    const a = Math.max(1, Number(start) || 1), b = Math.min(lines.length, Math.max(Number(end) || a + 199, a + 99), a + 249);   // at least 100 lines: asking for 20 at a time burns the turn budget
    return `${rel} (${lines.length} lines), lines ${a}-${b}:\n` + lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l.length > 400 ? l.slice(0, 400) + ' …' : l}`).join('\n');
  },
  list_dir({ path }) {
    const { abs, rel } = safe(path || '.');
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`${rel} is not a directory`);
    const names = readdirSync(abs, { withFileTypes: true }).filter((d) => !DENY.test(join(rel === '.' ? '' : rel, d.name))).map((d) => d.name + (d.isDirectory() ? '/' : ''));
    return clip(names.sort().join('\n') || '(empty)', 4000);
  },
  search({ pattern, path }) {
    if (typeof pattern !== 'string' || !pattern) throw new Error('pattern is required');
    const spec = path ? [safe(path).rel] : [];
    const r = git('grep', '-nI', '-E', '--max-count=8', '-e', pattern, '--', ...spec, ':(exclude)contracts', ':(exclude)*.zkey', ':(exclude)dapp/vendor', ':(exclude)dapp/circuits');
    const out = (r.stdout || '').split('\n').filter(Boolean).slice(0, 40).map((l) => (l.length > 220 ? l.slice(0, 220) + ' …' : l));
    return out.length ? out.join('\n') : 'no matches (the pattern is an extended regular expression)';
  },
  replace({ path, old, new: next }) {
    const { abs, rel } = safe(path, { write: true });
    if (!existsSync(abs)) throw new Error(`${rel} does not exist`);
    if (typeof old !== 'string' || typeof next !== 'string' || !old) throw new Error('old and new are required strings');
    const src = readFileSync(abs, 'utf8');
    const n = src.split(old).length - 1;
    if (n === 0) throw new Error('old was not found: it must match the file text exactly, including indentation');
    if (n > 1) throw new Error(`old appears ${n} times: include more surrounding text so it matches once`);
    writeFileSync(abs, src.replace(old, () => next));
    return `edited ${rel}`;
  },
  run_test({ file }) {
    const { abs, rel } = safe(file);
    if (!isTestPath(rel) || !existsSync(abs)) throw new Error('give the path of an existing test file under tests/');
    return runTestFile(rel).summary;
  },
  finish({ summary }) { return { done: true, summary: String(summary || '').slice(0, 300) }; },
};
function runTestFile(rel) {
  const t0 = Date.now();
  const r = spawnSync('node', ['--require', NOWEB, rel], { cwd: REPO, encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 16 << 20, env: { ...process.env, CI: '1', NODE_NO_WARNINGS: '1' } });
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n').slice(-40).join('\n');
  return { ok: r.status === 0 && !timedOut, ms: Date.now() - t0, summary: `${timedOut ? 'TIMED OUT' : r.status === 0 ? 'PASSED' : 'FAILED'} (${rel}, ${Math.round((Date.now() - t0) / 100) / 10} s)\n${clip(text, 2500)}` };
}

const TOOL_SPECS = [
  ['read_file', 'Read a text file with line numbers. Give start and end (1-based) for a range; at most 250 lines per call.', { path: 'string', start: 'integer', end: 'integer' }, ['path']],
  ['list_dir', 'List the entries of a directory (default: the repository root).', { path: 'string' }, []],
  ['search', 'Search the repository with an extended regular expression (git grep). Optionally restrict to a path.', { pattern: 'string', path: 'string' }, ['pattern']],
  ['replace', 'Edit a file: replace the text old with new. old must match the file exactly and appear once.', { path: 'string', old: 'string', new: 'string' }, ['path', 'old', 'new']],
  ['run_test', 'Run one test file (a plain Node script under tests/), offline. Reports PASSED or FAILED with the end of its output.', { file: 'string' }, ['file']],
  ['finish', 'Call this when the change is complete, with a one-line summary.', { summary: 'string' }, ['summary']],
].map(([name, description, props, required]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])), required } } }));

const SYSTEM = `You are a careful software engineer working in a JavaScript repository (Tacit: a privacy and bridging protocol, with a browser dapp under dapp/, a Cloudflare-style API under worker/, relays and keepers under worker-relay/, server/ and helpdesk/, and plain Node test scripts under tests/). Tool paths are relative to the repository root.
Work like this: find the code the request is about (search and read it), make the smallest change that does what is asked, check it with run_test when a relevant test exists, then call finish. Edit with replace; the old text must appear exactly once. Never touch contracts/, circuits, keys or secrets. Do not rewrite or reformat code you do not need to change. Call one tool at a time.`;

function taskText(item) {
  const head = `Request: ${item.request}\n`;
  if (MODE === 'symptom') return `${head}\nMake this change in the repository, then call finish.`;
  const tests = item.testSources.map((t) => `--- ${t.path}\n${clip(t.text, 7000)}`).join('\n\n');
  const hint = HINTS ? importedSources(item).map((f) => `--- ${f.rel} (${f.n} lines; first ${Math.min(f.n, 220)} shown, use read_file for the rest)\n${f.shown}`).join('\n\n') : '';
  return `${head}\nThese tests currently fail and must pass. Do not edit them.\n\n${tests}\n\nWhat they print on the current code:\n${clip(item.failOut || '', 1800)}\n\n${hint ? `\nThe tests import these source files, so the change is probably in one of them:\n\n${hint}\n` : ''}\nMake the change in the repository (not in the tests), then call finish.`;
}

// ---- the brain ----------------------------------------------------------------------------------------------------
async function chat(messages, seed) {
  const body = { model: 'yardstick', messages, tools: TOOL_SPECS, tool_choice: 'auto', temperature: TEMP, top_p: 0.95, max_tokens: MAX_TOK, seed, stream: false,
    chat_template_kwargs: { enable_thinking: THINK }, parallel_tool_calls: false };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15 * 60000);
  try {
    // a stale keep-alive socket under load makes Node's fetch throw 'fetch failed' before anything reached the server:
    // safe to repeat (nothing was generated), so retry a few times before calling it an error
    let res;
    for (let a = 0; ; a++) {
      try { res = await fetch(`${MODEL_URL}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal }); break; }
      catch (e) { if (a >= 3 || ctl.signal.aborted) throw e; await new Promise((r) => setTimeout(r, 1000 * (a + 1))); }
    }
    if (!res.ok) throw new Error(`model server ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

// Old tool results are what fills the window (file reads above all). Past ~60% full, everything but the last few is
// cut to one line saying what it was; the model can run the call again. Returns how many results were cut.
function compact(messages, keep = 4) {
  const tools = []; messages.forEach((m, i) => { if (m.role === 'tool') tools.push(i); });
  let n = 0;
  for (const i of tools.slice(0, Math.max(0, tools.length - keep))) {
    const m = messages[i];
    if (m.content.startsWith('[elided')) continue;
    messages[i] = { ...m, content: `[elided to save space: ${m.content.split('\n')[0].slice(0, 100)} ... run the call again if you need it]` };
    n++;
  }
  return n;
}

// ---- one attempt --------------------------------------------------------------------------------------------------
function grade(item) {
  // the model's work first (as a patch), then the commit's tests go on top and decide
  git('add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude)*/node_modules');
  const patch = git('diff', '--cached', '--no-color').stdout || '';
  const files = (git('diff', '--cached', '--name-only').stdout || '').split('\n').filter(Boolean);
  const lines = patch.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length;
  git('reset', '-q');
  for (const f of item.overlay) git('checkout', '-q', item.commit, '--', f);
  const runs = item.tests.map((t) => runTestFile(t));
  return { solved: runs.length > 0 && runs.every((r) => r.ok), patch, files, diffLines: lines, testTail: runs.find((r) => !r.ok)?.summary.slice(0, 600) || '' };
}

async function attempt(item, k) {
  reset(item.parent);
  if (MODE === 'tests-given' && !ORACLE) {
    // the failing tests go on disk first (the prompt shows them; the checkout is at the parent, whose old test files pass), and the result is committed as the base, so the model's patch is only what IT changed
    for (const f of (item.overlay?.length ? item.overlay : item.tests)) git('checkout', '-q', item.commit, '--', f);
    git('add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude)*/node_modules');
    git('-c', 'user.name=yardstick', '-c', 'user.email=y@localhost', 'commit', '-qm', 'base with the failing tests', '--allow-empty');
  }
  const t0 = Date.now();
  const rec = { id: item.id, tag: TAG, mode: MODE, attempt: k, oracle: ORACLE, turns: 0, finish: 'turns', malformed: 0, toolErrors: 0, repeats: 0, compactions: 0, calls: {}, promptTokens: 0, genTokens: 0, promptMs: 0, genMs: 0, maxPrompt: 0 };
  let messages = null, log = null;
  if (ORACLE) {
    for (const f of item.scope) git('checkout', '-q', item.commit, '--', f);   // the reference fix, not the tests
    rec.finish = 'oracle';
  } else {
    messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: taskText(item) }];
    log = [...messages];                                       // the full conversation, for the transcript; `messages` is what is sent and may be compacted
    const push = (m) => { messages.push(m); log.push(m); };
    let plain = 0, epoch = 0; const seen = new Set();   // epoch counts edits: after one, a read, search or test run can answer differently, so repeating it is not a repeat
    while (rec.turns < MAX_TURNS) {
      if (Date.now() - t0 > WALL_MS) { rec.finish = 'wall'; break; }
      let res; try { res = await chat(messages, 1000 * k + rec.turns + 1); } catch (e) { rec.finish = 'error'; rec.error = String(e.message).slice(0, 200); break; }
      rec.turns++;
      const u = res.usage || {}, tm = res.timings || {};
      rec.promptTokens += tm.prompt_n ?? 0; rec.genTokens += u.completion_tokens ?? tm.predicted_n ?? 0;
      rec.promptMs += tm.prompt_ms ?? 0; rec.genMs += tm.predicted_ms ?? 0; rec.maxPrompt = Math.max(rec.maxPrompt, u.prompt_tokens ?? 0);
      const msg = res.choices?.[0]?.message || {};
      push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
      if (!msg.tool_calls?.length) {
        rec.malformed++; plain++;
        if (plain >= 2) { rec.finish = 'no-tool-calls'; break; }
        push({ role: 'user', content: 'Use a tool call. When the change is complete, call finish.' });
        continue;
      }
      plain = 0; let finished = false;
      for (const call of msg.tool_calls.slice(0, 1)) {
        const name = call.function?.name; let out;
        try {
          const args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call.function?.arguments || {});
          if (!tools[name]) throw new Error(`unknown tool ${name}`);
          const key = name === 'replace' || name === 'finish' ? '' : `${name}:${epoch}:${JSON.stringify(args)}`;   // edits may repeat; reads, searches and test runs may not, until something has been edited
          if (key && seen.has(key)) { rec.repeats++; throw new Error('you already made this exact call and its result has not changed: try a different search or file, make the edit, or call finish'); }
          if (key) seen.add(key);
          const r = tools[name](args); rec.calls[name] = (rec.calls[name] || 0) + 1; if (name === 'replace') epoch++;
          if (r && r.done) { finished = true; rec.summary = r.summary; out = 'ok'; } else out = String(r);
        } catch (e) { rec.toolErrors++; out = `error: ${e.message}`; }
        const left = MAX_TURNS - rec.turns;
        if (left === 12 || left === 4) out += `\n[${left} steps left: if you know what to change, edit now; call finish when done]`;
        push({ role: 'tool', tool_call_id: call.id, content: clip(out, 4000) });
      }
      if (finished) { rec.finish = 'finish'; break; }
      if ((u.prompt_tokens ?? 0) > CTX * 0.6 && compact(messages)) rec.compactions++;   // one step, so the server's prompt cache is cut once, not every turn
      if ((u.prompt_tokens ?? 0) > CTX * 0.88) { rec.finish = 'context'; break; }
    }
  }
  const g = grade(item);
  Object.assign(rec, { solved: g.solved, files: g.files, diffLines: g.diffLines, wallMs: Date.now() - t0, testTail: g.solved ? '' : g.testTail });
  const dir = join(dirname(resolve(OUT)), `patches-${TAG}`); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${item.id}.${k}.patch`), g.patch);
  if (log) {                                        // the whole conversation, to read what the model did and why it stopped
    const td = join(dirname(resolve(OUT)), `transcripts-${TAG}`); mkdirSync(td, { recursive: true });
    writeFileSync(join(td, `${item.id}.${k}.json`), JSON.stringify(log, null, 1));
  }
  reset(item.parent);
  return rec;
}

// ---- main ---------------------------------------------------------------------------------------------------------
const SKIP = new Set(flag('--skip') && existsSync(flag('--skip')) ? readFileSync(flag('--skip'), 'utf8').split('\n').filter(Boolean) : []);   // ids the oracle could not solve
const items = readFileSync(ITEMS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((c) => c.modes.includes(MODE) && c.srcLines <= MAX_SRC && !SKIP.has(c.id)).slice(OFFSET, OFFSET + LIMIT);
const done = new Set(existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.id}:${r.attempt}`; }) : []);
console.log(`${items.length} items, mode ${MODE}, ${ORACLE ? 'ORACLE' : TAG}, ${ATTEMPTS} attempt(s) each`);
let n = 0, ok = 0;
for (const item of items) {
  item.testSources = item.tests.map((p) => ({ path: p, text: git('show', `${item.commit}:${p}`).stdout || '' }));
  item.overlay = item.overlay?.length ? item.overlay : item.tests;
  for (let k = 0; k < ATTEMPTS; k++) {
    if (done.has(`${item.id}:${k}`)) continue;
    const rec = await attempt(item, k); n++; if (rec.solved) ok++;
    appendFileSync(OUT, JSON.stringify(rec) + '\n');
    console.log(`${item.id} #${k} ${rec.solved ? 'SOLVED' : 'no'} | ${rec.finish} | ${rec.turns} turns | ${Math.round(rec.wallMs / 1000)} s | ${rec.diffLines} lines | ${n} done, ${ok} solved`);
  }
}
console.log(`done: ${ok}/${n} solved`);
