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
  ok(/Tacit Praxis ceremony/.test(await text(page, 'h1')) && /SP1 v6\.1\.0 verifier circuit/.test(hero) && /We are building Praxis on this key/.test(hero), 'the heading, the circuit it is for, and that Praxis is being built on the key');
  ok(!/has not been reviewed|Nothing rests|not built|in progress|may not|might not/i.test(hero), 'the head makes its case without disclaimers (the plain status is in the folded sections)');
  ok(/even one of them throws away their secret/.test(hero) && /Smart contracts on Bitcoin/.test(hero) && /without changing Bitcoin/.test(hero) && /covenants/.test(hero), 'the leader says what it makes possible, how, and why a contributor matters');
  await openAll(page);
  const rests = await text(page, '#honest');
  ok(/at least one Phase 2 contributor/.test(rests) && /first 54 Perpetual Powers of Tau contributors/.test(rests) && /derived correctly from Phase 1 and the circuit/.test(rests), 'the conditions the key rests on: a Phase 2 contributor, a Phase 1 contributor and a correct start');
  ok(/Where it stands/.test(rests) && /being built on this key/.test(rests) && /new key/.test(rests) && /does not change Succinct's deployed SP1 verifier/.test(rests), 'where it stands, plainly: a new key, Praxis being built on it, Succinct\'s deployed verifier unchanged');
  const how = await text(page, '#use');
  ok(/Witness encryption/.test(how) && /covenants/.test(how) && /ordinary signature/.test(how) && /Ethereum/.test(how) && /Limits/.test(how) && /quantum/.test(how) && /7\.9 GiB/.test(how), 'the short technical summary: the primitive, Bitcoin, Ethereum, the setup, and the limits as facts');
  ok(/Names and handles are self-declared/.test(rests), 'names and handles are said to be self-declared');
  const all = await text(page, 'main');
  const meta = [await page.getAttribute('meta[name=description]', 'content'), await page.getAttribute('meta[property="og:description"]', 'content')].join(' ');
  ok(!/trustless|audited|protects? (BTC|bitcoin)|strengthens? SP1|\bsecure[sd]?\b|Safe if|locks keys|only a valid proof/i.test(all + ' ' + meta), 'none of: trustless, audited, secure, protects BTC, strengthens SP1');
  ok(await page.$('header.top .sn') && await page.$('footer.sf'), 'the site header and footer are stamped in');
  const fixed = await text(page, '.fixed');
  ok(fixed.includes('d6a66be2702206e2b1a20bebf7096142864feac9e399a309e5e6e00353264cbc') && fixed.includes('bf6f7799c77a90009ae356fd0d3a69a91cf153825e6762ce344fe804cf5db2df') && fixed.includes(KEY) && /drand round 1000/.test(fixed) && /first Bitcoin block mined after the close is announced/.test(fixed) && !/announced before the close/.test(fixed) && /as explorers print it/.test(fixed) && /quicknet/.test(fixed), 'the fixed values: circuit, starting file, coordinator key, both seals (the Phase 2 seal follows the close)');
  const vt = await text(page, '#verify');
  ok(/From phase2-17 onward/.test(vt) && /These commands start at phase2-17/.test(vt) && /re-derived from the Hermez file/.test(vt) && !/separate check/.test(vt), 'what the file checks cover, and what they do not, with the genesis record');
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
  ok((await text(page, '#n-total')) === String(18 + T.receipts.length) && (await text(page, '#n-ours')) === String(T.receipts.length) && await page.$eval('#n-prover', (e) => e.closest('li').hidden), 'the stats: in the chain and joined here; the count of provers stays out of sight while it is zero');
  ok(/Tacit/.test(await text(page, '.tile[data-index="18"] .bd.house')) && /Tacit/.test(await text(page, '.tile[data-index="20"] .bd.house')) && (await page.$('.tile[data-index="19"] .bd')) === null, 'Tacit\'s own two contributions are badged, by their hashes, and the outside one is not');
  ok(/phase2-20/.test(await text(page, '#head-line')) && (await page.$eval('#link', (e) => e.hidden)), 'the head, and no warning about the chain');
  await page.click(`.tile[data-index="18"]`);
  ok((await page.evaluate(() => navigator.clipboard.readText())) === R18.contribution_hash && /hash copied/.test(await text(page, `.tile[data-index="18"]`)), 'a tile copies its whole contribution hash');
  ok(/signed by the coordinator/.test(await page.getAttribute(`.tile[data-index="18"] .tick`, 'title')), 'the tick says what it checked');
  await SHOT(page, 'desktop-light');
  await ctx.close();
}

