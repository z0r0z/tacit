// The nodes page (dapp/nodes/) in a real browser, under its content-security policy: the module graph loads, the signed status is read from the API origin
// (stood in for by a route), the page shows it when the key is pinned and it verifies, says so when no key is pinned, and shows nothing when it does not verify.
//   PLAYWRIGHT=<path to playwright-core> node tests/nodes-page.mjs        (Node 22; SHOTS=<dir> saves screenshots)
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { sampleStatus, samplePub } from './lib/nodes-sample.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const server = createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (p.endsWith('/')) p += 'index.html';
  const f = join(DAPP, p);
  if (!f.startsWith(DAPP) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok -', name); } catch (e) { failed++; console.log('not ok -', name, '\n', e.message); } };

async function open({ status, pinned, scheme = 'light', width = 1100 }) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  // the build pins no key; a run that pins one serves a pin file with it
  if (pinned) await page.route('**/nodes-pin.js', (r) => r.fulfill({ contentType: 'text/javascript', body: `export const PROBER_PUBS = Object.freeze(['${pinned}']); export const NODES_API = 'https://api.tacit.finance/nodes';` }));
  await page.route('https://api.tacit.finance/nodes/status', (r) => r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(status) }));
  await page.goto(`${base}/nodes/`);
  await page.waitForFunction(() => document.getElementById('sig').textContent !== 'Loading…', null, { timeout: 15000 });
  return { page, ctx, problems };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: true }); };

await check('verified status: leaderboard and nodes drawn, CSP clean', async () => {
  const { page, ctx, problems } = await open({ status: sampleStatus(), pinned: samplePub });
  assert.match(await page.textContent('#sig'), /Verified\./);
  assert.equal(await page.locator('#ops-body tr').count(), 5);
  assert.equal(await page.locator('#nodes-body tr').count(), 9);
  assert.match(await page.textContent('#ops-body tr:first-child'), /alice/);
  await shot(page, 'nodes-verified-light');
  await page.click('#filter button[data-f="community"]');
  assert.equal(await page.locator('#nodes-body tr').count(), 4);
  await shot(page, 'nodes-community-filter');
  assert.deepEqual(problems, []);
  await ctx.close();
});
await check('dark scheme and a phone width', async () => {
  const d = await open({ status: sampleStatus(), pinned: samplePub, scheme: 'dark' });
  await shot(d.page, 'nodes-verified-dark'); await d.ctx.close();
  const m = await open({ status: sampleStatus(), pinned: samplePub, width: 390 });
  assert.ok(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll');
  await shot(m.page, 'nodes-phone'); await m.ctx.close();
});
await check('no key pinned: shown and marked not verified', async () => {
  const { page, ctx } = await open({ status: sampleStatus() });
  assert.match(await page.textContent('#sig'), /Not verified/);
  assert.equal(await page.locator('#ops-body tr').count(), 5);
  await shot(page, 'nodes-unpinned'); await ctx.close();
});
await check('a status that does not verify shows nothing', async () => {
  const bad = sampleStatus(); bad.operators[0].score = 9999;
  const { page, ctx } = await open({ status: bad, pinned: samplePub });
  assert.match(await page.textContent('#sig'), /does not verify/);
  assert.equal(await page.locator('#ops-body tr').count(), 0);
  await shot(page, 'nodes-rejected'); await ctx.close();
});
await browser.close(); server.close();
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('nodes page: all ok');
