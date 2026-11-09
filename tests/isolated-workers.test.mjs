// The workers the front page and TAC's page start, loaded in a real browser with the headers the site sends (tools/site-isolation-rules.mjs). Those pages are
// cross-origin isolated, and an isolated page loads a worker only when the worker's script is sent with the embedder policy too; without it the worker's `error`
// event fires with no message, and the page can only say that proving stopped. So: every worker script the page starts must have a rule, and each must load.
//   [PLAYWRIGHT=<path to playwright-core>] node --test tests/isolated-workers.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ISOLATION_RULES, isolationHeaders } from '../tools/site-isolation-rules.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };

// every worker script the page names by a path of its own (the threaded prover's worker is found next to its module, under /btc-pool/)
const started = [...new Set([...readFileSync(DAPP + 'index.html', 'utf8').matchAll(/new Worker\('(\/[^'?]+)/g)].map((m) => m[1]))];
const WORKERS = [...started, '/btc-pool/halo2-worker.js'];

test('the page starts the workers this test is about', () => {
  for (const w of ['/evm-pool-prove-worker.js', '/evm-pool-sync-worker.js', '/holding-prove-worker.js']) assert.ok(started.includes(w), `${w} is no longer started by index.html: update this test`);
});

test('every worker script an isolated page starts has the embedder policy rule', () => {
  for (const w of WORKERS) assert.equal(isolationHeaders(w)['cross-origin-embedder-policy'], 'credentialless', `${w} would be sent without Cross-Origin-Embedder-Policy: add it to tools/site-isolation-rules.mjs and run tools/site-isolation-headers.mjs`);
});

let browser, server, base, bare;
before(async () => {
  // `bare` (a worker asked for with ?bare): the rules without the worker scripts' own, to show the browser refuses what this test guards
  bare = ISOLATION_RULES.filter(([path]) => !/-worker\.js$/.test(path) || path.startsWith('/btc-pool/'));
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
    const headers = isolationHeaders(p, u.searchParams.has('bare') ? bare : ISOLATION_RULES);
    if (p === '/tac/blank.html') { res.writeHead(200, { 'content-type': 'text/html', ...headers }); return res.end('<!doctype html><title>blank</title>'); }
    const f = join(DAPP, p);
    if (!f.startsWith(DAPP) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', ...headers });
    res.end(readFileSync(f));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chromium-headless-shell' });
});
after(async () => { await browser?.close(); server?.close(); });

// from an isolated page, start the worker and ask it something: 'loaded' when it answers, 'refused' when its error event fires
async function load(worker) {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/tac/blank.html`);
    return await page.evaluate((url) => new Promise((resolve) => {
      const w = new Worker(url, { type: 'module' });
      const t = setTimeout(() => { w.terminate(); resolve({ state: 'silent', isolated: crossOriginIsolated }); }, 8000);
      const done = (state, extra = {}) => { clearTimeout(t); w.terminate(); resolve({ state, isolated: crossOriginIsolated, ...extra }); };
      w.onerror = (e) => done('refused', { message: e.message || '' });
      w.onmessage = () => done('loaded');
      w.postMessage({ id: 1, op: 'ping' });
    }), worker);
  } finally { await page.close(); }
}

for (const w of WORKERS) {
  test(`${w} loads from an isolated page`, async () => {
    const r = await load(w);
    assert.equal(r.isolated, true, 'the page is cross-origin isolated, as the site makes it');
    assert.equal(r.state, 'loaded', `${w}: ${r.state} ${r.message || ''}`);
  });
}

test('control: without its own rule a worker script does not load on an isolated page', async () => {
  const r = await load('/evm-pool-prove-worker.js?bare');
  assert.equal(r.isolated, true);
  assert.equal(r.state, 'refused', 'the browser no longer refuses a worker that lacks the policy: this test no longer guards what it was written for');
  assert.equal(r.message, '', 'a refusal carries no message, which is why the page cannot say what stopped');
});
