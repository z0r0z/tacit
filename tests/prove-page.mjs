// The proving page (dapp/prove/) in a real browser under its content-security policy, with the computer's tacit-prover and the pool and
// points services stood in by routes: nothing set up (the setup line, with the address), an older prover (the setup line again), paused,
// started from the button (the POST it sends), proving with a bar and the time left, paused mid-proof, a Windows PC, and a phone.
//   PLAYWRIGHT=<path to playwright-core> node tests/prove-page.mjs        (Node 22; SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { saltAddress as poolSaltAddress } from '../worker/src/salt-pool.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const server = createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (p.endsWith('/')) p += 'index.html';
  const f = join(DAPP, p);
  if (!f.startsWith(DAPP) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://localhost:${server.address().port}`;

const ADDR = '0x66f5a1225e6ac772c461f2b4d8028bf9568f3db5';
const day = Math.floor(Date.now() / 86400000);
const OTHER = '0x' + 'ab'.repeat(20);
const blk = (height, o = {}) => ({ height, hash: '0x' + height.toString(16).padStart(64, '0'), prev: '0x' + (height - 1).toString(16).padStart(64, '0'), ethBlock: 26349000 + height, tx: '0x' + 'cd'.repeat(32), notes: 1, spent: 1, deposits: 0, ...o });
const chain = { blocks: [blk(9389), blk(9388, { notes: 2, spent: 0, deposits: 1, prover: ADDR, points: 20 }), blk(9387, { prover: OTHER, points: 20 }), blk(9386, { house: true })] };
let fails = 0;
const check = (ok, what, got = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (${got})`}`); if (!ok) fails++; };

// The salt pool's newest good finds: two from one send (one row, the better), the house's, and one from two days ago (not shown).
const SALT_ADDR = '0x00000000009f12cd34ef56ab78cd90ef12ab34cd', HOUSE = '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7';
const SALT_FINDS = () => { const at = Date.now() - 90_000; return [{ address: SALT_ADDR, bits: 44, miner: OTHER, at }, { address: SALT_ADDR, bits: 33, miner: OTHER, at },
  { address: SALT_ADDR, bits: 41, miner: HOUSE, at: Date.now() - 150_000, house: true }, { address: SALT_ADDR, bits: 32, miner: '0x' + 'ef'.repeat(20), at: Date.now() - 200_000 }, { address: SALT_ADDR, bits: 56, miner: OTHER, at: Date.now() - 2 * 86400000 }]; };
// Every banked address (GET /prover/salt/bank), the best of them a contract by now (what an eth_getCode batch to the public RPC answers).
const BANK_AT = Date.now() - 3 * 86400000, DEPLOYED = '0x00000000000a9147ffd8d41d152d730ca5f84e6c';
const SALT_BANK = () => [{ address: DEPLOYED, bits: 44, miner: OTHER, at: BANK_AT }, { address: '0x0000000000ab12cd34ef56ab78cd90ef12ab34cd', bits: 41, miner: OTHER, at: BANK_AT },
  { address: '0x0000000000cd12cd34ef56ab78cd90ef12ab34cd', bits: 40, miner: HOUSE, at: BANK_AT, house: true },
  ...[1, 2, 3, 4, 5, 6].map((i) => ({ address: '0x00000000' + i + i + '12cd34ef56ab78cd90ef12ab34cd56', bits: 38 - i, miner: OTHER, at: BANK_AT }))];
// The stand-in prover: `local` is what it answers (null: nothing listens), and each POST /mine it was sent.
// The browser's battery, stood in: on the charger unless a scenario unplugs it (window.__battery, then a chargingchange event).
const CHARGER = () => { const b = new EventTarget(); b.charging = true; window.__battery = b; navigator.getBattery = () => Promise.resolve(b); };
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// `more`: the node's other numbers and the checkpoint sit behind summaries, so the scenarios that read them open those first.
async function open(browser, local, { phone = false, idle = false, ua = null, hash = '', init = null, noBank = false, more = true, minBits = 26 } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 800 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' } : { viewport: { width: 1100, height: 900 }, ...(ua ? { userAgent: ua } : {}) });
  const page = await ctx.newPage();
  // The public Nostr relays are the outside world: a page under test must never post its stand-in jobs to them or read other people's, so
  // each is an empty relay (it ends every read at once and takes every post).
  await page.routeWebSocket(/^wss:\/\//, (ws) => ws.onMessage((m) => {
    let d; try { d = JSON.parse(String(m)); } catch { return; }
    if (d[0] === 'REQ') ws.send(JSON.stringify(['EOSE', d[1]]));
    else if (d[0] === 'EVENT') ws.send(JSON.stringify(['OK', d[1]?.id, true, '']));
  }));
  if (init) await page.addInitScript(init);
  const errors = [], posts = [], codeReads = [], deskPosts = [], shares = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // a public Nostr relay that is down (the Relay tab reads several) is the outside world, not the page
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|WebSocket connection to 'wss:\/\//.test(m.text())) errors.push(m.text()); });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await page.route('http://127.0.0.1:47815/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' } });
    if (!local.v) return route.abort('connectionrefused');
    if (path === '/health') return json(route, { ok: true, vkey: '0x00', busy: !!local.v.mine?.job });
    if (path === '/mine' && req.method() === 'GET') return local.v.mine ? json(route, local.v.mine) : json(route, { error: 'not found' }, 404);
    // the help desk job: `local.v.desk` is what GET /helpdesk answers (none: an older prover), and each POST switches it
    if (path === '/helpdesk' && req.method() === 'GET') return local.v.desk ? json(route, local.v.desk) : json(route, { error: 'not found' }, 404);
    if (path === '/helpdesk' && req.method() === 'POST') { const b = JSON.parse(req.postData() || '{}'); deskPosts.push(b); local.v.desk = { ...local.v.desk, on: b.on, api: b.api }; return json(route, local.v.desk); }
    if (path === '/mine' && req.method() === 'POST') {
      const b = JSON.parse(req.postData() || '{}');
      posts.push(b);
      local.v.mine = { ...local.v.mine, on: b.on, miner: b.miner || local.v.mine.miner };
      return json(route, local.v.mine);
    }
    return json(route, { error: 'not found' }, 404);
  });
  await page.route('https://api.tacit.finance/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/prover/pool') return json(route, { ...(idle ? {} : {}), queued: idle ? 0 : 3, leased: idle ? 0 : 2, doneToday: 41, minersToday: 2, done24h: 433, miners24h: 11, top: [{ miner: ADDR, proofs: 4 }, { miner: OTHER, proofs: 1 }], terms: { pointsPerProof: 20, proofsPerMinerDay: 30 } });
    if (u.pathname === '/prover/blocks') return json(route, { head: { height: chain.blocks[0].height, hash: chain.blocks[0].hash, ethHead: chain.blocks[0].ethBlock + 25 }, blocks: chain.blocks, cross: [{ digest: '0x' + '89'.repeat(32), bitcoin: 974721, ethereum: { digest: '0x' + '54'.repeat(32), slot: 15592000 }, tx: '0x' + 'ab'.repeat(32), ethBlock: chain.blocks[0].ethBlock, at: Date.now(), by: { miner: OTHER } }] });
    if (u.pathname === '/prover/board') return json(route, { queued: 0, workers: [{ name: `c-${ADDR}`, community: true, programs: ['btc-state'], proved: 3, lastSeenSeconds: 4, racing: null }, { name: `c-${OTHER}`, community: true, programs: ['btc-state'], proved: 1, lastSeenSeconds: 2400, racing: 'btc-state' }, { name: 'c-0x' + 'cd'.repeat(20), community: true, programs: ['btc-state'], proved: 0, lastSeenSeconds: 90000, racing: null }, { name: 'c-0x' + 'ef'.repeat(20), community: true, programs: ['confidential'], proved: 5, lastSeenSeconds: 2 }, { name: 'tacit-a5000', programs: ['confidential', 'eth-state'], proved: 9, lastSeenSeconds: 0 }], pay: { pointsPerProof: 20, pointsByProgram: { 'btc-state': 1000 } } });
    if (u.pathname === '/prover/pool/recent') return json(route, { proofs: [{ at: Date.now() - 60_000 - (idle ? 30 * 60_000 : 0), house: true, points: 0, secs: 31 }, { at: Date.now() - 120_000 - (idle ? 30 * 60_000 : 0), miner: ADDR, points: 20, secs: 552 }] });
    if (u.pathname === '/prover/pool/credits') return json(route, { day, over: false, miners: [{ miner: ADDR, proofs: 4, points: 80 }] });
    if (u.pathname === '/pool/snapshot') return json(route, { v: 1, cid: 'bafkreia4g6iad4ec3634pd5lsfcqsmenqcc5oyn3mm2kwezybpwv6iltom', to: 26352486, checkpoint: { eth: { block: 26352486, hash: '0x' + 'e9'.repeat(32) }, tacit: { height: 9441, hash: '0xec803dcef9a1a4c0f64a919b491a226ce22e9d30be225c76a148b0a22b62eb41' }, bitcoin: { relayTip: 974739, reflection: { height: 974721 } }, ethereum: { finalizedSlot: 13450016 } } });
    // the salt pool takes the tab miner's shares: each send is kept, and answered as the pool answers (every salt counted)
    if (u.pathname === '/prover/salt/share' && route.request().method() === 'POST') { const b = JSON.parse(route.request().postData() || '{}'); shares.push(b); const n = (b.salts || []).length, total = shares.reduce((a, x) => a + x.salts.length, 0); return json(route, { ok: true, accepted: n, weight: n, rejected: [], today: { shares: total, weight: total * 4000, best: null } }); }
    if (u.pathname === '/prover/salt') return json(route, { recent: SALT_FINDS(), pointsPerDay: 1500, minBits, today: { miners: 2, shares: 30, weight: 400000 }, top: [{ miner: ADDR, shares: 20, weight: 2200 }], live: [{ miner: OTHER, at: Date.now() - 60_000 }, { miner: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', at: Date.now() - 30_000, house: true }], rate: 2_400_000, bank: [{ address: '0x0000000000ab12cd34ef56ab78cd90ef12ab34cd', bits: 41, miner: OTHER }, { address: '0x0000000000cd12cd34ef56ab78cd90ef12ab34cd', bits: 40, miner: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', house: true }] });
    if (u.pathname === '/prover/salt/bank') return noBank ? json(route, {}, 500) : json(route, { bank: SALT_BANK().map((b) => ({ ...b, salt: '0x' + '00'.repeat(32) })) });
    return json(route, {}, 404);
  });
  // the public RPC: eth_getCode of the banked addresses is batched (the first is a contract); anything else goes to the network as before
  await page.route('https://ethereum-rpc.publicnode.com/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' } });
    let b = null; try { b = JSON.parse(req.postData() || 'null'); } catch {}
    if (!Array.isArray(b) || !b.length || !b.every((x) => x.method === 'eth_getCode')) return route.fallback();
    codeReads.push(b.length);
    return json(route, b.map((x) => ({ jsonrpc: '2.0', id: x.id, result: String(x.params[0]).toLowerCase() === DEPLOYED ? '0x60806040' : '0x' })));
  });
  // the help desk's public stats: three nodes online and the review record of the page's address
  await page.route('https://tacit-helpdesk.onrender.com/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/stats') return json(route, { nodes: { online: 3, miners: [] }, swarm: { findings: { pending: 4 }, reviewers: [{ miner: ADDR.slice(0, 8) + '…' + ADDR.slice(-4), skeptic: { n: 37, right: 22 }, scout: { n: 17, found: 5 } }] } });
    return json(route, {}, 404);
  });
  await page.route('https://tacit-points.onrender.com/**', (route) => json(route, { enabled: true, endSec: Math.floor(Date.now() / 1000) + 86400 * 10, terms: { capWeiPerPoint: '10000000000000000' }, account: { creditedWei: '6000000000000000000' }, pocket: { totalWei: '7500000000000000000000', creditedWei: '291270000000000000000', remainingWei: '7208730000000000000000' } }));
  await page.goto(`${ORIGIN}/prove/${hash}`);
  if (more) await page.evaluate(() => document.querySelectorAll('#desk .more, .more.cp').forEach((d) => { d.open = true; }));
  return { page, ctx, errors, posts, codeReads, deskPosts, shares };
}
const text = (page, s) => page.locator(s).innerText();
// the page's grinding threads, once their number is what is expected (the browser reports a thread started or ended a moment after the page asks)
const threads = async (page, ok, ms = 4000) => { const t0 = Date.now(); while (!ok(page.workers().length) && Date.now() - t0 < ms) await page.waitForTimeout(50); return ok(page.workers().length); };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

