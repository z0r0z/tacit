// The front page's "Task" line (dapp/tasks/open.js) in a real browser, under the page's own CSP, with every request to a service the page would
// make stubbed or refused: it shows only when the rewards service is on, a job's rewards have opened, some step of it has no claim and is not already
// on the chain, and the tasks budget has room; it says what there is to earn; it is remembered for five minutes; and it fits beside the airdrop line at a phone and a desktop width.
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/lander-tasknews.mjs      (SHOTS=dir saves screenshots)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, SHOTS = process.env.SHOTS || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const TAC = 10n ** 18n, NOW = Math.floor(Date.now() / 1000);
const step = (id, tac, claimed = false) => ({ id, chainId: 1, estimateWei: String(BigInt(tac) * TAC), claim: claimed ? { address: '0x1', wei: String(BigInt(tac) * TAC), txHash: '0x2', state: 'credited' } : null });
const api = (jobs, budget = 760) => ({ enabled: true, endSec: NOW + 1e6, budget: { totalWei: String(1150n * TAC), creditedWei: '0', pendingWei: '0', remainingWei: String(BigInt(budget) * TAC) }, jobs });
const meta = (id, title, opensAt) => ({ id, title, opensAt, steps: [] });
const AT = '0x00000065e3e51af95d330fb6932ca3e87912c554';
const deploy = (id, title, opensAt) => ({ ...meta(id, title, opensAt), chainId: 1, steps: [{ id: '01-amm-route', kind: 'createx', expected: AT }] });
const NODE = /^https:\/\/(ethereum-rpc\.publicnode\.com|eth\.drpc\.org|1rpc\.io|mainnet\.gateway\.tenderly\.co)$/, CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };

