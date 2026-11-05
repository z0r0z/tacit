#!/usr/bin/env node
// dapp/bridge/ in a real browser, under its own CSP. The API, mempool.space and the Ethereum node are answered here (LIVE=1 lets
// them through). Checks the page loads clean; the tile's asset and direction pick its steps, its door and its link; the bridges a
// browser has under way (seeded as the front page journals them) are listed with what each waits on, read from the chains, and no
// signing material reaches the page; another tab's journal write shows at once; the walk-through's steppers and checks answer a
// press; a phone and a dark screen have no sideways scroll.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/bridge-page.mjs        (SHOTS=dir saves screenshots)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null, LIVE = !!process.env.LIVE;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const WEB = 23000 + Math.floor(Math.random() * 1000);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(DAPP, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(WEB);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

// ── what the front page journals ──
const NOW = Date.now(), PUB = '02' + 'ab'.repeat(32), SECRET = 'cd'.repeat(32);
const TAC_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', TETH_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const BURN_TX = 'b1'.repeat(32), MINT_TX = 'c2'.repeat(32);
const IN = [
  { id: 'a1', network: 'mainnet', walletPub: PUB, path: 'reflected', stage: 'rburn-mined', createdAt: NOW - 2 * 3600e3, burnHeight: 972_100,
    source: { txid: 'aa'.repeat(32), vout: 0, assetId: TAC_ID, ticker: 'TAC', amount: { __big: '25000000000' }, blinding: { __big: '7' } },
    burn: { txid: BURN_TX, hex: 'deadbeef' }, notePriv: SECRET },
  { id: 'a3', network: 'mainnet', walletPub: PUB, path: 'reflected', stage: 'rburn-mined', createdAt: NOW - 5 * 3600e3, burnHeight: 972_100,
    source: { txid: 'ac'.repeat(32), vout: 0, assetId: '0x' + TETH_ID, ticker: 'tETH', amount: { __big: '30000000' }, blinding: { __big: '9' } },
    burn: { txid: BURN_TX }, notePriv: SECRET },
  { id: 'a2', network: 'mainnet', walletPub: PUB, path: 'reflected', stage: 'minted', createdAt: NOW - 30 * 3600e3, mintedAt: NOW - 20 * 3600e3, mintedTxHash: '9f'.repeat(32),
    source: { txid: 'ab'.repeat(32), vout: 1, assetId: TAC_ID, ticker: 'TAC', amount: { __big: '100000000000' } }, burn: { txid: 'b2'.repeat(32) } },
];
const OUT = [
  { id: '0x' + 'dd'.repeat(32), network: 'mainnet', walletPub: PUB, stage: 'covered', createdAt: NOW - 40 * 60e3,
    source: { amount: '150000000', value: '151000000', assetId: '0x' + TETH_ID, ticker: 'tETH' },
    settle: { txHash: 'ee'.repeat(32), ethBlock: 26_225_700, claimIdVerified: true } },
  { id: '0x' + 'de'.repeat(32), network: 'mainnet', walletPub: PUB, stage: 'mint-submitted', createdAt: NOW - 20 * 60e3,
    source: { amount: '4000000000', assetId: '0x' + TAC_ID, ticker: 'TAC' }, mint: { revealTxid: MINT_TX, revealHex: 'cafe' },
    settle: { txHash: 'ef'.repeat(32), ethBlock: 26_225_750, claimIdVerified: true } },
];

// LATE: both proofs far behind their chains (Bitcoin's tip 60 blocks past it, Ethereum's head 3,000 blocks past it)
let LATE = false, NO_MEMPOOL = false;
const ETH_COVERED = 26_225_800;

