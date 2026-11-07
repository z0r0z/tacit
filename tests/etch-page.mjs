#!/usr/bin/env node
// dapp/etch/ in a real browser, under its own CSP: Create etches an asset from a Tacit key, Discover searches the registry. The page and its modules are the
// real files; the registry, the metadata batch and the logo pin are answered here, and /trade/btc.js (the page's door to tacit.js and the key) is a stand-in that
// holds a key and a few sats and records what the page asks of it, so nothing here reaches Bitcoin.
//   checks: the page and its address in the header's menu; the ticker and supply read as they are typed (what is refused and why); a ticker already in use; the
//   wallet's button through its states (open, enter, add sats, etch); what the etch is asked for and what is said while it runs, when it stops, and when it is
//   done; the logo; Discover (order, names and logos from the metadata, the earlier-ticker note, search, a row's detail, more, a link to a search); a phone width.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/etch-page.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f) && !extname(p)) f = join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── the registry: the live shapes, thirty-odd assets so that "show more" has something to show ──
const hex = (n) => String(n).padStart(4, '0') + 'ab'.repeat(30);
const cid = (n) => `bafkrei${'a'.repeat(44)}${String(n).padStart(3, '0')}`;
const TAC_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const asset = (o) => ({ asset_id: hex(o.n), ticker: o.t, decimals: o.d ?? 8, commitment: '02' + 'ab'.repeat(32), image_uri: `ipfs://${cid(o.n)}`, etch_txid: hex(o.n + 5000), etch_vout: 0, etched_at_height: 950000 + o.n, etched_at: 1780000000 + o.n * 3600, mintable: !!o.m, verified: !!o.v, holder_count: o.h ?? 1, ...(o.s ? { attestation: { supply: o.s, blinding: 'cd'.repeat(32), attested_at: 1780100000 } } : {}) });
const ASSETS = [
  { ...asset({ n: 1, t: 'TAC', v: true, h: 40, s: '2100000000000000' }), asset_id: TAC_ID },
  asset({ n: 2, t: 'ORANGE', s: '2100000000000000', h: 3 }),
  asset({ n: 3, t: 'TAC' }), asset({ n: 4, t: 'TAC', m: true }),
  asset({ n: 5, t: 'NOODS', d: 0, s: '1000000', h: 12 }),
  asset({ n: 6, t: 'TACIT' }),
  ...Array.from({ length: 28 }, (_, i) => asset({ n: 10 + i, t: `COIN${i + 1}` })),
];
// the metadata: ORANGE names itself and its logo; NOODS is a logo itself (not JSON); the rest have none that reads
const LOGO = readFileSync(join(DAPP, 'favicon.svg'));
const BLOBS = { [cid(2)]: { name: 'Orange Coin', image: `ipfs://${cid(900)}`, description: 'x', tacit_attest: { supply: '2100000000000000', blinding: 'ab'.repeat(32) } } };
const calls = { assets: 0, batch: 0, pin: 0 };

// ── the stand-in for /trade/btc.js ──
const STUB = `
const W = window.__stub = { calls: [], unlocked: false, sats: 60000, need: 4000, failAt: null, holdAt: null, signInFails: false, noPin: false };
const rec = (name, args) => W.calls.push({ name, args });
const hold = (at) => (W.holdAt === at ? new Promise((r) => { W.release = r; }) : Promise.resolve());
const T = {
  etchQuote: async (o) => { rec('quote', o); return { rate: 5, fee: 2100 + (o.pin ? 300 : 0), need: W.need }; },
  etchAsset: async (o) => {
    rec('etch', { ticker: o.ticker, supply: String(o.supply), decimals: o.decimals, name: o.name, description: o.description, externalUrl: o.externalUrl, imageUri: o.imageUri, mintable: o.mintable, publishSupply: o.publishSupply });
    await hold('start');
    o.onProgress?.('commit-start'); await hold('commit');
    if (W.failAt === 'commit') throw new Error('broadcast refused');
    o.onProgress?.('reveal-start'); await hold('reveal');
    if (W.failAt === 'reveal') throw new Error('reveal refused');
    return { commitTxid: 'c1'.repeat(32), revealTxid: 'e2'.repeat(32), assetIdHex: 'a7'.repeat(32), metadataPinned: W.noPin ? false : true, supplyPublished: !!o.publishSupply };
  },
};
let me = null;
const session = { key: null, get unlocked() { return W.unlocked; }, load: async () => T };
export function makeBitcoin({ onChange }) {
  const read = () => { me = { sats: W.sats }; onChange?.(); };
  return {
    session,
    signIn: async () => { if (W.signInFails) { const e = new Error('Cancelled.'); e.unlockCancelled = true; throw e; } W.unlocked = true; session.key = { pubHex: '02' + 'ab'.repeat(32) }; rec('signIn', {}); read(); },
    fund: () => rec('fund', {}),
    refresh: async () => { rec('refresh', {}); read(); },
    get me() { return me; },
  };
}`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();

