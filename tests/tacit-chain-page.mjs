// The tacit chain on TAC's page (/tac/; /chain/ goes on there) in a real browser, under the page's own content-security policy. Pointed at a
// deployment (localStorage 'tacit-chain-dev', the leader reached through the page's own origin so the CSP holds as shipped), over a stand-in
// Ethereum (every public node the page reads routed to a fake that answers the landing contract's views) and a stand-in leader on the page's
// server: the chain's figures, what a share is worth and the fee cards, then a key pasted in the wallet sheet, its TAC on the chain found from a
// note sealed to it, the spends this browser kept for it, and its address with the chain lane, published as it opens.
// At 390 and 1280 px, light and dark, with no sideways scroll.
//   PLAYWRIGHT=<path to playwright-core> node tests/tacit-chain-page.mjs        (SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { secp, keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from '../dapp/vendor/tacit-poseidon.min.js';
import { makeChainClient } from '../dapp/tacit-chain-client.js';
import { makeChainWallet, assetField, worthOf } from '../dapp/tacit-chain-wallet.js';
import { makeTacitAddress } from '../dapp/tacit-address.js';
import { ETH_NODES } from '../dapp/eth-nodes.js';
import { fmtTac, sharePrice } from '../dapp/chain/ui.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const sel = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4)).toString('hex');
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', UNIT = 10n ** 8n;
const BLOCKS = '0x00000000000000000000000000000000000b10c5';
const CHAIN = '0x' + 'c4'.repeat(32);
const asset = assetField(Uint8Array.from([...new Array(12).fill(0), ...Buffer.from(TAC.slice(2), 'hex')]));
const assetHex = asset.toString(16).padStart(64, '0');
const NOW_S = Math.floor(Date.now() / 1000);
const RATE = { pool: 12_345n * UNIT + 6_700_000n, shares: 12_300n * UNIT };
const KEY = 'a11c'.padEnd(64, '4');
const POSEIDON = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 }, poseidon = (xs) => POSEIDON[xs.length](xs);

// two deposits this key made: a shield from the wallet still waiting on Ethereum (past RECLAIM_AFTER), and a move from the private pool
// whose inbox is paid and not swept
const depA = { shares: '2490000000', amount: '2500000000', cx: '0x' + '11'.repeat(32), cy: '0x' + '22'.repeat(32), body: '0x' + '33'.repeat(32) };
const depB = { shares: '4790000000', amount: '4800000000', cx: '0x' + '44'.repeat(32), cy: '0x' + '55'.repeat(32), body: '0x' + '66'.repeat(32) };
const depKey = (d) => hx(keccak_256(Buffer.from(assetHex + word(d.shares) + strip(d.cx) + strip(d.cy) + strip(d.body) + word(d.amount), 'hex')));
const INBOX = '0x' + 'ab'.repeat(20);

// Ethereum as the page reads it: the landing contract's views, TAC's balance of an inbox, an inbox's code
const views = {
  [sel('CHAIN()')]: () => CHAIN,
  [sel('TAC_ASSET()')]: () => '0x' + assetHex,
  [sel('height()')]: () => '0x' + word(1234),
  [sel('lastLanded()')]: () => '0x' + word(NOW_S - 42),
  [sel('pool()')]: () => '0x' + word(RATE.pool),
  [sel('shares()')]: () => '0x' + word(RATE.shares),
  [sel('RECLAIM_AFTER()')]: () => '0x' + word(7 * 86400),
  [sel('FORCE_DELAY()')]: () => '0x' + word(3600),
  [sel('TAC()')]: () => '0x' + word(TAC),
  [sel('hops(bytes32)')]: () => '0x' + word(1),
  [sel('balanceOf(address)')]: () => '0x' + word(10n ** 21n),
  [sel('pending(bytes32)')]: (data) => {
    const k = '0x' + data.slice(10, 74);
    return k === depKey(depA) ? '0x' + word('0x' + '0d'.repeat(20)) + word(NOW_S - 8 * 86400) + word(0) : '0x' + '0'.repeat(192);
  },
};
function ethAnswer(method, params) {
  if (method === 'eth_call') {
    const data = String(params[0].data), f = views[data.slice(2, 10)];
    if (!f) throw new Error(`unexpected call ${data.slice(0, 10)}`);
    return f(data);
  }
  if (method === 'eth_getCode') return '0x';
  if (method === 'eth_blockNumber') return '0x10';
  if (method === 'eth_chainId') return '0x1';
  throw new Error(`unexpected ${method}`);
}
const rpcCall = async (m, p) => ethAnswer(m, p);

