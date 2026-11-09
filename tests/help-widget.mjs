#!/usr/bin/env node
// The help launcher (dapp/help/widget.js, loaded by dapp/chrome.js) in a real browser, under each page's own CSP. The launcher is shown by default
// (the LIVE constant in chrome.js; a browser can choose localStorage "tacit.help" = "off"); every page that wears the site's header carries it, bottom right, and
// opens the help page in a panel: fetched only when first opened, framed by the page's own origin, closed by Escape (also from inside), and the same
// conversation when it is opened again. The help desk behind it is a stand-in.
//   checks: shown by default and hidden by a browser's "off"; on every chrome page: the launcher is bottom right, nothing is fetched before it is pressed, the panel opens with the framed layout and no
//   frame or CSP refusal, it closes and the launcher has the focus again; the behaviour once (a question, Escape from the page and from the frame, a second opening,
//   tacitHelp.open()); not on the help page itself nor inside the frame; a phone sheet in both colour schemes.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/help-widget.mjs        (SHOTS=<dir> saves screenshots)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let helpCoep = true;   // the Render header rule on /help/*
const dapp = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  // what Render says for the site: a page may be framed by its own origin and nobody else's; and the front page, /tac/ and /btc-pool/ are cross-origin isolated,
  // which lets them frame only a document that is isolated too (so /help/* carries the header too, as dapp's Render rule makes it, unless a test takes it away)
  const isolated = p === '/' || p === '/index.html' || p.startsWith('/tac/') || p.startsWith('/btc-pool/');
  const h = { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "frame-ancestors 'self'" };
  if (isolated || (p.startsWith('/help/') && helpCoep)) h['cross-origin-embedder-policy'] = 'credentialless';
  if (p === '/' || p === '/index.html' || p.startsWith('/tac/')) h['cross-origin-opener-policy'] = 'same-origin';
  res.writeHead(200, h);
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => dapp.on('listening', r));
const BASE = `http://127.0.0.1:${dapp.address().port}`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const b = await chromium.launch({ channel: 'chromium-headless-shell' });
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const HELP_HOST = /^https:\/\/tacit-helpdesk\.onrender\.com\//;

async function open(rel, { on = true, off = false, viewport = { width: 1100, height: 800 }, scheme = 'light' } = {}) {
  const ctx = await b.newContext({ viewport, colorScheme: scheme });
  const page = await ctx.newPage();
  const refused = [], helpCalls = [], asks = [];
  page.on('console', (m) => { const t = m.text(); if (/frame-src|frame-ancestors|framing|x-frame/i.test(t) && /Refused|violates|blocked/i.test(t)) refused.push(t.slice(0, 200)); });
  if (on) await page.addInitScript(() => { try { localStorage.setItem('tacit.help', 'on'); } catch {} });
  if (off) await page.addInitScript(() => { try { localStorage.setItem('tacit.help', 'off'); } catch {} });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.route(HELP_HOST, (route) => {
    const q = route.request(), u = new URL(q.url()); helpCalls.push(`${q.method()} ${u.pathname}`);
    if (q.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (u.pathname === '/health') return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: '{"ok":true,"nodes":2,"dense":"ready","backends":[]}' });
    if (u.pathname === '/ask') { asks.push(JSON.parse(q.postData() || '{}').q); return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ answer: 'Two audits, both public.', sources: ['Security > Audits'] }) }); }
    return route.fulfill({ status: 404, headers: CORS, body: '' });
  });
  await page.goto(`${BASE}/${rel.replace(/index\.html$/, '')}`, { waitUntil: 'load' });
  return { page, ctx, refused, helpCalls, asks };
}
const frameOf = async (page) => { const h = await page.waitForSelector('#hw-p iframe', { state: 'attached', timeout: 15000 }); const f = await h.contentFrame(); await f.waitForSelector('#q', { timeout: 15000 }); return f; };
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const gap = (page) => page.evaluate(() => { const r = document.querySelector('.hw-b').getBoundingClientRect(); return { right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom), w: Math.round(r.width) }; });

