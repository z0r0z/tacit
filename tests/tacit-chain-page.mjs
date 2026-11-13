// The tacit chain on TAC's page (/tac/; /chain/ goes on there) in a real browser, under the page's own content-security policy. Pointed at a
// deployment (localStorage 'tacit-chain-dev', the leader reached through the page's own origin so the CSP holds as shipped), over a stand-in
// Ethereum (every public node the page reads routed to a fake that answers the landing contract's views) and a stand-in leader on the page's
// server: the chain's figures, what a share is worth and the fee cards, then a key pasted in the wallet sheet, its TAC on the chain found from a
// note sealed to it, the spends this browser kept for it, and its address with the chain lane, published as it opens. The page as the chain's own:
// its name and what it rests on at the head, the pool's notes drawn, the ways to take part; the card beside the chain on a wide screen and under
// its newest blocks on a narrow one, on the first screen either way; what a shield brings and costs before and after sign-in, the gas paid from
// the account's own ETH when it has some (the leader's fee in TAC a press away) and by the leader for its fee when it has none.
// At 390 and 1280 px, light and dark, with no sideways scroll.
// Then a shield pressed and proved in the page, with ETH and with none: what the account signs and sends, what the leader is handed, the card's steps
// and the chain panel's mark on the visitor's block.
//   PLAYWRIGHT=<path to playwright-core> node tests/tacit-chain-page.mjs        (SHOTS=<dir> saves screenshots; PRESS=no leaves the pressed shields
//   out, each of which proves a spend for half a minute or more, and PRESS=only runs nothing else)

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { secp, keccak_256, sha256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeEvmAccount } from '../dapp/evm-account.js';
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
  [sel('WINDOW()')]: () => '0x' + word(600),                     // (the chain panel's own reads: nothing queued)
  [sel('queued()')]: () => '0x' + word(0),
  [sel('queueDone()')]: () => '0x' + word(0),
  [sel('TAC()')]: () => '0x' + word(TAC),
  [sel('hops(bytes32)')]: () => '0x' + word(1),
  [sel('balanceOf(address)')]: () => '0x' + word(10n ** 21n),
  [sel('nonces(address)')]: () => '0x' + word(0),
  [sel('inbox(uint256,uint256,bytes32,bytes32,bytes32,bytes32)')]: () => '0x' + word(INBOX),
  // (a deposit the pressed shield's own transaction made is held for its inbox, as a sweep leaves it)
  [sel('pending(bytes32)')]: (data) => {
    const k = '0x' + data.slice(10, 74);
    if (k === depKey(depA)) return '0x' + word('0x' + '0d'.repeat(20)) + word(NOW_S - 8 * 86400) + word(0);
    return press.raw.length ? '0x' + word(INBOX) + word(NOW_S) + word(0) : '0x' + '0'.repeat(192);
  },
};
// a shield pressed in the page: the spends handed to the leader (each with what came with it), which lands them a few seconds after the second
// hand-over, and the transactions the account sent to Ethereum
const press = { spends: [], raw: [], landAt: 0 };
const landed = () => (press.landAt && Date.now() >= press.landAt ? 1 : 0);
const pressAgain = () => Object.assign(press, { spends: [], raw: [], landAt: 0 });
// Multicall3, as far as a wallet's balances go: aggregate3 over the views above and the account's ETH (`ETH_HELD`, set for a visit). Its own clock is
// not answered, so the chain panel's batched read still falls back to one call each.
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
let ETH_HELD = 0n;
function oneCall(to, data) {
  if (to.toLowerCase() === MULTICALL3) {
    if (data.slice(2, 10) === '4d2301cc') return '0x' + word(ETH_HELD);
    throw new Error('unexpected Multicall3 call');
  }
  const f = views[data.slice(2, 10)];
  if (!f) throw new Error(`unexpected call ${data.slice(0, 10)}`);
  return f(data);
}
function aggregate3(data) {
  const h = data.slice(10), at = (i) => h.slice(64 * i, 64 * i + 64), num = (i) => Number(BigInt('0x' + at(i))), count = num(1);
  let head = '', tail = '', off = count * 32;
  for (let i = 0; i < count; i++) {
    const e = 2 + num(2 + i) / 32, len = num(e + 3);
    let ok = 1, ret = '';
    try { ret = strip(oneCall('0x' + at(e).slice(24), '0x' + h.slice(64 * (e + 4), 64 * (e + 4) + len * 2))); } catch { ok = 0; }
    const body = word(ok) + word(64) + word(ret.length / 2) + ret.padEnd(Math.ceil(ret.length / 64) * 64, '0');
    head += word(off); tail += body; off += body.length / 2;
  }
  return '0x' + word(32) + word(count) + head + tail;
}
function ethAnswer(method, params) {
  if (method === 'eth_call' && String(params[0].to).toLowerCase() === MULTICALL3) {
    const data = String(params[0].data);
    if (data.slice(2, 10) !== '82ad56cb') throw new Error('unexpected Multicall3 call');
    return aggregate3(data);
  }
  if (method === 'eth_call') {
    const data = String(params[0].data), f = views[data.slice(2, 10)];
    if (!f) throw new Error(`unexpected call ${data.slice(0, 10)}`);
    return f(data);
  }
  if (method === 'eth_gasPrice') return '0x' + (50_000_000).toString(16);
  if (method === 'eth_getBalance') return '0x' + ETH_HELD.toString(16);
  if (method === 'eth_getTransactionCount') return '0x1';                     // (the key's account has sent before: it is the one that pays, with ETH or without)
  if (method === 'eth_maxPriorityFeePerGas') return '0x' + (10_000_000).toString(16);
  if (method === 'eth_estimateGas') return '0x' + (175_000).toString(16);
  if (method === 'eth_sendRawTransaction') { press.raw.push(strip(params[0])); return hx(keccak_256(Buffer.from(strip(params[0]), 'hex'))); }
  if (method === 'eth_getTransactionReceipt') return press.raw.some((r) => hx(keccak_256(Buffer.from(r, 'hex'))) === params[0]) ? { status: '0x1', blockNumber: '0x10', transactionHash: params[0] } : null;
  if (method === 'eth_getBlockByNumber') return { number: '0x10', timestamp: '0x' + NOW_S.toString(16), baseFeePerGas: '0x' + (50_000_000).toString(16) };
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
const LEAVES = 365, SPENT = 151, SPENDS = 987, SWEEP_FEE = '40000000000000000';
// (the chain address the leader's fee is paid to: a key of its own)
const LEADER_ADDRESS = w.encodeAddress(await makeChainClient({ cfg: cfgOf('http://x'), rpcCall, priv: Buffer.from('1eade4'.padEnd(64, '5'), 'hex'), system: () => null, storage: null }).address());
const LEADER = {
  'GET /state': () => [200, { height: 1234 + landed(), pending: press.spends.length && !landed() ? 1 : 0, leaves: LEAVES + 2 * landed(), nullifiers: SPENT, spends: SPENDS + landed(), pool: String(RATE.pool), shares: String(RATE.shares) }],
  'GET /fee': () => [200, { address: LEADER_ADDRESS, fee: '1500000', shieldCap: '100000000000', sweepFee: SWEEP_FEE, at: NOW_S }],
  'POST /spend': (q, body) => {
    const j = JSON.parse(body);
    press.spends.push({ permit: j.permit || null, back: j.back || null });
    if (press.spends.length === 2) press.landAt = Date.now() + 6000;
    return [200, { id: 'e5'.repeat(16) }];
  },
  'GET /notes': (q) => (Number(q.get('from')) === 0 ? [200, { leaves: [hx(Buffer.from(note.leaf.toString(16).padStart(64, '0'), 'hex'))], memos: [hx(note.memo)], next: 1, total: 1 }] : [200, { leaves: [], memos: [], next: 1, total: 1 }]),
};
function leaderAnswer(method, path, q, body) {
  if (LEADER[`${method} ${path}`]) return LEADER[`${method} ${path}`](q, body);
  if (method === 'GET' && path.startsWith('/receipt/')) return [200, landed() ? { status: 'landed', height: SPAN + 1 } : { status: 'queued' }];
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
// the block API: a history of SPAN blocks, a hundred to a page as the real one gives, a share's worth rising with each
const SPAN = 250, apiAsked = [];
const blockAt = (h) => ({ height: h, ethBlock: 20_000_000 + h * 7, tx: '0x' + h.toString(16).padStart(64, '0'), by: '0x' + '84'.repeat(20), pool: String(12_000n * UNIT + BigInt(h) * 3_000_000n), shares: String(12_000n * UNIT) });
function apiAnswer(path, q) {
  if (path === '/prover/blocks') return { head: SPAN + landed(), blocks: SPAN + landed(), cross: null, rollup: Array.from({ length: 20 }, (_, i) => blockAt(SPAN + landed() - i)) };
  if (path === '/prover/rollup') {
    const before = Number(q.get('before')), rows = [];
    for (let h = before - 1; h >= 1 && rows.length < Math.min(100, Number(q.get('limit')) || 100); h--) rows.push(blockAt(h));
    return { rollup: rows, first: 1, kept: SPAN };
  }
  // the proving board: two machines that prove the chain's blocks, seen just now
  if (path === '/prover/board') return { workers: [{ name: 'a', programs: ['tacit-block'], lastSeenSeconds: 2 }, { name: 'b', programs: ['confidential', 'tacit-block'], lastSeenSeconds: 9 }, { name: 'c', programs: ['confidential'], lastSeenSeconds: 1 }] };
  return null;
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
    if (host === 'api.tacit.finance' && q.method() === 'GET') {
      const u = new URL(q.url()), a = apiAnswer(u.pathname, u.searchParams);
      if (a) { apiAsked.push(u.pathname + u.search); return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(a) }); }
    }
    if (NODE_HOSTS.has(host) && q.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (!NODE_HOSTS.has(host) || q.method() !== 'POST') return route.abort();
    const body = JSON.parse(q.postData() || '{}'), one = (x) => { try { return { jsonrpc: '2.0', id: x.id, result: ethAnswer(x.method, x.params) }; } catch (e) { return { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: e.message } }; } };
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
  });
  const page = await ctx.newPage();
  page.on('request', (r) => asked.push(r.url()));
  page.on('pageerror', (e) => bad.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) bad.push(`console: ${m.text()} ${m.location()?.url || ''}`); });
  await page.goto(`${WEB}/tac/`, { waitUntil: 'domcontentloaded' });
  const tag = `${viewport.width}-${colorScheme}`;
  return { page, ctx, asked, bad, shot: async (name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `chain-${name}-${tag}.png`), fullPage: true }); } };
}
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
// the key pasted in the front page's wallet sheet, which TAC's page shares
async function signIn(page) {
  await page.click('#tcd-go');
  await page.waitForSelector('#sheet-wallet[open] [data-in="paste"]', { timeout: 10000 });
  await page.click('#sheet-wallet [data-in="paste"]');
  await page.fill('#ws-hex', KEY);
  await page.click('#sheet-wallet [data-in="key"]');
  await page.waitForFunction(() => /tacit1/.test(document.querySelector('#wallet-label')?.textContent || ''), null, { timeout: 30000 });
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
}
// the Receive tab's own address, by its row's label (the pay link above it is folded too)
const TACIT_ROW = `(() => [...document.querySelectorAll('#tpg-p .keyrow')].find((r) => r.querySelector('.kv > span')?.textContent.trim() === 'Your Tacit address')?.querySelector('.full code')?.textContent.trim() || '')()`;
const cells = (page) => page.$$eval('#tpg-nets .tpg-strip:last-of-type > div', (cs) => Object.fromEntries(cs.map((c) => [c.querySelector('.k').textContent.trim(), c.querySelector('.v').textContent.trim()])));
// what the card says a move brings and costs, by its rows' names (the gas row's name holds its choice of what pays, when there is one)
const quoteRows = (page) => page.$$eval('#tcd-q .tcd-rows > div', (ds) => Object.fromEntries(ds.map((d) => {
  const k = d.querySelector('dt').firstChild?.textContent.replace(/\s+/g, ' ').trim() || '';
  return [k.replace(/ in$/, ''), d.querySelector('dd').textContent.replace(/\s+/g, ' ').trim()];
})));
const shieldQuote = async (page, amount) => {
  await page.fill('#tcd-amt', amount);
  // (the rows are whole once the amount is quoted and the account's balances are read: the gas row waits for them)
  await page.waitForFunction(() => /≈/.test(document.querySelector('#tcd-q .tcd-rows')?.textContent || '') && !document.querySelector('#tcd-q .sk'), null, { timeout: 30000 }).catch(() => {});
  return quoteRows(page);
};
// where the page's parts sit, at the top of the page
const laid = (page) => page.evaluate(() => {
  const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top + scrollY, bottom: b.bottom + scrollY }; };
  return { live: r('#tpg-live'), card: r('#tpg-card'), mid: r('#tpg-mid'), amt: r('#tcd-amt'), go: r('#tcd-go'), screen: innerHeight };
});