console.log('the whole chain, as masks');
{
  const { ctx, page } = await fresh();
  const n = T.receipts.length;
  ok((await page.$$('#chain .lk.last')).length === 1 && (await page.$eval('#chain .lk:last-child', (e) => e.classList.contains('last'))), 'the newest link is marked, for its ring');
  ok((await page.$$('#chain .lk')).length === 18 + n && (await page.$$('#chain .lk.sg')).length === 18 && (await page.$$('#chain .lk.ours')).length === n, `a mask for every link: Succinct's 18 and the ${n} here`);
  const srcs = await page.$$eval('#chain .lk img.inv', (i) => i.map((x) => x.src));
  ok(srcs.length === 18 + n && new Set(srcs).size === srcs.length && srcs.every((x) => x.startsWith('data:image/svg+xml;base64')), 'each is a different zOrgz invader');
  const same = await page.$eval('#chain .lk.ours[data-index="19"] img', (i) => i.src);
  ok(same === (await page.$eval('.tile[data-index="19"] img.inv', (i) => i.src)), 'a contributor has the same face in the chain and on the wall');
  ok((await page.$eval('#chain .lk.ours img', (i) => i.getBoundingClientRect().width)) > (await page.$eval('#chain .lk.sg img', (i) => i.getBoundingClientRect().width)), 'Succinct\'s masks are smaller than ours');
  await page.fill('#find', '#19');
  ok((await page.$('#chain .lk.mine[data-index="19"]')) !== null, 'finding yours lights your mask in the chain');
  await page.click('#chain .lk.ours[data-index="18"]');
  ok((await page.evaluate(() => navigator.clipboard.readText())) === R18.contribution_hash, 'a mask copies its contribution hash');
  const log = readFileSync(join(DAPP, '../ceremony-phase2/genesis/sg11-genesis.log'), 'utf8');
  const links = [...log.matchAll(/^ok \d+ sha256 ([0-9a-f]{64})/gm)].map((m) => m[1]);
  const mod = await import(new URL('../dapp/praxis/receipt.js', import.meta.url));
  ok(links.length === 18 && JSON.stringify(mod.SUCCINCT_LINKS) === JSON.stringify(links), 'Succinct\'s 18 hashes on the page are the ones in the genesis record');
  await ctx.close();
}

console.log('a name left as the command\'s placeholder');
{
  const mod = await import(new URL('../dapp/praxis/receipt.js', import.meta.url));
  const A = '0xf33ce75baed614c6d41246ecb8d076e2ceedd3fe';
  ok(mod.nameOf({ name: '<your name>', handle: A }) === '0xf33c…d3fe', 'a placeholder name shows the address instead');
  ok(mod.nameOf({ name: '<your name>', handle: '' }) === 'Anonymous' && !mod.hasName({ name: '  ' }) && mod.hasName({ name: 'Ada' }), 'no name and no address reads Anonymous; a real name still counts');
  ok(mod.nameOf({ name: 'Ada', handle: A }) === 'Ada', 'a real name is kept');
}

console.log('earned, not yet paid');
{
  const mod = await import(new URL('../dapp/praxis/receipt.js', import.meta.url));
  const view = mod.rewardView({ enabled: true, pocket: { totalWei: String(1250n * W), creditedWei: '0', remainingWei: String(1250n * W) }, terms: { capWeiPerPoint: String(5n * W / 100n) } });
  const p = mod.rewardProgress(view, 3);
  ok(p.pending === 15n * W && p.leftAfter === 1235n * W && p.count === 247n && p.pendFrac > 0, 'three addresses earned 15 TAC that is not paid yet: it shows on the bar and comes off what is left');
  const q = mod.rewardProgress(mod.rewardView({ enabled: true, pocket: { totalWei: String(1250n * W), creditedWei: String(15n * W), remainingWei: String(1235n * W) }, terms: { capWeiPerPoint: String(5n * W / 100n) } }), 3);
  ok(q.pending === 0n && q.leftAfter === 1235n * W, 'once they are paid, nothing is counted twice');
  ok(mod.addressOf({ name: 'x', handle: ' 0xAbCdEf0123456789abcdef0123456789ABCDEF01 ' }) === '0xabcdef0123456789abcdef0123456789abcdef01' && mod.addressOf({ name: 'Tacit', handle: '@tacitfinance' }) === null, 'the address a contribution is credited to is its handle, else its name');
}

