#!/usr/bin/env node
// A help desk node: asks the help desk for a question, has a local model answer it, sends the answer back. The same job the prover's help desk
// mode does (device-prover/src/helpdesk.rs), as a small standalone program for a machine that is not proving: a laptop, a server.
//
//   MINER=0x… node worker.mjs                       (HELPDESK_API, LLM_URL and MODEL_ID have defaults, see below)
//   MINER      an Ethereum address; the help desk credits the answers it takes to it
//   HELPDESK_API  the help desk (default https://tacit-helpdesk.onrender.com)
//   LLM_URL    an OpenAI-compatible chat server, e.g. llama.cpp's llama-server (default http://127.0.0.1:8095)
//   MODEL_ID   what this node says it runs; the help desk hands out jobs a model like this can do (default qwen3.5-4b-q4_k_m)
//   KINDS      the work this node takes: answer (a visitor's question), scan (a code review window), agent (one turn of a coding agent, for a node that holds a BIG model:
//              point LLM_URL at it and set MODEL_ID to its name; the help desk hands agent turns only to nodes it has measured as big and whose model is on its list), or a mix (default answer,scan). A slow machine
//              (a laptop) should take scan only: a visitor waits for an answer, and the help desk gives it to whichever node is free.
//
// Nothing a job contains is run: it is a list of chat messages, passed to the model as text, and the reply goes back as text.
// The help desk checks what comes back; a node that answers wrongly or repeatedly fails its checks is paused for an hour.

import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const MAX_JOB = 24_000;     // bytes of messages accepted
export const MAX_REPLY = 16_000;   // characters of answer sent back
export const MAX_AGENT_JOB = 400_000, MAX_AGENT_REPLY = 24_000;   // an agent turn carries a whole conversation and its tools, and the model's reply may hold a patch
const DEFAULT_MODEL = 'qwen3.5-4b-q4_k_m';

