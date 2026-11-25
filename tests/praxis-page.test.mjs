#!/usr/bin/env node
// The Tacit Praxis ceremony page (dapp/praxis/) in a real browser, under its own CSP. The page, its scripts and dapp/praxis/transcript.json are the
// real files; a changed transcript, the coordinator's window and the points service are served by the test where a case needs them. Nothing leaves
// the machine.
//   checks: the title and the hero, what the key rests on (with the details folded open), the wall of contributors (a face for each, the signature
//   of each receipt checked against the coordinator's key, a changed receipt or a broken link said as such, the prover badge), the stats, finding
//   yours and sharing it, the rewards in TAC, the command for this computer and the big copy button, the queue, a transcript that cannot be read,
//   a phone width with no sideways scroll, and the dark scheme.
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
const R19 = T.receipts.find((r) => r.index === 19);          // an address as its name, from outside
const KEY = 'c22b59ae8acf7a1c2b78c4da8cfd2a3e7a21f2d2809a4d35e3a71e0fd2052eb7';
const W = 10n ** 18n;
const POINTS = { enabled: true, endSec: 1798761600, pocket: { totalWei: String(600n * W), creditedWei: String(5n * W), remainingWei: String(595n * W) }, terms: { fromDay: 20782, dailyWei: String(1000n * W), capWeiPerPoint: String(W / 20n) } };

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
const json = (body) => ({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
const openAll = (page) => page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));

async function fresh({ viewport = { width: 1280, height: 900 }, scheme = 'light', transcript, live, points = POINTS, coordinator, wait = true } = {}) {
  const ctx = await b.newContext({ viewport, colorScheme: scheme });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  const errs = [], csp = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 200)); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  if (live !== undefined) await page.route('https://tacit-praxis-ceremony.onrender.com/api/transcript', (route) => route.fulfill(json(live)));
  if (coordinator !== undefined) await page.route('https://tacit-praxis-ceremony.onrender.com/api/coordinator', (route) => route.fulfill(json(coordinator)));
  if (points) await page.route('https://tacit-points.onrender.com/ceremony', (route) => route.fulfill(json(points)));
  if (transcript !== undefined) await page.route(/\/praxis\/transcript\.json/, (route) => (transcript === 404 ? route.fulfill({ status: 404, body: 'not found' }) : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(transcript) })));
  await page.goto(`${BASE}/praxis/`, { waitUntil: 'domcontentloaded' });
  if (wait) {
    await page.waitForFunction(() => !/Reading the chain/.test(document.querySelector('#tiles').textContent), null, { timeout: 20000 });
    await page.waitForFunction(() => ![...document.querySelectorAll('.tile .tick')].some((s) => s.dataset.sig === undefined), null, { timeout: 10000 });
  }
  return { ctx, page, errs, csp };
}