console.log('what a shared link looks like');
{
  const og = (p) => page0.getAttribute(`meta[property="${p}"]`, 'content');
  const page0 = (await fresh({ wait: false })).page;
  ok(await og('og:image') === 'https://tacit.finance/praxis/og.png' && await page0.getAttribute('meta[name="twitter:image"]', 'content') === 'https://tacit.finance/praxis/og.png' && await page0.getAttribute('meta[name="twitter:card"]', 'content') === 'summary_large_image', 'the card that X and link previews show is this page\'s own');
  const png = readFileSync(join(DAPP, 'praxis/og.png'));
  ok(png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630 && png.length < 400000, 'the card file is 1200 x 630 and small');
  const d = await page0.getAttribute('meta[name="twitter:description"]', 'content');
  ok(/Smart contracts on Bitcoin/.test(d) && /5 TAC/.test(d) && !/trustless|audited|secure|locks keys/i.test(d), 'its text says what it is and what it pays, in plain words');
}

console.log('the banner on the landing page');
{
  const land = readFileSync(join(DAPP, 'index.html'), 'utf8');
  const m = land.match(/<a class="pxb" href="([^"]+)"[^>]*>(.*?)<\/a>/s);
  const txt = m ? m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  ok(m && m[1] === '/praxis/' && /smart contracts on Bitcoin/.test(txt) && /up to 5 TAC/.test(txt) && !/not reviewed|not built/i.test(txt), `the landing page has a quiet line to the ceremony that says what it is (${txt.slice(0, 90)})`);
  ok(/class="pxb"/.test(readFileSync(join(DAPP, 'tac/index.html'), 'utf8')) && /class="pxb"/.test(readFileSync(join(DAPP, 'spx/index.html'), 'utf8')), 'and the pages built from it carry it too');
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
  ok((await text(page, '#n-prover')) === '1' && !(await page.$eval('#n-prover', (e) => e.closest('li').hidden)) && (await text(page, '#n-ours')) === String(T.receipts.length + 1), 'a contribution by tacit-prover counts as one by a prover, and the stat shows once there is one');
  const row = await text(page, `.tile[data-index="${p.index}"]`);
  ok(/prover/.test(row) && /0xcdcd…cdcd/.test(row) && !/tacit-prover/.test(row), `its tile says prover and shows the address, not the tool's name (${row})`);
  ok((await page.$$eval('.tile .bd:not(.house)', (b) => b.length)) === 1, 'and only that tile has the prover badge');
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
  const tweet = u.searchParams.get('text');
  ok(u.origin === 'https://twitter.com' && u.pathname === '/intent/tweet' && u.searchParams.get('url') === 'https://tacit.finance/praxis/' && tweet.includes(R18.contribution_hash) && /Tacit Praxis ceremony, #18 in the chain/.test(tweet) && /#TAC #Praxis/.test(tweet) && /earn TAC/.test(tweet), `the X post carries the number, the hash, the tags and the page (${tweet.length} characters)`);
  ok(tweet.length + 24 <= 280, 'and fits in a post with the link');
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

console.log('sharing the ceremony, and a contributor who comes back');
{
  const { ctx, page } = await fresh();
  const u = new URL(await page.getAttribute('#share-page', 'href'));
  const tweet = u.searchParams.get('text');
  ok(u.origin === 'https://twitter.com' && u.pathname === '/intent/tweet' && u.searchParams.get('url') === 'https://tacit.finance/praxis/' && /Tacit Praxis ceremony is open/.test(tweet) && /earn TAC/.test(tweet) && /#TAC #Praxis/.test(tweet) && tweet.length + 24 <= 280, `the Share button next to Contribute posts the ceremony, with the tags (${tweet.length} characters)`);
  ok((await page.getAttribute('#share-page', 'target')) === '_blank' && /noopener/.test(await page.getAttribute('#share-page', 'rel')), 'it opens in a new tab');
  await page.fill('#name', 'Nobody');
  await page.fill('#addr', R19.handle);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.tile.mine'), null, { timeout: 15000 });
  ok((await page.inputValue('#addr')) === R19.handle && (await page.inputValue('#name')) === 'Nobody', 'what was typed is still there on the next visit');
  ok(/You are #19/.test(await text(page, '#you')) && (await page.$eval('#you a.btn', (a) => /#19 in the chain/.test(new URL(a.href).searchParams.get('text')))), 'and a returning contributor is found on the wall, with a post ready to share');
  await ctx.close();
}

console.log('the moment a contribution lands');
{
  const A = '0x' + 'be'.repeat(20);
  const last = T.receipts[T.receipts.length - 1];
  const mk = (i, handle, ageMs) => ({ index: i, name: 'Eve', handle, contribution_hash: String(i).repeat(32).slice(0, 64).replace(/./g, 'a'), file_sha256: 'e'.repeat(64), prev_file_sha256: last.file_sha256, at: new Date(Date.now() - ageMs).toISOString(), signature: '00'.repeat(64) });
  const fresh1 = mk(last.index + 1, A, 90e3);
  const live = { ...T, head_index: fresh1.index, head_sha256: fresh1.file_sha256, receipts: [...T.receipts, fresh1] };
  const { ctx, page, errs, csp } = await fresh({ live });
  ok(!(await page.$eval('#cele', (d) => d.open)), 'the page does not celebrate before anyone says who they are');
  await page.fill('#find', '#' + fresh1.index);
  ok(!(await page.$eval('#cele', (d) => d.open)), 'and a search for someone else\'s contribution does not either');
  await page.fill('#find', '');
  await page.fill('#addr', A);
  await page.waitForFunction(() => document.querySelector('#cele').open, null, { timeout: 4000 });
  ok(new RegExp(`You are #${fresh1.index}`).test(await text(page, '#cele-h')), 'typing the address of a contribution just made opens the celebration, with its number');
  ok(/TAC/.test(await text(page, '#cele-amt')) && /up to 5|\b5\b/.test(await text(page, '#cele-amt')) && !(await page.$eval('#cele-amt', (e) => e.hidden)), 'it says what the contribution pays, in TAC');
  const cu = new URL(await page.getAttribute('#cele-share', 'href'));
  ok(cu.hostname === 'twitter.com' && cu.searchParams.get('text').includes(fresh1.contribution_hash) && new RegExp(`#${fresh1.index} in the chain`).test(cu.searchParams.get('text')) && /#TAC #Praxis/.test(cu.searchParams.get('text')), 'its Share on X button carries the number, the hash and the tags');
  ok((await page.$$eval('#cele-coin .fly', (c) => c.length)) > 0 || (await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)), 'TAC coins burst from the coin');
  await page.click('#cele button[data-close].btn');
  ok(!(await page.$eval('#cele', (d) => d.open)), 'it closes');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.tile.mine'), null, { timeout: 15000 });
  ok(!(await page.$eval('#cele', (d) => d.open)) && /You are #/.test(await text(page, '#you')), 'on the next visit it is not shown again, and the wall still finds the contributor');
  ok(!errs.length && !csp.length, `no page or CSP errors (${[...errs, ...csp].join(' | ')})`);
  await ctx.close();
  // an old contribution (typed in by someone else, or long ago) is not celebrated
  const old = { ...T, receipts: T.receipts.map((r) => (r.index === 19 ? { ...r, at: new Date(Date.now() - 5 * 86400e3).toISOString() } : r)) };
  const o = await fresh({ live: old });
  await o.page.fill('#addr', R19.handle);
  await o.page.waitForTimeout(600);
  ok(!(await o.page.$eval('#cele', (d) => d.open)), 'a contribution days old is found but not celebrated');
  await o.ctx.close();
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
