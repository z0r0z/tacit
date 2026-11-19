// The large-pool cards of the Pay page's Deposit tab (dapp/fixed-pool-pay.js) in a real browser, on a stand-in page that
// gives them what the Pay page gives them: a node, a wallet, the user's deposit address, the amount field and the busy
// wrapper. An amount splits into whole notes; the notes are deposited, kept (without their secrets), found again, moved
// into the Tacit balance with the gas paid from the note (real prover, in a worker; stand-in bundler and chunk cache), and
// withdrawn to an address that is checked first.
//   PLAYWRIGHT=<path to playwright-core> node tests/fixed-pool-pay-cards.mjs        (SHOTS=<dir> saves screenshots)

import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { keccak_256, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
const { FIXED_POOLS, noteString, parseNoteString, commitmentBytes32 } = await import('../dapp/fixed-pool-notes.js');

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const sel = (x) => bytesToHex(keccak_256(new TextEncoder().encode(x)).slice(0, 4));
const POOLS = FIXED_POOLS[1];
const ONE = POOLS[1];
const BOX = '0x00000000000000000000000000000000000b0b01';
const WALLET = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

// the stand-in page: the cards, and the few things the Pay page would give them
const HARNESS = `<!doctype html><meta charset="utf-8"><title>cards</title>
<style>body{font:14px monospace;max-width:520px;margin:20px auto} .btn{display:block;width:100%;padding:10px;margin-top:8px} .kv{display:flex;justify-content:space-between} .note{color:#555} .link{background:none;border:0;text-decoration:underline;cursor:pointer}</style>
<input id="amt" value="" placeholder="amount"><div id="host"></div><div id="main"></div><div id="notes"></div><div id="wd"></div><div id="in"></div><button id="wd-go" class="btn">exit</button><div id="status" role="status"></div>
<script type="module">
import { attach, attachWithdraw, attachIntake } from '/fixed-pool-pay.js?cb=00000000';
const SEL = ${JSON.stringify({ den: sel('denomination()'), com: sel('commitments(bytes32)'), spent: sel('isSpent(bytes32)'), root: sel('isKnownRoot(bytes32)') })};
const pools = new Map(${JSON.stringify(POOLS.map((p) => [p.address.toLowerCase(), { d: p.denomination.toString() }]))}.map(([a, v]) => [a, { d: BigInt(v.d), seen: new Set() }]));
window.__log = { signs: 0, sends: 0, accountRequests: 0, busy: 0 };
window.__spentAll = false;
window.__rest = []; window.__restFail = false; window.__spentN = 0; window.__order = null;
const hex = (n, w) => BigInt(n).toString(16).padStart(w, '0');
const read = async () => async (method, params = []) => {
  switch (method) {
    case 'eth_chainId': return '0x1';
    case 'eth_blockNumber': return '0x3e8';
    case 'eth_getLogs': return [];
    case 'eth_getCode': return '0x6080';
    case 'eth_getBalance': return '0x' + hex(10n ** 21n, 1);
    case 'eth_getTransactionReceipt': return { status: '0x1' };
    case 'eth_feeHistory': return { baseFeePerGas: ['0x5f5e100', '0x5f5e100', '0x5f5e100'], reward: [['0x5f5e100'], ['0x5f5e100']] };
    case 'eth_call': {
      const { to, data } = params[0], p = pools.get(to.toLowerCase());
      if (!p) return '0x';
      const s = data.slice(2, 10), arg = data.slice(10);
      if (s === SEL.den) return '0x' + hex(p.d, 64);
      if (s === SEL.com) { if (window.__failReads > 0) { window.__failReads--; throw new Error('rpc busy'); } return '0x' + (p.seen.has(arg) ? '1' : '0').padStart(64, '0'); }
      if (s === SEL.spent) return '0x' + ((window.__order ? window.__order.slice(0, window.__spentN).includes('0x' + arg) : window.__spentAll) ? '1' : '0').padStart(64, '0');
      if (s === SEL.root) return '0x' + '1'.padStart(64, '0');
      throw new Error('call ' + s);
    }
    default: throw new Error('unexpected read ' + method);
  }
};
const wallet = { async request({ method, params = [] }) {
  if (method === 'eth_signTypedData_v4') { window.__log.signs++; const n = Number(JSON.parse(params[1]).message.nonce); (window.__log.nonces ||= []).push(n); return '0x' + hex(0x1111 + n, 64) + hex(1 + n, 64) + '1b'; }
  if (method === 'eth_sendTransaction' && BigInt(params[0].value || 0) === 0n) {
    const tx = params[0]; window.__wsent = (window.__wsent || 0) + 1; window.__wtx = { to: tx.to, from: tx.from, value: tx.value || '0x0', data: tx.data };
    window.__spentAll = true; window.__spentN++;
    return '0x' + hex(900 + window.__wsent, 64);
  }
  if (method === 'eth_sendTransaction') { const tx = params[0], p = pools.get(tx.to.toLowerCase()); if (BigInt(tx.value) !== p.d) throw new Error('value');
    window.__deposits = (window.__deposits || 0) + 1;
    if (window.__rejectDepositAt === window.__deposits) throw new Error('User rejected the request.'); p.seen.add(tx.data.slice(10)); window.__log.sends++; return '0x' + hex(window.__log.sends, 64); }
  if (method === 'eth_requestAccounts') { window.__log.accountRequests++; return ['${WALLET}']; }
  throw new Error('unsupported ' + method);
} };
const status = document.getElementById('status');
const say = (t, cls = '') => { status.textContent = t; status.className = cls; };
let account = null, handle = null;
const env = {
  host: document.getElementById('host'), notesHost: document.getElementById('notes'), amountInput: document.getElementById('amt'),
  chain: { chainId: 1, full: 'Ethereum' }, store: { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) }, workerUrl: '/fixed-pool-worker.js?cb=00000000',
  account: () => account, walletProvider: () => (account ? wallet : null), read,
  connect: async () => { window.__log.accountRequests++; account = '${WALLET}'; handle.repaint(); window.__wd?.repaint(); window.__in?.repaint(); return account; },
  // the page's own button: it shows the plan the card hands over, connects first, and runs it in its busy wrapper, which finishes with the text
  onPlan: (p) => {
    const m = document.getElementById('main');
    if (!p) { m.innerHTML = ''; return; }
    m.innerHTML = '<button class="btn" id="lg-go"></button>';
    const b = m.firstChild;
    b.textContent = account ? p.label : 'Connect wallet';
    b.onclick = () => (account ? env.act(b, async (step, c) => { const r = await p.run(step, c); say(r.text + (r.h ? ' ' + r.h : ''), 'ok'); }) : env.connect());
  },
  depositRest: async (a) => { if (window.__restFail) throw new Error('the wallet refused'); window.__rest.push(a.toString()); return '0x' + 'cd'.repeat(32); },
  ensureChain: async () => {}, toast: (m, bad) => say(m, bad ? 'err' : ''), errText: (e) => e?.message || String(e),
  say: (t) => say(t, 'ok'), done: (c, h, t) => say(t + ' ' + h, 'ok'),
  depositAddress: async () => '${BOX}',
  // names: what the test puts in window.__nameCfg ({ 'ross.wei': { pool, n, ns } }) is what the name service says
  names: async () => ({
    resolveName: async (name) => { const r = (window.__nameCfg || {})[name]; if (!r) { const e = new Error(name + ' has not published a Tacit address.'); e.code = 'no-record'; throw e; } return { name, pool: r.pool, address: 'tacit1x' }; },
    readBox: async (name) => { const r = (window.__nameCfg || {})[name]; return r && r.n ? { name, n: r.n, ns: r.ns } : null; },
  }),
  setAmount: (wei) => { const el = document.getElementById('amt'); el.value = wei ? (Number(wei) / 1e18).toString() : ''; el.dispatchEvent(new Event('input')); },
  act: async (btn, fn) => {
    if (window.__log.busy) return;
    window.__log.busy++; btn.setAttribute('aria-busy', 'true');
    try { await fn((m) => say(m[0].toUpperCase() + m.slice(1)), env.chain); } catch (e) { say(e?.message || String(e), 'err'); } finally { window.__log.busy--; btn.removeAttribute('aria-busy'); }
  },
};
handle = attach(env);
const env2 = { ...env, host: document.getElementById('wd'), onNotes: (l) => { window.__wdList = l.map((x) => ({ den: x.den.toString(), nonce: x.meta.nonce })); } };
const wdCtl = attachWithdraw(env2);
window.__wd = wdCtl;
document.getElementById('wd-go').onclick = (e) => env2.act(e.currentTarget, async (step, c) => {
  const q = window.__wdReq;
  window.__wdOut = null; window.__wdErr = null; window.__wdDone = null;
  try { window.__wdOut = (await wdCtl.exit(step, c, q.picks.map((i) => wdCtl.list[i]), q.to)).map((o) => o.receive.toString()); }
  catch (err) { window.__wdErr = err.message; window.__wdDone = (err.done || []).length; throw err; }
});
window.__intents = []; window.__relayErr = null; window.__sendFailAt = null; window.__bal = null;
const REFUND = '0x00000000000000000000000000000000000b0b02';
const env3 = {
  ...env, host: document.getElementById('in'),
  balance: () => (window.__bal == null ? null : BigInt(window.__bal)),
  relayFee: async (gas) => { if (window.__relayErr) throw new Error(window.__relayErr); window.__quotedGas = gas; return 100000000000000n; },
  refundBox: async () => REFUND,
  clock: async () => 1800000000, sendGraceMs: 3000,
  send: async (a) => {
    window.__intents.push({ calls: a.intent.calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data })), refund: a.intent.refund, deadline: a.intent.deadline.toString(), amount: a.amount.toString(), gas: a.gas, maxFee: a.maxFee == null ? null : a.maxFee.toString(), via: a.via });
    if (window.__sendFailAt === window.__intents.length) throw new Error('the relay refused');
    for (const c of a.intent.calls) pools.get(c.target.toLowerCase()).seen.add(c.data.slice(10));
    // the notes are in their pools; what the send then does is up to the test: answer, lose the answer, or never answer
    if (window.__sendMode === 'lose') throw new Error('the relay timed out');
    if (window.__sendMode === 'hang') { a.onStep?.('sending through the relay'); await new Promise(() => {}); }
    if (window.__sendMode === 'hangflaky') { window.__failReads = 3; await new Promise(() => {}); }
    return '0x' + hex(700 + window.__intents.length, 64);
  },
};
const inCtl = attachIntake(env3);
window.__in = inCtl;
window.__repaint = () => { handle.repaint(); wdCtl.repaint(); };
window.__ready = true;
</script>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__harness.html') { res.writeHead(200, { 'content-type': TYPES['.html'] }); res.end(HARNESS); return; }
  const path = normalize(decodeURIComponent(url.pathname));
  let file = join(DAPP, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(DAPP) || !existsSync(file)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `paycards-${name}.png`), fullPage: true }); };

// a chunk cache for the 1 ETH pool on Ethereum holding six deposits, `commitment` among them (`cacheHits` counts what the page asks of it)
const cacheHits = { n: 0 };
function chunkCache(page, commitments) {
  const topic = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('Deposit(bytes32,uint32,uint256)')));
  const hex = (n) => n.toString(16).padStart(64, '0');
  const leaves = [1, 2, 3].map((i) => '0x' + hex(BigInt(i) * 104729n)).concat([].concat(commitments), [5, 6].map((i) => '0x' + hex(BigInt(i) * 104729n)));
  const raw = Buffer.from(leaves.map((c, i) => JSON.stringify({ contractAddress: ONE.address.toLowerCase(), eventTopic: topic, topics: [topic, c], data: '0x' + hex(BigInt(i)) + hex(1n), blockNumber: '0x' + (100 + i).toString(16), logIndex: '0x0' })).join('\n') + '\n');
  const manifest = { availableProtocols: { 'tornado-cash-1-eth-1': { trackedAddresses: [ONE.address.toLowerCase()], trackedEventTopics: [topic], chunks: [], hotHead: { fromBlock: '0x0', toBlock: '0x384', file: 'hot.jsonl.gz', size: '0x1', digest: { type: 'sha256', data: '0x' + createHash('sha256').update(raw).digest('hex') } } } } };
  return page.route('https://saga.0000000000.org/**', (route) => {
    const url = route.request().url();
    cacheHits.n++;
    const headers = { 'access-control-allow-origin': '*' };
    if (url.endsWith('/index.json')) return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(manifest) });
    if (url.endsWith('/hot.jsonl.gz')) return route.fulfill({ status: 200, headers, contentType: 'application/gzip', body: gzipSync(raw) });
    return route.fulfill({ status: 404, headers, body: 'no' });
  });
}
const bundlerMode = { failAt: null };   // the operation sent when this many have been sent is refused
function stubBundler(page, sent) {
  return page.route('https://public.pimlico.io/**', async (route) => {
    const { id, method, params } = route.request().postDataJSON();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const answer = (result) => route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
    if (method === 'pimlico_getUserOperationGasPrice') return answer({ standard: { maxFeePerGas: '0x17d78400', maxPriorityFeePerGas: '0x5f5e100' } });
    if (method === 'eth_estimateUserOperationGas') return answer({ callGasLimit: '0x0', verificationGasLimit: '0x9c40', preVerificationGas: '0xea60', paymasterVerificationGasLimit: '0x55730', paymasterPostOpGasLimit: '0x7530' });
    if (method === 'eth_sendUserOperation') {
      if (bundlerMode.failAt === sent.length) { bundlerMode.failAt = null; return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32500, message: 'AA31 paymaster deposit too low' } }) }); }
      sent.push(params[0]); await page.evaluate(() => { window.__spentAll = true; window.__spentN++; }); return answer('0x1');
    }
    if (method === 'eth_getUserOperationByHash') return answer(null);   // after a refused send the client asks whether the operation is known: it is not
    if (method === 'eth_getUserOperationReceipt') return answer({ success: true, receipt: { transactionHash: '0x' + 'ee'.repeat(32) } });
    return route.fulfill({ status: 404, headers, body: 'no' });
  });
}

console.log('Pay deposit cards');
const ctx = await browser.newContext({ viewport: { width: 540, height: 1000 } });
const page = await ctx.newPage();
await page.addInitScript(() => { try { localStorage.setItem('tacit-fixed-min:1', '1000000000000000000'); } catch {} });   // these were written for a 1 ETH smallest note
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console ' + m.text() + ' ' + (m.location()?.url || '')); });
await page.goto(base + '/__harness.html');
await page.waitForFunction(() => window.__ready === true);
const sent = [];
await stubBundler(page, sent);
const typeAmount = async (v) => { await page.fill('#amt', v); };
const note = async () => (await page.locator('#status').innerText());

await test('an amount under a whole note shows no card; a large one shows the split and what stays for the form', async () => {
  await typeAmount('0.9');
  assert.equal(await page.locator('#lg-go').count(), 0, 'under 1 ETH: nothing');
  await typeAmount('2.5');
  const text = await page.locator('#host').innerText();
  assert.match(text, /2 × 1 ETH/); assert.match(text, /0\.5 ETH\s+your private balance/);
  assert.equal((await page.locator('#lg-go').innerText()).trim(), 'Connect wallet');
  await shot(page, 'split');
});
await test('the notes card opens with a short explainer that names Tornado Cash, closed until opened', async () => {
  const d = page.locator('#notes details.lg-how');
  assert.equal(await d.count(), 1);
  assert.equal(await d.evaluate((el) => el.open), false, 'closed at first');
  assert.match(await page.locator('#notes summary').innerText(), /How it works/);
  await page.click('#notes summary');
  assert.equal(await d.evaluate((el) => el.open), true);
  const t = await d.innerText();
  assert.match(t, /Tornado Cash/); assert.match(t, /1, 10 or 100 ETH/); assert.match(t, /Find/); assert.match(t, /blends in/);
  assert.ok(t.split(/\s+/).length < 110, 'short: ' + t.split(/\s+/).length + ' words');
  await page.click('#notes summary');
});
await test('with no notes the card has no gas picker (nothing to take out yet), and Find and Paste are there', async () => {
  assert.equal(await page.locator('#notes #lg-gas').count(), 0);
  assert.equal(await page.locator('#notes #lg-find').count(), 1); assert.equal(await page.locator('#notes #lg-paste').count(), 1);
  assert.doesNotMatch(await page.locator('#notes').innerText(), /Paid from/);
});
await test('the smallest note can be lowered to 0.1 ETH', async () => {
  await typeAmount('0.35');
  assert.equal(await page.locator('#lg-go').count(), 0);
  await typeAmount('2.5');
  await page.selectOption('#lg-min', String(10n ** 17n));
  assert.match(await page.locator('#host').innerText(), /6 × 0\.1 ETH|5 × 0\.1 ETH|\d × 0\.1 ETH/);
  await page.selectOption('#lg-min', String(10n ** 18n));
});
await test('connecting, then depositing the whole notes: signed and sent for each, kept without secrets, and the amount above becomes what is left', async () => {
  await page.click('#lg-go'); // connect
  await page.waitForFunction(() => /Deposit 2\.5 ETH: 2 whole notes \+ 0\.5/.test(document.querySelector('#lg-go')?.textContent || ''));
  await page.click('#lg-go');
  await page.waitForFunction(() => /are in the large pools/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  await page.waitForFunction(() => /0\.5 ETH went into your private balance/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  assert.match(await note(), /\(2 ETH\), and 0\.5 ETH went into your private balance/);
  assert.equal(await page.inputValue('#amt'), '0.5');
  assert.deepEqual(await page.evaluate(() => window.__rest), ['500000000000000000'], 'what was left went to the page to deposit');
  const log = await page.evaluate(() => window.__log);
  assert.equal(log.sends, 2, 'one deposit per note');
  const kept = JSON.parse(await page.evaluate(() => localStorage.getItem(`tacit-fixed-notes:1:${'0x2c7536e3605d9c16a7a3d7b1898e529396a65c23'}`)));
  assert.equal(kept.length, 2);
  for (const n of kept) assert.deepEqual(Object.keys(n).sort(), ['c', 'nh', 'nonce', 'pool'], 'only where the note is and what it is called on chain');
  assert.deepEqual(kept.map((n) => n.nonce), [0, 1]);
  const notesText = await page.locator('#notes').innerText();
  assert.match(notesText, /1 ETH\s+· note 0/); assert.match(notesText, /1 ETH\s+· note 1/);
  assert.match(notesText, /Move into Tacit/);
  await shot(page, 'notes');
});
await test('Move into Tacit: proved in a worker, the fee shown and pressed, one operation to the bundler, paying the user\'s own deposit address', async () => {
  const kept = JSON.parse(await page.evaluate(() => localStorage.getItem(`tacit-fixed-notes:1:${'0x2c7536e3605d9c16a7a3d7b1898e529396a65c23'}`)));
  await chunkCache(page, kept[0].c);
  // pointing at the note's action builds its pool's tree ahead: the cache is read now, before any press, and not again by the press
  cacheHits.n = 0;
  await page.hover('[data-move="0"]');
  let last = -1;
  for (let i = 0; i < 60; i++) { await page.waitForTimeout(500); if (cacheHits.n > 0 && cacheHits.n === last) break; last = cacheHits.n; }
  const warmed = cacheHits.n;
  assert.ok(warmed > 0, 'the pool was read ahead, on pointing at the note');
  await page.click('[data-move="0"]');
  await page.waitForSelector('#lg-ask:not([hidden]) #lg-send', { timeout: 240000 });
  assert.equal(cacheHits.n, warmed, 'the press did not read the pool again');
  assert.equal(sent.length, 0, 'nothing is sent before the press');
  // a redraw of the card while the panel is open (a late read of the pool, the gas choice) must not take its buttons away
  await page.evaluate(() => { window.__repaint(); });
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#lg-ask:not([hidden]) #lg-send').count(), 1, 'the panel and its Send button are still there');
  const ask = await page.locator('#lg-ask').innerText();
  assert.match(ask, /up to 0\.\d+ ETH \(\d\.\d\d% of it\)/); assert.match(ask, /at least 0\.\d+ ETH/);
  await shot(page, 'confirm');
  await page.click('#lg-send');
  await page.waitForFunction(() => /on its way to your deposit address/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
  assert.equal(sent.length, 1);
  const op = sent[0];
  assert.equal(op.paymaster.toLowerCase(), '0xb0ffcdc890e969579d348f519a9c3920c2dd04a5', 'the mainnet paymaster');
  assert.equal(op.callData, '0x');
  assert.ok(op.paymasterData.toLowerCase().includes(BOX.slice(2)), 'pays the deposit address');
  assert.ok(op.eip7702Auth && op.eip7702Auth.chainId === '0x1');
});
await test('notes taken out fold into one closed line with nothing to do on them; the unspent ones are listed by number, and the line keeps its state', async () => {
  const key = 'tacit-fixed-notes:1:0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
  await page.waitForFunction(() => /\d+ spent notes?/.test(document.querySelector('#notes details.lg-spent summary')?.textContent || ''));
  const box = () => page.locator('#notes details.lg-spent');
  assert.equal(await box().evaluate((el) => el.open), false, 'closed at first');
  assert.match((await box().locator('summary').innerText()).trim(), /^\d+ spent notes?$/);
  assert.equal(await page.locator('#notes [data-move], #notes [data-out]').count(), 0, 'nothing to do on a spent note');
  assert.match(await page.locator('#notes').innerText(), /No unspent notes/);
  assert.equal(await page.locator('#notes #lg-gas').count(), 1, 'the gas choice stays: a pasted note is taken out with it too');
  await box().locator('summary').click();
  await page.evaluate(() => { window.__repaint(); });
  assert.equal(await box().evaluate((el) => el.open), true, 'stays open when the card is drawn again');
  const nums = [...(await box().innerText()).matchAll(/note (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b), 'by number');
  await box().locator('summary').click();
  // one taken out, one still in its pool: the one in the pool keeps its actions, and the other is the one folded line
  const kept = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), key));
  const spentN = await page.evaluate(() => window.__spentN);
  await page.evaluate(([nh]) => { window.__spentAll = false; window.__order = [nh]; window.__spentN = 1; window.__repaint(); }, [kept[0].nh.toLowerCase()]);
  await page.waitForFunction(() => document.querySelectorAll('#notes [data-move]').length === 1);
  assert.match((await box().locator('summary').innerText()).trim(), /^1 spent note$/);
  assert.equal(await page.locator('#notes [data-out]').count(), 1);
  assert.doesNotMatch(await page.locator('#notes').innerText(), /No unspent notes/);
  await page.evaluate(([n]) => { window.__order = null; window.__spentAll = true; window.__spentN = n; window.__repaint(); }, [spentN]);
  await page.waitForFunction(() => document.querySelectorAll('#notes [data-move]').length === 0);
});
await test('Find brings the notes back from the wallet alone: both are listed again, and only the numbers not signed for in this visit are asked for', async () => {
  const key = 'tacit-fixed-notes:1:0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
  await page.evaluate((k) => { localStorage.removeItem(k); window.__spentAll = false; window.__repaint(); }, key);
  assert.match(await page.locator('#notes').innerText(), /None found in this browser/);
  const signsBefore = await page.evaluate(() => window.__log.signs);
  await page.click('#lg-find');
  await page.waitForFunction(() => /2 found/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  await page.waitForFunction(() => /note 1/.test(document.querySelector('#notes').textContent));
  const text = await page.locator('#notes').innerText();
  assert.match(text, /note 0/); assert.match(text, /note 1/);
  const nonces = await page.evaluate(() => window.__log.nonces);
  assert.ok(nonces.slice(0, signsBefore).includes(0) && nonces.slice(0, signsBefore).includes(1), 'numbers 0 and 1 were signed for when the notes were made in this visit');
  assert.deepEqual(nonces.slice(signsBefore), [2, 3], 'Find tried 0 to 3 and asked only for 2 and 3: 0 and 1 are not asked for again');
  const kept = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), key));
  assert.deepEqual(kept.map((n) => n.nonce), [0, 1], 'kept again, without secrets');
  assert.match(text, /Kohaku/, 'the way out that does not need the paymaster is named');
});
await test('the explainer stays as the user left it when the card is drawn again', async () => {
  await page.click('#notes summary');
  assert.equal(await page.locator('#notes details.lg-how').evaluate((el) => el.open), true);
  await page.evaluate(() => { window.__repaint(); });
  assert.equal(await page.locator('#notes details.lg-how').evaluate((el) => el.open), true, 'still open after a late read draws the card again');
  await page.click('#notes summary');
  await page.evaluate(() => { window.__repaint(); });
  assert.equal(await page.locator('#notes details.lg-how').evaluate((el) => el.open), false, 'and still closed when it was closed');
});
await test('a form left open keeps what was typed when the card is drawn again, and the card is drawn once the form closes', async () => {
  const key = 'tacit-fixed-notes:1:0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
  const stored = await page.evaluate((k) => localStorage.getItem(k), key);
  await page.click('#lg-paste');
  await page.fill('#lg-note', 'tornado-eth-1-5-0xabc');
  await page.evaluate((k) => { localStorage.removeItem(k); window.__repaint(); }, key);
  assert.equal(await page.inputValue('#lg-note'), 'tornado-eth-1-5-0xabc', 'what was typed is still there');
  assert.equal(await page.locator('#lg-ask').isVisible(), true, 'the form is still open');
  assert.match(await page.locator('#notes').innerText(), /note 0/, 'the list waits while the form is open');
  await page.click('#lg-pno');
  assert.match(await page.locator('#notes').innerText(), /None found in this browser/, 'the card is drawn when the form closes');
  await page.evaluate(([k, v]) => { localStorage.setItem(k, v); window.__repaint(); }, [key, stored]);
  await page.waitForFunction(() => /note 1/.test(document.querySelector('#notes').textContent));
});
await test('the way-in card stays open when it is drawn again right after it is opened', async () => {
  const open = await page.evaluate(() => {
    const d = document.querySelector('#in details');
    d.open = true;             // the browser says so in a later task; a redraw that comes first must not close it
    window.__in.repaint();
    return document.querySelector('#in details').open;
  });
  assert.equal(open, true);
  await page.evaluate(() => { document.querySelector('#in details').open = false; window.__in.repaint(); });
  assert.equal(await page.locator('#in details').evaluate((el) => el.open), false);
});
await test('Withdraw to an address: a mistyped checksum is refused before anything is read or signed', async () => {
  await page.reload(); await page.waitForFunction(() => window.__ready === true);
  await page.fill('#amt', '2.5'); await page.click('#lg-go'); // connect again: this page forgot it
  await page.waitForSelector('[data-out="1"]');
  await page.click('[data-out="1"]');
  await page.fill('#lg-to', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd'); // one capital wrong
  const signsBefore = await page.evaluate(() => window.__log.signs);
  await page.click('#lg-out');
  assert.match(await note(), /capitalization does not match its checksum/);
  assert.equal(await page.evaluate(() => window.__log.signs), signsBefore, 'nothing signed');
  assert.equal(sent.length, 1, 'nothing more sent');
});
await test('a valid address goes as far as the fee, and Cancel sends nothing', async () => {
  const kept = JSON.parse(await page.evaluate(() => localStorage.getItem(`tacit-fixed-notes:1:${'0x2c7536e3605d9c16a7a3d7b1898e529396a65c23'}`)));
  await chunkCache(page, kept[1].c);
  await page.fill('#lg-to', '0x00000000000000000000000000000000000dead1');
  await page.click('#lg-out');
  await page.waitForSelector('#lg-ask:not([hidden]) #lg-cancel', { timeout: 240000 });
  await page.click('#lg-cancel');
  await page.waitForFunction(() => /Cancelled\. Nothing was sent/.test(document.querySelector('#status').textContent));
  assert.equal(sent.length, 1, 'still just the first operation');
  assert.equal(await page.locator('#lg-ask').isVisible(), false);
});
const pasteNote = async (text, to = '') => {
  await page.click('#lg-paste');
  await page.fill('#lg-note', text);
  await page.fill('#lg-pto', to);
  await page.click('#lg-pgo');
};
await test('Paste a note: any note, with no wallet connected, goes to the fee and then to the user\'s own deposit address, with nothing signed by the wallet', async () => {
  const text = noteString({ denomination: 10n ** 18n, chainId: 1, preimage: new Uint8Array(62).fill(7) });
  await chunkCache(page, commitmentBytes32(parseNoteString(text).commitment));
  await page.reload(); await page.waitForFunction(() => window.__ready === true);
  const before = sent.length;
  assert.equal(await page.locator('#lg-paste').isVisible(), true, 'the card is there with no wallet');
  await pasteNote(text);
  await page.waitForSelector('#lg-ask:not([hidden]) #lg-send', { timeout: 240000 });
  assert.equal(sent.length, before, 'nothing is sent before the press');
  assert.match(await page.locator('#lg-ask').innerText(), /up to 0\.\d+ ETH \(\d\.\d\d% of it\)/);
  await shot(page, 'paste-confirm');
  await page.click('#lg-send');
  await page.waitForFunction(() => /on its way to your deposit address/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
  assert.equal(sent.length, before + 1);
  assert.ok(sent.at(-1).paymasterData.toLowerCase().includes(BOX.slice(2)), 'pays the deposit address');
  const log = await page.evaluate(() => window.__log);
  assert.equal(log.signs, 0, 'nothing signed'); assert.equal(log.accountRequests, 0, 'no account asked for'); assert.equal(log.sends, 0, 'nothing sent from the wallet');
});
await test('Paste a note to an address: it goes there, and a mistyped checksum is refused first', async () => {
  const text = noteString({ denomination: 10n ** 18n, chainId: 1, preimage: new Uint8Array(62).fill(8) });
  await chunkCache(page, commitmentBytes32(parseNoteString(text).commitment));
  await page.evaluate(() => { window.__spentAll = false; });
  const before = sent.length;
  await pasteNote(text, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd'); // one capital wrong
  assert.match(await note(), /capitalization does not match its checksum/);
  await pasteNote(text, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  await page.waitForSelector('#lg-ask:not([hidden]) #lg-send', { timeout: 240000 });
  await page.click('#lg-send');
  await page.waitForFunction(() => /is on its way to 0x5aAe/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
  assert.equal(sent.length, before + 1);
  assert.ok(sent.at(-1).paymasterData.toLowerCase().includes('5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), 'to that address');
});
await test('Paste a note: something that is not a note, a note for another network and one of a size no pool takes are each refused, with nothing sent', async () => {
  const before = sent.length;
  await pasteNote('hello');
  assert.match(await note(), /That is not a note/);
  await pasteNote(noteString({ denomination: 10n ** 18n, chainId: 8453, preimage: new Uint8Array(62).fill(9) }));
  await page.waitForFunction(() => /This note is for network 8453/.test(document.querySelector('#status').textContent));
  await pasteNote(noteString({ denomination: 5n * 10n ** 17n, chainId: 1, preimage: new Uint8Array(62).fill(9) }));
  await page.waitForFunction(() => /No pool takes this note on this network/.test(document.querySelector('#status').textContent));
  await page.click('#lg-paste');
  await page.fill('#lg-note', noteString({ denomination: 10n ** 18n, chainId: 1, preimage: new Uint8Array(62).fill(9) }));
  await page.fill('#lg-pto', '0x1234');
  await page.click('#lg-pgo');
  assert.match(await note(), /Enter the address that should receive it/);
  assert.equal(sent.length, before, 'nothing sent');
});
// a payee with a name: a view key, the pool address that carries it, and a deposit-address key signed with it
const { poolAddressOf } = await import('../dapp/tacit-address.js');
const { signBox, boxValue } = await import('../dapp/fixed-pool-box.js');
const { receiveBoxAddress, RECEIVE_FEE_BPS, EVM_POOL_ROUTER } = await import('../dapp/evm-pool-gateway.js');
const { secp, hexToBytes: h2b } = await import('../dapp/vendor/tacit-deps.min.js');
const keys97 = (v) => { const k = new Uint8Array(97); k.set(secp.getPublicKey(h2b(v.toString(16).padStart(64, '0')), true), 0); k.fill(7, 33); return k; };
const VIEW = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn, OTHER_VIEW = 0x0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0bn;
const BOXKEY = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn;
const hex64n = (x) => x.toString(16).padStart(64, '0');
const THEIR_BOX = receiveBoxAddress(BOXKEY, RECEIVE_FEE_BPS, EVM_POOL_ROUTER);
const setNames = (cfg) => page.evaluate((c) => { window.__nameCfg = c; }, cfg);
const sendToName = async (name, noteByte) => {
  const text = noteString({ denomination: 10n ** 18n, chainId: 1, preimage: new Uint8Array(62).fill(noteByte) });
  await chunkCache(page, commitmentBytes32(parseNoteString(text).commitment));
  await page.evaluate(() => { window.__spentAll = false; });
  await pasteNote(text, name);
};
await test('Paste a note to a name: its deposit address is looked up, checked against the name\'s own key, shown in the fee panel, and paid', async () => {
  await setNames({ 'ross.wei': { pool: poolAddressOf(keys97(VIEW)), n: hex64n(BOXKEY), ns: await signBox(VIEW, BOXKEY) } });
  const before = sent.length;
  await sendToName('ross.wei', 21);
  await page.waitForSelector('#lg-ask:not([hidden]) #lg-send', { timeout: 240000 });
  const ask = await page.locator('#lg-ask').innerText();
  assert.match(ask, /To ross\.wei's deposit address/); assert.ok(ask.toLowerCase().includes(THEIR_BOX.toLowerCase()), 'the address is shown');
  await page.click('#lg-send');
  await page.waitForFunction(() => /is on its way to ross\.wei's deposit address/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
  assert.equal(sent.length, before + 1);
  assert.ok(sent.at(-1).paymasterData.toLowerCase().includes(THEIR_BOX.slice(2).toLowerCase()), 'pays the name\'s deposit address');
});
await test('Pasted notes to a name with no deposit address, to one signed by another key and to one that does not exist are each refused, with nothing sent', async () => {
  const before = sent.length;
  await setNames({
    'none.wei': { pool: poolAddressOf(keys97(VIEW)) },
    'fake.wei': { pool: poolAddressOf(keys97(VIEW)), n: hex64n(BOXKEY), ns: await signBox(OTHER_VIEW, BOXKEY) },
  });
  await sendToName('none.wei', 22);
  await page.waitForFunction(() => /has not published a deposit address/.test(document.querySelector('#status').textContent));
  await sendToName('fake.wei', 23);
  await page.waitForFunction(() => /not signed by fake\.wei's own key/.test(document.querySelector('#status').textContent));
  await sendToName('ghost.wei', 24);
  await page.waitForFunction(() => /ghost\.wei has not published a Tacit address/.test(document.querySelector('#status').textContent));
  assert.equal(sent.length, before, 'nothing was sent');
});
// ---- one press for a large amount, and the Withdraw block's notes ----
const NOTES_KEY = 'tacit-fixed-notes:1:0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
const keptNotes = async () => JSON.parse(await page.evaluate((k) => localStorage.getItem(k), NOTES_KEY) || '[]');
const status = async () => page.locator('#status').innerText();
await test('one press, the part that is left refused: the notes are placed, and the message says what remains and to press again', async () => {
  await page.reload(); await page.waitForFunction(() => window.__ready === true);
  await page.evaluate((k) => { localStorage.removeItem(k); window.__restFail = true; window.__repaint(); }, NOTES_KEY);
  await page.fill('#amt', '2.5');
  await page.click('#lg-go'); // connect
  await page.waitForFunction(() => /Deposit 2\.5 ETH: 2 whole notes \+ 0\.5/.test(document.querySelector('#lg-go')?.textContent || ''));
  await page.click('#lg-go');
  await page.waitForFunction(() => /did not go in/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  const text = await status();
  assert.match(text, /The notes are in the large pools \(2 ETH\)\. The rest, 0\.5 ETH, did not go in: the wallet refused/);
  assert.match(text, /press the button again/);
  assert.equal(await page.inputValue('#amt'), '0.5', 'the amount is what is left');
  assert.equal((await keptNotes()).length, 2, 'the notes are kept');
  assert.deepEqual(await page.evaluate(() => window.__rest), [], 'nothing of the rest went in');
});
await test('an exact multiple of a note deposits only whole notes in one press, with nothing left for the page', async () => {
  await page.evaluate(() => { window.__restFail = false; });
  await page.fill('#amt', '1');
  await page.waitForFunction(() => /^Deposit 1 ETH: 1 whole note$/.test(document.querySelector('#lg-go')?.textContent || ''));
  const drawn = await page.locator('#host').innerText();
  assert.match(drawn, /1 × 1 ETH\s+whole note · Tornado Cash/); assert.doesNotMatch(drawn, /private balance/, 'no part is drawn for the private balance when nothing is left');
  await page.click('#lg-go');
  await page.waitForFunction(() => /The note is in the large pool \(1 ETH\)\./.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  assert.deepEqual(await page.evaluate(() => window.__rest), []);
  assert.equal((await keptNotes()).length, 3, 'the note joins the two kept before');
});
await test('the large pools can be turned off, and the choice is kept', async () => {
  await page.fill('#amt', '2.5');
  await page.selectOption('#lg-min', '0');
  assert.match(await page.locator('#host').innerText(), /large pools are off/);
  assert.equal(await page.locator('#lg-go').count(), 0, 'no button of the card: the form deposits it all as it always did');
  assert.equal(await page.evaluate(() => localStorage.getItem('tacit-fixed-min:1')), '0');
  await page.selectOption('#lg-min', String(10n ** 18n));
  await page.waitForSelector('#lg-go');
  assert.equal(await page.evaluate(() => localStorage.getItem('tacit-fixed-min:1')), String(10n ** 18n));
});
await test('the Withdraw block lists the unspent notes this wallet holds', async () => {
  await page.evaluate(() => window.__wd.repaint());
  await page.waitForFunction(() => window.__wdList?.length === 3);
  assert.deepEqual(await page.evaluate(() => window.__wdList), (await keptNotes()).map((n) => ({ den: '1000000000000000000', nonce: n.nonce })), 'each kept note, at the size of its pool');
  const text = await page.locator('#wd').innerText();
  assert.match(text, /3 whole notes\s+3 ETH/); assert.match(text, /Look for notes/); assert.match(text, /at most 3% of each/);
  await shot(page, 'withdraw-block');
});
const exitNotes = async (picks, to) => {
  await page.evaluate((q) => { window.__wdReq = q; }, { picks, to });
  await page.click('#wd-go');
};
await test('two notes out in one press: each proved and sent with its gas from the note and no confirm between, and the second refused by the bundler leaves the first out and says so', async () => {
  const kept = await keptNotes();
  await chunkCache(page, kept.map((n) => n.c));
  await page.evaluate((order) => { window.__order = order; window.__spentN = 0; window.__spentAll = false; }, kept.map((n) => n.nh.toLowerCase()));
  const before = sent.length;
  bundlerMode.failAt = before + 1;
  await exitNotes([0, 1], '0x000000000000000000000000000000000000dEaD');
  await page.waitForFunction(() => window.__wdErr != null, null, { timeout: 480000 });
  const err = await page.evaluate(() => ({ msg: window.__wdErr, done: window.__wdDone }));
  assert.match(err.msg, /1 of 2 notes went out to 0x0000…dEaD \(0\.\d+ ETH\)\. Note 2 did not: .*AA31/);
  assert.equal(err.done, 1);
  assert.equal(sent.length, before + 1, 'one operation went out');
  assert.ok(sent.at(-1).paymasterData.toLowerCase().includes('000000000000000000000000000000000000dead'), 'to that address');
  assert.equal(await page.locator('#lg-ask').isVisible(), false, 'no confirm panel: the ceiling was stated before the press');
});
await test('the notes still held go out together the next time, and what comes back per note is the note less its gas', async () => {
  await page.evaluate(() => window.__wd.repaint());
  await page.waitForFunction(() => window.__wdList?.length === 2);
  const before = sent.length;
  await exitNotes([0, 1], '0x000000000000000000000000000000000000dEaD');
  await page.waitForFunction(() => window.__wdOut != null, null, { timeout: 480000 });
  const out = await page.evaluate(() => window.__wdOut);
  assert.equal(out.length, 2);
  for (const r of out) { const v = BigInt(r); assert.ok(v < 10n ** 18n && v > 97n * 10n ** 16n, `a note less its gas: ${r}`); }
  assert.equal(sent.length, before + 2);
  await page.waitForFunction(() => window.__wdList?.length === 0);
  assert.match(await page.locator('#wd').innerText(), /None known in this browser/);
});
const dead2 = '0x00000000000000000000000000000000000dead2';
await test('Gas from my wallet: the note is sent by the wallet as the proved call, after a confirm that says so, with no paymaster and no bundler', async () => {
  const text = noteString({ denomination: 10n ** 18n, chainId: 1, preimage: new Uint8Array(62).fill(31) });
  await chunkCache(page, commitmentBytes32(parseNoteString(text).commitment));
  await page.evaluate(() => { window.__spentAll = false; window.__order = null; window.__wsent = 0; });
  await page.selectOption('#lg-gas', 'wallet');
  assert.match(await page.locator('#notes').innerText(), /Your wallet sends the withdrawal and pays its gas/);
  assert.equal(await page.evaluate(() => localStorage.getItem('tacit-fixed-gas:1')), 'wallet', 'the choice is kept');
  const before = sent.length;
  await pasteNote(text, dead2);
  await page.waitForSelector('#lg-ask:not([hidden]) #lg-send', { timeout: 240000 });
  const ask = await page.locator('#lg-ask').innerText();
  assert.match(ask, /Your wallet sends this and pays the gas, so it shows as the sender/); assert.match(ask, /whole 1 ETH/);
  assert.equal(await page.evaluate(() => window.__wsent), 0, 'the wallet is not asked before the press');
  await page.click('#lg-send');
  await page.waitForFunction(() => /1 ETH is on its way to 0x0000…ead2/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
  const tx = await page.evaluate(() => window.__wtx);
  assert.equal(await page.evaluate(() => window.__wsent), 1);
  assert.equal(tx.to.toLowerCase(), ONE.address.toLowerCase(), 'to the pool'); assert.equal(tx.value, '0x0'); assert.equal(tx.from.toLowerCase(), WALLET.toLowerCase(), 'from the wallet');
  assert.ok(tx.data.toLowerCase().includes(dead2.slice(2)), 'the proved call names the address');
  assert.equal(sent.length, before, 'no operation went to the bundler');
  await page.selectOption('#lg-gas', 'note');
  assert.equal(await page.evaluate(() => localStorage.getItem('tacit-fixed-gas:1')), 'note');
});
await test('the same choice in the Withdraw block: a stored note goes out from the wallet, the whole note, with no bundler operation', async () => {
  await page.evaluate(() => { window.__spentAll = false; window.__order = null; });   // the wallet-sent exit before this one left every note reading as spent
  await page.fill('#amt', '1');
  await page.waitForFunction(() => /^Deposit 1 ETH: 1 whole note$/.test(document.querySelector('#lg-go')?.textContent || ''));
  await page.click('#lg-go');
  await page.waitForFunction(() => /The note is in the large pool \(1 ETH\)\./.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  await page.evaluate(() => window.__wd.repaint());
  await page.waitForFunction(() => window.__wdList?.length === 1);
  const kept = await keptNotes();
  await chunkCache(page, kept.at(-1).c);
  await page.evaluate((order) => { window.__order = order; window.__spentN = order.length - 1; window.__wsent = 0; }, kept.map((n) => n.nh.toLowerCase()));
  await page.selectOption('#lw-gas', 'wallet');
  assert.equal(await page.evaluate(() => window.__wd.fromWallet), true);
  assert.match(await page.locator('#wd').innerText(), /Your wallet sends each note and pays its gas/);
  const before = sent.length;
  await exitNotes([0], dead2);
  await page.waitForFunction(() => window.__wdOut != null, null, { timeout: 480000 });
  assert.deepEqual(await page.evaluate(() => window.__wdOut), [String(10n ** 18n)], 'the whole note: nothing was taken for gas');
  assert.equal(await page.evaluate(() => window.__wsent), 1); assert.equal(sent.length, before);
  await page.selectOption('#lw-gas', 'note').catch(() => {});
});

// ---- the way in: whole notes from the private balance ----
const inText = () => page.locator('#in').innerText();
const intents = () => page.evaluate(() => window.__intents);
// the form to make notes is one line until it is opened
const openIntake = () => page.evaluate(() => { const d = document.querySelector('#in details'); if (d && !d.open) d.open = true; });
const typeIn = async (v) => { await openIntake(); await page.fill('#li-amt', v); };
await test('Into whole notes: the plan and the relay\'s fee show for an amount, priced for one note\'s gas, and the relay is the default', async () => {
  await page.reload(); await page.waitForFunction(() => window.__ready === true);
  await page.evaluate((k) => { localStorage.removeItem(k); }, NOTES_KEY);
  await page.fill('#amt', '1'); await page.click('#lg-go'); // connect (the card's button asks first)
  await page.evaluate(() => { window.__repaint(); window.__bal = null; });
  await typeIn('2.5');
  const t = await inText();
  assert.match(t, /2 × 1 ETH\s+whole notes, large pool/); assert.match(t, /0\.5 ETH\s+stays in your private balance/);
  assert.match(t, /Relay fee\s+up to 0\.000125 ETH from your balance for each note/);
  assert.equal(await page.evaluate(() => window.__quotedGas), 450000 + 1040000, 'priced for the withdrawal and one deposit');
  assert.match(await page.locator('#li-go').innerText(), /Move 2 ETH into 2 notes/);
  await typeIn('0.4');
  assert.match(await inText(), /less than the smallest note, 1 ETH/);
  await shot(page, 'intake');
});
await test('by the relay the notes go one to a transaction: each spend is one deposit call into its pool, to a refund box, for exactly the note, and only landed notes are kept', async () => {
  await typeIn('2.5');
  const before = (await keptNotes()).length;
  await page.click('#li-go');
  await page.waitForFunction(() => /are in the large pools \(2 ETH\), made from your private balance/.test(document.querySelector('#status').textContent), null, { timeout: 90000 });
  const list = await intents(), kept = (await keptNotes()).slice(before);
  assert.equal(list.length, 2, 'one spend for each note');
  list.forEach((it, i) => {
    assert.equal(it.calls.length, 1);
    assert.equal(it.calls[0].target.toLowerCase(), ONE.address.toLowerCase()); assert.equal(it.calls[0].value, String(10n ** 18n));
    assert.equal(it.calls[0].data, '0xb214faa5' + kept[i].c.slice(2), 'the call deposits this note\'s commitment');
    assert.equal(it.refund, '0x00000000000000000000000000000000000b0b02'); assert.equal(it.deadline, String(1800003600));
    assert.equal(it.amount, String(10n ** 18n)); assert.equal(it.via, 'relay'); assert.equal(it.gas, 450000 + 1040000); assert.equal(it.maxFee, '125000000000000');
  });
  assert.equal(kept.length, 2, 'both are kept, and they are the notes the calls deposited');
  assert.equal(await page.evaluate(() => window.__log.sends), 0, 'the wallet sent no transaction: it only signed');
});
await test('from the wallet all the notes go in one transaction, with the escrow paying each deposit, and the wallet is named as the sender', async () => {
  await page.evaluate(() => { window.__intents.length = 0; });
  await openIntake(); await page.selectOption('#li-via', 'wallet');
  await typeIn('2.5');
  assert.match(await inText(), /Sent by\s+your wallet: it pays the gas and shows as the sender/);
  await page.click('#li-go');
  await page.waitForFunction(() => window.__intents.length === 1, null, { timeout: 90000 });
  const [it] = await intents();
  assert.equal(it.calls.length, 2); assert.equal(it.amount, String(2n * 10n ** 18n)); assert.equal(it.via, 'self'); assert.equal(it.maxFee, null);
  assert.equal(it.gas, 450000 + 1040000 + 850000);
  assert.notEqual(it.calls[0].data, it.calls[1].data, 'two different notes');
});
await test('a send whose answer is lost after the notes landed (a mainnet canary saw this) still counts as made: the pool says so, and the note is kept', async () => {
  await page.evaluate(() => { window.__intents.length = 0; window.__sendMode = 'lose'; });
  const before = (await keptNotes()).length;
  await typeIn('1');
  await page.click('#li-go');
  await page.waitForFunction(() => /The note is in the large pool \(1 ETH\), made from your private balance/.test(document.querySelector('#status').textContent), null, { timeout: 90000 });
  assert.equal((await keptNotes()).length, before + 1);
  assert.doesNotMatch(await status(), /timed out/);
});
await test('a send that never answers ends as soon as the notes are in the pool, and what it says afterwards is not shown', async () => {
  await page.evaluate(() => { window.__intents.length = 0; window.__sendMode = 'hang'; });
  const before = (await keptNotes()).length;
  await typeIn('1');
  await page.click('#li-go');
  await page.waitForFunction(() => /The note is in the large pool \(1 ETH\), made from your private balance/.test(document.querySelector('#status').textContent), null, { timeout: 90000 });
  assert.equal((await keptNotes()).length, before + 1);
  await page.waitForTimeout(1500);
  assert.match(await status(), /The note is in the large pool/, 'the pending send does not overwrite the result');
  await page.evaluate(() => { window.__sendMode = null; });
});
await test('a send that fails with nothing landed keeps its error and says where to look if it was sent after all', async () => {
  await page.evaluate(() => { window.__intents.length = 0; window.__sendFailAt = 1; });
  const before = (await keptNotes()).length;
  await typeIn('1');
  await page.click('#li-go');
  await page.waitForFunction(() => /the relay refused If it was sent after all, Look for notes will show the note once it lands/.test(document.querySelector('#status').textContent.replace(/\s+/g, ' ')), null, { timeout: 90000 });
  assert.equal((await keptNotes()).length, before, 'nothing kept');
  await page.evaluate(() => { window.__sendFailAt = null; });
});
await test('a refused second spend leaves the first note in the pool and kept, and the message says how far it got', async () => {
  await openIntake(); await page.selectOption('#li-via', 'relay');
  await page.evaluate(() => { window.__intents.length = 0; window.__sendFailAt = 2; });
  const before = (await keptNotes()).length;
  await typeIn('2.5');
  await page.click('#li-go');
  await page.waitForFunction(() => /1 of 2 notes is in the large pool\. The next did not go: the relay refused/.test(document.querySelector('#status').textContent), null, { timeout: 90000 });
  assert.equal((await keptNotes()).length, before + 1, 'the one that landed is kept');
  await page.evaluate(() => { window.__sendFailAt = null; });
});
await test('a private balance that is short is said so before anything is signed', async () => {
  await page.evaluate(() => { window.__bal = String(10n ** 18n); });
  await page.evaluate(() => window.__in.repaint());
  await typeIn('2.5');
  assert.match(await inText(), /Your private balance holds 1 ETH, less than the 2 ETH of notes/);
  assert.equal(await page.locator('#li-go').isDisabled(), true);
  await page.evaluate(() => { window.__bal = null; });
});
await test('a relay that will not take the gas falls back to the wallet and says why', async () => {
  await page.evaluate(() => { window.__relayErr = 'gas above the 1500000 cap'; window.__in.requote(); });
  await page.waitForFunction(() => /The relay cannot send this one \(gas above the 1500000 cap\), so your wallet does/.test(document.querySelector('#in').textContent));
  assert.equal(await page.locator('#li-via').inputValue(), 'wallet');
  await page.evaluate(() => { window.__relayErr = null; });
});
// ---- what a code review found, held in place ----
await test('a deposit that stops after the first note (the second declined in the wallet) keeps that note, takes it off the amount, and the next press deposits only the rest', async () => {
  await page.reload(); await page.waitForFunction(() => window.__ready === true);
  await page.evaluate((k) => { localStorage.removeItem(k); window.__restFail = false; window.__rest = []; window.__deposits = 0; window.__rejectDepositAt = 2; }, NOTES_KEY);
  await page.fill('#amt', '2.5');
  await page.click('#lg-go'); // connect
  await page.waitForFunction(() => /Deposit 2\.5 ETH: 2 whole notes \+ 0\.5/.test(document.querySelector('#lg-go')?.textContent || ''));
  await page.click('#lg-go');
  await page.waitForFunction(() => /1 of 2 notes was sent \(1 ETH\) and kept\. The amount above is what is left to deposit\./.test(document.querySelector('#status').textContent), null, { timeout: 90000 });
  assert.match(await status(), /User rejected the request/);
  assert.equal(await page.inputValue('#amt'), '1.5', 'the note that was sent is off the amount');
  assert.equal((await keptNotes()).length, 1, 'and kept');
  assert.deepEqual(await page.evaluate(() => window.__rest), [], 'the part for the private balance was not deposited either');
  await page.evaluate(() => { window.__rejectDepositAt = null; });
  await page.waitForFunction(() => /Deposit 1\.5 ETH: 1 whole note \+ 0\.5/.test(document.querySelector('#lg-go')?.textContent || ''));
  const sendsBefore = await page.evaluate(() => window.__log.sends);
  await page.click('#lg-go');
  await page.waitForFunction(() => /0\.5 ETH went into your private balance/.test(document.querySelector('#status').textContent), null, { timeout: 90000 });
  assert.equal((await page.evaluate(() => window.__log.sends)) - sendsBefore, 1, 'one more note, not two');
  assert.equal((await keptNotes()).length, 2);
  assert.deepEqual(await page.evaluate(() => window.__rest), ['500000000000000000']);
});
await test('a send that never answers, with the pool reads failing for a while, still ends once a read gets through and the notes are there', async () => {
  await page.evaluate(() => { window.__intents.length = 0; window.__sendMode = 'hangflaky'; });
  const before = (await keptNotes()).length;
  await typeIn('1');
  await page.click('#li-go');
  await page.waitForFunction(() => /The note is in the large pool \(1 ETH\), made from your private balance/.test(document.querySelector('#status').textContent), null, { timeout: 120000 });
  assert.equal((await keptNotes()).length, before + 1);
  assert.doesNotMatch(await status(), /did not go/);
  await page.evaluate(() => { window.__sendMode = null; window.__failReads = 0; });
});
await test('two notes by the relay: the second is not started while the first send is still unanswered, and the message says why', async () => {
  await page.evaluate(() => { window.__intents.length = 0; window.__sendMode = 'hang'; });
  const before = (await keptNotes()).length;
  await typeIn('2');
  await page.click('#li-go');
  await page.waitForFunction(() => /The relay has not answered for the last note, so the others were not started/.test(document.querySelector('#status').textContent), null, { timeout: 90000 });
  assert.equal((await intents()).length, 1, 'only the first spend was made');
  assert.match(await status(), /1 of 2 notes is in the large pool/);
  assert.equal((await keptNotes()).length, before + 1, 'the note that landed is kept');
  await page.evaluate(() => { window.__sendMode = null; });
});
await test('no errors reached the console', async () => { assert.deepEqual(problems, []); });

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
