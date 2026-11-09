#!/usr/bin/env node
// dapp/help/ in a real browser, under its own CSP: the page that asks the community help desk. The page and its modules are the real files; what stands in is the
// gateway at tacit-helpdesk.onrender.com (its /health and /ask), and every other origin is cut off.
//   checks: the page starts with no page error and no CSP violation; the count of machines online and the example questions; a question goes to the gateway as
//   the gateway reads it (POST /ask, JSON {q}, no cookies) and its answer and sources are drawn; control+enter; a refused question (429) and a gateway that cannot be
//   reached are said in words and the page asks again; a model's markup stays text; the CSP refuses any other origin; a phone width in both colour schemes.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/help-page.mjs        (SHOTS=<dir> saves screenshots)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const dapp = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => dapp.on('listening', r));
const BASE = `http://127.0.0.1:${dapp.address().port}`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const b = await chromium.launch({ channel: 'chromium-headless-shell' });
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

// gateway: what /health says and what each /ask gets back (a function of the request, so a test can change it)
async function open({ nodes = 3, ask = () => ({ status: 200, body: { answer: 'Two audits, both public.', sources: ['Security > Audits'], ms: 900 } }), viewport = { width: 1100, height: 800 }, scheme = 'light', down = false, touch = false } = {}) {
  const ctx = await b.newContext({ viewport, colorScheme: scheme, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  const errs = [], csp = [], asks = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 220)); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.route(/^https:\/\/tacit-helpdesk\.onrender\.com\//, (route) => {
    const q = route.request(), u = new URL(q.url());
    if (down) return route.abort();
    if (q.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (u.pathname === '/health') return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: nodes > 0, nodes, backends: [] }) });
    if (u.pathname === '/ask') {
      asks.push({ method: q.method(), type: q.headers()['content-type'], cookie: q.headers().cookie, body: JSON.parse(q.postData() || '{}') });
      const r = ask(asks[asks.length - 1]);
      return route.fulfill({ status: r.status, contentType: 'application/json', headers: CORS, body: JSON.stringify(r.body) });
    }
    return route.fulfill({ status: 404, headers: CORS, body: '' });
  });
  await page.goto(`${BASE}/help/`, { waitUntil: 'load' });
  return { page, ctx, errs, csp, asks };
}
const out = (p) => p.locator('#out');
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

