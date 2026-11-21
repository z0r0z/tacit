#!/usr/bin/env node
// IMD (Identity.md, frenpet) and imdUSD in the swap card's token picker, from the hand-curated dapp/swap/extra-tokens.js:
//   file:    both rows have their exact addresses, symbols and 18 decimals; each logo is an SVG of white Helvetica text on a black background, and says its symbol; the card loads the file
//   browser: on the Shield tab's To picker and the Swap tab's Get picker, 'imd' finds both, 'imdusd' finds imdUSD, 'frenpet' finds IMD, and each full address (lower or checksummed) finds its row
//            as a listed token (no "Add" step); each row draws its own logo (an SVG data URL), not a letter
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/extra-tokens.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const DAPP = new URL('../dapp/', import.meta.url).pathname;
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const IMD = '0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7', IMDUSD = '0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25', INFER = '0x53D0eA0A685220718dC6A0a6E4617194C6f37921';

// ── the file ──
const { EXTRA } = await import(join(DAPP, 'swap/extra-tokens.js'));
const by = Object.fromEntries(EXTRA.map((t) => [t.s, t]));
ok(by.IMD?.a === IMD.toLowerCase() && by.IMD.d === 18 && /Identity\.md/.test(by.IMD.n) && /frenpet/i.test(by.IMD.n), 'IMD: its address, 18 decimals, named Identity.md and frenpet');
ok(by.imdUSD?.a === IMDUSD.toLowerCase() && by.imdUSD.d === 18, 'imdUSD: its address and 18 decimals');
ok(by.INFER?.a === INFER.toLowerCase() && by.INFER.d === 18 && /Inference/.test(by.INFER.n) && by.INFER.n.length <= 40, 'INFER: its address, 18 decimals, named Inference (the card keeps 40 characters of a name)');
ok(EXTRA.length === 3 && !!by.IMD && !!by.imdUSD && !!by.INFER, 'all three rows are there: IMD, imdUSD and INFER');
for (const [sym, t] of Object.entries(by)) {
  const m = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/.exec(t.l || ''), svg = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
  ok(!!m && t.l.length < 40000, `${sym}: the logo is a base64 SVG data URL (the card takes only those under 40,000 characters)`);
  if (sym === 'INFER') ok(/viewBox="0 0 400 400"/.test(svg) && /<rect[^>]*fill="#f6f4ef"/.test(svg) && /fill="#161f2f"/.test(svg) && !/<text/.test(svg) && svg.length < 1000, 'INFER: the project\'s I-beam mark, drawn lean from shapes (no text, under 1,000 characters)');
  else ok(/<rect[^>]*width="128"[^>]*height="128"[^>]*fill="#000"/.test(svg) && /<text[^>]*fill="#fff"[^>]*font-family="[^"]*Helvetica/.test(svg) && new RegExp(`>${sym}</text>`).test(svg), `${sym}: white Helvetica text "${sym}" on a black background, nothing else drawn`);
  ok(!/<(script|image|use|foreignObject)\b|on\w+=|href=/.test(svg), `${sym}: the SVG holds no script, link or embedded image`);
}
const card = readFileSync(join(DAPP, 'swap/card.js'), 'utf8'), want = (await import('node:crypto')).createHash('sha256').update(readFileSync(join(DAPP, 'swap/extra-tokens.js'))).digest('hex').slice(0, 8);
ok(card.includes(`import('/swap/extra-tokens.js?cb=${want}')`) && /takeList\(LIST, UNI, EXTRA\)/.test(card), 'the card imports the file under its cache token and merges it into the list');

// ── the picker ──
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = p.endsWith('/') ? join(f, 'index.html') : join(DAPP, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch(), p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(), bad = [];
const NOISE = /CORS policy|ERR_FAILED|Failed to load resource/;
p.on('pageerror', (e) => bad.push('script error: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) bad.push('console: ' + m.text().slice(0, 160)); if (/Content Security Policy/.test(m.text())) bad.push('CSP: ' + m.text().slice(0, 160)); });
await p.goto(BASE + '/', { waitUntil: 'load' });
await p.waitForSelector('#hx .go', { timeout: 40000 });
const tab = (name) => p.evaluate((t) => [...document.querySelectorAll('#hx button')].find((e) => e.innerText.trim() === t)?.click(), name);
const rows = () => p.evaluate(() => [...document.querySelectorAll('#pk .pk-r')].filter((x) => !x.hidden && !x.closest('[hidden]')).map((x) => ({ k: x.dataset.k, add: !!x.dataset.add, t: x.innerText.replace(/\s+/g, ' '), img: x.querySelector('img')?.getAttribute('src') || x.querySelector('img')?.dataset.src || '', letter: !!x.querySelector('.tk.letter, .letter') })));
async function search(q) {
  await p.fill('#pk-q', q);
  await p.waitForTimeout(900);
  return rows();
}
for (const [where, open] of [['the Shield tab\'s To picker', async () => { await tab('Shield'); await p.waitForTimeout(2000); await p.click('#get-coin'); }], ['the Swap tab\'s Get picker', async () => { await tab('Swap'); await p.waitForTimeout(2500); await p.click('#get-coin'); }]]) {
  await open();
  await p.waitForSelector('#pk:not([hidden]) .pk-r', { state: 'attached', timeout: 15000 });
  let r = await search('imd');
  const both = [IMD, IMDUSD].map((a) => r.find((x) => x.k === a.toLowerCase()));
  ok(both.every(Boolean), `${where}: 'imd' finds IMD and imdUSD`);
  ok(both.every((x) => x && /^data:image\/svg\+xml;base64,/.test(x.img) && !x.letter), `${where}: each is drawn with its own SVG logo, not a letter`);
  ok((await search('imdusd')).some((x) => x.k === IMDUSD.toLowerCase()), `${where}: 'imdusd' finds imdUSD`);
  ok((await search('frenpet')).some((x) => x.k === IMD.toLowerCase()), `${where}: 'frenpet' finds IMD`);
  r = await search('infer');
  const inf = r.find((x) => x.k === INFER.toLowerCase());
  ok(!!inf && /^data:image\/svg\+xml;base64,/.test(inf.img) && !inf.letter, `${where}: 'infer' finds INFER, drawn with its own SVG logo`);
  ok((await search('inference')).some((x) => x.k === INFER.toLowerCase()), `${where}: 'inference' finds INFER by its name`);
  for (const [name, a] of [['IMD', IMD], ['imdUSD', IMDUSD], ['INFER', INFER]]) {
    for (const form of [a, a.toLowerCase()]) {
      r = await search(form);
      ok(r.length === 1 && r[0].k === a.toLowerCase() && !r[0].add, `${where}: the address ${form === a ? '(checksummed)' : '(lower case)'} of ${name} finds its row as a listed token, with no "Add" step`);
    }
  }
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
}
await b.close(); server.close();
console.log(`\n${n} ok, ${fails} failed`);
if (bad.length) { console.log('PAGE ERRORS:\n' + bad.join('\n')); fails++; }
process.exit(fails ? 1 : 0);
