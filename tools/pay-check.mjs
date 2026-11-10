// Checks dapp/pay/index.html in a real browser.
//   live   read-only against mainnet: the page loads under its pinned CSP, a pasted key reads all four chains, the
//          history rebuilt from the key alone matches each chain's balance, forms refuse what they should, a payment
//          link fills Send, and a sample payment is proved and verified in the page's worker
//   relay  (opt-in, spends funds) KEY pays KEY2 privately on mainnet through the relay; KEY2's key alone finds it
//   fork   an anvil fork of Base (CHAIN=ethereum or robinhood for those): deposit from a wallet, send privately and withdraw part, all proved in the page and
//          sent by the wallet (no relay), then the history rebuilt from chain logs names all three
//   hub    tacit.finance/pay read-only against mainnet with KEY: links made for the ETH page before it moved open on
//          /pay/eth/; BTC and TAC balances read; each kind of address routes as it should, a tacit1 from before the pool
//          lane included (a silent payment in BTC, a shielded transfer in TAC); the receive addresses and their QR codes;
//          Activity rebuilt from the key
//   tokens an anvil fork of Ethereum: the USDC pool's deposit by permit, a private send and a withdrawal through a stubbed relay, a payment link in
//          USDC paid from a wallet with no Tacit key, and the recipient's key finding it
//   tokbase the same on an anvil fork of Base, for Base's USDC pool: each chain's pools in the asset row, the permit signed for Base, the
//          relay's send and withdrawal, and a payment link that names the chain (&chain=base)
//   poolact with KEY (the canary): its real take-out that a payment through the pool recorded (sold for 3,300 sats) shows in Activity
//          as "Paid through the pool", not as a send from its own Bitcoin address
//   poolpay read-only against mainnet with KEY (a key holding shielded TAC): BTC Send to a bc1… address switched to the shielded
//          pool shows what the recipient gets, the TAC it takes with the relay's fee, the price and how private it is; under the
//          minimum, to this wallet's own address and to a tacit1 it says why or is not offered; nothing is sent
//   btcsend no network: a silent payment through /pay's Send form to a tacit1 (both forms), captured, shown in Activity, found
//          by its recipient
//   lookfor LOCAL=1 POOL_STUB=1, transfer index and Bitcoin explorers stubbed: the shielded TAC balance's refresh also looks through the
//          asset's transfer index for payments to the key, says what came of it, and counts the transfers it could not read
//   firstrun no network: a first visit with no wallet leads with a new passkey wallet, a failed way in is said beside the options, and
//          every module a page preloads is fetched once
//   wc     no network: WalletConnect on /pay, /pay/eth and /tac over a stand-in for its bundle (tests/wc-fake.mjs): with no wallet in the browser a new wallet still
//          leads and the Ethereum wallet option names WalletConnect, a wallet app opens the key with two signatures (the page says "Approve in your wallet" while each waits),
//          a reload opens it again through the kept session, Disconnect ends the session and locks the key
//   saved  no network: the key saved in this browser, behind a passphrase, opens on /pay/ and /pay/eth/ through the passphrase
//          dialog (Escape closes it quietly, a wrong passphrase asks again)
//   anyone the same fork with a real keeper relaying: pay an 0x address now, or hold it until it blends in (after a
//          deposit made for it when the balance is short); save a name for an address; pay by link, taken by a keyless
//          recipient to their address and into another key's private balance, or taken back; the links found again
//          from the key alone
//   PLAYWRIGHT=<path to playwright-core> KEY=<64-hex Tacit key with history> [PAGE=<url>] node tools/pay-check.mjs [live,fork]   (SHOTS=<dir>)
//   LOCAL=1 [POOL_STUB=1]: a page served from this machine, with the Tacit services' answers made readable to it (see localRoutes)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const ONLY = new Set((process.argv[2] || 'live,hub,firstrun,wc,saved,fork,anyone').split(','));
const SHOTS = process.env.SHOTS || null;
const WEB = 21000 + Math.floor(Math.random() * 2000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failed++; };

const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.zkey': 'application/octet-stream' };
const server = createServer((req, res) => {
  let f = normalize(join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  const body = readFileSync(f);
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'content-length': body.length });
  res.end(body);
}).listen(WEB);
const URL_ = process.env.PAGE || `http://127.0.0.1:${WEB}/pay/eth/`;   // PAGE=https://tacit.finance/pay/ checks the deployed page

// The Tacit services answer the origin tacit.finance, not one served from this machine: LOCAL=1 gives their answers
// CORS headers, and POOL_STUB=1 (with LOCAL) answers the BTC pool services as an empty pool with no relay, for a day
// they are down. A run against a deployed page needs neither.
async function localRoutes(ctx) {
  const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  const json = (r, status, body) => r.fulfill({ status, contentType: 'application/json', headers: H, body: JSON.stringify(body) });
  await ctx.route(/^https:\/\/(tacit-[a-z0-9-]+\.onrender\.com|api\.tacit\.finance|tacit-pin\.[a-z0-9.-]+\.workers\.dev)\//, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: H });
    try { const resp = await r.fetch(); await r.fulfill({ response: resp, headers: { ...resp.headers(), ...H } }); } catch { await r.abort().catch(() => {}); }
  });
  // the later route is asked first
  if (process.env.POOL_STUB) {
    await ctx.route(/^https:\/\/tacit-btc-pool(-relay)?-mainnet\.onrender\.com\//, (r) => {
      const u = new URL(r.request().url());
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: H });
      if (u.pathname === '/btc-pool/notes') return json(r, 200, { notes: [], next: 0 });
      if (u.pathname === '/btc-pool/nullifiers') return json(r, 200, { nullifiers: [], next: null });
      if (u.pathname === '/btc-pool/status') return json(r, 200, { height: 970487, halted: false });
      if (u.pathname === '/sp/hints') return json(r, 200, { hints: [], next: null });
      return json(r, 404, { error: 'not found' });
    });
  }
}

async function page(browser, { viewport = { width: 1280, height: 900 }, colorScheme = 'light', init = null, route = null } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme, permissions: ['clipboard-read', 'clipboard-write'] });
  if (process.env.LOCAL && !/^https:/.test(URL_)) await localRoutes(ctx);
  if (init) await ctx.addInitScript(init);
  if (route) await route(ctx);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|blocked by CORS policy/.test(m.text())) errors.push(m.text()); });
  return { ctx, p, errors };
}
// Under a link's card (a request, or a payment by link) the way in is one line that opens the wallet sheet.
const openKey = async (p, key) => {
  const id = (await p.$('#g-open')) ? 'ws' : 'g';
  if (id === 'ws') await p.click('#g-open');
  await p.click(`#${id}-in [data-in="paste"]`);
  await p.fill(`#${id}-hex`, key);
  await p.click(`#${id}-in [data-in="key"]`);
  await p.waitForSelector('#tabs:not([hidden])');
};
// A QR code (the ETH page's Receive by default), drawn to a canvas in the page, decoded here when jsQR is installed
// (JSQR=<its path>).
let jsQR = null;
try { jsQR = require(process.env.JSQR || 'jsqr'); } catch {}
async function readQr(p, sel = '#f-qr svg') {
  if (!jsQR) return null;
  const { w, px } = await p.evaluate(async (sel) => {
    const svg = document.querySelector(sel), w = 600, img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: w, height: w }), g = c.getContext('2d');
    g.imageSmoothingEnabled = false; g.drawImage(img, 0, 0, w, w);
    return { w, px: [...g.getImageData(0, 0, w, w).data] };
  }, sel);
  return jsQR(Uint8ClampedArray.from(px), w, w)?.data ?? '';
}
const getPaidLink = async (p, amount, note) => {
  await p.click('#tabs [data-tab="receive"]');
  await p.waitForSelector('#f-link[data-box]:not([disabled])', { timeout: 900e3 });     // the link with its one-time deposit address
  await p.fill('#f-ramt', amount); await p.fill('#f-rfor', note); await sleep(300);
  await p.click('#f-link');
  return p.evaluate(() => navigator.clipboard.readText());
};
const shot = async (p, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: join(SHOTS, name + '.png'), fullPage: true }); };

