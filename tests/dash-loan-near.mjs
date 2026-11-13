#!/usr/bin/env node
// A cUSD loan near its liquidation line, as the front page tells it (dapp/index.html dashLoans, the Your Tacit note, and the background watch), in a real
// browser with a pasted key. The page's own code runs; only what it reads from outside is put in its place, through a hook this test appends to a copy of the
// page's module (served without its CSP, which hashes that module): the loans the key holds, the price of a bitcoin, the engine's ratios, and the chain reads
// the watch makes. Notification and document.hidden are stand-ins so a background tab can be told and one in front cannot.
//   · the note under "Your Tacit": a loan under the line can be liquidated now, one a few percent above it says how far bitcoin must fall, a loan further off
//     keeps the old wording, a safe loan has no note;
//   · the watch (every five minutes, a tab in the background, notifications on): told once when a loan comes near, not again while it stays, again after it
//     has gone clear and comes back; silent with the tab in front or notifications off.
//
//   PLAYWRIGHT=/Users/z/tacit/node_modules/playwright-core node tests/dash-loan-near.mjs      (DAPP=<dir> to try another build)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/tacit/node_modules/playwright-core');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const PORT = 33000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

// the page with a hook into its module (and no CSP: the module's hash no longer matches)
let PAGE = readFileSync(join(DAPP, 'index.html'), 'utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
const at = PAGE.indexOf('const store = {'), end = PAGE.indexOf('</script>', at);
if (at < 0 || end < 0 || !/const getUx = lazy\(/.test(PAGE)) { console.log('FAIL   the page has the names this test hooks into'); process.exit(1); }
PAGE = PAGE.slice(0, end) + `\n;globalThis.__t = { S, P, LOANS, TPX, HXR, LOCK, dashLoans, dashSoon, hxBwView, stub: (o) => { if (o.cdpLoans) cdpLoans = o.cdpLoans; if (o.loadTacPrice) loadTacPrice = o.loadTacPrice; if (o.getUx) getUx = o.getUx; } };\n` + PAGE.slice(end);
PAGE = PAGE.replace('const getUx = lazy(', 'let getUx = lazy(');

const KEY = '11'.repeat(31) + '22', CB = 'cb'.repeat(32), NOTIFY = 'tacit-lite-notify-v1';
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1300 }, serviceWorkers: 'block' });
await ctx.addInitScript(() => {
  // the watch's timer is kept to be run by hand; Notification records what it is asked to show; document.hidden is a switch
  const real = window.setInterval;
  window.__timers = [];
  window.setInterval = (f, ms, ...a) => { if (ms === 300000) window.__timers.push(f); return real(f, ms, ...a); };
  window.__notes = [];
  window.Notification = class { constructor(title, o) { window.__notes.push({ title, body: o?.body, tag: o?.tag }); } close() {} };
  window.Notification.permission = 'granted'; window.Notification.requestPermission = async () => 'granted';
  window.__hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
});
await ctx.route('**/*', (r) => {
  const u = r.request().url();
  if (u.startsWith(BASE)) {
    if (new URL(u).pathname === '/') return r.fulfill({ status: 200, headers: { 'content-type': TYPES['.html'], 'cache-control': 'no-store' }, body: PAGE });
    return r.continue();
  }
  return r.abort();
});
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(process.env.DEBUG ? String(e.stack || e.message) : String(e.message || e)));

