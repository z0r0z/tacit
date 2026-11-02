#!/usr/bin/env node
// How long the swap card takes to show a price, in a real browser, and what it asks of the nodes on the way: the page's files are served from a dapp
// directory (the page keeps its tacit.finance origin, so CORS and CSP are as live), the clock starts when the tile is drawn (the card's first quote starts
// then), and every fetch is listed with its start and end.
//
//   node tools/swap-trace.mjs [url] [--local dapp] [--runs N] [--base dir-of-another-dapp] [--public] [--wallet ms] [--fault host=how ...] [--cpu N] [--rtt ms] [--quiet]
//
//   url        default https://tacit.finance/?to=DAI&amt=0.01&private=to   (without `private=to` the card opens on Swap privately anyway for ETH into a token; --public turns that off)
//   --local    the dapp directory to serve (default ./dapp); without it the live site is traced
//   --base     a second dapp directory (e.g. `git archive origin/main dapp | tar -x -C /tmp/base`): the two are run alternately, --runs times each, and compared
//   --wallet   a connected wallet that answers eth_accounts after this many ms (a stand-in for an extension), on chain 1
//   --fault    host=how for host in publicnode drpc mevblocker blast tenderly onerpc keeper api and how in hang | reset | 429 | slow:ms | flake:p (a heavy
//              scan's first read answered with a gas-cap error with probability p)
//   --cpu/--rtt  4x CPU throttling, added round trip in ms
//   PLAYWRIGHT   path to playwright-core when it is not installed here
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1] ?? true; };
const url = args.find((a) => a.startsWith('http')) || 'https://tacit.finance/?to=DAI&amt=0.01&private=to';
const local = opt('--local'), base = opt('--base'), runs = Number(opt('--runs', base ? 6 : 1)), quiet = args.includes('--quiet'), pub = args.includes('--public');
const walletMs = opt('--wallet'), cpu = Number(opt('--cpu', 1)), rtt = Number(opt('--rtt', 0)), limit = Number(opt('--timeout', 25000));
const faults = args.filter((a, i) => args[i - 1] === '--fault');
const HOSTS = { publicnode: 'ethereum-rpc.publicnode.com', drpc: 'eth.drpc.org', mevblocker: 'rpc.mevblocker.io', blast: 'eth-mainnet.public.blastapi.io', tenderly: 'mainnet.gateway.tenderly.co', onerpc: '1rpc.io', keeper: 'tacit-evm-pool-keepers.onrender.com', api: 'api.tacit.finance' };
const MIME = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const stat = (xs, unit = ' ms') => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); if (!v.length) return 'n/a'; const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))]; return `${q(0.5)}${unit} (p90 ${q(0.9)}, n=${v.length}/${xs.length})`; };

// ── the parent of a comparison: runs this file once per side, alternately ──
if (base) {
  const one = (dir) => {
    const r = spawnSync(process.execPath, [process.argv[1], url, '--local', dir, '--quiet', '--timeout', String(limit), ...args.filter((a, i) => !['--base', '--runs', '--local'].includes(a) && !['--base', '--runs', '--local'].includes(args[i - 1]) && a !== url && a !== '--quiet')], { encoding: 'utf8', timeout: 180000 });
    const out = (r.stdout || '') + (r.stderr || '');
    let m = {}; try { m = JSON.parse(/marks: (\{.*\})/.exec(out)?.[1] || '{}'); } catch { /* none */ }
    const from = (k) => (m[k] != null && m.tile != null ? m[k] - m.tile : null);
    return { price: from('price'), relay: from('relay'), scans: Number(/heavy zQuoter scans: (\d+)/.exec(out)?.[1] ?? NaN), reqs: Number(/(\d+) fetch\/POST requests/.exec(out)?.[1] ?? NaN), noRoute: /"No route"/.test(out) };
  };
  const A = [], B = [];
  for (let i = 0; i < runs; i++) { A.push(one(path.resolve(base))); B.push(one(path.resolve(local || 'dapp'))); }
  const line = (tag, R) => `${tag}  first price ${stat(R.map((x) => x.price))}  relay fee ${stat(R.map((x) => x.relay))}  heavy scans ${stat(R.map((x) => x.scans), '')}  requests ${stat(R.map((x) => x.reqs), '')}${R.some((x) => x.noRoute) ? `  NO ROUTE in ${R.filter((x) => x.noRoute).length}` : ''}`;
  console.log(`${url}\n${line('base', A)}\n${line('new ', B)}`);
  process.exit(0);
}

// ── one trace ──
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const root = local ? path.resolve(local) : null;
const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);
const label = (req) => {
  if (req.method() !== 'POST') return 'GET';
  try {
    const m = JSON.parse(req.postData() || '{}'), p = m.params?.[0];
    return m.method === 'eth_call' && p ? `eth_call to=${short(p.to)} ${(p.data || '').slice(0, 10)}${p.gas ? ` gas=${p.gas}` : ''}` : m.method || 'POST';
  } catch { return 'POST'; }
};

