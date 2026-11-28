// node node/agent-e2e.test.mjs -- an agent turn end to end: a caller POSTs a chat turn to the REAL gateway's /agent/chat, the REAL worker (a big node on an allowed model) takes it,
// a scripted stand-in for the model replies with a tool call, and the caller gets it back as an OpenAI-style message. Also: who is refused, what is refused, and that the
// endpoint is off without its secret.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run, clampAgentJob, MAX_AGENT_JOB } from './worker.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname), ROOT = path.dirname(HERE);
let fails = 0; const check = (n, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = 'agent-test-secret-' + 'x'.repeat(24), MODEL = 'qwen3.6-35b-a3b-q4', MINER = '0x' + 'cd'.repeat(20);
const BIG = { ram: 96, vram: 6, cores: 16, os: 'windows', arch: 'x64', unified: false };
const tools = [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];

// ── clampAgentJob ──
{ const ok = { id: 'a', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'r' }], tools };
  const c = clampAgentJob(ok);
  check('an agent turn with tool calls and results is accepted, with default budgets', c && c.max_tokens === 1024 && c.temperature === 0.2 && c.tools.length === 1 && c.messages.length === 4);
  check('budgets are bounded', clampAgentJob({ ...ok, max_tokens: 99999, temperature: 9 }).max_tokens === 2048 && clampAgentJob({ ...ok, max_tokens: 1, temperature: -3 }).temperature === 0);
  const bad = [null, {}, { ...ok, id: '' }, { ...ok, id: 'x'.repeat(65) }, { ...ok, messages: [] }, { ...ok, messages: Array(81).fill({ role: 'user', content: 'x' }) }, { ...ok, messages: [{ role: 'root', content: 'x' }] },
    { ...ok, messages: [{ role: 'user', content: 5 }] }, { ...ok, messages: [{ role: 'tool', content: 'x' }] }, { ...ok, messages: [{ role: 'user', content: 'x', tool_calls: [] }] },
    { ...ok, messages: [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'rm -rf', arguments: '{}' } }] }] }, { ...ok, tools: 'x' }, { ...ok, tools: Array(13).fill(tools[0]) },
    { ...ok, tools: [{ function: { name: '../x' } }] }, { ...ok, messages: [{ role: 'user', content: 'x'.repeat(MAX_AGENT_JOB) }] }];
  check('turns this node will not run are refused: bad id, no or too many messages, a role it does not know, text that is not text, tool results without an id, tool calls from the wrong role or with odd names, bad tools, too big', bad.every((j) => clampAgentJob(j) === null)); }

// ── the model (scripted: a tool call first, then words) ──
const seen = []; let n = 0;
const model = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
  const body = JSON.parse(b || '{}'); seen.push(body); n++;
  const message = n === 1 ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"dapp/x.js"}' } }] } : { role: 'assistant', content: 'The file reads fine.' };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }] })); }); }).listen(0, '127.0.0.1');
await new Promise((r) => model.on('listening', r));
const LLM = `http://127.0.0.1:${model.address().port}`;

// ── two real gateways: one with the agent endpoint, one without ──
const gateway = async (port, extra) => { const data = mkdtempSync(path.join(tmpdir(), 'ag-'));
  const gw = spawn(process.execPath, ['server.mjs', 'serve'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, EMB: 'off', LLM_URLS: '', DATA_DIR: data, PORT: String(port), TRUST_PROXY: '1', RATE_PER_MIN: '1000', SCAN_REPO: '', ...extra } });
  let log = ''; gw.stderr.on('data', (d) => (log += d)); gw.stdout.on('data', (d) => (log += d));
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await sleep(250); }
  return { gw, data, api: `http://127.0.0.1:${port}`, log: () => log }; };