try {
// ── shown by default (LIVE in chrome.js), hidden for a browser that chose "off" ──
for (const rel of ['index.html', 'pay/index.html', 'prove/index.html']) {
  const a = await open(rel, { on: false });   // no preference stored
  await a.page.locator('.hw-b').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  ok((await a.page.locator('.hw-b').count()) === 1 && a.helpCalls.length === 0, `${rel}: the launcher is there by default, and has said nothing to the help desk`);
  await a.ctx.close();
  const b2 = await open(rel, { on: false, off: true });
  await b2.page.waitForTimeout(700);
  ok((await b2.page.locator('.hw').count()) === 0 && (await b2.page.evaluate(() => window.tacitHelp)) === undefined && b2.helpCalls.length === 0, `${rel}: a browser that chose "off" gets no launcher and no word to the help desk`);
  await b2.ctx.close();
}

// ── every page that wears the site's header ──
// every page that carries the site's header, found in the files (a generated page such as /tac/ is not in build/chrome.mjs's list)
const PAGES = readdirSync(DAPP, { recursive: true }).filter((f) => f.endsWith('index.html') && f !== 'help/index.html' && readFileSync(join(DAPP, f), 'utf8').includes('chrome:head:begin')).sort();
ok(PAGES.length >= 22 && PAGES.includes('tac/index.html') && PAGES.includes('index.html'), `${PAGES.length} pages carry the site's header, the front page and /tac/ among them`);
for (const rel of PAGES) {
  const { page, ctx, refused, helpCalls } = await open(rel);
  const btn = page.locator('.hw-b');
  try { await btn.waitFor({ state: 'visible', timeout: 15000 }); } catch { ok(false, `${rel}: the launcher appears`); await ctx.close(); continue; }
  const g = await gap(page);
  const early = { frames: await page.locator('#hw-p iframe').count(), calls: helpCalls.length };
  await btn.click();
  const frame = await frameOf(page).catch(() => null);
  if (!frame) { ok(false, `${rel}: the help page loads in the panel${refused.length ? ' (' + refused[0] + ')' : ''}`); await ctx.close(); continue; }
  const framed = await frame.evaluate(() => ({ embed: document.documentElement.classList.contains('embed'), top: getComputedStyle(document.querySelector('.top')).display, foot: getComputedStyle(document.querySelector('footer.sf')).display, widget: !!document.getElementById('hw') }));
  const shown = await page.locator('#hw-p').isVisible();
  await page.click('.hw-x');
  const back = await page.evaluate(() => document.activeElement && document.activeElement.className);
  ok(g.w === 48 && g.right >= 14 && g.right <= 26 && g.bottom >= 14 && g.bottom <= 26, `${rel}: the launcher is bottom right (${g.right}/${g.bottom} px from the edges)`);
  ok(early.frames === 0 && early.calls === 0, `${rel}: nothing is fetched before it is pressed`);
  ok(shown && framed.embed && framed.top === 'none' && framed.foot === 'none' && !framed.widget, `${rel}: the panel opens with the framed layout and no launcher inside it`);
  ok(refused.length === 0, `${rel}: no frame or CSP refusal${refused.length ? ': ' + refused[0] : ''}`);
  ok(!(await page.locator('#hw-p').isVisible()) && /hw-b/.test(back || ''), `${rel}: it closes and the launcher has the focus`);
  await ctx.close();
}

// ── how it behaves, once ──
{
  const { page, ctx, helpCalls, asks, refused } = await open('pay/index.html');
  await page.locator('.hw-b').waitFor({ state: 'visible' });
  await page.click('.hw-b');
  const frame = await frameOf(page);
  ok((await page.getAttribute('.hw-b', 'aria-expanded')) === 'true' && (await page.getAttribute('#hw-p', 'role')) === 'dialog', 'open: aria-expanded is true and the panel is a dialog');
  await page.waitForFunction(() => document.querySelector('#hw-p iframe').contentDocument.activeElement?.id === 'q');
  ok(true, 'open: the question box in the frame has the focus');
  await frame.fill('#q', 'Has Tacit been audited?'); await frame.click('#go');
  await frame.waitForSelector('#out .a');
  ok(asks.length === 1 && asks[0] === 'Has Tacit been audited?' && (await frame.locator('#out .a').innerText()) === 'Two audits, both public.', 'a question asked in the panel reaches the help desk and its answer is drawn');
  await page.focus('.hw-b');   // focus on the page itself, not in the frame
  await page.keyboard.press('Escape');
  ok(!(await page.locator('#hw-p').isVisible()), 'Escape on the page closes it');
  await page.click('.hw-b');
  await page.waitForFunction(() => document.querySelector('#hw-p iframe').contentDocument.activeElement?.id === 'q');
  ok((await page.locator('#hw-p iframe').count()) === 1 && (await frame.locator('#out .a').innerText()) === 'Two audits, both public.' && asks.length === 1, 'opened again it is the same conversation, in the same frame, and asks nothing more');
  await frame.press('#q', 'Escape');
  await page.waitForFunction(() => document.getElementById('hw-p').hidden);
  ok(await page.evaluate(() => document.activeElement.className === 'hw-b'), 'Escape inside the frame closes it too, and the launcher has the focus');
  await page.evaluate(() => window.tacitHelp.open());
  ok(await page.locator('#hw-p').isVisible(), 'tacitHelp.open() shows it');
  await page.evaluate(() => window.tacitHelp.close());
  ok(!(await page.locator('#hw-p').isVisible()), 'tacitHelp.close() hides it');
  ok(refused.length === 0, 'no frame or CSP refusal');
  ok(helpCalls.filter((c) => c === 'POST /ask').length === 1, 'the help desk was asked exactly once');
  await ctx.close();
}

// ── a frame that is refused leaves a way out, not a dead box ──
{
  helpCoep = false;   // as the front page is until the header rule is on /help/*: an isolated page cannot frame a document that is not
  const { page, ctx } = await open('index.html');
  await page.locator('.hw-b').waitFor({ state: 'visible' });
  await page.click('.hw-b');
  await page.waitForSelector('#hw-p .hw-f', { timeout: 15000 });
  const link = await page.locator('#hw-p .hw-f a').getAttribute('href');
  ok(link === '/help/' && (await page.locator('#hw-p iframe').count()) === 0 && (await page.locator('#hw-p').isVisible()), 'a frame the page refuses is replaced by a link to the help page, in the panel');
  await page.click('.hw-x'); await page.click('.hw-b');
  ok((await page.locator('#hw-p .hw-f').count()) === 1 && (await page.locator('#hw-p iframe').count()) === 0, 'opened again it says the same, without trying the frame again');
  await ctx.close();
  helpCoep = true;
}

// ── the "page updated" notice's Reload button never sits under the launcher, on a range of phone widths ──
for (const width of [320, 360, 390]) {
  const ctx = await b.newContext({ viewport: { width, height: 700 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.__tacitUpd = true; });
  let etag = 'W/"one"';
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.route(`${BASE}/pay/`, (route) => (route.request().method() === 'HEAD' ? route.fulfill({ status: 200, headers: { etag, 'content-type': 'text/html' }, body: '' }) : route.continue()));
  await page.clock.install();
  await page.goto(`${BASE}/pay/`, { waitUntil: 'load' });
  await page.locator('.hw-b').waitFor({ state: 'visible', timeout: 15000 });
  etag = 'W/"two"';
  await page.clock.runFor(11 * 60e3);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForSelector('[role=status] button', { timeout: 15000 });
  const m = await page.evaluate(() => { const r = (e) => e.getBoundingClientRect(); const a = r(document.querySelector('[role=status] button')), l = r(document.querySelector('.hw-b'));
    const e = document.elementFromPoint(a.x + a.width / 2, a.y + a.height / 2); return { apart: a.right <= l.left || a.left >= l.right || a.bottom <= l.top || a.top >= l.bottom, reached: !!e && !!e.closest('[role=status]') }; });
  ok(m.apart && m.reached, `${width} px: the notice's Reload button is clear of the launcher and is what a tap reaches`);
  await ctx.close();
}

// ── not on the help page itself ──
{
  const { page, ctx } = await open('help/index.html');
  await page.waitForTimeout(800);
  ok((await page.locator('.hw').count()) === 0, 'the help page has no launcher of its own');
  await ctx.close();
}

// ── a phone: a sheet, light and dark ──
for (const scheme of ['light', 'dark']) {
  const { page, ctx, refused } = await open('pay/index.html', { viewport: { width: 375, height: 760 }, scheme });
  await page.locator('.hw-b').waitFor({ state: 'visible' });
  const g = await gap(page);
  await page.click('.hw-b');
  const frame = await frameOf(page);
  await frame.fill('#q', 'What do I get for holding TAC?'); await frame.click('#go'); await frame.waitForSelector('#out .a');
  const m = await page.evaluate(() => { const r = document.getElementById('hw-p').getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom), h: Math.round(r.height), sw: document.documentElement.scrollWidth, iw: innerWidth }; });
  ok(g.right >= 14 && g.bottom >= 14, `${scheme}: the launcher keeps its corner on a phone`);
  ok(m.left === 0 && m.right === 0 && m.bottom === 0 && m.h > 400 && m.h <= 640 && m.sw <= m.iw, `${scheme}: the panel is a full-width sheet at the bottom (${m.h} px high), with no sideways scroll`);
  ok(refused.length === 0, `${scheme}: no frame or CSP refusal`);
  await shot(page, `help-widget-phone-${scheme}`);
  await ctx.close();
}
{
  const { page, ctx } = await open('index.html', { viewport: { width: 1100, height: 800 } });
  await page.locator('.hw-b').waitFor({ state: 'visible' });
  await page.click('.hw-b'); const frame = await frameOf(page); await frame.waitForSelector('#nodes:not(:empty)');
  await shot(page, 'help-widget-front-desktop');
  await ctx.close();
}

} catch (e) { ok(false, `the run stopped: ${String(e.message).split('\n')[0]}`); }
await b.close(); dapp.close();
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\nhelp widget: ${n} checks passed`);
process.exit(fails ? 1 : 0);
