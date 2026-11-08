#!/usr/bin/env node
// The pages that carry an import map (build/build.mjs: `<!-- importmap:begin -->` in the head). Statically, each map's tokens are the first eight hex
// digits of their files' sha-256, every preload link names the URL the map sends its module to, and the map's hash is pinned in the page's CSP. In a
// real browser, the page loads with its modules under those URLs, no module is fetched under two URLs, the CSP refuses nothing, and a repeat visit
// (with the service worker, dapp/sw.js) asks the server for none of them.
//
//   PLAYWRIGHT=/Users/z/zFi/node_modules/playwright-core node tests/importmap-pages.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
// every page that carries the block (the shielded-TAC page did until its pool moved to the front page, which is CSP-pinned and takes none)
const PAGES = ['index.html', ...readdirSync(DAPP, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => [`${d.name}/index.html`, ...readdirSync(join(DAPP, d.name), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${d.name}/${e.name}/index.html`)])]
  .filter((rel) => existsSync(join(DAPP, rel)) && readFileSync(join(DAPP, rel), 'utf8').includes('<!-- importmap:begin -->'));
if (!PAGES.length) { console.log('no page carries an import map'); process.exit(0); }
const PORT = 29000 + Math.floor(Math.random() * 900);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
let hits = new Map();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.set(u.pathname + u.search, (hits.get(u.pathname + u.search) || 0) + 1);
  let f = join(DAPP, decodeURIComponent(u.pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=0' });
  res.end(readFileSync(f));
}).listen(PORT);

let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha8 = (path) => createHash('sha256').update(readFileSync(join(DAPP, path))).digest('hex').slice(0, 8);
const isModule = (k) => /\.js(\?|$)/.test(k.split('?')[0] + (k.includes('?') ? '?' : ''));

const browser = await chromium.launch();
try {
  for (const rel of PAGES) {
    const html = readFileSync(join(DAPP, rel), 'utf8');
    const mapText = (/<script type="importmap">([\s\S]*?)<\/script>/.exec(html) || [])[1];
    ok(!!mapText, `${rel}: has an import map`);
    const imports = JSON.parse(mapText).imports;
    const wrong = Object.entries(imports).filter(([k, v]) => v !== `${k}?cb=${sha8(k)}`);
    ok(Object.keys(imports).length > 20 && wrong.length === 0, `${rel}: ${Object.keys(imports).length} modules, each sent to its own content token (${wrong.length} wrong${wrong[0] ? ': ' + wrong[0][0] : ''})`);
    const digest = 'sha256-' + createHash('sha256').update(mapText, 'utf8').digest('base64');
    ok(html.includes(`'${digest}'`) && html.indexOf('importmap:begin') < html.indexOf('preload:begin'), `${rel}: its hash is pinned in script-src, and it comes before the preload links`);
    const pre = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
    const stray = pre.filter((u) => !u.includes('?cb=') && imports[u]);
    ok(pre.length > 20 && stray.length === 0, `${rel}: ${pre.length} preload links, none naming a module's bare URL (${stray.length})`);

    // in a browser, with the service worker (a test asks for it)
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await ctx.addInitScript(() => { window.__tacitSw = true; });
    await ctx.route('https://**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    const page = await ctx.newPage();
    const errors = [], csp = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (/Content Security Policy|import map|violates/i.test(m.text())) csp.push(m.text().slice(0, 160)); });
    hits = new Map();
    await page.goto(`http://127.0.0.1:${PORT}/${rel.replace(/index\.html$/, '')}`, { waitUntil: 'load' });
    await sleep(2500);
    const asked = [...hits.keys()].filter((k) => /\.js(\?|$)/.test(k));
    ok(csp.length === 0, `${rel}: the CSP and the import map raise no violation${csp[0] ? ' (' + csp[0] + ')' : ''}`);
    const moduleErrors = errors.filter((e) => /export named|dynamically imported|Failed to fetch|Cannot use import|SyntaxError/i.test(e));
    ok(moduleErrors.length === 0, `${rel}: every module loads (${moduleErrors[0] || 'no module errors'})`);
    const byPath = new Map();
    for (const k of asked) { const p = k.split('?')[0]; byPath.set(p, (byPath.get(p) || new Set()).add(k)); }
    const twice = [...byPath].filter(([, urls]) => urls.size > 1).map(([p]) => p);
    ok(twice.length === 0, `${rel}: no module is fetched under two URLs (${twice.slice(0, 3).join(', ') || 'none'})`);
    const bare = asked.filter((k) => !k.includes('?') && imports[k]);
    ok(bare.length === 0, `${rel}: no mapped module is fetched at its bare URL (${bare.slice(0, 3).join(', ') || 'none'})`);
    ok(asked.length > 30, `${rel}: the page's graph came through the map (${asked.length} scripts)`);

    // the worker keeps the versioned files; the repeat visit asks for none of them
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 }).catch(() => {});
    await page.reload({ waitUntil: 'load' }); await sleep(2500);
    hits = new Map();
    await page.reload({ waitUntil: 'load' }); await sleep(2500);
    const again = [...hits.keys()].filter((k) => /\.js\?cb=[0-9a-f]{8}$/.test(k));
    const total = [...hits.keys()].filter((k) => /\.js(\?|$)/.test(k));
    ok(again.length === 0, `${rel}: a repeat visit asks the server for no versioned script (${again.length} of ${total.length} scripts reached it${again.length ? ': ' + again.slice(0, 4).join(', ') : ''})`);
    await ctx.close();
  }
} catch (e) {
  fails++; console.log('FAIL   ' + (e.stack || e));
}
await browser.close(); server.close();
console.log(`\n${n} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