const on = await gateway(8796, { AGENT_SECRET: SECRET, AGENT_MODELS: 'qwen3.6-35b-a3b,qwen3-coder-next', AGENT_WAIT_MS: '20000' });
const off = await gateway(8797, {});
const ac = new AbortController(); let loop;
const chat = (body, headers = {}) => fetch(`${on.api}/agent/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const authed = { authorization: `Bearer ${SECRET}` };
const turn = { messages: [{ role: 'system', content: 'You fix code.' }, { role: 'user', content: 'Check dapp/x.js' }], tools, max_tokens: 512, temperature: 0.1 };
try {
  check('without its secret the endpoint is off (404), not a login page', (await fetch(`${off.api}/agent/chat`, { method: 'POST', body: '{}' })).status === 404);
  check('no token is refused', (await chat(turn)).status === 401);
  check('a wrong token is refused', (await chat(turn, { authorization: 'Bearer nope' })).status === 401);
  check('a token of the wrong length is refused without error', (await chat(turn, { authorization: `Bearer ${SECRET}x` })).status === 401);
  check('a malformed turn is refused (400)', (await chat({ messages: [{ role: 'root', content: 'x' }] }, authed)).status === 400 && (await chat({}, authed)).status === 400 && (await chat({ ...turn, tools: [{ function: { name: '../x' } }] }, authed)).status === 400);
  const st0 = await (await fetch(`${on.api}/agent/status`, { headers: authed })).json();
  check('status says no node can take a turn yet', st0.ok === true && st0.nodes === 0 && st0.models.length === 2, JSON.stringify(st0));

  // a small node cannot take it; a big one on an allowed model can
  const lines = [];
  const small = run({ api: on.api, llm: LLM, miner: '0x' + '11'.repeat(20), model: MODEL, kinds: ['agent'], say: () => {}, signal: ac.signal, idleMs: 100, hw: { ram: 8, vram: 0, cores: 4, os: 'darwin', arch: 'arm64', unified: true } });
  await sleep(600);
  const pendingNoNode = chat(turn, authed);   // nobody eligible yet: it waits
  await sleep(500);
  check('a small node is not handed the turn: the model was not called', seen.length === 0);
  loop = run({ api: on.api, llm: LLM, miner: MINER, model: MODEL, kinds: ['agent'], say: (t) => lines.push(t), signal: ac.signal, idleMs: 100, hw: BIG });
  const r1 = await pendingNoNode; const j1 = await r1.json();
  check('a big node on an allowed model takes the waiting turn, and the caller gets an OpenAI-style message with the tool call',
    r1.status === 200 && j1.object === 'chat.completion' && j1.choices[0].finish_reason === 'tool_calls' && j1.choices[0].message.tool_calls[0].function.name === 'read_file' && j1.choices[0].message.tool_calls[0].function.arguments === '{"path":"dapp/x.js"}', JSON.stringify(j1).slice(0, 220));
  check('the reply says which model and size of node answered, and who', j1.swarm?.tier === 'big' && j1.swarm?.model === MODEL && j1.swarm?.miner === MINER && j1.usage.prompt_tokens > 0);
  const call = seen[0];
  check('the model was asked with the conversation, the tools, thinking off, one tool call at a time, and the budget', call.messages.length === 2 && call.tools?.[0]?.function?.name === 'read_file' && call.tool_choice === 'auto' && call.chat_template_kwargs?.enable_thinking === false && call.parallel_tool_calls === false && call.max_tokens === 512 && call.temperature === 0.1);

  // the next turn carries the tool result; the model answers in words
  const turn2 = { ...turn, messages: [...turn.messages, j1.choices[0].message, { role: 'tool', tool_call_id: 'call_a', content: 'file text' }] };
  const r2 = await chat(turn2, authed); const j2 = await r2.json();
  check('a follow-up turn (with the tool result) is answered in words', r2.status === 200 && j2.choices[0].finish_reason === 'stop' && j2.choices[0].message.content === 'The file reads fine.' && !j2.choices[0].message.tool_calls);
  check('the model saw the assistant tool call and the tool result', seen[1].messages.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call_a') && seen[1].messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_a'));
  const st1 = await (await fetch(`${on.api}/agent/status`, { headers: authed })).json();
  check('status now counts the big node', st1.nodes === 1, JSON.stringify(st1));
  const hs = await (await fetch(`${on.api}/helpdesk/stats`)).json();
  check('an agent turn earned the node no points (nothing to farm)', hs.miners.every((m) => m.points === 0), JSON.stringify(hs.miners.map((m) => m.points)));

  ac.abort(); await Promise.all([loop, small]);
} finally {
  ac.abort(); for (const g of [on, off]) { g.gw.kill('SIGTERM'); } model.close(); await sleep(150); for (const g of [on, off]) rmSync(g.data, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'agent e2e: all tests passed'); if (fails) console.log(on.log().slice(-600));
process.exit(fails ? 1 : 0);
