// node embed.test.mjs -- the gateway starts answering at once and loads its document vectors in the background; the vectors are kept on the data disk one
// chunk at a time, so a restart embeds nothing and a few missing entries are the only ones embedded again. The embedding server is a stand-in.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname), PORT = 8796, B = `http://127.0.0.1:${PORT}`, data = mkdtempSync(path.join(tmpdir(), 'emb-'));
// the gateway indexes the document chunks and, as chunks of their own, the reviewed FAQ answers
const corpus = JSON.parse(readFileSync(path.join(ROOT, 'corpus.json'), 'utf8')), faq = JSON.parse(readFileSync(path.join(ROOT, 'faq.json'), 'utf8')), N = corpus.chunks.length + (Array.isArray(faq) ? faq.length : Object.keys(faq).length);
let fails = 0; const check = (n, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0, delay = 4;
const emb = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
    calls++; await sleep(delay);
    const input = JSON.parse(b).input;
    const vec = (t) => { const h = createHash('sha256').update(t).digest(); return Array.from({ length: 8 }, (_, i) => h[i] / 255 + 0.01); };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vec(t) })) }));
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => emb.on('listening', r));

const EMB_URL = `http://127.0.0.1:${emb.address().port}`;   // taken now: the server is closed near the end
function start() {
  const gw = spawn(process.execPath, ['server.mjs', 'serve'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, EMB: EMB_URL, LLM_URLS: '', DATA_DIR: data, PORT: String(PORT), SCAN_REPO: '' } });
  let log = ''; gw.stderr.on('data', (d) => (log += d)); gw.stdout.on('data', (d) => (log += d));
  return { gw, log: () => log };
}
const health = async () => { try { return await (await fetch(`${B}/health`)).json(); } catch { return null; } };
const until = async (f, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await f(); if (v) return v; await sleep(100); } return null; };

let run = start();
try {
  const first = await until(health, 15000);
  check('the service answers /health at once, before its vectors are in', first && first.dense === 'loading', JSON.stringify(first));
  const q = await (await fetch(`${B}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'How many TAC exist, and can more be minted?' }) })).json();
  check('and a question is handled meanwhile (on keyword search)', typeof q.answer === 'string' && q.answer.length > 0);
  const ready = await until(async () => { const h = await health(); return h?.dense === 'ready' ? h : null; });
  check('the vectors finish loading in the background', !!ready);
  check('every chunk was embedded once', calls >= N && calls <= N + 2, `${calls} calls for ${N} chunks`);
  const cache = JSON.parse(readFileSync(path.join(data, 'emb-cache.json'), 'utf8'));
  check('they are kept on the data disk, one entry per chunk', Object.keys(cache).length === N, `${Object.keys(cache).length} entries`);

  run.gw.kill('SIGTERM'); await sleep(300); calls = 0; run = start();
  const again = await until(async () => { const h = await health(); return h?.dense === 'ready' ? h : null; }, 20000);
  check('a restart finds them all and embeds nothing', !!again && calls === 0, `${calls} calls`);

  run.gw.kill('SIGTERM'); await sleep(300);
  const keys = Object.keys(cache); for (const k of keys.slice(0, 3)) delete cache[k];
  writeFileSync(path.join(data, 'emb-cache.json'), JSON.stringify(cache)); calls = 0; run = start();
  const part = await until(async () => { const h = await health(); return h?.dense === 'ready' ? h : null; }, 20000);
  check('with three entries missing, exactly those three are embedded again', !!part && calls === 3, `${calls} calls`);

  // the embedding server goes away: the service keeps answering and tries again
  run.gw.kill('SIGTERM'); await sleep(300); rmSync(path.join(data, 'emb-cache.json')); emb.closeAllConnections?.(); emb.close(); await sleep(200);
  run = start();
  const down = await until(health, 15000); await sleep(1500);
  const q2 = await (await fetch(`${B}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'What do I get for holding TAC?' }) })).json();
  check('with the embedding server down it still answers, on keyword search', down?.dense === 'loading' && typeof q2.answer === 'string' && q2.answer.length > 0, JSON.stringify(down));
} finally { run.gw.kill('SIGTERM'); emb.close(); await sleep(100); rmSync(data, { recursive: true, force: true }); }
console.log(fails ? `${fails} FAILED` : 'embeddings: all tests passed'); if (fails) console.log(run.log().slice(-500));
process.exit(fails ? 1 : 0);