// the key's chain wallet, as the page's client makes it, and one note sealed to it (worth fmtTac(worthOf(…)) TAC at the rate above)
const cfgOf = (leader) => ({ blocks: BLOCKS, leader });
const node = makeChainClient({ cfg: cfgOf('http://x'), rpcCall, priv: Buffer.from(KEY, 'hex'), system: () => null, storage: null });
const lane = await node.lane(), laneHex = hx(lane).slice(2, 18);
const w = makeChainWallet({ poseidon, prover: null, chain: CHAIN, asset });
const NOTE_SHARES = 2_490_000_000n, note = w.makeNote(await node.address(), NOTE_SHARES);
const WANT_BAL = fmtTac(worthOf(NOTE_SHARES, RATE));
// (the page's row for it, to the cent, as fmt rounds)
const WANT_ROW = (() => { const c = (worthOf(NOTE_SHARES, RATE) + 500_000n) / 1_000_000n, f = String(c % 100n).padStart(2, '0').replace(/0+$/, ''); return `${(c / 100n).toLocaleString('en-US')}${f ? '.' + f : ''}`; })();
const pendingKey = `tacit-chain-pending-v1:${BLOCKS.toLowerCase()}:${laneHex}`, hopsKey = `tacit-chain-hops-v1:${BLOCKS.toLowerCase()}:${laneHex}`;
const kept = (now) => [
  { id: 'aa'.repeat(32), kind: 'shield', units: '2500000000', submission: { publics: '0x', data: '0x' }, extra: {}, nullifiers: [], leaves: [], deposit: depA, from: '0x' + '0d'.repeat(20), at: now - 60e3 },
  { id: 'bb'.repeat(32), kind: 'shield', units: '4800000000', submission: { publics: '0x', data: '0x' }, extra: { back: '0x' + '77'.repeat(32) }, nullifiers: [], leaves: [], deposit: depB, inbox: INBOX, back: '0x' + '77'.repeat(32), pay: { until: now + 3600e3 }, at: now - 60e3 },
  { id: 'cc'.repeat(32), kind: 'pay', units: '1000000000', submission: { publics: '0x', data: '0x' }, extra: {}, nullifiers: [], leaves: [], forced: { tx: '0x' + '99'.repeat(32), at: now - 30e3 }, at: now - 90e3 },
];
const hopsWaiting = (now) => [{ units: '700000000', commit: '0x' + '88'.repeat(32), at: now - 6 * 60e3 }];

