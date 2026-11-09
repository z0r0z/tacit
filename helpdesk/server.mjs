#!/usr/bin/env node
// Tacit help desk PoC: BM25 retrieval over public docs -> small local model (llama-server) -> answer + sources.
//   node server.mjs serve            http://127.0.0.1:8787  (page + POST /ask)   -- loopback only, reach it with an ssh tunnel
//   node server.mjs eval OUT.json    run the 31-question regression set through this exact pipeline
// The voice lives in persona.txt (re-read on every request), so tone edits need no restart.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildIndex } from './retrieval.mjs';
import { looksLikeSecret } from './guard.mjs';
import { makeBackend, BusyError } from './backend.mjs';
import { makeLeases, makeVet, isAddr, creditsFor } from './lease.mjs';
import { makeScanFeed } from './scanfeed.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR: where this process keeps what must outlive a restart (the points ledger, the review inbox, the scan cursor, lease state, embeddings). On a host with a
// persistent disk, point it there.
const DATA = process.env.DATA_DIR || HERE; mkdirSync(DATA, { recursive: true });
// LLM_URLS: comma-separated OpenAI-compatible backends, tried in order with timeout, retry and a circuit breaker. Typical:
//   LLM_URLS=http://127.0.0.1:8089,http://127.0.0.1:8090   (OpenAI-compatible servers, tried in order)
//   LLM_URLS=                                                (empty: no steady backend, community nodes only; a visitor gets the "nodes offline" reply when none is up)
const llm = makeBackend({ urls: (process.env.LLM_URLS ?? process.env.LLM ?? 'http://127.0.0.1:8089').split(',').map((u) => u.trim()).filter(Boolean),
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 10000), maxAttempts: Number(process.env.LLM_ATTEMPTS || 3), maxInflight: Number(process.env.MAX_INFLIGHT || 8) });
const DOWN_REPLY = "The help desk's model nodes are busy or offline right now. Please try again in a minute, or see tacit.finance.";
const K = Number(process.env.K || 6);
const corpus = JSON.parse(readFileSync(path.join(HERE, process.env.CORPUS || 'corpus.json'), 'utf8'));
// Reviewed FAQ answers are retrieved like any chunk but ranked higher (FAQ_BOOST). FAQ=off skips them (for A/B runs).
const FAQ_BOOST = Number(process.env.FAQ_BOOST || 2.5);
const FAQ_MAX = Number(process.env.FAQ_MAX || 99);
if (process.env.FAQ !== 'off') {
  for (const e of JSON.parse(readFileSync(path.join(HERE, 'faq.json'), 'utf8'))) corpus.chunks.push({ title: `FAQ > ${e.q}`, faq: true, text: `[FAQ > ${e.q}]\nQ: ${e.q}\nA: ${e.a}\n(Source: ${[].concat(e.src).join(', ')})` });
}
const { search, assess } = buildIndex(corpus.chunks);
const COVERAGE_MIN = Number(process.env.COVERAGE_MIN || 0.30);   // below this the question is not about anything in the docs
const GATE_REPLY = "I don't have that in the Tacit docs. I can help with Tacit: TAC, the pool, farms, bridges, proving and recovery. For anything else, see tacit.finance.";
const persona = () => readFileSync(path.join(HERE, 'persona.txt'), 'utf8').trim();

