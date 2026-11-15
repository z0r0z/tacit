#!/usr/bin/env node
// TAC's page lists a key's TAC on Bitcoin right under All your TAC (dapp/index.html #tpg-br, drawn by dapp/front/tac.js renderBridgeIn), and a holder ticks notes there:
//   · the list opens by itself once the key's notes are read, and the Bitcoin address row of All your TAC links to it;
//   · one ticked note is the bridge it always was (its receipt and Bridge button), with a row under it to split some of it off;
//   · several ticked notes are one merge to the key's own address (dapp/bridge-all.js planPick): one note when they come to 1,000 TAC or less, else 1,000 and
//     the rest, said before anything is sent, with the Bridge button out of the way;
//   · notes Bitcoin's proof tracks and notes it does not are not merged together, and the page says which are which.
// In a real browser under the page's own CSP, with a pasted key. The key's notes are put in place of the Bitcoin scan (tacit.js has a hook for it, and this test
// appends the line that reaches it); the reflection's state, the address's coins and the fee rates are answered here, and every other host is refused. Nothing is sent.
//
//   PLAYWRIGHT=/Users/z/tacit/node_modules/playwright-core node tests/tac-bridge-pick.mjs      (DAPP=<dir> to try another build)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || new URL('../node_modules/playwright-core', import.meta.url).pathname);
const { keccak_256 } = require('@noble/hashes/sha3');
const DAPP = process.env.DAPP || new URL('../dapp/', import.meta.url).pathname;
const PORT = 33000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

const KEY = '11'.repeat(31) + '22', TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const H = 900000, PROOF = 900100;
// the key's TAC on Bitcoin: three notes the proof tracks, two it does not, and one that holds nothing
const NOTES = [['a1', 600, true], ['a2', 300, true], ['a3', 250, true], ['b1', 120, false], ['b2', 80, false], ['c1', 0, true]]
  .map(([t, v, tracked]) => ({ txid: t.repeat(32), vout: 0, amount: String(BigInt(v) * 100000000n), tracked }));
const key = (txid, vout) => { const b = new Uint8Array(36); b.set(Buffer.from(txid, 'hex').reverse(), 0); new DataView(b.buffer).setUint32(32, vout, true); return '0x' + Buffer.from(keccak_256(b)).toString('hex'); };
const DUMP = { attestedHeight: PROOF, snapshot: { height: PROOF, liveTriples: NOTES.filter((x) => x.tracked).map((x) => [key(x.txid, x.vout), '0x', '0x', '0x', 0]), burnNodes: [], noteLeaves: [] } };
const COIN = [{ txid: 'ee'.repeat(32), vout: 1, value: 250000, status: { confirmed: true, block_height: H, block_time: 1700000000 } }];
const TACIT_JS = readFileSync(join(DAPP, 'tacit.js'), 'utf8') + '\n_testSetScanHoldingsOverride(() => (globalThis.__held ? globalThis.__held() : new Map()));\n';

