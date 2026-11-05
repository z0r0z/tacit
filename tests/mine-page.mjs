// The mining page (dapp/mine/) in a real browser under its content-security policy, with the computer's tacit-prover and the pool and
// points services stood in by routes: nothing set up (the setup line, with the address), an older prover (the setup line again), paused,
// started from the button (the POST it sends), proving with a bar and the time left, paused mid-proof, and a phone.
//   PLAYWRIGHT=<path to playwright-core> node tests/mine-page.mjs        (Node 22; SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const server = createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (p.endsWith('/')) p += 'index.html';
  const f = join(DAPP, p);
  if (!f.startsWith(DAPP) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://localhost:${server.address().port}`;

const ADDR = '0x66f5a1225e6ac772c461f2b4d8028bf9568f3db5';
const day = Math.floor(Date.now() / 86400000);
let fails = 0;
const check = (ok, what, got = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (${got})`}`); if (!ok) fails++; };

// The stand-in prover: `local` is what it answers (null: nothing listens), and each POST /mine it was sent.
async function open(browser, local, { phone = false } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 800 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' } : { viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errors.push(m.text()); });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await page.route('http://127.0.0.1:47815/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' } });
    if (!local.v) return route.abort('connectionrefused');
    if (path === '/health') return json(route, { ok: true, vkey: '0x00', busy: !!local.v.mine?.job });
    if (path === '/mine' && req.method() === 'GET') return local.v.mine ? json(route, local.v.mine) : json(route, { error: 'not found' }, 404);
    if (path === '/mine' && req.method() === 'POST') {
      const b = JSON.parse(req.postData() || '{}');
      posts.push(b);
      local.v.mine = { ...local.v.mine, on: b.on, miner: b.miner || local.v.mine.miner };
      return json(route, local.v.mine);
    }
    return json(route, { error: 'not found' }, 404);
  });
  await page.route('https://api.tacit.finance/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/prover/pool') return json(route, { queued: 3, terms: { pointsPerProof: 20, proofsPerMinerDay: 30 } });
    if (u.pathname === '/prover/pool/credits') return json(route, { day, over: false, miners: [{ miner: ADDR, proofs: 4, points: 80 }] });
    return json(route, {}, 404);
  });
  await page.route('https://tacit-points.onrender.com/**', (route) => json(route, { enabled: true, endSec: Math.floor(Date.now() / 1000) + 86400 * 10, terms: { capWeiPerPoint: '10000000000000000' }, account: { creditedWei: '6000000000000000000' } }));
  await page.goto(`${ORIGIN}/mine/`);
  return { page, ctx, errors, posts };
}
const text = (page, s) => page.locator(s).innerText();
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

const browser = await chromium.launch();
try {
  // nothing on this computer
  {
    const local = { v: null };
    const { page, ctx, errors } = await open(browser, local);
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Not set up on this computer');
    check(await page.locator('#setup').isVisible(), 'not set up: the setup line is shown');
    check(!(await page.locator('#go').isVisible()), 'not set up: no start button');
    await page.fill('#addr', ADDR);
    check((await text(page, '#cmd')).endsWith(ADDR), 'the setup line carries the address', await text(page, '#cmd'));
    await page.waitForFunction(() => document.querySelector('#today').textContent.includes('4 proofs'));
    check((await text(page, '#pays')).includes('0.2 TAC a proof'), 'what a proof pays is read from the services', await text(page, '#pays'));
    check((await text(page, '#paid')) === '6 TAC credited', 'what was paid', await text(page, '#paid'));
    await shot(page, 'mine-none');
    // the prover appears (the line was pasted): the page sees it on its own
    local.v = { mine: { miner: null, on: false, job: null, proved: 0 } };
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Paused', null, { timeout: 8000 });
    check(!(await page.locator('#setup').isVisible()), 'once it answers, the setup line goes');
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }
  // an older prover: no GET /mine
  {
    const { page, ctx } = await open(browser, { v: { mine: null } });
    await page.waitForFunction(() => document.querySelector('#title').textContent.startsWith('Update'));
    check(await page.locator('#setup').isVisible(), 'an older prover is shown the setup line to update');
    await ctx.close();
  }
  // paused, then started from the button, then a proof under way, then paused mid-proof
  {
    const local = { v: { mine: { miner: ADDR, on: false, job: null, proved: 0 } } };
    const { page, ctx, errors, posts } = await open(browser, local);
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Paused');
    check((await page.inputValue('#addr')).toLowerCase() === ADDR, 'the prover\'s own address fills the field');
    check((await text(page, '#go')) === 'Start proving', 'paused: the button starts');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Waiting for the next proof');
    check(posts.length === 1 && posts[0].on === true && posts[0].miner.toLowerCase() === ADDR, 'Start sends on with the address', JSON.stringify(posts));
    local.v.mine = { ...local.v.mine, job: { id: 'j1', secs: 120, stage: 'shrink', eta: 360 }, proved: 2 };
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Proving');
    const st = await text(page, '#stage'), w = await page.locator('#bar i').evaluate((e) => e.style.width);
    check(st === 'Compressing · about 6 min left', 'proving: the stage and the time left', st);
    check(parseFloat(w) === 25, 'proving: the bar is a quarter along', w);
    check((await text(page, '#run')) === '2', 'proofs since it started', await text(page, '#run'));
    await shot(page, 'mine-proving');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Pausing after this proof');
    check(posts[1]?.on === false, 'Pause sends off', JSON.stringify(posts));
    check((await text(page, '#say')).includes('after the proof under way'), 'pausing mid-proof says it finishes that one', await text(page, '#say'));
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }
  // start with no address: refused in words, nothing sent
  {
    const { page, ctx, posts } = await open(browser, { v: { mine: { miner: null, on: false, job: null, proved: 0 } } });
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Paused');
    await page.click('#go');
    check(posts.length === 0 && (await text(page, '#say')).includes('Enter the address'), 'Start without an address asks for one');
    await ctx.close();
  }
  // a phone
  {
    const { page, ctx } = await open(browser, { v: null }, { phone: true });
    check(await page.locator('#phone').isVisible() && !(await page.locator('#desk').isVisible()), 'a phone is told to open it on a computer');
    const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    check(!over, 'no sideways scroll on a phone');
    await shot(page, 'mine-phone');
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
