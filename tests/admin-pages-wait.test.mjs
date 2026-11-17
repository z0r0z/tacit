// The admin deploy pages (gas relay, proof market, tacit chain, token pools) wait for the receipt of the transaction their wallet sent, by its hash. A speed-up or cancel in the wallet sent
// another at the same nonce and the first hash never confirmed, so the page said "No receipt yet" after the deploy had landed. Their CSP allows no module, so each carries the same short
// copy of dapp/activity.js waitMined. The real source is cut out of each page and run over a fake chain.
//   node --test tests/admin-pages-wait.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chain, whenLooked } from './fake-eth-chain.mjs';

const PAGES = ['gas-relay', 'proof-market', 'tacit-chain', 'token-pools'];
const text = (f) => readFileSync(new URL(`../dapp/admin/${f}/index.html`, import.meta.url), 'utf8');
const cutHelper = (s) => { const a = s.indexOf('async function waitMined('), b = s.indexOf('\n}\n', a); assert.ok(a > 0 && b > a, 'waitMined is in the page'); return s.slice(a, b + 3); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const me = '0x' + 'aa'.repeat(20), to = '0x' + 'bb'.repeat(20);
const call = { to, value: 0, input: '0xdeadbeef' + '00'.repeat(80) };
const orig = { hash: '0x' + '01'.repeat(32), from: me, nonce: 0, ...call }, fast = { hash: '0x' + '02'.repeat(32), from: me, nonce: 0, ...call }, cancel = { hash: '0x' + '03'.repeat(32), from: me, nonce: 0, to: me, value: 0, input: '0x' };
const helper = cutHelper(text('gas-relay')).replaceAll('15000', '10');
const wait = (c, tries = 400) => new Function('sleep', `${helper}\nreturn waitMined;`)(sleep)(c.read, orig.hash, tries, 5);
const pending = () => { const c = chain(); c.send(orig); return c; };

test('every admin page carries the same wait', () => {
  const [first, ...rest] = PAGES.map((f) => cutHelper(text(f)));
  for (const r of rest) assert.equal(r, first);
  assert.ok(readFileSync(new URL('../dapp/admin/tacit-chain/index.src.html', import.meta.url), 'utf8').includes(first), 'and the tacit chain page\'s source');
});
test('a speed-up is the transaction that was waited for; a cancel never ran; a revert is a receipt; the time running out is said', async () => {
  let c = pending(); whenLooked(c, () => { c.mempool.delete(orig.hash); c.mine(fast, 990); });
  assert.equal((await wait(c)).rc.transactionHash, fast.hash);
  c = pending(); whenLooked(c, () => { c.mempool.delete(orig.hash); c.mine(cancel, 990); });
  assert.deepEqual(await wait(c), { replaced: cancel.hash });
  c = pending(); whenLooked(c, () => { c.mempool.delete(orig.hash); c.mine({ ...fast, status: '0x0' }, 990); });
  assert.equal((await wait(c)).rc.status, '0x0');
  c = pending(); c.mine(orig, 999); c.calls.length = 0;
  assert.equal((await wait(c)).rc.transactionHash, orig.hash); assert.deepEqual(c.calls, ['eth_getTransactionReceipt'], 'a transaction that lands at once costs nothing more');
  assert.deepEqual(await wait(pending(), 20), { timeout: true });
});
