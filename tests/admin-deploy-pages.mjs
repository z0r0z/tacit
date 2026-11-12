#!/usr/bin/env node
// The admin deploy pages (dapp/admin/{proof-market,gas-relay,tacit-chain,token-pools}) and the signer of the /sats/ ETH panel, offline: a stub
// wallet (EIP-1193), a stub JSON-RPC node and one headless Chromium, nothing leaves the machine. What the pages are held to:
//   - a deploy goes out only after the wallet's chain is read again, and never on another chain
//   - Deploy is off while a deploy runs, so a second click is not a second wallet prompt
//   - nodes that do not answer read as 'not read', not as 'not deployed', and Deploy stays off
//   - a kit whose init code does not hash to the hash it lists is refused (the pages hash it themselves: their keccak-256 is checked here against noble's)
//   - token-pools refuses a node's answer that claims more results than it holds
//   - the /sats/ ETH signer reads the chain again after a switch, and again at send (a send comes after proving)
//   node tests/admin-deploy-pages.mjs      (PLAYWRIGHT=<path to playwright-core>)
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const require = createRequire(import.meta.url);
const load = (...ids) => { for (const id of ids) { try { return require(id); } catch {} } throw new Error('playwright-core not found: set PLAYWRIGHT=<path to playwright-core>'); };
const { chromium } = load(process.env.PLAYWRIGHT, 'playwright-core', '/Users/z/zFi/node_modules/playwright-core');
const { keccak_256 } = await import('@noble/hashes/sha3');
const { randomBytes } = await import('node:crypto');

const DAPP = join(new URL('../', import.meta.url).pathname, 'dapp');
const ORIGIN = 'https://tacit.test';
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.css': 'text/css' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readText = (p) => readFileSync(join(DAPP, p), 'utf8');
const scriptOf = (html) => html.match(/<script>([\s\S]*?)<\/script>/)[1];
let n = 0, fails = 0;
const ok = (c, s) => { if (c) { n++; console.log('  ok   ' + s); } else { fails++; console.log('FAIL   ' + s); } };

// ── the pages' keccak-256 against noble's ──
console.log('\nkeccak-256 in the deploy pages');
for (const page of ['proof-market', 'gas-relay', 'tacit-chain']) {
  const html = readText(`admin/${page}/index.html`), a = html.indexOf('function keccak256(msg)'), b = html.indexOf('const hashOfCode', a);
  const keccak256 = new Function(`${html.slice(a, b)}\nreturn keccak256;`)();
  const lens = [0, 1, 31, 32, 33, 134, 135, 136, 137, 271, 272, 273, 20615, ...Array.from({ length: 24 }, () => Math.floor(Math.random() * 600))];
  const bad = lens.filter((len) => { const m = len ? randomBytes(len) : new Uint8Array(0); return keccak256(m) !== Buffer.from(keccak_256(m)).toString('hex'); });
  ok(bad.length === 0, `${page}: ${lens.length} inputs, from empty to 20 KB, across the 136-byte block edge${bad.length ? ' (bad lengths ' + bad + ')' : ''}`);
}
console.log('\nthe pages\' CSP hashes');
for (const page of ['proof-market', 'gas-relay', 'tacit-chain', 'token-pools']) {
  const html = readText(`admin/${page}/index.html`), { createHash } = await import('node:crypto');
  const want = 'sha256-' + createHash('sha256').update(scriptOf(html)).digest('base64');
  ok(html.includes(`script-src '${want}'`), `${page}: the CSP pins the script as it is (run node build/build.mjs if not)`);
}
ok(scriptOf(readText('admin/tacit-chain/index.src.html')) === scriptOf(readText('admin/tacit-chain/index.html')), 'tacit-chain: index.html carries the script of index.src.html');

const browser = await chromium.launch();