const browser = await chromium.launch();
try {
  if (ONLY.has('live')) {
    console.log('live');
    const KEY = process.env.KEY;
    for (const [name, vp, cs] of [['desktop', { width: 1280, height: 900 }, 'light'], ['phone', { width: 390, height: 844 }, 'light'], ['phone-dark', { width: 390, height: 844 }, 'dark']]) {
      const { ctx, p, errors } = await page(browser, { viewport: vp, colorScheme: cs });
      await p.goto(URL_);
      await p.waitForSelector('#g-in');
      ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no sideways scroll`);
      await shot(p, `gate-${name}`);
      ok(!errors.length, `${name}: no page errors ${errors.join(' | ')}`);
      await ctx.close();
    }
    const { ctx, p, errors } = await page(browser);
    await p.goto(URL_ + '#pay=bp1qqqq&amount=0.01&chain=robinhood');
    await p.waitForSelector('#g-open');
    ok(await p.evaluate(() => document.querySelector('#chains [aria-selected="true"]').textContent.startsWith('Robinhood')), 'payment link picks the chain');
    if (KEY) {
      await openKey(p, KEY);
      ok(await p.evaluate(() => document.querySelector('#tabs [aria-selected="true"]').textContent === 'Send'), 'payment link opens Send');
      ok((await p.inputValue('#f-to')) === 'bp1qqqq' && (await p.inputValue('#f-amt')) === '0.01', 'payment link fills Send');
      await p.waitForFunction(() => document.querySelectorAll('#chains small .sk').length === 0, null, { timeout: 180e3 });
      const bals = await p.$$eval('#chains small', (x) => x.map((e) => e.textContent));
      ok(bals.length === 4 && bals.every((b) => /ETH|—/.test(b)), `four chain balances read: ${bals.join(' · ')}`);
      ok(await p.evaluate(() => [...document.querySelectorAll('#chains [data-chain]')].every((b) => { const u = b.querySelector('svg use'); return !!u && !!document.querySelector(u.getAttribute('href')); })), 'each chain tab shows its mark');
      await p.waitForFunction(() => !/rebuilding/.test(document.querySelector('#recover-at').textContent), null, { timeout: 300e3 });
      const sums = await p.$$eval('.chainsum li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      console.log('    ' + sums.join('\n    '));
      ok(sums.every((s) => /matches|0 ETH/.test(s)), 'history rebuilt from the key matches every chain’s balance');
      const rows = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      console.log('    ' + rows.slice(0, 8).join('\n    '));
      ok(rows.length > 0, `history rows: ${rows.length}`);
      // Send pays an 0x address (as a withdrawal to it, or a deposit first and the payment held) and refuses the pool's own.
      await p.fill('#f-amt', '0.00001'); await p.fill('#f-to', '0x' + '11'.repeat(20));
      await p.waitForFunction(() => /Arrives|Two steps/.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 60e3 }).catch(() => {});
      ok(/Arrives|Two steps keep this private/.test(await p.textContent('#f-rcpt')), `send: an 0x address is paid: ${(await p.textContent('#f-rcpt')).replace(/\s+/g, ' ').trim().slice(0, 80)}`);
      await p.fill('#f-to', '0x000000c2A20657CE25f2Ba99737933D031AFBEE9'); await sleep(300);
      ok(/cannot receive a payment/.test(await p.textContent('#f-rcpt')), 'send: the pool’s own address is refused');
      await p.fill('#f-amt', '');
      // A tacit1 from before the pool lane is explained; a unified one pays its pool address; a name without a record says so.
      const OLD = 'tacit1qqps9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxq5cns9hdj6k89clmjd77v0vqmp4vrejf8twa8jas0zhvf2edczlduk6e0c7';
      const UNI = 'tacit1qzzs9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxqngxmx5kxhvt2xqfmf4rufjqgcrgplldjykhww6nnq83gv2kcplcplm0hgggeadk2kqtqtqrk6qpedvat59c6sdeam6ankwjfjgldpjp05v82lv45dajuwype9n88tfdv4d0ta6qyvd9zzzwq58ed9pq75emyyf75';
      await p.click('#chains [data-chain="8453"]'); await p.waitForSelector('#f-to');
      await p.fill('#f-to', OLD); await sleep(600);
      ok(/before pool payments/.test(await p.textContent('#f-rcpt')), 'send: a tacit1 from before the pool lane is explained');
      await p.fill('#f-amt', '0.00001'); await p.fill('#f-to', UNI);
      await p.waitForFunction(() => /→ bp1q/.test(document.querySelector('#f-rcpt').textContent) || /More than/.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 30e3 }).catch(() => {});
      ok(/To\s*tacit1qzzs9.*→ bp1qf5rd/.test((await p.textContent('#f-rcpt')).replace(/\s+/g, ' ')) || /More than/.test(await p.textContent('#f-rcpt')), `send: a unified tacit1 pays its pool address: ${(await p.textContent('#f-rcpt')).replace(/\s+/g, ' ').trim().slice(0, 90)}`);
      await p.fill('#f-to', 'nobody-tacit-pay-check.wei');
      await p.waitForFunction(() => /has not published|could not|refus|no record/i.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 30e3 }).catch(() => {});
      ok(/has not published/i.test(await p.textContent('#f-rcpt')), `send: a name without a record says so: ${(await p.textContent('#f-rcpt')).trim().slice(0, 90)}`);
      await p.fill('#f-amt', '');
      const own = await p.evaluate(() => document.querySelector('#wallet-label .wide').textContent);
      ok(/^tacit1qzzs[a-z0-9]{6}…[a-z0-9]{6}$/.test(own), `wallet chip shows the unified address, with characters of its own after the shared prefix: ${own}`);
      // Withdraw: a partial amount shows what stays private.
      await p.click('#tabs [data-tab="withdraw"]');
      await p.click('#chains [data-chain="8453"]');
      await p.waitForSelector('#f-wto');
      await p.fill('#f-wto', '0x' + '22'.repeat(20)); await p.fill('#f-wamt', '0.000001'); await sleep(500);
      await p.waitForFunction(() => document.querySelector('.pv-h') || /More than/.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 420e3 }).catch(() => {});
      const rc = await p.textContent('#f-rcpt');
      if (/Arrives/.test(rc)) ok(/Blends in well|Could blend in better|Easy to link to you/.test(rc) && /hides among \d+ notes from \d+ deposits/.test(rc), `withdraw privacy check: ${(await p.textContent('.pv')).replace(/\s+/g, ' ').trim().slice(0, 160)}`);
      ok((/Arrives/.test(rc) && /Stays private/.test(rc)) || /More than/.test(rc), `withdraw receipt: ${rc.replace(/\s+/g, ' ').trim()}`);
      const link = await getPaidLink(p, '0.01', 'coffee & cake');
      ok(/#pay=tacit1qzz[a-z0-9]{267}&n=[0-9a-f]{64}&ns=[0-9a-f]{128}&amount=0\.01&chain=base&for=coffee/.test(link), `payment link: ${link.slice(0, 60)}…${link.slice(-50)}`);
      // A name in the link is used only once it points at this key: a name of someone else's is refused, the link keeps the address.
      await p.fill('#f-rname', 'z0r0z.wei');
      await p.waitForFunction(() => /different Tacit address|points to your address|could not|has not/i.test(document.querySelector('#f-rnote')?.textContent || ''), null, { timeout: 60e3 }).catch(() => {});
      await p.click('#f-link');
      const keep = await p.evaluate(() => navigator.clipboard.readText());
      ok(/different Tacit address/.test(await p.textContent('#f-rnote')) && /#pay=tacit1qzz/.test(keep), `a name pointing at another key is refused: ${(await p.textContent('#f-rnote')).trim()}`);
      await p.fill('#f-rname', '');
      const q = await readQr(p);
      ok(q === null || q === link, q === null ? 'QR present (install jsqr to decode it)' : 'the QR code decodes to the same link');
      const recv = await p.$$eval('.addr code', (x) => x.map((c) => c.textContent));
      ok(/^tacit1qzz/.test(recv[0]) && recv[0].length === 276, `receive shows the unified address: ${recv[0].slice(0, 16)}…`);
      ok(await p.evaluate(() => [...document.querySelectorAll('[data-copy]')].some((b) => /^bp1/.test(b.dataset.copy))), 'and still offers the pool address alone');
      await shot(p, 'key-desktop');
      const r = await page(browser, { viewport: { width: 390, height: 844 } });
      await r.p.goto(link.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
      await r.p.waitForSelector('#req:not([hidden])');
      const card = (await r.p.textContent('#req')).replace(/\s+/g, ' ');
      ok(/0\.01 ETH/.test(card) && /on Base/.test(card) && /coffee & cake/.test(card) && await r.p.$('#req-wallet') && await r.p.$('#req-priv'), `request card: ${card.slice(0, 120)}`);
      await r.p.click('#req-priv');
      await r.p.waitForSelector('#sheet-wallet[open] #ws-in', { timeout: 10e3 }).catch(() => {});
      ok(!!(await r.p.$('#sheet-wallet[open] #ws-in')) && !(await r.p.$('#form #g-in')), 'pay privately without a wallet opens the wallet sheet; under the card the way in is one line');
      await shot(r.p, 'request-phone');
      ok(!r.errors.length, `request page: no page errors ${r.errors.join(' | ')}`);
      await r.ctx.close();
    }
    // A sample payment, proved and verified in the worker (downloads the ceremony key from this server).
    const t0 = Date.now();
    await p.click('#device-try');
    await p.waitForSelector('.proof b', { timeout: 600e3 });
    ok(/s$/.test(await p.textContent('.proof b')), `sample proof: ${await p.textContent('.proof b')} (${Math.round((Date.now() - t0) / 1000)} s with key load)`);
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await shot(p, 'proved-desktop');
    await ctx.close();
  }

  if (ONLY.has('relay')) {
    // A real relayed private payment on mainnet: KEY pays KEY2 AMT ETH on CHAIN through the relay, then KEY2's key
    // alone finds it. Spends real (tiny) funds; never part of the default run.
    console.log('relay (mainnet, spends funds)');
    const { ctx, p, errors } = await page(browser, { init: `localStorage.setItem('tacit-pay-chain-v1', JSON.stringify(${JSON.stringify(process.env.CHAIN || 'robinhood')}))` });
    await p.goto(URL_);
    await p.waitForSelector('#g-in');
    await openKey(p, process.env.KEY2);
    await p.click('#tabs [data-tab="receive"]');
    const to = (await p.textContent('.addr code')).trim();
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, process.env.KEY);
    await p.click('#tabs [data-tab="send"]');
    await p.waitForFunction(() => !document.querySelector('#chains [aria-selected="true"] .sk'), null, { timeout: 180e3 });
    await p.fill('#f-to', to); await p.fill('#f-amt', process.env.AMT || '0.00001');
    await p.waitForFunction(() => !document.querySelector('#f-go').disabled, null, { timeout: 60e3 });
    console.log('    ' + (await p.textContent('#f-rcpt')).replace(/\s+/g, ' ').trim());
    const t0 = Date.now();
    await p.click('#f-go');
    await p.waitForFunction(() => /Sent/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 900e3 });
    ok(/Sent/.test(await p.textContent('#status')), `relayed private send (${Math.round((Date.now() - t0) / 1000)} s): ${(await p.textContent('#status')).trim()}`);
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, process.env.KEY2);
    await p.waitForFunction(() => [...document.querySelectorAll('.rows li')].some((l) => /Received privately/.test(l.textContent)) && !/rebuilding/.test(document.querySelector('#recover-at').textContent), null, { timeout: 300e3 }).catch(() => {});
    const rows = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    console.log('    ' + rows.join('\n    '));
    ok(rows.some((r) => /^Received privately/.test(r) && /just now|min ago/.test(r)), 'the recipient’s key alone finds the payment');
    await shot(p, 'relay-recipient');
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await ctx.close();
  }

  // The wallet's own Bitcoin address (P2WPKH of its key), to check the page refuses paying itself through the pool.
  const p2wpkhOf = async (privHex) => {
    const { secp, sha256, ripemd160 } = await import('../dapp/vendor/tacit-deps.min.js');
    const prog = ripemd160(sha256(secp.getPublicKey(privHex.replace(/^0x/, ''), true)));
    const C = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    const poly = (v) => v.reduce((c, x) => { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; G.forEach((g, i) => { if ((b >>> i) & 1) c ^= g; }); return c; }, 1);
    const data = [0]; let acc = 0, bits = 0;
    for (const x of prog) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; data.push((acc >>> bits) & 31); } }
    if (bits) data.push((acc << (5 - bits)) & 31);
    const pm = poly([3, 3, 0, 2, 3, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
    return 'bc1' + [...data, ...[0, 1, 2, 3, 4, 5].map((i) => (pm >>> (5 * (5 - i))) & 31)].map((d) => C[d]).join('');
  };
  if (ONLY.has('poolbuy')) {
    // Read-only with KEY (a key with sats at its Bitcoin address): TAC → Move lists lots to buy into the pool within those
    // sats, and a first press asks before anything is bought. Nothing is bought.
    console.log('poolbuy (/pay: buy TAC with sats into the pool, mainnet reads)');
    const origin = new URL(URL_).origin, { ctx, p, errors } = await page(browser, { colorScheme: 'dark' });
    const text = async (sel) => ((await p.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    await p.goto(origin + '/pay/#tac/move');
    await p.waitForSelector('#g-in');
    await openKey(p, process.env.KEY);
    await p.waitForSelector('#f-lots', { timeout: 120e3 });
    await p.waitForFunction(() => !/Reading the market/.test(document.querySelector('#f-lots')?.textContent || ''), null, { timeout: 180e3 });
    const lots = await text('#f-lots');
    const n = (await p.$$('#f-lots [data-buy]')).length;
    ok(n > 0 || /Nothing listed/.test(lots), `the market is read: ${lots.slice(0, 200)}`);
    if (n) {
      ok(/TAC · [\d,.]+ sats each\s*Buy for [\d,]+ sats/.test(lots), 'each lot shows its TAC, the price per TAC and what it costs');
      await p.waitForFunction(() => !document.querySelector('#f-lots [data-buy]')?.disabled, null, { timeout: 180e3 }).catch(() => {});
      await p.click('#f-lots [data-buy]');
      const st = await text('#status');
      ok(/^Buy [\d,.]+ TAC for [\d,]+ sats, plus (the|about [\d,]+ sats of) Bitcoin fee, straight into the pool\? Press again to buy\.$/.test(st), `a first press asks: ${st}`);
      await p.waitForFunction(() => /plus about [\d,]+ sats of Bitcoin fee/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 30e3 }).catch(() => {});
      ok(/plus about [\d,]+ sats of Bitcoin fee/.test(await text('#status')), `and then names the fee: ${await text('#status')}`);
      ok(/Press again to buy/.test(await text('#f-lots')), 'and the lot says to press again');
    }
    ok(/never sits at your address/.test(await text('#form')), 'it says the TAC never sits at the address');
    if (process.env.EXPECT_TAC) {
      await p.click('#tabs [data-tab="send"]');
      await p.waitForFunction((v) => (document.querySelector('#bal')?.textContent || '').replace(/\s+/g, ' ').includes(v), process.env.EXPECT_TAC, { timeout: 240e3 }).catch(() => {});
      const bal = await text('#bal');
      ok(bal.includes(process.env.EXPECT_TAC), `the bought TAC shows as this wallet's shielded balance: ${bal.slice(0, 120)}`);
    }
    ok(!errors.length, `no page errors ${errors.join(' | ').slice(0, 300)}`);
    await ctx.close();
  }
  if (ONLY.has('poolact')) {
    console.log('poolact (/pay: Activity names a payment through the pool, mainnet reads)');
    const origin = new URL(URL_).origin, { ctx, p, errors } = await page(browser, { colorScheme: 'dark' });
    const { secp, bytesToHex } = await import('../dapp/vendor/tacit-deps.min.js');
    const pub = bytesToHex(secp.getPublicKey(process.env.KEY.replace(/^0x/, ''), true));
    const TAKE = '450bad1e3be9db7f8ad05f016b4acbb10ef2b0a2bda5aca63215a931895bc57b', PAID = '804b2f168c0e83f3bfcdb48cdf68310de8e781294683b464da5cccb804f73273';
    await p.goto(origin + '/pay/#btc');
    await p.waitForSelector('#g-in');
    await p.evaluate(({ k, v }) => localStorage.setItem(k, JSON.stringify(v)), { k: 'tacit-pay-poolpay-v1:' + pub, v: [{ id: 'poolact1', to: 'bc1qvc8cvyhvare7xwg2rnws8etxaf2zk5grz8lgx3', script: '0014660f0000000000000000000000000000000051', sats: '3300', units: '2000000000', counter: 1, state: 'paid', txid: TAKE, vout: 0, paidTx: PAID, at: Date.now() }] });
    await openKey(p, process.env.KEY);
    const rows = () => p.$$eval('#act-body li', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    await p.waitForFunction((t) => [...document.querySelectorAll('#act-body li')].some((e) => e.textContent.includes(t.slice(0, 8))), TAKE, { timeout: 240e3 }).catch(() => {});
    const row = (await rows()).find((r) => r.includes(TAKE.slice(0, 8)));
    ok(!!row, `the take-out is in Activity: ${(row || '').slice(0, 200)}`);
    ok(/^Paid through the pool\s*−35 TAC/.test(row || ''), 'it is named as a payment through the pool, for what left the pool (35 TAC)');
    ok(/0\.000033 BTC for them, plus the relay’s fee/.test(row || ''), 'with the Bitcoin amount it paid and the relay’s fee');
    ok(!/posted from your Bitcoin address/.test(row || ''), 'and it no longer says it was posted from this key’s Bitcoin address');
    ok(!errors.length, `no page errors ${errors.join(' | ').slice(0, 300)}`);
    await ctx.close();
  }
  if (ONLY.has('poolpay')) {
    // BTC through the shielded TAC pool, read-only with KEY: the route is offered for a bc1… address and priced; nothing is sent.
    console.log('poolpay (/pay: BTC through the shielded pool, mainnet reads)');
    const origin = new URL(URL_).origin, { ctx, p, errors } = await page(browser);
    const text = async (sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
    const TO = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
    const UNI = 'tacit1qzzs9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxqngxmx5kxhvt2xqfmf4rufjqgcrgplldjykhww6nnq83gv2kcplcplm0hgggeadk2kqtqtqrk6qpedvat59c6sdeam6ankwjfjgldpjp05v82lv45dajuwype9n88tfdv4d0ta6qyvd9zzzwq58ed9pq75emyyf75';
    await p.goto(origin + '/pay/#btc');
    await p.waitForSelector('#g-in');
    await openKey(p, process.env.KEY);
    await p.waitForFunction(() => !document.querySelector('#bal .sk'), null, { timeout: 180e3 });
    const rcpt = async (re, ms = 120e3) => { await p.waitForFunction((s) => new RegExp(s).test(document.querySelector('#f-rcpt')?.textContent || ''), re.source, { timeout: ms }).catch(() => {}); return text('#f-rcpt'); };
    await p.fill('#f-amt', '0.0005'); await p.fill('#f-to', TO);
    ok(/Plain payment/.test(await rcpt(/Plain payment|err/)) && !!(await p.$('#f-rcpt [data-via="pool"]')), 'a bc1… payment offers the shielded pool');
    await p.click('#f-rcpt [data-via="pool"]');
    const r = await rcpt(/Sold at|err|alert/, 180e3);
    ok(/Through the shielded TAC pool/.test(r) && /They get\s*0\.0005 BTC/.test(r), `the pool route: ${r.slice(0, 160)}`);
    ok(/From your shielded TAC.*relay fee.*TAC/.test(r) && /Sold at\s*[\d,.]+ sats per TAC, 2% under the (last trade|cheapest ask)/.test(r), 'it names the TAC it takes, the relay fee and the price');
    ok(/How this stays private/.test(r), 'with how it stays private, folded');
    const tacOf = (t) => Number((t.match(/From your shielded TAC\s*([\d,.]+)/) || [])[1]?.replace(/,/g, ''));
    ok(!!(await p.$('#f-rcpt [data-speed="std"]')) && /Speed\s*Faster/.test(r), 'Faster is the default, with Standard one tap away');
    await p.click('#f-rcpt [data-speed="std"]');
    await p.waitForSelector('#f-rcpt [data-speed="fast"]', { timeout: 120e3 });
    const sRcpt = await rcpt(/Sold at/);
    ok(/Sold at\s*[\d,.]+ sats per TAC, 2% under the cheapest ask/.test(sRcpt) && tacOf(sRcpt) <= tacOf(r), `Standard prices under the cheapest ask and takes no more TAC (${tacOf(sRcpt)} against ${tacOf(r)})`);
    await p.click('#f-rcpt [data-speed="fast"]');
    await p.waitForSelector('#f-rcpt [data-speed="std"]', { timeout: 120e3 });
    const fRcpt = await rcpt(/Sold at/);
    ok(tacOf(fRcpt) === tacOf(r), 'and Faster is back to the first quote');
    ok(/^Paid from your shielded TAC/.test(await text('#f-bnote')), 'the line under the button says it is paid from shielded TAC');
    await p.click('#d-poolhow > summary');
    ok(/Halo2 proof made on this device/.test(await text('#d-poolhow')) && /amounts going in and coming out are public/.test(await text('#d-poolhow')), 'which says what it hides and what it does not');
    const enough = !/hold .* TAC shielded|at most two of your notes|relay can’t/.test(r);
    ok((await text('#f-go')) === 'Pay privately' && (await p.$eval('#f-go', (b) => b.disabled)) === !enough, `Pay privately is ${enough ? 'ready' : 'held back: ' + (r.match(/(This takes|One payment|The relay)[^.]*\./) || [''])[0]}`);
    await p.fill('#f-amt', '0.0001');
    ok(/pay 0\.0005 BTC or more/.test(await rcpt(/or more/)), 'under the minimum it says what the minimum is');
    await p.fill('#f-amt', '0.05');
    const short = await rcpt(/TAC shielded/);
    ok(/This takes [\d,.]+ TAC with the relay’s fee; you hold [\d,.]+ TAC shielded\. Get TAC with sats, then shield it under TAC → Move\./.test(short) && !!(await p.$('#f-rcpt a[href="/tac/"]')), `short of TAC it says where to get it: ${short.match(/This takes[^]*?Move\./)?.[0] || short.slice(0, 160)}`);
    await p.click('#f-rcpt [data-go-move]');
    ok(await p.waitForFunction(() => location.hash === '#tac/move' || document.querySelector('#tabs [data-tab="move"]')?.getAttribute('aria-selected') === 'true', null, { timeout: 15e3 }).then(() => true).catch(() => false), 'and TAC → Move opens from it');
    await p.goto(origin + '/pay/#btc'); await p.waitForSelector('#tabs:not([hidden])', { timeout: 60e3 });
    await p.waitForFunction(() => !document.querySelector('#bal .sk'), null, { timeout: 180e3 });
    await p.fill('#f-to', TO);
    await p.waitForFunction(() => /Through the shielded TAC pool|Plain payment/.test(document.querySelector('#f-rcpt')?.textContent || ''), null, { timeout: 120e3 });
    if (await p.$('#f-rcpt [data-via="pool"]')) await p.click('#f-rcpt [data-via="pool"]');
    await p.fill('#f-amt', '0.0005');
    const own = await p2wpkhOf(process.env.KEY);
    if (own) { await p.fill('#f-to', own); ok(/own Bitcoin address/.test(await rcpt(/own Bitcoin address|Plain/)), 'to this wallet’s own address it is refused'); }
    await p.fill('#f-to', UNI);
    const s = await rcpt(/Silent payment|More than|err/);
    ok(/Silent payment|More than/.test(s) && !(await p.$('#f-rcpt [data-via]')), `a tacit1 is not offered the pool: ${s.slice(0, 160)}`);
    await p.fill('#f-to', TO);
    await rcpt(/Through the shielded TAC pool/);
    await p.click('#f-rcpt [data-via="direct"]');
    ok(/Plain payment/.test(await rcpt(/Plain payment/)) && (await text('#f-go')) === 'Send BTC' && /^Sent from your Bitcoin address/.test(await text('#f-bnote')), 'Send it directly instead goes back');
    ok(!errors.length, `no page errors ${errors.join(' | ').slice(0, 300)}`);
    await ctx.close();
  }
  if (ONLY.has('hub')) {
    // tacit.finance/pay: BTC and TAC, read-only against mainnet with KEY; sends are routed, never made.
    console.log('hub (/pay: BTC and TAC, mainnet reads)');
    const origin = new URL(URL_).origin, { ctx, p, errors } = await page(browser);
    const text = async (sel) => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();
    const OLD = 'tacit1qqps9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxq5cns9hdj6k89clmjd77v0vqmp4vrejf8twa8jas0zhvf2edczlduk6e0c7';
    const UNI = 'tacit1qzzs9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxqngxmx5kxhvt2xqfmf4rufjqgcrgplldjykhww6nnq83gv2kcplcplm0hgggeadk2kqtqtqrk6qpedvat59c6sdeam6ankwjfjgldpjp05v82lv45dajuwype9n88tfdv4d0ta6qyvd9zzzwq58ed9pq75emyyf75';
    const BP = 'bp1qf5rdn2trtk94rqya5637yeqyvp5qllkeztth8dfesrc5x9tvqluqlahm5yyv7km9tq9s9spmdqqukkw46zudgxu7aawem8fyey0kseqh6xr40k26x7ew8zqujenn45kk2kh47aqzxxj3pp8q2rukjss02vszf7eaa';
    // Links the ETH page made before it moved keep working.
    await p.goto(origin + '/pay/#gift=' + 'ab'.repeat(32) + '&chain=base');
    await p.waitForURL(/\/pay\/eth\//, { timeout: 30e3 }).catch(() => {});
    await p.waitForSelector('#gift:not([hidden])', { timeout: 30e3 }).catch(() => {});
    ok(/\/pay\/eth\//.test(p.url()) && !!(await p.$('#gift:not([hidden])')), `an ETH link made for /pay/ opens on /pay/eth/: ${p.url()}`);
    for (const old of ['#send&chain=base', '#withdraw', '#link', '#robinhood']) {
      await p.goto(origin + '/pay/' + old);
      await p.waitForURL(/\/pay\/eth\//, { timeout: 30e3 }).catch(() => {});
      ok(p.url() === origin + '/pay/eth/' + old, `an old ETH tab link ${old} opens on /pay/eth/: ${p.url()}`);
    }
    for (const mine of ['#btc', '#tac', '#sp=' + 'ab'.repeat(32)]) {
      await p.goto(origin + '/pay/' + mine); await p.waitForSelector('#g-in');
      ok(/\/pay\/(#|$)/.test(p.url()) && !/\/pay\/eth/.test(p.url()), `the hub's own ${mine.slice(0, 6)} link stays on the hub`);
    }
    if (/^https:/.test(URL_)) {                                                   // a route on the host, not a file
      await p.goto(origin + '/pay/wei/');
      await p.waitForSelector('#chains', { timeout: 30e3 }).catch(() => {});
      ok(!!(await p.$('#chains')), '/pay/wei/ serves the ETH page');
    }
    await p.goto(origin + '/pay/');
    await p.waitForSelector('#g-in');
    ok((await p.$eval('#modes [data-mode="btc"]', (a) => a.getAttribute('aria-current'))) === 'page', 'BTC is the default');
    await openKey(p, process.env.KEY);
    await p.waitForFunction(() => !document.querySelector('#bal .sk'), null, { timeout: 180e3 });
    ok(/BTC/.test(await text('#bal')) && !/—/.test(await text('#bal .v')), `BTC balance read: ${await text('#bal')}`);
    const route = async (to, re) => {
      await p.fill('#f-amt', '0.00001'); await p.fill('#f-to', to);
      await p.waitForFunction((s) => new RegExp(s).test(document.querySelector('#f-rcpt').textContent), re.source, { timeout: 60e3 }).catch(() => {});
      return (await text('#f-rcpt'));
    };
    ok(/Silent payment/.test(await route(OLD, /Silent payment|err/)), 'BTC to a tacit1 from before the pool lane: a silent payment');
    ok(/Silent payment/.test(await route(UNI, /Silent payment|err/)), 'BTC to a unified tacit1: a silent payment');
    ok(/Plain payment/.test(await route('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', /Plain payment|err/)), 'BTC to bc1: a plain payment');
    ok(/Ethereum address/.test(await route('0x' + '11'.repeat(20), /Ethereum|err/)), 'BTC to an 0x address is refused');
    ok(/pool address/.test(await route(BP, /pool address/)), 'BTC to a bp1 pool address is refused');
    await p.click('#tabs [data-tab="receive"]');
    await p.waitForFunction(() => [...document.querySelectorAll('.addr code')].every((c) => c.textContent !== '…'), null, { timeout: 120e3 }).catch(() => {});
    const addrs = await p.$$eval('.addr code', (x) => x.map((c) => c.textContent));
    ok(/^tacit1qzz/.test(addrs[0]) && addrs[0].length === 276 && /^sp1/.test(addrs[1]) && /^bc1/.test(addrs[2]), `receive shows the unified Tacit, silent-payment and Bitcoin addresses: ${addrs.map((a) => a.slice(0, 10)).join(' ')}`);
    await p.waitForSelector('#f-aqr svg', { timeout: 30e3 }).catch(() => {});
    const qa = await p.$('#f-aqr svg') ? await readQr(p, '#f-aqr svg') : '';
    ok(qa === null ? !!(await p.$('#f-aqr svg')) : qa === addrs[0], qa === null ? 'Receive shows a QR code (install jsqr to decode it)' : 'Receive’s QR code is the Tacit address');
    await p.click('[data-qrv="btc"]').catch(() => {});
    await p.waitForFunction(() => /Bitcoin address/.test(document.querySelector('#f-aqr svg')?.getAttribute('aria-label') || ''), null, { timeout: 10e3 }).catch(() => {});
    const qb = await readQr(p, '#f-aqr svg');
    ok(qb === null ? /Bitcoin address/.test(await p.getAttribute('#f-aqr svg', 'aria-label')) : qb === `bitcoin:${addrs[2]}`, `its switch shows the Bitcoin address as a bitcoin: link${qb ? `: ${qb.slice(0, 20)}…` : ''}`);
    await p.click('[data-qrv="tacit"]').catch(() => {});
    // Activity, read from the key and the chain once its card is in view: rows, or that there are none yet.
    await p.evaluate(() => document.querySelector('#activity').scrollIntoView());
    await p.waitForFunction(() => document.querySelector('#act-body .rows li') || /Nothing yet|Could not/.test(document.querySelector('#act-body').textContent), null, { timeout: 180e3 }).catch(() => {});
    const rowsN = await p.$$eval('#act-body .rows li', (x) => x.length);
    ok(rowsN > 0 || /Nothing yet\. Payments you make or receive with this wallet show here\./.test(await text('#act-body')), `Activity: ${rowsN ? `${rowsN} payments` : ((await text('#act-body')).match(/(Nothing yet|Could not)[^.]*\./) || [''])[0]}`);
    await p.evaluate(() => scrollTo(0, 0));
    ok(await p.evaluate(() => document.body.classList.contains('in') && getComputedStyle(document.querySelector('.hero p')).display === 'none'), 'signed in, the pitch gives way to the form');
    ok(await p.evaluate(() => {
      const tabs = [...document.querySelectorAll('#tabs [role="tab"]')], sel = tabs.filter((t) => t.getAttribute('aria-selected') === 'true'), f = document.getElementById('form');
      return sel.length === 1 && tabs.every((t) => ['true', 'false'].includes(t.getAttribute('aria-selected')) && (t === sel[0] ? t.tabIndex === 0 : t.tabIndex === -1)) && f.getAttribute('role') === 'tabpanel' && f.getAttribute('aria-labelledby') === sel[0].id;
    }), 'the tabs say which is selected, take one tab stop, and the form is their panel');
    await p.click('#modes [data-mode="tac"]');
    await p.waitForFunction(() => /TAC, shielded/.test(document.querySelector('#bal').textContent) && !document.querySelector('#bal .sk'), null, { timeout: 180e3 });
    ok(/TAC, shielded/.test(await text('#bal')) && !/—/.test(await text('#bal .v')), `shielded TAC read: ${await text('#bal')}`);
    await p.click('#tabs [data-tab="send"]');
    ok(/Inside the shielded pool/.test(await route(BP, /shielded pool|err/)), 'TAC to a bp1 pool address: inside the pool');
    ok(/Inside the shielded pool/.test(await route(UNI, /shielded pool|err/)), 'TAC to a unified tacit1: inside the pool');
    ok(/Shielded transfer from your Bitcoin address/.test(await route(OLD, /Shielded transfer|err/)), 'TAC to a tacit1 from before the pool lane: a shielded transfer');
    ok(/Bitcoin address/.test(await route('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', /Bitcoin address|err/)), 'TAC to bc1 is refused');
    await p.click('#tabs [data-tab="receive"]');
    await p.waitForFunction(() => [...document.querySelectorAll('.addr code')].some((c) => /^bp1/.test(c.textContent)), null, { timeout: 60e3 }).catch(() => {});
    const tacAddrs = await p.$$eval('.addr code', (x) => x.map((c) => c.textContent));
    ok(/^tacit1qzz/.test(tacAddrs[0]) && /^bp1/.test(tacAddrs[1]) && /inside the shielded pool/.test(await p.textContent('#form')), 'TAC receive shows the unified address, which the pool pays, and the pool address alone');
    // Ask to be paid: a link that names this key's Tacit address and the amount; opened, it fills in Send.
    ok(await p.evaluate(() => ['d-ask', 'd-more'].every((id) => document.getElementById(id) && !document.getElementById(id).open)), 'Receive keeps the rest behind two closed sections');
    await p.click('#d-ask > summary');
    await p.fill('#f-qamt', '1.5'); await p.fill('#f-qfor', 'hub test'); await p.click('#f-qcopy');
    const ask = await p.evaluate(() => navigator.clipboard.readText());
    ok(new RegExp(`/pay/#tac&pay=${tacAddrs[0]}&amount=1\\.5&for=hub\\+test$`).test(ask), `a TAC payment link from Receive: ${ask.slice(0, 40)}…${ask.slice(-30)}`);
    await p.waitForFunction(() => /1\.5 TAC/.test(document.querySelector('#f-qqr svg')?.getAttribute('aria-label') || ''), null, { timeout: 10e3 }).catch(() => {});
    const qr = await readQr(p, '#f-qqr svg');
    ok(qr === null ? !!(await p.$('#f-qqr svg')) : qr === ask, qr === null ? 'the request has a QR code (install jsqr to decode it)' : 'the request’s QR code is the link Copy made');
    await p.goto(ask.replace(/^https?:\/\/[^/]+/, origin));
    await p.waitForFunction(() => /1\.5 TAC/.test(document.querySelector('#hreq')?.textContent || '') && document.querySelector('#f-to')?.value, null, { timeout: 60e3 }).catch(() => {});
    await p.waitForFunction(() => /shielded pool|err/.test(document.querySelector('#f-rcpt')?.textContent || ''), null, { timeout: 60e3 }).catch(() => {});
    ok(/Payment request/.test(await text('#hreq')) && /1\.5 TAC/.test(await text('#hreq')) && /hub test/.test(await text('#hreq')) && (await p.inputValue('#f-to')) === tacAddrs[0] && (await p.inputValue('#f-amt')) === '1.5' && /Inside the shielded pool/.test(await text('#f-rcpt')), `a TAC request opens with Send filled in: ${(await text('#hreq')).slice(0, 90)}`);
    await p.goto(`${origin}/pay/#btc&pay=${UNI}&amount=0.0001`);
    await p.waitForFunction((u) => document.querySelector('#f-to')?.value === u && /Silent payment|err/.test(document.querySelector('#f-rcpt')?.textContent || ''), UNI, { timeout: 60e3 }).catch(() => {});
    ok((await p.$eval('#modes [data-mode="btc"]', (a) => a.getAttribute('aria-current'))) === 'page' && /0\.0001 BTC/.test(await text('#hreq')) && (await p.inputValue('#f-amt')) === '0.0001' && /Silent payment/.test(await text('#f-rcpt')), `a BTC request opens on BTC with Send filled in: ${(await text('#f-rcpt')).slice(0, 60)}`);
    await p.click('#rq-x');
    ok(await p.$eval('#hreq', (e) => e.hidden) && /\/pay\/#btc$/.test(p.url()), 'dismissing a request clears it and its link');
    await p.click('#modes [data-mode="tac"]');
    await p.setViewportSize({ width: 390, height: 900 });
    ok((await p.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'no sideways scroll at 390px');
    await p.click('#modes [data-mode="eth"]');
    await p.waitForURL(/\/pay\/eth\//, { timeout: 30e3 }).catch(() => {});
    ok(/\/pay\/eth\//.test(p.url()), 'the ETH chip opens /pay/eth/');
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await ctx.close();
  }

  if (ONLY.has('firstrun')) {
    // A first visit, no network: the ways in suit the browser, a way in that fails says so beside the options, and
    // the module preloads are the URLs the page imports (each module is fetched once).
    console.log('first run (/pay and /pay/eth, no network)');
    const origin = new URL(URL_).origin;
    for (const path of ['/pay/', '/pay/eth/']) {
      for (const wallet of [false, true]) {
        const seen = new Map();
        const { ctx, p, errors } = await page(browser, {
          viewport: { width: 390, height: 844 },
          init: wallet ? () => { window.ethereum = { request: async () => { throw Object.assign(new Error('rejected'), { code: 4001 }); }, on() {}, removeListener() {} }; } : null,
          route: (c) => c.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort()),
        });
        p.on('request', (r) => { const u = new URL(r.url()); if (u.origin === origin && /\.js$/.test(u.pathname)) seen.set(u.pathname, (seen.get(u.pathname) || 0) + 1); });
        await p.goto(origin + path);
        await p.waitForSelector('#g-in');
        await sleep(1500);
        const twice = [...seen].filter(([, n]) => n > 1).map(([u]) => u);
        ok(!twice.length, `${path}${wallet ? ' (wallet)' : ''}: each module is fetched once ${twice.join(' ')}`);
        await p.click('#wallet'); await p.waitForSelector('#sheet-wallet[open] .opt');
        const order = await p.$$eval('#sheet-wallet .opt .opt-t', (x) => x.map((e) => e.textContent.trim()));
        if (!wallet) {
          ok(order[0] === 'Create a wallet' && order.includes('Open a passkey wallet'), `${path}: with no wallet in the browser, a new wallet leads: ${order.join(' · ')}`);
          await p.click('#sheet-wallet [data-in="btc"]');
          await p.waitForSelector('#sheet-wallet .opts-err:not([hidden])');
          ok(/No Bitcoin wallet found/.test(await p.textContent('#sheet-wallet .opts-err')) && !(await p.$('.toast')), `${path}: the missing wallet is said beside the options, not in a toast`);
        } else {
          ok(!order.includes('Create a wallet'), `${path}: with a wallet in the browser the order is the usual one: ${order.join(' · ')}`);
          await p.click('#sheet-wallet [data-in="eth"]');
          await p.waitForSelector('#sheet-wallet .opts-err:not([hidden])');
          ok(/Cancelled in your wallet/.test(await p.textContent('#sheet-wallet .opts-err')), `${path}: a refused signature is said beside the options`);
        }
        ok(!errors.length, `${path}: no page errors ${errors.join(' | ')}`);
        await ctx.close();
      }
    }
  }

  if (ONLY.has('wc')) {
    console.log('WalletConnect (/pay, /pay/eth and /tac, no network, a stand-in for its bundle)');
    const secp = await import('@noble/secp256k1'), { keccak_256 } = await import('@noble/hashes/sha3'), { hmac } = await import('@noble/hashes/hmac'), { sha256 } = await import('@noble/hashes/sha256');
    const { useWcFake } = await import('../tests/wc-fake.mjs');
    secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
    const KEY = Buffer.from('7'.repeat(63) + '1', 'hex'), origin = new URL(URL_).origin;
    const ADDR = '0x' + Buffer.from(keccak_256(secp.getPublicKey(KEY, false).slice(1)).slice(12)).toString('hex');
    const personalSign = (hex) => { const m = Buffer.from(hex.replace(/^0x/, ''), 'hex'); const sg = secp.sign(keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m])), KEY); return '0x' + sg.toCompactHex() + (27 + sg.recovery).toString(16); };
    for (const { path, chip, sheet } of [{ path: '/pay/', chip: '#wallet', sheet: '#sheet-wallet' }, { path: '/pay/eth/', chip: '#wallet', sheet: '#sheet-wallet' }, { path: '/tac/', chip: '#wallet-chip', sheet: '#connect-sheet' }]) {
      const asked = [], waiting = [];
      const { ctx, p, errors } = await page(browser, { route: async (c) => { await c.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort()); } });
      await useWcFake(ctx, { account: ADDR });
      await p.exposeFunction('__wcRequest', async (method, params) => {
        if (method !== 'personal_sign') return undefined;                      // reads (eth_getCode) go to the chain's own node through WalletConnect, not to the wallet app
        asked.push(method);
        waiting.push(await p.evaluate(() => document.querySelector('#sheet-wc[open] #wc-h')?.textContent || '').catch(() => ''));
        return personalSign(params[0]);
      });
      await p.goto(origin + path);
      await p.waitForSelector(chip);
      await p.click(chip); await p.waitForSelector(`${sheet}[open] .opt`);
      const order = await p.$$eval(`${sheet} .opt .opt-t`, (x) => x.map((e) => e.textContent.trim()));
      const eth = await p.$eval(`${sheet} [data-in="eth"] .opt-m`, (e) => e.textContent);
      ok(order[0] === 'Create a wallet' && /WalletConnect/.test(eth), `${path}: with no wallet in the browser a new wallet still leads, and the Ethereum wallet option names WalletConnect (${order.join(' · ')})`);
      await p.click(`${sheet} [data-in="eth"]`);
      await p.waitForSelector('#sheet-wc[open] .wc-qr svg');
      ok(/Connect a wallet app/.test(await p.textContent('#wc-h')) && /Copy link/.test(await p.textContent('#wc-body')), `${path}: the pairing sheet shows a code and a link to copy`);
      await p.evaluate(() => window.__wcfake.approve());
      await p.waitForFunction(() => /^tacit1/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 60e3 });
      const first = await p.textContent('#wallet-label');
      ok(!(await p.$('#sheet-wc[open]')) && asked.join(' ') === 'personal_sign personal_sign' && waiting.every((t) => t === 'Approve in your wallet'), `${path}: the wallet app opens the key with two signatures, and the page says where to approve (${first.slice(0, 18)}…)`);
      asked.length = 0;
      await p.reload(); await p.waitForSelector(chip);
      await p.click(chip); await p.waitForSelector(`${sheet}[open] [data-in="known"]`);
      await p.click(`${sheet} [data-in="known"]`);
      await p.waitForFunction(() => /^tacit1/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 60e3 });
      ok((await p.textContent('#wallet-label')) === first && (await p.evaluate(() => window.__wcfake.pairs)) === 0 && asked.join(' ') === 'personal_sign', `${path}: a reload opens the same key through the kept session, no new pairing (${asked.join(' ')})`);
      await p.click(chip); await p.waitForSelector('#w-wc-off');
      await p.click('#w-wc-off');
      await p.waitForFunction(() => !/^tacit1/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 30e3 });
      ok((await p.evaluate(() => window.__wcfake.disconnected)) === 1, `${path}: Disconnect ends the session and locks the key it opened`);
      ok(!errors.some((e) => !/ERR_FAILED|net::/.test(e)), `${path}: no page errors ${errors.join(' | ').slice(0, 200)}`);
      await ctx.close();
    }
  }

  if (ONLY.has('saved')) {
    // The key saved in this browser, behind a passphrase, opens on both pages through the passphrase dialog: no network.
    console.log('saved key (/pay and /pay/eth, passphrase dialog)');
    const origin = new URL(URL_).origin, PASS = 'correct horse battery staple 123';
    for (const path of ['/pay/', '/pay/eth/']) {
      const { ctx, p, errors } = await page(browser, { route: (c) => c.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort()) });
      await p.goto(origin + path);
      const pub = await p.evaluate(async (pass) => {
        const d = await import('/vendor/tacit-deps.min.js'), hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
        const priv = d.secp.utils.randomPrivateKey(), salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
        const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
        const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, base, 256));
        const key = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt']);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, priv)), pub = hex(d.secp.getPublicKey(priv, true));
        localStorage.setItem('tacit-wallet-v1:mainnet', JSON.stringify({ v: 1, kdf: 'pbkdf2', iter: 600000, salt: hex(salt), iv: hex(iv), ct: hex(ct), pub }));
        return pub;
      }, PASS);
      await p.reload();
      await p.waitForSelector('#g-in [data-in="known"]');
      ok(/saved in this browser/i.test(await p.textContent('#g-in [data-in="known"]')), `${path}: Continue offers the saved key`);
      const toasts = () => p.$$eval('.toast', (x) => x.map((e) => e.textContent));
      await p.click('#g-in [data-in="known"]');
      await p.waitForSelector('#pass-dialog[open]', { timeout: 30e3 });
      ok(true, `${path}: the passphrase dialog opens`);
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('#pass-dialog').open, null, { timeout: 10e3 });
      await sleep(500);
      ok(!(await toasts()).some((t) => /passphrase modal|cancel/i.test(t)) && !(await p.$('#wallet-dot.on')), `${path}: Escape closes it quietly and leaves the wallet locked`);
      await p.click('#g-in [data-in="known"]');
      await p.waitForSelector('#pass-dialog[open]');
      await p.fill('#pass-input-1', 'not the passphrase at all');
      await p.press('#pass-input-1', 'Enter');
      await p.waitForFunction(() => /wrong passphrase/i.test(document.querySelector('#pass-hint-1')?.textContent || ''), null, { timeout: 30e3 });
      ok(true, `${path}: a wrong passphrase says so and asks again`);
      await p.fill('#pass-input-1', PASS);
      await p.press('#pass-input-1', 'Enter');
      await p.waitForFunction(() => /^tacit1/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 60e3 });
      ok(!(await p.$eval('#pass-dialog', (d) => d.open)), `${path}: the right passphrase opens the key: ${await p.textContent('#wallet-label')}`);
      ok(!errors.some((e) => !/ERR_FAILED|net::/.test(e)), `${path}: no page errors ${errors.join(' | ').slice(0, 200)}`);
      await ctx.close();
    }
  }

  if (ONLY.has('btcsend')) {
    // A Bitcoin payment through /pay's own Send form, from a pasted key to another key's tacit1 address, both address forms;
    // the explorer is stubbed and the broadcast captured, never sent. The recipient's key alone then finds the payment in
    // that transaction, and the key it derives for it is the output's, so it can spend it.
    console.log('btcsend (/pay: a silent payment to a tacit1, captured, found by its recipient)');
    const { createHash, randomBytes } = await import('node:crypto');
    const h = (b) => Buffer.from(b).toString('hex'), sha = (b) => createHash('sha256').update(b).digest();
    const parseTx = (raw) => {
      const b = Buffer.from(raw, 'hex'); let o = 0;
      const u8 = () => b[o++], u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
      const vi = () => { const f = u8(); if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(o); o += 2; return v; } return u32(); };
      const bytes = (n) => { const x = b.subarray(o, o + n); o += n; return x; };
      const version = u32(), segwit = b[o] === 0 && b[o + 1] === 1; if (segwit) o += 2;
      const vin = []; for (let i = vi(); i > 0; i--) vin.push({ txid: h(Buffer.from(bytes(32)).reverse()), vout: u32(), scriptsig: h(bytes(vi())), sequence: u32() });
      const vout = []; for (let i = vi(); i > 0; i--) { const value = Number(b.readBigUInt64LE(o)); o += 8; vout.push({ value, scriptpubkey: h(bytes(vi())) }); }
      if (segwit) for (const x of vin) { x.witness = []; for (let i = vi(); i > 0; i--) x.witness.push(h(bytes(vi()))); }
      const locktime = u32(), n = (k) => Buffer.from([k]), le = (v, w) => { const x = Buffer.alloc(w); w === 8 ? x.writeBigUInt64LE(BigInt(v)) : x.writeUInt32LE(v); return x; };
      const plain = Buffer.concat([le(version, 4), n(vin.length), ...vin.flatMap((x) => [Buffer.from(x.txid, 'hex').reverse(), le(x.vout, 4), n(x.scriptsig.length / 2), Buffer.from(x.scriptsig, 'hex'), le(x.sequence, 4)]),
        n(vout.length), ...vout.flatMap((y) => [le(y.value, 8), n(y.scriptpubkey.length / 2), Buffer.from(y.scriptpubkey, 'hex')]), le(locktime, 4)]);
      return { raw, txid: h(sha(sha(plain)).reverse()), version, locktime, vin, vout };
    };
    const keyOf = () => { let k; do { k = randomBytes(32); } while (k[0] === 0 || k[0] > 0xf0); return h(k); };
    const FUND = '11'.repeat(32), sent = [];
    let scriptA = null, current = null;
    const json = (r, v) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(v) });
    const now = () => Math.floor(Date.now() / 1000);
    const explorer = async (r) => {
      const u = new URL(r.request().url()), path = u.pathname.replace(/^\/(signet\/)?api/, '');
      if (r.request().method() === 'POST' && /\/tx$/.test(path)) { const t = parseTx(r.request().postData().trim()); sent.push(t); return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: t.txid }); }
      if (/\/address\/[^/]+\/utxo$/.test(path)) return json(r, [{ txid: FUND, vout: 0, value: 200000, status: { confirmed: true, block_height: 900000, block_time: now() - 3600 } }]);
      if (/\/(address|scripthash)\/[^/]+\/txs/.test(path)) return json(r, []);
      if (/fees\/recommended/.test(path)) return json(r, { fastestFee: 3, halfHourFee: 2, hourFee: 2, economyFee: 1, minimumFee: 1 });
      if (/fee-estimates/.test(path)) return json(r, { 1: 3, 3: 2, 6: 2, 144: 1 });
      if (/blocks\/tip\/height/.test(path)) return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '900010' });
      if (path === `/tx/${FUND}`) return json(r, { txid: FUND, version: 2, locktime: 0, status: { confirmed: true, block_height: 900000, block_time: now() - 3600 },
        vin: [{ txid: '22'.repeat(32), vout: 0, is_coinbase: false, scriptsig: '', witness: [], sequence: 4294967295, prevout: { scriptpubkey: '0014' + '33'.repeat(20), value: 250000 } }],
        vout: [{ scriptpubkey: scriptA, value: 200000 }, { scriptpubkey: '0014' + '33'.repeat(20), value: 49000 }] });
      if (path === `/tx/${FUND}/outspends`) return json(r, [{ spent: false }, { spent: false }]);
      const m = path.match(/\/tx\/([0-9a-f]{64})(\/.*)?$/);
      if (m && current && m[1] === current.txid) {
        if (m[2] === '/hex') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: current.raw });
        if (m[2]?.startsWith('/outspend')) return json(r, { spent: false });
        return json(r, { txid: current.txid, version: current.version, locktime: current.locktime, status: { confirmed: true, block_height: 900011, block_time: now() },
          vin: current.vin.map((x) => ({ ...x, is_coinbase: false, prevout: x.txid === FUND ? { scriptpubkey: scriptA, value: 200000 } : null })), vout: current.vout });
      }
      return r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'not found' });
    };
    // The hint service (worker-relay/src/lib/sp-hints.js), in memory: routed after the catch-all, so it answers first.
    const HINTS = [];
    const hintService = (r) => {
      const u = new URL(r.request().url());
      if (r.request().method() === 'POST') { const b = JSON.parse(r.request().postData()); HINTS.push([HINTS.length + 1, b.e, b.c]); return json(r, { id: HINTS.length }); }
      return json(r, { hints: HINTS.filter(([id]) => id > Number(u.searchParams.get('after') || 0)), next: null });
    };
    const route = async (c) => {
      await c.route(/mempool\.space|blockstream\.info|mempool\.emzy\.de|mempool\.bitaroo\.net/, explorer);
      await c.route(/api\.tacit\.finance|onrender\.com|workers\.dev/, (r) => json(r, []));
      await c.route(/tacit-btc-pool-relay-mainnet\.onrender\.com\/sp\/hints/, hintService);
    };
    for (const form of ['unified', 'legacy']) {
      const { ctx, p, errors } = await page(browser, { route });
      sent.length = 0; current = null;
      const A = keyOf(), B = keyOf();
      await p.goto(new URL(URL_).origin + '/pay/');
      const pubA = await p.evaluate(async (k) => { const d = await import('/vendor/tacit-deps.min.js'); return d.bytesToHex(d.secp.getPublicKey(d.hexToBytes(k), true)); }, A);
      scriptA = '0014' + h(createHash('ripemd160').update(sha(Buffer.from(pubA, 'hex'))).digest());
      // B's address as its own page shows it, or the form from before the pool lane.
      const to = await p.evaluate(async ({ B, form }) => {
        if (form === 'unified') return (await import('/tacit-unified.js')).unifiedAddress(B).address;
        const d = await import('/vendor/tacit-deps.min.js'), ta = await import('/tacit-address.js'), bip = await import('/bip352.js');
        const spend = d.hexToBytes(B), pub = d.secp.getPublicKey(spend, true), scan = BigInt('0x' + d.bytesToHex(bip.bip352TaggedHash('BIP0352/ScanKey', spend))) % d.secp.CURVE.n;
        return ta.makeTacitAddress({ secp: d.secp }).encodeTacitAddress({ network: 'mainnet', btcSpendPub: pub, btcScanPub: d.secp.getPublicKey(d.hexToBytes(scan.toString(16).padStart(64, '0')), true), evmOwnerPub: pub });
      }, { B, form });
      await openKey(p, A);
      await p.waitForFunction(() => /0\.002/.test(document.querySelector('#bal .v')?.textContent || ''), null, { timeout: 120e3 }).catch(() => {});
      await p.fill('#f-to', to); await p.fill('#f-amt', '0.0005');
      await p.waitForFunction(() => /Silent payment/.test(document.querySelector('#f-rcpt')?.textContent || '') && !document.querySelector('#f-go').disabled, null, { timeout: 60e3 }).catch(() => {});
      ok(/Silent payment/.test(await p.textContent('#f-rcpt')) && /ID/.test(await p.textContent('#f-rcpt')), `${form} tacit1 (${to.length} chars): routed as a silent payment, with its ID`);
      const hints0 = HINTS.length;
      // In sequence: the recipient already has /pay open when the payment goes out (the unified case); for the older
      // form they open it afterwards.
      let R = null;
      if (form === 'unified') { R = await page(browser, { route }); await R.p.goto(new URL(URL_).origin + '/pay/'); await openKey(R.p, B); await R.p.waitForFunction(() => !document.querySelector('#bal .sk'), null, { timeout: 120e3 }).catch(() => {}); }
      await p.click('#f-go');
      await p.waitForFunction(() => /Sent 0\.0005 BTC/.test(document.querySelector('#status')?.textContent || '') || document.querySelector('#status .err'), null, { timeout: 120e3 }).catch(() => {});
      for (let i = 0; i < 40 && HINTS.length === hints0; i++) await sleep(250);
      const tx = sent.at(-1);
      ok(/Sent 0\.0005 BTC/.test(await p.textContent('#status')) && tx?.vout.some((y) => y.value === 50000 && /^5120/.test(y.scriptpubkey)), `${form}: the page signed it, to a fresh taproot output (captured, not broadcast)`);
      await p.waitForFunction(() => document.querySelector('#f-go')?.getAttribute('aria-busy') !== 'true', null, { timeout: 30e3 }).catch(() => {});
      await sleep(400);
      ok((await p.inputValue('#f-amt')) === '' && await p.$eval('#f-go', (b) => b.disabled), `${form}: once sent, the amount is cleared and Send BTC waits for a new one`);
      // The payment stays in Activity after its status line is gone, until the explorer lists it.
      await p.evaluate(() => document.querySelector('#activity').scrollIntoView());
      await p.waitForFunction(() => [...document.querySelectorAll('#act-body .rows li')].some((li) => /Sent/.test(li.textContent) && /0\.0005 BTC/.test(li.textContent)), null, { timeout: 60e3 }).catch(() => {});
      const sentRow = (await p.$$eval('#act-body .rows li', (x) => x.map((li) => li.textContent.replace(/\s+/g, ' ').trim()))).find((r) => /^Sent/.test(r)) || '';
      ok(/−0\.0005 BTC/.test(sentRow) && /waiting for a block/.test(sentRow) && sentRow.includes(tx?.txid?.slice(0, 8) || '-'), `${form}: Activity shows it at once: ${sentRow.slice(0, 90)}`);
      current = tx;
      const found = await p.evaluate(async ({ B, txid }) => {
        const t = await import('/tacit.js'), d = await import('/vendor/tacit-deps.min.js');
        t.wallet.priv = d.hexToBytes(B); t.wallet.pub = d.secp.getPublicKey(t.wallet.priv, true);
        try { t.invalidateHoldingsCache?.({ fromPoll: true }); } catch {}
        return (await t.discoverSilentPaymentFromTxid(txid)).map((g) => ({ vout: g.vout, sats: g.sats, xonly: d.bytesToHex(d.secp.getPublicKey(t.spCreditSpendingKey({ tweakHex: g.tweakHex, keyVersion: g.keyVersion }, t.wallet.priv), true).slice(1)) }));
      }, { B, txid: tx?.txid });
      ok(found.length === 1 && found[0].sats === 50000 && tx.vout[found[0].vout].scriptpubkey === '5120' + found[0].xonly, `${form}: the recipient's key alone finds it, and derives the key that spends it`);
      ok(HINTS.length === hints0 + 1, `${form}: the send posted one hint for its recipient (${HINTS.length - hints0})`);
      ok(!errors.length, `${form}: no page errors ${errors.join(' | ').slice(0, 160)}`);
      await ctx.close();
      // The hint brings the payment in with no link: within a poll on a page already open, or on opening /pay.
      const t0 = Date.now();
      if (!R) { R = await page(browser, { route }); await R.p.goto(new URL(URL_).origin + '/pay/'); await openKey(R.p, B); }
      const toastSeen = R.p.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Received 0\.0005 BTC by silent payment/.test(t.textContent)), null, { timeout: 120e3, polling: 200 }).then(() => true, () => false);
      await R.p.waitForFunction(() => /0\.0005 by silent payment/.test(document.querySelector('#bal')?.textContent || ''), null, { timeout: 120e3 }).catch(() => {});
      ok(/0\.0005 by silent payment/.test(await R.p.textContent('#bal')) && await toastSeen, `${form}: the recipient ${form === 'unified' ? 'with /pay already open' : 'opening /pay'} is told of it, from the hint, in ${Math.round((Date.now() - t0) / 1000)} s: ${(await R.p.textContent('#bal .u')).replace(/\s+/g, ' ').trim()}`);
      await R.p.click('#tabs [data-tab="receive"]');
      await R.p.waitForFunction(() => /Paid to you by silent payment/.test(document.querySelector('#form')?.textContent || ''), null, { timeout: 30e3 }).catch(() => {});
      const paid = (await R.p.textContent('#form')).replace(/\s+/g, ' ');
      ok(/Paid to you by silent payment ?1 unspent/.test(paid) && /· ?new/.test(paid) && /0\.0005(0000)? BTC/.test(paid), `${form}: Receive lists it, marked new: ${(paid.match(/Paid to you.*?BTC/) || [''])[0].slice(0, 120)}`);
      await R.p.click('#f-scan');
      await R.p.waitForFunction(() => /Nothing new|Found \d/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 60e3 }).catch(() => {});
      ok(/Nothing new/.test(await R.p.textContent('#status')), `${form}: Check for new payments, once it is in: ${(await R.p.textContent('#status')).trim().slice(0, 60)}`);
      ok(!R.errors.length, `${form}: recipient page, no errors ${R.errors.join(' | ').slice(0, 160)}`);
      await R.ctx.close();
    }
  }

  if (ONLY.has('lookfor')) {
    // /pay's TAC mode: the refresh beside the shielded balance reads the balances and also looks through the asset's transfer
    // index for payments to this key (which no balance read can see). The index and the explorers are stubbed.
    console.log('lookfor (/pay: the TAC refresh looks for payments to the key)');
    const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', H = { 'access-control-allow-origin': '*' };
    const json = (r, v) => r.fulfill({ status: 200, contentType: 'application/json', headers: H, body: JSON.stringify(v) });
    let reads = 0, indexTxids = [];
    const explorer = (r) => {
      const path = new URL(r.request().url()).pathname.replace(/^\/(signet\/)?api/, '');
      if (/\/address\/[^/]+\/utxo$/.test(path) || /\/(address|scripthash)\/[^/]+\/txs/.test(path)) return json(r, []);
      if (/fees\/recommended/.test(path)) return json(r, { fastestFee: 3, halfHourFee: 2, hourFee: 2, economyFee: 1, minimumFee: 1 });
      if (/blocks\/tip\/height/.test(path)) return r.fulfill({ status: 200, headers: H, body: '900010' });
      return r.fulfill({ status: 404, headers: H, body: 'not found' });
    };
    const route = async (c) => {
      await c.route(/mempool\.space|blockstream\.info|mempool\.emzy\.de|mempool\.bitaroo\.net/, explorer);
      await c.route(new RegExp(`^https://api\\.tacit\\.finance/assets/${TAC}/recent-xfer-txids`), (r) => { reads++; return json(r, { asset_id: TAC, txids: indexTxids, next_cursor: null, done: true }); });
    };
    const { ctx, p, errors } = await page(browser, { route });
    await p.goto(new URL(URL_).origin + '/pay/#tac');
    await p.waitForSelector('#g-in');
    await openKey(p, '7e57'.padEnd(64, '1'));
    const refresh = async (want) => {
      await p.waitForFunction(() => document.querySelector('#bal-re')?.textContent.trim() === 'refresh', null, { timeout: 180e3 });
      const before = reads;
      await p.click('#bal-re');
      await p.waitForFunction((re) => new RegExp(re).test(document.querySelector('#status')?.textContent || ''), want, { timeout: 180e3 });
      return { line: (await p.textContent('#status')).replace(/\s+/g, ' ').trim(), reads: reads - before };
    };
    const none = await refresh('None for you among the latest transfers');
    ok(none.reads === 1 && !/could not be read/.test(none.line), `the TAC refresh looks through the transfer index once and says none were for this key (${none.reads} read; ${none.line.slice(0, 80)})`);
    indexTxids = ['aa', 'bb', 'cc'].map((x) => x.repeat(32));                                 // transactions Bitcoin does not have
    const unread = await refresh('could not be read');
    ok(unread.reads === 1 && /None for you among the latest transfers\. 3 could not be read; refresh to try them again/.test(unread.line), `transfers that could not be read are counted and offered again (${unread.line.slice(0, 110)})`);
    ok(!errors.length, `no page errors ${errors.join(' | ').slice(0, 160)}`);
    await ctx.close();
  }

  if (ONLY.has('fork')) {
    // CHAIN=ethereum|base|robinhood picks the chain forked (Base by default); every host the page reads that chain from
    // is routed to the fork.
    const F = {
      ethereum: { id: 1, name: 'Ethereum', key: 'ethereum', other: 8453, row: 1, rpc: process.env.ETH_RPC || 'https://mainnet.gateway.tenderly.co', url: 'https://ethereum-rpc.publicnode.com', hosts: /ethereum-rpc\.publicnode\.com|mainnet\.gateway\.tenderly\.co|eth\.drpc\.org|rpc\.flashbots\.net|1rpc\.io/ },
      base: { id: 8453, name: 'Base', key: 'base', other: 1, row: 2, rpc: process.env.BASE_RPC || 'https://mainnet.base.org', url: 'https://mainnet.base.org', hosts: /mainnet\.base\.org|base-rpc\.publicnode\.com|base\.drpc\.org/ },
      robinhood: { id: 4663, name: 'Robinhood Chain', key: 'robinhood', other: 8453, row: 3, rpc: process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com', url: 'https://rpc.mainnet.chain.robinhood.com', hosts: /rpc\.mainnet\.chain\.robinhood\.com|robinhood\.drpc\.org/ },
    }[process.env.CHAIN || 'base'];
    console.log(`fork (${F.name})`);
    const PORT = WEB + 1, ANVIL = `http://127.0.0.1:${PORT}`;
    const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', F.rpc, '--chain-id', String(F.id), '--silent', '--no-rate-limit'], { stdio: 'ignore' });
    process.on('exit', () => anvil.kill('SIGKILL'));
    const rpc = async (method, params = []) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
    for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }
    const ACCT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
    // anvil's default keys carry delegation code on real chains; start from a plain EOA.
    await rpc('anvil_setCode', [ACCT, '0x']);
    await rpc('anvil_setBalance', [ACCT, '0x' + (10n ** 18n).toString(16)]);
    await rpc('anvil_autoImpersonateAccount', [true]);
    const route = async (ctx) => {
      await ctx.route(F.hosts, async (r) => {
        const body = r.request().postData();
        let text;
        try { text = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text(); }
        catch (e) { text = JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body || '{}').id ?? 1, error: { code: -32000, message: `fork: ${e.message}` } }); }
        await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: text }).catch(() => {});
      });
      await ctx.route(/tacit-evm-pool-keeper/, (r) => r.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"stubbed"}' }));
      // The points service, stubbed: it lists what PTSAPI holds, as the program would once it counts a deposit.
      await ctx.route(/api\.tacit\.finance\/(points|claim)\//, (r) => {
        const claim = /\/claim\//.test(r.request().url());
        const body = claim ? {} : { address: ACCT, points: PTSAPI.deposits.reduce((a, d) => a + d.points, 0), deposit_count: PTSAPI.deposits.length, amount_wei: '0', today: { points: PTSAPI.deposits.reduce((a, d) => a + d.points, 0), totalPoints: 50000, dayBudgetWei: '1111111111111111111112' }, deposits: PTSAPI.deposits };
        return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
      });
    };
    const PTSAPI = { deposits: [] };
    const init = `(() => {
      const ANVIL = ${JSON.stringify(F.url)}, ACCT = ${JSON.stringify(ACCT)};   // routed to the fork; the page's CSP allows only its own hosts
      let chain = ${JSON.stringify('0x' + F.id.toString(16))};
      const call = async (method, params) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw Object.assign(new Error(r.error.message), r.error); return r.result; };
      window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCT];
        if (method === 'eth_chainId') return chain;
        if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; return null; }
        if (method === 'eth_sendTransaction') { const h = await call('eth_sendTransaction', [{ ...params[0], from: ACCT }]); return h; }
        return call(method, params || []);
      } };
      localStorage.setItem('tacit-pay-chain-v1', ${JSON.stringify(String(F.id))});
      localStorage.setItem('tacit-pay-route-v1', JSON.stringify({ send: 'wallet', withdraw: 'wallet' }));
    })();`;
    const { ctx, p, errors } = await page(browser, { init, route });
    await p.goto(URL_);
    const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const other = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await p.waitForSelector('#g-in');
    // The other key's pool address, read by opening it first.
    await openKey(p, other);
    await p.click('#tabs [data-tab="receive"]');
    const otherBp = await p.textContent('.addr code');
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, key);
    await p.waitForSelector('details.adv');
    await p.evaluate(() => { const d = document.querySelector('details.adv'); d.open = true; d.dispatchEvent(new Event('toggle')); });
    await p.click('#rc-chain');
    await p.evaluate(() => document.querySelector('#wallet-label').click()); await p.click('#w-conn'); await p.click('#sheet-wallet [data-close]');
    // Points: allowed once for this tab, then they follow the wallet's deposit: counting at once, credited when counted.
    await p.click('#pts-show');
    await p.waitForFunction(() => /your points/.test(document.querySelector('#points-body').textContent), null, { timeout: 60e3 }).catch(() => {});
    await p.click('#tabs [data-tab="deposit"]');
    await p.fill('#f-damt', '0.01');
    const t0 = Date.now();
    await p.click('#f-go');
    await p.waitForFunction(() => /Deposited/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Deposited/.test(await p.textContent('#status')), `deposit from the wallet, proved here (${Math.round((Date.now() - t0) / 1000)} s): ${(await p.textContent('#status')).trim()}`);
    const counting = (await p.textContent('#points-body')).replace(/\s+/g, ' ');
    ok(/0\.01 ETH on .*≈ [\d,]+ points · counting…/.test(counting), `points: the deposit shows at once, counting (${(counting.match(/0\.01 ETH on[^·]*· counting…/) || [''])[0]})`);
    PTSAPI.deposits.push({ tx_hash: '0x' + 'ab'.repeat(32), block_number: 1, block_time: Math.floor(Date.now() / 1000), amount_wei: '10000000000000000', points: 41234.5, activity: 'evmpooldeposit', chain_id: F.id, pp_boosted: false, tac_boost: 1 });
    await p.waitForFunction(() => /\+41,235 points/.test(document.querySelector('#points-body').textContent), null, { timeout: 60e3 }).catch(() => {});
    const counted = (await p.textContent('#points-body')).replace(/\s+/g, ' ');
    ok(/\+41,235 points/.test(counted) && /41,235/.test(counted.match(/[\d,]+ ?your points/)?.[0] || ''), `points: once the program counts it, the card shows what it earned and the total (${(counted.match(/\+[\d,]+ points/) || [''])[0]}, ${(counted.match(/[\d,]+ ?your points/) || [''])[0]})`);
    ok(/shared out in \d/.test(counted), `points: today's share counts down to midnight UTC (${(counted.match(/shared out in [^;]*/) || [''])[0]})`);
    const hold = await p.evaluate(() => { const a = document.querySelector('#points-body #pts-hold'); return a ? { text: a.closest('li').textContent.replace(/\s+/g, ' ').trim(), href: a.getAttribute('href') } : null; });
    ok(hold && /^ETH you leave in the private pools keeps earning points each day\./.test(hold.text) && hold.href === '/#points', `points: the card says ETH left in the pools keeps earning, and links to where it is counted (${hold?.text}, ${hold?.href})`);
    await p.waitForFunction(() => /0\.01/.test(document.querySelector('#bal .v').textContent), null, { timeout: 120e3 }).catch(() => {});
    ok(/0\.01/.test(await p.textContent('#bal .v')), `private balance: ${await p.textContent('#bal .v')}`);
    await p.click('#tabs [data-tab="send"]');
    await p.fill('#f-to', otherBp); await p.fill('#f-amt', '0.004'); await sleep(800);
    await p.click('#f-go');
    await p.waitForFunction(() => /Sent/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Sent/.test(await p.textContent('#status')), `private send from the wallet: ${(await p.textContent('#status')).trim()}`);
    await p.click('#tabs [data-tab="withdraw"]');
    await p.fill('#f-wto', '0x' + '33'.repeat(20)); await p.fill('#f-wamt', '0.002'); await sleep(800);
    await p.waitForSelector('.pv-h', { timeout: 900e3 });
    ok(/Could blend in better/.test(await p.textContent('.pv')) && /wallet shows as the one sending/.test(await p.textContent('.pv')) && /since yours/.test(await p.textContent('.pv')), `privacy check before a wallet-sent withdrawal: ${(await p.textContent('.pv')).replace(/\s+/g, ' ').trim().slice(0, 140)}`);
    await p.click('#f-go');
    await p.waitForFunction(() => /Withdrew/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Withdrew/.test(await p.textContent('#status')), `partial withdrawal from the wallet: ${(await p.textContent('#status')).trim()}`);
    ok(BigInt(await rpc('eth_getBalance', ['0x' + '33'.repeat(20), 'latest'])) >= 2n * 10n ** 15n, 'the address received 0.002 ETH');
    await p.waitForFunction(() => /0\.004/.test(document.querySelector('#bal .v').textContent), null, { timeout: 120e3 }).catch(() => {});
    ok(/^0\.004$/.test((await p.textContent('#bal .v')).trim()), `0.004 stays private: ${await p.textContent('#bal .v')}`);
    // Deposit straight into someone else's private balance, from the wallet, proved here.
    await p.click('#tabs [data-tab="deposit"]'); await p.click('[data-dep="wallet"]');
    await p.fill('#f-damt', '0.001'); await p.fill('#f-dto', otherBp);
    await p.waitForFunction(() => /Into their private balance/.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 60e3 });
    await p.click('#f-go');
    await p.waitForFunction(() => /into their private balance/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/into their private balance/.test(await p.textContent('#status')), `deposit to someone else, from the wallet: ${(await p.textContent('#status')).trim()}`);
    ok(/^0\.004$/.test((await p.textContent('#bal .v')).trim()), 'the depositor’s own private balance is untouched');
    await p.evaluate(() => { const d = document.querySelector('details.adv'); d.open = true; d.dispatchEvent(new Event('toggle')); });
    await p.click('#rc-go');
    // The forked chain's own summary: the other two chains are read from the real nodes, which take their own time.
    await p.waitForFunction((n) => document.querySelectorAll('.rows li').length >= 3 && /\d+ payments? ·/.test(document.querySelector(`.chainsum li:nth-child(${n})`)?.textContent || ''), F.row, { timeout: 900e3 })
      .catch(async (e) => { console.log('    ' + (await p.textContent('#recover-body')).replace(/\s+/g, ' ')); throw e; });
    const rows = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    console.log('    ' + rows.join('\n    '));
    ok(rows.some((r) => /^Deposited ?\+0\.01 ETH/.test(r)) && rows.some((r) => /^Sent privately ?−0\.004 ETH.*kept 0\.006/.test(r)) && rows.some((r) => /^Withdrew to 0x3{40} ?−0\.002 ETH.*kept 0\.004/.test(r)), 'rebuilt history names the deposit, the private payment and the withdrawal');
    // The balance is read again beside the history; the two agree once both are in.
    await p.waitForFunction((n) => /matches/.test(document.querySelector(`.chainsum li:nth-child(${n})`)?.textContent || ''), F.row, { timeout: 180e3 }).catch(() => {});
    ok(/matches/.test(await p.$eval(`.chainsum li:nth-child(${F.row})`, (e) => e.textContent)), 'rebuilt balance matches');
    // The sender proves the private payment; anyone with the recipient's address can check it, and only against that address.
    await p.click('[data-proof]');
    const proofLink = await p.evaluate(() => navigator.clipboard.readText());
    const q = await ctx.newPage();
    await q.goto(proofLink.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
    await q.waitForSelector('#pf-to');
    const check = async (addr) => { await q.fill('#pf-to', addr); await q.click('#pf-go'); await q.waitForFunction(() => /This transaction paid|was not to|err/.test(document.querySelector('#pf-status').innerHTML), null, { timeout: 120e3 }); return (await q.textContent('#pf-status')).trim(); };
    const right = await check(otherBp);
    ok(/paid 0\.004 ETH privately/.test(right), `a payment proof checks out for its recipient: ${right}`);
    const wrong = await check('bp1qf5rdn2trtk94rqya5637yeqyvp5qllkeztth8dfesrc5x9tvqluqlahm5yyv7km9tq9s9spmdqqukkw46zudgxu7aawem8fyey0kseqh6xr40k26x7ew8zqujenn45kk2kh47aqzxxj3pp8q2rukjss02vszf7eaa');
    ok(/was not to/.test(wrong), `and proves nothing about another address: ${wrong}`);
    await q.close();
    // The recipient's key alone finds the payment.
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, other);
    await p.waitForFunction(() => document.querySelectorAll('.rows li').length >= 1, null, { timeout: 900e3 });
    const theirs = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    ok(theirs.some((r) => /^Received privately ?\+0\.004 ETH/.test(r)), `the recipient’s key finds it: ${theirs[0]}`);
    // Get paid by someone with only an ordinary wallet: they pay the request link; the payee takes it in.
    const link = await getPaidLink(p, '0.003', 'fork test');
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await p.goto(link.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
    await p.waitForSelector('#req-wallet');
    await p.click('#req-wallet');
    await p.waitForFunction(() => /Moving into their private balance|now in their/.test(document.querySelector('#req').textContent) || document.querySelector('#req .err'), null, { timeout: 180e3 });
    ok(/Paid 0\.003 ETH/.test(await p.textContent('#req')), `paid from a wallet, no Tacit key: ${(await p.textContent('#req')).replace(/\s+/g, ' ').trim()}`);
    await p.click(`#chains [data-chain="${F.other}"]`); await p.click(`#chains [data-chain="${F.id}"]`);
    ok(!(await p.$('#req-wallet')) && /Paid 0\.003 ETH/.test(await p.textContent('#req')), 'a paid request stays paid across redraws (no second pay button)');
    await p.click('#req-x');
    // A request with no one-time address (a link to a pool or Tacit address, or a name), paid with no Tacit key at all:
    // proved on the page with a throwaway key, straight into their private balance.
    await p.goto(new URL(URL_).origin + `/pay/#pay=${otherBp}&amount=0.0015&chain=${F.key}`);
    await p.waitForSelector('#req-wallet');
    await p.click('#req-wallet');
    await p.waitForFunction(() => /now in their private balance/.test(document.querySelector('#req').textContent) || document.querySelector('#req .err'), null, { timeout: 900e3 });
    ok(/Paid 0\.0015 ETH, now in their private balance/.test(await p.textContent('#req')), `a keyless payer deposits straight to them: ${(await p.textContent('#req')).replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    await p.click('#req-x');
    await openKey(p, other);
    await p.click('#tabs [data-tab="deposit"]'); await p.click('[data-dep="addr"]');
    await p.waitForSelector('[data-sweep]', { timeout: 300e3 });
    ok(/payment link’s address/.test(await p.textContent('#form')), 'the payment went to the link’s one-time address, not the standing one');
    await p.click('[data-sweep]');
    await p.waitForFunction(() => /Taken in/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Taken in/.test(await p.textContent('#status')), `the payee takes it in: ${(await p.textContent('#status')).trim()}`);
    const tw = Date.now();
    const probe = setInterval(async () => { try { console.log(`    [${Math.round((Date.now() - tw) / 1000)} s] ${(await p.textContent('#recover-at'))} · ${(await p.$$eval('.chainsum li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join(' | ')))}`); } catch {} }, 60e3);
    await p.waitForFunction(() => [...document.querySelectorAll('.rows li')].some((l) => /through a payment link/.test(l.textContent)), null, { timeout: 900e3 }).catch(() => {});
    clearInterval(probe);
    console.log(`    history showed it after ${Math.round((Date.now() - tw) / 1000)} s`);
    const got = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    console.log('    ' + got.join('\n    '));
    ok(got.some((r) => /^Came in through a payment link ?\+0\.003 ETH/.test(r)), 'the payee’s key finds the wallet payment');
    ok(got.some((r) => /^Deposited ?\+0\.001 ETH/.test(r)) && got.some((r) => /^Deposited ?\+0\.0015 ETH/.test(r)), 'the payee’s key finds both deposits made straight to them');
    // The next link names a fresh one-time address.
    const next = await getPaidLink(p, '', '');
    ok(new URL(next).hash.match(/n=([0-9a-f]+)/)[1] !== new URL(link).hash.match(/n=([0-9a-f]+)/)[1], 'after a link is paid, the next link uses a new address');
    await shot(p, 'fork-after');
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await ctx.close();
    anvil.kill('SIGKILL');
  }

  if (ONLY.has('tokens')) {
    // The token pools on Ethereum (USDC here), on an anvil fork: a deposit from the wallet by a permit signed for the pool's router, a private send
    // and a withdrawal through the relay (its keeper stubbed: quotes in USDC and sends pool.transact from the Ethereum keeper's address, as the
    // real one does), a payment link in USDC paid from a wallet with no Tacit key, and the recipient's key finding what it was paid.
    console.log('tokens (Ethereum fork, USDC pool)');
    const { calldata } = await import(new URL('../dapp/evm-pool-gateway.js', import.meta.url));
    const PAIR = { tuple: ['uint256', 'uint256'] }, B = (x) => BigInt(x);
    const TX_TYPES = [PAIR, { tuple: [PAIR, PAIR] }, PAIR, { tuple: Array(11).fill('uint256') }, 'address', 'uint256', 'address', 'uint256', 'bytes', 'bytes'];
    const TX_SIG = '(uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes)';
    const transactData = (t) => calldata(`transact${TX_SIG}`, TX_TYPES, [t.pA.map(B), t.pB.map((r) => r.map(B)), t.pC.map(B), t.publicInputs.map(B), t.recipient, BigInt.asUintN(256, B(t.extAmount)), t.relayer, B(t.fee), t.memo0, t.memo1]);
    const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', POOLU = '0x6C0be904750Fe1b50cd7207cc94731642d99e908', RELAYER = '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0';
    const PORT = WEB + 4, ANVIL = `http://127.0.0.1:${PORT}`, hosts = /ethereum-rpc\.publicnode\.com|mainnet\.gateway\.tenderly\.co|eth\.drpc\.org|rpc\.flashbots\.net|1rpc\.io/;
    const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', process.env.ETH_RPC || 'https://mainnet.gateway.tenderly.co', '--chain-id', '1', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
    process.on('exit', () => anvil.kill('SIGKILL'));
    const rpc = async (method, params = []) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
    for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }
    const ACCT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
    await rpc('anvil_setCode', [ACCT, '0x']);
    await rpc('anvil_setBalance', [ACCT, '0x' + (10n ** 18n).toString(16)]);
    await rpc('anvil_setBalance', [RELAYER, '0x' + (10n ** 18n).toString(16)]);
    await rpc('anvil_dealERC20', [ACCT, USDC, '0x' + (1000n * 10n ** 6n).toString(16)]);
    await rpc('anvil_autoImpersonateAccount', [true]);
    const usdcOf = async (a) => BigInt(await rpc('eth_call', [{ to: USDC, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
    const relays = [];
    const route = async (ctx) => {
      await ctx.route(hosts, async (r) => {
        const body = r.request().postData();
        let text;
        try { text = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text(); }
        catch (e) { text = JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body || '{}').id ?? 1, error: { code: -32000, message: `fork: ${e.message}` } }); }
        await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: text }).catch(() => {});
      });
      await ctx.route(/tacit-evm-pool-keeper/, async (r) => {
        const u = new URL(r.request().url()), H = { 'access-control-allow-origin': '*' };
        if (!/^\/1-xa0b86991c6\//.test(u.pathname)) return r.fulfill({ status: 503, contentType: 'application/json', headers: H, body: '{"error":"stubbed"}' });
        if (/\/quote$/.test(u.pathname)) return r.fulfill({ status: 200, contentType: 'application/json', headers: H, body: JSON.stringify({ chainId: 1, pool: POOLU, relayer: RELAYER, asset: USDC, fee: '200000', gas: '450000', sweepFee: '200000', receiveMin: '80000000' }) });
        if (/\/relay$/.test(u.pathname) && r.request().method() === 'POST') {
          const b = JSON.parse(r.request().postData() || '{}');
          const txHash = await rpc('eth_sendTransaction', [{ from: RELAYER, to: POOLU, data: transactData(b.tx), gas: '0x1e8480' }]);
          relays.push(txHash);
          return r.fulfill({ status: 200, contentType: 'application/json', headers: H, body: JSON.stringify({ txHash }) });
        }
        return r.fulfill({ status: 404, contentType: 'application/json', headers: H, body: '{"error":"no such route"}' });
      });
      await ctx.route(/api\.tacit\.finance\/(points|claim|stats)/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    };
    const init = `(() => {
      const ANVIL = 'https://ethereum-rpc.publicnode.com', ACCT = ${JSON.stringify(ACCT)};
      let chain = '0x1';
      const call = async (method, params) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw Object.assign(new Error(r.error.message), r.error); return r.result; };
      window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCT];
        if (method === 'eth_chainId') return chain;
        if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; return null; }
        if (method === 'wallet_getCapabilities') throw Object.assign(new Error('not supported'), { code: -32601 });
        if (method === 'eth_sendTransaction') return call('eth_sendTransaction', [{ ...params[0], from: ACCT }]);
        return call(method, params || []);
      } };
      localStorage.setItem('tacit-pay-chain-v1', '1');
    })();`;
    const { ctx, p, errors } = await page(browser, { init, route });
    await p.goto(URL_);
    const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const other = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await p.waitForSelector('#g-in');
    ok(await p.isVisible('#assets [data-tok="usdc"]') && await p.isVisible('#assets [data-tok="usdt"]') && await p.isVisible('#assets [data-tok="tac"]'), 'on Ethereum the page offers ETH and the USDC, USDT and TAC pools');
    await openKey(p, other);
    await p.click('#assets [data-tok="usdc"]');
    await p.click('#tabs [data-tab="receive"]');
    const otherAddr = await p.$eval('#f-acopy', (b) => b.closest('.kv').querySelector('b').textContent).catch(() => '');
    await p.click('#f-acopy');
    const otherTacit = await p.evaluate(() => navigator.clipboard.readText());
    ok(/^tacit1/.test(otherTacit), `a token pool's Receive shows the one Tacit address (${otherAddr})`);
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, key);
    await p.evaluate(() => document.querySelector('#wallet-label').click()); await p.click('#w-conn'); await p.click('#sheet-wallet [data-close]');
    await p.click('#assets [data-tok="usdc"]');
    ok(/USDC, private on Ethereum/.test(await p.textContent('#bal')), `the balance is the private USDC (${(await p.textContent('#bal')).replace(/\s+/g, ' ').trim().slice(0, 60)})`);
    await p.click('#tabs [data-tab="deposit"]');
    await p.waitForFunction(() => /1,000/.test(document.querySelector('#f-wb')?.textContent || ''), null, { timeout: 60e3 }).catch(() => {});
    await p.fill('#f-amt', '300');
    const t0 = Date.now(), u0 = await usdcOf(ACCT);
    await p.click('#f-go');
    await p.waitForFunction(() => /Deposited/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Deposited 300 USDC/.test(await p.textContent('#status')) && u0 - (await usdcOf(ACCT)) === 300n * 10n ** 6n, `deposit of 300 USDC from the wallet, a permit signed for the router, proved here (${Math.round((Date.now() - t0) / 1000)} s): ${(await p.textContent('#status')).trim()}`);
    await p.waitForFunction(() => /^300$/.test(document.querySelector('#bal .v')?.textContent.trim() || ''), null, { timeout: 120e3 }).catch(() => {});
    ok(/^300$/.test((await p.textContent('#bal .v')).trim()), `private balance: ${await p.textContent('#bal .v')} USDC`);
    await p.click('#tabs [data-tab="send"]');
    await p.fill('#f-to', otherTacit); await p.fill('#f-amt', '100');
    await p.waitForFunction(() => /Relay fee/.test(document.querySelector('#f-rcpt')?.textContent || '') && !document.querySelector('#f-go').disabled, null, { timeout: 60e3 }).catch(() => {});
    ok(/at most 0\.25 USDC/.test(await p.textContent('#f-rcpt')), `the relay's fee is in USDC (${(await p.textContent('#f-rcpt')).replace(/\s+/g, ' ').trim()})`);
    await p.click('#f-go');
    await p.waitForFunction(() => /Sent/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Sent 100 USDC privately/.test(await p.textContent('#status')) && relays.length === 1, `a private send of 100 USDC through the relay: ${(await p.textContent('#status')).trim()}`);
    await p.click('#tabs [data-tab="withdraw"]');
    const before3 = await usdcOf('0x' + '33'.repeat(20));       // a real address: it holds some USDC already
    await p.fill('#f-to', '0x' + '33'.repeat(20)); await p.fill('#f-amt', '50');
    await p.waitForFunction(() => !document.querySelector('#f-go').disabled, null, { timeout: 60e3 }).catch(() => {});
    await p.click('#f-go');
    await p.waitForFunction(() => /Withdrew/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    const got3 = (await usdcOf('0x' + '33'.repeat(20))) - before3;
    ok(/Withdrew 50 USDC/.test(await p.textContent('#status')), `a withdrawal of 50 USDC to an address: ${(await p.textContent('#status')).trim()}`);
    ok(got3 === 50n * 10n ** 6n, `the address received exactly 50 USDC (+${Number(got3) / 1e6})`);
    ok(relays.length === 2, `and the relay sent it (${relays.length} relayed so far)`);
    await p.waitForFunction(() => /^149\.6$/.test(document.querySelector('#bal .v')?.textContent.trim() || ''), null, { timeout: 120e3 }).catch(() => {});
    ok(/^149\.6$/.test((await p.textContent('#bal .v')).trim()), `what stays private, less the two fees: ${await p.textContent('#bal .v')} USDC`);
    // USDT: no permit, and an allowance of 1 already in place that USDT will not change but through zero. The page resets it, approves exactly
    // the 40, and deposits (a deposit that tried approve(40) from 1 would revert, so a deposit that lands shows the reset was sent).
    const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7', POOLT = '0x73872ceEaADd2C603BD057073D403f08DCB31EB9', ROUTERT = '0x5650c850872bc89FC6E22CBB7a51b0e0DAC97198';
    const word = (a) => a.slice(2).toLowerCase().padStart(64, '0');
    const read = async (to, data) => BigInt(await rpc('eth_call', [{ to, data }, 'latest']));
    await rpc('anvil_dealERC20', [ACCT, USDT, '0x' + (500n * 10n ** 6n).toString(16)]);
    await rpc('eth_sendTransaction', [{ from: ACCT, to: USDT, data: '0x095ea7b3' + word(ROUTERT) + (10n ** 6n).toString(16).padStart(64, '0'), gas: '0x30000' }]);
    ok((await read(USDT, '0xdd62ed3e' + word(ACCT) + word(ROUTERT))) === 10n ** 6n, 'USDT: an allowance of 1 is in place for its router');
    await p.click('#assets [data-tok="usdt"]');
    ok(/USDT, private on Ethereum/.test(await p.textContent('#bal')), 'the USDT pool is picked');
    await p.click('#tabs [data-tab="deposit"]');
    await p.waitForFunction(() => /500/.test(document.querySelector('#f-wb')?.textContent || ''), null, { timeout: 60e3 }).catch(() => {});
    await p.fill('#f-amt', '40');
    const heldT = await read(USDT, '0x70a08231' + word(POOLT));
    await p.click('#f-go');
    await p.waitForFunction(() => /Deposited/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Deposited 40 USDT/.test(await p.textContent('#status')), `USDT: deposit of 40 after the allowance is reset: ${(await p.textContent('#status')).trim()}`);
    ok((await read(USDT, '0x70a08231' + word(POOLT))) - heldT === 40n * 10n ** 6n && (await read(USDT, '0xdd62ed3e' + word(ACCT) + word(ROUTERT))) === 0n, 'the USDT pool took exactly 40 and no allowance is left');
    await p.waitForFunction(() => /^40$/.test(document.querySelector('#bal .v')?.textContent.trim() || ''), null, { timeout: 120e3 }).catch(() => {});
    ok(/^40$/.test((await p.textContent('#bal .v')).trim()), `private USDT: ${await p.textContent('#bal .v')}`);
    // The gas relay: the wallet holds USDC and no ETH. The deposit is proved here as always, signed as one order and one permit (the fee in USDC), and sent by the relay,
    // stood in for by this check (the posted order goes through the same encoding the settle relay uses): the wallet sends nothing.
    {
      const RELAY = '0x000000197E8f0B64463B2010e568fF42090Af88d', SENDER = '0x000000000000000000000000000000000007a0f0';
      const { encodeExecute } = await import(new URL('../worker-relay/src/lib/gas-calls.js', import.meta.url)), { checkGasOrder } = await import(new URL('../worker/src/gas-relay-queue.js', import.meta.url));
      await rpc('anvil_setBalance', [SENDER, '0x' + (5n * 10n ** 18n).toString(16)]);
      const posted = [];
      await ctx.route('https://api.tacit.finance/gas/order', async (r) => {
        const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'content-type': 'application/json' };
        if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
        const x = JSON.parse(r.request().postData()).order; posted.push(x);
        const why = checkGasOrder(x);
        if (why) return r.fulfill({ status: 400, headers: h, body: JSON.stringify({ ok: false, error: why }) });
        try { await rpc('eth_sendTransaction', [{ from: SENDER, to: RELAY, data: encodeExecute(x), gas: '0x7a1200' }]); } catch (e) { return r.fulfill({ status: 400, headers: h, body: JSON.stringify({ ok: false, error: String(e.message).slice(0, 160) }) }); }
        await r.fulfill({ status: 200, headers: h, body: JSON.stringify({ ok: true }) });
      });
      const eth0 = await rpc('eth_getBalance', [ACCT, 'latest']);
      await p.click('#assets [data-tok="usdc"]');
      await p.click('#tabs [data-tab="deposit"]');
      await rpc('anvil_setBalance', [ACCT, '0x0']);
      await p.click('#assets [data-tok="usdt"]'); await p.click('#assets [data-tok="usdc"]'); await p.click('#tabs [data-tab="deposit"]');   // the form is drawn again with no ETH
      await p.waitForFunction(() => /No ETH in your wallet/.test(document.querySelector('#f-note')?.textContent || ''), null, { timeout: 60e3 }).catch(() => {});
      ok(/the relay sends this deposit and takes about [\d.]+ USDC/.test(await p.textContent('#f-note')), `relay: with no ETH the form says the relay sends the deposit and USDC pays for it (${(await p.textContent('#f-note')).trim().slice(0, 90)})`);
      const n0 = await rpc('eth_getTransactionCount', [ACCT, 'latest']), u1 = await usdcOf(ACCT);
      await p.fill('#f-amt', '100');
      await p.click('#f-go');
      await p.waitForFunction(() => /Deposited/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
      ok(/Deposited 100 USDC/.test(await p.textContent('#status')), `relay: the deposit landed with no ETH: ${(await p.textContent('#status')).trim().slice(0, 80)}`);
      const spent = u1 - (await usdcOf(ACCT));
      ok(posted.length === 1 && posted[0].order.feeToken.toLowerCase() === USDC.toLowerCase() && spent > 100n * 10n ** 6n && (await rpc('eth_getTransactionCount', [ACCT, 'latest'])) === n0 && (await rpc('eth_getBalance', [ACCT, 'latest'])) === '0x0', `relay: one order, the fee in USDC (${Number(spent - 100n * 10n ** 6n) / 1e6}), the wallet sent no transaction and still has no ETH`);
      await ctx.unroute('https://api.tacit.finance/gas/order');
      await rpc('anvil_setBalance', [ACCT, eth0]);
    }
    // a request for 25 USDC, from the other key, paid from a wallet by someone with no Tacit key
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, other);
    await p.click('#assets [data-tok="usdc"]');
    await p.click('#tabs [data-tab="receive"]');
    await p.fill('#f-ramt', '25'); await sleep(300);
    await p.click('#f-rcopy');
    const link = await p.evaluate(() => navigator.clipboard.readText());
    ok(/#pay=tacit1.+asset=usdc.+amount=25/.test(link), `a payment link names USDC and the amount (${link.slice(0, 90)}…)`);
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await p.goto(link.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
    await p.waitForSelector('#req-wallet');
    ok(/25 USDC/.test((await p.textContent('#req')).replace(/\s+/g, ' ')), `the request reads 25 USDC (${(await p.textContent('#req .req-a')).trim()})`);
    await p.click('#req-wallet');
    await p.waitForFunction(() => /now in their private balance|You paid/.test(document.querySelector('#req').textContent) || document.querySelector('#req .err'), null, { timeout: 600e3 });
    ok(/Paid 25 USDC, now in their private balance/.test(await p.textContent('#req')), `paid from a wallet, no Tacit key, straight into their private USDC: ${(await p.textContent('#req')).replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    await p.click('#req-x');
    await openKey(p, other);
    await p.click('#assets [data-tok="usdc"]');
    await p.waitForFunction(() => /^125$/.test(document.querySelector('#bal .v')?.textContent.trim() || ''), null, { timeout: 180e3 }).catch(() => {});
    ok(/^125$/.test((await p.textContent('#bal .v')).trim()), `the recipient's key finds the 100 sent and the 25 paid: ${await p.textContent('#bal .v')} USDC`);
    ok(!errors.filter((e) => !/status of (404|503)/.test(e)).length, `no page errors ${errors.join(' | ').slice(0, 200)}`);
    await ctx.close();
    anvil.kill('SIGKILL');
  }

  if (ONLY.has('tokbase')) {
    // A token pool on another chain than Ethereum (Base's USDC, on an anvil fork of Base): picked on Base beside its ETH, a deposit by a permit
    // signed for Base (one transaction, no approval), a private send and a withdrawal through a stubbed relay (Base's keeper address), a payment
    // link that names the chain, paid from a wallet with no Tacit key, and the recipient's key finding what it was paid.
    console.log('tokbase (Base fork, USDC pool)');
    const { calldata } = await import(new URL('../dapp/evm-pool-gateway.js', import.meta.url));
    const PAIR = { tuple: ['uint256', 'uint256'] }, B = (x) => BigInt(x);
    const TX_TYPES = [PAIR, { tuple: [PAIR, PAIR] }, PAIR, { tuple: Array(11).fill('uint256') }, 'address', 'uint256', 'address', 'uint256', 'bytes', 'bytes'];
    const TX_SIG = '(uint256[2],uint256[2][2],uint256[2],uint256[11],address,int256,address,uint256,bytes,bytes)';
    const transactData = (t) => calldata(`transact${TX_SIG}`, TX_TYPES, [t.pA.map(B), t.pB.map((r) => r.map(B)), t.pC.map(B), t.publicInputs.map(B), t.recipient, BigInt.asUintN(256, B(t.extAmount)), t.relayer, B(t.fee), t.memo0, t.memo1]);
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', POOLU = '0xCAf6BE2e337AEcAB4a4eA183452f78800fD1616D', RELAYER = '0xfA2afbaB631C7Eda7CeA6AE1440605C504E322Ec';
    const PORT = WEB + 5, ANVIL = `http://127.0.0.1:${PORT}`, hosts = /mainnet\.base\.org|base-rpc\.publicnode\.com|base\.gateway\.tenderly\.co|base\.drpc\.org|base\.rpc\.blxrbdn\.com/;
    // forked from a node that answers 5,000-block log reads (mainnet.base.org limits them when busy)
    const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', process.env.BASE_RPC || 'https://base-rpc.publicnode.com', '--chain-id', '8453', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
    process.on('exit', () => anvil.kill('SIGKILL'));
    const rpc = async (method, params = []) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
    for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }
    const ACCT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
    await rpc('anvil_setCode', [ACCT, '0x']);
    for (const a of [ACCT, RELAYER]) await rpc('anvil_setBalance', [a, '0x' + (10n ** 18n).toString(16)]);
    await rpc('anvil_dealERC20', [ACCT, USDC, '0x' + (1000n * 10n ** 6n).toString(16)]);
    await rpc('anvil_autoImpersonateAccount', [true]);
    const usdcOf = async (a) => BigInt(await rpc('eth_call', [{ to: USDC, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
    const nonceOf = async (a) => Number(BigInt(await rpc('eth_getTransactionCount', [a, 'latest'])));
    const relays = [];
    const route = async (ctx) => {
      await ctx.route(hosts, async (r) => {
        const body = r.request().postData();
        let text;
        try { text = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text(); }
        catch (e) { text = JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body || '{}').id ?? 1, error: { code: -32000, message: `fork: ${e.message}` } }); }
        await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: text }).catch(() => {});
      });
      await ctx.route(/tacit-evm-pool-keeper/, async (r) => {
        const u = new URL(r.request().url()), H = { 'access-control-allow-origin': '*' };
        if (!/^\/8453-x833589fcd6\//.test(u.pathname)) return r.fulfill({ status: 503, contentType: 'application/json', headers: H, body: '{"error":"stubbed"}' });
        if (/\/quote$/.test(u.pathname)) return r.fulfill({ status: 200, contentType: 'application/json', headers: H, body: JSON.stringify({ chainId: 8453, pool: POOLU, relayer: RELAYER, asset: USDC, fee: '20000', gas: '450000', sweepFee: '20000', receiveMin: '4000000' }) });
        if (/\/relay$/.test(u.pathname) && r.request().method() === 'POST') {
          const b = JSON.parse(r.request().postData() || '{}');
          const txHash = await rpc('eth_sendTransaction', [{ from: RELAYER, to: POOLU, data: transactData(b.tx), gas: '0x1e8480' }]);
          relays.push(txHash);
          return r.fulfill({ status: 200, contentType: 'application/json', headers: H, body: JSON.stringify({ txHash }) });
        }
        return r.fulfill({ status: 404, contentType: 'application/json', headers: H, body: '{"error":"no such route"}' });
      });
      await ctx.route(/api\.tacit\.finance\/(points|claim|stats)/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    };
    const init = `(() => {
      const ANVIL = 'https://mainnet.base.org', ACCT = ${JSON.stringify(ACCT)};
      let chain = '0x1';
      const call = async (method, params) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw Object.assign(new Error(r.error.message), r.error); return r.result; };
      window.__chains = [];
      window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCT];
        if (method === 'eth_chainId') return chain;
        if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; window.__chains.push(chain); return null; }
        if (method === 'wallet_getCapabilities') throw Object.assign(new Error('not supported'), { code: -32601 });
        if (method === 'eth_sendTransaction') { if (chain !== '0x2105' || params[0].chainId !== '0x2105') throw new Error('sent on chain ' + chain + ' for ' + params[0].chainId); return call('eth_sendTransaction', [{ ...params[0], from: ACCT }]); }
        if (method === 'eth_signTypedData_v4' && JSON.parse(params[1]).domain.chainId !== 8453) throw new Error('a permit for another chain');
        return call(method, params || []);
      } };
      localStorage.setItem('tacit-pay-chain-v1', '8453');
    })();`;
    const { ctx, p, errors } = await page(browser, { init, route });
    await p.goto(URL_);
    const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const other = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await p.waitForSelector('#g-in');
    const toks = () => p.$$eval('#assets:not([hidden]) [data-tok]', (bs) => bs.map((b) => b.dataset.tok).join(','));
    ok(await toks() === ',usdc,usdt,wsteth', `on Base the page offers ETH and Base's USDC, USDT and wstETH pools (${await toks()})`);
    await p.click('#chain-4663');
    ok(await toks() === ',usdg,usde', `on Robinhood Chain, USDG and USDe (${await toks()})`);
    await p.click('#chain-1');
    ok(await toks() === ',usdc,usdt,tac,wsteth', `on Ethereum, USDC, USDT, TAC and wstETH (${await toks()})`);
    await p.click('#chain-8453');
    await openKey(p, other);
    await p.click('#assets [data-tok="usdc"]');
    await p.click('#tabs [data-tab="receive"]');
    await p.click('#f-acopy');
    const otherTacit = await p.evaluate(() => navigator.clipboard.readText());
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, key);
    await p.evaluate(() => document.querySelector('#wallet-label').click()); await p.click('#w-conn'); await p.click('#sheet-wallet [data-close]');
    await p.click('#assets [data-tok="usdc"]');
    ok(/USDC, private on Base/.test(await p.textContent('#bal')) && /#base\/usdc\//.test(await p.evaluate(() => location.hash)), `Base's USDC is picked (${(await p.textContent('#bal')).replace(/\s+/g, ' ').trim().slice(0, 50)}, ${await p.evaluate(() => location.hash)})`);
    await p.click('#tabs [data-tab="deposit"]');
    await p.waitForFunction(() => /1,000/.test(document.querySelector('#f-wb')?.textContent || ''), null, { timeout: 60e3 }).catch(() => {});
    ok(/1,000/.test(await p.textContent('#f-wb')), `the wallet's USDC is read on Base (${await p.textContent('#f-wb')})`);
    await p.fill('#f-amt', '300');
    const t0 = Date.now(), u0 = await usdcOf(ACCT), n0 = await nonceOf(ACCT);
    await p.click('#f-go');
    await p.waitForFunction(() => /Deposited/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Deposited 300 USDC/.test(await p.textContent('#status')) && u0 - (await usdcOf(ACCT)) === 300n * 10n ** 6n, `deposit of 300 USDC on Base, proved here (${Math.round((Date.now() - t0) / 1000)} s): ${(await p.textContent('#status')).trim()}`);
    ok(await nonceOf(ACCT) - n0 === 1, `one transaction: the permit was signed for Base, so no approval went first (${await nonceOf(ACCT) - n0} sent)`);
    await p.waitForFunction(() => /^300$/.test(document.querySelector('#bal .v')?.textContent.trim() || ''), null, { timeout: 120e3 }).catch(() => {});
    ok(/^300$/.test((await p.textContent('#bal .v')).trim()), `private balance: ${await p.textContent('#bal .v')} USDC`);
    await p.click('#tabs [data-tab="send"]');
    await p.fill('#f-to', otherTacit); await p.fill('#f-amt', '100');
    await p.waitForFunction(() => /Relay fee/.test(document.querySelector('#f-rcpt')?.textContent || '') && !document.querySelector('#f-go').disabled, null, { timeout: 60e3 }).catch(() => {});
    await p.click('#f-go');
    await p.waitForFunction(() => /Sent/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Sent 100 USDC privately/.test(await p.textContent('#status')) && relays.length === 1, `a private send of 100 USDC through Base's relay: ${(await p.textContent('#status')).trim()}`);
    await p.click('#tabs [data-tab="withdraw"]');
    const before3 = await usdcOf('0x' + '33'.repeat(20));
    await p.fill('#f-to', '0x' + '33'.repeat(20)); await p.fill('#f-amt', '50');
    await p.waitForFunction(() => !document.querySelector('#f-go').disabled, null, { timeout: 60e3 }).catch(() => {});
    await p.click('#f-go');
    await p.waitForFunction(() => /Withdrew/.test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), null, { timeout: 600e3 });
    ok(/Withdrew 50 USDC/.test(await p.textContent('#status')) && (await usdcOf('0x' + '33'.repeat(20))) - before3 === 50n * 10n ** 6n && relays.length === 2, `a withdrawal of exactly 50 USDC on Base, sent by the relay: ${(await p.textContent('#status')).trim()}`);
    // a request for 25 USDC on Base, from the other key, paid from a wallet by someone with no Tacit key
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, other);
    await p.click('#assets [data-tok="usdc"]');
    await p.click('#tabs [data-tab="receive"]');
    await p.fill('#f-ramt', '25'); await sleep(300);
    await p.click('#f-rcopy');
    const link = await p.evaluate(() => navigator.clipboard.readText());
    ok(/#pay=tacit1.+asset=usdc.+amount=25.+chain=base/.test(link), `the payment link names USDC, the amount and Base (…${link.slice(-40)})`);
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await p.click('#chain-1');
    await p.goto(link.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
    await p.waitForSelector('#req-wallet');
    ok(/25 USDC.*in USDC on Base/.test((await p.textContent('#req')).replace(/\s+/g, ' ')), `the request reads 25 USDC on Base (${(await p.textContent('#req .req-m')).replace(/\s+/g, ' ').trim().slice(-30)})`);
    await p.click('#req-wallet');
    await p.waitForFunction(() => /now in their private balance|You paid/.test(document.querySelector('#req').textContent) || document.querySelector('#req .err'), null, { timeout: 600e3 });
    ok(/Paid 25 USDC, now in their private balance/.test(await p.textContent('#req')), `paid from a wallet on Base, no Tacit key: ${(await p.textContent('#req')).replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    await p.click('#req-x');
    await openKey(p, other);
    await p.click('#assets [data-tok="usdc"]');
    await p.waitForFunction(() => /^125$/.test(document.querySelector('#bal .v')?.textContent.trim() || ''), null, { timeout: 180e3 }).catch(() => {});
    ok(/^125$/.test((await p.textContent('#bal .v')).trim()), `the recipient's key finds the 100 sent and the 25 paid on Base: ${await p.textContent('#bal .v')} USDC`);
    ok((await p.evaluate(() => window.__chains)).every((c) => c === '0x2105'), `the wallet was only ever asked for Base (${[...new Set(await p.evaluate(() => window.__chains))].join(', ')})`);
    ok(!errors.filter((e) => !/status of (404|503)/.test(e)).length, `no page errors ${errors.join(' | ').slice(0, 200)}`);
    await ctx.close();
    anvil.kill('SIGKILL');
  }

  if (ONLY.has('anyone')) {
    console.log('anyone (Base fork, real keeper)');
    const PORT = WEB + 2, KPORT = WEB + 3, ANVIL = `http://127.0.0.1:${PORT}`;
    const anvil = spawn('anvil', ['--port', String(PORT), '--fork-url', process.env.BASE_RPC || 'https://mainnet.base.org', '--chain-id', '8453', '--silent', '--no-rate-limit'], { stdio: 'ignore' });
    process.on('exit', () => anvil.kill('SIGKILL'));
    const rpc = async (method, params = []) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
    for (let i = 0; ; i++) { try { await rpc('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await sleep(500); } }
    const ACCT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', RELAYER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
    for (const a of [ACCT, RELAYER]) { await rpc('anvil_setCode', [a, '0x']); await rpc('anvil_setBalance', [a, '0x' + (10n ** 18n).toString(16)]); }
    await rpc('anvil_autoImpersonateAccount', [true]);
    const kdb = join(process.env.TMPDIR || '/tmp', `pay-check-keeper-${KPORT}.db`);
    const keeper = spawn('node', ['src/evm-pool-keeper.js'], {
      cwd: new URL('../worker-relay/', import.meta.url).pathname, stdio: 'ignore',
      env: { ...process.env, EVM_POOL_ADDR: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', EVM_POOL_ROUTER_ADDR: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', EVM_POOL_RPC_URL: ANVIL,
        EVM_POOL_CHAIN_ID: '8453', EVM_POOL_KEEPER_PRIV: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', EVM_POOL_KEEPER_DB: kdb, PORT: String(KPORT),
        EVM_POOL_KEEPER_POLL_SECS: '1', EVM_POOL_CONFIRMATIONS: '0', EVM_POOL_START_BLOCK: '51864014', EVM_POOL_KEEPER_SEND_RPC_URLS: ANVIL, EVM_POOL_KEEPER_RATE_PER_MIN: '200' },
    });
    process.on('exit', () => keeper.kill('SIGKILL'));
    for (let i = 0; ; i++) { try { if ((await fetch(`http://127.0.0.1:${KPORT}/health`)).ok) break; } catch {} if (i > 120) throw new Error('keeper did not start'); await sleep(500); }
    const route = async (ctx) => {
      await ctx.route(/mainnet\.base\.org|base\.drpc\.org/, async (r) => {
        const body = r.request().postData();
        let text;
        try { text = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text(); }
        catch (e) { text = JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body || '{}').id ?? 1, error: { code: -32000, message: `fork: ${e.message}` } }); }
        await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: text }).catch(() => {});
      });
      await ctx.route(/tacit-evm-pool-keepers\.onrender\.com\/(1|4663)\//, (r) => r.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"stubbed"}' }));
      await ctx.route(/tacit-evm-pool-keepers\.onrender\.com\/8453\//, async (r) => {
        const u = new URL(r.request().url()), req = r.request();
        try {
          const res = await fetch(`http://127.0.0.1:${KPORT}${u.pathname}${u.search}`, { method: req.method(), headers: { 'content-type': 'application/json' }, body: req.method() === 'GET' ? undefined : req.postData() });
          await r.fulfill({ status: res.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await res.text() });
        } catch (e) { await r.fulfill({ status: 502, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: e.message }) }).catch(() => {}); }
      });
    };
    const init = `(() => {
      const ANVIL = 'https://mainnet.base.org', ACCT = ${JSON.stringify(ACCT)};
      let chain = '0x2105';
      const call = async (method, params) => { const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw Object.assign(new Error(r.error.message), r.error); return r.result; };
      window.ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCT];
        if (method === 'eth_chainId') return chain;
        if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; return null; }
        if (method === 'eth_sendTransaction') return call('eth_sendTransaction', [{ ...params[0], from: ACCT }]);
        return call(method, params || []);
      } };
      localStorage.setItem('tacit-pay-chain-v1', '8453');
    })();`;
    const hexKey = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const balOf = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
    // Waits for a status the press made: the one left from the last action is cleared first.
    const waitStatus = (p, re) => p.waitForFunction((s) => new RegExp(s).test(document.querySelector('#status').textContent) || document.querySelector('#status .err'), re.source, { timeout: 900e3 });
    const press = async (p, sel, re) => { await p.evaluate(() => { document.querySelector('#status').textContent = ''; }); await p.click(sel); await waitStatus(p, re); };
    const text = async (p, sel) => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();
    const { ctx, p, errors } = await page(browser, { init, route });
    await p.goto(URL_);
    await p.waitForSelector('#g-in');
    const key = hexKey(), other = hexKey();
    await openKey(p, other);
    await p.click('#tabs [data-tab="receive"]');
    const otherBp = (await p.textContent('.addr code')).trim();
    await p.click('#wallet'); await p.click('#w-lock'); await p.click('#sheet-wallet [data-close]');
    await openKey(p, key);
    await p.evaluate(() => document.querySelector('#wallet-label').click()); await p.click('#w-conn'); await p.click('#sheet-wallet [data-close]');
    await p.click('#tabs [data-tab="deposit"]');
    await p.fill('#f-damt', '0.01');
    await press(p, '#f-go', /Deposited/);
    ok(/Deposited/.test(await p.textContent('#status')), `deposit: ${await text(p, '#status')}`);
    await p.waitForFunction(() => /0\.01/.test(document.querySelector('#bal .v').textContent), null, { timeout: 120e3 }).catch(() => {});

    // Max leaves room for the relay's fee, and fills in again when the route changes: all of it from the wallet.
    await p.click('#tabs [data-tab="withdraw"]');
    await p.waitForFunction(() => { document.querySelector('#f-max')?.click(); return !!document.querySelector('#f-wamt')?.value; }, null, { timeout: 120e3, polling: 1000 });
    const viaRelay = await p.inputValue('#f-wamt');
    await p.click('[data-route="wallet"]');
    const viaWallet = await p.inputValue('#f-wamt');
    await p.click('[data-route="relay"]');
    const back = await p.inputValue('#f-wamt');
    ok(Number(viaRelay) < 0.01 && viaWallet === '0.01' && back === viaRelay, `Max follows the route: relay ${viaRelay}, wallet ${viaWallet}, relay again ${back}`);
    await p.fill('#f-wamt', '');

    // An 0x address in Send, with a name saved for it; just after a deposit the payment can wait until it blends in.
    const ALICE = '0x' + '44'.repeat(20), alice0 = await balOf(ALICE);
    await p.click('#tabs [data-tab="send"]');
    await p.fill('#f-to', ALICE); await p.fill('#f-amt', '0.002');
    await p.waitForSelector('#f-save:not([hidden])');
    await p.fill('#f-pname', 'Alice'); await p.click('#f-psave');
    await p.waitForSelector('.pchip');
    ok(/Alice/.test(await p.textContent('.people')), 'a name saved for an 0x address shows as a chip');
    await p.fill('#f-amt', '0.002');
    await p.waitForFunction(() => /Pay Alice now/.test(document.querySelector('#f-go').textContent), null, { timeout: 300e3 });
    await p.waitForSelector('#f-later:not([hidden])', { timeout: 300e3 });
    ok(/since yours/.test(await p.textContent('.pv')), `the privacy check asks to wait: ${(await text(p, '.pv')).slice(0, 120)}`);
    await p.click('#f-later');
    await p.waitForSelector('#due:not([hidden]) [data-due]');
    const dueText = await text(p, '#due');
    ok(/Pay Alice/.test(dueText) && /0\.002 ETH/.test(dueText) && /of 5 deposits by others since yours/.test(dueText), `held until it blends in: ${dueText.slice(0, 160)}`);
    await p.waitForSelector('#due [data-due]:not([disabled])', { timeout: 300e3 });
    await press(p, '#due [data-due]', /Paid Alice/);
    ok(/Paid Alice 0\.002 ETH/.test(await p.textContent('#status')), `paid from the card, relayed: ${await text(p, '#status')}`);
    ok(await balOf(ALICE) - alice0 === 2n * 10n ** 15n, 'Alice’s address received exactly 0.002 ETH');
    ok(await p.$eval('#due', (e) => e.hidden), 'the card is gone once paid');

    // Short of private ETH: one press deposits a round amount, and the payment waits for it.
    const BOB = '0x' + '55'.repeat(20);
    await p.fill('#f-to', BOB); await p.fill('#f-amt', '0.02');
    await p.waitForFunction(() => /Deposit .* ETH, pay later/.test(document.querySelector('#f-go').textContent), null, { timeout: 120e3 });
    ok(/Deposit 0\.025 ETH, pay later/.test(await p.textContent('#f-go')), `a short balance offers a round deposit: ${await text(p, '#f-go')}`);
    await press(p, '#f-go', /Deposited/);
    ok(/waits above/.test(await p.textContent('#status')) && /Pay 0x5555…5555/.test(await text(p, '#due')), `deposited, payment held: ${await text(p, '#status')}`);
    await p.click('#due [data-undue]');
    ok(await p.$eval('#due', (e) => e.hidden), 'a held payment can be cancelled');

    // Pay by link: a keyless recipient takes it to their address.
    const makeLink = async (amount, note) => {
      if (!(await p.$('#f-byaddr'))) await p.click('#f-bylink');
      await p.waitForFunction(() => !/Reading your past links/.test(document.querySelector('#f-rcpt').textContent), null, { timeout: 900e3 });
      await p.fill('#f-gamt', amount); await p.fill('#f-gfor', note);
      await p.waitForSelector('#f-go:not([disabled])', { timeout: 120e3 });
      await press(p, '#f-go', /link is ready/);
      ok(/link is ready/.test(await p.textContent('#status')), `link made for ${amount} ETH: ${await text(p, '#status')}`);
      return (await p.textContent('.glink code')).trim();
    };
    const link1 = await makeLink('0.003', 'fork gift');
    ok(/#gift=[0-9a-f]{64}&chain=base&for=fork\+gift$/.test(link1), 'the link carries its key, the chain and the note');
    const CAROL = '0x' + '66'.repeat(20), carol0 = await balOf(CAROL);
    {
      const r = await page(browser, { init: init.replace("localStorage.setItem('tacit-pay-chain-v1', '8453');", ''), route });
      await r.p.goto(link1.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
      await r.p.waitForFunction(() => !!document.querySelector('#gift-take') && /came with the link/.test(document.querySelector('#gift').textContent), null, { timeout: 300e3 });
      ok(/fork gift/.test(await r.p.textContent('#gift')) && /Base/.test(await r.p.textContent('#gift')), `the link opens with its amount and note: ${(await text(r.p, '#gift')).slice(0, 100)}`);
      await r.p.fill('#gift-to', CAROL);
      await r.p.click('#gift-take');
      await r.p.waitForFunction(() => /Sent to 0x/.test(document.querySelector('#gift').textContent) || document.querySelector('#gift-status .err'), null, { timeout: 900e3 });
      ok(/Sent to 0x6{40}/.test(await r.p.textContent('#gift')), `taken by a keyless recipient, relayed: ${await text(r.p, '#gift-status') || (await text(r.p, '#gift')).slice(0, 100)}`);
      { const got = await balOf(CAROL) - carol0; ok(got > 29n * 10n ** 14n && got <= 31n * 10n ** 14n, `they got what was sent, the relay’s fee having ridden in the link: ${Number(got) / 1e18} ETH`); }
      await r.p.goto(link1.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
      await r.p.waitForFunction(() => /Empty/.test(document.querySelector('#gift').textContent), null, { timeout: 300e3 });
      ok(true, 'the link, opened again, says it is empty');
      ok(!r.errors.length, `recipient page: no page errors ${r.errors.join(' | ')}`);
      await r.ctx.close();
    }
    // Another link, taken into someone's own private balance; a third, taken back.
    const link2 = await makeLink('0.001', '');
    {
      const r = await page(browser, { init, route });
      await r.p.goto(link2.replace(/^https?:\/\/[^/]+/, new URL(URL_).origin));
      await r.p.waitForSelector('#gift-keep:not([disabled])', { timeout: 300e3 }).catch(async (e) => { console.log('    ' + await text(r.p, '#gift')); throw e; });
      await openKey(r.p, other);
      await r.p.click('#gift-keep');
      await r.p.waitForFunction(() => /In your private balance/.test(document.querySelector('#gift').textContent) || document.querySelector('#gift-status .err'), null, { timeout: 900e3 });
      ok(/In your private balance/.test(await r.p.textContent('#gift')), `kept private by a Tacit user: ${await text(r.p, '#gift-status') || (await text(r.p, '#gift')).slice(0, 80)}`);
      await r.ctx.close();
    }
    await makeLink('0.0015', 'back');
    await p.waitForSelector('[data-gback]', { timeout: 300e3 });
    await p.evaluate(() => { document.querySelector('#status').textContent = ''; });
    await p.locator('[data-gback]').first().click();
    await waitStatus(p, /Taken back/);
    ok(/Taken back into your private balance/.test(await p.textContent('#status')), `a link taken back: ${await text(p, '#status')}`);
    // The links, found again from the key alone: this browser's own record of them wiped, history rebuilt.
    await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^tacit-pay-gifts-v1:/.test(k)) localStorage.removeItem(k); });
    await p.evaluate(() => { const d = document.querySelector('details.adv'); d.open = true; d.dispatchEvent(new Event('toggle')); });
    await p.click('#rc-go');
    await p.waitForFunction(() => document.querySelectorAll('.gl li').length >= 3 && !/rebuilding/.test(document.querySelector('#recover-at').textContent), null, { timeout: 900e3 }).catch(() => {});
    const links = await p.$$eval('.gl li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    console.log('    ' + links.join('\n    '));
    ok(links.length === 3 && links.filter((l) => /· taken$/.test(l)).length === 2 && links.some((l) => /taken back$/.test(l)), 'every link found again from the key, with what became of it');
    const rows = await p.$$eval('.rows li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    ok(rows.filter((r) => /^Sent by link/.test(r)).length === 3 && rows.some((r) => /^Took back a link/.test(r)), `activity names the links: ${rows.filter((r) => /link/.test(r)).join(' | ').slice(0, 200)}`);
    await shot(p, 'anyone-after');
    ok(!errors.length, `no page errors ${errors.join(' | ')}`);
    await ctx.close();
    keeper.kill('SIGKILL'); anvil.kill('SIGKILL');
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