async function fresh(path = '/etch/', viewport = { width: 1100, height: 1000 }, scheme = 'light') {
  const ctx = await b.newContext({ viewport, colorScheme: scheme });
  const page = await ctx.newPage();
  const errs = [], csp = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t.slice(0, 200)); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.route(/^https:\/\/api\.tacit\.finance\//, async (route) => {
    const u = new URL(route.request().url()), cors = { 'access-control-allow-origin': '*' };
    if (u.pathname === '/assets') { calls.assets++; return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ network: 'mainnet', count: ASSETS.length, assets: ASSETS, meta: {} }) }); }
    if (u.pathname === '/ipfs/batch') {
      calls.batch++;
      const ids = JSON.parse(route.request().postData() || '{}').cids || [], blobs = {};
      for (const c of ids) blobs[c] = BLOBS[c] || { error: 'not json' };
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ blobs }) });
    }
    if (u.pathname === '/pin') { calls.pin++; if (calls.pinDelay) await sleep(calls.pinDelay); return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ cid: cid(777) }) }); }
    if (u.pathname.startsWith('/ipfs/')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: cors, body: LOGO });
    return route.fulfill({ status: 404, headers: cors, body: '{}' });
  });
  await page.route(/\/trade\/btc\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tk', { state: 'attached' });
  return { page, errs, csp, ctx };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim());
const stub = (page, k) => page.evaluate((key) => (window.__stub ? window.__stub[key] : undefined), k);
const calls_ = (page, name) => page.evaluate((nm) => (window.__stub?.calls || []).filter((c) => c.name === nm), name);
const type = async (page, sel, v) => { await page.fill(sel, ''); await page.type(sel, v, { delay: 5 }); };

console.log('The page:');
{
  const { page, errs, csp } = await fresh();
  ok((await page.title()) === 'tacit etch', 'its title');
  ok(await page.$eval('.sm > summary', (e) => e.classList.contains('here')), 'the header menu marks Etch as the page you are on');
  ok((await page.$$eval('.sm-p a', (a) => a.map((x) => x.getAttribute('href')))).includes('/etch/'), 'and lists it');
  ok((await text(page, '#go')) === 'Open your Tacit wallet', 'the button opens the wallet first');
  ok(await page.$eval('#t-create', (e) => e.getAttribute('aria-selected') === 'true'), 'Create is the panel it opens on');
  ok(!(await page.isVisible('#rcpt')), 'no receipt before there is a ticker and a supply');
  await shot(page, 'create-empty');
  await page.waitForTimeout(200);
  ok(errs.length === 0, 'no script errors' + (errs.length ? `: ${errs[0]}` : ''));
  ok(csp.length === 0, 'nothing refused by the page’s CSP' + (csp.length ? `: ${csp[0]}` : ''));
  await page.close();
}