const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, serviceWorkers: 'block' });
  await ctx.addInitScript(([tac, notes, h]) => {
    const utxos = notes.map((x) => ({ utxo: { txid: x.txid, vout: x.vout, value: 546, status: { confirmed: true, block_height: h } }, amount: BigInt(x.amount), blinding: 1n }));
    window.__held = () => new Map([[tac, { assetIdHex: tac, ticker: 'TAC', decimals: 8, balance: utxos.reduce((s, u) => s + u.amount, 0n), utxos, unverified: [] }]]);
  }, [TAC, NOTES, H]);
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE)) {
      if (new URL(u).pathname === '/tacit.js') return r.fulfill({ status: 200, headers: { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }, body: TACIT_JS });
      return r.continue();
    }
    const json = (o) => r.fulfill({ status: 200, headers: CORS, body: JSON.stringify(o) });
    if (/\/reflection\/dump/.test(u)) return json(DUMP);
    if (/\/reflection\/status/.test(u)) return json({ attestedHeight: PROOF });
    if (/\/address\/[^/]+\/utxo/.test(u)) return json(COIN);
    if (/\/v1\/fees\/recommended/.test(u)) return json({ fastestFee: 4, halfHourFee: 3, hourFee: 2, economyFee: 1, minimumFee: 1 });
    if (/\/fee-estimates/.test(u)) return json({ 1: 4, 3: 3, 6: 2, 144: 1 });
    if (/\/blocks\/tip\/height/.test(u)) return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/plain' }, body: String(PROOF + 30) });
    return r.abort();
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(BASE + '/tac/', { waitUntil: 'commit' });
  await page.waitForSelector('#wallet', { timeout: 30000 });
  await page.click('#wallet');
  await page.waitForSelector('#ws-in', { timeout: 15000 });
  await page.click('#ws-in [data-in="paste"]');
  await page.fill('#ws-hex', KEY);
  await page.click('#ws-in [data-in="key"]');
  await page.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.sheet[open]'), null, { timeout: 10000 }).catch(() => {});

  const box = '#bridge-body', tick = '#bridge-body input[name="br-note"]';
  await page.waitForFunction((s) => document.querySelectorAll(s).length >= 5, tick, { timeout: 60000 }).catch(() => {});
  const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const shown = (sel) => page.$eval(sel, (e) => !e.hidden && !!(e.offsetWidth || e.offsetHeight)).catch(() => false);
  const at = (txid) => `${tick}[value="${txid}:0"]`;
  // the list is drawn again as reads land, so each box is found afresh (what is ticked is kept across a redraw: that is checked here too)
  const setTicks = async (ids) => {
    for (const x of NOTES) {
      const el = page.locator(at(x.txid));
      if (await el.isDisabled().catch(() => true)) continue;
      if ((await el.isChecked()) !== ids.includes(x.txid)) await el.click();
    }
    await page.waitForTimeout(300);
    const now = await page.$$eval(`${tick}:checked`, (es) => es.map((e) => e.value.slice(0, 64)).sort());
    if (JSON.stringify(now) !== JSON.stringify([...ids].sort())) throw new Error(`ticked ${now.map((x) => x.slice(0, 2))}, wanted ${ids.map((x) => x.slice(0, 2))}`);
  };
  const id = (p) => NOTES.find((x) => x.txid.startsWith(p)).txid;

  ok(await page.$eval('#tpg-br', (d) => d.open).catch(() => false), 'the list of TAC on Bitcoin opens by itself once the notes are read');
  ok(await page.$eval('#tpg-top', (s) => s.compareDocumentPosition(document.querySelector('#tpg-br')) & Node.DOCUMENT_POSITION_FOLLOWING).catch(() => false), 'and it sits right after All your TAC');
  const types = await page.$$eval(tick, (es) => es.map((e) => e.type));
  ok(types.length === NOTES.length && types.every((t) => t === 'checkbox'), `each note is ticked, not picked from a radio group (${types.join(',')})`);
  ok(await page.$eval(at(id('c1')), (e) => e.disabled).catch(() => false), 'the note that holds nothing cannot be ticked');
  await page.waitForSelector('#tpg-top [data-th="bridge:in"]', { timeout: 30000 }).catch(() => {});
  ok(/Bridge, merge or split it/.test(await text('#tpg-top [data-th="bridge:in"]')), 'the Bitcoin address row of All your TAC links to the list');

  // one note: the bridge as before, and a row to split some off
  await setTicks([id('a2')]);
  await page.waitForSelector('#br-pickp #brsp-pick', { timeout: 15000 }).catch(() => {});
  ok(await shown('#br-pickp #brsp-pick') && /Or split it/.test(await text('#br-pickp')), 'one ticked note has a split row under it');
  ok(await shown('#br-go'), 'and the Bridge button is there for it');

  // two tracked notes under the cap: one note of their whole
  await setTicks([id('a2'), id('a3')]);
  await page.waitForSelector('#br-pick-go', { timeout: 15000 }).catch(() => {});
  let t = await text('#br-pickp');
  ok(/Merge\s*2 notes, 550 TAC/.test(t) && /One note of 550 TAC/.test(t), `two tracked notes merge into one: ${t.slice(0, 160)}`);
  ok(!(await shown('#br-go')), 'the Bridge button steps aside for a merge');
  ok(/Merge 2 notes/.test(await text('#br-pick-go')), 'the button says what it does');
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('#br-pickfee')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  ok(/sats|not quoted/.test(await text('#br-pickfee')), `the Bitcoin fee is read: ${await text('#br-pickfee')}`);

  // three tracked notes over the cap: 1,000 and the rest
  await setTicks([id('a1'), id('a2'), id('a3')]);
  await page.waitForFunction(() => /1,000 TAC and 150 TAC/.test(document.querySelector('#br-pickp')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  t = await text('#br-pickp');
  ok(/1,000 TAC and 150 TAC, two notes/.test(t), `over 1,000 TAC: the cap and the rest, in one transaction: ${t.slice(0, 200)}`);
  ok(!!(await page.$('#br-pickp #br-prepauto')), 'and it can bridge them for the holder once ready');
  if (process.env.SHOT) await page.locator('#tpg-br').screenshot({ path: process.env.SHOT.replace(/\.png$/, '-merge.png') });

  // a tracked and an untracked note: refused, naming the untracked one
  await setTicks([id('a2'), id('b1')]);
  await page.waitForFunction(() => /one merge/.test(document.querySelector('#br-pickp')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  t = await text('#br-pickp');
  ok(/does not track 120 TAC/.test(t) && !(await page.$('#br-pick-go')), `notes of the two kinds are not merged, and it says which: ${t}`);

  // two untracked notes: a merge whose button waits for their histories (none can be read here, so it stays shut)
  await setTicks([id('b1'), id('b2')]);
  await page.waitForSelector('#br-pickhist', { timeout: 15000 }).catch(() => {});
  t = await text('#br-pickp');
  ok(/One note of 200 TAC/.test(t) && /History/.test(t) && /move and then a burn/.test(t), `untracked notes merge too, and say how they bridge: ${t.slice(0, 200)}`);
  await page.waitForTimeout(1500);
  ok(await page.$eval('#br-pick-go', (b) => b.disabled).catch(() => false), 'and the merge waits until each note\'s history is read');

  // unticking all puts the list back as it was
  await setTicks([]);
  ok(!(await shown('#br-pickp')), 'nothing ticked, no panel');
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  await ctx.close();
} finally {
  await browser.close(); server.close();
}
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\ntac bridge pick checks passed (${n})`);
process.exit(fails ? 1 : 0);