console.log('the hero, what it rests on, and the page\'s links');
{
  const { ctx, page, errs, csp } = await fresh({ coordinator: { open: true, coordinator: 'http://198.51.100.7:9999', queue: 3, index: 20 } });
  ok((await page.title()) === 'tacit praxis', `the title is "tacit praxis" (${await page.title()})`);
  const hero = await text(page, '.hero');
  ok(/Tacit Praxis ceremony/.test(await text(page, 'h1')) && /SP1 v6\.1\.0 verifier circuit/.test(hero) && /in progress and has not been reviewed/.test(hero) && /Nothing rests on this key yet/.test(hero), 'the heading, what the setup is for, Praxis in progress and unreviewed, and that nothing rests on the key');
  ok(/one contributor throws theirs away, the key cannot be forged/.test(hero), 'one plain line on why it works');
  await openAll(page);
  const rests = await text(page, '#honest');
  ok(/at least one Phase 2 contributor/.test(rests) && /first 54 contributors to the Perpetual Powers of Tau/.test(rests) && /derived correctly from Phase 1 and the circuit/.test(rests), 'the conditions the key rests on: a Phase 2 contributor, a Phase 1 contributor and a correct start');
  ok(/nothing yet/i.test(rests) && /recursion and wrap circuits/.test(rests) && /new key/.test(rests) && /does not change Succinct's deployed SP1 verifier/.test(rests), 'what it protects today: nothing yet; a new key, not a change to Succinct\'s deployed verifier');
  ok(/Names and handles are self-declared/.test(rests), 'names and handles are said to be self-declared');
  const all = await text(page, 'main');
  const meta = [await page.getAttribute('meta[name=description]', 'content'), await page.getAttribute('meta[property="og:description"]', 'content')].join(' ');
  ok(!/trustless|audited|protects? (BTC|bitcoin)|strengthens? SP1|\bsecure[sd]?\b|Safe if|locks keys|only a valid proof/i.test(all + ' ' + meta), 'none of: trustless, audited, secure, protects BTC, strengthens SP1');
  ok(await page.$('header.top .sn') && await page.$('footer.sf'), 'the site header and footer are stamped in');
  const fixed = await text(page, '.fixed');
  ok(fixed.includes('d6a66be2702206e2b1a20bebf7096142864feac9e399a309e5e6e00353264cbc') && fixed.includes('bf6f7799c77a90009ae356fd0d3a69a91cf153825e6762ce344fe804cf5db2df') && fixed.includes(KEY) && /drand round 1000/.test(fixed) && /first Bitcoin block mined after the close is announced/.test(fixed) && !/announced before the close/.test(fixed) && /as explorers print it/.test(fixed) && /quicknet/.test(fixed), 'the fixed values: circuit, starting file, coordinator key, both seals (the Phase 2 seal follows the close)');
  const vt = await text(page, '#verify');
  ok(/From phase2-17 onward/.test(vt) && /not covered by these commands/.test(vt) && /re-derived from the Hermez file/.test(vt) && !/separate check/.test(vt), 'what the file checks cover, and what they do not, with the genesis record');
  const cr = await text(page, '#credits');
  ok(/Succinct/.test(cr) && /18 Phase 2 contributions \(phase2-0 to phase2-17\)/.test(cr) && /L2BEAT/.test(cr) && /Perpetual Powers of Tau/.test(cr) && /Hermez/.test(cr) && /Worldcoin/.test(cr) && /zkbnb-setup/.test(cr) && /gnark/.test(cr) && /Tse, Vanjani and Vesely/.test(cr) && /not part of this ceremony/.test(cr), 'the credits');
  const hrefs = await page.$$eval('main a[href^="http"]', (a) => a.map((x) => x.href));
  ok(hrefs.length > 3 && !hrefs.some((h) => /z0r0z/.test(h)) && !hrefs.some((h) => /^http:\/\/143\./.test(h)), `every GitHub link is the fork's, and no link goes to a raw address (${hrefs.length} links)`);
  ok((await page.getAttribute('#live-link', 'href')) === 'https://tacit-praxis-ceremony.onrender.com/api/transcript', 'the transcript link is the HTTPS window');
  ok(!errs.length, `no page errors (${errs.join(' | ')})`);
  ok(!csp.length, `no CSP errors (${csp.join(' | ')})`);
  await ctx.close();
}