console.log('\nThe ticker and the supply:');
{
  const { page } = await fresh();
  await type(page, '#tk', 'or-ange!x1');
  ok((await page.inputValue('#tk')) === 'ORANGEX1', 'letters and digits only, upper case, eight at most');
  await type(page, '#tk', 'orange');
  ok((await text(page, '#unit')) === 'ORANGE', 'the ticker is named beside the supply');
  ok(!(await page.$eval('#mark', (e) => e.hidden)), 'and has a mark');
  await type(page, '#sup', 'abc');
  ok((await text(page, '#sup-note')) === 'Enter a number', 'a supply that is not a number is said so');
  await type(page, '#sup', '1.234567891');
  ok((await text(page, '#sup-note')) === 'Up to 8 decimals', 'too many decimals for the choice');
  await page.click('[data-d="0"]');
  await type(page, '#sup', '1.5');
  ok((await text(page, '#sup-note')) === 'Whole numbers only', 'none allowed at 0 decimals');
  await type(page, '#sup', '0');
  ok((await text(page, '#sup-note')) === 'More than zero', 'zero is refused');
  await type(page, '#sup', '99999999999999999999');
  ok(/^At most 18,446,744,073,709,551,615$/.test(await text(page, '#sup-note')), 'more than 2⁶⁴ base units names the most it can be');
  await page.click('[data-d="8"]');
  ok(/^At most 184,467,440,737\.09551615$/.test(await text(page, '#sup-note')), 'and that follows the decimals');
  await type(page, '#sup', '1,000,000');
  ok((await text(page, '#sup-note')) === '', 'a grouped number reads');
  const rows = await page.$$eval('#rcpt div', (d) => d.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows[0] === 'Supply1,000,000 ORANGE', `the receipt names the supply (${rows[0]})`);
  ok(/^Network fee…$/.test(rows[1]) || /^Network feeabout [\d,]+ sats$/.test(rows[1]), `and the fee (${rows[1]})`);
  ok(await page.$eval('#dec [aria-pressed="true"]', (e) => e.textContent) === '8', 'eight decimals unless chosen otherwise');
  await shot(page, 'create-filled');
  await page.close();
}

console.log('\nA ticker already in use:');
{
  const { page } = await fresh();
  await page.waitForFunction(() => document.querySelector('#tk-note') !== null);
  await type(page, '#tk', 'tac');
  await page.waitForSelector('#tk-note button');
  ok((await text(page, '#tk-note')) === '3 assets use TAC', 'it says how many assets already carry it');
  await page.click('#tk-note button');
  await page.waitForSelector('#list .as');
  ok(await page.$eval('#t-find', (e) => e.getAttribute('aria-selected') === 'true'), 'and the link opens Discover');
  ok((await page.inputValue('#find')) === 'TAC', 'on that ticker');
  ok((await page.$$eval('#list .as b', (b) => b.map((x) => x.textContent))).filter((t) => t === 'TAC').length === 3, 'with the three');
  await page.close();
}