// What this machine has, for the help desk to size its jobs by: memory, GPU memory, cores, system and chip family, as numbers and two words (nothing that names
// the machine). The GPU's memory comes from nvidia-smi when there is one; Apple silicon shares its memory between CPU and GPU, which `unified` says.
export function hardware({ run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }), platform = os.platform(), arch = os.arch(), totalmem = os.totalmem(), cores = os.cpus().length } = {}) {
  const system = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform] || '', chip = { arm64: 'arm64', x64: 'x64' }[arch] || '';
  let vram = 0;
  try { vram = Math.round(String(run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'])).split('\n').map((l) => l.trim()).filter(Boolean).map(Number).filter(Number.isFinite).reduce((a, b) => a + b, 0) / 1024); } catch { /* no NVIDIA GPU, or no driver */ }
  return { ram: Math.round(totalmem / 2 ** 30), vram, cores, os: system, arch: chip, unified: system === 'darwin' && chip === 'arm64' };
}
let HW = null;   // asked once: it does not change while the node runs

// a job as the help desk sends it, cut down to what this node will run: null for one it will not
export function clampJob(job) {
  const id = job?.id;
  if (typeof id !== 'string' || !id || id.length > 64) return null;
  const messages = job.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 4) return null;
  if (JSON.stringify(messages).length > MAX_JOB) return null;
  if (!messages.every((m) => m && typeof m.role === 'string' && typeof m.content === 'string')) return null;
  const clamp = (x, lo, hi, d) => (Number.isFinite(Number(x)) && x !== null ? Math.min(hi, Math.max(lo, Number(x))) : d);
  return { id, messages, max_tokens: Math.floor(clamp(job.max_tokens, 16, 500, 300)), temperature: clamp(job.temperature, 0, 1, 0.2) };
}

// an agent turn as the help desk sends it, cut down to what this node will run: null for one it will not. Roles from a short list, text as text, tool calls and tools of
// the shape a chat server takes, sizes bounded. Nothing in it is run here: it goes to the local model as chat messages.
const NAME = /^[A-Za-z_]{1,40}$/;
export function clampAgentJob(job) {
  const id = job?.id;
  if (typeof id !== 'string' || !id || id.length > 64) return null;
  const messages = job.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 80) return null;
  for (const m of messages) {
    if (!m || !['system', 'user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string') return null;
    if (m.role === 'tool' && (typeof m.tool_call_id !== 'string' || m.tool_call_id.length > 64)) return null;
    if (m.tool_calls !== undefined && (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length > 4 || !m.tool_calls.every((c) => c && c.function && NAME.test(c.function.name || '') && typeof c.function.arguments === 'string'))) return null;
  }
  let tools;
  if (job.tools !== undefined && job.tools !== null) {
    if (!Array.isArray(job.tools) || job.tools.length > 12 || !job.tools.every((t) => t && t.function && NAME.test(t.function.name || ''))) return null;
    tools = job.tools;
  }
  if (JSON.stringify({ messages, tools }).length > MAX_AGENT_JOB) return null;
  const clamp = (x, lo, hi, d) => (Number.isFinite(Number(x)) && x !== null && x !== undefined ? Math.min(hi, Math.max(lo, Number(x))) : d);
  return { id, messages, tools, max_tokens: Math.floor(clamp(job.max_tokens, 16, 2048, 1024)), temperature: clamp(job.temperature, 0, 1, 0.2), seed: Number.isInteger(job.seed) ? job.seed : undefined };
}

// a signal that fires after ms, or when `signal` does (AbortSignal.any needs Node 20.3; this runs on 18)
const within = (ms, signal) => {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  c.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  if (signal?.aborted) c.abort(); else signal?.addEventListener('abort', () => c.abort(), { once: true });
  return c.signal;
};
const sleep = (ms, signal) => new Promise((r) => {
  if (signal?.aborted) return r();   // an abort that has already happened fires no event: do not wait for one
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});

// one round: lease a job, run it, submit. Resolves to 'worked', 'empty' (nothing waiting) or 'failed'.
export async function leaseOne({ api, llm, miner, model = DEFAULT_MODEL, kinds = ['answer', 'scan'], say = () => {}, signal, hw }) {   // hw: for tests; a real node reports what it measures
  const post = async (path, body, ms = 45000) => {
    try {
      const r = await fetch(`${api}/helpdesk/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: within(ms, signal) });
      let j = null; try { j = await r.json(); } catch { /* no body: a 204 */ }
      return { code: r.status, body: j };
    } catch { return null; }
  };
  HW ??= hardware();
  const got = await post('lease', { miner, model, kinds, hw: hw || HW });
  if (!got) return 'failed';
  if (got.code === 204) return 'empty';
  if (got.code === 429) { say(`help desk: ${got.body?.error || 'paused'}`); return 'failed'; }
  if (got.code !== 200 || typeof got.body?.lease !== 'string') return 'failed';
  const lease = got.body.lease;
  if (got.body.kind === 'agent') {
    // one turn of a coding agent: the whole conversation and its tools go to the local model, and its reply (words and/or tool calls) goes back as JSON. The model's reply is
    // data for the caller to read; the help desk never runs it, and neither does this node.
    const ajob = kinds.includes('agent') ? clampAgentJob(got.body) : null;
    if (!ajob) { if (typeof got.body.id === 'string') await post('submit', { id: got.body.id, lease, miner, error: 'a job this node will not run' }); return 'failed'; }
    const t0 = Date.now(); let msg;
    try {
      const r = await fetch(`${llm}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: within(Number(process.env.AGENT_TURN_MS || 540000), signal),
        body: JSON.stringify({ model: 'local', temperature: ajob.temperature, max_tokens: ajob.max_tokens, ...(ajob.seed !== undefined ? { seed: ajob.seed } : {}), chat_template_kwargs: { enable_thinking: false }, parallel_tool_calls: false,
          messages: ajob.messages, ...(ajob.tools ? { tools: ajob.tools, tool_choice: 'auto' } : {}) }) });
      if (!r.ok) { await post('submit', { id: ajob.id, lease, miner, error: `the model answered HTTP ${r.status}` }); say(`gave up ${ajob.id}: HTTP ${r.status}`); return 'failed'; }
      msg = (await r.json())?.choices?.[0]?.message;
    } catch { await post('submit', { id: ajob.id, lease, miner, error: 'the model did not answer' }); say(`gave up ${ajob.id}: no answer`); return 'failed'; }
    const reply = JSON.stringify({ content: String(msg?.content ?? ''), ...(Array.isArray(msg?.tool_calls) && msg.tool_calls.length ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg || (!String(msg.content ?? '').trim() && !msg.tool_calls?.length)) { await post('submit', { id: ajob.id, lease, miner, error: 'the model gave no answer' }); return 'failed'; }
    if (reply.length > MAX_AGENT_REPLY) { await post('submit', { id: ajob.id, lease, miner, error: 'the reply was too long' }); return 'failed'; }
    for (let i = 0; i < 3; i++) {
      const s2 = await post('submit', { id: ajob.id, lease, miner, text: reply, ms: Date.now() - t0 });
      if (s2?.code === 200) { say(`agent turn ${ajob.id} in ${((Date.now() - t0) / 1000).toFixed(1)} s`); return 'worked'; }
      if (s2 && s2.code !== 503) break;
      await sleep(5000, signal);
    }
    return 'failed';
  }
  const job = clampJob(got.body);
  if (!job) { if (typeof got.body.id === 'string') await post('submit', { id: got.body.id, lease, miner, error: 'a job this node will not run' }); return 'failed'; }
  const giveUp = async (why) => { await post('submit', { id: job.id, lease, miner, error: why }); say(`gave up ${job.id}: ${why}`); return 'failed'; };

  const t0 = Date.now();
  let text = '';
  try {
    const r = await fetch(`${llm}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: within(120000, signal),
      // thinking off: with it on, a small model can spend the whole budget on reasoning and send back nothing
      body: JSON.stringify({ model: 'local', temperature: job.temperature, max_tokens: job.max_tokens, chat_template_kwargs: { enable_thinking: false }, messages: job.messages }) });
    if (!r.ok) return giveUp(`the model answered HTTP ${r.status}`);
    text = String((await r.json())?.choices?.[0]?.message?.content ?? '').trim();
  } catch { return giveUp('the model did not answer'); }
  if (!text) return giveUp('the model gave no answer');
  text = [...text].slice(0, MAX_REPLY).join('');
  const body = { id: job.id, lease, miner, text, ms: Date.now() - t0 };
  for (let i = 0; i < 3; i++) {
    const s = await post('submit', body);
    if (s?.code === 200) { say(`answered ${job.id} in ${((Date.now() - t0) / 1000).toFixed(1)} s`); return 'worked'; }
    if (s && s.code !== 503) break;
    await sleep(5000, signal);
  }
  return 'failed';
}

// ask, answer, ask again: a short pause when nothing is waiting, a longer one (1, 2, 4, 8 and then 15 s) while the help desk or the model is not answering: a help desk
// that was restarted has its nodes back within seconds
export async function run({ api, llm, miner, model, kinds, say = () => {}, signal, idleMs = 1500, once = false, hw }) {
  let bad = 0;
  while (!signal?.aborted) {
    const out = await leaseOne({ api, llm, miner, model, kinds, say, signal, hw });
    if (once) return out;
    if (out === 'failed') bad++; else bad = 0;
    await sleep(out === 'worked' ? 0 : out === 'empty' ? idleMs : Math.min(15000, 1000 * 2 ** Math.min(bad, 4)), signal);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const api = (process.env.HELPDESK_API || 'https://tacit-helpdesk.onrender.com').replace(/\/$/, '');
  const llm = (process.env.LLM_URL || 'http://127.0.0.1:8095').replace(/\/$/, '');
  const miner = process.env.MINER || '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(miner)) { console.error('Set MINER to an Ethereum address (0x… and 40 hex digits): the help desk credits your answers to it.'); process.exit(2); }
  const ac = new AbortController();
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => ac.abort());
  const say = (t) => console.error(`${new Date().toISOString().slice(11, 19)} ${t}`);
  say(`help desk node for ${miner}: ${api}, model at ${llm}`);
  const kinds = (process.env.KINDS || 'answer,scan').split(',').map((k) => k.trim()).filter((k) => k === 'answer' || k === 'scan' || k === 'agent');
  if (!kinds.length) { console.error('KINDS must name answer, scan and/or agent.'); process.exit(2); }
  say(`taking: ${kinds.join(' and ')}`);
  await run({ api, llm, miner, model: process.env.MODEL_ID || undefined, kinds, say, signal: ac.signal });
}