const PRESS = process.env.PRESS || 'too';
try {
  // pointed at a deployment: /chain/ goes on to TAC's page, which reads the chain's figures, then a key's side (its account holds ETH)
  if (PRESS !== 'only') {
    ETH_HELD = 10n ** 16n;
    const { page, ctx, bad, shot } = await visit();
    ok((await page.title()) === 'tacit TAC', 'TAC\'s page opens');
    // the page is the chain's: named at its head, with what it rests on; the card beside the chain, its button on the first screen
    const head = await page.evaluate(() => ({ h1: document.querySelector('#tac-h')?.textContent.replace(/\s+/g, ' ').trim(), marks: [...document.querySelectorAll('.tpg-trust a')].map((a) => a.textContent.trim()) }));
    ok(head.h1 === 'tacit chain' && head.marks.join('|') === 'No owner or upgrade key|Every block proven|Data on Ethereum|Forced inclusion', `the page is named for the chain, with what it rests on (${JSON.stringify(head)})`);
    await page.waitForFunction(() => !!document.querySelector('#tpg-live .cl-chain li a, #tpg-live .cl-chain li.sl') && !!document.querySelector('#tcd-go'), null, { timeout: 20000 }).catch(() => {});
    const wide = await laid(page);
    ok(wide.card.left >= wide.live.right && wide.card.top < wide.live.bottom && wide.go.bottom <= wide.screen, `on a wide screen the card is beside the chain, its button on the first screen (${JSON.stringify(wide)})`);
    // before sign-in the card already says what a shield brings and costs, from what anyone can read
    const out = await shieldQuote(page, '250');
    ok(/^≈ 249\.\d+ TAC, private$/.test(out.Arrives) && out.Gas === '0.04 TAC, or your own ETH' && /^One signature · about a minute$/.test(out.Takes) && (await text(page, '#tcd-go')) === 'Sign in',
      `signed out, a shield is quoted from the chain's public figures (${JSON.stringify(out)})`);
    await page.fill('#tcd-amt', '');
    await page.click('#tpg-how > summary');
    await page.waitForFunction(() => /1,234/.test(document.querySelector('#tpg-nets')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    const r = await cells(page);
    ok(r.Blocks === '1,234' && /^[4-8]\d s ago$/.test(r['Last block']) && r['Share price'] === sharePrice(RATE.pool, RATE.shares, 5) && r['Pool, TAC'] === fmtTac(RATE.pool, 2)
      && r['Leader fee, TAC'] === '0.015' && r['Shield cap, TAC'] === '1,000', `the chain's figures (${JSON.stringify(r)})`);
    // a share's worth, and what the chain has landed, are figures in the chain panel; the pool's notes are drawn under them, a dot each
    await page.waitForFunction((want) => [...document.querySelectorAll('#tpg-mid .cl-stats [data-k="px"]')].some((e) => e.textContent === want), sharePrice(RATE.pool, RATE.shares, 5), { timeout: 20000 }).catch(() => {});
    const figs = await page.$$eval('#tpg-mid .cl-stats > div', (ds) => Object.fromEntries(ds.map((d) => [d.querySelector('.k').textContent.replace(/\s+/g, ' ').trim(), d.querySelector('.v').textContent.replace(/\s+/g, ' ').trim()])));
    ok(figs[Object.keys(figs).find((k) => /^1 share/.test(k))] === `${sharePrice(RATE.pool, RATE.shares, 5)}TAC`, `what a share is worth (${JSON.stringify(figs)})`);
    ok(figs.transactions === String(SPENDS), `the transactions are the leader's count (${figs.transactions})`);
    await page.waitForFunction(() => document.querySelector('#tpg-mid .cl-pool canvas')?.height > 1, null, { timeout: 20000 }).catch(() => {});
    const pool = await page.evaluate(() => {
      const f = document.querySelector('#tpg-mid .cl-pool'), c = f?.querySelector('canvas');
      if (!c) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let inked = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]) inked++;
      return { shown: !f.hidden, says: f.querySelector('figcaption').textContent.replace(/\s+/g, ' ').trim(), inked, height: Math.round(c.getBoundingClientRect().height) };
    });
    ok(pool?.shown && pool.says.startsWith(`${LEAVES} notes made, ${SPENT} spent.`) && pool.inked > LEAVES && pool.height > 30 && pool.height < 90, `the pool's notes are drawn, the leader's counts under them (${JSON.stringify(pool)})`);
    await page.waitForFunction(() => /GPUs? prove/.test(document.querySelector('#tpg-part')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    const ways = await page.$$eval('#tpg-part .cl-part li', (ls) => ls.map((l) => [l.querySelector('b').textContent.trim(), l.querySelector('div span').textContent.trim()]));
    ok(ways.map((x) => x[0]).join('|') === 'Pay|Lead|Prove|Verify' && /^2 GPUs prove its blocks\./.test(ways[2]?.[1] || ''), `the ways to take part, one for each step of the path, the board's provers counted (${ways.map((x) => x[0]).join(', ')}: ${ways[2]?.[1]})`);
    // the path is a ring for each step; the chart is a staircase over the whole history, which the API gives a hundred blocks at a time
    // (one step in the page: a redraw between finding the ring and reading it would leave a node with no style)
    const ring = await page.evaluate(() => { const e = document.querySelector('#tpg-mid .cl-flow .cl-ic'), c = e && getComputedStyle(e); return c ? `${c.width} ${c.borderRadius}` : ''; });
    ok(ring === '40px 50%', `each step of the path is a ring (${ring})`);
    await page.waitForFunction(() => /^block 1 ·/.test(document.querySelector('#tpg-chain .cl-chart figcaption')?.textContent.trim() || ''), null, { timeout: 20000 }).catch(() => {});
    const line = await page.$eval('#tpg-chain .cl-plot .ln', (e) => e.getAttribute('d')).catch(() => '');
    ok(/^M[\d. ]+( H[\d.]+ V[\d.]+){10,}$/.test(line), `the share chart is a staircase: a share's worth holds until a block moves it (${line.slice(0, 60)})`);
    const pages = apiAsked.filter((x) => x.startsWith('/prover/rollup')).length;
    ok(/^block 1 ·/.test(await text(page, '#tpg-chain .cl-chart figcaption')) && pages === 3, `the chart runs from the first block, the API's pages taken until none is left (${pages} asked)`);
    ok((await page.$$('#tpg-chain .cl-plot .pt')).length === 1 && await page.$eval('#tpg-chain .cl-plot .pt', (e, last) => e.classList.contains('last') && e.dataset.i === last, String(SPAN - 1)), 'past forty blocks the chart marks only the newest');
    ok(/about 0\.017 TAC/.test(await text(page, '.tpg-fees')) && /0\.015 TAC/.test(await text(page, '.tpg-fees')), `the fee cards take the leader's terms (${(await text(page, '.tpg-fees')).slice(0, 120)})`);
    await shot('status');
    await signIn(page);
    await page.waitForFunction((want) => [...document.querySelectorAll('.tpg-leg li')].some((li) => /Tacit chain/.test(li.textContent) && li.querySelector('b')?.textContent.trim() === want), WANT_ROW, { timeout: 30000 })
      .then(() => ok(true, `the key's TAC on the Tacit chain, found from the note sealed to it (${WANT_BAL})`), async () => ok(false, `chain row: ${await text(page, '.tpg-leg')}`));
    await page.waitForFunction(() => /moves have not landed yet/.test(document.querySelector('#tpg-top')?.textContent || ''), null, { timeout: 30000 })
      .then(async () => ok(true, `what waits is said, with the tile's move that shows it (${await text(page, '#tpg-top .note')})`), async () => ok(false, `kept: ${await text(page, '#tpg-top')}`));
    // its account holds ETH, so a shield's gas is its own: one signature, then one transaction, no fee; the leader's way, for its fee in TAC, is a press away
    await page.waitForFunction(() => /\d in /.test(document.querySelector('#tcd-have')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => !!document.querySelector('#tcd-q [data-tcd-way]'), null, { timeout: 30000 }).catch(() => {});
    const own = await shieldQuote(page, '250'), picked = () => page.$eval('#tcd-q [data-tcd-way][aria-pressed="true"]', (b) => b.dataset.tcdWay).catch(() => null);
    ok(/^≈ 249\.\d+ TAC, private$/.test(own.Arrives) && own.Gas === 'your ETH, no fee' && (await picked()) === 'own' && (await text(page, '#tcd-have')) === '1,000 in this key’s address',
      `with ETH in the account a shield pays its own gas (${JSON.stringify(own)}, ${await text(page, '#tcd-have')})`);
    await page.click('#tcd-q [data-tcd-way="permit"]');
    await page.waitForFunction(() => document.querySelector('#tcd-q [data-tcd-way="permit"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 10000 }).catch(() => {});
    const relayed = await quoteRows(page);
    ok(relayed.Gas === '0.04 TAC' && (await picked()) === 'permit', `or the leader sends it in for its fee in TAC (${JSON.stringify(relayed)})`);
    await page.fill('#tcd-amt', '');
    await page.click('#tcd-t-receive');
    await page.waitForFunction(`/^tacit1/.test(${TACIT_ROW})`, null, { timeout: 30000 }).catch(() => {});
    const addr = await page.evaluate(TACIT_ROW).catch(() => '');
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
  // a phone and a desk, light and dark: nothing sideways. On the phone the card comes under the chain's newest blocks and over its path, its amount
  // on the first screen. These accounts hold no ETH: the leader sends a shield in for its fee, with nothing else to choose
  ETH_HELD = 0n;
  for (const viewport of PRESS === 'only' ? [] : [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    for (const colorScheme of ['light', 'dark']) {
      directory.clear();
      const { page, ctx, bad, shot } = await visit({ viewport, colorScheme });
      await page.waitForFunction(() => /^\d\.\d{5}$/.test(document.querySelector('#tpg-mid [data-k="px"]')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
      const before = await noSideways(page);
      if (viewport.width < 600 && colorScheme === 'light') {
        const at = await laid(page);
        ok(at.live.bottom <= at.card.top && at.card.bottom <= at.mid.top && at.amt.bottom <= at.screen, `on a phone the card is under the newest blocks and over the path, its amount on the first screen (${JSON.stringify(at)})`);
      }
      await signIn(page);
      if (colorScheme === 'light') {
        await page.waitForFunction(() => /\d in /.test(document.querySelector('#tcd-have')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
        const q = await shieldQuote(page, '250');
        ok(q.Gas === '0.04 TAC, no ETH needed' && !(await page.$('#tcd-q [data-tcd-way]')), `${viewport.width} px: with no ETH the leader sends a shield in for its fee (${JSON.stringify(q)})`);
        await page.fill('#tcd-amt', '');
      }
      await shot('page');
      ok(before && (await noSideways(page)), `${viewport.width} px ${colorScheme}: no sideways scroll, signed out or in`);
      ok(bad.length === 0, `${viewport.width} px ${colorScheme}: no errors (${bad.join(' | ')})`);
      await ctx.close();
    }
  }
  // a shield pressed, proved in the page. An account with ETH: one signature and one transaction of its own, TacitBlocks.sweepWithPermit with no
  // fee, the leader handed the spend with only its way back. An account with none: no transaction, the leader handed the permit with its fee.
  // Either way the permit is the account's, for the shield's inbox and no more than the deposit (and the fee); the card counts the steps and
  // the chain panel marks the block as the visitor's.
  const SWEEP_SEL = sel('sweepWithPermit(uint256,uint256,bytes32,bytes32,bytes32,bytes32,address,uint256,uint256,uint8,bytes32,bytes32)');
  const account = makeEvmAccount({ secp, keccak256: keccak_256, sha256 }).deriveEvmAccount(Buffer.from(KEY, 'hex'), 'mainnet').address.toLowerCase();
  const k32 = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
  const h32 = (...ws) => Buffer.from(keccak_256(Buffer.from(ws.map((x) => (typeof x === 'bigint' ? x.toString(16) : strip(x)).padStart(64, '0')).join(''), 'hex'))).toString('hex');
  // who signed an ERC-2612 permit of TAC for `spender` and `value` (the token's first nonce), from its v, r and s
  const permitSigner = ({ value, deadline, v, r, s }, spender) => {
    const domain = h32(k32('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), k32('Tacit Token'), k32('1'), 1n, TAC);
    const struct = h32(k32('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'), account, spender, BigInt(value), 0n, BigInt(deadline));
    const pub = secp.Signature.fromCompact(strip(r).padStart(64, '0') + strip(s).padStart(64, '0')).addRecoveryBit(Number(v) - 27).recoverPublicKey(keccak_256(Buffer.from('1901' + domain + struct, 'hex'))).toRawBytes(false);
    return '0x' + Buffer.from(keccak_256(pub.slice(1)).slice(12)).toString('hex');
  };
  const steps = (page) => page.$$eval('#tcd-flow li', (ls) => ls.map((l) => l.textContent.trim() + (l.classList.contains('done') ? ' ✓' : l.classList.contains('now') ? ' …' : '')).join(', '));
  for (const [held, way] of PRESS === 'no' ? [] : [[10n ** 16n, 'own'], [0n, 'permit']]) {
    ETH_HELD = held; pressAgain(); directory.clear();
    const { page, ctx, bad, shot } = await visit();
    await signIn(page);
    await page.waitForFunction(() => /\d in /.test(document.querySelector('#tcd-have')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    if (way === 'own') await page.waitForFunction(() => !!document.querySelector('#tcd-q [data-tcd-way]'), null, { timeout: 30000 }).catch(() => {});
    await shieldQuote(page, '250');
    await page.click('#tcd-go');
    const mine = await page.waitForFunction(() => document.querySelector('#tpg-live .cl-chain li.nx.me small')?.textContent === 'yours', null, { timeout: 300000 }).then(() => true, () => false);
    const under = await steps(page), note = await text(page, '#tpg-mid .cl-note');
    await shot(`press-${way}`);
    ok(mine && under === (way === 'own' ? 'Proved ✓, Signed ✓, Sent ✓, Block …, Ethereum' : 'Proved ✓, Signed ✓, Block …, Ethereum') && /^Yours is in the next block/.test(note),
      `${way === 'own' ? 'with ETH' : 'with no ETH'}: the card counts the shield's steps, and the block forming is marked as the visitor's (${under} | ${note.slice(0, 40)} | ${await text(page, '#tcd-st')})`);
    await page.waitForFunction(() => /Shielded\./.test(document.querySelector('#tcd-st')?.textContent || ''), null, { timeout: 120000 }).catch(() => {});
    await page.waitForFunction((h) => [...document.querySelectorAll('#tpg-live .cl-chain li.me b')].some((b) => b.textContent === `#${h}`), SPAN + 1, { timeout: 60000 }).catch(() => {});
    const done = await steps(page), marked = await page.$$eval('#tpg-live .cl-chain li.me b', (bs) => bs.map((b) => b.textContent).join());
    ok(/^Shielded\./.test(await text(page, '#tcd-st')) && done.split(', ').every((x) => x.endsWith(' ✓')) && done.endsWith('On Ethereum ✓') && marked === `#${SPAN + 1}`,
      `it lands: every step done, the block marked (${done} | ${marked} | ${await text(page, '#tcd-st')})`);
    const cd = press.raw[0] ? press.raw[0].slice(press.raw[0].indexOf(SWEEP_SEL) + 8) : '', arg = (i) => cd.slice(64 * i, 64 * i + 64);
    if (way === 'own') {
      const p = { value: 250n * UNIT * 10n ** 10n, deadline: BigInt('0x' + (arg(8) || '0')), v: Number(BigInt('0x' + (arg(9) || '0'))), r: arg(10), s: arg(11) };
      // (a type-2 transaction's fields, in order: … to (0x94, 20 bytes), value (0x80: none), data (0xb9, its length in two bytes: 388) …)
      const mineTx = press.raw.length === 1 && press.raw[0].startsWith('02') && press.raw[0].includes('94' + strip(BLOCKS) + '80' + 'b90184' + SWEEP_SEL);
      ok(mineTx && BigInt('0x' + arg(1)) === 250n * UNIT && '0x' + arg(6).slice(24) === account && BigInt('0x' + arg(7)) === 0n && permitSigner(p, INBOX) === account,
        `one transaction, the account's own: sweepWithPermit on the chain's contract for 250 TAC with no fee, its permit signed by the account for the shield's inbox and the deposit alone (${press.raw.length} sent)`);
      ok(press.spends.length === 2 && press.spends.every((x) => x.back && !x.permit), `the leader is handed the spend with its way back and no permit (${JSON.stringify(press.spends.map((x) => !!x.permit))})`);
    } else {
      const p = press.spends[0]?.permit;
      ok(press.raw.length === 0 && !!p && p.owner === account && p.fee === SWEEP_FEE && permitSigner({ value: 250n * UNIT * 10n ** 10n + BigInt(SWEEP_FEE), deadline: p.deadline, v: p.v, r: p.r, s: p.s }, INBOX) === account,
        `no transaction from the account: the leader is handed its permit, for the shield's inbox, the deposit and the leader's fee (${press.raw.length} sent, fee ${p?.fee})`);
      ok(press.spends.length === 2 && press.spends.every((x) => x.back && x.permit?.back === x.back), 'and the way back with it, each time it is handed over');
    }
    ok(bad.length === 0, `${way}: no errors (${bad.join(' | ')})`);
    await ctx.close();
  }
} finally {
  await browser.close();
  web.close();
}
console.log(`\n${n} ok, ${fails} failed`);
process.exit(fails ? 1 : 0);