console.log('\nThe wallet and the etch:');
{
  const { page, errs, csp } = await fresh();
  await type(page, '#tk', 'orange');
  await type(page, '#sup', '1000000');
  await page.waitForFunction(() => window.__stub);
  await page.evaluate(() => { window.__stub.sats = 1200; });
  await page.click('#go');
  await page.waitForFunction(() => window.__stub?.calls.some((c) => c.name === 'signIn'));
  ok(true, 'the button opens the Tacit wallet');
  await page.waitForFunction(() => /about [\d,]+ sats/.test(document.querySelector('#rcpt').textContent) && /1,200 sats/.test(document.querySelector('#rcpt').textContent));
  ok((await calls_(page, 'etch')).length === 0, 'nothing is sent by opening it');
  const rows = await page.$$eval('#rcpt div', (d) => d.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(rows.some((r) => /^Network feeabout [\d,]+ sats$/.test(r)), 'the fee reads once the library is in');
  ok(rows.some((r) => r === 'In your wallet1,200 sats add'), 'and the sats the key holds');
  ok(/^Add sats$/.test(await text(page, '#go')), 'a key short of sats is offered Add sats');
  await page.click('[data-chain="eth"]');
  await page.click('[data-chain="btc"]');
  await page.waitForFunction(() => /about [\d,]+ sats/.test(document.querySelector('#rcpt').textContent), null, { timeout: 5000 }).catch(() => {});
  ok(/Network feeabout [\d,]+ sats/.test((await text(page, '#rcpt')).replace(/\s+/g, ' ')), 'to Ethereum and back, the Bitcoin fee is asked again (not left at …)');
  await page.waitForFunction(() => /^Add sats$/.test(document.querySelector('#go').textContent), null, { timeout: 5000 }).catch(() => {});
  ok(/Needs about 4,000 sats at your wallet’s address\. It holds 1,200\./.test(await text(page, '#q')), 'and the line says how much');
  ok(await page.$eval('#rcpt dd.warn', (e) => /1,200 sats/.test(e.textContent)), 'the balance is marked in the receipt');
  await shot(page, 'create-short');
  await page.click('#go');
  await page.waitForFunction(() => window.__stub.calls.some((c) => c.name === 'fund'));
  ok((await calls_(page, 'refresh')).length >= 1, 'pressing it reads the balance again first');
  ok((await calls_(page, 'etch')).length === 0, 'and etches nothing');
  // sats arrive: the next press reads them and goes on
  await page.evaluate(() => { window.__stub.sats = 60000; });
  await page.click('#more > summary');
  await type(page, '#nm', 'Orange Coin');
  await type(page, '#ln', 'https://orange.example');
  await page.click('#go');                                                  // the press that finds the sats only offers the etch
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch ORANGE');
  ok((await calls_(page, 'etch')).length === 0, 'sats that have arrived since the balance was read change the button and send nothing');
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  const e = (await calls_(page, 'etch'))[0].args;
  ok(e.ticker === 'ORANGE' && e.supply === '100000000000000' && e.decimals === 8, `the etch is asked for in base units (${e.supply})`);
  ok(e.name === 'Orange Coin' && e.externalUrl === 'https://orange.example' && e.publishSupply === true && e.mintable === false, 'with its name and link, the supply published and no minting');
  ok(e.imageUri === null, 'and no logo');
  ok((await text(page, '#done h2')) === 'ORANGE is etched', 'it says what was made');
  ok((await page.$$eval('#done .kv', (k) => k.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))).some((t) => t === 'Supply1,000,000 ORANGE'), 'and the supply');
  ok((await page.$eval('#done a.btn', (a) => a.getAttribute('href'))) === `/#bitcoin/${'a7'.repeat(32)}`, 'with a way to the wallet that holds it, on Send for that asset');
  ok((await page.$$eval('#done a.btn', (a) => a.map((x) => x.getAttribute('href')))).includes(`/classic.html#tab=market&aid=${'a7'.repeat(32)}`), 'and one to its order book in the classic app');
  await page.click('#t-find');
  await page.waitForSelector('#list .as');
  const first = await page.$eval('#list .as', (e) => ({ id: e.dataset.id, t: e.textContent.replace(/\s+/g, ' ') }));
  ok(first.id === 'a7'.repeat(32) && /ORANGE/.test(first.t) && /Just etched/.test(first.t), 'Discover lists it at once, first, as just etched');
  ok(/Ticker used by an earlier asset/.test(first.t) === true, 'and notes that the ticker was used before, as the registry has ORANGE already');
  await page.click('#t-create');
  ok((await page.$$eval('#done .kv a', (a) => a.map((x) => x.href))).every((h) => h.startsWith('https://mempool.space/tx/')), 'and the two transactions');
  ok(await page.$eval('#edit', (x) => x.hidden), 'the form is put away');
  await shot(page, 'create-done');
  await page.click('#again');
  ok((await page.inputValue('#tk')) === '' && (await page.inputValue('#sup')) === '', 'Etch another starts clean');
  ok(!(await page.$eval('#edit', (x) => x.hidden)), 'with the form back');
  ok(errs.length === 0 && csp.length === 0, 'no errors or refused requests' + (errs[0] || csp[0] ? `: ${errs[0] || csp[0]}` : ''));
  await page.close();
}