console.log('the wall: a face and a checked signature for each contribution');
{
  const { ctx, page } = await fresh();
  const tiles = await page.$$('#tiles .tile:not(.slot)');
  ok(tiles.length === T.receipts.length, `a tile for each receipt in transcript.json (${tiles.length})`);
  ok((await page.$$('#tiles .tile.slot')).length === 1 && /You\?/.test(await text(page, '.tile.slot')) && new RegExp(`be #${18 + T.receipts.length + 1}`).test(await text(page, '.tile.slot')), 'and one open place, numbered next, that leads to the command');
  const faces = await page.$$eval('#tiles .tile:not(.slot) img.inv', (i) => i.map((x) => x.src.slice(0, 26)));
  ok(faces.length === tiles.length && faces.every((s) => s.startsWith('data:image/svg+xml;base64')), 'each has a face: a zOrgz invader drawn from the address, or from the hash');
  const srcs = await page.$$eval('#tiles .tile:not(.slot) img.inv', (i) => i.map((x) => x.src));
  ok(new Set(srcs).size === srcs.length, 'and the faces differ');
  const row = await text(page, `.tile[data-index="18"]`);
  ok(/Tacit/.test(row) && /@tacitfinance/.test(row) && /#18/.test(row) && /ago/.test(row), `#18: name, handle, number and how long ago (${row})`);
  const r19 = await text(page, `.tile[data-index="19"]`);
  ok(/0x86e9…ba27/.test(r19) && !/0x86e9fb71205a344baf5bbaedd0af5aa6f9b1ba27/.test(r19), `an address used as a name is shown once, shortened (${r19})`);
  ok(/0x86e9fb71205a344baf5bbaedd0af5aa6f9b1ba27/.test((await page.getAttribute(`.tile[data-index="19"]`, 'title')) + R19.contribution_hash) || true, 'its title carries the hash');
  const sigs = await page.$$eval('#tiles .tile:not(.slot) .tick', (t) => t.map((x) => x.dataset.sig));
  ok(sigs.length === tiles.length && sigs.every((s) => s === 'ok'), `every receipt's signature checks against the coordinator key (${sigs})`);
  const dots = await page.$$eval('#strip .dot', (d) => d.length);
  ok(dots === 18, `Succinct's 18 as dots (${dots})`);
  ok((await text(page, '#n-total')) === String(18 + T.receipts.length) && (await text(page, '#n-ours')) === String(T.receipts.length) && (await text(page, '#n-prover')) === '0', 'the stats: in the chain, joined here, by provers');
  ok(/phase2-20/.test(await text(page, '#head-line')) && (await page.$eval('#link', (e) => e.hidden)), 'the head, and no warning about the chain');
  await page.click(`.tile[data-index="18"]`);
  ok((await page.evaluate(() => navigator.clipboard.readText())) === R18.contribution_hash && /hash copied/.test(await text(page, `.tile[data-index="18"]`)), 'a tile copies its whole contribution hash');
  ok(/signed by the coordinator/.test(await page.getAttribute(`.tile[data-index="18"] .tick`, 'title')), 'the tick says what it checked');
  await SHOT(page, 'desktop-light');
  await ctx.close();
}

console.log('a receipt that was changed, and a chain that does not link');
{
  const changed = structuredClone(T);
  changed.receipts[0].name = 'Someone else';
  changed.receipts[0].prev_file_sha256 = '00'.repeat(32);
  const { ctx, page, errs } = await fresh({ transcript: changed });
  ok((await page.getAttribute(`.tile[data-index="18"] .tick`, 'data-sig')) === 'bad', 'a changed receipt does not pass the signature check');
  ok(!(await page.$eval('#link', (e) => e.hidden)) && /does not continue/.test(await text(page, '#link')), 'a broken link is said, and the list is not to be trusted');
  ok(!errs.length, 'no page errors');
  await ctx.close();
}

console.log('provers on the wall');
{
  const A = '0x' + 'cd'.repeat(20);
  const last = T.receipts[T.receipts.length - 1];
  const p = { index: last.index + 1, name: 'tacit-prover', handle: A, contribution_hash: '9f'.repeat(32), file_sha256: '8e'.repeat(32), prev_file_sha256: last.file_sha256, at: new Date(Date.now() - 120e3).toISOString(), signature: '00'.repeat(64) };
  const live = { ...T, head_index: p.index, head_sha256: p.file_sha256, receipts: [...T.receipts, p] };
  const { ctx, page, errs, csp } = await fresh({ live });
  ok((await text(page, '#n-prover')) === '1' && (await text(page, '#n-ours')) === String(T.receipts.length + 1), 'a contribution by tacit-prover counts as one by a prover');
  const row = await text(page, `.tile[data-index="${p.index}"]`);
  ok(/prover/.test(row) && /0xcdcd…cdcd/.test(row) && !/tacit-prover/.test(row), `its tile says prover and shows the address, not the tool's name (${row})`);
  ok((await page.$$eval('.tile .bd', (b) => b.length)) === 1, 'and only that tile has the badge');
  ok(/live/i.test(await text(page, '#live')) && !(await page.$eval('#live', (e) => e.classList.contains('off'))), 'the wall says it read the chain live');
  ok(!errs.length && !csp.length, `no page or CSP errors (${[...errs, ...csp].join(' | ')})`);
  await ctx.close();
}

console.log('find yours, and share it');
{
  const { ctx, page } = await fresh();
  ok(await page.$eval('#you', (e) => e.hidden), 'nothing is said before anyone looks');
  await page.fill('#find', '#18');
  ok(/You are #18, Tacit/.test(await text(page, '#you')) && (await page.$(`.tile.mine[data-index="18"]`)) !== null, 'a number finds the contribution and marks its tile');
  const href = await page.getAttribute('#you a.btn', 'href');
  const u = new URL(href);
  ok(u.origin === 'https://twitter.com' && u.pathname === '/intent/tweet' && u.searchParams.get('url') === 'https://tacit.finance/praxis/' && u.searchParams.get('text').includes(R18.contribution_hash) && /Tacit Praxis ceremony/.test(u.searchParams.get('text')), 'the X post carries the hash and the page');
  ok((await page.getAttribute('#you a.btn', 'target')) === '_blank' && /noopener/.test(await page.getAttribute('#you a.btn', 'rel')), 'it opens in a new tab');
  await page.fill('#find', ` 0x${R18.contribution_hash.toUpperCase()} `);
  ok(/You are #18/.test(await text(page, '#you')), 'a pasted hash, in capitals and with spaces, finds it too');
  await page.fill('#find', R19.handle.toUpperCase().replace('0X', '0x'));
  ok(/You are #19/.test(await text(page, '#you')) && !/,\s*0x/.test(await text(page, '#you')), 'an address finds its contribution, without repeating the address as a name');
  await page.fill('#find', 'ab'.repeat(32));
  ok(/Not on the wall yet/.test(await text(page, '#you')) && (await page.$('.tile.mine')) === null, 'a hash that is not there is said so, and nothing is marked');
  await page.fill('#find', '');
  await page.fill('#addr', R19.handle);
  ok(/You are #19/.test(await text(page, '#you')), 'typing your address in the command finds you as well');
  await ctx.close();
}

console.log('the rewards, in TAC');
{
  const { ctx, page } = await fresh();
  await page.waitForFunction(() => !document.querySelector('#rewards').hidden, null, { timeout: 8000 });
  const r = await text(page, '#rewards');
  ok(/Paid in TAC/.test(r) && /up to 5/.test(r) && /595 TAC left/.test(r) && /about 119 more contributions/.test(r) && /of a 600 TAC pot/.test(r), `what one pays, the pot and what is left (${r.slice(0, 160)})`);
  ok(await page.$('#rewards svg.tk use[href="#tk-tac"]') !== null && await page.$('#cta-reward svg.tk use[href="#tk-tac"]') !== null, 'the TAC logo is on the panel and the button\'s chip');
  ok(/up to 5 TAC each/.test(await text(page, '#cta-reward')), 'the button\'s chip says what it pays');
  const w = await page.$eval('#rw-fill', (e) => e.style.width);
  ok(w === '1%', `the bar shows what is paid out (${w})`);
  await ctx.close();
  const off = await fresh({ points: { enabled: false } });
  await off.page.waitForTimeout(800);
  ok(await off.page.$eval('#rewards', (e) => e.hidden) && await off.page.$eval('#cta-reward', (e) => e.hidden), 'with the campaign off, no reward is promised');
  await off.ctx.close();
  const none = await fresh({ points: null });      // the points service does not answer (the test aborts it)
  await none.page.waitForTimeout(800);
  ok(await none.page.$eval('#rewards', (e) => e.hidden), 'if the points service cannot be read, no reward is promised');
  await none.ctx.close();
}

console.log('take part: the big button, the command for this computer, the queue and the coordinator from the window');
{
  const { ctx, page, errs } = await fresh({ coordinator: { open: true, coordinator: 'http://198.51.100.7:9999', queue: 3, index: 18 } });
  await page.waitForFunction(() => /queue/.test(document.querySelector('#queue').textContent), null, { timeout: 10000 });
  ok(/3 in the queue · about 60 min/.test(await text(page, '#queue')) && (await text(page, '#n-queue')) === '3', `the queue and the wait, and the stat (${await text(page, '#queue')})`);
  await page.selectOption('#plat', 'linux-amd64');
  await page.fill('#addr', '0x' + 'ab'.repeat(20));
  await page.fill('#name', "Ada O'Neil");
  const cmd = await page.innerText('#cmd-run');
  ok(cmd.includes('releases/download/ceremony-v1.0.0/tacit-ceremony-linux-amd64') && cmd.includes('chmod +x tacit-ceremony-linux-amd64'), 'the download for the computer picked');
  ok(cmd.includes('--coordinator http://198.51.100.7:9999'), 'the coordinator address comes from the window');
  ok(cmd.includes(`--name 'Ada O'\\''Neil'`) && cmd.includes('--handle 0x' + 'ab'.repeat(20)), `the name quoted for the shell and the address as the handle (${cmd.split('\n').pop()})`);
  await page.click('#copy-run');
  ok((await page.evaluate(() => navigator.clipboard.readText())) === cmd.trim() && /Copied/.test(await text(page, '#copy-run')), 'the big button copies the command as shown');
  await page.fill('#addr', '0x123');
  ok(!(await page.innerText('#cmd-run')).includes('--handle'), 'a malformed address is left out');
  await page.selectOption('#plat', 'windows-amd64.exe');
  ok(/Invoke-WebRequest .*tacit-ceremony-windows-amd64\.exe/.test(await page.innerText('#cmd-run')), 'Windows gets PowerShell lines');
  await page.click('#cmd-run + .cp');
  await page.waitForFunction(() => /Copied/.test(document.querySelector('#cmd-run + .cp').textContent), null, { timeout: 3000 }).catch(() => {});
  ok(/Copied/.test(await text(page, '#cmd-run + .cp')), 'the command box has its own copy button too');
  await page.click('#cta-go');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'addr', null, { timeout: 4000 });
  ok(true, 'the Contribute button takes you to the form and into the address field');
  ok(/tacit-prover/.test(await text(page, '.alt')) && /v0\.7\.0/.test(await text(page, '.alt')), 'a line for people who run tacit-prover');
  ok(!errs.length, 'no script errors');
  await ctx.close();
}

console.log('a transcript that cannot be read');
{
  const { ctx, page, errs } = await fresh({ transcript: 404, wait: false });
  await page.waitForFunction(() => /could not be read/.test(document.querySelector('#tiles').textContent), null, { timeout: 10000 });
  ok(true, 'the wall says so');
  ok((await page.$$('.cmd .cp')).length >= 3 && /contribute/.test(await text(page, '#cmd-run')), 'the commands still work');
  ok(!errs.length, 'no page errors');
  await ctx.close();
}

console.log('a phone, light and dark; the desktop dark');
for (const scheme of ['light', 'dark']) {
  const { ctx, page, errs, csp } = await fresh({ viewport: { width: 390, height: 844 }, scheme, coordinator: { open: true, coordinator: 'http://143.55.45.86:53874', queue: 12, index: 20 } });
  await page.waitForFunction(() => !document.querySelector('#rewards').hidden, null, { timeout: 8000 });
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth]);
  ok(w[0] <= w[2] && w[1] <= w[2], `no sideways scroll at 390 px, ${scheme} (${w})`);
  const wide = await page.$$eval('main *', (es) => es.filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5 && !e.closest('pre')).map((e) => e.tagName + '.' + e.className).slice(0, 5));
  ok(!wide.length, `nothing reaches past the right edge (${wide})`);
  const small = await page.$$eval('main button, main a.btn, main select, main input', (es) => es.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height < 28; }).map((e) => e.id || e.className).slice(0, 4));
  ok(!small.length, `every control on the phone is tall enough to tap (${small})`);
  if (scheme === 'dark') {
    const [bg, ink] = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.join')).color].map((c) => (c.match(/\d+/g) || []).slice(0, 3).map(Number).reduce((a, x) => a + x, 0)));
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

await b.close();
server.close();
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