// ── the page starts ──
{
  const { page, ctx, errs, csp } = await open();
  await page.waitForFunction(() => document.getElementById('nodes').textContent !== '');
  ok((await page.title()) === 'tacit help', 'the tab says "tacit help"');
  ok((await page.locator('h1').innerText()).replace(/\s+/g, ' ').trim() === 'tacit help', 'the heading is "tacit help"');
  ok((await page.locator('header.top .brand').innerText()).replace(/\s+/g, ' ').trim().toLowerCase() === 'tacit help' && (await page.locator('header.top .brand svg').count()) === 1, 'the header brand reads "tacit help" with the logo');
  ok(!/=>|\$\{|`/.test(await page.locator('body').innerText()), 'no stray template or code text on the page');
  ok((await page.locator('#nodes').innerText()) === '3 community machines online', 'the count of machines online is shown');
  ok((await page.locator('#eg button').count()) === 3, 'three example questions');
  ok((await page.locator('nav.sn a').count()) >= 3, "the site's header links are there");
  ok((await page.locator('footer.sf a').count()) >= 5, "the site's footer links are there");
  ok((await page.locator('#out').count()) === 1 && (await out(page).evaluate((e) => getComputedStyle(e).display)) === 'none', 'nothing is drawn under the box until a question is asked');
  ok(errs.length === 0, 'no page error' + (errs.length ? ': ' + errs[0] : ''));
  ok(csp.length === 0, 'no CSP violation' + (csp.length ? ': ' + csp[0] : ''));
  await shot(page, 'help-empty-light');
  await ctx.close();
}

// ── a question and its answer ──
{
  const { page, ctx, errs, csp, asks } = await open();
  await page.fill('#q', '  Has Tacit been audited?  ');
  await page.click('#go');
  await page.waitForSelector('#out .a');
  ok(asks.length === 1 && asks[0].method === 'POST' && /application\/json/.test(asks[0].type) && asks[0].body.q === 'Has Tacit been audited?' && Object.keys(asks[0].body).join() === 'q', 'the question goes to the gateway as POST /ask with {q}, trimmed');
  ok(!asks[0].cookie, 'no cookie goes with it');
  ok((await page.locator('#out .a').innerText()) === 'Two audits, both public.', 'the answer is drawn');
  ok((await page.locator('#out .src').innerText()) === 'From the docs: Security > Audits', 'where it came from is drawn');
  ok(/can be wrong/.test(await page.locator('#out .fine').innerText()), 'and that it can be wrong');
  ok(await page.locator('#go').isEnabled(), 'the button is on again');
  await page.fill('#q', 'What do I get for holding TAC?');
  await page.press('#q', 'Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('#out .a').length === 1 && document.getElementById('go').disabled === false);
  await page.waitForFunction(() => true);
  ok(asks.length === 2 && asks[1].body.q === 'What do I get for holding TAC?', 'control+enter asks');
  await page.click('#eg button:nth-child(2)');
  await page.waitForFunction(() => document.getElementById('go').disabled === false);
  ok(asks.length === 3 && asks[2].body.q === 'Can I get my notes back with just my key?' && (await page.inputValue('#q')) === asks[2].body.q, 'an example question asks itself and fills the box');
  ok(errs.length === 0 && csp.length === 0, 'no page error, no CSP violation');
  await shot(page, 'help-answer-light');
  await ctx.close();
}

// ── a refused question, an unreachable gateway ──
{
  let first = true;
  const { page, ctx, errs } = await open({ ask: () => { if (first) { first = false; return { status: 429, body: { error: 'Too many questions, try again in a minute.' } }; } return { status: 200, body: { answer: 'Back.', sources: ['FAQ'] } }; } });
  await page.fill('#q', 'x'); await page.click('#go');
  await page.waitForSelector('#out .status.err');
  ok((await page.locator('#out .status').innerText()) === 'Too many questions, try again in a minute.', "a refused question shows the gateway's own words, in the error colour");
  ok(await page.locator('#go').isEnabled(), 'and the button is on again');
  await page.click('#go');
  await page.waitForSelector('#out .a');
  ok((await page.locator('#out .a').innerText()) === 'Back.' && (await page.locator('#out .status').count()) === 0, 'the same question asked again is answered and the error is gone');
  ok(errs.length === 0, 'no page error');
  await ctx.close();

  const d = await open({ down: true });
  await d.page.fill('#q', 'x'); await d.page.click('#go');
  await d.page.waitForSelector('#out .status.err');
  ok(/could not be reached/.test(await d.page.locator('#out .status').innerText()), 'a gateway that cannot be reached is said in words');
  ok((await d.page.locator('#nodes').innerText()) === '', 'and no count of machines is claimed');
  ok(d.errs.length === 0, 'no page error');
  await d.ctx.close();

  const z = await open({ nodes: 0, ask: () => ({ status: 200, body: { answer: 'Nobody is answering right now. Try again soon.', sources: [], unavailable: true } }) });
  await z.page.waitForFunction(() => document.getElementById('nodes').textContent !== '');
  ok((await z.page.locator('#nodes').innerText()) === 'no community machine online', 'with no machine online the page says so');
  await z.page.fill('#q', 'x'); await z.page.click('#go');
  await z.page.waitForSelector('#out .a');
  ok((await z.page.locator('#out .src').count()) === 0 && (await z.page.locator('#out .fine').count()) === 0, "the gateway's own reply carries no sources and no caution");
  await z.ctx.close();
}

// ── a model's markup stays text; the CSP refuses other origins ──
{
  const evil = '<img src=x onerror="window.__pwn=1"><b>bold</b>';
  const { page, ctx, errs, csp } = await open({ ask: () => ({ status: 200, body: { answer: evil, sources: [evil] } }) });
  await page.fill('#q', 'x'); await page.click('#go');
  await page.waitForSelector('#out .a');
  ok((await page.locator('#out img, #out b').count()) === 0 && (await page.locator('#out .a').innerText()) === evil && (await page.evaluate(() => window.__pwn)) === undefined, 'markup in an answer or a source is drawn as text and runs nothing');
  csp.length = 0;
  const verdict = await page.evaluate(() => fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'allowed', () => 'blocked'));
  ok(verdict === 'blocked' && csp.some((t) => /connect-src/.test(t)), 'the CSP refuses a request to any other origin');
  // code run through page.evaluate is exempt from the page's CSP, so inline script is tried the way a page would meet it: a script element with text
  csp.length = 0;
  await page.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.append(s); });
  ok((await page.evaluate(() => window.__inline)) === undefined && csp.some((t) => /script-src/.test(t)), 'and refuses inline script');
  ok(!/unsafe-(eval|inline)'?[^;]*script|script-src[^;]*unsafe/.test(await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content)), "the policy's script-src has neither unsafe-eval nor unsafe-inline");
  ok(errs.length === 0, 'no page error');
  await ctx.close();
}

// ── a phone, light and dark ──
for (const scheme of ['light', 'dark']) {
  const { page, ctx, errs, csp } = await open({ viewport: { width: 375, height: 760 }, scheme, ask: () => ({ status: 200, body: { answer: 'The pool hides who paid whom and how much. What stays public: that a deposit or a withdrawal happened, and its amount at the edge.', sources: ['FAQ > What does the confidential pool hide', 'Docs > Pool'] } }) });
  await page.waitForFunction(() => document.getElementById('nodes').textContent !== '');
  await page.fill('#q', 'What does the confidential pool hide, and what stays public?'); await page.click('#go');
  await page.waitForSelector('#out .a');
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bg: getComputedStyle(document.body).backgroundColor, tap: [...document.querySelectorAll('#go, #eg button')].map((e) => Math.round(e.getBoundingClientRect().height)) }));
  ok(m.sw <= m.iw, `${scheme}: no sideways scroll at 375 px (${m.sw} <= ${m.iw})`);
  ok(m.tap.every((h) => h >= 34), `${scheme}: the buttons are tall enough to press (${m.tap.join(', ')} px)`);
  ok(scheme === 'dark' ? /rgb\(2[0-9], 1[0-9], 1[0-9]\)/.test(m.bg) : /rgb\(23\d, 22\d, 20\d\)/.test(m.bg), `${scheme}: the page wears the ${scheme} paper (${m.bg})`);
  ok(errs.length === 0 && csp.length === 0, `${scheme}: no page error, no CSP violation`);
  await shot(page, `help-phone-${scheme}`);
  await ctx.close();
}

// ── a touch screen: a tap leaves the button as it was, not in its hover look ──
{
  const { page, ctx } = await open({ viewport: { width: 375, height: 760 }, touch: true });
  await page.fill('#q', 'x'); await page.tap('#go');
  await page.waitForSelector('#out .a');
  await page.waitForTimeout(400);
  const bg = await page.locator('#go').evaluate((e) => getComputedStyle(e).backgroundColor);
  ok(!(await page.evaluate(() => matchMedia('(hover: hover)').matches)) && bg === 'rgb(26, 26, 26)', `after a tap the Ask button is still filled (${bg})`);
  await ctx.close();
}

await b.close(); dapp.close();
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\nhelp page: ${n} checks passed`);
process.exit(fails ? 1 : 0);
