#!/usr/bin/env node
// dapp/etch/ with its real wallet door (/trade/btc.js, its sign-in sheet and its Add sats sheet) and only the key session and tacit.js behind it stubbed: how a key
// that holds sats at its address, sats in silent payments, a Bitcoin wallet's sats, or none, gets to an etch.
//   checks: opening the key with a Bitcoin wallet and then funding from that wallet in one press (the wallet's own transfer to the key's address); a key opened another
//   way is offered the address alone; silent payments are counted, shown and moved to the address by the etch's own press; a balance that has arrived since it was read
//   is not spent on by the press that finds it (the button changes and waits); coming back to the page reads the balance again.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/etch-funding.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
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

// The key session and tacit.js: a key opened through the sheet, a few sats, and the calls the page makes recorded.
const SESSION = `
const W = window.__w = { calls: [], sats: 0, silent: 0, need: 4000 };
const rec = (name, args) => W.calls.push({ name, args });
const ADDR = 'bc1qtestaddress0000000000000000000000000';
let key = null; const listeners = new Set(); const emit = () => listeners.forEach((f) => f());
const T = {
  wallet: { pub: new Uint8Array(33), address: () => ADDR },
  hash160: () => new Uint8Array(20), bytesToHex: () => 'ab'.repeat(20),
  getUtxos: async () => (W.sats ? [{ txid: 'ee'.repeat(32), vout: 0, value: W.sats }] : []),
  scanHoldings: async () => new Map(), bridgedAtTaproot: () => { if (W.readFails > 0) { W.readFails--; throw new Error('the read failed'); } return Promise.resolve({ count: 0 }); },
  extWallet: {
    state: null,
    connectDefault: async () => { rec('connect', {}); T.extWallet.state = { provider: 'sats-connect', address: W.testnet ? 'tb1qext' : 'bc1qext' }; return T.extWallet.state; },
    sendSats: async (to, n) => { rec('sendSats', { to, n }); if (W.refuse) throw new Error('User rejected the request'); W.sats += n; return 'ab'.repeat(32); },
  },
  etchQuote: async () => { if (W.slow) await new Promise((r) => setTimeout(r, W.slow)); return { rate: 5, fee: 2100, need: W.need }; },
  silentSats: async () => W.silent,
  gatherSats: async (n) => { rec('gather', n); W.sats += n; W.silent -= n; return 'dd'.repeat(32); },
  etchAsset: async (o) => { rec('etch', { ticker: o.ticker, supply: String(o.supply), decimals: o.decimals }); return { commitTxid: 'c1'.repeat(32), revealTxid: 'e2'.repeat(32), assetIdHex: 'a7'.repeat(32), metadataPinned: true, supplyPublished: true }; },
};
const opener = (mode) => async () => { key = { mode, pubHex: '02' + 'ab'.repeat(32), address: 'bc1qext' }; if (mode === 'btc') T.extWallet.state = { provider: 'sats-connect', address: 'bc1qext' }; emit(); };
export const short = (a) => a;
export class Cancelled extends Error { constructor() { super('Cancelled.'); this.unlockCancelled = true; } }
export function makeBtcSession() {
  return {
    load: async () => T, get T() { return T; }, get key() { return key; }, get unlocked() { return !!key; }, get address() { return key ? ADDR : null; },
    known: () => null, other: () => null, passkeyAvailable: () => !!W.pk, btcSeen: () => !W.noBtc, ethAvailable: () => true,
    turn: (fn) => Promise.resolve().then(fn),
    open: { btc: opener('btc'), eth: opener('eth'), passkey: opener('passkey'), newPasskey: opener('passkey') },
    lock() { key = null; emit(); }, onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const SHOTS = process.env.SHOTS || '';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const b = await chromium.launch();
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim());
const calls = (page, name) => page.evaluate((nm) => window.__w.calls.filter((c) => c.name === nm), name);
const label = (page) => text(page, '#go');
const type = async (page, sel, v) => { await page.fill(sel, ''); await page.type(sel, v, { delay: 5 }); };

async function fresh(w = {}) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.route(/^https:\/\/api\.coinbase\.com\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ data: { amount: '100000' } }) }));
  await page.route(/\/trade\/btc-session\.js/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: SESSION }));
  await page.goto(`${BASE}/etch/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tk');
  await type(page, '#tk', 'orange');
  await type(page, '#sup', '1000');
  await page.waitForFunction(() => window.__w);
  await page.evaluate((o) => Object.assign(window.__w, o), w);
  return { page, errs };
}
async function signIn(page, way) {
  await page.click('#go');
  await page.waitForSelector(`.bsheet [data-in="${way}"]`);
  await page.click(`.bsheet [data-in="${way}"]`);
  await page.waitForFunction(() => !document.querySelector('.bsheet'));
}

