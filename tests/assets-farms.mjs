#!/usr/bin/env node
// dapp/assets/: the farms under the assets, in a real browser under the page's own CSP. Ethereum, the farm program and the points service's liquidity campaign are
// stubbed with fixed answers, so every figure on the row is checked against arithmetic done here: the TAC/ETH farm's APR, the best of the private farms, and what the
// campaign pays a dollar held in a TACD or a TACE pool (the day's pot over the weighted dollars, no more than the cap, at TAC's price). Also: the row when the
// campaign is off, when the points service is down, when the TACD pools trade outside their bands and when the private farms are between reward periods; on each
// asset's row, the best farm that pairs it; the campaign's rule at the cap and under it, and when it has not started or has ended; and the layout, six tiles three
// to a row on a desktop and two to a row on a phone.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/assets-farms.mjs        (SHOTS=dir saves screenshots)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { privateFarms, aprText } from '../dapp/trade/farm-read.js';
import { campaignRate, campaignApr, bestApr } from '../dapp/trade/lp-campaign.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname, SHOTS = process.env.SHOTS || null, WEB = 23000 + Math.floor(Math.random() * 1000);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

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
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);

const W = (v) => BigInt(v).toString(16).padStart(64, '0'), E18 = 10n ** 18n;
const PRECISION_POOL = '0x0155358241411db868ba714ae7c83a27087e3d6e', PRECISION_FARM = '0x0000003bf4ba0b21f5e0d35119b337f4d4cf82e0';
const CHAINLINK_ETH = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419', CHAINLINK_BTC = '0xf4030086522a5beea4988f8ca5b36dbc97bee88c';
const TACD = '0xa0f6b02561c8ef08335b69ad25e022c0b342147c', TACE = '0x9de27883c5dc9db47be12e595d59b8f1abec8570', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ZERO = '0x' + '0'.repeat(40);
const POOLS = { tacdPeg: '0xdfee03499f65e56d54aceeedc6f41a09fbeb94b3', tacdBack: '0x867918fd7b6d4f13a20048485147867b9a597534', tacePeg: '0x386627b60cd2a11365e653f0382d92421fddf7a1', taceBack: '0xe1e317700589f3eafca20ac9408c97fe700fc1c1' };
const TOKENS = { [POOLS.tacdPeg]: [TACD, USDC], [POOLS.tacdBack]: [USDC, TACD], [POOLS.tacePeg]: [TACE, ZERO], [POOLS.taceBack]: [ZERO, TACE] };

// Prices: ETH $2,400 and BTC $60,000 (Chainlink, 8 decimals); the TAC/ETH pool's sqrt price is 100, so one TAC is 1/100² ETH = 0.0001 ETH = $0.24.
const ETH_USD = 2400, BTC_USD = 60000, SQRT = 100n, TAC_ETH = 1 / (100 * 100), TAC_USD = ETH_USD * TAC_ETH;
// The public farm: 6 ETH-worth of pool (3 ETH and 30,000 TAC), half of it staked, 100 TAC a day over a year-long period.
const STAKED_ETH = 3, RATE_PER_SEC = 1157407407407407n, PER_DAY = Number(RATE_PER_SEC * 86400n) / 1e18;
const PUBLIC_APR = PER_DAY * 365 * TAC_ETH / STAKED_ETH * 100;

const answers = () => {
  const t = BigInt(Math.floor(Date.now() / 1000)), round = (price) => '0x' + W(1) + W(BigInt(price) * 10n ** 8n) + W(t) + W(t) + W(1);
  return {
    [`${PRECISION_POOL}:0x443cb4bc`]: '0x' + W(3n * E18), [`${PRECISION_POOL}:0x5a76f25e`]: '0x' + W(30000n * E18), [`${PRECISION_POOL}:0x18160ddd`]: '0x' + W(1000n * E18), [`${PRECISION_POOL}:0x2af1f249`]: '0x' + W(SQRT * E18),
    [`${PRECISION_FARM}:0x817b1cd2`]: '0x' + W(500n * E18), [`${PRECISION_FARM}:0x7b0a47ee`]: '0x' + W(RATE_PER_SEC), [`${PRECISION_FARM}:0xebe2b12b`]: '0x' + W(t + 365n * 86400n),
    [`${CHAINLINK_ETH}:0xfeaf968c`]: round(ETH_USD), [`${CHAINLINK_BTC}:0xfeaf968c`]: round(BTC_USD),
    ...Object.fromEntries(Object.entries(TOKENS).flatMap(([pool, [a, b]]) => [[`${pool}:0x0dfe1681`, '0x' + W(BigInt(a))], [`${pool}:0xd21220a7`, '0x' + W(BigInt(b))]])),
  };
};