// the leader, on the page's own server under /tacit-chain-leader
const directory = new Map();
const LEADER = {
  'GET /fee': () => [200, { fee: '1500000', shieldCap: '100000000000', sweepFee: '40000000000000000', at: NOW_S }],
  'GET /notes': (q) => (Number(q.get('from')) === 0 ? [200, { leaves: [hx(Buffer.from(note.leaf.toString(16).padStart(64, '0'), 'hex'))], memos: [hx(note.memo)], next: 1, total: 1 }] : [200, { leaves: [], memos: [], next: 1, total: 1 }]),
};
function leaderAnswer(method, path, q, body) {
  if (LEADER[`${method} ${path}`]) return LEADER[`${method} ${path}`](q, body);
  if (method === 'GET' && path.startsWith('/spent/')) return [200, { spent: false }];
  if (method === 'GET' && path.startsWith('/leaf/')) return [404, { error: 'no such leaf' }];
  if (method === 'GET' && path.startsWith('/address/')) { const a = directory.get(strip(path.slice(9))); return a ? [200, { address: a }] : [404, { error: 'no such address' }]; }
  if (method === 'POST' && path === '/address') {
    const a = strip(JSON.parse(body).address), h = hx(w.chainAddressHash(w.decodeAddress('tc1' + a)));
    directory.set(strip(h), '0x' + a);
    return [200, { hash: h }];
  }
  return [404, { error: 'not here' }];
}
const leaderAsked = [];
const web = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/tacit-chain-leader/')) {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const path = u.pathname.slice('/tacit-chain-leader'.length);
      leaderAsked.push(`${req.method} ${path}`);
      const [status, j] = leaderAnswer(req.method, path, u.searchParams, body);
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j));
    });
    return;
  }
  let f = normalize(join(DAPP, decodeURIComponent(u.pathname)));
  if (!f.startsWith(DAPP)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const WEB = `http://127.0.0.1:${web.address().port}`;

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const browser = await chromium.launch();
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
const rowsOf = (page, sel) => page.$$eval(`${sel} .kv`, (rs) => Object.fromEntries(rs.map((r) => [r.firstElementChild.textContent.trim(), r.lastElementChild.textContent.replace(/\s+/g, ' ').trim()])));
const NODE_HOSTS = new Set(ETH_NODES.map((u) => new URL(u).host));

async function visit({ viewport = { width: 1280, height: 900 }, colorScheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme });
  const asked = [], bad = [];
  await ctx.addInitScript(({ dev, pk, kept, hk, hops }) => {
    localStorage.setItem('tacit-chain-dev', JSON.stringify(dev));
    const now = Date.now();
    localStorage.setItem(pk, JSON.stringify(kept.map((e) => ({ ...e, at: now - e.at, ...(e.pay ? { pay: { until: now + e.pay.until } } : {}), ...(e.forced ? { forced: { ...e.forced, at: now - e.forced.at } } : {}) }))));
    localStorage.setItem(hk, JSON.stringify(hops.map((h) => ({ ...h, at: now - h.at }))));
  }, { dev: { blocks: BLOCKS, leader: `${WEB}/tacit-chain-leader` }, pk: pendingKey, hk: hopsKey,
    // (times as offsets from the page's now, which the script adds)
    kept: kept(0).map((e) => ({ ...e, at: -e.at, ...(e.pay ? { pay: { until: e.pay.until } } : {}), ...(e.forced ? { forced: { ...e.forced, at: -e.forced.at } } : {}) })),
    hops: hopsWaiting(0).map((h) => ({ ...h, at: -h.at })) });
  // Ethereum is the stand-in; every other service the front page reads is out of reach, as it may be on a bad day
  await ctx.route(/^https:\/\//, async (route) => {
    const q = route.request(), host = new URL(q.url()).host;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (NODE_HOSTS.has(host) && q.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (!NODE_HOSTS.has(host) || q.method() !== 'POST') return route.abort();
    const body = JSON.parse(q.postData() || '{}'), one = (x) => { try { return { jsonrpc: '2.0', id: x.id, result: ethAnswer(x.method, x.params) }; } catch (e) { return { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: e.message } }; } };
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
  });
  const page = await ctx.newPage();
  page.on('request', (r) => asked.push(r.url()));
  page.on('pageerror', (e) => bad.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) bad.push(`console: ${m.text()} ${m.location()?.url || ''}`); });
  await page.goto(`${WEB}/chain/`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/tac\/$/, { timeout: 15000 });
  const tag = `${viewport.width}-${colorScheme}`;
  return { page, ctx, asked, bad, shot: async (name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `chain-${name}-${tag}.png`), fullPage: true }); } };
}
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
// the key pasted in the front page's wallet sheet, which TAC's page shares
async function signIn(page) {
  await page.click('#tpg-top [data-signin]');
  await page.waitForSelector('#sheet-wallet[open] [data-in="paste"]', { timeout: 10000 });
  await page.click('#sheet-wallet [data-in="paste"]');
  await page.fill('#ws-hex', KEY);
  await page.click('#sheet-wallet [data-in="key"]');
  await page.waitForFunction(() => /tacit1/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 30000 });
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
}
const cells = (page) => page.$$eval('#tpg-nets .tpg-strip:last-of-type > div', (cs) => Object.fromEntries(cs.map((c) => [c.querySelector('.k').textContent.trim(), c.querySelector('.v').textContent.trim()])));