console.log('A key opened with a Bitcoin wallet, with no sats:');
{
  const { page, errs } = await fresh({ sats: 0 });
  await signIn(page, 'btc');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  ok(true, 'the button says Add sats');
  ok(/Needs about 4,000 sats( \(≈ \$4\.00\))? at your wallet’s address\. It holds 0\./.test(await text(page, '#q')), 'and the line says how many, and what that is in dollars');
  await page.click('#go');
  await page.waitForSelector('.bsheet [data-send]');
  ok(/Add sats/.test(await text(page, '.bsheet h2')), 'a sheet opens');
  ok((await text(page, '.bsheet [data-send]')) === 'Send 5,000 sats (≈ $5.00) from your Bitcoin wallet', 'offering that wallet’s own transfer, in whole 500s and not under 5,000, with what it is worth');
  ok(/bc1qtestaddress/.test(await text(page, '.bsheet .addr')) && !!(await page.$('.bsheet [data-copy]')), 'beside the address to copy');
  await page.waitForSelector('.bsheet svg.qr');
  await shot(page, 'fund-sheet');
  ok(true, 'a code of the address to scan');
  ok((await page.$eval('.bsheet [data-open]', (a) => a.getAttribute('href'))) === 'bitcoin:bc1qtestaddress0000000000000000000000000?amount=0.00005000', 'and a link that opens a wallet app with the amount filled in');
  ok((await calls(page, 'sendSats')).length === 0, 'nothing is sent by opening it');
  await page.click('.bsheet [data-send]');
  await page.waitForFunction(() => window.__w.calls.some((c) => c.name === 'sendSats'));
  const s = (await calls(page, 'sendSats'))[0].args;
  ok(s.to === 'bc1qtestaddress0000000000000000000000000' && s.n === 5000, 'the wallet is asked for 5,000 sats to the key’s address');
  await page.waitForFunction(() => !document.querySelector('.bsheet'), null, { timeout: 20000 });
  ok(true, 'the sheet closes once the address shows them');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch ORANGE');
  ok((await calls(page, 'etch')).length === 0, 'and the etch waits for its own press');
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  ok((await calls(page, 'etch')).length === 1, 'which etches');
  ok(errs.length === 0, 'no script errors' + (errs[0] ? `: ${errs[0]}` : ''));
  await page.close();
}
{
  const { page } = await fresh({ sats: 0, refuse: true });
  await signIn(page, 'btc');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.click('#go');
  await page.click('.bsheet [data-send]');
  await page.waitForFunction(() => /Nothing was sent/.test(document.querySelector('.bsheet [data-st]')?.textContent || ''));
  ok(!(await page.$eval('.bsheet [data-send]', (e) => e.disabled)), 'a transfer declined in the wallet says nothing was sent, and can be asked again');
  await page.close();
}