try {
  await page.goto(BASE + '/', { waitUntil: 'commit' });
  await page.waitForSelector('#wallet', { timeout: 30000 });
  await page.click('#wallet');
  await page.waitForSelector('#ws-in', { timeout: 15000 });
  await page.click('#ws-in [data-in="paste"]');
  await page.fill('#ws-hex', KEY);
  await page.click('#ws-in [data-in="key"]');
  await page.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
  await page.keyboard.press('Escape');
  ok(await page.evaluate(() => !!globalThis.__t?.S.key), 'the key is open and the hook reaches the page');

  // 0.002 cBTC against 110 cUSD (the loan in the 11-12 liquidation), the engine at a 150% floor and a 130% line; `px` is what a bitcoin costs
  await page.evaluate(([cb]) => {
    const t = globalThis.__t, pub = t.S.key.pubHex;
    // what a scan of a key with only this loan returns (the rows read `.value` of each of these)
    t.P.scan = { eth: { value: 0n, notes: [] }, tac: { value: 0n, notes: [] }, cbtc: { id: cb, value: 0n, notes: [] }, cusd: { value: 11000000000n, notes: [] }, cusdt: { value: 0n, notes: [] }, others: [] };
    Object.assign(t.LOANS, { pub, at: Date.now(), p: null, v: { positions: [{ live: true, debtValue: '11000000000', basket: [{ asset: cb, value: '200000' }] }] } });
    t.HXR.ratio = 150; t.HXR.liq = 130; t.LOCK.state = null;
    t.stub({ cdpLoans: async () => t.LOANS.v, getUx: async () => ({}), loadTacPrice: async () => { t.TPX.v = { ...(t.TPX.v || {}), usdBtc: window.__px, ethBtc: 0.03, mid: 0.0001 }; t.TPX.at = Date.now(); } });
  }, [CB]);
  const setPx = (px) => page.evaluate((p) => { const t = globalThis.__t; window.__px = p; t.TPX.v = { ...(t.TPX.v || {}), usdBtc: p, ethBtc: 0.03, mid: 0.0001 }; t.TPX.at = Date.now(); }, px);
  const loan = () => page.evaluate(() => { const [x] = globalThis.__t.dashLoans() || []; return x ? { ratio: x.ratio, fall: x.fall, near: x.near } : null; });
  const note = async () => {
    await page.evaluate(() => globalThis.__t.dashSoon());
    await page.waitForTimeout(300);
    return page.$eval('#dash-due', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  };

  // the note under Your Tacit
  await setPx(71482.1);
  let l = await loan();
  ok(l && Math.abs(l.ratio - 129.97) < 0.01 && l.fall === 0 && l.near, `at $71,482 the loan is at ${l?.ratio}%, under the line`);
  let t = await note();
  ok(/A loan of 110(\.00)? cUSD stands at 129%, under the 130% line: it can be liquidated now\. Repay it\./.test(t), `it says it can be liquidated now (and 129.97% is not rounded up to the line): ${t.slice(0, 160)}`);
  await setPx(74000);
  l = await loan();
  ok(l.near && Math.abs(l.fall - 3.38) < 0.01, `at $74,000 it is near: ${l.ratio.toFixed(1)}%, bitcoin 3.4% from the line`);
  t = await note();
  ok(/stands at 134%, and bitcoin falling 3% liquidates it\. Repay it\./.test(t), `it says how far bitcoin must fall, rounded down: ${t.slice(0, 160)}`);
  await setPx(71600);
  t = await note();
  ok(/bitcoin falling less than 1% liquidates it/.test(t), `a loan a hair above the line says less than 1%: ${t.slice(0, 160)}`);
  await setPx(90000);
  l = await loan();
  t = await note();
  ok(!l.near && /stands at 164%; liquidation starts at 130%\. Repay it before BTC falls further\./.test(t), `a loan under 175% but not near keeps the old note: ${t.slice(0, 160)}`);
  await setPx(120000);
  t = await note();
  ok(!/A loan of/.test(t), 'a safe loan has no note');

  // the Borrow sheet's sentence about a loan: hxBwView draws the panel from the lock's state (a loan being chosen, one borrowed, one under the line)
  const view = (st) => page.evaluate((s) => { const d = document.createElement('div'); d.innerHTML = globalThis.__t.hxBwView(s).s; return d.textContent.replace(/\s+/g, ' ').trim(); }, st);
  const lock = { rec: { vBtc: '200000', lockTxid: 'aa'.repeat(32), lockVout: 0 }, minted: true, bonded: true, ratio: 15000n, liq: 13000n };
  let v = await view({ ...lock, usd: 14800000000n });
  ok(/Collateral ratio 200%; liquidation starts at 130% \(bitcoin 35% lower\)\./.test(v), `choosing a loan: how far bitcoin must fall to the line (${v.match(/Collateral ratio[^.]*\./)?.[0]})`);
  v = await view({ ...lock, usd: 14800000000n, borrowed: 11000000000n });
  ok(/Borrowed 110(\.00)? cUSD\. Collateral ratio 134%; liquidation starts at 130% \(bitcoin 3% lower\)\./.test(v), `a loan borrowed: the same (${v.match(/Borrowed.*?\./g)?.slice(0, 2).join(' ')})`);
  v = await view({ ...lock, usd: 14296420000n, borrowed: 11000000000n });
  ok(/Collateral ratio 129%; it can be liquidated now \(the line is 130%\)\./.test(v), `a loan under the line says so, and 129.96% is not shown as 130% (${v.match(/Collateral ratio[^.]*\.[^.]*\./)?.[0]})`);

  // the watch: the timer the page registered at five minutes
  const run = async () => { await page.evaluate(async () => { const f = window.__timers.find((g) => String(g).includes('LOANW')); if (!f) throw new Error('no watch timer'); await f(); }); await page.waitForTimeout(100); };
  const notes = () => page.evaluate(() => window.__notes.slice());
  await page.evaluate(() => { window.__hidden = false; });
  await setPx(74000); await run();
  ok((await notes()).length === 0, 'with the tab in front it tells nothing (the note is on the page)');
  await page.evaluate(() => { window.__hidden = true; });
  await run();
  ok((await notes()).length === 0, 'with notifications off it tells nothing');
  await page.evaluate((k) => localStorage.setItem(k, 'true'), NOTIFY);
  await run();
  let got = await notes();
  ok(got.length === 1 && got[0].title === 'A loan is close to liquidation' && /^110(\.00)? cUSD at 134%: bitcoin falling 3% liquidates it\. Repay it\.$/.test(got[0].body) && /^loan-near:11000000000:200000$/.test(got[0].tag), `a background tab is told once: ${JSON.stringify(got[0])}`);
  await run(); await run();
  ok((await notes()).length === 1, 'and not again while it stays near');
  await setPx(90000); await run();
  ok((await notes()).length === 1 && JSON.stringify(await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('tacit-loan-near-v1:')).map(([, v]) => JSON.parse(v)))) === '[[]]', 'once it is well clear it is forgotten');
  await setPx(74000); await run();
  ok((await notes()).length === 2, 'and told again when it comes near again');
  await setPx(71482.1); await page.evaluate(() => { globalThis.__t.TPX.at = 0; }); await run();
  ok((await notes()).length === 2, 'a loan already told about is not told again when it falls under the line');
  await page.evaluate((k) => { localStorage.setItem(k, 'true'); Object.keys(localStorage).filter((x) => x.startsWith('tacit-loan-near-v1:')).forEach((x) => localStorage.removeItem(x)); }, NOTIFY);
  await run();
  got = await notes();
  ok(got.length === 3 && /cUSD at 129%: it can be liquidated now\. Repay it\.$/.test(got[2].body), `under the line it says so: ${got[2]?.body}`);

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n'));
  if (errors.length) console.log('page errors: ' + errors.slice(0, 3).join(' | '));
} finally {
  await browser.close(); server.close();
}
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