try {
  // pointed at a deployment: /chain/ goes on to TAC's page, which reads the chain's figures, then a key's side
  {
    const { page, ctx, bad, shot } = await visit();
    ok((await page.title()) === 'tacit TAC', '/chain/ goes on to TAC\'s page');
    await page.click('#tpg-how > summary');
    await page.waitForFunction(() => /1,234/.test(document.querySelector('#tpg-nets')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    const r = await cells(page);
    ok(r.Blocks === '1,234' && /^4\d s ago$/.test(r['Last block']) && r['Share price'] === sharePrice(RATE.pool, RATE.shares, 5) && r['Pool, TAC'] === fmtTac(RATE.pool, 2)
      && r['Leader fee, TAC'] === '0.015' && r['Shield cap, TAC'] === '1,000', `the chain's figures (${JSON.stringify(r)})`);
    ok(new RegExp(`1 share = ${sharePrice(RATE.pool, RATE.shares, 5).replace('.', '\\.')}`).test(await text(page, '#tpg-why')), `what a share is worth (${(await text(page, '#tpg-why .tpg-px'))})`);
    ok(/about 0\.017 TAC/.test(await text(page, '.tpg-fees')) && /0\.015 TAC/.test(await text(page, '.tpg-fees')), `the fee cards take the leader's terms (${(await text(page, '.tpg-fees')).slice(0, 120)})`);
    await shot('status');
    await signIn(page);
    await page.waitForFunction((want) => [...document.querySelectorAll('.tpg-leg li')].some((li) => /Tacit chain/.test(li.textContent) && li.querySelector('b')?.textContent.trim() === want), WANT_ROW, { timeout: 30000 })
      .then(() => ok(true, `the key's TAC on the Tacit chain, found from the note sealed to it (${WANT_BAL})`), async () => ok(false, `chain row: ${await text(page, '.tpg-leg')}`));
    await page.waitForFunction(() => /moves have not landed yet/.test(document.querySelector('#tpg-top')?.textContent || ''), null, { timeout: 30000 })
      .then(async () => ok(true, `what waits is said, with the tile's move that shows it (${await text(page, '#tpg-top .note')})`), async () => ok(false, `kept: ${await text(page, '#tpg-top')}`));
    await page.click('#tpg-top [data-tpg="receive"]');
    await page.waitForFunction(() => /^tacit1/.test(document.querySelector('#tpg-p .keyrow .full code')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    const addr = await page.$eval('#tpg-p .keyrow .full code', (e) => e.textContent.trim()).catch(() => '');
    let laneOk = false;
    try { laneOk = Buffer.from(makeTacitAddress({ secp }).decodeTacitAddress(addr).lanes.chain.hash).equals(Buffer.from(lane)); } catch { /* not an address */ }
    ok(laneOk, `its Tacit address carries its chain lane (${addr.slice(0, 18)}…)`);
    for (let i = 0; i < 40 && directory.size === 0; i++) await new Promise((r) => setTimeout(r, 500));
    ok(directory.size === 1, 'the address is in the leader\'s directory, published as the key opened');
    ok(leaderAsked.includes('GET /fee') && leaderAsked.some((x) => x.startsWith('GET /notes')), 'the leader was asked for its terms and its notes');
    await shot('signed-in');
    ok(bad.length === 0, `no errors or CSP violations (${bad.join(' | ')})`);
    await ctx.close();
  }
  // a phone and a desk, light and dark: nothing sideways
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    for (const colorScheme of ['light', 'dark']) {
      directory.clear();
      const { page, ctx, bad, shot } = await visit({ viewport, colorScheme });
      await page.waitForFunction(() => /1 share = \d/.test(document.querySelector('#tpg-why')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
      const before = await noSideways(page);
      await signIn(page);
      await shot('page');
      ok(before && (await noSideways(page)), `${viewport.width} px ${colorScheme}: no sideways scroll, signed out or in`);
      ok(bad.length === 0, `${viewport.width} px ${colorScheme}: no errors (${bad.join(' | ')})`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  web.close();
}
console.log(`\n${n} ok, ${fails} failed`);
process.exit(fails ? 1 : 0);
