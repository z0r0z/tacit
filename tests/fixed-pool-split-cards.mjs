// The Pay deposit card's atomic path (dapp/fixed-pool-pay.js, depositAtomic + splitForwarder) in a real browser, on a stand-in page: where a split deposit's
// forwarder (contracts/src/TacitSplitDeposit.sol) is named and answers as it should, the notes and the rest go in ONE transaction, all or nothing; where it is
// not (none named, no code, another Tacit pool) the deposit goes the old way. A fresh browser context for each scenario.
//   PLAYWRIGHT=<path to playwright-core> node tests/fixed-pool-split-cards.mjs

import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { keccak_256, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
const { FIXED_POOLS } = await import('../dapp/fixed-pool-notes.js');

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const sel = (x) => bytesToHex(keccak_256(new TextEncoder().encode(x)).slice(0, 4));
const POOLS = FIXED_POOLS[1];
const WALLET = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const FWD = '0x' + 'f0'.repeat(20);
const TACIT = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
const NOTES_KEY = `tacit-fixed-notes:1:${WALLET.toLowerCase()}`;

const HARNESS = `<!doctype html><meta charset="utf-8"><title>split</title>
<style>body{font:14px monospace;max-width:520px;margin:20px auto} .btn{display:block;width:100%;padding:10px;margin-top:8px} .kv{display:flex;justify-content:space-between} .note{color:#555} .link{background:none;border:0;color:#06c;cursor:pointer} [hidden]{display:none}</style>
<input id="amt" value="" placeholder="amount"><div id="host"></div><div id="main"></div><div id="notes"></div><div id="status"></div>
<script type="module">
import { attach } from '/fixed-pool-pay.js?cb=00000000';
import { splitDepositCall } from '/evm-pool-wallet.js';
const SEL = ${JSON.stringify({ den: sel('denomination()'), com: sel('commitments(bytes32)'), spent: sel('isSpent(bytes32)'), root: sel('isKnownRoot(bytes32)'), tacit: sel('TACIT_POOL()'), denOf: sel('denominationOf(address)') })};
const FWD = '${FWD}', TACIT = '${TACIT}';
const pools = new Map(${JSON.stringify(POOLS.map((p) => [p.address.toLowerCase(), { d: p.denomination.toString() }]))}.map(([a, v]) => [a, { d: BigInt(v.d), seen: new Set() }]));
window.__log = { signs: 0, sends: 0, fwd: [], busy: 0 };
window.__rest = []; window.__split = null; window.__restFail = false; window.__fwdMode = 'ok'; window.__fwdReject = false;
const hex = (n, w) => BigInt(n).toString(16).padStart(w, '0');
// the words of an address[] and a bytes32[] at the front of splitDeposit's calldata
const decode = (data) => {
  const w = (i) => data.slice(10 + i * 64, 10 + (i + 1) * 64), off = (k) => Number(BigInt('0x' + w(k))) / 32;
  const arr = (o) => Array.from({ length: Number(BigInt('0x' + w(o))) }, (_, i) => w(o + 1 + i));
  return { pools: arr(off(0)).map((x) => '0x' + x.slice(24)), commitments: arr(off(1)) };
};
const read = async () => async (method, params = []) => {
  switch (method) {
    case 'eth_chainId': return '0x1';
    case 'eth_blockNumber': return '0x3e8';
    case 'eth_getLogs': return [];
    case 'eth_getCode': return params[0].toLowerCase() === FWD && window.__fwdMode === 'nocode' ? '0x' : '0x6080';
    case 'eth_getBalance': return '0x' + hex(10n ** 21n, 1);
    case 'eth_getTransactionReceipt': return { status: '0x1' };
    case 'eth_call': {
      const { to, data } = params[0];
      if (to.toLowerCase() === FWD) {
        if (data.slice(2, 10) === SEL.tacit) return '0x' + (window.__fwdMode === 'wrongpool' ? '11'.repeat(20) : TACIT.slice(2).toLowerCase()).padStart(64, '0');
        if (data.slice(2, 10) === SEL.denOf) return '0x' + hex(pools.get('0x' + data.slice(34).toLowerCase())?.d ?? 0n, 64);
        throw new Error('forwarder call ' + data.slice(0, 10));
      }
      const p = pools.get(to.toLowerCase());
      if (!p) return '0x';
      const s = data.slice(2, 10), arg = data.slice(10);
      if (s === SEL.den) return '0x' + hex(p.d, 64);
      if (s === SEL.com) return '0x' + (p.seen.has(arg) ? '1' : '0').padStart(64, '0');
      if (s === SEL.spent) return '0x' + '0'.padStart(64, '0');
      if (s === SEL.root) return '0x' + '1'.padStart(64, '0');
      throw new Error('call ' + s);
    }
    default: throw new Error('unexpected read ' + method);
  }
};
const land = (list, cs) => list.forEach((a, i) => pools.get(a.toLowerCase()).seen.add(cs[i].replace(/^0x/, '')));
const wallet = { async request({ method, params = [] }) {
  if (method === 'eth_signTypedData_v4') { window.__log.signs++; const n = Number(JSON.parse(params[1]).message.nonce); return '0x' + hex(0x1111 + n, 64) + hex(1 + n, 64) + '1b'; }
  if (method === 'eth_sendTransaction') {
    const tx = params[0];
    if (tx.to.toLowerCase() === FWD) {
      if (window.__fwdReject) throw new Error('User rejected the request.');
      const d = decode(tx.data), want = d.pools.reduce((t, a) => t + pools.get(a.toLowerCase()).d, 0n);
      if (BigInt(tx.value) !== want) throw new Error('the forwarder is sent the notes and nothing else here');
      window.__log.fwd.push({ to: tx.to, value: BigInt(tx.value).toString(), pools: d.pools, commitments: d.commitments, selector: tx.data.slice(0, 10) });
      land(d.pools, d.commitments);
      return '0x' + hex(500 + window.__log.fwd.length, 64);
    }
    const p = pools.get(tx.to.toLowerCase());
    if (BigInt(tx.value) !== p.d) throw new Error('value');
    p.seen.add(tx.data.slice(10)); window.__log.sends++; return '0x' + hex(window.__log.sends, 64);
  }
  if (method === 'eth_requestAccounts') return ['${WALLET}'];
  throw new Error('unsupported ' + method);
} };
const status = document.getElementById('status');
const say = (t, cls = '') => { status.textContent = t; status.className = cls; };
let account = null, handle = null;
const env = {
  host: document.getElementById('host'), notesHost: document.getElementById('notes'), amountInput: document.getElementById('amt'),
  chain: { chainId: 1, full: 'Ethereum' }, store: { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) }, workerUrl: '/fixed-pool-worker.js?cb=00000000',
  account: () => account, walletProvider: () => (account ? wallet : null), read, tacitPool: TACIT,
  connect: async () => { account = '${WALLET}'; handle.repaint(); return account; },
  onPlan: (p) => {
    const m = document.getElementById('main');
    if (!p) { m.innerHTML = ''; return; }
    m.innerHTML = '<button class="btn" id="lg-go"></button>';
    const b = m.firstChild;
    b.textContent = account ? p.label : 'Connect wallet';
    b.onclick = () => (account ? env.act(b, async (step, c) => { const r = await p.run(step, c); say(r.text + (r.h ? ' ' + r.h : ''), 'ok'); }) : env.connect());
  },
  // the page's depositRest: the Tacit part, which with a split is sent as the forwarder's one call (the stand-in lands the notes as that transaction would)
  depositRest: async (a, step, c, split) => {
    window.__rest.push(a.toString());
    window.__split = split ? { forwarder: split.forwarder, pools: split.pools.map((p) => p.address), commitments: split.commitments, call: splitDepositCall(split.forwarder, { pA: [0n, 0n], pB: [[0n, 0n], [0n, 0n]], pC: [0n, 0n], publicInputs: Array(11).fill(0n), recipient: '0x' + '00'.repeat(20), extAmount: a, relayer: '0x' + '00'.repeat(20), fee: 0n, memo0: '0x', memo1: '0x' }, split).value.toString() } : null;
    if (window.__restFail) throw new Error('the wallet refused');
    if (split) land(split.pools.map((p) => p.address), split.commitments);
    return '0x' + 'cd'.repeat(32);
  },
  splitCall: async (fwd, tx, split) => splitDepositCall(fwd, tx, split),
  ensureChain: async () => {}, toast: (m, bad) => say(m, bad ? 'err' : ''), errText: (e) => e?.message || String(e),
  say: (t) => say(t, 'ok'), done: (c, h, t) => say(t + ' ' + h, 'ok'),
  depositAddress: async () => '0x00000000000000000000000000000000000b0b01',
  names: async () => ({ resolveName: async () => { throw Object.assign(new Error('none'), { code: 'no-record' }); }, readBox: async () => null }),
  setAmount: (wei) => { const el = document.getElementById('amt'); el.value = wei ? (Number(wei) / 1e18).toString() : ''; el.dispatchEvent(new Event('input')); },
  act: async (btn, fn) => {
    if (window.__log.busy) return;
    window.__log.busy++; btn.setAttribute('aria-busy', 'true');
    try { await fn((m) => say(m[0].toUpperCase() + m.slice(1)), env.chain); } catch (e) { say(e?.message || String(e), 'err'); } finally { window.__log.busy--; btn.removeAttribute('aria-busy'); }
  },
};
handle = attach(env);
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
// a fresh page with the forwarder named (or not) and the stand-in answering as `mode` says
async function open({ named = true, mode = 'ok', amount }) {
  const ctx = await browser.newContext({ viewport: { width: 540, height: 1000 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console ' + m.text()); });
  await page.goto(base + '/__harness.html');
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(([n, m, f]) => { if (n) localStorage.setItem('tacit-split-depositor:1', f); window.__fwdMode = m; }, [named, mode, FWD]);
  await page.fill('#amt', amount);
  await page.click('#lg-go');   // connect
  await page.waitForFunction(() => /^Deposit /.test(document.querySelector('#lg-go')?.textContent || ''));
  return { ctx, page, problems };
}
const status = (page) => page.locator('#status').innerText();
const kept = async (page) => JSON.parse((await page.evaluate((k) => localStorage.getItem(k), NOTES_KEY)) || '[]');

console.log('Split deposit: one transaction');
await test('with the forwarder, 2.5 ETH is one call: the rest goes to the page with the split (two notes and their commitments), no note is sent by itself, and the notes are kept', async () => {
  const { ctx, page, problems } = await open({ amount: '2.5' });
  assert.match(await page.locator('#lg-go').innerText(), /Deposit 2\.5 ETH: 2 whole notes \+ 0\.5/);
  await page.click('#lg-go');
  await page.waitForFunction(() => /all in one transaction/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  assert.match(await status(page), /\(2 ETH\), and 0\.5 ETH went into your private balance, all in one transaction/);
  assert.deepEqual(await page.evaluate(() => window.__rest), ['500000000000000000']);
  const split = await page.evaluate(() => window.__split);
  assert.equal(split.forwarder, FWD);
  assert.equal(split.pools.length, 2); assert.equal(split.commitments.length, 2);
  assert.equal(new Set(split.commitments).size, 2, 'each note has its own commitment');
  assert.ok(split.commitments.every((c) => /^0x[0-9a-f]{64}$/.test(c)));
  assert.equal(split.call, String(2n * 10n ** 18n + 5n * 10n ** 17n), 'the one call carries the notes and the rest');
  assert.equal((await page.evaluate(() => window.__log)).sends, 0, 'no note was sent by itself');
  const k = await kept(page);
  assert.equal(k.length, 2);
  for (const n of k) assert.deepEqual(Object.keys(n).sort(), ['c', 'nh', 'nonce', 'pool'], 'only where the note is and what it is called on chain');
  assert.deepEqual(problems, []);
  await ctx.close();
});
await test('the page failing to send it leaves nothing: none deposited, none kept, no number used, the amount as typed', async () => {
  const { ctx, page } = await open({ amount: '2.5' });
  await page.evaluate(() => { window.__restFail = true; });
  await page.click('#lg-go');
  await page.waitForFunction(() => /None of it was deposited/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  assert.match(await status(page), /None of it was deposited\. the wallet refused If your wallet sent it after all, Find shows the notes once it is mined\./);
  assert.equal((await kept(page)).length, 0);
  assert.equal(await page.inputValue('#amt'), '2.5');
  assert.equal((await page.evaluate(() => window.__log)).sends, 0);
  // and the next try signs for the same first number, since nothing used it
  await page.evaluate(() => { window.__restFail = false; });
  await page.click('#lg-go');
  await page.waitForFunction(() => /all in one transaction/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  assert.deepEqual((await kept(page)).map((n) => n.nonce), [0, 1]);
  await ctx.close();
});
await test('notes only: 3 ETH is one transaction to the forwarder carrying exactly the notes, with each commitment, and nothing goes to the page', async () => {
  const { ctx, page } = await open({ amount: '3' });
  assert.match(await page.locator('#lg-go').innerText(), /^Deposit 3 ETH: 3 whole notes$/);
  await page.click('#lg-go');
  await page.waitForFunction(() => /in one transaction/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  const log = await page.evaluate(() => window.__log);
  assert.equal(log.fwd.length, 1, 'one transaction'); assert.equal(log.sends, 0);
  assert.equal(log.fwd[0].to, FWD); assert.equal(log.fwd[0].value, String(3n * 10n ** 18n));
  assert.equal(log.fwd[0].pools.length, 3); assert.equal(log.fwd[0].commitments.length, 3);
  assert.deepEqual(await page.evaluate(() => window.__rest), [], 'no Tacit part');
  assert.equal((await kept(page)).length, 3);
  assert.match(await status(page), /\(3 ETH\), in one transaction/);
  await ctx.close();
});
await test('the wallet declining the forwarder call (notes only) leaves nothing', async () => {
  const { ctx, page } = await open({ amount: '2' });
  await page.evaluate(() => { window.__fwdReject = true; });
  await page.click('#lg-go');
  await page.waitForFunction(() => /None of it was deposited/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  assert.match(await status(page), /User rejected the request/);
  assert.equal((await kept(page)).length, 0);
  await ctx.close();
});

console.log('Split deposit: where the forwarder cannot be used, the deposit goes as it did');
for (const [mode, why] of [['nocode', 'it has no code'], ['wrongpool', 'it sends to another Tacit pool']]) {
  await test(`a named forwarder is passed over when ${why}: 2 ETH is a transaction for each note`, async () => {
    const { ctx, page } = await open({ mode, amount: '2' });
    await page.click('#lg-go');
    await page.waitForFunction(() => /are in the large pools/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
    const log = await page.evaluate(() => window.__log);
    assert.equal(log.sends, 2); assert.equal(log.fwd.length, 0);
    await ctx.close();
  });
}
await test('a forwarder this stand-in node does not know (the shipped address is the real one, which it never answers for): 2.5 ETH is the notes one at a time, then the rest through the page without a split', async () => {
  const { ctx, page } = await open({ named: false, amount: '2.5' });
  await page.click('#lg-go');
  await page.waitForFunction(() => /0\.5 ETH went into your private balance/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  assert.equal((await page.evaluate(() => window.__log)).sends, 2);
  assert.equal(await page.evaluate(() => window.__split), null, 'the page was asked for no split');
  assert.doesNotMatch(await status(page), /one transaction/);
  await ctx.close();
});
await test('a single note with nothing left over is a plain deposit even with a forwarder', async () => {
  const { ctx, page } = await open({ amount: '1' });
  await page.click('#lg-go');
  await page.waitForFunction(() => /is in the large pool/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  const log = await page.evaluate(() => window.__log);
  assert.equal(log.sends, 1); assert.equal(log.fwd.length, 0);
  await ctx.close();
});

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