console.log('\nA key opened another way:');
{
  const { page } = await fresh({ sats: 0 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.click('#go');
  await page.waitForSelector('.bsheet [data-send]');
  ok(/^Send 5,000 sats \(≈ \$5\.00\) from your Bitcoin wallet$/.test(await text(page, '.bsheet [data-send]')), 'is offered a Bitcoin wallet to send from, as one opened with a Bitcoin wallet is');
  ok((await calls(page, 'connect')).length === 0, 'which is not connected until it is asked for');
  await page.click('.bsheet [data-send]');
  await page.waitForFunction(() => window.__w.calls.some((c) => c.name === 'sendSats'));
  ok((await calls(page, 'connect')).length === 1 && (await calls(page, 'sendSats'))[0].args.n === 5000, 'it is connected, and asked for 5,000 sats to the key’s address');
  await page.waitForFunction(() => !document.querySelector('.bsheet'), null, { timeout: 20000 });
  ok(true, 'and the sheet closes when they show');
  await page.close();
}

console.log('\nSats in silent payments:');
{
  const { page } = await fresh({ sats: 0, silent: 40000 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => /silent payments/.test(document.querySelector('#q').textContent));
  ok((await label(page)) === 'Etch ORANGE', 'they count: the button offers the etch, not Add sats');
  ok(/In your wallet0 sats \+ 40,000 silent/.test((await page.$$eval('#rcpt div', (d) => d.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))).join('|')), 'the receipt shows them');
  ok(/silent payments: etching first moves them to your wallet’s address, in one more transaction/.test(await text(page, '#q')), 'and says what the press does');
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  const order = await page.evaluate(() => window.__w.calls.filter((c) => c.name === 'gather' || c.name === 'etch').map((c) => c.name));
  ok(order.join() === 'gather,etch', `they are moved first, then the etch is sent (${order})`);
  ok((await calls(page, 'gather'))[0].args === 4000, 'enough to cover what the etch needs');
  await page.close();
}
{
  const { page } = await fresh({ sats: 0, silent: 4500 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  ok(true, 'silent payments that leave too little after the move are not counted as enough');
  await page.close();
}

console.log('\nSats that arrive after the balance was read:');
{
  const { page } = await fresh({ sats: 0 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.evaluate(() => { window.__w.sats = 60000; });
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch ORANGE');
  ok((await calls(page, 'etch')).length === 0 && !(await page.$('.bsheet')), 'the press that finds them changes the button and sends nothing');
  await page.click('#go');
  await page.waitForSelector('#done:not([hidden])');
  ok((await calls(page, 'etch')).length === 1, 'the next press etches');
  await page.close();
}
{
  const { page } = await fresh({ sats: 0 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.evaluate(() => { window.__w.sats = 60000; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch ORANGE', null, { timeout: 8000 });
  ok(true, 'coming back to the page reads the balance again, and the button follows');
  ok((await calls(page, 'etch')).length === 0, 'with nothing sent');
  await page.close();
}


console.log('\nA button pressed twice:');
{
  const { page } = await fresh({ sats: 60000, slow: 600 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch ORANGE');
  await page.click('#go');
  await page.evaluate(() => document.querySelector('#form').requestSubmit());      // Enter in a field, or a second press, while the first is still being prepared
  await page.evaluate(() => document.querySelector('#go').click());
  await page.waitForSelector('#done:not([hidden])');
  await page.waitForTimeout(1200);
  ok((await calls(page, 'etch')).length === 1, 'is one etch, not two');
  await page.close();
}

console.log('\nA form changed while the etch is prepared:');
{
  const { page } = await fresh({ sats: 60000, slow: 800 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch ORANGE');
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#go').disabled);
  ok(await page.$eval('#edit', (e) => e.inert), 'the form is put out of reach while it runs');
  await page.evaluate(() => { document.querySelector('#sup').value = '999'; document.querySelector('[data-d="0"]').click(); });     // changed behind the page's back
  await page.waitForSelector('#done:not([hidden])');
  const e = (await calls(page, 'etch'))[0].args;
  ok(e.supply === '100000000000' && e.decimals === 8, `what is etched is what was on the form at the press (${e.supply}, ${e.decimals} decimals)`);
  ok(/1,000 ORANGE/.test(await text(page, '#done .kvs')), 'and what is said to be etched');
  await page.close();
}

console.log('\nA failed read while sats are on their way:');
{
  const { page } = await fresh({ sats: 0 });
  await signIn(page, 'btc');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.click('#go');
  await page.waitForSelector('.bsheet [data-send]');
  await page.evaluate(() => { window.__w.readFails = 1; });
  await page.click('.bsheet [data-send]');
  await page.waitForFunction(() => !document.querySelector('.bsheet'), null, { timeout: 20000 });
  ok(true, 'the sheet still closes once they show: a read that fails is tried again');
  await page.close();
}

console.log('\nSats sent from somewhere else:');
{
  const { page } = await fresh({ sats: 0, need: 4000 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.click('#go');
  await page.waitForSelector('.bsheet [data-qr] svg');
  ok(/Waiting for the sats to arrive/.test(await text(page, '.bsheet [data-st]')), 'the sheet says it is waiting');
  await page.evaluate(() => { window.__w.sats = 1500; });                    // a phone or an exchange sends part of it
  await page.waitForFunction(() => /Received 1,500 sats\. About 2,500 more are needed\./.test(document.querySelector('.bsheet [data-st]')?.textContent || ''), null, { timeout: 20000 });
  ok(!!(await page.$('.bsheet')), 'a part of it is said, with what is still needed, and the sheet stays');
  await page.evaluate(() => { window.__w.sats = 6000; });
  await page.waitForFunction(() => !document.querySelector('.bsheet'), null, { timeout: 20000 });
  ok(true, 'the rest closes it');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Etch ORANGE');
  ok((await calls(page, 'etch')).length === 0, 'and the etch waits for its own press');
  await page.close();
}
{
  const { page } = await fresh({ sats: 0, testnet: true });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.click('#go');
  await page.click('.bsheet [data-send]');
  await page.waitForFunction(() => /test network/.test(document.querySelector('.bsheet [data-st]')?.textContent || ''));
  ok((await calls(page, 'sendSats')).length === 0, 'a Bitcoin wallet on a test network is told to switch, and nothing is sent');
  await page.close();
}
{
  const { page } = await fresh({ sats: 0, noBtc: true });
  await signIn(page, 'eth');
  await page.waitForFunction(() => document.querySelector('#go').textContent === 'Add sats');
  await page.click('#go');
  await page.waitForSelector('.bsheet [data-qr]');
  ok(!(await page.$('.bsheet [data-send]')), 'with no Bitcoin wallet in the browser there is no button for one, only the address, its code and the app link');
  await page.close();
}

console.log('\nThe first sign-in:');
{
  const { page } = await fresh({ pk: true });
  await page.click('#go');
  await page.waitForSelector('.bsheet [data-in]');
  await shot(page, 'signin-sheet');
  const ways = await page.$$eval('.bsheet [data-in]', (b) => b.map((x) => x.dataset.in));
  ok(ways[0] === 'btc' && (await page.$eval('.bsheet [data-in="btc"]', (b) => b.classList.contains('main'))), 'a Bitcoin wallet in the browser comes first, as the way in');
  ok(/to etch an asset on Bitcoin\. It comes from a signature or a passkey, so there is nothing to back up/.test(await text(page, '.bsheet .lede-s')), 'the sheet says what it is for, and that there is nothing to back up');
  ok(/^No wallet yet\? Create one/.test(await text(page, '.bsheet [data-in="new"]')), 'and a visitor with no wallet is shown the way to make one');
  await page.close();
}
{
  const { page } = await fresh({ noBtc: true });
  await page.click('#go');
  await page.waitForSelector('.bsheet [data-in]');
  const ways = await page.$$eval('.bsheet [data-in]', (b) => b.map((x) => x.dataset.in));
  ok(ways[0] === 'eth' && !(await page.$eval('.bsheet [data-in="btc"]', (b) => b.classList.contains('main'))), 'with none, the Ethereum wallet leads and the Bitcoin one is not pushed');
  await page.close();
}

console.log('\nWhat it costs, in dollars:');
{
  const { page } = await fresh({ sats: 60000 });
  await signIn(page, 'eth');
  await page.waitForFunction(() => /about 2,100 sats \(≈ \$2\.10\)/.test(document.querySelector('#rcpt')?.textContent || ''));
  ok(true, 'the receipt gives the fee in sats and in dollars');
  await page.click('#rcpt [data-fund]');
  await page.waitForSelector('.bsheet [data-qr]');
  ok(!!(await page.$('.bsheet')) && !(await page.$('.bsheet [data-send]')), 'its add link opens the sheet at any time, with no amount asked when nothing is short');
  await page.close();
}

await b.close();
server.close();
console.log(`\n${n} ok, ${fails} failed`);
process.exit(fails ? 1 : 0);
