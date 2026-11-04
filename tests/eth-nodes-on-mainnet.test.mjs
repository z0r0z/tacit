// onMainnet (dapp/eth-nodes.js): the wallet a page opened its key with is a last-resort node only while it is on Ethereum mainnet, its chain read
// once and again when it changes; a page with no wallet, or one without a request method, has none.
//   node tests/eth-nodes-on-mainnet.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { onMainnet, walletNode } from '../dapp/eth-nodes.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
function wallet(chain) {
  const fns = new Set(), w = { chain, asked: 0, request: async ({ method }) => { if (method === 'eth_chainId') { w.asked++; return '0x' + w.chain.toString(16); } return '0x1'; }, on: (e, f) => { if (e === 'chainChanged') fns.add(f); }, switchTo: (c) => { w.chain = c; fns.forEach((f) => f('0x' + c.toString(16))); } };
  return w;
}

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log('  ok - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n' + e.stack); } };

await test('a wallet on mainnet is used, one on another chain is not, and a change of chain is followed', async () => {
  const w = wallet(8453);
  let current = w;
  const get = onMainnet(() => current);
  assert.equal(get(), null, 'nothing before its chain is known');
  await tick();
  assert.equal(get(), null, 'on Base it is not a mainnet node');
  w.switchTo(1); await tick();
  assert.equal(get(), w, 'switched to mainnet, it is');
  assert.equal(w.asked, 2, 'its chain was read once, and again on the change, not on every call');
  get(); get(); assert.equal(w.asked, 2);
  w.switchTo(10); await tick();
  assert.equal(get(), null, 'and not once it leaves');
  current = null; assert.equal(get(), null, 'no wallet, no node');
  current = { notAProvider: true }; assert.equal(get(), null);
});

await test('as a node, the wallet takes the reads it is asked for only while it is on mainnet', async () => {
  const w = wallet(1), node = walletNode(onMainnet(() => w));
  assert.equal(node.usable('eth_getStorageAt', ['0x0', '0x0', 'latest']), false, 'not before its chain is read');
  await tick();
  assert.equal(node.usable('eth_getStorageAt', ['0x0', '0x0', 'latest']), true);
  assert.equal(await node.send('eth_blockNumber', []), '0x1');
});

console.log(failed ? `\n${failed} failed` : '\nall eth-nodes onMainnet checks passed');
process.exit(failed ? 1 : 0);
