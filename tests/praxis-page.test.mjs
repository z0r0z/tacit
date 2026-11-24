#!/usr/bin/env node
// The Tacit Praxis ceremony page (dapp/praxis/) in a real browser, under its own CSP. The page, its script and dapp/praxis/transcript.json are the
// real files; a changed transcript is served by the test where a case needs one. Nothing leaves the machine.
//   checks: the title and the hero, the chain (Succinct's 18 and the contributions here, the head), each receipt listed with its signature checked
//   against the coordinator's key (and a changed receipt or a broken link said as such), the copy buttons, the share link, a transcript that
//   cannot be read, a phone width with no sideways scroll, and the dark scheme.
//
//   node tests/praxis-page.test.mjs        (SHOTS=<dir> saves screenshots; PLAYWRIGHT=<path to playwright-core>)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const T = JSON.parse(readFileSync(join(DAPP, 'praxis/transcript.json'), 'utf8'));
const R18 = T.receipts.find((r) => r.index === 18);
const KEY = 'c22b59ae8acf7a1c2b78c4da8cfd2a3e7a21f2d2809a4d35e3a71e0fd2052eb7';

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

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const b = await chromium.launch();
const text = async (page, sel) => ((await page.innerText(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const SHOT = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

async function fresh({ viewport = { width: 1280, height: 900 }, scheme = 'light', transcript, live } = {}) {
  const ctx = await b.newContext({ viewport, colorScheme: scheme });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  const errs = [], csp = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 200)); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  if (live !== undefined) await page.route('https://tacit-praxis-ceremony.onrender.com/api/transcript', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(live) }));
  if (transcript !== undefined) await page.route(/\/praxis\/transcript\.json/, (route) => (transcript === 404 ? route.fulfill({ status: 404, body: 'not found' }) : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(transcript) })));
  await page.goto(`${BASE}/praxis/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !/Reading the transcript/.test(document.querySelector('#receipts').textContent), null, { timeout: 20000 });
  await page.waitForFunction(() => ![...document.querySelectorAll('.sig')].some((s) => /checking/.test(s.textContent)), null, { timeout: 10000 });
  return { ctx, page, errs, csp };
}

console.log('the page, the chain and the receipts');
{
  const { ctx, page, errs, csp } = await fresh();
  ok((await page.title()) === 'tacit praxis', `the title is "tacit praxis" (${await page.title()})`);
  ok(/Tacit Praxis ceremony/.test(await text(page, 'h1')) && /SP1 verifier/.test(await text(page, '.hero .sub')) && /one contributor/.test(await text(page, '.hero .sub')), 'the heading and one line on what it secures');
  ok(await page.$('header.top .sn') && await page.$('footer.sf'), 'the site header and footer are stamped in');
  const dots = await page.$$eval('#strip .dot', (ds) => [ds.filter((d) => !d.classList.contains('ours')).length, ds.filter((d) => d.classList.contains('ours')).length]);
  ok(dots[0] === 18 && dots[1] === T.receipts.length, `the strip: 18 of Succinct's, then ${T.receipts.length} here (${dots})`);
  ok((await text(page, '#n-total')) === String(18 + T.receipts.length) && (await text(page, '#n-ours')) === String(T.receipts.length), 'the tally counts both');
  const head = await text(page, '#head');
  ok(head.includes(`phase2-${T.head_index}`) && head.includes(`${T.head_sha256.slice(0, 8)}…${T.head_sha256.slice(-8)}`), `the head (${head})`);
  ok(/Open for contributions/.test(await text(page, '#state')), 'the status');
  const rows = await page.$$('#receipts li.rc');
  ok(rows.length === T.receipts.length, `each receipt in transcript.json is listed (${rows.length})`);
  const row = await text(page, '#receipts li.rc:last-child');
  ok(/#18/.test(row) && /Tacit/.test(row) && /@tacitfinance/.test(row) && row.includes(`${R18.contribution_hash.slice(0, 8)}…${R18.contribution_hash.slice(-8)}`) && /24 Nov 2026, 12:41 UTC/.test(row), `#18: name, handle, short hash and time (${row})`);
  ok(/signed by the coordinator/.test(row) && (await page.$eval('#receipts li.rc:last-child .sig', (e) => e.classList.contains('ok'))), 'its signature checks against the coordinator key');
  ok(/continues the file before it/.test(await text(page, '#link')), 'the receipts link from phase2-17 to the head');
  ok((await page.getAttribute('#live', 'href')) === 'http://143.55.45.86:53874/api/transcript', 'the live transcript is linked');
  ok((await page.$$eval('[data-head]', (s) => s.map((x) => x.textContent))).every((t) => t === String(T.head_index)), 'the verify commands run to the head');

  console.log('copy buttons');
  await page.click('#receipts li.rc:last-child .cp');
  ok((await page.evaluate(() => navigator.clipboard.readText())) === R18.contribution_hash && /Copied/.test(await text(page, '#receipts li.rc:last-child .cp')), 'a receipt\'s copy button copies its whole contribution hash');
  const cmds = await page.$$('.cmd');
  ok(cmds.length >= 5 && (await page.$$('.cmd .cp')).length === cmds.length, `every command has a copy button (${cmds.length})`);
  await page.locator('#join .cmd').nth(1).locator('.cp').click();
  const contrib = await page.evaluate(() => navigator.clipboard.readText());
  ok(contrib === './tacit-ceremony contribute \\\n  --coordinator http://143.55.45.86:53874 \\\n  --name "<your name>" --handle @you', `the contribute command copies as typed (${JSON.stringify(contrib)})`);
  await page.locator('#join .cmd').nth(0).locator('.cp').click();
  ok((await page.evaluate(() => navigator.clipboard.readText())) === 'git clone https://github.com/z0r0z/tacit\ncd tacit/ceremony-phase2\ngo build -o tacit-ceremony ./cmd/tacit-ceremony', 'the build commands copy as typed');
  await page.locator('#verify .cmd').nth(0).locator('.cp').click();
  ok((await page.evaluate(() => navigator.clipboard.readText())) === `for n in $(seq 17 ${T.head_index}); do\n  curl -fO http://143.55.45.86:53874/f/phase2-$n\ndone\nshasum -a 256 phase2-*`, 'the download copies with the head');
  await page.locator('#verify .cmd').nth(2).locator('.cp').click();
  ok((await page.evaluate(() => navigator.clipboard.readText())) === `./tacit-ceremony verify-chain . 17 ${T.head_index}`, 'the chain check copies with the head');
  await page.locator('#head .cp').click();
  ok((await page.evaluate(() => navigator.clipboard.readText())) === T.head_sha256, 'the head copies whole');
  const fixed = await text(page, '.fixed');
  ok(fixed.includes('d6a66be2702206e2b1a20bebf7096142864feac9e399a309e5e6e00353264cbc') && fixed.includes('bf6f7799c77a90009ae356fd0d3a69a91cf153825e6762ce344fe804cf5db2df') && fixed.includes(KEY) && /drand round 1000/.test(fixed) && /drand round and a Bitcoin block/.test(fixed), 'the fixed values: circuit, starting file, coordinator key, both seals');
  ok(/protects nothing|Nothing yet/.test(await text(page, '#honest')) && /recursion and wrap circuits/.test(await text(page, '#honest')), 'the note on what it protects today');
  const cr = await text(page, '#credits');
  ok(/Succinct/.test(cr) && /18 contributors/.test(cr) && /Perpetual Powers of Tau/.test(cr) && /Hermez/.test(cr) && /Worldcoin/.test(cr) && /zkbnb-setup/.test(cr) && /gnark/.test(cr) && /Tse, Vanjani and Vesely/.test(cr) && /not part of this ceremony/.test(cr), 'the credits');

  console.log('the share link');
  ok((await page.getAttribute('#share-go', 'aria-disabled')) === 'true' && !(await page.getAttribute('#share-go', 'href')), 'no link before a hash is pasted');
  await page.fill('#share-hash', 'abc');
  ok((await page.getAttribute('#share-go', 'aria-disabled')) === 'true' && /64 hex/.test(await text(page, '#share-hint')), 'a short hash is refused, and said why');
  await page.fill('#share-hash', ` 0x${R18.contribution_hash.toUpperCase()} `);
  const href = await page.getAttribute('#share-go', 'href');
  const u = new URL(href);
  ok(u.origin === 'https://twitter.com' && u.pathname === '/intent/tweet' && u.searchParams.get('url') === 'https://tacit.finance/praxis/' && u.searchParams.get('text').includes(R18.contribution_hash) && /Tacit Praxis ceremony/.test(u.searchParams.get('text')), `the X post carries the hash and the page (${href.slice(0, 120)}…)`);
  ok((await page.getAttribute('#share-go', 'aria-disabled')) === null && (await page.getAttribute('#share-go', 'target')) === '_blank' && /noopener/.test(await page.getAttribute('#share-go', 'rel')), 'it opens in a new tab');
  ok(/That is contribution #18, by Tacit/.test(await text(page, '#share-hint')), 'a listed hash is named');
  await page.fill('#share-hash', 'ab'.repeat(32));
  ok(/^https:\/\/twitter\.com\/intent\/tweet\?/.test(await page.getAttribute('#share-go', 'href')) && /Not in this page's copy/.test(await text(page, '#share-hint')), 'an unlisted hash still shares, with a word that the copy may be behind');
  await SHOT(page, 'desktop-light');
  ok(!errs.length, `no page errors (${errs.join(' | ')})`);
  ok(!csp.length, `no CSP errors (${csp.join(' | ')})`);
  await ctx.close();
}

console.log('a receipt that was changed, and a chain that does not link');
{
  const changed = structuredClone(T);
  changed.receipts[0].name = 'Someone else';
  changed.receipts[0].prev_file_sha256 = '00'.repeat(32);
  const { ctx, page, errs } = await fresh({ transcript: changed });
  ok(/signature does not match/.test(await text(page, '#receipts')), 'a changed receipt does not pass the signature check');
  ok(/does not continue/.test(await text(page, '#link')), 'a broken link is said');
  ok(!errs.length, 'no page errors');
  await ctx.close();
}

console.log('a transcript that cannot be read');
{
  const { ctx, page, errs } = await fresh({ transcript: 404 });
  ok(/could not be read/.test(await text(page, '#receipts')), 'the list says so');
  ok(/Share/.test(await text(page, '#join')) && (await page.$$('.cmd .cp')).length >= 5, 'the commands and the share field still work');
  ok(!errs.length, 'no page errors');
  await ctx.close();
}

console.log('a phone, light and dark; the desktop dark');
for (const scheme of ['light', 'dark']) {
  const { ctx, page, errs, csp } = await fresh({ viewport: { width: 390, height: 844 }, scheme });
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth]);
  ok(w[0] <= w[2] && w[1] <= w[2], `no sideways scroll at 390 px, ${scheme} (${w})`);
  const wide = await page.$$eval('main *', (es) => es.filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5 && !e.closest('pre')).map((e) => e.tagName + '.' + e.className).slice(0, 5));
  ok(!wide.length, `nothing reaches past the right edge (${wide})`);
  if (scheme === 'dark') {
    const [bg, ink] = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.panel')).color].map((c) => (c.match(/\d+/g) || []).slice(0, 3).map(Number).reduce((a, x) => a + x, 0)));
    ok(bg < 120 && ink > 500, `the dark scheme: dark ground, light ink (${bg}, ${ink})`);
  }
  ok(!errs.length && !csp.length, `no page or CSP errors (${[...errs, ...csp].join(' | ')})`);
  await SHOT(page, `phone-${scheme}`);
  await ctx.close();
}
{
  const { ctx, page } = await fresh({ scheme: 'dark' });
  await SHOT(page, 'desktop-dark');
  await ctx.close();
}

// the live transcript through the ceremony's HTTPS window, when it answers
{
  const t = JSON.parse(readFileSync(new URL('../dapp/praxis/transcript.json', import.meta.url), 'utf8'));
  const { ctx, page, errs, csp } = await fresh({ live: t });
  ok(/Read live from the coordinator/.test(await page.textContent('#src')), 'the page says it read the transcript live');
  ok(/signed by the coordinator/.test(await page.textContent('#receipts')), 'and still checks each receipt against the coordinator key');
  ok(!errs.length && !csp.length, `the live read raises no page or CSP errors (${[...errs, ...csp].join(' | ')})`);
  await ctx.close();
}

await b.close();
server.close();
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
