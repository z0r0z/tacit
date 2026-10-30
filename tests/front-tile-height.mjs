#!/usr/bin/env node
// The front page's tile holds the height its Swap tab settles at from the first paint (dapp/index.html: `.hx:has(#hx-body > .hx-sk)`), so what is below the tile does not
// move when the script draws it. The heights are measured, not derived, and go stale when the card gains or loses a block (the "Private in" block took the card from 448 to
// 537 px and nothing said so), so this loads the page in a real browser at each width the rules name and compares the height held at the first paint with the height it settles at.
// Nothing leaves the machine: every request to another host is refused, and the page's stats (the points figure in the card's "Private in" row comes from them: written as
// an estimate it wraps at some widths, as a floor it does not, so it changes the height there) are a copy of the live ones.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/front-tile-height.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const PORT = 31000 + Math.floor(Math.random() * 900);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(PORT);

// /stats?network=mainnet&view=front as api.tacit.finance served it on 2026-10-31
const STATS = {"at":1793399460076,"errors":{},"btc":{"locked":{"$n":"11946354"},"nLocked":24,"redeemed":1,"unlocked":1,"waiting":0,"mint":{"$n":"12028354"},"nMint":26,"bonds":{"$n":"5229877550309034646"},"nBonds":25,"borrowed":{"$n":"475631815650"},"repaid":{"$n":"30135000000"},"liq":{"$n":"0"},"out":{"$n":"445496815650"},"open":14,"tacbtc":{"$n":"294000000000000"},"tacusd":{"$n":"17786783520000000000"}},"tac":{"supply":{"$n":"2747600882945190000000000"},"tacIn":{"n":77,"v":{"$n":"108679936311650000000000"}},"tacOut":{"n":896,"v":{"$n":"650665046792420000000000"},"who":140},"times":{"out":[1793292611,1793305619,1793335703,1793355719,1793355851,1793355995,1793356103,1793366951,1793367047,1793367131,1793367191,1793369267],"in":[1792559015,1792571891,1792586135,1792595447,1792699499,1792949123,1792977047,1793050151,1793069495,1793097563,1793097839,1793358779]},"claims":1048,"claimed":{"$n":"358661076406780000000000"},"claimers":1048,"others":[{"n":3,"v":{"$n":"4630000"},"m":{"symbol":"USDT","decimals":6,"token":"0xdac17f958d2ee523a2206206994597c13d831ec7"}},{"n":2,"v":{"$n":"2000000"},"m":{"symbol":"USDC","decimals":6,"token":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"}},{"n":1,"v":{"$n":"400000000000000"},"m":{"symbol":"wstETH","decimals":18,"token":"0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"}},{"n":1,"v":{"$n":"96756200000000000000"},"m":{"symbol":"tacUSD","decimals":18,"token":"0x23cacffac2674514a6d4f6cd420b4cc2ac921564"}},{"n":1,"v":{"$n":"1322770000000000"},"m":{"symbol":"tacBTC","decimals":18,"token":"0xdf1d99148beb7a9aff1d95c49b3d22b7ed90d696"}}]},"dev":[{"chain":1,"bal":{"$n":"6088889423417993038"},"dep":{"$n":"104493540641265801250"},"wd":{"$n":"98404651217847808212"},"nd":164,"nw":151,"moves":343,"lastAt":1793296979,"series":{"ins":[[1793091263,{"$n":"2000000000000000000"}],[1793092679,{"$n":"10000000000000000"}],[1793093039,{"$n":"10000000000000000"}],[1793094839,{"$n":"7770000000000000"}],[1793096843,{"$n":"2000000000000000"}],[1793097743,{"$n":"6481430000000000"}],[1793098091,{"$n":"6000000000000000"}],[1793146055,{"$n":"2000000000000000000"}],[1793157299,{"$n":"2000000000000000000"}],[1793215583,{"$n":"9200000000000000"}],[1793266487,{"$n":"10000000000000000"}],[1793296979,{"$n":"1010000000000000000"}]]}},{"chain":8453,"bal":{"$n":"8022979124433744691"},"dep":{"$n":"183463974953451798938226"},"wd":{"$n":"183455951974327365193535"},"nd":67457,"nw":67421,"moves":134893,"lastAt":1793399457,"series":{"ins":[[1793399151,{"$n":"3000000000000000000"}],[1793399179,{"$n":"3000000000000000000"}],[1793399207,{"$n":"3000000000000000000"}],[1793399235,{"$n":"3000000000000000000"}],[1793399263,{"$n":"3000000000000000000"}],[1793399289,{"$n":"3000000000000000000"}],[1793399317,{"$n":"3000000000000000000"}],[1793399343,{"$n":"3000000000000000000"}],[1793399371,{"$n":"3000000000000000000"}],[1793399401,{"$n":"3000000000000000000"}],[1793399429,{"$n":"3000000000000000000"}],[1793399457,{"$n":"3000000000000000000"}]]}},{"chain":4663,"bal":{"$n":"90212911860991913"},"dep":{"$n":"2171314941371662106311"},"wd":{"$n":"2171224728459801114398"},"nd":1017,"nw":1013,"moves":2038,"lastAt":1793099934,"series":{"ins":[[1792021398,{"$n":"4250000000000000000"}],[1792053596,{"$n":"1900000000000000000"}],[1792053682,{"$n":"1900000000000000000"}],[1792053766,{"$n":"1900000000000000000"}],[1792053851,{"$n":"1900000000000000000"}],[1792053936,{"$n":"1900000000000000000"}],[1792054022,{"$n":"1900000000000000000"}],[1792054106,{"$n":"1900000000000000000"}],[1792164016,{"$n":"2190000000000000000"}],[1792513011,{"$n":"1000000000000000"}],[1792587579,{"$n":"70000000000000000"}],[1793099934,{"$n":"50000000000000000"}]]}}],"eth":{"inWei":{"$n":"6784365396930000000000"},"held":{"$n":"15662440230000000000"},"outWei":{"$n":"6786467994330000000000"},"deposits":2842,"lastAt":1793397455,"wallets":90,"unread":0,"series":{"ins":[[1793393267,{"$n":"1550000000000000000"}],[1793393723,{"$n":"1550000000000000000"}],[1793393999,{"$n":"1550000000000000000"}],[1793394527,{"$n":"1550000000000000000"}],[1793394791,{"$n":"1550000000000000000"}],[1793395175,{"$n":"1550000000000000000"}],[1793395547,{"$n":"1550000000000000000"}],[1793395991,{"$n":"1550000000000000000"}],[1793396291,{"$n":"1550000000000000000"}],[1793396927,{"$n":"1550000000000000000"}],[1793397191,{"$n":"1550000000000000000"}],[1793397455,{"$n":"1550000000000000000"}]]}},"pts":{"participants":500,"full":true,"points":301626498.1157003,"allocated":{"$n":"42938493307374236711561"},"claimed":{"$n":"37078140772798095366279"}},"link":{"tip":973824,"btcTip":973889,"attestedHeight":973800,"anchorHeight":964163,"attests":1146,"lastAttest":{"hash":"0xedaf2f215944bed53f3d6cec18e72d770980ca26d5a1de3592d7ac9034f6123b","timeStamp":1793391011},"settles":8125,"notes":5017,"spent":5174,"crossOuts":11,"consumed":2,"status":{"network":"mainnet","attestedHeight":973800,"tipHeight":973800,"lagBlocks":0,"confirmations":24,"foldedCrossoutCount":9,"bridgeBurns":550,"bridgeMinted":530,"consumedCount":2,"liveNotes":3768,"burnDeposits":119,"burnsAwaitingBundle":3,"oldestAwaitingHeight":972729,"updatedAt":"2026-10-30T22:31:00.344Z"},"times":{"settles":[1793395667,1793395787,1793396063,1793396279,1793396387,1793396531,1793397011,1793397143,1793397275,1793397431,1793397587,1793397743],"attests":[1793343539,1793343851,1793348939,1793349287,1793349683,1793350043,1793366627,1793367383,1793368103,1793389343,1793390387,1793391011]}},"block":26308574,"partial":false,"stale":[],"staleAt":null};

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [width, height, a phone] around each breakpoint of the rules (640, 380, 330), and a wide screen
const WIDTHS = [[1440, 900, false], [820, 1100, false], [641, 900, false], [640, 900, true], [412, 915, true], [390, 844, true], [375, 667, true], [360, 800, true], [340, 700, true], [320, 640, true]];
const browser = await chromium.launch();
try {
  for (const [w, h, phone] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' });
    await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), (r) => r.abort());
    await ctx.route(/^https:\/\/api\.tacit\.finance\/stats/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ...STATS, at: Date.now() }) }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => { window.__held = 0; new MutationObserver(() => { const e = document.querySelector('#hx'); if (e && !window.__held) window.__held = Math.round(e.getBoundingClientRect().height); }).observe(document, { childList: true, subtree: true }); });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'commit' });
    await page.waitForSelector('#hx-swap #amt', { timeout: 60000 });
    await sleep(1500);
    const m = await page.evaluate(() => ({ held: window.__held, settled: Math.round(document.querySelector('#hx').getBoundingClientRect().height) }));
    ok(m.held > 0 && Math.abs(m.settled - m.held) <= 2, `${w} px${phone ? ' (phone)' : ''}: the tile holds ${m.held} px from the first paint and settles at ${m.settled}`);
    ok(!errors.length, `${w} px: no page errors${errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''}`);
    await ctx.close();
  }
} finally { await browser.close(); server.close(); }
console.log(`\n${fails ? `${fails} FAILED, ${n} ok` : `${n} front-tile-height checks passed`}`);
process.exit(fails ? 1 : 0);
