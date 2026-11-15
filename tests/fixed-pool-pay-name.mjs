// The deposit-address row of the Pay page's exchange-deposit panel (attachName in dapp/fixed-pool-pay.js) in a real browser, on
// a stand-in page that gives it what the Pay page gives it. The owner's primary name can carry the deposit address: the card
// offers one transaction when it does not, says so when it does, and offers nothing when the name does not point at this key
// or the address shown is not the one this key makes. What it publishes is signed with the view key, and checks out.
//   PLAYWRIGHT=<path to playwright-core> node tests/fixed-pool-pay-name.mjs        (SHOTS=<dir> saves screenshots)

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
const { poolAddressOf } = await import('../dapp/tacit-address.js');
const { boxSigOk, boxValue } = await import('../dapp/fixed-pool-box.js');
const { receiveBoxAddress, RECEIVE_FEE_BPS, EVM_POOL_ROUTER } = await import('../dapp/evm-pool-gateway.js');
const { secp, hexToBytes } = await import('../dapp/vendor/tacit-deps.min.js');

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm' };

const keys97 = (v) => { const k = new Uint8Array(97); k.set(secp.getPublicKey(hexToBytes(v.toString(16).padStart(64, '0')), true), 0); k.fill(7, 33); return k; };
const VIEW = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn;
const BOXKEY = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn;
const POOL = poolAddressOf(keys97(VIEW));
const OTHER_POOL = poolAddressOf(keys97(0x0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0badc0ffee0bn));
const THEIR_BOX = receiveBoxAddress(BOXKEY, RECEIVE_FEE_BPS, EVM_POOL_ROUTER);
const WALLET = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

const HARNESS = `<!doctype html><meta charset="utf-8"><title>name</title>
<style>body{font:14px monospace;max-width:520px;margin:20px auto} .btn{display:block;width:100%;padding:10px;margin-top:8px} .kv{display:flex;justify-content:space-between} .note{color:#555} .lbl{display:flex;justify-content:space-between}</style>
<div id="host"></div><div id="status" role="status"></div>
<script type="module">
import { attachName } from '/fixed-pool-pay.js?cb=00000000';
const cfg = () => window.__cfg;
const status = document.getElementById('status');
const say = (t, cls = '') => { status.textContent = t; status.className = cls; };
window.__txs = [];
const env = {
  host: document.getElementById('host'),
  account: () => cfg().account,
  shownBox: () => cfg().shown,
  ownPool: () => cfg().ownPool,
  names: async () => ({
    findPrimary: async () => ({ primary: cfg().primary ? { name: cfg().primary } : null }),
    resolveName: async (name) => { if (!cfg().resolves) { const e = new Error(name + ' has not published a Tacit address.'); e.code = 'no-record'; throw e; } return { name, pool: cfg().namePool }; },
  }),
  publishNames: async () => ({
    planPublishBox: async ({ owner, n, ns }) => { const next = n.toString(16).padStart(64, '0') + ':' + ns; return { name: cfg().primary, owner, current: cfg().published ?? null, next, changed: cfg().published !== next }; },
    publish: async (plan) => { window.__txs.push(plan.next); cfg().published = plan.next; return { skipped: false, txHash: '0x' + 'ab'.repeat(32) }; },
  }),
  boxKey: async () => ({ n: BigInt(cfg().n), v: BigInt(cfg().v), box: cfg().derived }),
  read: async () => async (method) => (method === 'eth_getTransactionReceipt' ? { status: '0x1' } : null),
  act: async (btn, fn) => { btn.setAttribute('aria-busy', 'true'); try { await fn((m) => say(m), { chainId: 1, full: 'Ethereum' }); } catch (e) { say(e?.message || String(e), 'err'); } finally { btn.removeAttribute('aria-busy'); } },
  done: (c, h, t) => say(t + ' ' + h, 'ok'), say: (t) => say(t, 'ok'),
};
window.__mount = () => { window.__handle = attachName(env); };
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
const ctx = await browser.newContext({ viewport: { width: 540, height: 700 } });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console ' + m.text()); });
await page.goto(base + '/__harness.html');
await page.waitForFunction(() => window.__ready === true);
const BASE_CFG = { account: WALLET, primary: 'ross.wei', resolves: true, namePool: POOL, ownPool: POOL, shown: THEIR_BOX, derived: THEIR_BOX, n: '0x' + BOXKEY.toString(16), v: '0x' + VIEW.toString(16), published: null };
const show = async (over = {}) => {
  await page.evaluate((c) => { window.__cfg = c; window.__txs = []; document.getElementById('status').textContent = ''; window.__mount(); }, { ...BASE_CFG, ...over });
  await page.waitForTimeout(400);
  return page.locator('#host').innerText();
};

console.log('deposit address in the name');
await test('a primary name with none published: the card offers one transaction, and what it would publish is signed by the view key', async () => {
  const text = await show();
  assert.match(text, /ross\.wei\s+has none yet/); assert.match(text, /Put this address in ross\.wei/);
  assert.match(text, /makes the address public next to the name/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'name-card.png') });
  await page.click('#lg-pub');
  await page.waitForFunction(() => /now carries your deposit address/.test(document.querySelector('#status').textContent), null, { timeout: 15000 });
  const txs = await page.evaluate(() => window.__txs);
  assert.equal(txs.length, 1);
  const [n, ns] = txs[0].split(':');
  assert.equal(n, BOXKEY.toString(16).padStart(64, '0'));
  assert.equal(boxSigOk(keys97(VIEW).slice(0, 33), n, ns), true, 'the record verifies under the view key of the pool address');
  assert.match(await page.locator('#host').innerText(), /ross\.wei carries this deposit address/);
});
await test('a name that already carries it says so and offers nothing', async () => {
  const { signBox } = await import('../dapp/fixed-pool-box.js');
  const ns = await signBox(VIEW, BOXKEY);
  const text = await show({ published: boxValue(BOXKEY, ns) });
  assert.match(text, /ross\.wei carries this deposit address/);
  assert.equal(await page.locator('#lg-pub').count(), 0);
});
await test('a name that carries another deposit address offers to replace it', async () => {
  const text = await show({ published: boxValue(BOXKEY + 1n, '00'.repeat(64)) });
  assert.match(text, /carries another deposit address/); assert.match(text, /Put this address in ross\.wei/);
});
await test('no primary name, or no wallet: nothing is shown', async () => {
  assert.equal((await show({ primary: null })).trim(), '');
  assert.equal((await show({ account: null })).trim(), '');
});
await test('a name pointing at a different Tacit address is refused: nothing is offered', async () => {
  const text = await show({ namePool: OTHER_POOL });
  assert.match(text, /points to a different Tacit address/); assert.equal(await page.locator('#lg-pub').count(), 0);
});
await test('a name with no Tacit address at all cannot carry a deposit address', async () => {
  const text = await show({ resolves: false });
  assert.match(text, /has not published a Tacit address yet/); assert.equal(await page.locator('#lg-pub').count(), 0);
});
await test('if the address shown is not the one this key makes, nothing is offered', async () => {
  assert.equal((await show({ shown: '0x' + '11'.repeat(20) })).trim(), '');
  assert.equal(await page.locator('#lg-pub').count(), 0);
});
await test('no errors reached the console', async () => { assert.deepEqual(problems, []); });

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
