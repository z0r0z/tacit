// /pay's TAC Send when the relay quoted on load and then cannot take the payment: the page asks on the status line before
// posting it from the key's Bitcoin address. "Not now" sends nothing; leaving the question unanswered (its ten minutes
// shortened here) is a no; a second writer to the status line does not remove it; "Post it from my Bitcoin address" goes
// on to prove the payment (stopped here at the prover's download). The pool, the relay and the explorers are stubbed,
// and nothing is broadcast.
//   PLAYWRIGHT=<path to playwright-core> [SHOTS=<dir>] node tests/pay-tac-ask-self.browser.mjs

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const secret = await import('../dapp/sats/secret.js');
const { poseidon2 } = await import('../dapp/vendor/tacit-poseidon.min.js');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const local = [];
const server = createServer((r, res) => {
  const path = decodeURIComponent(new URL(r.url, 'http://x').pathname);
  if (path.startsWith('/btc-pool/')) { local.push(path); res.writeHead(404); return res.end(); }    // the prover's files
  let f = normalize(join(DAPP, path));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok  ' : 'FAIL', m); };
const keyOf = () => { let k; do { k = randomBytes(32); } while (k[0] === 0 || k[0] > 0xf0); return k.toString('hex'); };
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

const TAC = '0x' + secret.TAC_ASSET_MAINNET, H = 970600;
const H_ = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const json = (r, status, body) => r.fulfill({ status, contentType: 'application/json', headers: H_, body: JSON.stringify(body) });

// A browser with the pool, the relay and the explorers stubbed: key A holds one 1 TAC note, B is the recipient.
async function stubbed(answer) {
  const A = keyOf(), B = keyOf();
  const pw = secret.poolWalletFor(hexToBytes(A), 'mainnet');
  const to = secret.poolWalletFor(hexToBytes(B), 'mainnet').addressString;
  const note = secret.pool.createNote(pw.addressString, TAC, 100_000_000n);
  // The pool's tree has Poseidon empty-subtree hashes; the page works its paths out from the feed and checks the root the replay gives for the anchor.
  const Z = [0n]; for (let i = 1; i < 32; i++) Z.push(poseidon2([Z[i - 1], Z[i - 1]]));
  const zeros = Z.map((v) => '0x' + v.toString(16).padStart(64, '0')), root = secret.pool.merkleRootFrom(note.leaf, 0, zeros);
  const feed = [{ leafIndex: 0, txid: 'ab'.repeat(32), height: H - 100, leaf: note.leaf, asset: note.asset, pk_eph: note.pkEph, ct_note: note.ctNote }];
  const seen = { posts: [], relay: [] };
  let relayDown = false;

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
  // The ten-minute wait for an answer, shortened for the run where nothing is pressed.
  if (answer === 'none') await ctx.addInitScript(() => { const st = window.setTimeout; window.setTimeout = (fn, ms, ...a) => st(fn, ms === 600000 ? 300 : ms, ...a); });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route(/mempool\.space|blockstream\.info|mempool\.emzy\.de|mempool\.bitaroo\.net/, (r) => {
    const u = new URL(r.request().url()), path = u.pathname.replace(/^\/(signet\/)?api/, '');
    if (r.request().method() === 'POST') { seen.posts.push(u.href); return r.fulfill({ status: 500, headers: H_, body: 'not in this check' }); }
    if (/fees\/recommended/.test(path)) return json(r, 200, { fastestFee: 3, halfHourFee: 2, hourFee: 2, economyFee: 1, minimumFee: 1 });
    if (/fee-estimates/.test(path)) return json(r, 200, { 1: 3, 3: 2, 6: 2, 144: 1 });
    if (/blocks\/tip\/height/.test(path)) return r.fulfill({ status: 200, headers: H_, body: String(H) });
    if (/\/address\/[^/]+\/utxo$|\/(address|scripthash)\/[^/]+\/txs/.test(path)) return json(r, 200, []);
    return r.fulfill({ status: 404, headers: H_, body: 'not found' });
  });
  await ctx.route(/api\.tacit\.finance|onrender\.com|workers\.dev/, (r) => {
    if (r.request().method() !== 'GET' && r.request().method() !== 'OPTIONS') seen.posts.push(r.request().url());
    return json(r, 200, []);
  });
  await ctx.route(/^https:\/\/tacit-btc-pool(-relay)?-mainnet\.onrender\.com\//, (r) => {
    const q = r.request(), u = new URL(q.url()), p = u.pathname;
    if (q.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: H_ });
    if (p.startsWith('/btc-pool/relay/')) {
      seen.relay.push(`${q.method()} ${p}${relayDown ? ' (down)' : ''}`);
      if (p === '/btc-pool/relay/info' && !relayDown) return json(r, 200, { fees: { [TAC]: '1000' }, carrierVb: 1300 });
      return json(r, 503, { error: 'unavailable' });
    }
    if (p === '/btc-pool/status') return json(r, 200, { height: H, halted: false });
    if (p === '/btc-pool/notes') return json(r, 200, Number(u.searchParams.get('from') || 0) === 0 ? { notes: feed, next: 1 } : { notes: [], next: 1 });
    if (/^\/btc-pool\/root\/\d+$/.test(p)) return json(r, 200, { root, retained: true });
    if (p === '/btc-pool/nullifiers') return json(r, 200, { nullifiers: [], next: null });
    const m = p.match(/^\/btc-pool\/path\/0$/);
    if (m) { const at = Number(u.searchParams.get('at')); return json(r, 200, { leaf: note.leaf, hAnchor: at, root, path: zeros }); }
    if (p === '/sp/hints') return json(r, 200, { hints: [], next: null });
    return json(r, 404, { error: 'not found' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { A, to, seen, b, page, errors, down: () => { relayDown = true; } };
}

async function run(answer) {
  const { A, to, seen, b, page, errors, down } = await stubbed(answer);
  await page.goto(ORIGIN + '/pay/#tac');
  await page.waitForSelector('#g-in [data-in="paste"]', { state: 'attached' });
  await page.evaluate(() => document.querySelectorAll('details.more-in').forEach((d) => { d.open = true; }));
  await page.click('#g-in [data-in="paste"]');
  await page.fill('#g-hex', A);
  await page.click('#g-in [data-in="key"]');
  await page.waitForSelector('#tabs:not([hidden])');
  await page.waitForFunction(() => /^1(\.0+)?$/.test((document.querySelector('#bal .v')?.textContent || '').trim()), null, { timeout: 60e3 });
  ok(true, `${answer}: the stubbed shielded balance reads 1 TAC`);
  await page.fill('#f-to', to);
  await page.fill('#f-amt', '0.1');
  await page.waitForFunction(() => !document.querySelector('#f-go').disabled, null, { timeout: 30e3 });
  ok(/relay for at most/.test(await page.textContent('#form .note')) && !/If the relay can/.test(await page.textContent('#form')), `${answer}: the form offers the relay, with no hand-back line`);

  down();
  await page.click('#f-go');
  await page.waitForSelector('#status .callout.ask', { timeout: 60e3 });
  if (process.env.SHOTS) await page.locator('section.card.app').screenshot({ path: join(process.env.SHOTS, `pay-ask-${answer}.png`) }).catch(() => page.screenshot({ path: join(process.env.SHOTS, `pay-ask-${answer}.png`), fullPage: true }));
  const ask = (await page.textContent('#status .callout.ask > span')).replace(/\s+/g, ' ').trim();
  ok(/^The relay didn’t take this payment\. Post it from your Bitcoin address instead\? Your Bitcoin address shows as the sender and pays ≈ [\d,]+ sats\.$/.test(ask), `${answer}: the question: ${ask}`);
  ok(await page.$eval('#f-go', (x) => x.getAttribute('aria-busy') === 'true' && x.disabled), `${answer}: Send stays busy while it is asked`);
  await page.evaluate(() => { document.querySelector('#status').textContent = 'Checking for payments to you…'; });
  await page.waitForFunction(() => !!document.querySelector('#status .callout.ask'));
  ok(true, `${answer}: another message on the status line leaves the question on it`);
  await page.click('#tabs [data-tab="receive"]'); await page.click('#tabs [data-tab="send"]');
  ok(!!(await page.$('#status .callout.ask')) && (await page.$eval('#f-go', (x) => x.disabled)), `${answer}: switching tabs keeps the question, and Send stays off`);

  if (answer === 'no' || answer === 'none') {
    if (answer === 'no') await page.click('#status [data-ask="no"]');
    await page.waitForFunction(() => /Nothing was sent/.test(document.querySelector('#status').textContent), null, { timeout: 30e3 });
    const said = (await page.textContent('#status')).trim();
    ok(said === 'The relay can’t take this one right now. Nothing was sent.' && !(await page.$('#status .err')), `${answer}: says so plainly: ${said}`);
    await page.waitForTimeout(1500);
    ok(!seen.posts.length, `${answer}: nothing was posted (${seen.posts.join(' ') || 'none'})`);
    ok(!seen.relay.some((x) => /submit/.test(x)), `${answer}: nothing was handed to the relay (${seen.relay.join(', ')})`);
    ok(!local.length, `${answer}: nothing was proved (${local.join(' ') || 'no prover download'})`);
    ok(!(await page.$('#status .callout.ask')), `${answer}: the question is gone`);
    await page.fill('#f-to', to); await page.fill('#f-amt', '0.2');
    const back = await page.waitForFunction(() => !document.querySelector('#f-go').disabled && document.querySelector('#f-go').getAttribute('aria-busy') !== 'true', null, { timeout: 30e3 }).then(() => true, () => false);
    ok(back, `${answer}: Send works again afterwards`);
  } else {
    await page.click('#status [data-ask="yes"]');
    await page.waitForFunction(() => !document.querySelector('#status .callout.ask') && !document.querySelector('#status .spin'), null, { timeout: 90e3 }).catch(() => {});
    ok(local.length > 0, `yes: it goes on to prove the payment (${local[0] || 'no prover read'})`);
    ok(!seen.posts.length, `yes: nothing broadcast in this check (${seen.posts.join(' ') || 'none'}); the status ends: ${(await page.textContent('#status')).trim().slice(0, 120)}`);
  }
  ok(!errors.length, `${answer}: no page errors ${errors.join(' | ')}`);
  await b.close();
}

// /tac now hosts the Tacit-chain dashboard; its former Bitcoin Send form is no longer served.
// The live Bitcoin relay-fallback flow is exercised above through /pay/#tac for no, timeout and yes.

try {
  for (const a of ['no', 'none', 'yes']) await run(a);
} finally { server.close(); }
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