// ---- dense retrieval: a 37 MB embedding model (bge-small) served by a second llama-server; merged with BM25 by reciprocal rank fusion
const EMB = process.env.EMB || 'http://127.0.0.1:8090';
const QPREFIX = 'Represent this sentence for searching relevant passages: ';
const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Float32Array.from(v, (x) => x / n); };
async function embed(texts) {
  const r = await fetch(`${EMB}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'emb', input: texts }), signal: AbortSignal.timeout(120000) });
  const j = await r.json(); if (!j.data) throw new Error('embedding server: ' + JSON.stringify(j).slice(0, 120));
  return j.data.sort((a, b) => a.index - b.index).map((d) => unit(d.embedding));
}
let chunkVecs = null;
// Chunk vectors are kept on the data disk one chunk at a time, by the hash of its text, so a restart after the docs changed embeds only the chunks that did.
// Until every chunk has a vector retrieval is lexical only; the service does not wait for them.
let denseState = process.env.EMB === 'off' ? 'off' : 'loading';
async function initDense() {
  if (process.env.EMB === 'off') { chunkVecs = null; return; }   // lexical retrieval only
  const file = path.join(DATA, 'emb-cache.json');
  let have = {}; try { have = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const key = (t) => createHash('sha1').update(t).digest('hex').slice(0, 16);
  const keys = corpus.chunks.map((c) => key(c.text)); const save = (m) => { try { writeFileSync(file + '.tmp', JSON.stringify(m)); renameSync(file + '.tmp', file); } catch { /* the disk is optional */ } };
  let fresh = 0;
  for (const [i, c] of corpus.chunks.entries()) {
    if (have[keys[i]]) continue;
    // bge-small reads at most 512 tokens; table and hex heavy chunks run long, so shrink one chunk at a time until it fits
    let n = 1000, v; for (;;) { try { [v] = await embed([c.text.slice(0, n)]); break; } catch (e) { if (n <= 250) throw e; n = Math.floor(n * 0.7); } }
    have[keys[i]] = [...v].map((x) => +x.toFixed(5)); if (++fresh % 25 === 0) save(have);
  }
  const keep = Object.fromEntries(keys.map((k) => [k, have[k]]));   // chunks that are gone from the docs are dropped from the cache
  if (fresh || Object.keys(have).length !== keys.length) save(keep);
  chunkVecs = keys.map((k) => Float32Array.from(keep[k])); denseState = 'ready';
  console.error(`embeddings ready: ${fresh} new, ${keys.length - fresh} cached`);
}
// the embedding server may still be starting, or restart: try again until the vectors are in
function startDense() { initDense().catch((e) => { denseState = 'loading'; console.error(`embeddings: ${String(e.message || e).slice(0, 100)}; trying again in 60 s`); setTimeout(startDense, 60000).unref?.(); }); }
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
async function retrieve(question, k = K) {
  const bm = search(question, 30);                                   // lexical
  let dn = [];
  if (chunkVecs) { try { const [qv] = await embed([QPREFIX + question]); dn = chunkVecs.map((v, i) => [dot(qv, v), i]).sort((a, b) => b[0] - a[0]).slice(0, 30); } catch { /* the embedding server is down: this question is answered from lexical retrieval */ } }
  const score = new Map(); const add = (i, rank) => score.set(i, (score.get(i) || 0) + (corpus.chunks[i].faq ? FAQ_BOOST : 1) / (60 + rank));
  bm.forEach((h, r) => add(h.i, r)); dn.forEach(([, i], r) => add(i, r));
  // FAQ_MAX caps how many FAQ chunks may fill the context, so raw doc passages keep their place when the FAQ is large
  const top = []; let nFaq = 0;
  for (const [i] of [...score.entries()].sort((a, b) => b[1] - a[1])) { if (corpus.chunks[i].faq) { if (nFaq >= FAQ_MAX) continue; nFaq++; } top.push(i); if (top.length >= k) break; }
  return { chunks: top.map((i) => corpus.chunks[i]), bm, denseMax: dn[0]?.[0] ?? 0 };
}

// ---- input safety (deterministic, never left to the model)
const SEED_REPLY = "That looks like a seed phrase or private key. Don't share it with anyone, including this help desk. Treat it as exposed if you've typed it anywhere you don't fully trust, and move your funds to a fresh wallet. I haven't stored it.";
const redact = (s) => s.replace(/0x[0-9a-fA-F]{40,}/g, '[address]');

const DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|xyz|app|finance|fi|co|dev|eth|wei|link|site|online|info|me|cc|ai))\b/gi;
const CORPUS_TEXT = corpus.chunks.map((c) => c.text).join('\n').toLowerCase();
// a name the docs themselves use (anon.wei, a docs host) is not an unknown domain
const otherDomains = (q) => [...new Set((q.match(DOMAIN_RE) || []).map((d) => d.toLowerCase()).filter((d) => d !== 'tacit.finance' && !d.endsWith('.tacit.finance') && !CORPUS_TEXT.includes(d)))];

// ---- the prompt (one builder for real questions and canaries, so a node cannot tell them apart)
function promptFor(question, ctx) {
  const doms = otherDomains(question);
  const note = doms.length ? `\n\nNOTE: the question mentions ${doms.join(', ')}. The only official site is tacit.finance. Say you can't confirm ${doms[0]} and that they shouldn't connect a wallet there.` : '';
  const user = `DOC EXCERPTS:\n${ctx.map((c) => c.text).join('\n\n---\n\n')}\n\nQUESTION: ${question}${note}`;
  return [{ role: 'system', content: persona() }, { role: 'user', content: user }];
}

// ---- the community nodes (tacit-prover's helpdesk.rs): they pull questions, and code-check windows when idle
const LEASE_ON = process.env.HELPDESK_LEASE !== '0';
const CANARIES = [
  { q: 'How many TAC will ever exist?', check: (t) => /21,?000,?000/.test(t) },
  { q: 'Who is allowed to run a relay?', check: (t) => /anyone|any account/i.test(t) },
  { q: 'Is there a bug bounty and how do I report something?', check: (t) => /250,?000/.test(t) && /security@tacit\.finance/i.test(t) },
  { q: 'Which networks does private ETH work on?', check: (t) => /Base/i.test(t) && /Robinhood/i.test(t) },
  { q: 'Can the airdrop contract be upgraded?', check: (t) => /no (owner|upgrade|proxy)|cannot|can.?t|not|immutable|fixed/i.test(t) },
];
let canaryI = 0;
const leases = makeLeases({
  ledger: path.join(DATA, 'ledger.jsonl'), persist: path.join(DATA, 'leases-state.json'),
  points: { answer: Number(process.env.POINTS_ANSWER ?? 1), canary: Number(process.env.POINTS_CANARY ?? 1), scan: Number(process.env.POINTS_SCAN ?? 1) }, clientMaxPerDay: Number(process.env.POINTS_MAX_DAY ?? 100), vet: makeVet(corpus.chunks.map((c) => c.text).join('\n')),
  canaryEvery: Number(process.env.CANARY_EVERY || 6), waitMs: Number(process.env.LEASE_HOLD_MS || 20000),
  scan: process.env.SCAN_REPO ? makeScanFeed({ repo: process.env.SCAN_REPO, ref: process.env.SCAN_REF || 'origin/main', inbox: path.join(DATA, 'suggestions.jsonl'), cursorFile: path.join(DATA, 'scan-cursor.json') }) : null,
  canary: async () => { const c = CANARIES[canaryI++ % CANARIES.length]; const { chunks } = await retrieve(c.q); return { messages: promptFor(c.q, chunks), check: c.check, ctxText: chunks.map((x) => x.text).join('\n') }; },
});

// ---- ask
export async function ask(qRaw, { ip = null } = {}) {
  const q = String(qRaw || '').trim().slice(0, 500);
  if (!q) return { answer: 'Ask me something about Tacit.', sources: [], ms: 0 };
  if (looksLikeSecret(q)) return { answer: SEED_REPLY, sources: [], ms: 0, guarded: true };
  const question = redact(q);
  const { chunks: ctx, bm, denseMax } = await retrieve(question);
  const { coverage } = assess(question, bm.slice(0, K));
  const gate = process.env.GATE === 'off' ? false : coverage < COVERAGE_MIN;
  if (gate) return { answer: GATE_REPLY, sources: [], ms: 0, gated: true, coverage, denseMax };
  const t0 = Date.now();
  const messages = promptFor(question, ctx);
  let answer, backend;
  // community nodes first (their answers are vetted and the node is known); then the steady backends; then the "nodes offline" reply
  if (LEASE_ON && leases.nodesOnline() > 0) {
    try { const r = await leases.enqueue('answer', messages, { max_tokens: 300, temperature: Number(process.env.TEMP ?? 0.2), timeoutMs: Number(process.env.LEASE_WAIT_MS || 12000), askerIp: ip, ctxText: ctx.map((c) => c.text).join('\n') }); answer = r.text; backend = 'node:' + r.miner.slice(0, 10); } catch { /* no node answered in time: fall through */ }
  }
  if (!answer) try { ({ text: answer, backend } = await llm.chat(messages, { temperature: Number(process.env.TEMP ?? 0.2), max_tokens: 300 })); }
  catch (e) { return { answer: DOWN_REPLY, sources: [], ms: Date.now() - t0, unavailable: true, busy: e instanceof BusyError, coverage, denseMax }; }
  return { answer, backend, coverage, denseMax, sources: [...new Set(ctx.map((c) => c.title.split(' > ').slice(0, 2).join(' > ')))], ms: Date.now() - t0 };
}

// ---- http (loopback, 20 requests / minute / client, no storage of questions)
const hits = new Map();
const ok = (ip) => { const now = Date.now(); const a = (hits.get(ip) || []).filter((t) => now - t < 60000); a.push(now); hits.set(ip, a); return a.length <= Number(process.env.RATE_PER_MIN || 20); };
const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Tacit help desk (PoC)</title>
<style>body{font:16px/1.5 system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fafafa}textarea{width:100%;box-sizing:border-box;font:inherit;padding:.6rem}button{font:inherit;padding:.5rem 1rem;margin-top:.5rem}#a{white-space:pre-wrap;background:#fff;border:1px solid #ddd;border-radius:6px;padding:1rem;margin-top:1rem;min-height:3rem}small{color:#666}</style>
<h1>Tacit help desk <small>PoC</small></h1><p><small>Answers come from the public docs, written by a small open model. Don't paste keys or seed phrases.</small></p>
<textarea id=q rows=3 maxlength=500 placeholder="Ask about TAC, the pool, farms, recovery…"></textarea><button id=go>Ask</button><div id=a></div><small id=m></small>
<script>const $=i=>document.getElementById(i);async function go(){const q=$('q').value.trim();if(!q)return;$('go').disabled=true;$('a').textContent='…';
try{const r=await fetch('/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({q})});const j=await r.json();$('a').textContent=j.answer||j.error;$('m').textContent=j.sources?('Sources: '+j.sources.join(' · ')+'  ('+j.ms+' ms)'):''}catch(e){$('a').textContent='Error: '+e.message}$('go').disabled=false}
$('go').onclick=go;$('q').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();go()}}</script>`;

// ---- the nodes' API. A lease request is held open for up to LEASE_HOLD_MS (so an idle node is not a busy loop); each client may hold two.
const leaseHits = new Map(), holding = new Map();
// Behind a proxy (TRUST_PROXY=1) the client is, in order: the True-Client-IP header (on Render, its Cloudflare sets it to the address it accepted the
// connection from), else the entry TRUST_PROXY_HOPS from the RIGHT of X-Forwarded-For (each proxy adds one; everything to the left is whatever the client
// chose to send; on Render the client is the second from the right, before the edge's own entry; count too few rather than too many: a miss lands on a shared edge address, a hit too far left on one the caller chose). Check it on the deployed service with GET /whoami (it only tells a caller their own address, as seen here).
// An IPv6 client is counted by its /64, the block one subscriber is given, so a ban or a cap cannot be dodged by changing the address within it.
const HOPS = Number(process.env.TRUST_PROXY_HOPS || 1);
const IPCHARS = /^[0-9a-f:.]+$/i;
function ipKey(addr) {
  const a = String(addr).trim().toLowerCase();
  if (!a.includes(':') || /^(::ffff:)?\d+\.\d+\.\d+\.\d+$/.test(a)) return a;
  const [h, t = ''] = a.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const full = a.includes('::') ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
const clientIp = (req) => {
  if (process.env.TRUST_PROXY === '1') {
    const tc = String(req.headers['true-client-ip'] || '').trim();
    if (tc && tc.length <= 45 && IPCHARS.test(tc)) return ipKey(tc);
    const xs = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (xs.length >= HOPS && IPCHARS.test(xs[xs.length - HOPS])) return ipKey(xs[xs.length - HOPS]);
  }
  return ipKey(req.socket.remoteAddress || '?');
};
// CORS: the page on tacit.finance calls this service from the browser. ALLOW_ORIGINS is a comma list (or *).
const ORIGINS = (process.env.ALLOW_ORIGINS ?? 'https://tacit.finance,https://www.tacit.finance').split(',').map((o) => o.trim()).filter(Boolean);
function cors(req, res) {
  const o = req.headers.origin; if (o && (ORIGINS.includes('*') || ORIGINS.includes(o))) { res.setHeader('access-control-allow-origin', o); res.setHeader('vary', 'origin'); }
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS'); res.setHeader('access-control-allow-headers', 'content-type'); res.setHeader('access-control-max-age', '600');
}
const utcDay = () => Math.floor(Date.now() / 86400000);
const readJson = (req, max = 65536) => new Promise((resolve, reject) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > max) { req.destroy(); reject(new Error('too large')); } }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } }); req.on('error', reject); });
const send = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(o === undefined ? '' : JSON.stringify(o)); };
async function nodeApi(req, res) {
  const ip = clientIp(req);
  if (!LEASE_ON) return send(res, 404, { error: 'not found' });
  if (req.method === 'GET' && req.url === '/helpdesk/stats') { const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress); return local ? send(res, 200, leases.stats()) : send(res, 403, { error: 'local only' }); }
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
  const now = Date.now(); const a = (leaseHits.get(ip) || []).filter((t) => now - t < 60000); a.push(now); leaseHits.set(ip, a);
  if (a.length > Number(process.env.NODE_RATE_PER_MIN || 120)) return send(res, 429, { error: 'slow down' });
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad request' }); }
  if (req.url === '/helpdesk/lease') {
    if ((holding.get(ip) || 0) >= 2) return send(res, 429, { error: 'this client already has requests waiting' });
    holding.set(ip, (holding.get(ip) || 0) + 1);
    // when the node's connection closes before it was answered, it leaves the line (lease.mjs): a job is never handed to a node that is gone
    const gone = new AbortController(); res.on('close', () => { if (!res.writableFinished) gone.abort(); });
    try { const out = await leases.lease({ miner: body.miner, ip, kinds: Array.isArray(body.kinds) ? body.kinds : ['answer'], closed: gone.signal });
      if (out === null) return send(res, 204); if (out.banned) return send(res, 429, { error: 'paused: this client failed too many checks, try again in an hour' }); if (out.error) return send(res, 400, out); return send(res, 200, out); }
    finally { holding.set(ip, Math.max(0, (holding.get(ip) || 1) - 1)); }
  }
  if (req.url === '/helpdesk/submit') { const out = await leases.submit({ id: body.id, lease: body.lease, miner: body.miner, ip, text: body.text, error: body.error }); return out.error ? send(res, 400, out) : send(res, 200, out); }
  return send(res, 404, { error: 'not found' });
}

