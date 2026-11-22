#!/usr/bin/env node
// TAC's page has a sheet for a key's TAC on Bitcoin (dapp/index.html #tac-notes, drawn by dapp/front/tac.js tnPaint), opened from the box of its
// own over the card (Manage your TAC, #tpg-notes) and from the Bitcoin address row of All your TAC. Notes are ticked there, and one bar acts on what is ticked:
//   · Bridge is open for any ticked notes that can be bridged now, Merge for two or more of one kind (dapp/bridge-all.js planPick: one note
//     of them all), Split for one;
//   · a press shows a short card (what comes out, the Bitcoin fee) with Back and a confirm that stays shut until what it needs is read or ticked;
//   · notes Bitcoin's proof tracks and notes it does not are not merged together, and the bar says why;
//   · notes holding nothing are folded away, and notes waiting on the proof cannot be ticked.
// In a real browser under the page's own CSP, with a pasted key. The key's notes are put in place of the Bitcoin scan (tacit.js has a hook for it, and this test
// appends the line that reaches it); the reflection's state, the address's coins and the fee rates are answered here, and every other host is refused. Nothing
// is confirmed, so nothing is signed or sent.
//
//   PLAYWRIGHT=/Users/z/tacit/node_modules/playwright-core node tests/tac-notes-sheet.mjs      (DAPP=<dir> to try another build)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || new URL('../node_modules/playwright-core', import.meta.url).pathname);
const { keccak_256 } = require('@noble/hashes/sha3');
const secp = await import('@noble/secp256k1');
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
const POSTED = [];   // transactions the page broadcasts (answered with a txid; nothing leaves this machine)
const H = 900000, PROOF = 900100;
// the key's TAC on Bitcoin: three notes the proof tracks, two it does not, and one that holds nothing
const NOTES = [['a1', 600, true], ['a2', 300, true], ['a3', 250, true], ['b1', 120, false], ['b2', 80, false], ['c1', 0, true]]
  .map(([t, v, tracked]) => ({ txid: t.repeat(32), vout: 0, amount: String(BigInt(v) * 100000000n), tracked }));