console.log('\nThe etch while it runs and when it stops:');
{
  const { page } = await fresh();
  await type(page, '#tk', 'moon');
  await type(page, '#sup', '21');
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch MOON');
  await page.evaluate(() => { window.__stub.failAt = 'commit'; });
  await page.click('#go');
  await page.waitForFunction(() => /broadcast refused/.test(document.querySelector('#q').textContent));
  ok(/^broadcast refused$/.test(await text(page, '#q')) && (await page.$eval('#q', (q) => q.classList.contains('err'))), 'a refusal is said as it is');
  ok(/^Etch MOON$/.test(await text(page, '#go')) && !(await page.$eval('#go', (g) => g.disabled)), 'and the button is back');
  await page.evaluate(() => { window.__stub.failAt = 'reveal'; });
  await page.click('#go');
  await page.waitForFunction(() => /reveal refused/.test(document.querySelector('#q').textContent));
  ok(/^The first transaction went out and the second did not: reveal refused$/.test(await text(page, '#q')), 'a stop after the first transaction says so');
  ok(await page.$eval('#done', (d) => d.hidden), 'and nothing is shown as made');
  await page.evaluate(() => { window.__stub.failAt = null; });
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  ok((await text(page, '#done h2')) === 'MOON is etched', 'then it goes through');
  await page.close();
}
{
  const { page } = await fresh();
  await type(page, '#tk', 'x');
  await type(page, '#sup', '5');
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch X');
  await page.evaluate(() => { window.__stub.holdAt = 'start'; });
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#q').textContent === 'Proving the supply…');
  ok(/^Etching…$/.test(await text(page, '#go')) && (await page.$eval('#go', (g) => g.disabled)), 'while it runs the button says so and waits');
  ok(await page.evaluate(() => { let stopped = false; const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); stopped = e.defaultPrevented; return stopped; }), 'and leaving the page is asked about');
  await page.evaluate(() => { window.__stub.holdAt = 'commit'; window.__stub.release(); });
  await page.waitForFunction(() => document.querySelector('#q').textContent === 'Sending the first transaction…');
  await page.evaluate(() => { window.__stub.holdAt = 'reveal'; window.__stub.release(); });
  await page.waitForFunction(() => document.querySelector('#q').textContent === 'Sending the second…');
  await page.evaluate(() => { window.__stub.holdAt = null; window.__stub.release(); });
  await page.waitForSelector('#done:not([hidden])');
  ok(true, 'it says each step: the proof, the first transaction, the second');
  await page.close();
}
{
  const { page } = await fresh();
  await type(page, '#tk', 'dud');
  await page.click('#go');
  await page.waitForFunction(() => window.__stub?.calls.some((c) => c.name === 'signIn'));
  ok(/^Enter a supply$/.test(await text(page, '#go')) && (await page.$eval('#go', (g) => g.disabled)), 'a key open and no supply: the button says what is missing and waits');
  await type(page, '#sup', '1');
  await page.click('#more > summary');
  await type(page, '#ln', 'http://insecure.example');
  ok(/^The link starts with https:\/\/$/.test(await text(page, '#go')) && (await page.$eval('#go', (g) => g.disabled)), 'a link that is not https waits');
  await type(page, '#ln', 'https://ok.example');
  await page.check('#mint');
  await page.uncheck('#pub');
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  const e = (await calls_(page, 'etch'))[0].args;
  ok(e.mintable === true && e.publishSupply === false, 'minting and a private supply are passed on as chosen');
  ok(/private/.test(await text(page, '#done .kvs')), 'and a supply that was not published says it is private');
  await page.close();
}

console.log('\nA wallet that is not opened:');
{
  const { page } = await fresh();
  await type(page, '#tk', 'zed');
  await page.waitForFunction(() => window.__stub);
  await page.evaluate(() => { window.__stub.signInFails = true; });
  await page.click('#go');
  await page.waitForTimeout(150);
  ok(/^Open your Tacit wallet$/.test(await text(page, '#go')), 'a sign-in that is closed leaves the button as it was');
  ok((await text(page, '#q')) === '', 'and says nothing');
  await page.close();
}