async function trace() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  const t0 = { v: Date.now() }, rows = [], by = new Map(), logs = [];
  page.on('request', (r) => { const x = { t: Date.now() - t0.v, url: r.url(), method: r.method(), label: label(r) }; by.set(r, x); rows.push(x); });
  page.on('response', (r) => { const x = by.get(r.request()); if (x) x.status = r.status(); });
  page.on('requestfinished', (r) => { const x = by.get(r); if (x) x.end = Date.now() - t0.v; });
  page.on('requestfailed', (r) => { const x = by.get(r); if (x) { x.end = Date.now() - t0.v; x.failed = r.failure()?.errorText; } });
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/Failed to load resource/.test(m.text())) logs.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => logs.push(String(e).slice(0, 200)));
  if (pub) await page.addInitScript(() => { try { localStorage.setItem('tacit-swap-hop', 'public'); } catch { /* storage is a convenience */ } });
  if (walletMs != null) {
    await page.addInitScript(({ delay }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const provider = { isMetaMask: true, chainId: '0x1', async request({ method }) { await sleep(delay); if (method === 'eth_accounts' || method === 'eth_requestAccounts') return ['0x000000000000000000000000000000000000dEaD']; if (method === 'eth_chainId') return '0x1'; throw Object.assign(new Error('unsupported'), { code: 4200 }); }, on() {}, removeListener() {} };
      const info = { uuid: '350670db-19fa-4704-a166-e52e178b59d2', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', rdns: 'io.metamask' };
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
      window.addEventListener('eip6963:requestProvider', announce);
      window.ethereum = provider;
      try { localStorage.setItem('tacit-trade-wallet', 'io.metamask'); } catch { /* storage is a convenience */ }
      announce();
    }, { delay: Number(walletMs) || 0 });
  }
  if (cpu > 1 || rtt > 0) {
    const cdp = await ctx.newCDPSession(page);
    if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    if (rtt > 0) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: -1, uploadThroughput: -1 });
  }
  for (const f of faults) {
    const [name, how] = f.split('=');
    if (!HOSTS[name]) throw new Error(`--fault host? ${name}`);
    await page.route(`**://${HOSTS[name]}/**`, async (route) => {
      if (how === 'hang') return;
      if (how === 'reset') return route.abort('connectionreset');
      if (how === '429') return route.fulfill({ status: 429, body: 'rate limited' });
      if (how.startsWith('slow:')) { await new Promise((r) => setTimeout(r, Number(how.slice(5)))); return route.fallback().catch(() => {}); }
      if (how.startsWith('flake:')) {
        const b = route.request().postData() || '';
        if (/11E1A300/i.test(b) && /e453166e/.test(b) && Math.random() < Number(how.slice(6))) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'out of gas: gas required exceeds: 50000000' } }) });
      }
      return route.fallback();
    });
  }
  if (root) {
    await page.route('https://tacit.finance/**', async (route) => {
      let p = decodeURIComponent(new URL(route.request().url()).pathname);
      if (p.endsWith('/')) p += 'index.html';
      let f = path.join(root, p);
      if (!f.startsWith(root)) return route.abort();
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' } });
    });
  }
  t0.v = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  const marks = {};
  const probe = () => page.evaluate(() => {
    const T = document.body ? document.body.innerText : '';
    return { tile: !!document.querySelector('#go'), price: /\bPrice\b[^\n]*\n[^\n]*=/.test(T) || /Price\s*\n?\s*1\s+\S+\s*=\s*[\d,.]+/.test(T), relay: /Relay fee\s*\n?\s*[\d.]+\s*ETH/.test(T), net: /Network fee\s*\n?\s*[\d.<]+/.test(T), go: document.querySelector('#go')?.innerText || '' };
  }).catch(() => null);
  while (Date.now() - t0.v < limit) {
    const s = await probe(), t = Date.now() - t0.v;
    if (s) {
      if (s.tile && marks.tile == null) marks.tile = t;
      if (s.price && marks.price == null) marks.price = t;
      if (s.relay && marks.relay == null) marks.relay = t;
      if (s.net && marks.net == null) marks.net = t;
      marks.button = s.go.replace(/\s+/g, ' ').trim();
      if (marks.price != null && (marks.relay != null || marks.net != null) && t > 300) break;
    }
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(500);
  await browser.close();
  return { rows, marks, logs };
}

const { rows, marks, logs } = await trace();
const data = rows.filter((r) => r.method === 'POST' || /onrender|api\./.test(r.url)), heavy = data.filter((r) => /gas=0x11E1A300/.test(r.label));
const hostOf = (r) => new URL(r.url).host;
const by = {}; for (const r of heavy) by[hostOf(r)] = (by[hostOf(r)] || 0) + 1;
console.log(`price ${marks.price != null && marks.tile != null ? marks.price - marks.tile : 'n/a'} ms after the tile was drawn   marks: ${JSON.stringify(marks)}`);
if (!quiet) for (const r of data.sort((a, b) => a.t - b.t)) console.log(`${String(r.t).padStart(6)} → ${String(r.end ?? '?').padStart(6)}  ${String(r.status ?? r.failed ?? '').padEnd(8)} ${hostOf(r)}  ${r.label}`);
console.log(`heavy zQuoter scans: ${heavy.length} requests ${JSON.stringify(by)}; ${data.length} fetch/POST requests in all`);
if (logs.length) console.log(`console: ${logs.slice(0, 5).join(' | ')}`);