// one page of the site under a fake origin, with a stub wallet and a stub node; `run` drives it
async function open(pagePath, opts, run) {
  const kit0 = existsSync(join(DAPP, pagePath, 'kit.json')) ? JSON.parse(readText(`${pagePath}/kit.json`)) : null;
  const kit = kit0 && opts.kit ? opts.kit(structuredClone(kit0)) : kit0;
  const hub = pagePath.endsWith('token-pools') ? JSON.parse(readText(`${pagePath}/hub.json`)).find((h) => h.chainId === 1) : null;
  const account = kit0?.deployer || '0x1111111111111111111111111111111111111111';
  const expected = hub ? hub.expected.toLowerCase() : (kit0.steps ? kit0.steps[0].expected : kit0.expected).toLowerCase();
  const to = hub ? hub.to.toLowerCase() : kit0.factory.toLowerCase();
  const ctx = await browser.newContext(), page = await ctx.newPage(), errors = [], st = { armed: false, polls: 0 };
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(({ account }) => {
    window.__w = { chain: '0x1', account, sent: [] };
    window.ethereum = { request: async ({ method }) => {
      if (method === 'eth_requestAccounts') return [window.__w.account];
      if (method === 'eth_chainId') return window.__w.chain;
      if (method === 'eth_sendTransaction') { window.__w.sent.push({ chain: window.__w.chain }); window.__w.landed = true; return '0x' + 'ab'.repeat(32); }
      throw Object.assign(new Error('unsupported ' + method), { code: -32601 });
    }, on() {} };
  }, { account });
  await ctx.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.origin === ORIGIN) {
      if (kit && u.pathname === `/${pagePath}/kit.json`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(kit) });
      let p = join(DAPP, decodeURIComponent(u.pathname)); if (u.pathname.endsWith('/')) p = join(p, 'index.html');
      if (existsSync(p) && statSync(p).isFile()) return route.fulfill({ contentType: TYPES[extname(p)] || 'application/octet-stream', body: readFileSync(p) });
      return route.fulfill({ status: 200, contentType: 'text/plain', body: '' }); // fonts, favicon
    }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (opts.rpcDown) return route.abort('failed');
    const q = JSON.parse(req.postData() || '{}'), reply = (result) => route.fulfill({ headers: CORS, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) });
    switch (q.method) {
      case 'eth_getCode': {
        if (st.armed) { st.armed = false; await page.evaluate(() => { window.__w.chain = '0x2105'; }); } // the wallet moves networks while the page waits, with no event
        const landed = await page.evaluate(() => !!window.__w.landed).catch(() => false);
        return reply(landed ? '0x6080' : '0x'); // the code is there once the send has landed
      }
      case 'eth_call': return reply('0x' + '0'.repeat(24) + (String(q.params[0]?.to).toLowerCase() === to ? expected.slice(2) : '0'.repeat(40)));
      case 'eth_estimateGas': if (opts.flipOnEstimate) await page.evaluate(() => { window.__w.chain = '0x2105'; }); return reply('0x2dc6c0');
      case 'eth_gasPrice': return reply('0x3b9aca00');
      case 'eth_getTransactionReceipt': st.polls++; return reply(opts.slowReceipt && st.polls <= 2 ? null : { status: '0x1', blockNumber: '0x1', gasUsed: '0x1' });
      default: return reply(null);
    }
  });
  await page.goto(`${ORIGIN}/${pagePath}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.st').length >= 1 && (document.querySelectorAll('#rows tr').length === 0 || document.querySelectorAll('#rows .st').length >= 4), null, { timeout: 15000 });
  await sleep(250);
  const view = () => page.evaluate(() => {
    const b = document.querySelector('button.btn.go');
    return { label: document.querySelector('.st')?.textContent, go: b ? { disabled: b.disabled, text: b.textContent } : null, text: document.body.innerText, readAgain: [...document.querySelectorAll('button')].some((x) => /Read again/.test(x.textContent)) };
  });
  const connect = async () => { await page.click('#connect'); await page.waitForSelector('#who:not([hidden])'); await sleep(150); };
  await run({ page, st, view, connect, sent: () => page.evaluate(() => window.__w.sent) });
  ok(errors.length === 0, `no page errors, no CSP refusals${errors.length ? ': ' + errors.slice(0, 2).join(' | ').slice(0, 160) : ''}`);
  await ctx.close();
}
const scenario = (pagePath, name, opts, run) => { console.log(`\n${pagePath} · ${name}`); return open(pagePath, opts, run); };

for (const pagePath of ['admin/proof-market', 'admin/gas-relay', 'admin/tacit-chain']) {
  await scenario(pagePath, 'a normal deploy: one send, on the kit chain', {}, async ({ view, connect, page, sent }) => {
    let v = await view(); ok(v.label === 'not deployed', `reads 'not deployed' (${v.label})`);
    await connect(); v = await view(); ok(v.go && !v.go.disabled, 'Deploy is on once the wallet is on the kit chain');
    await page.click('button.btn.go'); await page.waitForFunction(() => window.__w.sent.length > 0, null, { timeout: 8000 }); await sleep(300);
    const s = await sent(); ok(s.length === 1 && s[0].chain === '0x1', `one transaction, sent on chain 0x1 (${JSON.stringify(s)})`);
  });
  await scenario(pagePath, 'the wallet changes network while the page waits', { flipOnEstimate: true }, async ({ view, connect, page, sent }) => {
    await connect(); await page.click('button.btn.go'); await sleep(1500);
    const s = await sent(), v = await view();
    ok(s.length === 0, 'nothing is sent'); ok(/no longer on Ethereum/.test(v.text), 'the page says why');
  });
  await scenario(pagePath, 'a second click while the first is running', {}, async ({ page, connect, sent }) => {
    await connect();
    await page.evaluate(() => { const b = document.querySelector('button.btn.go'); b.click(); b.click(); });
    await sleep(1500); const s = await sent(); ok(s.length === 1, `one wallet prompt (${s.length})`);
  });
  await scenario(pagePath, 'the button while the deploy runs, and once it has landed', { slowReceipt: true }, async ({ page, connect, view }) => {
    await connect(); await page.click('button.btn.go');
    await page.waitForFunction(() => window.__w.sent.length > 0, null, { timeout: 8000 });
    let v = await view(); ok(v.go && v.go.disabled && /Deploying/.test(v.go.text), "Deploy is off and says 'Deploying…' while it runs");
    await page.waitForFunction(() => /^deployed/.test(document.querySelector('.st')?.textContent || ''), null, { timeout: 20000 });
    await sleep(300); v = await view(); ok(v.go && v.go.disabled, `once it has landed the page reads '${v.label}' and Deploy is off`);
  });
  await scenario(pagePath, 'no node answers', { rpcDown: true }, async ({ view, connect }) => {
    await connect(); const v = await view();
    ok(v.label === 'not read', `reads 'not read' (${v.label})`); ok(v.go && v.go.disabled, 'Deploy is off'); ok(v.readAgain, "offers 'Read again'");
  });
  await scenario(pagePath, 'a kit whose init code was changed', { kit: (k) => { const s = k.steps ? k.steps[0] : k; s.initCode = s.initCode.slice(0, -1) + (s.initCode.slice(-1) === '0' ? '1' : '0'); return k; } }, async ({ view, connect, sent }) => {
    await connect(); const v = await view();
    ok(v.go && v.go.disabled, 'Deploy is off'); ok(/init code hashes to/.test(v.text), 'the page names the mismatch'); ok((await sent()).length === 0, 'nothing is sent');
  });
}

// ── token-pools ──
{
  console.log('\nadmin/token-pools · madeBy() on valid and on hostile answers');
  const html = readText('admin/token-pools/index.html'), a = html.indexOf('function madeBy(tx, ret) {'), b = html.indexOf('\n}\n', a) + 3;
  const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
  const madeBy = new Function('MULTICALL3', 'lc', 'strip', `${html.slice(a, b)}\nreturn madeBy;`)(MULTICALL3, (s) => String(s || '').toLowerCase(), (h) => String(h || '').replace(/^0x/, ''));
  const w = (v) => BigInt(v).toString(16).padStart(64, '0'), tuple = (ad) => w(1) + w(0x40) + w(32) + '0'.repeat(24) + ad, A = 'aa'.repeat(20), B = 'bb'.repeat(20);
  const got = madeBy({ to: MULTICALL3 }, '0x' + w(0x20) + w(2) + w(0x40) + w(0xc0) + tuple(A) + tuple(B));
  ok(got.length === 2 && got[0] === '0x' + A && got[1] === '0x' + B, 'a Multicall3 answer with two results reads as two addresses');
  ok(madeBy({ to: '0x' + 'cc'.repeat(20) }, '0x' + '0'.repeat(24) + A)[0] === '0x' + A, 'a plain CreateX answer reads as one address');
  const refused = (data) => { const t0 = performance.now(); try { madeBy({ to: MULTICALL3 }, data); return false; } catch { return performance.now() - t0 < 50; } };
  ok(refused('0x' + w(0x20) + w(2n ** 40n) + w(0x40)), 'a count of 2^40 is refused at once');
  ok(refused('0x' + w(0x20) + w(2) + w(0x40)), 'a count the answer is too short to hold is refused');
  ok(refused('0x' + w(0x20) + w(33) + '0'.repeat(64 * 40)), 'a count above what a kit can make (33) is refused even when the data is long enough');
}
await scenario('admin/token-pools', 'the page loads and draws its rows', {}, async ({ page }) => {
  const rows = await page.evaluate(() => document.querySelectorAll('#rows tr').length); ok(rows >= 4, `${rows} rows drawn`);
});
await scenario('admin/token-pools', 'check and send on the Ethereum hub row', {}, async ({ page, sent }) => {
  await page.click('#connect'); await page.waitForSelector('#who:not([hidden])'); await sleep(150);
  await page.click('#rows tr:first-child button'); await page.waitForFunction(() => /Send/.test(document.querySelector('#rows tr button')?.textContent || ''), null, { timeout: 10000 });
  await page.click('#rows tr:first-child button'); await page.waitForFunction(() => window.__w.sent.length > 0, null, { timeout: 10000 }); await sleep(4500);
  const s = await sent(); ok(s.length === 1 && s[0].chain === '0x1', `one transaction, on chain 0x1 (${JSON.stringify(s)})`);
  ok(/Deployed/.test(await page.evaluate(() => document.querySelector('#rows tr').innerText)), 'the row reads as deployed once it landed');
});
await scenario('admin/token-pools', 'the wallet changes network between the state read and the send', {}, async ({ page, st, sent }) => {
  await page.click('#connect'); await page.waitForSelector('#who:not([hidden])'); await sleep(150);
  await page.click('#rows tr:first-child button'); await page.waitForFunction(() => /Send/.test(document.querySelector('#rows tr button')?.textContent || ''), null, { timeout: 10000 });
  st.armed = true; await page.click('#rows tr:first-child button'); await sleep(2500);
  ok((await sent()).length === 0, 'nothing is sent'); ok(/wallet moved to chain/.test(await page.evaluate(() => document.querySelector('#rows tr').innerText)), 'the row says the wallet moved');
});
await browser.close();

// ── the /sats/ ETH panel's signer, as the file has it, against a stub wallet ──
{
  console.log('\nsats/eth.js · browserSigner()');
  const src = readText('sats/eth.js'), a = src.indexOf('async function onThisChain(eth) {'), b = src.indexOf('\n  // ETH at the private ETH address', a);
  const chain = { chainId: 1, name: 'Ethereum' };
  const signerOf = (w) => new Function('chain', 'ctx', 'guardProvider', `${src.slice(a, b)}\nreturn browserSigner;`)(chain, { ethProvider: () => w }, (p) => p);
  const wallet = ({ chain: c0 = '0x1', switches = true } = {}) => {
    const w = { chain: c0, calls: [], sent: [] };
    w.request = async ({ method, params }) => {
      w.calls.push(method);
      if (method === 'eth_requestAccounts') return ['0xabc'];
      if (method === 'eth_chainId') return w.chain;
      if (method === 'wallet_switchEthereumChain') { if (switches) w.chain = params[0].chainId; return null; }
      if (method === 'eth_sendTransaction') { w.sent.push({ chain: w.chain }); return '0xhash'; }
      throw new Error('unsupported ' + method);
    };
    return w;
  };
  const tx = { to: '0xpool', data: '0x', value: 0n };
  { const w = wallet(), s = await signerOf(w)(), before = w.calls.filter((m) => m === 'eth_chainId').length; await s.send(tx);
    ok(w.sent.length === 1 && w.sent[0].chain === '0x1', 'on the right chain: one transaction, on chain 0x1');
    ok(w.calls.filter((m) => m === 'eth_chainId').length - before === 1, 'a send costs one extra eth_chainId read, which the wallet answers locally'); }
  { const w = wallet({ chain: '0x2105' }), s = await signerOf(w)(); await s.send(tx); ok(w.sent.length === 1 && w.sent[0].chain === '0x1', 'wrong chain at connect, the switch works: sent on chain 0x1'); }
  { const w = wallet({ chain: '0x2105', switches: false }); let err = null; try { await signerOf(w)(); } catch (e) { err = e; }
    ok(err && /Switch your wallet to Ethereum/.test(err.message) && w.sent.length === 0, 'a wallet that answers the switch without switching is refused'); }
  { const w = wallet({ switches: false }), s = await signerOf(w)(); w.chain = '0x2105'; let err = null; try { await s.send(tx); } catch (e) { err = e; }
    ok(err && /Switch your wallet to Ethereum/.test(err.message) && w.sent.length === 0, 'a wallet that moved after connecting and will not move back: refused at send time, nothing sent'); }
  { const w = wallet(), s = await signerOf(w)(); w.chain = '0x2105'; await s.send(tx); ok(w.sent.length === 1 && w.sent[0].chain === '0x1', 'a wallet that moved after connecting and moves back when asked: sent on chain 0x1'); }
}

console.log(fails ? `\nFAILED: ${fails} of ${n + fails}` : `\nall ${n} checks hold`);
process.exit(fails ? 1 : 0);