console.log('\nThe logo:');
{
  const { page } = await fresh();
  await type(page, '#tk', 'logo');
  await type(page, '#sup', '1');
  await page.click('#more > summary');
  await page.setInputFiles('#lg', { name: 'x.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  ok((await text(page, '#lg-s')) === 'PNG, JPEG or WebP', 'a type that is not offered is refused');
  await page.setInputFiles('#lg', { name: 'x.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  ok((await text(page, '#lg-s')) === '2 MB at most', 'and a file that is too big');
  ok(calls.pin === 0, 'neither is uploaded');
  await page.setInputFiles('#lg', { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
  await page.waitForFunction(() => !document.querySelector('#lg-x').hidden);
  ok(calls.pin === 1, 'a good one is pinned through the API');
  ok(!(await page.$eval('#lg-mark', (e) => e.hidden)) && /blob:/.test(await page.$eval('#mark', (e) => e.style.backgroundImage)), 'and shown as the mark');
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch LOGO');
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  ok((await calls_(page, 'etch'))[0].args.imageUri === `ipfs://${cid(777)}`, 'its CID goes to the etch as ipfs://');
  await page.close();
}


console.log('\nA logo still uploading, and a name that was not saved:');
{
  const { page } = await fresh();
  await type(page, '#tk', 'late');
  await type(page, '#sup', '5');
  await page.waitForFunction(() => window.__stub);
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch LATE');
  await page.evaluate(() => { window.__stub.noPin = true; });
  calls.pinDelay = 1200;
  await page.click('#more > summary');
  await type(page, '#nm', 'Late Coin');
  await page.setInputFiles('#lg', { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Uploading the logo…');
  ok(await page.$eval('#go', (g) => g.disabled), 'the button waits while the logo uploads, so it is not etched without it');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch LATE');
  calls.pinDelay = 0;
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  ok((await calls_(page, 'etch'))[0].args.imageUri === `ipfs://${cid(777)}`, 'and then it is etched with it');
  ok(/The name and details could not be saved with it\. The asset itself is etched\./.test(await text(page, '#done .q')) && (await page.$eval('#done .q', (q) => q.classList.contains('err'))), 'a name that the pin lost is said to be lost');
  await page.click('#again');
  await page.click('#t-find');
  await page.waitForSelector('#list .as');
  ok(await page.$eval('#list .as .tk img', (i) => i.src.startsWith('https://api.tacit.finance/ipfs/')), 'its logo in Discover is the pinned one, not a page-local copy that "Etch another" revoked');
  await page.close();
}
{
  const { page } = await fresh();
  await type(page, '#tk', 'keys');
  await page.click('#more > summary');
  await page.focus('#lg');
  ok(await page.evaluate(() => document.activeElement.id === 'lg'), 'the logo’s file field takes the keyboard’s focus');
  await type(page, '#sup', '1,000');
  ok((await text(page, '#sup-note')) === 'Write it without the comma', '1,000 is not guessed at, and the line says what to do');
  await type(page, '#sup', '1,000,000');
  ok((await text(page, '#sup-note')) === '', 'while 1,000,000 reads');
  await page.close();
}

console.log('\nFound again after the page is left:');
{
  const { page } = await fresh();
  await type(page, '#tk', 'again');
  await type(page, '#sup', '7');
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch AGAIN');
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  const link = await page.$$eval('#done [data-copy]', (b) => b.map((x) => x.dataset.copy));
  ok(link.some((l) => l === `${BASE}/etch/#discover=${'a7'.repeat(32)}`), 'the done card has a link to share, which searches for the asset');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('tacit-etch-mine-v1') || '[]').some((m) => m.id === 'a7'.repeat(32) && m.ticker === 'AGAIN')), 'the etch is kept in this browser');
  await page.evaluate(() => { const v = JSON.parse(localStorage.getItem('tacit-etch-mine-v1')); v[0].at -= 7200; localStorage.setItem('tacit-etch-mine-v1', JSON.stringify(v)); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.click('#t-find');
  await page.waitForSelector('#list .as');
  const first = await page.$eval('#list .as', (e) => ({ id: e.dataset.id, t: e.textContent.replace(/\s+/g, ' ') }));
  ok(first.id === 'a7'.repeat(32) && /AGAIN/.test(first.t) && /Yours/.test(first.t), 'after the page is left and opened again, it is first in Discover, as yours, before the registry lists it');
  // an Ethereum etch kept here shows on that side with no node to read
  await page.evaluate(() => localStorage.setItem('tacit-etch-mine-v1', JSON.stringify([{ id: '0x' + '9a'.repeat(20), chain: 'eth', ticker: 'KEPT', decimals: 18, etchTxid: 'ab'.repeat(32), at: 1780000000, supply: '5000000000000000000', name: '', logo: null }])));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.click('#t-find');
  await page.click('[data-fchain="eth"]');
  await page.waitForSelector('#list .as');
  const eth = await text(page, '#list .as');
  ok(/KEPT/.test(eth) && /5/.test(eth) && /Yours/.test(eth), 'an Ethereum etch kept here is listed on the Ethereum side');
  await page.close();
}
{
  const { page } = await fresh('/etch/#discover:eth');
  await page.waitForFunction(() => /Could not load the Ethereum assets/.test(document.querySelector('#find-q')?.textContent || ''), null, { timeout: 40000 });
  ok(await page.$eval('#fchain [aria-checked="true"]', (e) => e.dataset.fchain) === 'eth', '#discover:eth opens the Ethereum side, and a node that cannot be read says so with a way to try again');
  await page.close();
}
{
  const { page } = await fresh('/etch/#discover:eth=zed');
  ok(await page.$eval('#fchain [aria-checked="true"]', (e) => e.dataset.fchain) === 'eth' && (await page.inputValue('#find')) === 'zed', '#discover:eth=zed opens a search on the Ethereum side');
  ok((await page.evaluate(() => location.hash)) === '#discover:eth=zed', 'and the address keeps both');
  await page.close();
}

console.log('\nDiscover:');
{
  const { page, errs, csp } = await fresh('/etch/#discover');
  await page.waitForSelector('#list .as');
  ok(await page.$eval('#t-find', (e) => e.getAttribute('aria-selected') === 'true'), '#discover opens it');
  ok((await text(page, '#cnt')) === `${ASSETS.length} assets`, 'the count of assets');
  const first = await page.$$eval('#list .as-n b', (b) => b.map((x) => x.textContent));
  ok(first.length === 30, 'thirty are listed first');
  ok(first[0] === 'COIN28' && first[27] === 'COIN1', 'newest first');
  ok(!(await page.$eval('#more-r', (e) => e.hidden)), 'with more to show');
  await page.click('#more-r');
  ok((await page.$$('#list .as')).length === ASSETS.length, 'it shows the rest');
  ok(await page.$eval('#more-r', (e) => e.hidden), 'and then is gone');
  await page.waitForFunction((id) => document.querySelector(`#list .as[data-id="${id}"] .as-n small`), hex(2));
  const orange = await page.$eval(`#list .as[data-id="${hex(2)}"]`, (e) => e.textContent.replace(/\s+/g, ' '));
  ok(/Orange Coin/.test(orange), 'a name comes from the metadata');
  ok(/21,000,000/.test(orange) && /3 holders/.test(orange), 'with the supply that was published and the holders');
  ok(await page.$eval(`#list .as[data-id="${hex(2)}"] .tk img`, (i) => i.src.startsWith('https://api.tacit.finance/ipfs/')), 'and its logo through the API’s gateway');
  const noods = await page.$eval(`#list .as[data-id="${hex(5)}"]`, (e) => e.textContent.replace(/\s+/g, ' '));
  ok(/1,000,000/.test(noods) && !/Orange/.test(noods), 'whole-number supplies read without decimals');
  ok(await page.$eval(`#list .as[data-id="${hex(5)}"] .tk img`, (i) => /\/ipfs\/bafkrei/.test(i.src)), 'an image that is not metadata is the logo itself');
  ok(await page.$eval(`#list .as[data-id="${hex(5)}"] .tk`, (e) => e.firstChild.nodeType === 3 && e.textContent.trim() === 'NO'), 'its letters are under the logo while it loads');
  ok(/Supply private/.test(await page.$eval(`#list .as[data-id="${hex(6)}"]`, (e) => e.textContent)), 'a supply that is not published says it is private');
  await shot(page, 'discover');
  // search
  await type(page, '#find', 'tac');
  await page.waitForFunction(() => document.querySelector('#cnt').textContent !== '');
  const hits = await page.$$eval('#list .as', (r) => r.map((x) => `${x.querySelector('.as-n').textContent.trim()} | ${x.querySelector('.as-t > small').textContent.trim()}`));
  ok((await text(page, '#cnt')) === '4 found', 'a ticker is found by its letters (TAC ×3, TACIT)');
  ok(/^TAC✓ \|/.test(hits[0]), 'the listed asset leads the exact ticker');
  ok(/Ticker used by an earlier asset/.test(hits[1]) && /Ticker used by an earlier asset/.test(hits[2]), 'the later ones say another used it before');
  ok(!/Ticker used by an earlier asset/.test(hits[0]), 'the first does not');
  ok(/^TACIT \|/.test(hits[3]), 'longer tickers follow');
  ok((await page.evaluate(() => location.hash)) === '#discover=tac', 'the address keeps the search');
  await type(page, '#find', 'orange coin');
  ok((await text(page, '#cnt')) === '1 found', 'a name is found');
  await type(page, '#find', hex(3).slice(0, 12));
  ok((await text(page, '#cnt')) === '1 found' && (await page.$eval('#list .as', (e) => e.dataset.id)) === hex(3), 'so is the start of an asset id');
  await type(page, '#find', 'zzzz');
  ok(/Nothing matches “zzzz”/.test(await text(page, '#list')), 'a search with no match says so');
  await type(page, '#find', 'noods');
  await page.click('#list .as-b');
  const d = await text(page, '#list .as-d');
  ok(d.includes(hex(5)), 'a row opens to its whole asset id');
  ok((await page.$$eval('#list .as-d a', (a) => a.map((x) => x.href))).join(' ').includes(`https://www.tacitscan.io/assets/${hex(5)}`), 'with a link to tacitscan');
  ok((await page.$$eval('#list .as-d a', (a) => a.map((x) => x.getAttribute('href')))).includes(`/classic.html#tab=market&aid=${hex(5)}`), 'and to its order book');
  ok(await page.$eval('#list .as-b', (e) => e.getAttribute('aria-expanded') === 'true'), 'and says it is open');
  await page.click('#list .as-b');
  ok(await page.$eval('#list .as-d', (e) => e.hidden), 'a second press closes it');
  ok(errs.length === 0 && csp.length === 0, 'no errors or refused requests' + (errs[0] || csp[0] ? `: ${errs[0] || csp[0]}` : ''));
  await page.close();
}
{
  const { page } = await fresh('/etch/#discover=orange');
  await page.waitForSelector('#list .as');
  ok((await page.inputValue('#find')) === 'orange' && (await text(page, '#cnt')) === '1 found', '#discover=orange opens the search on that word');
  await page.focus('#t-find');
  await page.keyboard.press('ArrowLeft');
  ok(await page.$eval('#t-create', (e) => e.getAttribute('aria-selected') === 'true'), 'the arrow keys move between the two');
  ok((await page.evaluate(() => location.hash)) === '', 'and the address follows');
  await page.close();
}
console.log('\nA phone:');
{
  const { page } = await fresh('/etch/', { width: 390, height: 800 });
  await type(page, '#tk', 'orange');
  await type(page, '#sup', '1000000000');
  await page.click('#more > summary');
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  ok(w.s <= w.c, `no sideways scroll (${w.s} in ${w.c})`);
  await shot(page, 'phone-create');
  await page.click('#t-find');
  await page.waitForSelector('#list .as');
  const w2 = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  ok(w2.s <= w2.c, `nor in Discover (${w2.s} in ${w2.c})`);
  await shot(page, 'phone-discover');
  await page.close();
}
{
  const { page } = await fresh('/etch/', { width: 1100, height: 1000 }, 'dark');
  await type(page, '#tk', 'orange');
  await type(page, '#sup', '1000000');
  await shot(page, 'dark-create');
  await page.click('#t-find');
  await page.waitForSelector('#list .as');
  await shot(page, 'dark-discover');
  await page.close();
}

await b.close();
server.close();
console.log(`\n${n} ok, ${fails} failed`);
process.exit(fails ? 1 : 0);