async function mock(ctx) {
  if (LIVE) return;
  await ctx.route('https://api.tacit.finance/**', (route) => {
    const u = new URL(route.request().url());
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
    if (u.pathname === '/reflection/status') return json({ attestedHeight: 972_090, tipHeight: 972_093, confirmations: 24, bridgeBurns: 186, foldedCrossoutCount: 7 });
    if (u.pathname === '/reflection/eth-state/covers') return json({ bestBlock: ETH_COVERED, confirmedBlock: ETH_COVERED, covered: true });
    if (u.pathname === '/confidential/quote') return json({ gasAwareFloorUnits: '52241', staticFloorUnits: '10000' });
    if (u.pathname === '/flow') {                     // the live picture's feed: a day with a few burns, mints and proofs in it
      const t = Math.floor(NOW / 1e3);
      const pt = (dt, k) => ({ t: t - dt, burns: 180 + k, minted: 165 + k, out: 9, att: 972_000 + 10 * k, relay: 972_020 + 10 * k, btc: 972_024 + 10 * k });
      return json({ asOf: t, windowSec: 86400, now: { btc: LATE ? 972_150 : 972_093, relay: 972_090, attested: 972_090, burns: 186, minted: 169, crossOuts: 9 },
        series: [pt(80000, 0), pt(60000, 2), pt(30000, 4), pt(5000, 6)], events: { attests: [0, 1, 2, 3, 4, 5].map((k) => t - 9000 - k * 1800) } });
    }
    return json({ error: 'not found' }, 404);
  });
  await ctx.route('https://mempool.space/**', (route) => {
    const u = route.request().url();
    if (NO_MEMPOOL && u.endsWith('/tip/height')) return route.fulfill({ status: 429, headers: { 'access-control-allow-origin': '*' }, body: 'rate limited' });
    if (u.includes('/v1/fees/recommended')) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ fastestFee: 2, halfHourFee: 2, hourFee: 1 }) });
    const body = u.includes(BURN_TX) ? { confirmed: true, block_height: 972_100 } : u.includes(MINT_TX) ? { confirmed: false } : u.endsWith('/tip/height') ? (LATE ? 972_150 : 972_093) : {};
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await ctx.route('https://ethereum-rpc.publicnode.com/**', (route) => {
    const call = route.request().postDataJSON?.() || {};
    const feed = (usd) => '0x' + [1n, BigInt(usd) * 10n ** 8n, 1n, 1n, 1n].map((w) => w.toString(16).padStart(64, '0')).join('');      // latestRoundData: round, answer, started, updated, answeredIn
    const to = String(call.params?.[0]?.to || '').toLowerCase();
    const result = call.method === 'eth_blockNumber' ? '0x' + (ETH_COVERED + (LATE ? 3000 : 60)).toString(16)
      : to === '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419' ? feed(2500) : to === '0xf4030086522a5beea4988f8ca5b36dbc97bee88c' ? feed(80_000)
      : '0x' + (2_512_345n * 10n ** 18n).toString(16).padStart(64, '0');
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
  });
}

