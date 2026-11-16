// walletNode (dapp/eth-nodes.js): the connected wallet is a read node of last resort, never a flood. Its extension answers these reads and shows its sign prompts from one queue, so at most two reads
// are with it at once, counted across every node a page makes; a read over that is left to the public nodes, and a read it never answers frees its place after thirty seconds.
//   node tests/eth-nodes-wallet-cap.test.mjs

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { walletNode } from '../dapp/eth-nodes.js';

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log('  ok - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n' + e.stack); } };
const READ = ['0x0', 'latest'];

await test('at most two reads are with the wallet at once, counted across the nodes a page makes', async () => {
  const waiting = [], wallet = { request: () => new Promise((done, fail) => waiting.push({ done, fail })) };
  const a = walletNode(() => wallet), b = walletNode(() => wallet);
  assert.equal(a.usable('eth_getBalance', READ), true, 'an idle wallet takes a read');
  const first = a.send('eth_getBalance', READ), second = b.send('eth_getLogs', [{}]);
  assert.equal(a.usable('eth_getBalance', READ), false, 'two are with it: no third from the same node');
  assert.equal(b.usable('eth_blockNumber', []), false, 'nor from the page\'s other node: one wallet, one queue');
  waiting.shift().done('0x1'); assert.equal(await first, '0x1');
  assert.equal(b.usable('eth_blockNumber', []), true, 'a place is free again once an answer has come');
  waiting.shift().done('0x2'); assert.equal(await second, '0x2');
  assert.equal(a.usable('eth_getBalance', READ), true);
});

await test('a read the wallet refuses frees its place, and one made with no wallet too', async () => {
  const wallet = { request: async () => { throw new Error('user rejected'); } };
  const node = walletNode(() => wallet);
  await assert.rejects(node.send('eth_getBalance', READ));
  await assert.rejects(node.send('eth_getBalance', READ));
  await assert.rejects(node.send('eth_getBalance', READ));
  assert.equal(node.usable('eth_getBalance', READ), true, 'three refusals in a row leave it as free as before');
  const none = walletNode(() => null);
  for (let i = 0; i < 3; i++) assert.throws(() => none.send('eth_getBalance', READ));
  assert.equal(walletNode(() => wallet).usable('eth_getBalance', READ), true, 'a send with no wallet to ask held nothing');
});

await test('a read the wallet never answers frees its place after thirty seconds', async () => {
  try { mock.timers.enable({ apis: ['setTimeout'] }); } catch { mock.timers.enable(['setTimeout']); }      // Node 22 takes an options object, Node 20 an array
  try {
    const wallet = { request: () => new Promise(() => {}) }, node = walletNode(() => wallet);
    node.send('eth_getLogs', [{}]); node.send('eth_getLogs', [{}]);
    assert.equal(node.usable('eth_getBalance', READ), false, 'two hung reads fill it');
    mock.timers.tick(29e3); assert.equal(node.usable('eth_getBalance', READ), false, 'not yet at 29 seconds');
    mock.timers.tick(2e3); assert.equal(node.usable('eth_getBalance', READ), true, 'free after 30');
  } finally { mock.timers.reset(); }
});

await test('the other rules still hold: no prompt open, only reads, no WalletConnect, no gas-limited call', async () => {
  const wallet = { request: async () => '0x1' }, node = walletNode(() => wallet);
  assert.equal(node.usable('eth_sendTransaction', []), false, 'a send is not a read');
  assert.equal(node.usable('eth_call', [{ gas: '0x5208' }, 'latest']), false, 'a call with its own gas limit is left to the nodes that allow it');
  assert.equal(walletNode(() => ({ ...wallet, isWalletConnect: true })).usable('eth_getBalance', READ), false, 'WalletConnect is a phone, not a node');
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('eth-nodes-wallet-cap: all ok');
