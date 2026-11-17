// The wallet the trade, vault, farm, rewards, relay, face and swap pages share (dapp/trade/wallet.js) waits for a receipt by the hash the wallet gave. A speed-up or
// cancel in the wallet sends another transaction at the same nonce and the first hash never confirms: the wait must follow what took its place (the receipt of a speed-up,
// an error for a cancel) and must stay what it was for everything else.
//   node tests/trade-wallet-replaced.test.mjs
import assert from 'node:assert/strict';
import { chain, whenLooked } from './fake-eth-chain.mjs';

const ET = new EventTarget();
globalThis.addEventListener = ET.addEventListener.bind(ET); globalThis.removeEventListener = ET.removeEventListener.bind(ET); globalThis.dispatchEvent = ET.dispatchEvent.bind(ET);
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { makeWallet } = await import('../dapp/trade/wallet.js');
await import('../dapp/activity.js');                                       // (what the wallet loads the first time it is wanted: loaded here, so these short waits do not depend on how busy the machine is)

const me = '0x' + 'aa'.repeat(20), pool = '0x' + 'bb'.repeat(20), later = (ms, f) => new Promise((r) => setTimeout(() => { f(); r(); }, ms));
const call = { to: pool, value: 5, input: '0x1234abcd' + '00'.repeat(200) };
const orig = { hash: '0x' + '01'.repeat(32), from: me, nonce: 0, ...call }, fast = { hash: '0x' + '02'.repeat(32), from: me, nonce: 0, ...call };
const fresh = () => { const c = chain(); const w = makeWallet({ rpc: c.read }); return { c, wait: (o = {}) => w.receipt(orig.hash, { read: c.read, probeMs: 10, every: 5, timeoutMs: 2000, ...o }) }; };

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
  whenLooked(c, () => { c.mempool.delete(orig.hash); c.mine(fast, 990); });
  const r = await wait();
  assert.equal(r.transactionHash, fast.hash, 'the receipt of what took its place'); assert.equal(r.status, '0x1');
}
// the same, with the lookup handed in
{
  const A = await import('../dapp/activity.js');
  const { c, wait } = fresh(); c.send(orig);
  whenLooked(c, () => { c.mempool.delete(orig.hash); c.mine(fast, 990); });
  assert.equal((await wait({ look: A.lookReplaced })).transactionHash, fast.hash);
}
// cancelled (a zero-value send to itself at the nonce): the first never ran, and that is said
{
  const { c, wait } = fresh(); c.send(orig); const cancel = { hash: '0x' + '03'.repeat(32), from: me, nonce: 0, to: me, value: 0, input: '0x' };
  whenLooked(c, () => { c.mempool.delete(orig.hash); c.mine(cancel, 995); });
  await assert.rejects(wait(), (e) => e.replaced === true && e.hash === cancel.hash && /replaced in your wallet/.test(e.message), 'a cancel is not a success');
}
// a replacement that reverted is a revert, as any receipt is (the caller reads its status)
{
  const { c, wait } = fresh(); c.send(orig);
  whenLooked(c, () => { c.mempool.delete(orig.hash); c.mine({ ...fast, status: '0x0' }, 990); });
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

// a wallet on a private mempool: no node holds the transaction it sent, yet the wait follows its speed-up, from what the page asked it to send
{
  const c = chain(), sent = [];
  const w = makeWallet({ rpc: c.read });
  w.state.prov = { request: async ({ method, params }) => { if (method === 'eth_chainId') return '0x1'; if (method === 'eth_sendTransaction') { sent.push(params[0]); return orig.hash; } throw new Error('no ' + method); } };
  w.state.account = me; w.state.chain = '0x1';
  const h = await w.sendTx({ to: call.to, data: call.input, value: BigInt(call.value) });
  assert.equal(h, orig.hash); assert.equal(sent.length, 1);
  await new Promise((r) => setTimeout(r, 30));                                           // (the nonce is read while the wallet is asked)
  setTimeout(() => c.mine(fast, 990), 40);                                               // the speed-up lands: the first hash was never in any node's pool
  const r = await w.receipt(h, { read: c.read, probeMs: 10, every: 5, timeoutMs: 3000 });
  assert.equal(r.transactionHash, fast.hash, 'followed without any node having held the first');
  const other = { hash: '0x' + '0d'.repeat(32), from: me, nonce: 1, to: me, value: 0, input: '0x' };
  const c2 = chain(); c2.mine({ ...other, nonce: 0 }, 990);                              // another transaction at that nonce: not a cancel of this one, as far as can be told
  const w2 = makeWallet({ rpc: c2.read });
  w2.state.prov = { request: async ({ method }) => (method === 'eth_chainId' ? '0x1' : orig.hash) }; w2.state.account = me; w2.state.chain = '0x1';
  await w2.sendTx({ to: call.to, data: call.input, value: BigInt(call.value) }); await new Promise((r2) => setTimeout(r2, 30));
  await assert.rejects(w2.receipt(orig.hash, { read: c2.read, probeMs: 10, every: 5, timeoutMs: 200 }), (e) => !e.replaced && /Sent, not confirmed yet/.test(e.message) && e.seen?.guess === true, 'nothing is concluded; the wait ends as it always did, with the guess kept for a later look');
}
