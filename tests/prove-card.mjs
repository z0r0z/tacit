#!/usr/bin/env node
// The keeper page's "Prove wraps for points" card (dapp/weld/keeper/index.html, dapp/community-prove.js): the command that installs tacit-prover for the
// address in the field, what the pool and the points service say mining pays, and what an address has been credited. Every request to another host is
// answered here (the pool, the points service) or refused, so nothing leaves the machine.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/prove-card.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const PORT = 31000 + Math.floor(Math.random() * 900);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.sh': 'text/plain' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_ = `http://127.0.0.1:${PORT}/weld/keeper/`;
const ADDR = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const WALLET = '0x1111111111111111111111111111111111111111';
const POOL = { queued: 2, leased: 0, doneToday: 23, minersToday: 1, top: [{ miner: '0x2222222222222222222222222222222222222222', proofs: 4 }], terms: { pointsPerProof: 20, proofsPerMinerDay: 30, leaseMs: 2700000 } };
const TALLY = { day: 0, over: false, pointsPerProof: 20, miners: [{ miner: ADDR.toLowerCase(), proofs: 2, points: 40 }] };
const MINE = { enabled: true, endSec: 1795478400, terms: { fromDay: 20751, dailyWei: '50000000000000000000', capWeiPerPoint: '10000000000000000' }, next: { fromDay: 20781, off: true } };

const ctxOptions = (phone) => ({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
// Routes the two services; `asked` collects the points service's requests. `pool` / `mine`: a status (404, 500) or 'abort' for a request that fails.
async function route(ctx, { pool = POOL, mine = MINE, tally = TALLY, asked = [] } = {}) {
  const json = (body) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), async (r) => {
    const u = new URL(r.request().url());
    if (u.host === 'api.tacit.finance' && u.pathname === '/prover/pool') {
      if (pool === 'abort') return r.abort();
      return typeof pool === 'number' ? r.fulfill({ status: pool, body: '' }) : r.fulfill(json(pool));
    }
    if (u.host === 'api.tacit.finance' && u.pathname === '/prover/pool/credits') {
      asked.push(`credits?day=${u.searchParams.get('day')}`);
      return tally === 'abort' ? r.abort() : r.fulfill(json(tally));
    }
    if (u.host === 'tacit-points.onrender.com' && u.pathname === '/mine') {
      asked.push(u.search);
      if (mine === 'abort') return r.abort();
      const a = u.searchParams.get('address');
      return r.fulfill(json(a ? { ...mine, account: { address: a, creditedWei: '6200000000000000000' } } : mine));
    }
    return r.abort();
  });
  return asked;
}

const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());
const box = (page) => text(page, '#mine-box');
const cmd = (page) => text(page, '#mine-cmd');
const tell = (page) => page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' | '));