const key = (txid, vout) => { const b = new Uint8Array(36); b.set(Buffer.from(txid, 'hex').reverse(), 0); new DataView(b.buffer).setUint32(32, vout, true); return '0x' + Buffer.from(keccak_256(b)).toString('hex'); };
const DUMP = { attestedHeight: PROOF, snapshot: { height: PROOF, liveTriples: NOTES.filter((x) => x.tracked).map((x) => [key(x.txid, x.vout), '0x', '0x', '0x', 0]), burnNodes: [], noteLeaves: [] } };
const coin = (t, vout, value) => ({ txid: t.repeat(32), vout, value, status: { confirmed: true, block_height: H, block_time: 1700000000 } });
let COIN = [coin('ee', 1, 250000)];
// what the TAC page's bridge reads for a note the reflection does not track, answered only for the last check: the note's own transaction, its history and the miner's rates
let LATE = false;
const OWN_SPK = '0014' + createHash('ripemd160').update(createHash('sha256').update(Buffer.from(secp.getPublicKey(KEY, true))).digest()).digest().toString('hex');
// (the cBTC lock sync reads the pool, which this test refuses; it is answered as done, so the coins the page counts as free are the address's own and the protected ones seeded below stay)
const TACIT_JS = readFileSync(join(DAPP, 'tacit.js'), 'utf8') + '\n_testSetScanHoldingsOverride(() => (globalThis.__held ? globalThis.__held() : new Map()));\n_ownLocksReserved = () => Promise.resolve();\nglobalThis.__recordSp = (o) => recordSpCredit(o);\n';

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
    if (LATE && /\/reflection\/burndep\/trace/.test(u)) return json({ ok: true, bundle: { fake: true }, hops: 1 });
    if (LATE && /slipstream\.mara\.com\/api\/rates/.test(u)) return json({ effective_rate: 8, submit_fee_rate: 8, market_rate: 4, multiplier: 2, slipstream_rate: 8, discounted_multiplier: 2 });
    if (LATE && /\/tx\/[0-9a-f]{64}(\?|$)/.test(u)) return json({ status: { confirmed: true, block_height: H, block_time: 1700000000 }, vout: [{ scriptpubkey: OWN_SPK, value: 546 }] });
    if (/\/address\/[^/]+\/utxo/.test(u)) return json(COIN);
    if (/\/scripthash\/|\/address\/[^/]+\/txs/.test(u)) return json([]);   // the lock sync reads the address's history: none
    if (r.request().method() === 'POST' && /\/tx$/.test(u)) { POSTED.push(r.request().postData()); return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/plain' }, body: 'ab'.repeat(32) }); }
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
  await page.evaluate(() => document.querySelectorAll('details.more-in').forEach((d) => { d.open = true; }));
  await page.click('#ws-in [data-in="paste"]');
  await page.fill('#ws-hex', KEY);
  await page.click('#ws-in [data-in="key"]');
  await page.waitForFunction(() => (document.querySelector('#wd-id')?.textContent || '').length > 12, null, { timeout: 30000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.sheet[open]'), null, { timeout: 10000 }).catch(() => {});

  const sheet = '#tac-notes', tick = '#tac-notes input[data-tn]';
  const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const at = (p) => `${tick}[data-tn^="${p}"]`;
  const isOn = (sel) => page.$eval(sel, (b) => !b.disabled).catch(() => false);
  // the sheet is drawn again as reads land, so each box is found afresh
  const setTicks = async (ps) => {
    for (const p of ['a1', 'a2', 'a3', 'b1', 'b2']) {
      const el = page.locator(at(p));
      if (await el.isDisabled().catch(() => true)) continue;
      if ((await el.isChecked()) !== ps.includes(p)) await el.click();
    }
    await page.waitForTimeout(300);
  };
  const press = async (sel) => { await page.click(sel); await page.waitForTimeout(300); };

  await page.waitForSelector('#tpg-notes:not([hidden]) [data-tn-open]', { timeout: 60000 }).catch(() => {});
  ok(/Manage your TAC/.test(await text('#tpg-notes')) && /1,350/.test(await text('#tpg-notes')) && /5 notes · 5 ready to bridge/.test(await text('#tpg-notes')), `a box of its own over the card says what is on Bitcoin: ${await text('#tpg-notes')}`);
  ok(await page.$eval('#tpg-side', (s) => s.firstElementChild?.id === 'tpg-notes' && s.lastElementChild?.id === 'tpg-card').catch(() => false), 'and it sits on top of the card, in the same column');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-page.png') });
  await page.click('#tpg-notes [data-tn-open]');
  await page.waitForSelector(`${sheet}[open] ${tick}`, { timeout: 30000 }).catch(() => {});
  ok(await page.$eval(sheet, (d) => d.open).catch(() => false), 'Manage notes opens the sheet');
  const shownTicks = await page.$$eval(tick, (es) => es.length);
  ok(shownTicks === 5 && /Show the 1 note holding no TAC/.test(await text(sheet)), `the five notes with TAC are listed, the empty one folded away (${shownTicks})`);
  ok(!(await isOn('[data-tn-act="bridge"]')) && !(await isOn('[data-tn-act="merge"]')) && !(await isOn('[data-tn-act="split"]')), 'nothing ticked, no action');

  // one note: Bridge and Split, not Merge; Split asks how much and says what stays
  await setTicks(['a2']);
  ok(await isOn('[data-tn-act="bridge"]') && await isOn('[data-tn-act="split"]') && !(await isOn('[data-tn-act="merge"]')), 'one ticked note: Bridge and Split, not Merge');
  await press('[data-tn-act="split"]');
  await page.fill('#tn-amt', '100');
  await page.waitForTimeout(200);
  ok(/Split 300 TAC/.test(await text('#tn-cf')) && /200 TAC/.test(await text('#tn-keep')), `Split shows what is split off and what stays: ${await text('#tn-cf')}`);
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('#tn-fee')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  ok(/sats|not quoted/.test(await text('#tn-fee')), `and its Bitcoin fee: ${await text('#tn-fee')}`);
  await press('[data-tn-back]');
  ok(!!(await page.$('[data-tn-act="split"]')), 'Back returns to the list');

  // two tracked notes: one note of their whole
  await setTicks(['a2', 'a3']);
  ok(await isOn('[data-tn-act="merge"]') && /2 picked · 550 TAC/.test(await text(sheet)), 'two tracked notes can be merged, and the bar says what is picked');
  await press('[data-tn-act="merge"]');
  ok(/Merge 2 notes → 1 note of 550 TAC/.test(await text('#tn-cf')) && !!(await page.$('#tn-cf #tn-auto')), `Merge shows the one note that comes out, and offers to bridge it after: ${await text('#tn-cf h3')}`);
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('#tn-fee')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  ok(/sats/.test(await text('#tn-fee')) && await isOn('#tn-go'), `its fee is read and Merge can be confirmed: ${await text('#tn-fee')}`);
  await press('[data-tn-back]');

  // three tracked notes past what the old 1,000 TAC cap allowed: still one note, there is no per-bridge cap
  await setTicks(['a1', 'a2', 'a3']);
  await press('[data-tn-act="merge"]');
  ok(/Merge 3 notes → 1 note of 1,150 TAC/.test(await text('#tn-cf h3')), `any total merges into one note: ${await text('#tn-cf h3')}`);
  await press('[data-tn-back]');

  // a tracked and an untracked note: no merge, and why
  await setTicks(['a2', 'b1']);
  ok(!(await isOn('[data-tn-act="merge"]')) && /does not track 120 TAC/.test(await text(sheet)) && await isOn('[data-tn-act="bridge"]'), 'a tracked and an untracked note are not merged together, the bar says why, and they can still be bridged');

  // two untracked notes: a merge that waits on their histories (none can be read here, so it stays shut)
  await setTicks(['b1', 'b2']);
  await press('[data-tn-act="merge"]');
  ok(/1 note of 200 TAC/.test(await text('#tn-cf h3')) && !!(await page.$('#tn-hist')), 'untracked notes merge too, after their histories are read');
  await page.waitForTimeout(1500);
  ok(!(await isOn('#tn-go')), 'and the merge stays shut until they are');
  await press('[data-tn-back]');

  // Bridge: what goes how, and a confirm that waits for the box saying it can't be undone
  await setTicks(['a2', 'a3']);
  await press('[data-tn-act="bridge"]');
  ok(/Bridge 2 notes → 550 private TAC on Ethereum/.test(await text('#tn-cf h3')), `Bridge says what arrives: ${await text('#tn-cf h3')}`);
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('#tn-fee')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  ok(!(await isOn('#tn-go')), 'Bridge stays shut until the box is ticked');
  await page.click('#tn-ack');
  ok(await isOn('#tn-go'), 'and opens once it is');
  if (process.env.SHOT) await page.locator(`${sheet} .treq-in`).screenshot({ path: process.env.SHOT.replace(/\.png$/, '-bridge.png') });
  await press('[data-tn-back]');
  await setTicks(['a1', 'a2', 'a3']);
  if (process.env.SHOT) await page.locator(`${sheet} .treq-in`).screenshot({ path: process.env.SHOT.replace(/\.png$/, '-list.png') });

  // closing, and the other way in
  await page.click(`${sheet} [data-tn-close]`);
  await page.waitForTimeout(300);
  ok(!(await page.$eval(sheet, (d) => d.open)), '× closes the sheet');
  await page.waitForSelector('#tpg-top [data-tn-top]', { timeout: 30000 }).catch(() => {});
  await page.click('#tpg-top [data-tn-top]').catch(() => {});
  await page.waitForTimeout(500);
  ok(await page.$eval(sheet, (d) => d.open).catch(() => false), 'the Bitcoin address row of All your TAC opens it too');

  // the address has a small free coin, a larger one a bridge in progress will spend and a larger one locked as collateral: a fee it cannot pay says what is there but not free
  COIN = [coin('ee', 1, 900), coin('ff', 2, 1200), coin('cc', 0, 7000), coin('dd', 0, 90000)];
  await page.evaluate(([lock, held]) => {
    localStorage.setItem('tacit-protected-outpoints-v1', JSON.stringify({ [lock]: '90000' }));
    localStorage.setItem('tacit-burndep-bridge-v1:mainnet:held-test', JSON.stringify([{ id: held, stage: 'migrate-signed', migrate: { fundingUtxo: { txid: held.split(':')[0], vout: 0, value: 7000 } } }]));
  }, [`${'dd'.repeat(32)}:0`, `${'cc'.repeat(32)}:0`]);
  await page.waitForTimeout(16000);   // the address's coins are kept for 15 s
  await setTicks(['a2', 'a3']);
  await press('[data-tn-act="merge"]');
  await page.waitForFunction(() => /short of the about/.test(document.querySelector('#tn-cf')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  const short = await text('#tn-cf');
  ok(/free for fees, short of the about [\d,]+ sats this needs\. Not counted as free: 0\.00007 BTC held for a bridge in progress \(it frees up when that bridge finishes\) and 0\.0009 BTC locked as collateral\./.test(short) && !(await isOn('#tn-go')),
    `a merge the address cannot pay the fee for says what is held for a bridge and what is locked, and stays shut: ${short.slice(short.indexOf('This key')).slice(0, 300)}`);

  // the TAC page's bridge of a note the reflection does not track (a move, then a burn through a miner), which spends one coin whole: the same address, a coin too small to pay it
  LATE = true;
  await page.click(`${sheet} [data-tn-close]`);
  await page.evaluate(() => { document.querySelector('#tpg-where').open = true; document.querySelector('#tpg-br').open = true; });
  await page.check(`#bridge-body input[value="${'b1'.repeat(32)}:0"]`);
  await page.waitForFunction(() => /one coin whole|err/.test(document.querySelector('#br-rcpt')?.textContent || ''), null, { timeout: 90000 }).catch(() => {});
  const review = await text('#br-rcpt');
  ok(/Bitcoin fee\s*≈ [\d,]+ sats, and about [\d,]+ sats for the burn later/.test(review) && /this needs one of [\d,]+ sats\. The 2 free coins there hold 0\.000021 BTC in all\. Not counted as free: 0\.00007 BTC held for a bridge in progress \(it frees up when that bridge finishes\) and 0\.0009 BTC locked as collateral\. Add bitcoin to it/.test(review),
    `its review says the largest free coin is short of the one it needs, what the free coins add up to, and what is held and locked: ${review.slice(review.indexOf('The move spends')).slice(0, 420)}`);

  // the Bitcoin sheet's balance is the free coins only (900 + 1,200 sats), and it says what else the address has
  await page.evaluate(() => { location.hash = '#bitcoin'; });
  await page.waitForSelector('#btc-re', { timeout: 30000 });
  await page.click('#btc-re');
  await page.waitForFunction(() => /Not counted in the balance/.test(document.querySelector('#btc-body')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  const bal = await text('#btc-body');
  ok(/0\.000021\s*BTC/.test(bal) && /Not counted in the balance: 0\.00007 BTC held for a bridge in progress \(it frees up when that bridge finishes\) and 0\.0009 BTC locked as collateral\./.test(bal),
    `the Bitcoin sheet's balance says what the address has that it does not count: ${bal.slice(0, 260)}`);
  // a key whose only coin is under the dust line, and whose other BTC is a silent payment (the balance above counts it, the address does not hold it): the review says the address has no free coin,
  // not that its largest holds 0 BTC, and says where the rest is
  COIN = [coin('ee', 3, 300)];
  await page.evaluate(() => { localStorage.removeItem('tacit-protected-outpoints-v1'); window.__recordSp({ txidHex: 'ab'.repeat(32), vout: 0, sats: 700, tweakHex: '11'.repeat(32), blockTime: 1700000000 }); });
  await page.waitForTimeout(16000);   // the address's coins are kept for 15 s
  await page.click('#btc-re');
  await page.waitForFunction(() => /0\.000007\s*BTC/.test(document.querySelector('#btc-body')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  ok(/0\.000007\s*BTC/.test(await text('#btc-body')), `the Bitcoin sheet's balance counts the silent payment: ${(await text('#btc-body')).slice(0, 200)}`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForFunction(() => !document.querySelector('dialog.sheet[open]'), null, { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('#tpg-where').open = true; document.querySelector('#tpg-br').open = true; });
  await page.check(`#bridge-body input[value="${'b2'.repeat(32)}:0"]`);
  await page.waitForFunction(() => /one coin whole|err/.test(document.querySelector('#br-rcpt')?.textContent || ''), null, { timeout: 90000 }).catch(() => {});
  const none = await text('#br-rcpt');
  ok(/The move spends one coin whole: this key’s Bitcoin address has no free coin, and this needs one of [\d,]+ sats\. Not counted as free: 0\.000007 BTC in silent payments, which are not coins at this address and 0\.000003 BTC in coins under 546 sats, too small to spend\. Add bitcoin to it/.test(none) && !/holds 0 BTC/.test(none),
    `with no free coin it says so, and says what the address has that does not count: ${none.slice(none.indexOf('The move spends')).slice(0, 420)}`);
  // three coins none of which is the one the move needs, that add up to it after a fee (and the silent payment above): it offers to make them one coin, and does, to this key's own address
  COIN = [coin('f1', 0, 3000), coin('f2', 0, 2500), coin('f3', 0, 800)];
  await page.waitForTimeout(16000);   // the address's coins are kept for 15 s
  await page.check(`#bridge-body input[value="${'b1'.repeat(32)}:0"]`);
  await page.waitForSelector('#br-combine', { timeout: 90000 }).catch(() => {});
  const offer = await text('#br-rcpt');
  ok(/the largest free coin on this key’s Bitcoin address holds 0\.00003 BTC/.test(offer) && /Your 3 free coins and 1 silent payment hold 0\.00007 BTC between them\. One transaction makes them one coin of 0\.0000\d+ BTC, enough for this; its network fee is about [\d,]+ sats\./.test(offer) && /Combine into one coin/.test(offer),
    `it offers to combine them, with the fee: ${offer.slice(offer.indexOf('Your 3')).slice(0, 300)}`);
  POSTED.length = 0;
  await page.click('#br-combine');
  await page.waitForFunction(() => /One coin of|err/.test(document.querySelector('#br-status')?.textContent || ''), null, { timeout: 90000 }).catch(() => {});
  const done = await text('#br-status');
  ok(/✓ One coin of 0\.0000\d+ BTC at your Bitcoin address/.test(done), `and says what it made: ${done.slice(0, 200)}`);
  ok(POSTED.length >= 1 && POSTED[0].slice(12, 14) === '04' && POSTED[0].includes(OWN_SPK) && POSTED[0].split(OWN_SPK).length === 2, `it broadcast one transaction, four inputs and a single output to this key (${POSTED.length} posted)`);
  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  await ctx.close();
} finally {
  await browser.close(); server.close();
}
console.log(fails ? `\n${fails} FAILED, ${n} ok` : `\ntac notes sheet checks passed (${n})`);
process.exit(fails ? 1 : 0);