const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const program = (active = true) => ({
  network: 'mainnet', epoch: { active },
  pools: [
    { pid: 0, pair: 'TAC/cETH', tacPerDayForPool: '553.8888', totalShares: '41570521890', reserves: { assetA: CETH, reserveA: '381294656', reserveB: '4714516976342', lpTotalShares: '41577165540' } },
    { pid: 1, pair: 'cETH/cUSD', tacPerDayForPool: '332.33328', totalShares: '6028127243', reserves: { assetA: CETH, reserveA: '140465504', reserveB: '261567636242', lpTotalShares: '6028128243' } },
    { pid: 2, pair: 'cETH/cBTC', tacPerDayForPool: '221.55552', totalShares: '10418589', reserves: { assetA: CETH, reserveA: '78667932', reserveB: '1402997', lpTotalShares: '10476485' } },
  ],
});
// The campaign: 25 TAC a day, 0.05 TAC at most for a dollar, four pools of about $30 (a full weight and a half weight for each token).
const campaign = (over = {}) => ({
  enabled: true, endSec: Math.floor(Date.now() / 1000) + 30 * 86400,
  terms: { fromDay: 20745, dailyWei: String(25n * E18), createWei: String(150n * E18), capWeiPerUsdDay: String(E18 / 20n) }, next: { fromDay: 20775, dailyWei: null, createWei: null, capWeiPerUsdDay: null },
  pools: [[POOLS.tacdPeg, 10000, 31], [POOLS.tacdBack, 5000, 31], [POOLS.tacePeg, 10000, 25], [POOLS.taceBack, 5000, 31]].map(([pool, w, usd]) => ({ pool, weightBps: String(w), valueUsdWei: String(BigInt(usd) * E18), opened: true, openPaid: true })),
  ...over,
});
const weighted = (c) => c.pools.reduce((s, p) => s + Number(p.valueUsdWei) / 1e18 * Number(p.weightBps) / 1e4, 0);

const RPC_HOSTS = ['ethereum-rpc.publicnode.com', 'eth.drpc.org', '1rpc.io', 'mainnet.gateway.tenderly.co', 'rpc.mevblocker.io', 'eth-mainnet.nodereal.io', '1.rpc.thirdweb.com', 'rpc.flashbots.net', 'eth-mainnet.public.blastapi.io', 'ethereum-json-rpc.stakely.io'];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function openPage({ prog = program(), lp = campaign(), viewport = { width: 1100, height: 900 }, extra = {} } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, colorScheme: 'light' });
  const seen = { rpc: 0, lp: 0, program: 0 }, table = { ...answers(), ...extra };
  for (const h of RPC_HOSTS) await ctx.route(`https://${h}/**`, (route) => {
    seen.rpc++;
    const { id, params } = JSON.parse(route.request().postData() || '{}'), c = params?.[0] || {}, hit = table[`${String(c.to).toLowerCase()}:${String(c.data).slice(0, 10)}`];
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(hit ? { jsonrpc: '2.0', id, result: hit } : { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } }) });
  });
  await ctx.route('https://api.tacit.finance/**', (route) => { seen.program++; return /farm\/program/.test(route.request().url()) && prog ? json(route, prog) : json(route, null, 404); });
  await ctx.route('https://tacit-points.onrender.com/**', (route) => { seen.lp++; return lp ? json(route, lp) : json(route, { error: 'down' }, 503); });
  const page = await ctx.newPage(), errors = [], blocked = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/Failed to load resource/.test(t)) return; (/Content Security Policy|Refused to/i.test(t) ? blocked : errors).push(t); } });
  await page.goto(`http://127.0.0.1:${WEB}/assets/`, { waitUntil: 'load' });
  return { browser, page, errors, blocked, seen };
}
const tileOf = (page, id) => page.evaluate((i) => { const a = document.querySelector(`#fr-${i}`); return a && { href: a.getAttribute('href'), name: a.querySelector('.n b').textContent, sub: a.querySelector('.sub').textContent, apr: a.querySelector('.apr').textContent, day: a.querySelector('.day').textContent, label: getComputedStyle(a.querySelector('.apr + small')).display }; }, id);
const ernOf = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.al .ern')].map((a) => [a.dataset.sym, { hidden: a.hidden, href: a.getAttribute('href'), t: a.textContent.replace(/\s+/g, ' ').trim() }])));
const settle = (page, id, want) => page.waitForFunction(([i, w]) => document.querySelector(`#fr-${i} .apr`)?.textContent === w, [id, want], { timeout: 15000 }).then(() => true, () => false);