const browser = await chromium.launch();
try {
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'desktop';
    const ctx = await browser.newContext(ctxOptions(phone));
    const asked = await route(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL_, { waitUntil: 'commit' });
    await page.waitForFunction(() => /wraps? waiting/.test(document.querySelector('#mine-box')?.textContent || ''), null, { timeout: 60000 });
    await page.waitForFunction(() => /a proof/.test(document.querySelector('#mine-box')?.textContent || ''), null, { timeout: 30000 });

    ok(/^2 wraps waiting · 23 proved today by 1 prover/.test(await box(page)), `${tag}: the pool's day is read`);
    ok((await box(page)).includes('Up to 0.2 TAC a proof, 30 proofs a day, until 24 Nov'), `${tag}: what a proof pays comes from the service's terms`);
    ok(!(await box(page)).includes('credited') && !(await box(page)).includes('today ·') && !asked.some((q) => q.startsWith('credits')), `${tag}: no address, nothing about one is said or asked`);
    ok(/Most today: 0x2222…2222 4/.test(await box(page)), `${tag}: the most today are listed`);
    ok((await cmd(page)) === 'curl -fsSL https://tacit.finance/prove.sh | sh -s -- 0xYourAddress', `${tag}: the command carries a placeholder until there is an address`);
    ok((await page.$eval('#mine-help', (e) => e.textContent)).includes('6.2 GB'), `${tag}: the line under it says what the first proof costs`);
    ok(!(await page.$eval('#g-mine', (e) => e.hidden)), `${tag}: the section is shown`);

    // A press with no address says what is missing and puts the cursor there.
    await page.click('#mine-copy');
    ok((await tell(page)).includes('Enter the address the points should go to.'), `${tag}: Copy with no address asks for it`);
    ok(await page.$eval('#mine-addr', (e) => e === document.activeElement), `${tag}: ...and puts the cursor in the field`);

    // A mistyped address marks the field and changes nothing.
    await page.fill('#mine-addr', '0xYourAddress');
    ok((await page.getAttribute('#mine-addr', 'aria-invalid')) === 'true', `${tag}: a mistyped address marks the field`);
    ok((await cmd(page)).endsWith('0xYourAddress'), `${tag}: ...and the command stays a placeholder`);
    const before = asked.length;

    // A real one (mixed case, as a wallet shows it) fills the command and reads what it has been credited.
    await page.fill('#mine-addr', `  ${ADDR}  `);
    await page.waitForFunction(() => /credited/.test(document.querySelector('#mine-box')?.textContent || ''), null, { timeout: 15000 });
    ok((await page.getAttribute('#mine-addr', 'aria-invalid')) === 'false', `${tag}: a good address clears the mark`);
    ok((await cmd(page)) === `curl -fsSL https://tacit.finance/prove.sh | sh -s -- ${ADDR}`, `${tag}: the command carries the address`);
    ok((await box(page)).includes('2 proofs, 40 points today · 6.2 TAC credited'), `${tag}: what the address made today and has been credited is shown`);
    ok(asked.slice(before).includes(`credits?day=${Math.floor(Date.now() / 86400000)}`), `${tag}: the pool's tally is asked for today's UTC day`);
    ok(asked.slice(before).includes(`?address=${ADDR.toLowerCase()}`), `${tag}: the points service was asked for that address, in lower case`);

    await page.click('#mine-copy');
    ok((await page.evaluate(() => navigator.clipboard.readText())) === `curl -fsSL https://tacit.finance/prove.sh | sh -s -- ${ADDR}`, `${tag}: Copy puts the command on the clipboard`);
    ok((await tell(page)).includes('Copied.'), `${tag}: ...and says so`);

    // Check and removal are under a fold.
    ok(!(await page.$eval('details.more', (d) => d.open)), `${tag}: the check and removal commands are folded`);
    await page.click('details.more summary');
    ok((await text(page, '#mine-more')).includes('--status') && (await text(page, '#mine-more')).includes('--uninstall'), `${tag}: ...and show --status and --uninstall`);

    // The address is kept in this browser.
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => /wraps? waiting/.test(document.querySelector('#mine-box')?.textContent || ''), null, { timeout: 60000 });
    ok((await page.inputValue('#mine-addr')) === ADDR, `${tag}: a reload keeps the address`);
    ok((await cmd(page)).endsWith(ADDR), `${tag}: ...and its command`);

    // Nothing runs off the side of a phone.
    ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth), `${tag}: the page does not scroll sideways`);
    ok(await page.$eval('#g-mine pre.cmd', (e) => e.scrollWidth <= e.clientWidth), `${tag}: the whole command is shown, wrapped, not cut off`);
    ok(errors.length === 0, `${tag}: no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
    await ctx.close();
  }

  // A connected wallet fills an empty field, and never one the person has typed in.
  {
    const ctx = await browser.newContext(ctxOptions(false));
    await route(ctx);
    await ctx.addInitScript((account) => {
      window.ethereum = {
        isMetaMask: true,
        request: async ({ method }) => ({ eth_requestAccounts: [account], eth_accounts: [account], eth_chainId: '0x1', net_version: '1' }[method] ?? null),
        on() {}, removeListener() {},
      };
    }, WALLET);
    const page = await ctx.newPage();
    await page.goto(URL_, { waitUntil: 'commit' });
    await page.waitForSelector('#mine-addr', { timeout: 60000 });
    await page.click('#wallet');
    await page.waitForFunction((w) => document.querySelector('#mine-addr')?.value === w, WALLET, { timeout: 15000 }).catch(() => {});
    ok((await page.inputValue('#mine-addr')) === WALLET, 'wallet: the connected account fills an empty field');
    ok((await cmd(page)).endsWith(WALLET), 'wallet: ...and the command');
    await ctx.close();

    const ctx2 = await browser.newContext(ctxOptions(false));
    await route(ctx2);
    await ctx2.addInitScript((account) => {
      window.ethereum = { isMetaMask: true, request: async ({ method }) => ({ eth_requestAccounts: [account], eth_accounts: [account], eth_chainId: '0x1', net_version: '1' }[method] ?? null), on() {}, removeListener() {} };
    }, WALLET);
    const p2 = await ctx2.newPage();
    await p2.goto(URL_, { waitUntil: 'commit' });
    await p2.waitForSelector('#mine-addr', { timeout: 60000 });
    await p2.fill('#mine-addr', ADDR);
    await p2.click('#wallet');
    await sleep(1500);
    ok((await p2.inputValue('#mine-addr')) === ADDR, 'wallet: an address already typed is left alone');
    await ctx2.close();
  }

  // The services failing: the pool's figures stand without the points service, and a pool the API lacks leaves the section out.
  {
    const ctx = await browser.newContext(ctxOptions(false));
    await route(ctx, { mine: 'abort' });
    const page = await ctx.newPage();
    await page.goto(URL_, { waitUntil: 'commit' });
    await page.waitForFunction(() => /wraps? waiting/.test(document.querySelector('#mine-box')?.textContent || ''), null, { timeout: 60000 });
    await sleep(500);
    ok(!(await box(page)).includes('a proof,') && (await box(page)).includes('23 proved today'), 'points service down: the pool is shown and no pay is promised');
    ok((await cmd(page)).includes('prove.sh'), 'points service down: the command is still there');
    await ctx.close();

    const ctx2 = await browser.newContext(ctxOptions(false));
    await route(ctx2, { pool: 404 });
    const p2 = await ctx2.newPage();
    await p2.goto(URL_, { waitUntil: 'commit' });
    await p2.waitForFunction(() => document.querySelector('#g-mine')?.hidden === true, null, { timeout: 60000 });
    ok(true, 'an API without the pool leaves the section out');
    await ctx2.close();

    const ctx3 = await browser.newContext(ctxOptions(false));
    await route(ctx3, { pool: 'abort' });
    const p3 = await ctx3.newPage();
    await p3.goto(URL_, { waitUntil: 'commit' });
    await p3.waitForFunction(() => /Could not read the proof pool/.test(document.querySelector('#mine-box')?.textContent || ''), null, { timeout: 60000 });
    ok(!(await p3.$eval('#g-mine', (e) => e.hidden)) && (await cmd(p3)).includes('prove.sh'), 'pool unreachable: it says so, and the command stays');
    await ctx3.close();

    // The tally down: what the address made today is left out and the rest stays.
    const ctx5 = await browser.newContext(ctxOptions(false));
    await route(ctx5, { tally: 'abort' });
    const p5 = await ctx5.newPage();
    await p5.addInitScript((a) => localStorage.setItem('tacit-prove-address', a), ADDR);
    await p5.goto(URL_, { waitUntil: 'commit' });
    await p5.waitForFunction(() => /credited/.test(document.querySelector('#mine-box')?.textContent || ''), null, { timeout: 60000 });
    ok(/6\.2 TAC credited/.test(await box(p5)) && !(await box(p5)).includes('today ·') && !(await box(p5)).includes('No proofs yet'), 'tally down: only what is known is said');
    await ctx5.close();

    // An address with no proofs yet today.
    const ctx6 = await browser.newContext(ctxOptions(false));
    await route(ctx6, { tally: { ...TALLY, miners: [] } });
    const p6 = await ctx6.newPage();
    await p6.addInitScript((a) => localStorage.setItem('tacit-prove-address', a), ADDR);
    await p6.goto(URL_, { waitUntil: 'commit' });
    await p6.waitForFunction(() => /credited/.test(document.querySelector('#mine-box')?.textContent || ''), null, { timeout: 60000 });
    ok((await box(p6)).includes('No proofs yet today · 6.2 TAC credited'), 'a new address: it says no proofs yet today');
    await ctx6.close();

    // Mining off or over: no pay is promised.
    const ctx4 = await browser.newContext(ctxOptions(false));
    await route(ctx4, { mine: { enabled: true, endSec: 1, terms: null } });
    const p4 = await ctx4.newPage();
    await p4.goto(URL_, { waitUntil: 'commit' });
    await p4.waitForFunction(() => /wraps? waiting/.test(document.querySelector('#mine-box')?.textContent || ''), null, { timeout: 60000 });
    await sleep(500);
    ok(!(await box(p4)).includes('TAC a proof'), 'mining over: no pay is promised');
    await ctx4.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${n} ok, ${fails} failed`);
process.exit(fails ? 1 : 0);
