// What a V2- or V3-style pool really took in from a swap (src/lib/pool-swap-input.js), against real logs from the chain.
//   node worker-relay/tests/pool-swap-input.test.mjs
//
// The attack this closes (on Base): a helper flash-loaned 5 WETH, had zRouter send it to a Uniswap V2 pair, and
// took it straight back with the pair's skim() in the same transaction. The pair never swapped, so it emitted no Swap
// event, and the transfer into it was all the scorer saw. The logs below are real: the attack's own receipt, a mainnet
// V2 swap (a route that comes back through the same pair), a Base V3 swap and a Base Aerodrome V2 swap.

import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { wethPaidIntoPool } from '../src/lib/pool-swap-input.js';

const FIX = {"v2_mainnet":{"chain":1,"tx":"0xb0c31e0831cd22e2ad77a77a007433bd27b34675a64baf1ced35fce4c4131ae1","pool":"0x52c77b0cb827afbad022e6d6caf2c44452edbc39","wethIsToken0":true,"expected":"50000000000000000","logs":[{"address":"0x52c77b0cb827afbad022e6d6caf2c44452edbc39","topics":["0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822","0x000000000000000000000000000000000000fb114709235f1ccbffb925f600e4","0x0000000000000000000000002819bac791627e5c5ae5048017145b226f51941d"],"data":"0x00000000000000000000000000000000000000000000000000b1a2bc2ec500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006f2e79905"},{"address":"0x52c77b0cb827afbad022e6d6caf2c44452edbc39","topics":["0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822","0x00000000000000000000000000000000e91fc5bad977c0cc4ad60557c06886a2","0x00000000000000000000000000000000e91fc5bad977c0cc4ad60557c06886a2"],"data":"0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003707720620000000000000000000000000000000000000000000000000057650651cd43ad0000000000000000000000000000000000000000000000000000000000000000"}]},"v3_base":{"chain":8453,"tx":"0xe233ffe081b15806bd2b9ec87dfb969ca4a2eae2232e259fdd685416a72b3f0c","pool":"0x20e068d76f9e90b90604500b84c7e19dcb923e7e","wethIsToken0":true,"expected":"2550000000000000000","logs":[{"address":"0x20e068d76f9e90b90604500b84c7e19dcb923e7e","topics":["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67","0x000000000000000000000000000000000000fb114709235f1ccbffb925f600e4","0x00000000000000000000000072f2a5698e949e67b7f41526f581f59b90713322"],"data":"0x00000000000000000000000000000000000000000000000023636b7d513f0000ffffffffffffffffffffffffffffffffffffffffffffffffe3ae0f807a933e5a0000000000000000000000000000000000000000e50456b7a5368b0a61a6c7290000000000000000000000000000000000000000000009745485caa48ff64817fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff74c"}]},"aero_base":{"chain":8453,"tx":"0xfeac3bb4eb4764841d912c2e394e603433ce3d8132ce73c85d8502b4a6dff4f0","pool":"0xa6385c73961dd9c58db2ef0c4eb98ce4b60651e8","wethIsToken0":true,"expected":"387500000000000000","logs":[{"address":"0xa6385c73961dd9c58db2ef0c4eb98ce4b60651e8","topics":["0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b","0x000000000000000000000000000000000000fb114709235f1ccbffb925f600e4","0x000000000000000000000000000000000000fb114709235f1ccbffb925f600e4"],"data":"0x0000000000000000000000000000000000000000000000000560ad326a76c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a1d787fecb819"}]},"attack":{"chain":8453,"tx":"0xcd04ae599ffb7fd23c41125ba9f3e4f54a9649d42ae423488c9b31e35de10e4e","pool":"0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c","logs":[{"address":"0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb","topics":["0xc76f1b4fe4396ac07a9fa55a415d4ca430e72651d37d3401f3bed7cb13fc4f12","0x000000000000000000000000ea96d2f85195732294d77149ddbc9e77bdbee46a","0x0000000000000000000000004200000000000000000000000000000000000006"],"data":"0x0000000000000000000000000000000000000000000000004563918244f40000"},{"address":"0x4200000000000000000000000000000000000006","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000bbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb","0x000000000000000000000000ea96d2f85195732294d77149ddbc9e77bdbee46a"],"data":"0x0000000000000000000000000000000000000000000000004563918244f40000"},{"address":"0x4200000000000000000000000000000000000006","topics":["0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65","0x000000000000000000000000ea96d2f85195732294d77149ddbc9e77bdbee46a"],"data":"0x0000000000000000000000000000000000000000000000004563918244f40000"},{"address":"0x4200000000000000000000000000000000000006","topics":["0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c","0x000000000000000000000000000000000000fb114709235f1ccbffb925f600e4"],"data":"0x0000000000000000000000000000000000000000000000004563918244f40000"},{"address":"0x4200000000000000000000000000000000000006","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000000000000000fb114709235f1ccbffb925f600e4","0x00000000000000000000000088a43bbdf9d098eec7bceda4e2494615dfd9bb9c"],"data":"0x0000000000000000000000000000000000000000000000004563918244f40000"},{"address":"0x4200000000000000000000000000000000000006","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x00000000000000000000000088a43bbdf9d098eec7bceda4e2494615dfd9bb9c","0x000000000000000000000000ea96d2f85195732294d77149ddbc9e77bdbee46a"],"data":"0x0000000000000000000000000000000000000000000000004563918244f40000"},{"address":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x00000000000000000000000088a43bbdf9d098eec7bceda4e2494615dfd9bb9c","0x000000000000000000000000ea96d2f85195732294d77149ddbc9e77bdbee46a"],"data":"0x0000000000000000000000000000000000000000000000000000000000000000"},{"address":"0x4200000000000000000000000000000000000006","topics":["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925","0x000000000000000000000000ea96d2f85195732294d77149ddbc9e77bdbee46a","0x000000000000000000000000bbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"],"data":"0x0000000000000000000000000000000000000000000000004563918244f40000"},{"address":"0xea96d2f85195732294d77149ddbc9e77bdbee46a","topics":["0xc200a1f31dd659e356e0f112c82558e25f49f7b0f84438691cd96f5cb3558823","0x000000000000000000000000bbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"],"data":"0x0000000000000000000000000000000000000000000000004563918244f40000"},{"address":"0x4200000000000000000000000000000000000006","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x000000000000000000000000ea96d2f85195732294d77149ddbc9e77bdbee46a","0x000000000000000000000000bbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"],"data":"0x0000000000000000000000000000000000000000000000004563918244f40000"},{"address":"0xea96d2f85195732294d77149ddbc9e77bdbee46a","topics":["0x45f53a160f2f017654e52425dd9dd12e110f776e4f829df4549fab2b28aada53","0x000000000000000000000000bc1c08a3f8fbc731f1c01d490391e8a152444a16","0x00000000000000000000000088a43bbdf9d098eec7bceda4e2494615dfd9bb9c","0x0000000000000000000000000000000000000000000000000000000000000001"],"data":"0x0000000000000000000000000000000000000000000000004563918244f40000"}]}};

{
  const { logs, pool } = FIX.attack;
  assert.ok(logs.some((l) => l.address.toLowerCase() === '0x4200000000000000000000000000000000000006'), 'the receipt really holds WETH logs');
  assert.equal(wethPaidIntoPool(logs, pool, true), 0n);
  assert.equal(wethPaidIntoPool(logs, pool, false), 0n);
  console.log('ok - the real skim attack: the pair emitted no Swap, so nothing was paid in on either side');
}

for (const [name, what] of [['v2_mainnet', 'Uniswap V2 (a route that returns through the same pair)'], ['v3_base', 'Uniswap V3'], ['aero_base', 'Aerodrome V2']]) {
  const f = FIX[name];
  assert.equal(wethPaidIntoPool(f.logs, f.pool, f.wethIsToken0), BigInt(f.expected), name);
  assert.notEqual(wethPaidIntoPool(f.logs, f.pool, !f.wethIsToken0), BigInt(f.expected), name + ': the other side of the pool is not WETH, so which side it is has to be read from the pool');
  const elsewhere = f.logs.map((l) => ({ ...l, address: '0x' + 'ab'.repeat(20) }));
  assert.equal(wethPaidIntoPool(elsewhere, f.pool, f.wethIsToken0), 0n, name + ': a Swap log written by another address is no proof for the pool');
  console.log('ok - a real ' + what + ' swap counts what it took in (' + f.expected + ' wei) from the WETH side only');
}

{
  const f = FIX.v2_mainnet;
  const first = f.logs[0];
  assert.equal(wethPaidIntoPool([first, first], f.pool, f.wethIsToken0), 2n * BigInt(f.expected), 'swaps on the one pool add up');
  console.log('ok - several swaps through one pool add up');
}

{
  const pool = '0x' + '11'.repeat(20), me = '0x' + '22'.repeat(20);
  const v2 = { type: 'event', name: 'Swap', inputs: [{ type: 'address', name: 'sender', indexed: true }, { type: 'uint256', name: 'amount0In' }, { type: 'uint256', name: 'amount1In' }, { type: 'uint256', name: 'amount0Out' }, { type: 'uint256', name: 'amount1Out' }, { type: 'address', name: 'to', indexed: true }] };
  const log = (a0, a1) => ({ address: pool, topics: encodeEventTopics({ abi: [v2], args: { sender: me, to: me } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [a0, a1, 0n, 1n]) });
  assert.equal(wethPaidIntoPool([log(7n, 0n)], pool, true), 7n, 'a tiny swap shows a tiny amount: stray WETH sent around it earns no more');
  assert.equal(wethPaidIntoPool([log(7n, 0n)], pool, false), 0n);
  assert.equal(wethPaidIntoPool([log(0n, 9n)], pool, false), 9n);
  console.log('ok - the credit is the amount the Swap event shows, however much more WETH was sent');
}

{
  // V3 amounts are signed from the pool's side: WETH that left the pool in a swap is negative and is not paid in.
  const pool = '0x' + '33'.repeat(20), me = '0x' + '22'.repeat(20);
  const v3 = { type: 'event', name: 'Swap', inputs: [{ type: 'address', name: 'sender', indexed: true }, { type: 'address', name: 'recipient', indexed: true }, { type: 'int256', name: 'amount0' }, { type: 'int256', name: 'amount1' }, { type: 'uint160', name: 'sqrtPriceX96' }, { type: 'uint128', name: 'liquidity' }, { type: 'int24', name: 'tick' }] };
  const log = (a0, a1) => ({ address: pool, topics: encodeEventTopics({ abi: [v3], args: { sender: me, recipient: me } }), data: encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [a0, a1, 1n, 1n, 0]) });
  assert.equal(wethPaidIntoPool([log(-5n * 10n ** 18n, 9n)], pool, true), 0n, 'WETH paid out of the pool is not paid in');
  assert.equal(wethPaidIntoPool([log(-5n * 10n ** 18n, 9n)], pool, false), 9n, 'the same swap read from the other side');
  assert.equal(wethPaidIntoPool([log(3n, -9n), log(-1n, 4n)], pool, true), 3n, 'only the paid-in legs of a pool add up');
  console.log('ok - a V3 swap that paid WETH out counts nothing, and only the paid-in legs add up');
}

{
  const f = FIX.v3_base;
  const sync ={ address: f.pool, topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'], data: '0x' + '00'.repeat(64) };
  const broken = { ...f.logs[0], data: '0x1234' };
  assert.equal(wethPaidIntoPool([sync, broken, ...f.logs], f.pool, f.wethIsToken0), BigInt(f.expected), 'other events and malformed data are skipped');
  assert.equal(wethPaidIntoPool([], f.pool, true), 0n);
  console.log('ok - other events from the pool, malformed data and no logs at all count nothing and throw nothing');
}