if (process.argv[2] === 'serve') startDense(); else await initDense();   // a running service answers at once, on keyword search until the vectors are in
if (process.argv[2] === 'serve') {
  http.createServer(async (req, res) => {
    const ip = clientIp(req); const pathname = req.url.split('?')[0];
    if (req.method === 'OPTIONS' && (pathname === '/ask' || pathname === '/health' || pathname === '/helpdesk/credits')) { cors(req, res); res.writeHead(204); return res.end(); }
    if (pathname === '/ask' || pathname === '/health') cors(req, res);
    if (pathname === '/whoami') return send(res, 200, { ip, trueClientIp: req.headers['true-client-ip'] || null, xff: req.headers['x-forwarded-for'] || null, socket: req.socket.remoteAddress, hops: HOPS, trustProxy: process.env.TRUST_PROXY === '1' });
    if (req.method === 'GET' && pathname === '/helpdesk/credits') { cors(req, res); const q = new URL(req.url, 'http://x').searchParams.get('day'); const day = /^\d{1,6}$/.test(q || '') ? Number(q) : NaN;
      if (!(day <= utcDay())) return send(res, 400, { ok: false, error: 'day must be a UTC day number, today or before' });
      return send(res, 200, creditsFor(path.join(DATA, 'ledger.jsonl'), day, { maxPerDay: Number(process.env.POINTS_MAX_DAY ?? 100) })); }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' }); return res.end(PAGE); }
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/stats')) { const st = llm.stats(); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(req.url === '/health' ? { ok: st.backends.some((b) => b.up) || leases.nodesOnline() > 0, nodes: leases.nodesOnline(), dense: denseState, backends: st.backends.map((b) => ({ url: b.url, up: b.up })) } : { ...st, nodes: leases.stats() })); }
    if (req.url.startsWith('/helpdesk/')) return nodeApi(req, res);
    if (req.method === 'POST' && req.url === '/ask') {
      if (!ok(ip)) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":"Too many questions, try again in a minute."}'); }
      let body = ''; req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', async () => { try { const out = await ask(JSON.parse(body).q, { ip }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
        catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Something went wrong.' })); } });
      return;
    }
    res.writeHead(404); res.end();
  }).listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => console.log(`help desk PoC on http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8787}`));
} else if (process.argv[2] === 'eval') {
  const qp = path.resolve(process.argv[4] || path.join(HERE, 'questions.mjs')); const QUESTIONS = qp.endsWith('.json') ? JSON.parse(readFileSync(qp, 'utf8')) : ((m) => m.QUESTIONS || m.HELD)(await import(qp));
  const out = {};
  for (const x of QUESTIONS) { const r = await ask(x.q); out[x.id] = { answer: r.answer, unavailable: !!r.unavailable, ms: r.ms, guarded: !!r.guarded, gated: !!r.gated, coverage: r.coverage, denseMax: r.denseMax }; console.log(x.id.padEnd(18), `${r.ms} ms${r.guarded ? ' (guarded)' : ''}${r.gated ? ' (gated)' : ''}`); }
  writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
}
