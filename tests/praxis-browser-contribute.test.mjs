#!/usr/bin/env node
// A contribution made from the Tacit Praxis ceremony page in a real browser (dapp/praxis/, under its own CSP), against a real coordinator
// and the real HTTPS window (ceremony-phase2/proxy) on the toy circuit. The page's calls to the ceremony's address are sent to the local
// window; nothing leaves the machine. After the browser's contribution is accepted the chain is checked link by link with the Go tool.
//
//   node tests/praxis-browser-contribute.test.mjs [workdir]     (PLAYWRIGHT=<path to playwright-core>; reuses the toy fixture in workdir)
import { createRequire } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import { spawn as sp, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const CER = resolve(new URL('../ceremony-phase2/', import.meta.url).pathname);
const W = resolve(process.argv[2] || mkdtempSync(join(tmpdir(), 'praxis-browser-')));
mkdirSync(W, { recursive: true });
const sh = (cmd, args, opts) => execFileSync(cmd, args, { cwd: W, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

// BASE_FILE=<a real head> and PREBUILT=1 (a tacit-ceremony binary already in the workdir) turn this into the full-size run
let base = 'fix/phase2-17';
if (process.env.BASE_FILE) base = resolve(process.env.BASE_FILE);
else {
  if (!process.env.PREBUILT) {
    sh('go', ['build', '-o', join(W, 'tacit-ceremony'), './cmd/tacit-ceremony'], { cwd: CER });
    sh('go', ['build', '-o', join(W, 'fixture'), './rehearsal/fixture'], { cwd: CER });
  }
  if (!existsSync(join(W, 'fix'))) sh('./fixture', ['make', 'fix'], { env: { ...process.env, FIXTURE_PAD: '3000' } });
}
rmSync(join(W, 'chain'), { recursive: true, force: true });
sh('./tacit-ceremony', ['init', 'chain', base, '17', 'browser test']);

const CP = 18300, PP = 18302;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const coord = sp(join(W, 'tacit-ceremony'), ['serve', '--per-ip', '1', '--heartbeat', '20s', '--claim-window', '60s', '--client-ip-header', 'X-Tacit-Client-IP', '--trusted-proxies', '127.0.0.1/32', 'chain', `127.0.0.1:${CP}`], { cwd: W, stdio: 'ignore' });
const proxy = sp('node', [join(CER, 'proxy/server.mjs')], { env: { ...process.env, COORDINATOR_URL: `http://127.0.0.1:${CP}`, PORT: String(PP), ALLOWED_ORIGINS: BASE, BROWSER_CONTRIBUTE: '1' }, stdio: 'ignore' });
// TLS_FORWARD=1: the ceremony's address resolves to a local HTTPS forwarder (self-signed) so a large download streams for real
let fwd = null;
if (process.env.TLS_FORWARD) {
  sh('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '2', '-subj', '/CN=tacit-praxis-ceremony.onrender.com', '-addext', 'subjectAltName=DNS:tacit-praxis-ceremony.onrender.com']);
  fwd = https.createServer({ key: readFileSync(join(W, 'k.pem')), cert: readFileSync(join(W, 'c.pem')) }, (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: PP, method: req.method, path: req.url, headers: { ...req.headers, 'true-client-ip': '203.0.113.50' } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => res.destroy());
    req.pipe(up);
  }).listen(18443);
}
const stop = async () => { coord.kill(); proxy.kill(); server.close(); fwd?.close(); await b?.close(); };
await new Promise((r) => setTimeout(r, 2000));

let b;
try {
  const args = [...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ') : []), ...(fwd ? ['--host-resolver-rules=MAP tacit-praxis-ceremony.onrender.com 127.0.0.1:18443'] : [])];
  b = await chromium.launch(args.length ? { args } : undefined);
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: !!fwd });
  const page = await ctx.newPage();
  const errs = [], csp = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 200)); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)(?!tacit-praxis-ceremony\.onrender\.com)/, (route) => route.abort());
  // the ceremony's address is the local window
  if (!fwd) await page.route(/^https:\/\/tacit-praxis-ceremony\.onrender\.com\//, async (route) => {
    const u = new URL(route.request().url());
    try {
      const r = await route.fetch({ url: `http://127.0.0.1:${PP}${u.pathname}${u.search}`, headers: { ...route.request().headers(), 'true-client-ip': '203.0.113.50' } });
      await route.fulfill({ response: r });
    } catch (e) { await route.abort(); }
  });
  await page.goto(`${BASE}/praxis/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#web').hidden, null, { timeout: 20000 });
  ok(true, 'the page offers the in-browser path once the window says the coordinator takes it');
  ok(!(await page.$eval('#cmd-alt', (d) => d.open)), 'with the browser path offered, the terminal command is folded away');
  ok(await page.isVisible('#web-go') && /Contribute/.test(await page.innerText('#web-go')), 'one big button to contribute');
  await page.fill('#name', 'Browser Tester');
  await page.click('#web-go');
  if (process.env.PROGRESS) { const t0 = Date.now(); const iv = setInterval(async () => console.log(`  ${Math.round((Date.now() - t0) / 1000)} s: ${await page.innerText('#web-msg').catch(() => '')}`), 30000); page.once('close', () => clearInterval(iv)); b.once('disconnected', () => clearInterval(iv)); }
  await page.waitForFunction(() => /Accepted|interrupted/.test(document.querySelector('#web-msg').textContent), null, { timeout: Number(process.env.RUN_MS || 240000) });
  const msg = await page.innerText('#web-msg');
  ok(/Accepted/.test(msg), `the contribution is accepted from the page (${msg.slice(0, 90)})`);
  ok(await page.$eval('#cele', (d) => d.open), 'the celebration opens');
  ok((await page.$$('#track li.past')).length === 3 && (await page.$eval('#track li:last-child', (e) => e.classList.contains('on'))), 'the four steps end on Done, the first three behind');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/praxis-browser-done.png`, fullPage: false });
  ok(csp.length === 0 && errs.length === 0, `no CSP violations or page errors (${[...csp, ...errs].slice(0, 2).join(' | ')})`);
  const head = JSON.parse(await (await fetch(`http://127.0.0.1:${CP}/api/head`)).text()).index;
  ok(head === 18, `the head is phase2-${head}`);
  try { sh('./tacit-ceremony', ['verify-chain', 'chain', '17', String(head)]); ok(true, 'the chain verifies link by link with the Go tool'); }
  catch (e) { ok(false, 'the chain verifies: ' + String(e.stderr || e).slice(0, 200)); }
} catch (e) {
  ok(false, 'the run: ' + (e.stack || e));
} finally { await stop(); }
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
