// The wallet the trade, vault, farm, rewards, relay, face and swap pages share (dapp/trade/wallet.js) waits for a receipt by the hash the wallet gave. A speed-up or
// cancel in the wallet sends another transaction at the same nonce and the first hash never confirms: the wait must follow what took its place (the receipt of a speed-up,
// an error for a cancel) and must stay what it was for everything else.
//   node tests/trade-wallet-replaced.test.mjs
import assert from 'node:assert/strict';
import { chain } from './fake-eth-chain.mjs';

const ET = new EventTarget();
globalThis.addEventListener = ET.addEventListener.bind(ET); globalThis.removeEventListener = ET.removeEventListener.bind(ET); globalThis.dispatchEvent = ET.dispatchEvent.bind(ET);
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { makeWallet } = await import('../dapp/trade/wallet.js');

const me = '0x' + 'aa'.repeat(20), pool = '0x' + 'bb'.repeat(20), later = (ms, f) => new Promise((r) => setTimeout(() => { f(); r(); }, ms));
const call = { to: pool, value: 5, input: '0x1234abcd' + '00'.repeat(200) };
const orig = { hash: '0x' + '01'.repeat(32), from: me, nonce: 0, ...call }, fast = { hash: '0x' + '02'.repeat(32), from: me, nonce: 0, ...call };
const fresh = () => { const c = chain(); const w = makeWallet({ rpc: c.read }); return { c, wait: (o = {}) => w.receipt(orig.hash, { read: c.read, probeMs: 10, every: 5, timeoutMs: 600, ...o }) }; };

// mined by itself, quickly: its own receipt, and nothing asked beyond receipts
{
  const { c, wait } = fresh(); c.send(orig); later(8, () => c.mine(orig, 999));
  const r = await wait({ probeMs: 1000 });
  assert.equal(r.transactionHash, orig.hash); assert.ok(c.calls.every((m) => m === 'eth_getTransactionReceipt'), 'a transaction that lands soon costs no more reads than before');
}
// slow, then mined by itself: the probes learn who sent it and find nothing replacing it
{
  const { c, wait } = fresh(); c.send(orig); later(60, () => c.mine(orig, 999));
  const r = await wait(); assert.equal(r.transactionHash, orig.hash);
  assert.ok(c.calls.includes('eth_getTransactionByHash'), 'it was looked at while it waited');
}
// sped up: the same call at a higher fee takes the nonce; the wait gives that receipt (the lookup is the page's own: loaded from activity.js the first time it is wanted)
{
  const { c, wait } = fresh(); c.send(orig);
  later(40, () => { c.mempool.delete(orig.hash); c.mine(fast, 990); });
  const r = await wait();
  assert.equal(r.transactionHash, fast.hash, 'the receipt of what took its place'); assert.equal(r.status, '0x1');
}
// the same, with the lookup handed in
{
  const A = await import('../dapp/activity.js');
  const { c, wait } = fresh(); c.send(orig);
  later(40, () => { c.mempool.delete(orig.hash); c.mine(fast, 990); });
  assert.equal((await wait({ look: A.lookReplaced })).transactionHash, fast.hash);
}
// cancelled (a zero-value send to itself at the nonce): the first never ran, and that is said
{
  const { c, wait } = fresh(); c.send(orig); const cancel = { hash: '0x' + '03'.repeat(32), from: me, nonce: 0, to: me, value: 0, input: '0x' };
  later(40, () => { c.mempool.delete(orig.hash); c.mine(cancel, 995); });
  await assert.rejects(wait(), (e) => e.replaced === true && e.hash === cancel.hash && /replaced in your wallet/.test(e.message), 'a cancel is not a success');
}
// a replacement that reverted is a revert, as any receipt is (the caller reads its status)
{
  const { c, wait } = fresh(); c.send(orig);
  later(40, () => { c.mempool.delete(orig.hash); c.mine({ ...fast, status: '0x0' }, 990); });
  assert.equal((await wait()).status, '0x0');
}
// never mined and never replaced: the wait ends as it always did
{
  const { c, wait } = fresh(); c.send(orig);
  await assert.rejects(wait({ timeoutMs: 120 }), (e) => /Sent, not confirmed yet\. Check it on Etherscan before sending anything again\./.test(e.message) && !e.replaced);
  const { c: c2, wait: wait2 } = fresh(); c2.send(orig);
  await assert.rejects(wait2({ timeoutMs: 120, where: 'the Base explorer' }), /the Base explorer/);
}
// nodes that cannot answer the extra reads leave the wait as it was
{
  const { c, wait } = fresh(); c.send(orig); const real = c.read;
  c.read = async (m, p) => { if (m !== 'eth_getTransactionReceipt') throw new Error('not served'); return real(m, p); };
  later(60, () => c.mine(orig, 999));
  assert.equal((await wait({ read: c.read })).transactionHash, orig.hash);
}
console.log('ok');
