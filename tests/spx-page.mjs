#!/usr/bin/env node
// The SPX6900 community page, /spx/ (dapp/spx/index.html, made from the front page by `npm run build`, with its parts in dapp/spx/): what is in the file, then the
// built page in a browser with no wallet, its tile reading the pool over the public RPCs.
//   file: made for /spx/ (data-page, title, address, share card), the front page's own CSP and script, one h1, the four moves' links on $SPX's address, every
//   file the page names exists, outside links open without the opener, the contract address is shown whole and is the token the swap card lists as SPX;
//   browser: the tile opens on Shield SPX; Send, Withdraw and Bridge each open it on $SPX (a visitor who holds none yet, with no key); the tabs (Swap shut, Bridge for More),
//   the picker (ETH and SPX only), ETH priced as buy-and-shield, Bridge on SPX alone, Earn with the SPX pool shut; the page's fonts load; nothing
//   scrolls sideways at 1280, 820 and 390; no script error and no CSP violation; the front page is still the front page (ETH first, none of this page's parts).
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/spx-page.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SPX = '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c';
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const read = (p) => readFileSync(join(DAPP, p), 'utf8');

// ── the file ──
const page = read('spx/index.html'), front = read('index.html');
ok(/<html lang="en" data-page="spx">/.test(page) && /<html lang="en">/.test(front), 'the page is marked data-page="spx" and the front page is not');
{
  // the zap's transaction finishes the proof job it spends (else its Activity item never closes and offers to send the spent proof again),
  // and the hand-off says the page sends it
  const zap = front.slice(front.indexOf('async function xtZapSend('), front.indexOf('async function xtStartCore('));
  ok(/finishes: \[nest, proven\.jobId && 'job:' \+ proven\.jobId\]\.filter\(Boolean\)/.test(zap) && /nest, finishes/.test(zap), 'the zap transaction is nested in its op and finishes the proof job, so Activity closes when it lands');
  ok((front.match(/, mine: true\b/g) || []).length === 2 && /run\.to\.mine \? `It is proved in about a minute, then sent from your account\./.test(front), 'both zap runs say the page sends it, not "you can close this"');
  // a farm zap's item is done when its transaction lands, but the share is not in the farm for minutes more: the tile line and the Activity row say so until it is
  ok(/mid: farm \? `added, \$\{FARMING\.charAt\(0\)\.toLowerCase\(\)\}\$\{FARMING\.slice\(1\)\}` : undefined/.test(front) && front.includes("const FARMING = 'Putting it in the farm…';") && (front.match(/\$\{it\.mid \|\| 'done\.'\}/g) || []).length === 2 && /closing: to\.done \|\| undefined, mid: to\.mid \|\| undefined/.test(front), 'a farm zap’s line says “added, putting it in the farm…”, not “done”, when its transaction lands');
  ok(/farmNote\(run, FARMING\);/.test(front) && /farmNote\(run, inFarm\);\s+farmSay\(run, st, html`<span class="ok">✓ \$\{inFarm\}<\/span>`\);/.test(front) && /Added, but not in the farm yet: \$\{errText\(e\)\} Farm it from Your Tacit\./.test(front), 'and then that it is in the farm, or that it is not yet and why (Activity row and tile)');
  ok(/const PROTECT_RPC = 'https:\/\/rpc\.flashbots\.net\/fast\?hint=hash';/.test(front), 'a protected send goes to Flashbots Protect in fast mode (every builder), not the default that left a zap unmined for minutes');
}
ok(/<title>tacit SPX<\/title>/.test(page) && /<link rel="canonical" href="https:\/\/tacit\.finance\/spx\/">/.test(page), 'it is called tacit SPX, at /spx/');
ok(/<meta property="og:image" content="https:\/\/tacit\.finance\/spx\/card\.jpg">/.test(page) && existsSync(join(DAPP, 'spx/card.jpg')), 'its share card is its own, and the file is there');
const cspOf = (t) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(t)?.[1];
ok(!!cspOf(page) && cspOf(page) === cspOf(front), 'its CSP, and so the pinned hash of the one inline script, is the front page’s');
const scriptOf = (t) => /<script type="module">([\s\S]*?)<\/script>/.exec(t)?.[1];
ok(!!scriptOf(page) && scriptOf(page) === scriptOf(front), 'and the inline script is the front page’s, byte for byte');
ok((page.match(/<h1\b/g) || []).length === (front.match(/<h1\b/g) || []).length && /<h1 id="hero-h"><img[^>]*alt="SPX6900"/.test(page) && !page.includes('Private DeFi<span class="sr">'), 'its hero h1 is the SPX6900 wordmark, in the place of the front page’s title');
const ops = [...page.matchAll(/<li><button type="button" data-hx="([^"]+)"><b>(\d\d)<\/b><span>([A-Z]+)<\/span>/g)].map((m) => [m[3], m[1]]);
ok(JSON.stringify(ops) === JSON.stringify([['SHIELD', `shield:${SPX}:defi`], ['SEND', `send:xp${SPX}`], ['WITHDRAW', `shield:${SPX}:wallet`], ['BRIDGE', `bridge:xp${SPX}`]]), 'Shield, Send, Withdraw and Bridge are the tile’s links on $SPX’s address, in that order');
const parts = read('spx/hero.html') + read('spx/below.html'), AEON = '0xc374a204334d4edd4c6a62f0867c752d65e9579c';
const addrs = new Set((parts.match(/0x[0-9a-fA-F]{40}/g) || []).map((a) => a.toLowerCase()));
ok([...addrs].sort().join() === [AEON, SPX].sort().join(), 'the page’s own parts name two addresses, $SPX and the Project Aeon collection, and no other');
const uni = read('swap/uni-tokens.js');
ok(new RegExp(`\\{"a":"${SPX}","s":"SPX"`).test(uni), 'the address is the token the swap card lists as SPX');
ok(page.includes(`<code>${SPX}</code>`) && page.includes(`https://etherscan.io/token/${SPX}`), 'the contract address is shown whole, and links to the token on Etherscan');
const out = [...parts.matchAll(/<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>/g)];
ok(out.length >= 10 && out.every((m) => /target="_blank"/.test(m[0]) && /rel="noopener"/.test(m[0])), `the ${out.length} outside links in the page’s own parts open in a new tab without the opener`);
const site = [...new Set([...page.matchAll(/(?:src|href)="(\/spx\/[^"?]+|\/fonts\/[^"?]+)(?:\?[^"]*)?"/g)].map((m) => m[1]))];
ok(site.length >= 10 && site.every((f) => existsSync(join(DAPP, f))), `every file the page names under /spx/ and /fonts/ is there (${site.length})`);
const css = read('spx/spx.css');
const cssFiles = [...css.matchAll(/url\('(\/[^')?]+)'\)/g)].map((m) => m[1]);
ok(cssFiles.length >= 4 && cssFiles.every((f) => existsSync(join(DAPP, f))), `and every file its stylesheet names (${cssFiles.length})`);
ok(new RegExp(`<link rel="stylesheet" href="/spx/spx\\.css\\?cb=[0-9a-f]{8}">`).test(page), 'the stylesheet is linked with its cache token');
const preludes = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((x) => x && !x.startsWith('@') && !/^(?:\d+%|from|to)$/.test(x));
const splitTop = (x) => { const o = []; let d = 0, c = ''; for (const ch of x) { if (ch === '(' || ch === '[') d++; if (ch === ')' || ch === ']') d--; if (ch === ',' && !d) { o.push(c); c = ''; } else c += ch; } return [...o, c]; };
ok(preludes.length > 80 && preludes.every((x) => splitTop(x).every((sel) => sel.trim().startsWith('html[data-page="spx"]'))), `every rule of its stylesheet starts at html[data-page="spx"], so none reaches another page (${preludes.length} rules)`);
ok(!/ on[a-z]+=|javascript:/.test(parts), 'its parts carry no inline handler and no javascript: link');

// ── the page ──
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.webp': 'image/webp', '.wasm': 'application/wasm' };
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
const b = await chromium.launch();
// the api answers a page from tacit.finance only, so a page served from here is refused its CORS check: that is this test's origin, not the page
const NOISE = /CORS policy|ERR_FAILED|Failed to load resource/;
async function open(path, width = 1280) {
  const ctx = await b.newContext({ viewport: { width, height: 900 } }), p = await ctx.newPage(), bad = [];
  p.on('pageerror', (e) => bad.push('script error: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) bad.push('console: ' + m.text().slice(0, 160)); if (/Content Security Policy/.test(m.text())) bad.push('CSP: ' + m.text().slice(0, 160)); });
  await p.goto(BASE + path, { waitUntil: 'load' });
  await p.waitForSelector('#hx .go', { timeout: 40000 }).catch(() => {});
  return { ctx, p, bad };
}
const tile = (p) => p.evaluate(() => (document.querySelector('#hx')?.innerText || '').replace(/\s+/g, ' '));
const waitFor = async (p, re, ms = 25000) => { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = await tile(p); if (re.test(t)) return t; await p.waitForTimeout(400); } return t; };

{
  // the tile's first paint is already on SPX with its logo: no default ETH / tETH pair, and no letter mark waiting for the token list
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }), p = await ctx.newPage();
  await p.addInitScript(() => {
    window.__seen = [];
    const snap = () => {
      const h = document.querySelector('#hx');
      if (!h || !h.querySelector('.go')) return;
      const t = (h.innerText || '').replace(/\s+/g, ' '), k = `${/SPX/.test(t)}|${/\bt?ETH\b/.test(t)}|${h.querySelectorAll('.tk.letter').length}`;
      if (window.__seen.at(-1) !== k) window.__seen.push(k);
    };
    new MutationObserver(snap).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await p.goto(BASE + '/spx/', { waitUntil: 'load' });
  await waitFor(p, /Shield SPX/i);
  await p.waitForTimeout(5000);
  const seen = await p.evaluate(() => window.__seen), logos = await p.evaluate(() => document.querySelectorAll('#hx img.tk').length);
  ok(seen.length > 0 && seen.every((k) => k === 'true|false|0') && logos >= 2, `the tile never shows the default pair or a letter mark for SPX: its first paint is SPX with its logo (${seen.join(' > ')}, ${logos} logos)`);
  await ctx.close();
}
// a farm zap's Activity row reads the line under it from the farm-bond step's own status, so a page that closed before the bond landed does not leave "Putting it in the farm…" under a share that is in
for (const [bond, want, not, said] of [['settled', /In the farm\./, /Putting it in the farm/, 'once the bond has landed: In the farm.'], ['proving', /Putting it in the farm…/, /In the farm\./, 'while the bond is still going: Putting it in the farm…'], ['failed', /Not in the farm yet: farm it from Your Tacit\./, /Putting it in the farm/, 'if the bond failed: not in the farm yet, farm it from Your Tacit']]) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }), p = await ctx.newPage(), t0 = Date.now() - 300e3;
  await p.addInitScript(([bond, t0]) => {
    const h = (c) => '0x' + c.repeat(64), at = { at: t0, up: t0 + 50e3, end: t0 + 50e3 };
    const items = [
      { id: 'op:t1', kind: 'op', label: 'Add 0.0002 ETH to tETH / SPX', status: 'settled', mid: 'added, putting it in the farm…', note: 'Putting it in the farm…', ...at,
        steps: [{ id: `job:${h('a')}`, main: true, step: null, doing: null }, { id: `tx:1:${h('1')}`, main: false, step: 'Pool', doing: 'Adding' }, { id: `job:${h('b')}`, main: false, step: 'Farm your tETH / SPX share', doing: 'Farming' }] },
      { id: `job:${h('a')}`, kind: 'job', type: 'wrap', status: 'settled', in: 'op:t1', proveOnly: true, hash: h('1'), ...at },
      { id: `tx:1:${h('1')}`, kind: 'tx', status: 'confirmed', in: 'op:t1', hash: h('1'), chain: 1, label: 'Add 0.0002 ETH to tETH / SPX', ...at },
      { id: `job:${h('b')}`, kind: 'job', type: 'farmbond', status: bond, in: 'op:t1', ...(bond === 'proving' ? { at: t0 + 50e3, up: t0 + 50e3 } : { at: t0 + 50e3, up: t0 + 100e3, end: t0 + 100e3 }), ...(bond === 'failed' ? { err: 'refused' } : {}) },
    ];
    try { localStorage.setItem('tacit-lite-activity-v1', JSON.stringify({ items })); } catch { }
  }, [bond, t0]);
  // the page asks the relay about a step that has not ended: it answers with that step's status (else the made-up job reads as one the relay lost)
  await p.route('**/confidential/status**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jobId: '0x' + 'b'.repeat(64), type: 'farmbond', status: bond, ...(bond === 'failed' ? { error: 'refused' } : {}) }) }));
  await p.goto(BASE + '/spx/', { waitUntil: 'load' });
  await p.waitForSelector('#hx .go', { timeout: 40000 }).catch(() => {});
  await p.waitForSelector('#act:not([hidden])', { timeout: 15000 }).catch(() => {});
  await p.evaluate(() => document.querySelector('#act')?.click());
  await p.waitForTimeout(1200);
  const t = await p.evaluate(() => (document.querySelector('#act-body')?.innerText || '').replace(/\s+/g, ' '));
  ok(/Add 0\.0002 ETH to tETH \/ SPX/.test(t) && want.test(t) && !not.test(t), `a farm zap's Activity row says ${said}`);
  await ctx.close();
}
{
  const { ctx, p, bad } = await open('/spx/');
  ok(/SHIELD SPX/i.test(await waitFor(p, /Shield SPX/i)), 'the tile opens on Shield SPX, from the wallet into the DeFi pool');
  ok(await p.evaluate(() => location.pathname === '/spx/'), 'the address bar stays on /spx/ (the front page’s routing script turns any other path into /)');
  ok(/From wallet/.test(await tile(p)) && /DeFi pool/.test(await tile(p)), 'paid from the wallet, into the DeFi pool');
  ok(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('#hx .hx-where .w')].map((e) => e.textContent.trim()))) === JSON.stringify(['From wallet', 'Back from Bitcoin']), 'Shield’s two ways in read From wallet and Back from Bitcoin (the second is the bridge’s way back: SPX held on Bitcoin, burned there, minted privately here)');
  for (const [i, name, re] of [[2, 'Send', /Send privately/i], [3, 'Withdraw', /Withdraw SPX/i], [4, 'Bridge', /Bridge SPX to Bitcoin/i]]) {
    await p.click(`#spx-ops li:nth-child(${i}) button`);
    const t = await waitFor(p, re);
    ok(re.test(t) && /SPX/.test(t), `${name} opens the tile on $SPX with no key and none held (${re.source})`);
  }
  await p.click('#spx-ops li:nth-child(1) button');
  ok(/Shield SPX/i.test(await waitFor(p, /Shield SPX/i)), 'and Shield brings it back');
  // the tabs: Swap is shut until a pool trades SPX, the front page's More is Bridge
  // (a tETH / SPX pool in the Confidential AMM opens the Swap tab, so which of the two it is follows the chain: the checks below follow it too)
  await p.waitForFunction(() => !document.querySelector('[data-hxm="swap"]')?.hasAttribute('data-off'), null, { timeout: 15000 }).catch(() => {});
  const tabs = await p.evaluate(() => [...document.querySelectorAll('#hx .hx-h button')].map((b) => [b.innerText.trim().toUpperCase(), b.hasAttribute('data-off')]));
  const live = !tabs[1][1];
  ok(JSON.stringify(tabs.map((x) => x[0])) === JSON.stringify(['SHIELD', 'SWAP', 'SEND', 'EARN', 'BRIDGE']) && tabs.filter((x, i) => i !== 1).every((x) => !x[1]), `the tabs are Shield, Swap, Send, Earn and Bridge (the front page's More), and only Swap can be off (${tabs.map((x) => x[0] + (x[1] ? ' off' : '')).join(', ')})`);
  if (!live) {
    await p.locator('#hx-tab-swap').dispatchEvent('click'); await p.waitForTimeout(600);
    ok(/Shield SPX/i.test(await tile(p)) && !/USDC/.test(await tile(p)), 'no pool trades SPX yet: a press on the shut Swap tab changes nothing');
  } else {
    await p.click('#hx-tab-swap');
    const sw = await waitFor(p, /From\s*DeFi pool\s*tETH/, 20000);
    ok(/From\s*DeFi pool\s*tETH/.test(sw) && /To\s*DeFi pool[\s\S]*SPX/.test(sw) && !/USDC/.test(sw), `a pool trades SPX: Swap opens as private tETH to SPX (${sw.slice(sw.indexOf('From'), sw.indexOf('From') + 70)})`);
    await p.click('#spx-ops li:nth-child(1) button'); await waitFor(p, /Shield SPX/i);
  }
  // the picker lists ETH and SPX and nothing else, and has no search
  await p.click('#pay-coin'); await p.waitForSelector('#pk .pk-r', { timeout: 10000 });
  const picks = await p.evaluate(() => [...document.querySelectorAll('#pk .pk-r')].filter((r) => !r.hidden).map((r) => r.innerText.replace(/\s+/g, ' ').trim().split(' ')[0]));
  ok(JSON.stringify(picks) === JSON.stringify(['ETH', 'SPX']) && !(await p.evaluate(() => !!document.querySelector('#pk-q'))), `the token picker lists ETH and SPX, with no search (${picks.join(', ')})`);
  // ETH: bought on the open market and shielded, one flow, priced through zQuoter
  await p.locator('#pk .pk-r', { hasText: /^ETH/ }).first().click();
  await p.fill('#amt', '0.01');
  const z = await waitFor(p, /swap, then shield and prove it/, 40000);
  ok(/swap, then shield and prove it/.test(z) && /private SPX/.test(z) && /To\s*DeFi pool\s*[\d.,]+\s*SPX/.test(z) && !/tETH/.test(z), `ETH is bought for SPX and shielded in one go: the To side is SPX, the route says so (${z.slice(z.indexOf('Price'), z.indexOf('Price') + 110)})`);
  ok(/Connect wallet/i.test(await p.evaluate(() => document.querySelector('#hx #go')?.textContent || '')), 'and with no wallet its button asks to connect one');
  await p.click('#spx-ops li:nth-child(1) button'); await waitFor(p, /Shield SPX/i);
  // Bridge: only SPX, to Bitcoin
  await p.click('#hx-tab-more');
  const br = await waitFor(p, /Bridge SPX to Bitcoin/i, 30000);
  ok(/Bridge SPX to Bitcoin/i.test(br) && /SPX, private/.test(br) && /SPX, on Bitcoin/.test(br) && !/\b(USDT|tETH|cBTC|cUSD|TAC)\b/.test(br.replace(/Tacit/g, '')) && !/Borrow/.test(br), 'Bridge opens on private SPX to Bitcoin, lists only SPX (wallet, private, on Bitcoin), and has no Borrow');
  // Send: tETH, private SPX, and SPX on Bitcoin (the note the bridge brought there, sent by the bound transfer once it is at the key's Bitcoin address)
  await p.click('#spx-ops li:nth-child(2) button');
  await p.waitForFunction(() => [...(document.querySelector('#hx-sa')?.options || [])].some((o) => /^xb0x/.test(o.value)), null, { timeout: 30000 }).catch(() => {});
  const sendKeys = await p.evaluate(() => [...(document.querySelector('#hx-sa')?.options || [])].map((o) => o.value.replace(/0x[0-9a-f]{40}/, '<spx>')));
  ok(JSON.stringify(sendKeys) === JSON.stringify(['eth', 'xp<spx>', 'xb<spx>']), `Send lists tETH, private SPX and SPX on Bitcoin and nothing else (${sendKeys.join(', ')})`);
  await p.evaluate((k) => { const el = document.querySelector('#hx-sa'); el.value = k; el.dispatchEvent(new Event('change', { bubbles: true })); }, `xb${SPX}`);
  const bs = await waitFor(p, /SPX on Bitcoin, to any tacit1 address or name/, 15000);
  ok(/SPX on Bitcoin, to any tacit1 address or name/.test(bs) && /Sign in to send/i.test(bs) && !/Sats to any Bitcoin/.test(bs) && /the address it goes to, not the amount/.test(bs), `SPX on Bitcoin says what it is, asks for a key, and says what the chain sees (${bs.slice(bs.indexOf('SPX on Bitcoin'), bs.indexOf('SPX on Bitcoin') + 70)})`);
  ok(await p.evaluate(() => document.querySelector('#hx-rcpt')?.placeholder === 'tacit1… or name.wei'), 'its recipient is a tacit1 address or a name (no Bitcoin address takes it)');
  await p.fill('#hx-rcpt', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
  ok(/goes to a tacit1 address or a name/.test(await waitFor(p, /goes to a tacit1 address or a name/, 8000)), 'a Bitcoin address is refused with the reason');
  await p.click('#spx-ops li:nth-child(1) button'); await waitFor(p, /Shield SPX/i);
  // Swap (a pool trades SPX): private, between tETH, SPX and TAC, and TAC is only ever the coin received
  if (live) {
    await p.click('#hx-tab-swap'); await waitFor(p, /From\s*DeFi pool\s*tETH/, 20000);
    const pick = async (sel) => { await p.click(sel); await p.waitForSelector('#pk .pk-r', { state: 'attached', timeout: 10000 }); const r = await p.evaluate(() => [...document.querySelectorAll('#pk .pk-r')].filter((x) => !x.hidden).map((x) => x.innerText.replace(/\s+/g, ' ').trim().split(' ')[0])); await p.keyboard.press('Escape'); await p.waitForTimeout(400); return r; };
    const payList = await pick('#pay-coin'), getList = await pick('#get-coin');
    ok(JSON.stringify(payList.sort()) === JSON.stringify(['SPX', 'tETH']) && JSON.stringify(getList.sort()) === JSON.stringify(['SPX', 'TAC', 'tETH']), `Swap pays with tETH or SPX and can receive TAC too, never pay with it (pay ${payList.join(', ')}; get ${getList.join(', ')})`);
    await p.click('#spx-ops li:nth-child(1) button'); await waitFor(p, /Shield SPX/i);
  }
  // Farm: the hero's fifth move opens Earn, where the two SPX farms lead, each source farms the pools that hold its coin, ETH zaps into tETH / SPX and its share goes into the farm
  ok(/data-hx="earn:ether"><b>05<\/b><span>FARM<\/span>/.test(page), 'the hero has a fifth move, Farm, that opens Earn');
  await p.click('#spx-ops li:nth-child(5) button');
  const e = await waitFor(p, /Tacit privacy protocol/, 20000);
  ok(/Tacit privacy protocol/.test(e), 'Earn says it supports the Tacit privacy protocol');
  const srcs = await p.evaluate(() => [...(document.querySelector('#hx-from')?.options || [])].map((o) => o.value.replace(/0x[0-9a-f]{40}/, '<spx>')));
  ok(JSON.stringify(srcs) === JSON.stringify(['ether', 'wtac', 'eth', 'tac', 'xp<spx>']), `it farms from ETH, TAC, tETH and SPX (${srcs.join(', ')})`);
  const rowsOf = async (has) => { await p.waitForFunction((k) => [...document.querySelectorAll('#hx [data-hxr]')].some((b) => b.dataset.hxr.startsWith(k)), has, { timeout: 40000 }).catch(() => {}); return p.evaluate(() => [...document.querySelectorAll('#hx [data-hxr]')].map((b) => [b.dataset.hxr, b.disabled, b.innerText.replace(/\s+/g, ' ').trim()])); };
  const source = async (v) => { await p.evaluate((val) => { const el = document.querySelector('#hx-from'); el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }, v); await p.waitForTimeout(2500); };
  let rows = await rowsOf('xa:');
  const keys = (rs) => rs.map((x) => x[0].replace(/0x[0-9a-f]{40}/, '<spx>'));
  ok(keys(rows).indexOf('xa:<spx>') >= 0 && keys(rows).indexOf('xa:<spx>') < keys(rows).indexOf('0') && /tETH \/ SPX/.test(rows.find((x) => x[0].startsWith('xa:'))[2]), `ETH farms tETH / SPX first, then the launch pools (${keys(rows).join(', ')})`);
  const zt = await waitFor(p, /Zap into the farm/i, 20000);
  ok(/Zap into the farm/i.test(zt) && /in the farm/.test(zt), 'its button is Zap into the farm, and the receipt says the share goes into the farm');
  await source('tac'); rows = await rowsOf('1000');
  ok(JSON.stringify(keys(rows)) === JSON.stringify(['1000', '0']) && /SPX \/ TAC/.test(rows[0][2]), `private TAC farms SPX / TAC and tETH / TAC (${keys(rows).join(', ')})`);
  await source(`xp${SPX}`); rows = await rowsOf('1001');
  ok(JSON.stringify(keys(rows)) === JSON.stringify(['1000', '1001']), `private SPX farms the two SPX farms and no other (${keys(rows).join(', ')})`);
  await source('eth'); rows = await rowsOf('1001');
  ok(keys(rows)[0] === '1001' && keys(rows).includes('0'), `private tETH farms tETH / SPX first, then the launch pools (${keys(rows).join(', ')})`);
  await source('ether');
  await p.click('text=LP only');
  rows = await rowsOf('xa:');
  const lpRows = rows.filter((x) => /^x[sa]:/.test(x[0]));
  const swapOff = await p.evaluate(() => document.querySelector('[data-hxm="swap"]')?.hasAttribute('data-off'));
  ok(lpRows.length === 1 && /tETH \/ SPX/.test(lpRows[0][2]), `LP only lists tETH / SPX as the one other token's pool (${lpRows.map((x) => x[2].slice(0, 50)).join(' | ')})`);
  ok(lpRows[0][1] === (/^xs:/.test(lpRows[0][0])) && swapOff === /^xs:/.test(lpRows[0][0]), `the SPX LP row and the Swap tab are shut together while no pool exists, and open together once one does (row ${lpRows[0][1] ? 'shut' : 'open'}, Swap ${swapOff ? 'shut' : 'open'})`);
  await p.click('#spx-ops li:nth-child(1) button'); await waitFor(p, /Shield SPX/i);
  const fonts = await p.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family); });
  ok(fonts.includes('Orbitron') && fonts.includes('Space Mono'), `its fonts are the page’s own, from /fonts/ (${[...new Set(fonts)].join(', ')})`);
  const imgs = await p.evaluate(async () => { const l = [...document.querySelectorAll('.spx-lumina img, .spx-roster img, .spx-wm')]; await Promise.all(l.map((i) => i.decode().catch(() => {}))); return l.map((i) => i.naturalWidth > 0); });
  ok(imgs.length === 8 && imgs.every(Boolean), `the wordmark, Lumina and the ${imgs.length - 2} aeons all load`);
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.hero')).display === 'grid' && document.documentElement.scrollWidth <= innerWidth), 'at 1280 the hero is the two columns and nothing scrolls sideways');
  ok(bad.length === 0, `no script error and no CSP violation${bad.length ? ': ' + bad.join(' | ') : ''}`);
  await ctx.close();
}
for (const w of [820, 390]) {
  const { ctx, p, bad } = await open('/spx/', w);
  await waitFor(p, /Shield SPX/i);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `at ${w} nothing scrolls sideways`);
  ok(await p.evaluate(() => { const l = [...document.querySelectorAll('#hx .hx-where .w')]; return l.length === 2 && l.every((e) => e.scrollWidth <= e.clientWidth + 1); }), `at ${w} the Shield way-in labels are not cut off`);
  ok(await p.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return r('#hx').top > r('.spx-ops').bottom - 1 && r('#hx').left >= 0 && r('#hx').right <= innerWidth + 1; }), `at ${w} the tile follows the four moves and fits the screen`);
  ok(bad.length === 0, `at ${w}: no script error and no CSP violation${bad.length ? ': ' + bad.join(' | ') : ''}`);
  await ctx.close();
}
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }), p = await ctx.newPage();
  await p.goto(BASE + '/spx', { waitUntil: 'commit' });
  let there = false;
  for (let i = 0; i < 50 && !there; i++) { await p.waitForTimeout(400); there = new URL(p.url()).pathname === '/spx/' && await p.evaluate(() => document.documentElement.dataset.page === 'spx').catch(() => false); }
  await p.waitForTimeout(2500);   // the routing script runs after the redirect: the address must still be /spx/ once it has
  there = there && new URL(p.url()).pathname === '/spx/';
  ok(there, 'the address without its slash (/spx) is taken to /spx/, whichever the host serves it as');
  await ctx.close();
}
{
  const { ctx, p, bad } = await open('/');
  const t = await waitFor(p, /Shield ETH/i, 15000);
  ok(/Shield ETH/i.test(t) && !/SPX/.test(t), 'the front page still opens on Shield ETH');
  ok(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('#hx .hx-where .w')].map((e) => e.textContent.trim()))) === JSON.stringify(['From wallet', 'From Bitcoin']), 'and its Shield ways in still read From wallet and From Bitcoin');
  ok(await p.evaluate(() => !document.querySelector('.spx-top, #spx-below') && !document.documentElement.dataset.page), 'and has none of this page’s parts');
  await p.click('#hx-tab-send'); await p.waitForTimeout(1500);
  ok(await p.evaluate(() => ![...(document.querySelector('#hx-sa')?.options || [])].some((o) => /^x[bp]0x/.test(o.value))), 'and its Send list has no SPX rows (they are this page’s)');
  ok(bad.length === 0, `no script error and no CSP violation on the front page${bad.length ? ': ' + bad.join(' | ') : ''}`);
  await ctx.close();
}
await b.close(); server.close();
console.log(`\n${fails ? `${fails} FAILED, ${n} ok` : `${n} spx page checks passed`}`);
process.exit(fails ? 1 : 0);