const browser = await chromium.launch();
try {
  // nothing on this computer
  {
    const local = { v: null };
    const { page, ctx, errors } = await open(browser, local);
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Set up this computer');
    check(await page.locator('#setup').isVisible(), 'not set up: the setup line is shown');
    check(!(await page.locator('#setup .wsl').isVisible()), 'on a Mac, the line alone');
    check((await text(page, '#copy')) === 'Enter your address first' && (await text(page, '#gpu-copy')) === 'Add address', 'with no address the copy buttons ask for one', `${await text(page, '#copy')} | ${await text(page, '#gpu-copy')}`);
    check(!(await page.locator('#go').isVisible()), 'not set up: no start button');
    await page.fill('#addr', '0x12');
    check((await text(page, '#addr-bad')).startsWith('That is not an address') && (await page.getAttribute('#addr', 'aria-invalid')) === 'true', 'a half-typed address is told so', await text(page, '#addr-bad'));
    await page.fill('#addr', 'vitalik.eth');
    check((await text(page, '#addr-bad')) === 'Use the 0x address, not the name.', 'a name is told to be an address');
    await page.click('#copy');
    check(await page.evaluate(() => document.activeElement.id) === 'addr', 'pressing a copy button without an address moves to the field');
    await page.fill('#addr', ADDR);
    check((await text(page, '#addr-bad')) === '' && (await text(page, '#copy')) === 'Copy, then paste in Terminal' && (await text(page, '#gpu-copy')) === 'Copy', 'a good address clears it and the buttons copy', `${await text(page, '#copy')}`);
    check((await text(page, '#setup-hint')).includes('6.2 GB'), 'the setup says how big the first download is', await text(page, '#setup-hint'));
    check(await page.locator('#blocked').isHidden(), 'a prover that is just not installed is not called blocked');
    check((await text(page, '#cmd')).endsWith(ADDR), 'the setup line carries the address', await text(page, '#cmd'));
    await page.waitForFunction(() => document.querySelector('#btc-pay').textContent.includes('TAC'), null, { timeout: 8000 }).catch(() => {});
    check((await page.textContent('#btc-pay')) === '10 TAC each','the GPU card says what a Bitcoin batch pays', await page.textContent('#btc-pay'));
    check((await text(page, '#gpu-cmd')) === `curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- ${ADDR}`, 'with the GPU command for the address', await text(page, '#gpu-cmd'));
    await page.waitForFunction(() => document.querySelector('#gpu-n').textContent !== '—', null, { timeout: 8000 }).catch(() => {});
    check((await text(page, '#gpu-n')) === '3 · Tacit\'s included', 'GPUs online: one asked for work just now, one is proving a batch, and Tacit\'s own; one gone a day and a settle-only machine are not', await text(page, '#gpu-n'));
    check((await text(page, '#gpu-me')) === 'waiting for its turn · 3 batches', "the address's own GPU, from its board name", await text(page, '#gpu-me'));
    // The Bitcoin card is the coin, a short name, the pay, the command and one line of needs; the cards and Windows notes sit behind a summary.
    check((await page.locator('[data-card="gpu"] h3 use[href="#tk-btc"]').count()) === 1 && (await text(page, '#h-gpu')) === 'Prove Bitcoin', 'the Bitcoin card has the coin and a short name', await text(page, '#h-gpu'));
    check(!(await page.locator('[data-card="gpu"] .more').evaluate((d) => d.open)) && !(await page.locator('[data-card="gpu"] .more .hint').isVisible()), 'the other cards and Windows are behind a summary, closed');
    await page.locator('[data-card="gpu"] .more summary').click();
    check((await page.locator('[data-card="gpu"] .more .hint').isVisible()) && (await text(page, '[data-card="gpu"] .more .hint')).includes('WSL 2') && (await text(page, '[data-card="gpu"] .more .hint')).includes('--status'), 'and a press opens them, with the Windows note and --status');
    await page.locator('[data-card="gpu"] .more summary').click();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#copy');
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Waiting for tacit-prover…', null, { timeout: 5000 }).catch(() => {});
    check((await text(page, '#title')) === 'Waiting for tacit-prover…', 'once copied, the page waits for the prover', await text(page, '#title'));
    await page.waitForFunction(() => document.querySelector('#today').textContent.includes('4 proofs'));
    check((await text(page, '#pays')).includes('0.2 TAC a proof'), 'what a proof pays is read from the services', await text(page, '#pays'));
    check((await text(page, '#paid')) === '6 TAC · Rewards' && (await page.getAttribute('#paid a', 'href')) === '/rewards/', 'what was paid, with the way to Rewards', await text(page, '#paid'));
    await page.waitForFunction(() => document.querySelectorAll('#chain .blk:not(.next):not(.xc)').length === 4);
    check((await text(page, '#height')) === '#9,389', 'the tip is the newest block', await text(page, '#height'));
    check((await text(page, '#last')) === '5 min ago', 'the newest block\'s age is read from Ethereum\'s head', await text(page, '#last'));
    check((await page.locator('#chain .blk:not(.next):not(.xc) .t').first().innerText()) === '5 min ago', 'each block says how long ago it was');
    check((await page.locator('#chain .blk.won').count()) === 2, 'blocks a community prover proved are marked');
    check((await page.locator('#chain .blk.mine').count()) === 1, 'the address\'s own block is picked out');
    await page.waitForFunction(() => document.querySelectorAll('#chain .cube.ghost i.on').length === 2, null, { timeout: 3000 }).catch(() => {});
    check((await page.locator('#chain .cube.ghost i').count()) === 5 && (await page.locator('#chain .cube.ghost i.on').count()) === 2, 'the waiting proofs are drawn in the next block, the leased ones lit');
    check((await page.locator('#pool').count()) === 0, 'and not on a row of their own');
    check((await text(page, '#feed')).includes('+0.2 TAC') && (await text(page, '#feed')).includes('a deposit, proved in 9 min'), 'the feed says who proved what, how fast and what it won', await text(page, '#feed'));
    const mineRank = (await page.locator('#board li.me').innerText()).replace(/\s+/g, ' ');
    check(mineRank.includes('4 proofs 0.8 TAC 9 min each'), 'today\'s provers with their TAC and their speed', mineRank);
    const cols = await page.evaluate(() => [...document.querySelectorAll('#feed li:not(.empty)')].map((li) => Math.round(li.children[1].getBoundingClientRect().right)));
    check(cols.length > 1 && new Set(cols).size === 1, 'the feed\'s TAC column lines up', JSON.stringify(cols));
    check(await page.evaluate(() => [...document.querySelectorAll('.who.gpu')].every((e) => getComputedStyle(e).marginTop === '0px')), 'the Tacit GPU name sits in line (no card style on it)');
    await page.waitForFunction(() => document.querySelector('#crowd-n').textContent === '3 nodes online');
    check((await page.locator('#crowd .pod').count()) === 3, 'the crowd: everyone who proved lately and every node grinding salts, Tacit GPU among them');
    check(await page.locator('#crowd .pod.me').count() === 1, 'with this address picked out');
    check((await page.locator('#chain .blk.xc').count()) === 1 && (await text(page, '#chain .blk.xc')).includes('974,721') && (await page.getAttribute('#chain .blk.xc a', 'href')).includes('etherscan.io/tx/0xabab') && (await page.locator('#chain .blk.xc .who').count()) === 1, 'a cross-chain block stands among the settles, with Bitcoin\'s height, its landing and who mined it');
    await page.waitForFunction(() => !document.querySelector('#checkpoint').hidden);
    check((await text(page, '#checkpoint')).includes('#9,441') && (await text(page, '#checkpoint')).includes('Bitcoin 974,721') && (await text(page, '#checkpoint')).includes('Ethereum slot 13,450,016'), 'the day\'s checkpoint: the block, Bitcoin\'s height and where it is kept', await text(page, '#checkpoint'));
    check((await page.locator('#feed li.me').count()) === 1 && !(await text(page, '#feed')).includes('· you'), 'its own proofs in the feed are marked by the row, the name kept short');
    check((await text(page, '#n-done')) === '433' && (await text(page, '#n-provers')) === '11', 'the headline counts are the last 24 hours, not since midnight UTC', `${await text(page, '#n-done')} ${await text(page, '#n-provers')}`);
    const kinds = await page.locator('#chain .blk:not(.next):not(.xc) .k').allInnerTexts();
    check(JSON.stringify(kinds) === JSON.stringify(['Private transfer', 'Deposit', 'Private transfer', 'Private transfer']), 'each block says what it did', JSON.stringify(kinds));
    check((await text(page, '#today')) === '4 proofs · 0.8 TAC', 'the rig says what today earned', await text(page, '#today'));
    check((await text(page, '#payout')).startsWith('after the day ends, in '), 'and when it is paid', await text(page, '#payout'));
    if (Date.now() % 86400000 >= 7200000) check((await text(page, '#pace')).includes('TAC a day ('), 'and the pace at today\'s rate', await text(page, '#pace'));
    else check(await page.locator('#pace-row').isHidden(), 'no pace in the day\'s first two hours');
    check((await page.locator('#chain .blk.gpu').count()) === 1 && (await page.locator('#chain .blk.gpu').innerText()).includes('Tacit GPU'), 'a block Tacit\'s GPU proved says so');
    const feedText = await text(page, '#feed');
    check((feedText.match(/good salt, 5 zero bytes/g) || []).length === 2 && (feedText.match(/good salt, 4 zero bytes/g) || []).length === 1, 'the feed shows the good salts the nodes mined, in zero bytes', feedText);
    check(!feedText.includes('7 zero bytes') && !feedText.includes(' bits'), 'a send shows its best find once (its 33-bit one is not a second row), a day-old find is not shown, and no bits', feedText);
    check((await page.locator('#feed li').count()) === 5 && (await page.locator('#feed li.salt').count()) === 3, 'proofs and salts share the feed, newest first');
    {
      // the page is two stacks: the node over the salts, the activity over the GPU card; no card sits beside a gap, and a feed row is one line
      const r = await page.evaluate(() => { const b = (s) => { const e = document.querySelector(s).getBoundingClientRect(); return { l: Math.round(e.left), t: Math.round(e.top), b: Math.round(e.bottom), r: Math.round(e.right) }; };
        return { node: b('[data-card="node"]'), salts: b('[data-card="salts"]'), feed: b('[data-card="activity"]'), gpu: b('[data-card="gpu"]'), rows: [...document.querySelectorAll('#feed li:not(.empty)')].map((li) => Math.round(li.getBoundingClientRect().height)) }; });
      check(r.node.l === r.salts.l && r.salts.t - r.node.b === 18, 'the salts card sits right under the node card', JSON.stringify([r.node, r.salts]));
      check(r.feed.l === r.gpu.l && r.gpu.t - r.feed.b === 18 && r.feed.l > r.node.r, 'the GPU card sits right under the activity, which is beside the node', JSON.stringify([r.feed, r.gpu, r.node]));
      check(Math.max(...r.rows) < 40, 'a feed row is one line', JSON.stringify(r.rows));
    }
    const saltRows = await page.locator('#feed li.salt').allInnerTexts();
    check(saltRows.filter((x) => x.includes('≈ +9.83 TAC')).length === 1 && saltRows.filter((x) => x.includes('< 0.01 TAC')).length === 1, 'a salt shows its part of the day\'s salt pot so far: a 44-bit find 9.83 TAC, a 32-bit one under a cent', saltRows.join(' / '));
    check(saltRows.filter((x) => x.includes('TAC')).length === 2, 'and Tacit\'s own find shows none');
    check((await page.textContent('#salt-best-h')) === 'Best today · 5 leading zero bytes · ≈ +9.83 TAC' && (await page.locator('#salt-best li').count()) === 1, 'the day\'s best find has its own line', await page.textContent('#salt-best-h'));
    check((await text(page, '#pot')) === '7,208 TAC left · 291 paid', 'the prover pot: what is left and what was paid', await text(page, '#pot'));
    check((await text(page, '#typ')) === '9 min' && (await text(page, '#saltpot')) === 'up to 15 TAC, shared by work', 'what a computer can expect: the typical proof and the salt pot', `${await text(page, '#typ')} / ${await text(page, '#saltpot')}`);
    check((await page.locator('#board .spd').allInnerTexts()).includes('–'), 'a prover with no recent proof shows a dash for its speed, not a blank');
    check(await page.locator('#feed-idle').isHidden(), 'no idle line while proofs wait');
    check((await page.locator('#g-prove, [data-card="orders"]').count()) === 0, 'the paid-orders card is gone from the Prove tab');
    check((await page.locator('#tb-bitcoin svg.tk use').getAttribute('href')) === '#tk-btc' && (await page.locator('#tb-relay svg').count()) === 0, 'the Bitcoin tab carries the Bitcoin mark');
    check((await page.locator('#feed li.salt .who.gpu').count()) === 1, 'Tacit\'s GPU is named on its own find');
    const gpuRow = await page.locator('#feed li').first().innerText();
    check(gpuRow.includes('Tacit GPU') && !gpuRow.includes('TAC '), 'the feed shows Tacit\'s GPU, earning nothing', gpuRow);
    check(!(await text(page, '#board')).includes('Tacit GPU'), 'Tacit\'s GPU is never on the leaderboard');
    check((await text(page, '#me')) === '0x66f5…3db5', 'the rig shows the address beside its invader, no NFT number', await text(page, '#me'));
    check(!(await page.content()).includes('zorgz #'), 'no page text names an NFT number');
    check((await text(page, '#next-o')) === '5 pending', 'the next block says how many proofs are waiting or being proved', await text(page, '#next-o'));
    check((await page.locator('#chain .blk .badge img.inv').count()) === 3, 'each proved block wears its prover\'s invader');
    const loaded = await page.locator('img.inv').evaluateAll((xs) => xs.every((x) => x.complete && x.naturalWidth > 0));
    check(loaded, 'every invader image draws');
    await page.click('#chain .blk.mine button');
    const det = await text(page, '#detail');
    check(det.includes('Won') && det.includes('0.2 TAC') && det.includes('you') && det.includes('Deposit') && det.includes('2 new notes · 1 deposit') && det.includes('Make a private deposit'), 'a block opens with what it did, a link to do it, who proved it and what it won', det);
    // a new block lands at the front
    chain.blocks = [blk(9390, { notes: 0, spent: 2 }), ...chain.blocks];
    await page.waitForFunction(() => document.querySelector('#chain .blk:not(.next):not(.xc)')?.dataset.h === '9390', null, { timeout: 12000 });
    check(await page.locator('#chain .blk.new').count() === 1, 'a new block lands with the landing animation');
    check((await page.locator('#chain .blk').first().getAttribute('class')).includes('next'), 'the next block stays at the front');
    check((await text(page, '#height')) === '#9,390', 'the tip moves on');
    await shot(page, 'prove-none');
    // the prover appears (the line was pasted): the page sees it on its own
    const NOW = { threads: 2, background: true, pausedFor: 'not mining' };   // what a prover from v0.6.3 on adds to /mine's salt
    local.v = { mine: { miner: null, on: false, job: null, proved: 0, salt: { on: false, rate: 0, minBits: 26, ...NOW } } };
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Paused', null, { timeout: 8000 });
    check(!(await page.locator('#setup').isVisible()), 'once it answers, the setup line goes');
    local.v = { mine: { miner: null, on: false, job: null, proved: 0 } };
    await page.waitForFunction(() => document.querySelector('#salt-day').textContent.startsWith('Run the setup line again'), null, { timeout: 8000 });
    check(await page.locator('#setup').isVisible(), 'a node from before salt mining is shown the setup line, to update');
    // v0.6.0 to v0.6.2 mine salts but report no `background`: they are told to update too, with what the update brings
    local.v = { mine: { miner: null, on: false, job: null, proved: 0, salt: { on: false, rate: 0, minBits: 26 } } };
    await page.waitForFunction(() => document.querySelector('#salt-day').textContent.includes('more gently'), null, { timeout: 8000 });
    check(await page.locator('#setup').isVisible() && (await text(page, '#salt-day')).startsWith('Run the setup line again'), 'a node from before gentle mining is shown the setup line, to update', await text(page, '#salt-day'));
    await shot(page, 'prove-update-gentle');
    // and a current one is not
    local.v = { mine: { miner: null, on: false, job: null, proved: 0, salt: { on: false, rate: 0, minBits: 26, ...NOW } } };
    await page.waitForFunction(() => !document.querySelector('#salt-day').textContent.startsWith('Run the setup line again'), null, { timeout: 8000 });
    check(!(await page.locator('#setup').isVisible()), 'a current prover is not told to update');
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }
  // nothing queued: the stats say what the nodes do meanwhile
  {
    const { page, ctx } = await open(browser, { v: null }, { idle: true });
    await page.waitForFunction(() => document.querySelector('#l-lease').textContent === 'Salts a second');
    check((await text(page, '#n-wait')) === '0' && (await text(page, '#n-lease')) === '2.4 M', 'with nothing queued, nothing waits and the nodes grind salts this fast', `${await text(page, '#n-wait')} ${await text(page, '#n-lease')}`);
    await page.waitForFunction(() => document.querySelector('#next-o')?.textContent === 'mining salts');
    check(true, 'the next block says the nodes are mining salts meanwhile');
    await page.waitForFunction(() => !document.querySelector('#feed-idle').hidden);
    check((await text(page, '#feed-idle')).includes('A private deposit starts the next proof') && (await page.getAttribute('#feed-idle a', 'href')) === '/', 'nothing waiting and no proof for ten minutes: the feed says where the next one comes from');
    await ctx.close();
  }
  // a Windows PC: Ubuntu installed first, then the same line pasted in Ubuntu; the switch goes back to Mac or Linux
  {
    const { page, ctx, errors } = await open(browser, { v: null }, { ua: WINDOWS_UA });
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Set up this computer');
    check(await page.locator('#setup .wsl').isVisible(), 'Windows: installing Ubuntu comes first');
    // drawn, not only laid out: no inherited style (such as the reward pop's opacity) hides the steps
    check(await page.evaluate(() => [...document.querySelectorAll('#setup .wsl, #setup .wsl *')].every((e) => getComputedStyle(e).opacity === '1')), 'and its steps are drawn');
    check((await page.getAttribute('#setup [data-os="win"]', 'aria-pressed')) === 'true', 'and the switch says Windows');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#wsl-copy');
    check((await page.evaluate(() => navigator.clipboard.readText())) === 'wsl --install', 'the first step copies wsl --install');
    await page.fill('#addr', ADDR);
    check((await text(page, '#copy')) === 'Copy, then paste in Ubuntu', 'the line is pasted in Ubuntu', await text(page, '#copy'));
    await page.click('#copy');
    check((await page.evaluate(() => navigator.clipboard.readText())).endsWith(ADDR), 'the second copies the setup line for the address');
    check((await text(page, '#say')).startsWith('Copied. Paste it in Ubuntu'), 'and says where to paste it', await text(page, '#say'));
    const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    check(!over, 'no sideways scroll with the Windows steps');
    await shot(page, 'prove-windows');
    await page.click('#setup [data-os="unix"]');
    check(!(await page.locator('#setup .wsl').isVisible()) && (await text(page, '#copy')) === 'Copy, then paste in Terminal', 'the switch goes back to Mac or Linux');
    check(errors.length === 0, 'no page errors on Windows', errors.join(' | '));
    await ctx.close();
  }
  // an older prover: no GET /mine
  {
    const { page, ctx } = await open(browser, { v: { mine: null } });
    await page.waitForFunction(() => document.querySelector('#title').textContent.startsWith('Update'));
    check(await page.locator('#setup').isVisible(), 'an older prover is shown the setup line to update');
    await ctx.close();
  }
  // the full bank not answering: the summary's best addresses are listed, none marked
  {
    const { page, ctx, errors } = await open(browser, { v: null }, { noBank: true });
    await page.waitForFunction(() => document.querySelectorAll('#salt-bank li').length > 0, null, { timeout: 8000 });
    check((await page.locator('#salt-bank li').count()) === 2 && (await page.locator('#salt-bank li.used').count()) === 0 && (await page.textContent('#salt-bank-h')) === 'Banked for deploys · 2', 'without the full list the summary\'s best addresses show', await page.textContent('#salt-bank-h'));
    check(errors.length === 0, 'and the page has no errors', errors.join(' | '));
    await ctx.close();
  }
  // paused, then started from the button, then a proof under way, then paused mid-proof
  {
    const local = { v: { mine: { miner: ADDR, on: false, job: null, proved: 0 } } };
    const { page, ctx, errors, posts, codeReads } = await open(browser, local);
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Paused');
    check((await page.inputValue('#addr')).toLowerCase() === ADDR, 'the prover\'s own address fills the field');
    check((await text(page, '#go')) === 'Start proving', 'paused: the button starts');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Waiting for the next proof');
    check(posts.length === 1 && posts[0].on === true && posts[0].miner.toLowerCase() === ADDR, 'Start sends on with the address', JSON.stringify(posts));
    local.v.mine = { ...local.v.mine, salt: { on: true, rate: 2_400_000, minBits: 26, threads: 2, background: true, pausedFor: null } };
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Mining salts until the next proof');
    await page.waitForFunction(() => document.querySelector('#salt').textContent.includes('M/s'));
    check((await text(page, '#salt')) === '20 shares · 0.08 TAC so far · 2.4 M/s', 'between proofs the node grinds salts: its shares, its part of the day and its speed', await text(page, '#salt'));
    await page.waitForFunction(() => document.querySelector('#salt-bank li.used'), null, { timeout: 8000 });
    check((await page.textContent('#salt-bank-h')) === 'Banked for deploys · 9 · 1 deployed', 'the bank says what it is: how many are banked and how many were deployed to', await page.textContent('#salt-bank-h'));
    check((await text(page, '#salt-pay')).includes('up to 15 TAC today') && (await text(page, '#salt-bank')).includes('Tacit GPU'), 'the salt pot and the addresses banked, Tacit GPU\'s named so', await text(page, '#salt-pay'));
    check((await page.locator('#salt-bank li').count()) === 9, 'every banked address is listed, not the best few', String(await page.locator('#salt-bank li').count()));
    const dep = page.locator('#salt-bank li.used');
    check((await dep.count()) === 1 && (await dep.locator('a.dep').innerText()) === 'Deployed' && (await dep.locator('a.dep').getAttribute('href')) === `https://etherscan.io/address/${DEPLOYED}`
      && (await dep.locator('code').getAttribute('title')) === DEPLOYED && (await dep.locator('code').innerText()).startsWith('0x00000000000a9147'), 'an address with a contract on it says so, with the link to it, and shows the whole address on hover');
    check((await page.locator('#salt-bank li:not(.used) a').count()) === 0, 'the rest carry no link');
    const box = await page.locator('#salt-bank').evaluate((el) => ({ over: el.scrollHeight > el.clientHeight, y: getComputedStyle(el).overflowY, tab: el.tabIndex, more: el.classList.contains('more'), h: el.clientHeight, last: el.lastElementChild.getBoundingClientRect().top > el.getBoundingClientRect().bottom }));
    check(box.over && box.y === 'auto' && box.tab === 0 && box.more && box.last && box.h < 160, 'the list scrolls (from the keyboard too), shows the first rows with the rest below, and fades at the foot', JSON.stringify(box));
    await page.locator('#salt-bank').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForFunction(() => !document.querySelector('#salt-bank').classList.contains('more') && document.querySelector('#salt-bank').lastElementChild.getBoundingClientRect().bottom <= document.querySelector('#salt-bank').getBoundingClientRect().bottom + 1);
    check(true, 'scrolled to the end, the last address is in view and the fade is gone');
    check(codeReads.length === 1 && codeReads[0] === 9, 'the chain is asked once, in one batch, for all the banked addresses', JSON.stringify(codeReads));
    local.v.mine = { ...local.v.mine, job: { id: 'j1', secs: 120, stage: 'shrink', eta: 360 }, proved: 2 };
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Proving');
    check((await page.title()) === 'Proving · tacit prove', 'a tab left open says it is proving', await page.title());
    const st = await text(page, '#stage'), steps = await page.locator('#forge li').evaluateAll((ls) => ls.map((l) => l.className));
    check(st === 'Compressing · about 6 min left', 'proving: the stage and the time left', st);
    check(JSON.stringify(steps) === JSON.stringify(['done', 'now spin', '', '']), 'proving: the forge shows the first stage done and the second under way', JSON.stringify(steps));
    check((await text(page, '#run')) === '2', 'proofs since it started', await text(page, '#run'));
    await shot(page, 'prove-proving');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Pausing after this proof');
    check(posts[1]?.on === false, 'Pause sends off', JSON.stringify(posts));
    // the proof is taken: the reward it won pops up
    local.v.mine = { ...local.v.mine, job: null, proved: 3 };
    await page.waitForFunction(() => document.querySelector('#win').classList.contains('go'));
    check((await text(page, '#win')) === '+0.2 TAC', 'a proof taken shows what it won', await text(page, '#win'));
    check((await text(page, '#say')).includes('after the proof under way'), 'pausing mid-proof says it finishes that one', await text(page, '#say'));
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }
  // start with no address: refused in words, nothing sent
  {
    const { page, ctx, posts } = await open(browser, { v: { mine: { miner: null, on: false, job: null, proved: 0 } } });
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Paused');
    await page.click('#go');
    check(posts.length === 0 && (await text(page, '#say')).includes('Enter the address'), 'Start without an address asks for one');
    await ctx.close();
  }
  // the node's jobs as tabs, and the old community ops address sending its visitors to them
  {
    const { page, ctx, errors } = await open(browser, { v: null });
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Set up this computer');
    check(!(await page.locator('#t-relay').isVisible()) && await page.locator('#t-prove').isVisible(), 'the Prove tab opens first');
    await page.click('#tb-relay');
    check(await page.locator('#g-board').isVisible() && !(await page.locator('#t-prove').isVisible()), 'Relay shows the open board and hides Prove');
    check(new URL(page.url()).hash === '#tab=relay', 'the tab is in the address', page.url());
    await shot(page, 'prove-relay');
    await page.keyboard.press('ArrowRight');
    check(await page.locator('#g-advance').isVisible() && (await page.getAttribute('#tb-bitcoin', 'aria-selected')) === 'true', 'the arrow keys move along the tabs to Bitcoin');
    await page.waitForTimeout(1500);
    await shot(page, 'prove-bitcoin');
    await page.click('#tb-prove');
    check(new URL(page.url()).hash === '' && await page.locator('#t-prove').isVisible(), 'back on Prove the address has no tab');
    check(await page.locator('#wallet').isVisible(), 'the wallet chip is in the header');
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    for (const [from, tab, extra] of [['#need=970200&why=lock', 'bitcoin', 'need=970200&why=lock'], ['#g-board', 'relay', ''], ['', 'bitcoin', '']]) {
      await page.goto(`${ORIGIN}/weld/keeper/${from}`);
      await page.waitForURL(/\/prove\//, { timeout: 8000 });
      const h = new URLSearchParams(new URL(page.url()).hash.slice(1));
      check(h.get('tab') === tab && (!extra || `need=${h.get('need')}&why=${h.get('why')}` === extra) && await page.locator(`#t-${tab}`).isVisible(),
        `/weld/keeper/${from || ''} goes to the ${tab} tab${extra ? ', keeping what the lock needs' : ''}`, page.url());
    }
    await ctx.close();
  }
  // a browser that refuses the page the computer's prover (Chrome's local network permission) is told so; a connected wallet fills an empty field
  {
    const { page, ctx, errors } = await open(browser, { v: null }, { init: () => {
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) => (d.name === 'loopback-network' ? Promise.resolve({ state: 'denied' }) : q(d));
    } });
    await page.waitForFunction(() => !document.querySelector('#blocked').hidden, null, { timeout: 6000 }).catch(() => {});
    check(await page.locator('#blocked').isVisible() && (await text(page, '#blocked')).includes('local network access'), 'a browser that blocks the local prover says how to allow it', await text(page, '#blocked'));
    await page.evaluate((a) => dispatchEvent(new CustomEvent('tacit:prove-wallet', { detail: a })), ADDR);
    check((await page.inputValue('#addr')) === ADDR && (await text(page, '#copy')) === 'Copy, then paste in Terminal', 'a wallet connected on the page fills the empty field');
    await page.evaluate((a) => dispatchEvent(new CustomEvent('tacit:prove-wallet', { detail: a })), OTHER);
    check((await page.inputValue('#addr')) === ADDR, 'and never replaces an address already there');
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }
  // each card's own link (/prove/#<card>), and the Link on each card that copies it
  {
    const { page, ctx, errors } = await open(browser, { v: null }, { hash: '#gpu', more: false });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.waitForTimeout(300);
    // the card a link names is brought into the window as the page opens (measured before the presses below scroll the page elsewhere)
    const gpu = page.locator('[data-card="gpu"]');
    check(await page.locator('#t-prove').isVisible() && await gpu.evaluate((el) => el.classList.contains('lit')), '#gpu opens the Prove tab and marks the GPU card');
    await page.waitForTimeout(1200);
    const box = await gpu.boundingBox();
    check(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height, 'and brings it into the window', JSON.stringify(box));   // the page ends soon after it, so it cannot always reach the top
    // The node card shows three numbers and keeps the rest behind a summary; the checkpoint is a summary of its own. Both start closed.
    await page.waitForFunction(() => !document.querySelector('#typ-row').hidden && !document.querySelector('#checkpoint').hidden, null, { timeout: 8000 }).catch(() => {});
    check((await text(page, '#desk .more summary')) === 'More numbers' && !(await page.locator('#desk .more').evaluate((d) => d.open)) && !(await page.locator('#typ-row').isVisible()), 'the node keeps its other numbers behind More numbers, closed');
    await page.locator('#desk .more summary').click();
    check((await page.locator('#typ-row').isVisible()) && (await text(page, '#typ-row')).includes('Typical proof'), 'and a press shows them');
    check((await text(page, '.more.cp summary')) === 'Checkpoint' && !(await page.locator('#checkpoint').isVisible()), 'the checkpoint is a summary, closed');
    await page.locator('.more.cp summary').click();
    check((await page.locator('#checkpoint').isVisible()) && (await text(page, '#checkpoint')).startsWith('Block #'), 'and a press shows the block, Bitcoin and the snapshot');
    const cards = await page.locator('[data-card]').count(), links = await page.locator('.card-link').count();
    check(cards >= 10 && links === cards && (await page.locator('[data-share], .share-x, a[href*="x.com/intent"]').count()) === 0, 'every card has its Link and none posts to X', `${links} of ${cards}`);
    await page.evaluate(() => { history.replaceState(null, '', location.pathname); });
    await page.click('[data-card="salts"] .card-link');
    check((await page.evaluate(() => navigator.clipboard.readText())) === 'https://tacit.finance/prove/#salts', "a card's Link copies the card's address", await page.evaluate(() => navigator.clipboard.readText()));
    check(new URL(page.url()).hash === '#salts' && (await text(page, '[data-card="salts"] .card-link')) === 'Copied' && await page.locator('[data-card="salts"]').evaluate((el) => el.classList.contains('lit')), 'and puts it in the address bar, marks the card and says Copied', page.url());
    await page.waitForFunction(() => document.querySelector('[data-card="salts"] .card-link').textContent === 'Link', null, { timeout: 4000 });
    check(true, 'the Link goes back to its name');
    await page.evaluate(() => { location.hash = 'send'; });
    await page.waitForTimeout(400);
    await page.click('[data-card="send"] .card-link');
    check((await page.evaluate(() => navigator.clipboard.readText())) === 'https://tacit.finance/prove/#send', "a Relay card's Link copies its address too");
    check(await page.locator('#t-relay').isVisible() && await page.locator('[data-card="send"]').evaluate((el) => el.classList.contains('lit')), '#send opens the Relay tab at its card');
    await page.click('#tb-bitcoin');
    check(new URL(page.url()).hash === '#tab=bitcoin', 'a tab pressed after a card link puts the tab alone in the address', page.url());
    await page.click('#tb-prove');
    check(new URL(page.url()).hash === '', 'and Prove clears it', page.url());
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }
  // an API answer carrying markup: dropped before anything is drawn
  {
    const saved = chain.blocks;
    chain.blocks = [{ height: '<img id=pwn src=x>', hash: '0x1', tx: '"><b id=pwn2>', ethBlock: '<i id=pwn3>', notes: 1, spent: 0 }, blk(7, { prover: '<b id=pwn4>x</b>', points: '<b id=pwn5>' })];
    const { page, ctx, errors } = await open(browser, { v: null });
    await page.waitForFunction(() => document.querySelectorAll('#chain .blk:not(.next):not(.xc)').length === 1);
    const pwned = await page.evaluate(() => ['pwn', 'pwn2', 'pwn3', 'pwn4', 'pwn5'].filter((i) => document.getElementById(i)));
    check(pwned.length === 0 && (await page.locator('#chain .blk:not(.next):not(.xc)').first().getAttribute('data-h')) === '7', 'markup in an API answer never reaches the page', JSON.stringify(pwned));
    check(errors.length === 0, 'and nothing breaks', errors.join(' | '));
    chain.blocks = saved;
    await ctx.close();
  }
  // a phone
  {
    const { page, ctx } = await open(browser, { v: null }, { phone: true });
    check(await page.locator('#phone').isVisible() && !(await page.locator('#desk').isVisible()), 'a phone is told to open it on a computer');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#send-page');
    await page.waitForFunction(() => document.querySelector('#send-page').textContent === 'Link copied', null, { timeout: 3000 }).catch(() => {});
    check((await text(page, '#send-page')) === 'Link copied' && (await page.evaluate(() => navigator.clipboard.readText())) === 'https://tacit.finance/prove/', 'and can send the page on (the link copied where there is no share sheet)', await text(page, '#send-page'));
    const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    check(!over, 'no sideways scroll on a phone');
    check(!(await page.locator('#review').isVisible()), 'a phone shows no code-review card (it runs no prover)');
    check(!(await page.locator('#tab-go').isVisible()), 'and is not asked to grind salts');
    await shot(page, 'prove-phone');
    await ctx.close();
  }
  // salt mining in the tab, with nothing installed: started from the card, real threads grind, their shares go to the pool for the address, and it stops
  {
    const { page, ctx, errors, shares } = await open(browser, { v: null }, { more: false, minBits: 16, init: CHARGER });
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Set up this computer');
    check((await text(page, '#tab-go')) === 'Enter your address first' && await page.locator('#tab-go').isVisible(), 'tab mining, no address: the button asks for one', await text(page, '#tab-go'));
    await page.click('#tab-go');
    check(await page.evaluate(() => document.activeElement?.id === 'addr') && page.workers().length === 0, 'and a press takes the reader to the field, starting nothing');
    await page.fill('#addr', ADDR);
    await page.waitForFunction(() => document.querySelector('#tab-go').textContent === 'Mine in this tab');
    check(!(await page.locator('#tab-rows').isVisible()), 'before it starts there are no numbers');
    const noGpu = await page.evaluate(async () => !(await navigator.gpu?.requestAdapter?.()));
    await page.click('#tab-go');
    await page.waitForFunction(() => document.querySelector('#tab-go').textContent === 'Stop mining in this tab' && !document.querySelector('#tab-rows').hidden);
    const cores = await page.evaluate(() => navigator.hardwareConcurrency || 2), want = Math.max(1, Math.floor(cores / 4));
    await page.waitForFunction((n) => document.querySelector('#tab-n').textContent.startsWith(`${n} of `), want);
    check(await threads(page, (n) => n === want), 'a press starts a quarter of the cores as grinding threads', `${page.workers().length} workers, ${cores} cores`);
    if (noGpu) check(!(await page.locator('#tab-gpu-row').isVisible()), 'in a browser with no GPU for the page, no GPU is offered');
    await page.waitForFunction(() => /\d (k|M)\/s$/.test(document.querySelector('#tab-rate').textContent), null, { timeout: 30000 });
    check(true, 'the card shows how fast this tab grinds');
    if (cores > 2) {
      await page.click('#tab-more');
      await page.waitForFunction((n) => document.querySelector('#tab-n').textContent.startsWith(`${n} of `), want + 1);
      check(await threads(page, (n) => n === want + 1), 'one more core on a press of +', `${page.workers().length} workers`);
      await page.click('#tab-less');
      await page.waitForFunction((n) => document.querySelector('#tab-n').textContent.startsWith(`${n} of `), want);
      check(await threads(page, (n) => n === want) && (await page.evaluate(() => localStorage.getItem('tacit-prove-tab-threads'))) === String(want), 'and one fewer on −, the choice kept for the next visit', `${page.workers().length} workers`);
    }
    // the first send is about 21 s after the start
    const t0 = Date.now(); while (!shares.length && Date.now() - t0 < 40000) await page.waitForTimeout(500);
    const sent = shares[0] || { salts: [] };
    check(shares.length >= 1 && sent.miner === ADDR && sent.client === 'tacit-prove-tab/1' && sent.salts.length >= 1 && sent.salts.length <= 64, 'its shares are sent to the pool for the address, as this page\'s miner', JSON.stringify({ n: shares.length, miner: sent.miner, salts: sent.salts.length }));
    const today = Math.floor(Date.now() / 86400000) % 65536;
    const bits = sent.salts.map((s) => poolSaltAddress(s).bits);
    check(sent.salts.every((s) => /^0x[0-9a-f]{64}$/.test(s) && s.slice(2, 44) === '68575b073de49a94e3e3acf6f3a0d6e3b66267c7' + '00' && [today, (today + 65535) % 65536].includes(parseInt(s.slice(44, 48), 16))) && bits.every((b) => b >= 16) && bits.every((b, i) => i === 0 || b <= bits[i - 1]) && new Set(sent.salts).size === sent.salts.length,
      'every salt is one of Tacit\'s deployer for today that the pool\'s own check counts, the best first', JSON.stringify(bits.slice(0, 8)));
    await page.waitForFunction(() => /^\d[\d,]* shares? · .* TAC so far$/.test(document.querySelector('#tab-today').textContent), null, { timeout: 8000 }).catch(() => {});
    check(/^\d[\d,]* shares? · .* TAC so far$/.test(await text(page, '#tab-today')), 'what the pool counted, and its part of the day\'s points, are shown', await text(page, '#tab-today'));
    await page.click('#tab-go');
    await page.waitForFunction(() => document.querySelector('#tab-go').textContent === 'Mine in this tab');
    check(await threads(page, (n) => n === 0) && !(await page.locator('#tab-rows').isVisible()), 'Stop ends the threads and puts the numbers away', `${page.workers().length} workers`);
    check(!errors.length, 'tab mining: no page errors (the threads and the WebAssembly are allowed by the page\'s policy)', errors.join(' | '));
    await page.click('#tab-go');
    await page.waitForFunction(() => document.querySelector('#tab-go').textContent === 'Stop mining in this tab');
    await page.waitForFunction(() => /\d (k|M)\/s$/.test(document.querySelector('#tab-rate').textContent), null, { timeout: 30000 });
    await shot(page, 'prove-tabmine');
    // off the charger it waits, as tacit-prover does, unless the person says to go on
    const unplug = (charging) => page.evaluate((c) => { window.__battery.charging = c; window.__battery.dispatchEvent(new Event('chargingchange')); }, charging);
    await unplug(false);
    await page.waitForFunction(() => document.querySelector('#tab-rate').textContent === 'Paused on battery' && !document.querySelector('#tab-battery').hidden);
    check(await threads(page, (n) => n === 0), 'on battery the threads stop, and the card says so and offers to go on', `${page.workers().length} workers`);
    await unplug(true);
    await page.waitForFunction(() => document.querySelector('#tab-battery').hidden && document.querySelector('#tab-rate').textContent !== 'Paused on battery');
    check(await threads(page, (n) => n >= 1), 'back on the charger they start again', `${page.workers().length} workers`);
    await unplug(false);
    await page.waitForFunction(() => !document.querySelector('#tab-battery').hidden);
    await page.click('#tab-battery');
    await page.waitForFunction(() => document.querySelector('#tab-battery').hidden);
    check(await threads(page, (n) => n >= 1) && (await text(page, '#tab-rate')) !== 'Paused on battery', '"Mine on battery too" goes on without the charger');
    await ctx.close();
    // from the setup block's own link
    const quick = await open(browser, { v: null }, { more: false, minBits: 16, init: CHARGER });
    await quick.page.fill('#addr', ADDR);
    await quick.page.waitForFunction(() => !document.querySelector('#setup').hidden);
    await quick.page.click('#tab-quick');
    await quick.page.waitForFunction(() => document.querySelector('#tab-go').textContent === 'Stop mining in this tab');
    check(await threads(quick.page, (n) => n >= 1), 'the setup block\'s "Mine in this tab" starts it');
    check((await text(quick.page, '#say')) === '', 'and no "enter the address" is left on the card');
    // one tab at a time: while another holds the miner's lock, this one says so and starts nothing
    const held = await open(browser, { v: null }, { more: false, minBits: 16, init: CHARGER });
    await held.page.fill('#addr', ADDR);
    await held.page.waitForFunction(() => document.querySelector('#tab-go').textContent === 'Mine in this tab');
    await held.page.evaluate(() => { navigator.locks.request('tacit-prove-tab-miner', () => new Promise((r) => { window.__letGo = r; })); });
    await held.page.waitForTimeout(100);
    await held.page.click('#tab-go');
    await held.page.waitForFunction(() => document.querySelector('#tab-say').textContent === 'Another tab is mining already.');
    check(held.page.workers().length === 0 && (await text(held.page, '#tab-go')) === 'Mine in this tab', 'while another tab mines, this one says so and starts nothing');
    await held.page.evaluate(() => window.__letGo());
    await held.page.waitForTimeout(100);
    await held.page.click('#tab-go');
    await held.page.waitForFunction(() => document.querySelector('#tab-go').textContent === 'Stop mining in this tab');
    check(await threads(held.page, (n) => n >= 1) && !(await held.page.locator('#tab-say').isVisible()), 'and starts once the other has stopped');
    await held.ctx.close();
    await quick.ctx.close();
    // a prover that is mining grinds already: the tab is not offered
    const mining = await open(browser, { v: { mine: { miner: ADDR, on: true, job: null, proved: 0 } } }, { more: false });
    await mining.page.waitForFunction(() => document.querySelector('#go') && !document.querySelector('#go').hidden);
    check(!(await mining.page.locator('#tab-go').isVisible()), 'with tacit-prover mining on this computer, the tab is not offered');
    await mining.ctx.close();
    // a prover that is paused: the tab can mine, and stops when the prover starts
    const local = { v: { mine: { miner: ADDR, on: false, job: null, proved: 0 } } };
    const paused = await open(browser, local, { more: false, minBits: 16, init: CHARGER });
    await paused.page.waitForFunction(() => document.querySelector('#tab-go').textContent === 'Mine in this tab' && !document.querySelector('#tab-go').hidden);
    await paused.page.click('#tab-go');
    await paused.page.waitForFunction(() => document.querySelector('#tab-go').textContent === 'Stop mining in this tab');
    local.v.mine = { ...local.v.mine, on: true };
    await paused.page.waitForFunction(() => document.querySelector('#tab-go').hidden, null, { timeout: 8000 });
    check(await threads(paused.page, (n) => n === 0), 'when the prover starts mining, the tab stops and leaves it to the prover', `${paused.page.workers().length} workers`);
    await paused.ctx.close();
  }
  // the code-review card: no prover, an older prover, the model not yet fetched, and switching it on (the POST it sends, the record shown)
  {
    const none = await open(browser, { v: null }, { more: false });
    await none.page.waitForFunction(() => document.querySelector('#review-n').textContent === '3');
    check((await text(none.page, '#review-state')) === 'Needs tacit-prover, above' && !(await none.page.locator('#review-go').isVisible()) && !(await none.page.locator('#review-get').isVisible()), 'review card, no prover: it says what it needs, no button, no line', await text(none.page, '#review-state'));
    await none.ctx.close();
    const old = await open(browser, { v: { mine: { miner: ADDR, on: true, job: null, proved: 0 } } }, { more: false });
    await old.page.waitForFunction(() => document.querySelector('#review-state').textContent === 'Update tacit-prover to turn this on');
    check(!(await old.page.locator('#review-go').isVisible()), 'review card, a prover with no help desk: asked to update, no button');
    await old.ctx.close();
    const bare = await open(browser, { v: { mine: { miner: ADDR, on: true, job: null, proved: 0 }, desk: { on: false, api: null, miner: ADDR, installed: false, model_running: false, served: 0, job: null } } }, { more: false });
    await bare.page.waitForFunction(() => document.querySelector('#review-state').textContent === 'Get the model first');
    check(await bare.page.locator('#review-get').isVisible() && (await text(bare.page, '#review-cmd')) === 'curl -fsSL https://tacit.finance/helpdesk-fetch.sh | bash' && !(await bare.page.locator('#review-go').isVisible()), 'review card, no model: the line that gets it, and no button yet', await text(bare.page, '#review-cmd'));
    await bare.ctx.close();
    const local = { v: { mine: { miner: ADDR, on: true, job: null, proved: 0 }, desk: { on: false, api: null, miner: ADDR, installed: true, model_running: false, served: 0, job: null } } };
    const { page, ctx, errors, deskPosts } = await open(browser, local, { more: false });
    await page.waitForFunction(() => document.querySelector('#review-go').textContent === 'Turn on' && !document.querySelector('#review-me-row').hidden);
    check((await text(page, '#review-state')) === 'Off' && (await text(page, '#review-me')) === '22 of 37 checks right · 5 of 17 planted bugs found' && (await text(page, '#review-n')) === '3', 'review card, installed and off: Turn on, the address\'s record and the nodes online', `${await text(page, '#review-state')} | ${await text(page, '#review-me')}`);
    await page.click('#review-go');
    await page.waitForFunction(() => document.querySelector('#review-go').textContent === 'Turn off');
    check(deskPosts.length === 1 && deskPosts[0].on === true && deskPosts[0].api === 'https://tacit-helpdesk.onrender.com', 'Turn on sends the prover on, with the help desk\'s address', JSON.stringify(deskPosts));
    check((await text(page, '#review-state')) === 'On · when this computer is idle and plugged in' && !(await page.locator('#review-say').isVisible()), 'and the card says when it works, with no extra note', await text(page, '#review-state'));
    local.v.desk = { ...local.v.desk, model_running: true, job: { id: 'j', secs: 2 }, served: 4 };
    await page.waitForFunction(() => document.querySelector('#review-state').textContent === 'Reviewing · 4 answered');
    check(true, 'a job under way shows as Reviewing, with the answers so far');
    await page.click('#review-go');
    await page.waitForFunction(() => document.querySelector('#review-go').textContent === 'Turn on');
    check(deskPosts.length === 2 && deskPosts[1].on === false, 'Turn off sends it off');
    check(!errors.length, 'review card: no page errors', errors.join(' | '));
    await shot(page, 'prove-review');
    await ctx.close();
  }
  // the GPU, in a browser started with WebGPU on (skipped on a machine that has none for it): the shader against the WebAssembly grinder, then the page
  {
    const gpuBrowser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal'] });
    try {
      const { page, ctx, errors, shares } = await open(gpuBrowser, { v: null }, { more: false, minBits: 16, init: CHARGER });
      await page.waitForFunction(() => document.querySelector('#title').textContent === 'Set up this computer');
      const has = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter?.({ powerPreference: 'high-performance' })));
      if (!has) console.log('skip - no GPU for WebGPU in this browser: the shader is not run here');
      else {
        const r = await page.evaluate(async () => {
          const C = await import('/prove/saltcore.js'), G = await import('/prove/saltgpu.js');
          const day = C.utcDay(), prefix = crypto.getRandomValues(new Uint8Array(5)), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
          const g = await G.makeGpuGrinder({ day, prefix }), w = C.makeWasmGrinder({ day, prefix });
          const a = await g.grind(1 << 20, 16), wa = w.grind(1 << 20, 16);
          const b = await g.grind(1 << 19, 16), wb = w.grind(1 << 19, 16);
          const c = await g.grind(1 << 20, 20), wc = w.grind(1 << 20, 20);   // 20 bits: two zero bytes from the shader, the rest checked here
          const at = g.at() === w.at();
          // a stretch long enough that one dispatch notes more than it can hold: it is walked again in halves, and nothing is lost
          const from = g.at(), t0 = performance.now(), big = await g.grind(1 << 25, 16), ms = performance.now() - t0;
          const head = w.grind(1 << 20, 16), bigHead = big.filter((f) => ((f.n - from) >>> 0) <= (1 << 20));
          const sorted = big.every((f, i) => i === 0 || (f.n >>> 0) > (big[i - 1].n >>> 0));
          // the three-zero-byte mask (the pool's own share size uses it) against the two-byte one over the same salts
          const p2 = crypto.getRandomValues(new Uint8Array(5)), g2 = await G.makeGpuGrinder({ day, prefix: p2 }), g3 = await G.makeGpuGrinder({ day, prefix: p2 });
          const wide = (await g2.grind(1 << 25, 16)).filter((f) => f.bits >= 24), narrow = await g3.grind(1 << 25, 24), narrowNoted = g3.stats().noted, wideNoted = g2.stats().noted;
          let low = false; try { await g.grind(1 << 14, 8); } catch { low = true; }
          g.close(); g2.close(); g3.close();
          return { first: same(a, wa), n1: a.length, second: same(b, wb), third: same(c, wc), n3: c.length, narrowNoted, wideNoted, at, big: big.length, bigHead: same(bigHead, head), sorted, allBits: big.every((f) => f.bits >= 16), mps: +(((1 << 25) / ms) / 1000).toFixed(1), masks: same(wide, narrow), n24: narrow.length, low };
        });
        check(r.first && r.n1 > 4, 'the GPU finds exactly the shares the WebAssembly grinder finds over the same million salts', JSON.stringify(r));
        check(r.second && r.at, 'and goes on from where it stopped, as far as the other', JSON.stringify(r));
        check(r.third && r.n3 < r.n1, 'at a share size that is not whole bytes (20 bits) it reports exactly the shares of that size', JSON.stringify(r));
        check(r.big > 380 && r.big < 660 && r.sorted && r.allBits && r.bigHead, `a stretch that notes more than one dispatch holds is walked again in halves, with nothing lost (${r.big} shares in 33 M salts, ${r.mps} M salts/s here)`, JSON.stringify(r));
        check(r.masks, `the pool's own share size (three zero bytes and more) finds what the wider search finds (${r.n24} of 24 bits)`, JSON.stringify(r));
        check(r.narrowNoted < 40 && r.wideNoted > 300, `and the shader passes on only what has those zero bytes (${r.narrowNoted} notes, against ${r.wideNoted} at two bytes)`, JSON.stringify(r));
        check(r.low, 'a share size under 16 bits is left to the cores');
        // the page: the GPU is offered and used, its shares are sent, and it can be turned off and up
        await page.fill('#addr', ADDR);
        await page.waitForFunction(() => document.querySelector('#tab-go').textContent === 'Mine in this tab');
        await page.click('#tab-go');
        await page.waitForFunction(() => !document.querySelector('#tab-gpu-row').hidden && document.querySelector('#tab-gpu-row [data-gpu="half"]').getAttribute('aria-pressed') === 'true');
        const cores = await page.evaluate(() => navigator.hardwareConcurrency || 2), want = Math.max(1, Math.floor(cores / 4));
        check(await threads(page, (n) => n === want + 1), 'with a GPU the page offers it, at half, and starts one more thread for it', `${page.workers().length} workers`);
        await page.waitForFunction(() => / M\/s$/.test(document.querySelector('#tab-rate').textContent), null, { timeout: 40000 });
        check(true, `the tab then grinds millions of salts a second (${await text(page, '#tab-rate')})`);
        const t0 = Date.now(); while (!shares.length && Date.now() - t0 < 40000) await page.waitForTimeout(500);
        const sent = shares[0] || { salts: [] }, bits = sent.salts.map((s) => poolSaltAddress(s).bits);
        check(sent.salts.length === 64 && bits.every((b) => b >= 16) && bits.every((b, i) => i === 0 || b <= bits[i - 1]) && bits[0] >= 20, 'its shares go to the pool, the best 64 first, each one the pool\'s own check counts', JSON.stringify(bits.slice(0, 6)));
        await page.click('#tab-gpu-row [data-gpu="off"]');
        check(await threads(page, (n) => n === want) && (await page.getAttribute('#tab-gpu-row [data-gpu="off"]', 'aria-pressed')) === 'true', 'Off ends the GPU thread and leaves the cores', `${page.workers().length} workers`);
        await page.click('#tab-gpu-row [data-gpu="full"]');
        check(await threads(page, (n) => n === want + 1) && (await page.evaluate(() => localStorage.getItem('tacit-prove-tab-gpu'))) === 'full', 'Full starts it again, and the choice is kept', `${page.workers().length} workers`);
        await shot(page, 'prove-tabmine-gpu');
        await page.click('#tab-go');
        check(await threads(page, (n) => n === 0), 'Stop ends every thread, the GPU\'s too', `${page.workers().length} workers`);
        check(!errors.length, 'GPU mining: no page errors', errors.join(' | '));
      }
      await ctx.close();
    } finally { await gpuBrowser.close(); }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