async function openPage(viewport, { scheme = 'light', seed = true, path = '/bridge/', shifts = false, reduced = false, rows = null, notifications = false } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await mock(ctx);
  if (shifts) await ctx.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); });
  if (seed) await ctx.addInitScript(([pub, a, b]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('tacit-burndep-bridge-v1:mainnet:' + pub, a);
    localStorage.setItem('tacit-crossout-bridge-v1:mainnet:' + pub, b);
  }, [PUB, JSON.stringify(rows ? rows.in : IN), JSON.stringify(rows ? rows.out : OUT)]);
  // A notification the page asks for is recorded here (permission is granted when it is requested), so what it would say can be read.
  if (notifications) await ctx.addInitScript(() => {
    window.__notes = [];
    window.Notification = class { static permission = 'default'; static async requestPermission() { window.Notification.permission = 'granted'; return 'granted'; } constructor(t, o) { window.__notes.push([t, (o && o.body) || '']); } close() {} };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${WEB}${path}`, { waitUntil: 'load' });
  return { browser, page, errors };
}
const shot = async (page, name, full = false) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: full }); };

try {
  // ── desktop, light ──
  {
    const { browser, page, errors } = await openPage({ width: 1280, height: 900 }, { shifts: true });
    await page.waitForFunction(() => !document.querySelector('[data-live="btc"]').classList.contains('sk'), null, { timeout: 20000 });
    await page.waitForTimeout(1500);
    const cls = await page.evaluate(() => window.__cls);
    console.log('  cls ' + cls.toFixed(4));
    ok(cls <= 0.04, `layout shift while it loads is ${cls.toFixed(3)} (at most 0.04)`);
    ok(await page.textContent('h1') === 'Cross by proof', 'the title');
    ok((await page.textContent('#pf-btc')).includes('972,090'), 'Bitcoin’s proof on Ethereum, live');
    ok((await page.textContent('#pf-btc')).includes('3 behind the tip'), 'and how far it is from the tip');
    ok((await page.textContent('#pf-eth')).includes('26,225,800'), 'Ethereum’s proof for Bitcoin, live');
    ok((await page.textContent('#pf-eth')).includes('12 min behind the head') && await page.getAttribute('#pf-eth', 'data-state') === 'on', 'and how far it is from the head, in minutes');
    ok(await page.getAttribute('#pf-btc', 'data-state') === 'on' && !(await page.textContent('#bt-wait')).includes('behind'), 'a proof close to its chain is not called slow, and the tile’s wait line adds nothing');
    ok(await page.getAttribute('#bt-go', 'href') === '/#card=bridge:btc', "TAC from Bitcoin opens the front page's Bridge tab on it");
    ok((await page.$$('#bt-steps li')).length === 4, 'four steps');
    ok((await page.$$('#bt-steps li svg.tk')).length === 2 && /Burned\s+on Bitcoin/.test(await page.textContent('#bt-steps')), 'the steps that happen on a chain show its mark, and keep its name for a screen reader');
    await page.click('#bt-flip');
    ok(await page.getAttribute('#bt-go', 'href') === '/#card=bridge:tac' && await page.evaluate(() => location.hash) === '#tac/out', 'the flip: TAC to Bitcoin, and the link says so');
    ok((await page.textContent('#bt-from')) === 'Ethereum', 'from Ethereum');
    await page.click('[data-asset="teth"]');
    ok((await page.textContent('#bt-limit')) === '0.001 to 0.5 tETH a bridge while it is new', 'tETH to Bitcoin: the tile says what one bridge takes');
    ok((await page.textContent('#bt-wait')).includes('a little BTC'), 'and that a little BTC from the address pays the mint');
    await page.waitForFunction(() => /\$/.test(document.querySelector('#bt-cost')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    ok((await page.textContent('#bt-cost')) === 'From $2.28 now: 0.0005 tETH to the relay and 1,214 sats on Bitcoin', `the way out says what it costs now, from the relay\'s floor, the fee rate and the prices (${await page.textContent('#bt-cost')})`);
    ok(/^A few hours: Ethereum finalizes \(about 13 min\), the next proof covers it, then you sign the Bitcoin step/.test(await page.textContent('#bt-wait')), 'the way out says it takes hours: finality, then the proof that covers the burn, then the Bitcoin step, not finality alone');
    ok(await page.getAttribute('.lost a', 'href') === '/#private/bitcoin/back', 'and a bridge that cannot be seen is looked for on the Private ETH sheet, where tETH’s are found');
    await page.click('#bt-flip');
    ok((await page.textContent('#bt-go')).includes('Bring tETH back') && (await page.getAttribute('#bt-way', 'aria-label')) === 'Bitcoin to Ethereum' && (await page.textContent('#bt-limit')) === 'Up to 0.5 tETH a bridge while it is new', 'tETH back from Bitcoin: its own button and limit');
    ok((await page.textContent('#bt-cost')) === 'About $0.80 now: 1,000 sats on Bitcoin; Tacit covers the Ethereum side', 'and the way back says its own cost');
    await page.click('#bt-flip');
    ok(await page.getAttribute('#bt-go', 'href') === '/#card=bridge:eth' && (await page.textContent('#bt-go')).includes('Bridge tETH') && (await page.getAttribute('#bt-way', 'aria-label')) === 'Ethereum to Bitcoin', 'tETH to Bitcoin');
    // cBTC and cUSD cross as tETH does: back from Bitcoin by default, to Bitcoin turned around, each with its limit
    await page.click('[data-asset="cbtc"]');
    if (await page.$eval('#bt', (b) => b.dataset.dir) === 'out') await page.click('#bt-flip');   // the way picked carries over from tETH's
    ok(await page.getAttribute('#bt-go', 'href') === '/#card=bridge:kb' && (await page.textContent('#bt-go')).includes('Bring cBTC back') && !(await page.isDisabled('#bt-flip')) && (await page.textContent('#bt-from')) === 'Bitcoin', 'cBTC comes back from Bitcoin through the Bridge tab, and turns around');
    ok(await page.getAttribute('.lost a', 'href') === '/#borrow/bitcoin/cbtc/back', 'a cBTC bridge that cannot be seen is looked for on the Borrow sheet, under cBTC and cUSD on Bitcoin');
    await page.click('#bt-flip');
    ok(await page.getAttribute('#bt-go', 'href') === '/#card=bridge:cbtc' && (await page.textContent('#bt-limit')) === '0.00001 to 0.5 cBTC a bridge while it is new', 'cBTC to Bitcoin, with what one bridge takes');
    await page.click('[data-asset="cusd"]');
    ok(await page.getAttribute('#bt-go', 'href') === '/#card=bridge:cusd' && (await page.textContent('#bt-go')).includes('Bridge cUSD') && (await page.textContent('#bt-limit')) === '10 to 1,000 cUSD a bridge while it is new', 'cUSD to Bitcoin, with what one bridge takes');
    await page.click('#bt-flip');
    ok(await page.getAttribute('#bt-go', 'href') === '/#card=bridge:ub' && (await page.textContent('#bt-go')).includes('Bring cUSD back'), 'and cUSD back from Bitcoin');
    await page.click('[data-asset="cusdt"]');
    ok(await page.getAttribute('#bt-go', 'href') === '/#card=bridge:ut' && (await page.textContent('#bt-go')).includes('Bring USDT back') && (await page.textContent('#bt-limit')) === 'Up to 100 cUSDT a bridge while it is new', 'USDT is brought back from Bitcoin, with what one bridge takes');
    await page.click('#bt-flip');
    ok(await page.getAttribute('#bt-go', 'href') === '/#card=bridge:wusdt' && (await page.textContent('#bt-go')).includes('Bridge USDT') && (await page.textContent('#bt-limit')) === '2 to 100 cUSDT a bridge while it is new', 'and USDT to Bitcoin starts from the wallet\'s USDT, with its two-dollar least');
    await page.click('#bt-flip');
    await page.click('[data-asset="tac"]');
    await shot(page, 'desktop-top');

    // your bridges
    ok(await page.isVisible('#mine'), 'the bridges under way are listed');
    const rows = await page.$$eval('#mine-l > li', (ls) => ls.map((l) => l.innerText));
    ok(rows.length === 5, `five bridges (${rows.length})`);
    ok(rows.some((r) => /0\.3 tETH/.test(r)) && await page.$$eval('#mine-l > li', (ls) => ls.some((l) => /0\.3 tETH/.test(l.innerText) && l.querySelector('.mb-t .cc')?.getAttribute('aria-label') === 'to Ethereum')), 'a tETH bridge coming back from Bitcoin is listed as tETH, with its amount and the way it goes');
    ok(/1\.5 tETH/.test(rows[0]) && /Send to Bitcoin/.test(rows[0]), 'the one that needs its holder comes first, with its press');
    ok(await page.$eval('#mine-l > li .mb-due', (a) => a.getAttribute('href')) === '/#private/bitcoin/out', 'which opens its sheet, on the way it goes');
    ok(rows.some((r) => /250 TAC/.test(r) && /10 blocks behind/.test(r)), 'a burn on Bitcoin: how far the proof is behind its block');
    ok(rows.some((r) => /40 TAC/.test(r) && /mempool/.test(r)), 'a mint on Bitcoin: still in the mempool');
    ok(rows.some((r) => /1,000 TAC/.test(r) && /Arrived/.test(r)), 'an arrival');
    ok((await page.textContent('#mine-n')).includes('1 needs you'), 'the count of what needs its holder');
    const html = await page.content();
    ok(!html.includes(SECRET) && !html.includes('deadbeef') && !html.includes('cafe"'), 'no signing material reaches the page');
    ok(await page.$eval(`#mine-l a[href*="${BURN_TX}"]`, (a) => a.href.startsWith('https://mempool.space/tx/')).catch(() => false), 'the Bitcoin transaction is linked');

    // another tab moves a bridge on
    await page.evaluate(([pub, out]) => {
      const list = JSON.parse(out); list[0].stage = 'mint-submitted';
      localStorage.setItem('tacit-crossout-bridge-v1:mainnet:' + pub, JSON.stringify(list));
      window.dispatchEvent(new StorageEvent('storage', { key: 'tacit-crossout-bridge-v1:mainnet:' + pub }));
    }, [PUB, JSON.stringify(OUT)]);
    await page.waitForFunction(() => !document.querySelector('#mine-l .mb-due'), null, { timeout: 5000 }).catch(() => {});
    ok(!(await page.$('#mine-l .mb-due')), 'another tab’s write shows at once');

    // the walk-through
    await page.locator('#c2-h').scrollIntoViewIfNeeded();
    const step = page.locator('section:has(#c2-h) .st-l li').nth(2);
    await step.click();
    ok(await step.getAttribute('aria-current') === 'step', 'a press picks a step');
    ok(await page.$eval('section:has(#c2-h) figure', (f) => f.dataset.at) === '2', 'and the drawing follows');
    await shot(page, 'desktop-b2e');
    await page.click('[data-ck="pool"]');
    ok(await page.isVisible('[data-ckp="pool"]') && !(await page.isVisible('[data-ckp="work"]')), 'who checks what: a press names it');
    await page.click('#note-fig button[data-side="eth"]');
    ok(await page.$eval('#note-fig', (f) => f.dataset.side) === 'eth', 'the note, in the pool');
    ok((await page.textContent('[data-live="supply"]')).includes('2,512,345'), 'the TAC that crossed, live');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on a desktop');
    // scrolled through as a reader would: every section comes in
    for (let y = 0; y < await page.evaluate(() => document.body.scrollHeight); y += 500) { await page.evaluate((v) => scrollTo(0, v), y); await page.waitForTimeout(120); }
    await page.waitForTimeout(900);
    ok(await page.$$eval('.rv', (els) => els.every((e) => e.classList.contains('in'))), 'every section comes in as it is scrolled to');
    const cls2 = await page.evaluate(() => window.__cls);
    console.log('  cls after scrolling the whole page ' + cls2.toFixed(4));
    ok(cls2 <= 0.04, `layout shift over a scroll through the whole page is ${cls2.toFixed(3)} (at most 0.04)`);
    await page.evaluate(() => document.querySelector('#rf').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
    ok(await page.$eval('#rf', (e) => e.dataset.run) === '1' && await page.$eval('#bt', (e) => e.dataset.run) === '0' && await page.$eval('#mv', (e) => e.dataset.run) === '0', 'motion runs only where it can be seen: the drawing in view runs, the tile and the other drawings are held');
    ok(await page.$eval('#rf .lane-b svg', (e) => getComputedStyle(e).animationPlayState) === 'running' && await page.$eval('#mv svg', (e) => getComputedStyle(e.querySelector('.flow')).animationPlayState) === 'paused', 'and a held drawing’s animations are paused, not only hidden');
    await page.waitForFunction(() => !!document.querySelector('#live-v canvas'), null, { timeout: 10000 }).catch(() => {});
    ok(!!(await page.$('#live-v canvas')), 'the live picture of both chains is drawn');
    ok((await page.textContent('#bt-wait')).includes('About 4 hours') && (await page.textContent('#bt-wait')).includes('about every 30 min'), 'the tile says how long it takes, with the live proof cadence');
    await page.click('#bt-flip');
    ok((await page.textContent('#bt-wait')).includes('A few hours: Ethereum finalizes'), 'and the other way waits for Ethereum to finalize, the proof, and the Bitcoin step');
    await page.click('#bt-flip');
    ok(await page.getAttribute('.lost a', 'href') === '/#bridge', 'a bridge that cannot be seen has a way back to the front page’s Find it');
    await page.click('#hood-dir button[data-dir="out"]');
    ok(await page.isVisible('#hood [data-hood="out"]') && !(await page.isVisible('#hood [data-hood="in"]')) && await page.isVisible('#hood figure[data-for="out"]') && !(await page.isVisible('#hood figure[data-for="in"]')), 'under the hood: the switch shows the way out, its steps and its drawing');
    await page.locator('#hood [data-hood="out"] [data-step]').nth(2).click();
    ok(await page.$eval('#hood figure[data-for="out"]', (f) => f.dataset.at) === '2', 'and a press on its step moves its drawing');
    await page.click('#hood-dir button[data-dir="in"]');
    await page.click('.faq summary');
    ok(await page.isVisible('.faq details[open] p'), 'a question opens to its answer');
    ok((await page.$$('.faq details')).length === 5, 'five questions');
    const faq = await page.textContent('.faq');
    ok(/TAC 20 to 1,000 to Bitcoin and up to 1,000 back/.test(faq) && /tETH 0\.001 to 0\.5 to Bitcoin and up to 0\.5 back/.test(faq) && /cBTC 0\.00001 to 0\.5 to Bitcoin and up to 0\.5 back/.test(faq) && /cUSD 10 to 1,000 to Bitcoin and up to 1,000 back/.test(faq) && /255 transfers/.test(faq), 'the limits answer gives each asset its own range, both ways, and the history it proves');
    ok(/To Bitcoin, a small relay fee comes out of the note/.test(faq) && /Tacit covers the Ethereum mint/.test(faq), 'and the cost answer is right for both directions');
    ok(!/allowance|free/i.test(await page.textContent('.faq')), 'the answers keep to plain words about who pays');
    ok(await page.getAttribute('.runcta .go', 'href') === '/prove/#tab=bitcoin' && (await page.$$('#run .cap3 li')).length === 3 && (await page.$$('#run .pill')).length === 3, 'anyone can run it: three steps, each open to anyone, and a door to community ops');
    ok(await page.getAttribute('.trio a', 'href') === '#run', 'and the top of the page points to it');
    const body = await page.textContent('main');
    ok(!/same commitment|same note|without opening/i.test(body) && /fresh note of the same value/.test(body), 'a bridge is said to mint a fresh note of the same value, not the same note');
    ok(/Only whoever proves the mint sees it/.test(await page.textContent('.faq')), 'and the privacy answer says who sees the amount');
    await page.click('#mv-dir button[data-dir="out"]');
    ok(await page.$eval('#mv', (f) => f.dataset.dir) === 'out' && (await page.$eval('#mv-a', (u) => u.getAttribute('href'))) === '#c-eth' && (await page.isVisible('.mvc .out')) && !(await page.isVisible('.mvc .in')), 'burn, prove, mint: the switch turns it to Ethereum → Bitcoin');
    ok((await page.textContent('#rf')).includes('972,090'), 'the reflection drawing carries the live block');
    for (const [id, name] of [['#rf', 'sec-reflection'], ['#mv-h', 'sec-moves'], ['#c1-h', 'sec-note'], ['#c2-h', 'sec-b2e'], ['#hood', 'sec-hood'], ['#run', 'sec-run'], ['.faq', 'sec-faq'], ['#c4-h', 'sec-trust'], ['#live-h', 'sec-live'], ['#rt-h', 'sec-roundtrip']]) {
      await page.evaluate((q) => { document.querySelector(q).scrollIntoView({ block: 'start' }); scrollBy(0, -90); }, id); await page.waitForTimeout(700); await shot(page, name);
    }
    await shot(page, 'desktop-full', true);
    ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ').slice(0, 400) : ''}`);
    await browser.close();
  }

  // ── a hash picks the tile; a phone, dark ──
  {
    const { browser, page, errors } = await openPage({ width: 390, height: 844 }, { scheme: 'dark', path: '/bridge/#teth/out' });
    await page.waitForFunction(() => document.querySelector('#bt').dataset.asset === 'teth', null, { timeout: 10000 });
    ok(await page.getAttribute('#bt-go', 'href') === '/#card=bridge:eth' && await page.$eval('#bt', (b) => b.dataset.dir) === 'out', 'the link #teth/out opens on tETH to Bitcoin');
    await page.waitForTimeout(800);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on a phone');
    ok(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(21, 19, 14)', 'dark paper');
    await shot(page, 'phone-dark');
    await shot(page, 'phone-dark-full', true);
    for (const [id, name] of [['#rf', 'phone-reflection'], ['#mv-h', 'phone-moves']]) {
      await page.evaluate((q) => { document.querySelector(q).scrollIntoView({ block: 'start' }); scrollBy(0, -60); }, id); await page.waitForTimeout(900); await shot(page, name);
    }
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the wide drawings scroll inside their frames, not the page');
    ok(errors.length === 0, `no console errors on a phone${errors.length ? ': ' + errors.join(' | ').slice(0, 400) : ''}`);
    await browser.close();
  }

  // ── both proofs far behind their chains ──
  {
    LATE = true;
    const { browser, page, errors } = await openPage({ width: 1280, height: 900 }, { path: '/bridge/#TETH' });
    await page.waitForFunction(() => document.querySelector('#pf-elag').textContent !== '' && document.querySelector('#pf-lag').textContent !== '', null, { timeout: 20000 });
    LATE = false;
    ok(await page.$eval('#bt', (b) => b.dataset.asset) === 'teth', 'a hash in capitals still picks the asset');
    ok(await page.getAttribute('#pf-btc', 'data-state') === 'slow' && await page.getAttribute('#pf-eth', 'data-state') === 'slow', 'a proof far behind its chain reads as slow, on both lines');
    ok((await page.textContent('#pf-eth')).includes('10 hours behind the head'), 'Ethereum’s lag is in hours once it is past an hour and a half');
    ok(/Right now the proof is about 6 hours behind, so it takes longer/.test(await page.textContent('#bt-wait')), 'and the way in says how late the proof is, so the four hours are not promised');
    await page.click('#bt-flip');
    ok(/^A few hours: Ethereum finalizes.*Right now the proof is about 6 hours behind, so it takes longer$/.test(await page.textContent('#bt-wait')), 'the way out says so too: one proof carries both chains');
    ok(errors.length === 0, `no console errors with the proofs behind${errors.length ? ': ' + errors.join(' | ').slice(0, 400) : ''}`);
    await browser.close();
  }

  // ── mempool.space does not answer: the API's own view of Bitcoin's tip stands in ──
  {
    LATE = true; NO_MEMPOOL = true;
    const { browser, page, errors } = await openPage({ width: 1280, height: 900 });
    await page.waitForFunction(() => document.querySelector('#pf-lag').textContent !== '', null, { timeout: 20000 }).catch(() => {});
    LATE = false; NO_MEMPOOL = false;
    ok((await page.textContent('#pf-btc')).includes('60 behind the tip') && await page.getAttribute('#pf-btc', 'data-state') === 'slow', 'with mempool.space refusing, the lag is still read, from the API’s own tip, and a late proof still reads as slow');
    await browser.close();
  }

  // ── a tab left open: a step the chains call ready is named, the tab says so, and an opt-in notification fires once ──
  {
    const row = (id, stage, extra = {}) => ({ id: '0x' + id.repeat(32), network: 'mainnet', walletPub: PUB, stage, createdAt: NOW - 30 * 60e3,
      source: { amount: '100000', value: '110000', assetId: '0x' + TETH_ID, ticker: 'tETH' }, settle: { txHash: 'ee'.repeat(32), ethBlock: 26_225_700, claimIdVerified: true }, ...extra });
    const READY = row('ab', 'settled');                                    // the journal says it waits for the proof; the proof has reached its block
    const { browser, page, errors } = await openPage({ width: 1280, height: 900 }, { rows: { in: [], out: [READY] }, notifications: true });
    await page.waitForFunction(() => document.querySelector('#mine-l .mb-due'), null, { timeout: 20000 });
    ok(await page.title() === '(1) tacit bridge', `the tab\'s title says one bridge needs its holder (${await page.title()})`);
    ok(/Send to Bitcoin/.test(await page.textContent('#mine-l .mb-due')) && (await page.textContent('#mine-n')).includes('1 needs you'), 'the chains\' word names the step although the journal still says settled');
    ok(await page.$eval('#mine-l .mb-due', (a) => a.getAttribute('href')) === '/#private/bitcoin/out', 'and its press opens the way out');
    ok(/^checked /.test(await page.textContent('#mine-t')), 'the list says when the chains were last read');
    ok(await page.isVisible('#mine-bell') && (await page.textContent('#mine-bell')) === 'Notify me', 'a browser that can notify offers it');
    await page.click('#mine-bell');
    await page.waitForFunction(() => document.querySelector('#mine-bell').getAttribute('aria-pressed') === 'true');
    ok((await page.evaluate(() => window.__notes.length)) === 0, 'turning it on says nothing about what the page opened on');
    // another tab moves a second bridge to the step that needs its holder, and a first one arrives
    await page.evaluate(([pub, a, b]) => {
      const list = JSON.parse(localStorage.getItem('tacit-crossout-bridge-v1:mainnet:' + pub));
      list.push(JSON.parse(a)); list.find((r) => r.id === JSON.parse(b).id).stage = 'minted'; list.find((r) => r.id === JSON.parse(b).id).mintedAt = Date.now();
      localStorage.setItem('tacit-crossout-bridge-v1:mainnet:' + pub, JSON.stringify(list));
      window.dispatchEvent(new StorageEvent('storage', { key: 'tacit-crossout-bridge-v1:mainnet:' + pub }));
    }, [PUB, JSON.stringify(row('cd', 'covered')), JSON.stringify(READY)]);
    await page.waitForFunction(() => window.__notes.length >= 2, null, { timeout: 8000 }).catch(() => {});
    const notes = await page.evaluate(() => window.__notes);
    ok(notes.length === 2 && notes.some(([t, b]) => /0\.001 tETH bridge needs you/.test(t) && /Send to Bitcoin/.test(b)) && notes.some(([t]) => /0\.001 tETH has arrived/.test(t)), `one notification for the step that needs its holder and one for the arrival (${JSON.stringify(notes)})`);
    await page.evaluate((pub) => window.dispatchEvent(new StorageEvent('storage', { key: 'tacit-crossout-bridge-v1:mainnet:' + pub })), PUB);
    await page.waitForTimeout(400);
    ok((await page.evaluate(() => window.__notes.length)) === 2, 'and a state already told is not told again');
    await page.click('#mine-bell');
    ok(await page.getAttribute('#mine-bell', 'aria-pressed') === 'false' && (await page.textContent('#mine-bell')) === 'Notify me', 'it can be turned off');
    ok(errors.length === 0, `no console errors with a tab left open${errors.length ? ': ' + errors.join(' | ').slice(0, 300) : ''}`);
    await browser.close();
  }

  // ── a reader who asks for less motion ──
  {
    const { browser, page, errors } = await openPage({ width: 1280, height: 900 }, { reduced: true });
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('#rf').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(500);
    ok(await page.$eval('#rf .lane-b svg', (e) => getComputedStyle(e).animationName) === 'none' && await page.$eval('#bt-steps li', (e) => getComputedStyle(e, '::after').animationName) === 'none', 'reduced motion: nothing drifts, glows or pulses');
    ok(await page.$eval('#rf', (e) => e.dataset.run) === '0' && await page.$eval('#rf svg.rf-top', (e) => e.animationsPaused()), 'and the drawings’ own animations are held');
    ok(await page.$$eval('.rv', (els) => els.every((e) => getComputedStyle(e).opacity === '1')), 'and every section is simply there');
    ok(errors.length === 0, 'no console errors with reduced motion');
    await browser.close();
  }

  // ── the header menu shows a bridge under way, on this page and on any other that has the menu ──
  for (const path of ['/bridge/', '/vault/']) {
    const { browser, page } = await openPage({ width: 1024, height: 800 }, { path });
    await page.waitForSelector('.sm summary', { state: 'attached' });
    await page.waitForTimeout(500);
    const read = () => page.evaluate(() => {
      const s = document.querySelector('.sm summary'), t = document.querySelector('.sm-p a[href="/bridge/"]'), d = s.querySelector(':scope > .bd');
      return { dot: !!d && !d.hidden, label: s.getAttribute('aria-label'), tag: t?.lastElementChild && !t.lastElementChild.hidden ? t.lastElementChild.textContent : '' };
    });
    let m = await read();
    ok(m.dot && m.tag === '1 needs you' && /4 bridges under way, 1 needs you/.test(m.label), `${path}: the menu button carries a dot, and the menu's Bridges entry says what waits on the holder (${JSON.stringify(m)})`);
    await page.evaluate(([pub, a, b]) => {
      localStorage.setItem('tacit-burndep-bridge-v1:mainnet:' + pub, a); localStorage.setItem('tacit-crossout-bridge-v1:mainnet:' + pub, b);
      window.dispatchEvent(new StorageEvent('storage', { key: 'tacit-crossout-bridge-v1:mainnet:' + pub }));
    }, [PUB, JSON.stringify(IN.map((r) => ({ ...r, stage: 'minted' }))), JSON.stringify(OUT.map((r) => ({ ...r, stage: r.id.endsWith('dd'.repeat(32)) ? 'mint-submitted' : 'minted' })))]);
    await page.waitForTimeout(300);
    m = await read();
    ok(m.dot && m.tag === '1 under way', `${path}: another tab's write shows at once: one bridge still under way, none waiting on the holder (${JSON.stringify(m)})`);
    await page.evaluate(([pub, b]) => {
      localStorage.setItem('tacit-crossout-bridge-v1:mainnet:' + pub, b);
      window.dispatchEvent(new StorageEvent('storage', { key: 'tacit-crossout-bridge-v1:mainnet:' + pub }));
    }, [PUB, JSON.stringify(OUT.map((r) => ({ ...r, stage: 'minted' })))]);
    await page.waitForTimeout(300);
    m = await read();
    ok(!m.dot && !m.tag && m.label === 'More pages', `${path}: once every bridge has arrived the dot and the count go (${JSON.stringify(m)})`);
    await browser.close();
  }

  // ── a browser with no bridges ──
  {
    const { browser, page, errors } = await openPage({ width: 1024, height: 800 }, { seed: false });
    await page.waitForTimeout(500);
    ok(!(await page.isVisible('#mine')), 'no bridges, no list');
    ok(errors.length === 0, 'no console errors with nothing journaled');
    await browser.close();
  }
} catch (e) {
  fails++;
  console.log('FAIL   ' + (e.stack || e));
}
server.close();
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