try {
  // 1. Everything reads: the figures are the arithmetic's.
  {
    const c = campaign(), total = weighted(c), perUsd = Math.min(25 / total, 0.05), full = perUsd * TAC_USD * 365 * 100;
    const priv = privateFarms(program(), TAC_ETH, { ethUsd: ETH_USD, btcUsd: BTC_USD }), best = priv.reduce((m, x) => (x.apr > m.apr ? x : m));
    const { browser, page, errors, blocked, seen } = await openPage({ lp: c });
    ok(await settle(page, 'tace', aprText(full)), `the TACE tile settles on ${aprText(full)}`);
    ok(await settle(page, 'p2', aprText(priv[2].apr)), `the tETH / cBTC tile settles on ${aprText(priv[2].apr)}`);
    const [pub, tacd, tace, ...prv] = await Promise.all(['pub', 'tacd', 'tace', 'p0', 'p1', 'p2'].map((i) => tileOf(page, i)));
    ok(perUsd === 0.05, 'the cap binds at these depths (25 TAC a day over about $87 of weighted liquidity is far over 0.05 a dollar)');
    ok(pub.apr === aprText(PUBLIC_APR) && pub.href === '/#card=earn:ether:public' && pub.name === 'TAC / ETH' && pub.sub === 'Public pool' && pub.day === `APR · ${Math.round(PER_DAY)} TAC a day`, `the public farm: ${pub.name}, ${pub.sub}, ${pub.apr} (${PUBLIC_APR.toFixed(1)}%), ${pub.day}, to the front page's Earn card on it`);
    ok(priv.length === 3 && priv.every((x, i) => prv[i].apr === aprText(x.apr) && prv[i].href === `/#card=earn:ether:p${x.pid}` && prv[i].name === x.name && prv[i].sub === 'Private pool' && prv[i].day === `APR · ${Math.round(x.perDay).toLocaleString('en-US')} TAC a day`),
      `a tile for each private farm, each to the Earn card on its pool: ${prv.map((t) => `${t.name} ${t.apr} (${t.day})`).join(', ')}`);
    ok(best.pid === 2, 'the best private farm is the tETH / cBTC one at these prices');
    ok(tacd.apr === aprText(full) && tacd.href === '/vault/#v=usd&pools' && tacd.name === 'TACD / USDC' && tacd.sub === 'Borrow market', `TACD / USDC: ${tacd.apr} APR, the full-weight pool's (0.05 TAC a day for a dollar at $${TAC_USD.toFixed(2)} for 365 days), to the dollar vault`);
    ok(tace.apr === aprText(full) && tace.href === '/vault/#v=eth&pools' && tace.name === 'TACE / ETH', `TACE / ETH: ${tace.apr} APR, to the ETH vault`);
    ok(full > 0 && Math.abs(full - 0.05 * 0.24 * 365 * 100) < 1e-9, `the figure is 0.05 TAC × $0.24 × 365 = ${full.toFixed(1)}%`);
    ok([pub, ...prv, tacd, tace].every((t) => t.label !== 'none'), 'each tile says what its figure is');
    // each asset's row: the farm that pays most of those that pair it
    const er = await ernOf(page), tacBest = PUBLIC_APR >= priv[0].apr ? ['/#card=earn:ether:public', PUBLIC_APR] : ['/#card=earn:ether:p0', priv[0].apr];
    ok(er.TAC.href === tacBest[0] && er.TAC.t === `Farm up to ${aprText(tacBest[1])} APR`, `TAC: the better of the TAC/ETH and tETH/TAC farms (${er.TAC.t})`);
    ok(er.tETH.href === `/#card=earn:ether:p${best.pid}` && er.tETH.t === `Farm up to ${aprText(best.apr)} APR`, `tETH: the best of its three (${er.tETH.t})`);
    ok(er.cBTC.href === '/#card=earn:ether:p2' && er.cBTC.t === `Farm ${aprText(priv[2].apr)} APR` && er.cUSD.href === '/#card=earn:ether:p1' && er.cUSD.t === `Farm ${aprText(priv[1].apr)} APR`, `cBTC and cUSD: the one farm each (${er.cBTC.t}; ${er.cUSD.t})`);
    ok(er.TACD.href === '/vault/#v=usd&pools' && er.TACE.href === '/vault/#v=eth&pools' && er.TACD.t === `Farm ${aprText(full)} APR` && Object.values(er).every((x) => !x.hidden), 'TACD and TACE: their markets; every row has its farm link');
    // the whole row opens the asset's page; its farm link is its own
    const hits = await page.evaluate(() => [...document.querySelectorAll('.al li')].map((li) => {
      const r = li.getBoundingClientRect(), e = li.querySelector('.ern').getBoundingClientRect(), at = (x, y) => document.elementFromPoint(x, y)?.closest('a');
      return { page: li.querySelector('.m').getAttribute('href'), corner: at(r.right - 4, r.bottom - 4)?.getAttribute('href'), mark: at(r.left + 20, r.top + 40)?.getAttribute('href'), farm: at(e.left + e.width / 2, e.top + e.height / 2)?.className };
    }));
    ok(hits.length === 6 && hits.every((h) => h.corner === h.page && h.mark === h.page && h.farm === 'ern'), `each row is one link to its page, with the farm link above it (${hits.map((h) => h.page).join(' ')})`);
    ok(/\$0\.240/.test(await text(page, '#px-tac')) && /\$2,?400/.test(await text(page, '#px-teth')), 'the prices above still show');
    ok(errors.length === 0 && blocked.length === 0, `no page errors or blocked requests (${[...errors, ...blocked].join(' | ').slice(0, 160)})`);
    ok(seen.lp === 1 && seen.program === 1, 'the program and the campaign are each read once');
    const lay = await page.evaluate(() => { const r = [...document.querySelectorAll('.fl a')].map((a) => a.getBoundingClientRect()); return { tops: r.map((x) => Math.round(x.top)), widths: r.map((x) => Math.round(x.width)), over: document.documentElement.scrollWidth > innerWidth, under: document.querySelector('.al').getBoundingClientRect().bottom <= document.querySelector('.fr').getBoundingClientRect().top }; });
    ok(lay.widths.length === 6 && new Set(lay.tops.slice(0, 3)).size === 1 && new Set(lay.tops.slice(3)).size === 1 && lay.tops[3] > lay.tops[0], `desktop: six tiles, three in a row (${lay.widths.join(', ')} px wide)`);
    ok(lay.under && !lay.over, 'the row sits under the assets, and the page does not scroll sideways');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'assets-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const ph = await page.evaluate(() => { const r = [...document.querySelectorAll('.fl a')].map((a) => a.getBoundingClientRect()), nm = [...document.querySelectorAll('.fl .n b')].map((b) => Math.round(b.getBoundingClientRect().top)); return { names: nm, tops: r.map((x) => Math.round(x.top)), right: Math.max(...r.map((x) => x.right), ...[...document.querySelectorAll('.al .acts')].map((a) => a.getBoundingClientRect().right)), over: document.documentElement.scrollWidth > innerWidth, clip: [...document.querySelectorAll('.fl .n b')].some((b) => b.scrollWidth > b.clientWidth + 1) }; });
    ok(ph.tops[0] === ph.tops[1] && ph.tops[2] === ph.tops[3] && ph.tops[4] === ph.tops[5] && ph.tops[2] > ph.tops[0] && ph.tops[4] > ph.tops[2], 'phone: two by two by two');
    ok(!ph.over && ph.right <= 390 && !ph.clip, 'phone: nothing sideways, no name cut off');
    ok(ph.names[0] === ph.names[1] && ph.names[2] === ph.names[3] && ph.names[4] === ph.names[5], `phone: the names line up across each row (${ph.names.join(', ')})`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'assets-phone.png'), fullPage: true });
    await browser.close();
  }
  // 2. A tile that has nothing to say stays a link: the campaign off, the points service down, the private farms between reward periods.
  for (const [what, opts] of [['the campaign is off', { lp: campaign({ enabled: false }) }], ['the points service is down', { lp: null }], ['the campaign has not started', { lp: campaign({ terms: { dailyWei: null } }) }], ['the campaign has ended', { lp: campaign({ endSec: 1 }) }]]) {
    const { browser, page, errors } = await openPage(opts);
    ok(await settle(page, 'pub', aprText(PUBLIC_APR)), `${what}: the farms still read`);
    await page.waitForTimeout(800);
    const [tacd, tace] = await Promise.all([tileOf(page, 'tacd'), tileOf(page, 'tace')]), er = await ernOf(page);
    ok(tacd.apr === '' && tace.apr === '' && tacd.label === 'none' && tace.label === 'none' && tacd.href === '/vault/#v=usd&pools' && tace.href === '/vault/#v=eth&pools', `${what}: TACD and TACE show no figure and no label, and still lead to their vaults`);
    ok(er.TACD.hidden && er.TACE.hidden && !er.TAC.hidden, `${what}: the TACD and TACE rows show no farm link`);
    ok(errors.length === 0, `${what}: no page errors`);
    await browser.close();
  }
  // 3. The TACD pools both trading outside their bands (a deposit there goes in at that price): their tile says so, with no figure, and the row has no farm link.
  {
    const band = (now) => ({ '0x2af1f249': now, '0x5c5ac485': 9n * E18 / 10n, '0x87e43840': 11n * E18 / 10n });
    const extra = Object.fromEntries(Object.entries({ [POOLS.tacdPeg]: band(3n * E18), [POOLS.tacdBack]: band(3n * E18), [POOLS.tacePeg]: band(E18), [POOLS.taceBack]: band(E18) })
      .flatMap(([pool, sels]) => Object.entries(sels).map(([sel, v]) => [`${pool}:${sel}`, '0x' + W(v)])));
    const full = 0.05 * TAC_USD * 365 * 100, { browser, page, errors } = await openPage({ extra });
    ok(await settle(page, 'tace', aprText(full)), `outside their bands: the TACE pools are inside theirs and keep ${aprText(full)}`);
    await page.waitForFunction(() => document.querySelector('#fr-tacd .sub')?.textContent === 'Not trading now', null, { timeout: 15000 }).then(() => ok(true, 'the TACD tile says it is not trading now'), () => ok(false, 'the TACD tile says it is not trading now'));
    const [tacd, er] = [await tileOf(page, 'tacd'), await ernOf(page)];
    ok(tacd.apr === '' && tacd.label === 'none' && tacd.href === '/vault/#v=usd&pools' && er.TACD.hidden && !er.TACE.hidden, 'and it shows no figure, still leads to its markets, and the TACD row has no farm link');
    ok(errors.length === 0, 'outside their bands: no page errors');
    await browser.close();
  }
  {
    const { browser, page } = await openPage({ prog: program(false) });
    ok(await settle(page, 'pub', aprText(PUBLIC_APR)), 'between private reward periods: the public farm reads');
    await page.waitForFunction(() => ['p0', 'p1', 'p2'].every((i) => document.querySelector(`#fr-${i} .sub`)?.textContent === 'Between reward periods'), null, { timeout: 15000 }).then(() => ok(true, 'each private tile says it is between reward periods'), () => ok(false, 'each private tile says it is between reward periods'));
    const prv = await Promise.all(['p0', 'p1', 'p2'].map((i) => tileOf(page, i))), er = await ernOf(page);
    ok(prv.every((t) => t.apr === ''), 'the private tiles show no figure');
    ok(er.TAC.t === `Farm ${aprText(PUBLIC_APR)} APR` && er.tETH.hidden && er.cBTC.hidden && er.cUSD.hidden, `the rows: TAC has the public farm alone (${er.TAC.t}), tETH, cBTC and cUSD none`);
    await browser.close();
  }
  {
    const { browser, page } = await openPage({ prog: null });
    await page.waitForTimeout(1500);
    const [pub, ...prv] = await Promise.all(['pub', 'p0', 'p1', 'p2'].map((i) => tileOf(page, i)));
    ok(prv.every((t, i) => t.apr === '' && t.sub === 'Private pool' && t.href === `/#card=earn:ether:p${i}`), 'the farm program unread: the private tiles are what the page wrote, each a link to its farm');
    ok(pub.apr === aprText(PUBLIC_APR), 'the public farm reads on its own');
    await browser.close();
  }
  // 4. The campaign's rule, as the points service applies it (allocateLpDay): the cap, and under it the pot over the weighted dollars; nothing when it is off.
  {
    const near = (x, y) => Math.abs(x - y) < 1e-9, now = Date.now() / 1000;
    const deep = campaign({ pools: [{ pool: POOLS.tacdPeg, weightBps: '10000', valueUsdWei: String(5000n * E18) }, { pool: POOLS.tacdBack, weightBps: '5000', valueUsdWei: String(10000n * E18) }] });
    const r1 = campaignRate(deep, now), apr = campaignApr(r1.perUsd, 10000n, 0.24);
    ok(near(r1.perUsd, 25 / 10000) && near(apr, 25 / 10000 * 0.24 * 365 * 100) && near(campaignApr(r1.perUsd, 5000n, 0.24), apr / 2) && campaignApr(r1.perUsd, 10000n, 0) === null, `deep pools ($10,000 weighted): the pot is shared, ${(r1.perUsd * 1000).toFixed(2)} TAC a day for $1,000, a half-weight pool earns half, and with no TAC price there is no figure`);
    ok(near(campaignRate(campaign({ pools: [] }), now).perUsd, 0.05), 'no liquidity yet: the first dollar earns the cap');
    ok(campaignRate(campaign({ enabled: false }), now) === null, 'off: no rate');
    ok(campaignRate(campaign({ terms: { dailyWei: null, capWeiPerUsdDay: null } }), now) === null, 'not started (only the next terms): no rate');
    ok(campaignRate(campaign({ endSec: 1000 }), 2000) === null, 'ended: no rate');
    ok(campaignRate(null, now) === null, 'unread: no rate');
    const c = { perUsd: 0.05, weights: { usd: [10000n, 5000n], eth: [] } };
    ok(near(bestApr(c, 'usd', 0.24), 0.05 * 0.24 * 365 * 100) && bestApr(c, 'eth', 0.24) === null && bestApr(null, 'usd', 0.24) === null && bestApr(c, 'usd', 0) === null, 'the best of a vault\'s pools is the full-weight one; none for a token no pool trades, an unread campaign or no price');
  }
} catch (e) { fails++; console.log('FAIL   ' + (e?.stack || e)); }
server.close();
console.log(fails ? `\n${fails} failed, ${n} passed` : `\n${n} passed`);
process.exit(fails ? 1 : 0);
