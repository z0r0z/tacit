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
<input id="amt" value="" placeholder="amount"><div id="host"></div><div id="notes"></div><div id="status" role="status"></div>
<script type="module">
import { attach } from '/fixed-pool-pay.js?cb=00000000';
const SEL = ${JSON.stringify({ den: sel('denomination()'), com: sel('commitments(bytes32)'), spent: sel('isSpent(bytes32)'), root: sel('isKnownRoot(bytes32)') })};
const pools = new Map(${JSON.stringify(POOLS.map((p) => [p.address.toLowerCase(), { d: p.denomination.toString() }]))}.map(([a, v]) => [a, { d: BigInt(v.d), seen: new Set() }]));
window.__log = { signs: 0, sends: 0, accountRequests: 0, busy: 0 };
window.__spentAll = false;
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
      if (s === SEL.com) return '0x' + (p.seen.has(arg) ? '1' : '0').padStart(64, '0');
      if (s === SEL.spent) return '0x' + (window.__spentAll ? '1' : '0').padStart(64, '0');
      if (s === SEL.root) return '0x' + '1'.padStart(64, '0');
      throw new Error('call ' + s);
    }
    default: throw new Error('unexpected read ' + method);
  }
};
const wallet = { async request({ method, params = [] }) {
  if (method === 'eth_signTypedData_v4') { window.__log.signs++; const n = Number(JSON.parse(params[1]).message.nonce); return '0x' + hex(0x1111 + n, 64) + hex(1 + n, 64) + '1b'; }
  if (method === 'eth_sendTransaction') { const tx = params[0], p = pools.get(tx.to.toLowerCase()); if (BigInt(tx.value) !== p.d) throw new Error('value'); p.seen.add(tx.data.slice(10)); window.__log.sends++; return '0x' + hex(window.__log.sends, 64); }
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
  connect: async () => { window.__log.accountRequests++; account = '${WALLET}'; handle.repaint(); return account; },
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
window.__repaint = () => handle.repaint();
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

// a chunk cache for the 1 ETH pool on Ethereum holding six deposits, `commitment` among them
function chunkCache(page, commitment) {
  const topic = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('Deposit(bytes32,uint32,uint256)')));
  const hex = (n) => n.toString(16).padStart(64, '0');
  const leaves = [1, 2, 3].map((i) => '0x' + hex(BigInt(i) * 104729n)).concat([commitment], [5, 6].map((i) => '0x' + hex(BigInt(i) * 104729n)));
  const raw = Buffer.from(leaves.map((c, i) => JSON.stringify({ contractAddress: ONE.address.toLowerCase(), eventTopic: topic, topics: [topic, c], data: '0x' + hex(BigInt(i)) + hex(1n), blockNumber: '0x' + (100 + i).toString(16), logIndex: '0x0' })).join('\n') + '\n');
  const manifest = { availableProtocols: { 'tornado-cash-1-eth-1': { trackedAddresses: [ONE.address.toLowerCase()], trackedEventTopics: [topic], chunks: [], hotHead: { fromBlock: '0x0', toBlock: '0x384', file: 'hot.jsonl.gz', size: '0x1', digest: { type: 'sha256', data: '0x' + createHash('sha256').update(raw).digest('hex') } } } } };
  return page.route('https://saga.0000000000.org/**', (route) => {
    const url = route.request().url();
    const headers = { 'access-control-allow-origin': '*' };
    if (url.endsWith('/index.json')) return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(manifest) });
    if (url.endsWith('/hot.jsonl.gz')) return route.fulfill({ status: 200, headers, contentType: 'application/gzip', body: gzipSync(raw) });
    return route.fulfill({ status: 404, headers, body: 'no' });
  });
}
function stubBundler(page, sent) {
  return page.route('https://public.pimlico.io/**', async (route) => {
    const { id, method, params } = route.request().postDataJSON();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const answer = (result) => route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
    if (method === 'pimlico_getUserOperationGasPrice') return answer({ standard: { maxFeePerGas: '0x17d78400', maxPriorityFeePerGas: '0x5f5e100' } });
    if (method === 'eth_estimateUserOperationGas') return answer({ callGasLimit: '0x0', verificationGasLimit: '0x9c40', preVerificationGas: '0xea60', paymasterVerificationGasLimit: '0x55730', paymasterPostOpGasLimit: '0x7530' });
    if (method === 'eth_sendUserOperation') { sent.push(params[0]); await page.evaluate(() => { window.__spentAll = true; }); return answer('0x1'); }
    if (method === 'eth_getUserOperationReceipt') return answer({ success: true, receipt: { transactionHash: '0x' + 'ee'.repeat(32) } });
    return route.fulfill({ status: 404, headers, body: 'no' });
  });
}

console.log('Pay deposit cards');
const ctx = await browser.newContext({ viewport: { width: 540, height: 1000 } });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console ' + m.text()); });
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
  assert.match(text, /2 × 1 ETH/); assert.match(text, /0\.5 ETH\s+stays for the deposit above/);
  assert.equal((await page.locator('#lg-go').innerText()).trim(), 'Connect wallet');
  await shot(page, 'split');
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
  await page.waitForFunction(() => /Deposit 2 whole notes/.test(document.querySelector('#lg-go')?.textContent || ''));
  await page.click('#lg-go');
  await page.waitForFunction(() => /are in the large pools/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  assert.match(await note(), /The amount above is now what is left, 0\.5 ETH/);
  assert.equal(await page.inputValue('#amt'), '0.5');
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
  await page.click('[data-move="0"]');
  await page.waitForSelector('#lg-ask:not([hidden]) #lg-send', { timeout: 240000 });
  assert.equal(sent.length, 0, 'nothing is sent before the press');
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
await test('a note that has been moved shows spent and offers nothing', async () => {
  await page.waitForFunction(() => /· spent/.test(document.querySelector('#notes').textContent));
});
await test('Find brings the notes back from the wallet alone: both are listed again, and each number tried is signed for', async () => {
  const key = 'tacit-fixed-notes:1:0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
  await page.evaluate((k) => { localStorage.removeItem(k); window.__spentAll = false; window.__repaint(); }, key);
  assert.match(await page.locator('#notes').innerText(), /None found in this browser/);
  const signsBefore = await page.evaluate(() => window.__log.signs);
  await page.click('#lg-find');
  await page.waitForFunction(() => /2 found/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  await page.waitForFunction(() => /note 1/.test(document.querySelector('#notes').textContent));
  const text = await page.locator('#notes').innerText();
  assert.match(text, /note 0/); assert.match(text, /note 1/);
  assert.ok((await page.evaluate(() => window.__log.signs)) - signsBefore >= 4, 'a signature for each of the numbers 0 to 3 it tried');
  const kept = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), key));
  assert.deepEqual(kept.map((n) => n.nonce), [0, 1], 'kept again, without secrets');
  assert.match(text, /Kohaku/, 'the way out that does not need the paymaster is named');
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
await test('no errors reached the console', async () => { assert.deepEqual(problems, []); });

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