const browser = await chromium.launch();
async function open({ service, jobs, viewport = { width: 1280, height: 900 }, store = null, chain = null }) {
  const ctx = await browser.newContext({ viewport });
  const errors = [], blocked = [], reads = [];
  await ctx.addInitScript(() => { window.__cls = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch { } });
  if (store) await ctx.addInitScript((s) => { try { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } catch { } }, store);
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.origin === SITE) {
      if (u.pathname === '/tasks/jobs.json' && jobs) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs }) });
      return route.continue();
    }
    if (u.origin === 'https://tacit-points.onrender.com' && u.pathname === '/tasks') {
      if (service === 'down') return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: 'down' });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(service) });
    }
    if (chain && NODE.test(u.origin)) {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const call = JSON.parse(route.request().postData() || '{}'), at = String(call.params?.[0]).toLowerCase();
      if (call.method !== 'eth_getCode') return route.abort();
      reads.push(at);
      return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ jsonrpc: '2.0', id: call.id, result: chain.has(at) ? '0x6080' : '0x' }) });
    }
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) blocked.push(t); } });
  await page.goto(`${SITE}/`, { waitUntil: 'load' });
  await page.waitForSelector('#air-news');
  return { ctx, page, errors, blocked, reads };
}
const pill = (page) => page.evaluate(() => { const a = document.getElementById('task-news'); return { shown: !!a && !a.hidden && a.getBoundingClientRect().width > 0, text: a?.innerText.replace(/\s+/g, ' ').trim(), href: a?.getAttribute('href'), title: a?.getAttribute('title') }; });
const settle = async (page, want) => { await page.waitForFunction((w) => { const a = document.getElementById('task-news'); return w ? !!a && !a.hidden : true; }, want, { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(want ? 200 : 1800); };

const OPEN = [meta('amm-route', 'Deploy the swap route', NOW - 60)];

// a live job
{
  const { ctx, page, errors, blocked } = await open({ service: api([{ id: 'amm-route', estimateWei: String(30n * TAC), steps: [step('01-amm-route', 30)] }]), jobs: OPEN });
  await settle(page, true);
  const p = await pill(page);
  ok(p.shown && p.text === 'Task Earn 30 TAC →', `a live job shows the line with what it pays (${p.text})`);
  ok(p.href === '/tasks/' && p.title === 'Deploy the swap route', 'it links to the tasks page and names the job on hover');
  const air = await page.evaluate(() => { const a = document.getElementById('air-news').getBoundingClientRect(), t = document.getElementById('task-news').getBoundingClientRect(); return { a: [a.left, a.top, a.right, a.bottom], t: [t.left, t.top, t.right, t.bottom], over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
  const apart = air.a[2] <= air.t[0] || air.t[2] <= air.a[0] || air.a[3] <= air.t[1] || air.t[3] <= air.a[1];
  ok(apart && air.over === 0, 'at a desktop width it sits beside the airdrop line without overlapping it or widening the page');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'lander-task-desktop.png') });
  const cls = await page.evaluate(() => window.__cls);
  ok(cls < 0.05, `the line appearing after the first paint moves the page by ${cls.toFixed(3)} (under 0.05)`);
  ok(!errors.length && !blocked.length, `no page errors and nothing blocked by the CSP${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}${blocked.length ? ': ' + blocked[0] : ''}`);
  await ctx.close();
}
// the same page with no line, to tell what the line adds from what the page does anyway
{
  const { ctx, page } = await open({ service: 'down', jobs: OPEN });
  await settle(page, false);
  const base = await page.evaluate(() => window.__cls);
  console.log(`       (the page with no line moves by ${base.toFixed(3)} on its own)`);
  await ctx.close();
}
// a phone
{
  const { ctx, page } = await open({ service: api([{ id: 'amm-route', estimateWei: String(30n * TAC), steps: [step('01-amm-route', 30)] }]), jobs: OPEN, viewport: { width: 390, height: 844 } });
  await settle(page, true);
  const g = await page.evaluate(() => { const a = document.getElementById('air-news').getBoundingClientRect(), t = document.getElementById('task-news').getBoundingClientRect(), tile = document.getElementById('hx').getBoundingClientRect(); return { apart: a.right <= t.left || t.right <= a.left || a.bottom <= t.top || t.bottom <= a.top, top: Math.min(a.top, t.top), tile: tile.bottom, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, right: t.right, vw: innerWidth }; });
  ok(g.apart && g.over === 0 && g.right <= g.vw && g.top >= g.tile, 'at a phone width the two lines wrap, stay inside the page and sit below the tile');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'lander-task-phone.png') });
  await ctx.close();
}
// not live
for (const [name, opts] of [
  ['every step claimed', { service: api([{ id: 'amm-route', estimateWei: String(30n * TAC), steps: [step('01-amm-route', 30, true)] }]), jobs: OPEN }],
  ['rewards not open yet', { service: api([{ id: 'amm-route', estimateWei: String(30n * TAC), steps: [step('01-amm-route', 30)] }]), jobs: [meta('amm-route', 'x', NOW + 3600)] }],
  ['a job with no opening time', { service: api([{ id: 'amm-route', estimateWei: String(30n * TAC), steps: [step('01-amm-route', 30)] }]), jobs: [meta('amm-route', 'x', 0)] }],
  ['the service does not list the job', { service: api([{ id: 'other', estimateWei: '0', steps: [step('a', 5)] }]), jobs: OPEN }],
  ['the tasks budget is spent', { service: api([{ id: 'amm-route', estimateWei: String(30n * TAC), steps: [step('01-amm-route', 30)] }], 0), jobs: OPEN }],
  ['the service has tasks off', { service: { enabled: false }, jobs: OPEN }],
  ['the service is down', { service: 'down', jobs: OPEN }],
]) {
  const { ctx, page } = await open(opts);
  await settle(page, false);
  ok(!(await pill(page)).shown, `no line when ${name}`);
  await ctx.close();
}
// two jobs, one partly done
{
  const { ctx, page } = await open({ service: api([
    { id: 'amm-route', estimateWei: String(30n * TAC), steps: [step('01', 30)] },
    { id: 'big', estimateWei: String(200n * TAC), steps: [step('a', 100, true), step('b', 60), step('c', 40)] },
  ]), jobs: [...OPEN, meta('big', 'A big one', NOW - 10)] });
  await settle(page, true);
  const p = await pill(page);
  ok(p.text === '2 tasks Earn up to 130 TAC →', `two live jobs are counted, and only the steps still open are summed (${p.text})`);
  await ctx.close();
}
// a retired job is a record, not a task, even while a step of it is still unclaimed
{
  const { ctx, page } = await open({ service: api([{ id: 'amm-route-v1', estimateWei: String(30n * TAC), steps: [step('01-amm-route', 30)] }]), jobs: [{ ...meta('amm-route-v1', 'Old', NOW - 60), retired: true }] });
  await settle(page, false);
  ok(!(await pill(page)).shown, 'no line for a retired job whose step has not been claimed yet');
  await ctx.close();
}
// a contract that is already on the chain has nothing left to send, claimed or not
{
  const live = api([{ id: 'amm-route', estimateWei: String(30n * TAC), steps: [step('01-amm-route', 30)] }]), jobs = [deploy('amm-route', 'Deploy the swap route', NOW - 60)];
  const a = await open({ service: live, jobs, chain: new Set([AT]) });
  await settle(a.page, false);
  ok(!(await pill(a.page)).shown && a.reads.includes(AT), 'no line for a step whose contract is already on the chain, though its reward is not claimed');
  await a.ctx.close();
  const b = await open({ service: live, jobs, chain: new Set() });
  await settle(b.page, true);
  ok((await pill(b.page)).text === 'Task Earn 30 TAC →', 'a contract that is not on the chain yet is still a task');
  await b.ctx.close();
  const c = await open({ service: live, jobs });
  await settle(c.page, true);
  ok((await pill(c.page)).shown, 'and when no node answers the line stays');
  await c.ctx.close();
  const d = await open({ service: api([{ id: 'amm-route', estimateWei: String(30n * TAC), steps: [step('01-amm-route', 30, true)] }]), jobs, chain: new Set() });
  await settle(d.page, false);
  ok(!(await pill(d.page)).shown && !d.reads.length, 'a claimed step is not looked up on the chain');
  await d.ctx.close();
}
// a job whose reward is not known yet
{
  const { ctx, page } = await open({ service: api([{ id: 'amm-route', estimateWei: null, steps: [{ id: '01', chainId: 1, estimateWei: null, claim: null }] }]), jobs: OPEN });
  await settle(page, true);
  ok((await pill(page)).text === 'Task Earn TAC →', 'a job with no price yet says only that it earns TAC');
  await ctx.close();
}
// remembered for five minutes
{
  const live = JSON.stringify({ at: Date.now() - 60e3, live: [{ id: 'amm-route', title: 'Kept', wei: String(30n * TAC) }] });
  const a = await open({ service: 'down', jobs: OPEN, store: { 'tacit-tasks-live-v1': live } });
  await settle(a.page, true);
  ok((await pill(a.page)).text === 'Task Earn 30 TAC →', 'a fresh remembered answer shows the line with no request to the service');
  await a.ctx.close();
  const old = JSON.stringify({ at: Date.now() - 600e3, live: [{ id: 'amm-route', title: 'Kept', wei: String(30n * TAC) }] });
  const b = await open({ service: 'down', jobs: OPEN, store: { 'tacit-tasks-live-v1': old } });
  await settle(b.page, false);
  ok(!(await pill(b.page)).shown, 'an answer older than five minutes is asked again (and the service being down shows nothing)');
  await b.ctx.close();
}

await browser.close();
server.close();
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
