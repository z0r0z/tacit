// The L1 data fee in the keeper's costs (src/lib/evm-pool-keeper-l1.js): the estimate it builds from a call's bytes, the setting that
// turns it on, and its part in coverCheck / quoteFee / reclaimWorth. The loop and the quote with a chain that has the fee are in
// tests/evm-pool-keeper.test.mjs.
//   node worker-relay/tests/evm-pool-keeper-l1fee.test.mjs

import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { OP_GAS_PRICE_ORACLE, TX_ENVELOPE_BYTES, filler, makeL1Fee, typicalCalldata } from '../src/lib/evm-pool-keeper-l1.js';
import { POOL_ABI, ROUTER_ABI } from '../src/lib/evm-pool-keeper-chain.js';
import { loadKeeperConfig, parseL1Fee } from '../src/lib/evm-pool-keeper-config.js';
import { coverCheck, l1Of, quoteFee, reclaimWorth } from '../src/lib/evm-pool-keeper-loop.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

const POOL = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const ETH = '0x0000000000000000000000000000000000000000';
const addr = (b) => '0x' + b.repeat(20);
const base = { EVM_POOL_ADDR: POOL, EVM_POOL_ROUTER_ADDR: ROUTER, EVM_POOL_RPC_URL: 'http://127.0.0.1:1' };

// the call a wallet relays: a payment (two 65-byte sealed-note memos) or a withdrawal (one)
const transactArgs = (memo0 = 65, memo1 = 65) => [
  [1n, 2n], [[3n, 4n], [5n, 6n]], [7n, 8n], Array.from({ length: 11 }, (_, i) => BigInt(i + 1)),
  addr('11'), -5n, addr('22'), 9n, '0x' + '33'.repeat(memo0), '0x' + '44'.repeat(memo1),
];
const target = (fn) => (fn === 'pool.transact'
  ? { address: POOL, abi: POOL_ABI, functionName: 'transact' }
  : { address: ROUTER, abi: ROUTER_ABI, functionName: fn });

await test('filler: the length asked for, no zero byte, the same every time, and it does not compress', () => {
  const a = filler(1000);
  assert.equal(a.length, 1000);
  assert.ok(!a.includes(0), 'a zero byte is priced as nearly free');
  assert.deepEqual(a, filler(1000), 'a second keeper and a test agree');
  assert.notDeepEqual(a, filler(1000, 'another seed'));
  assert.equal(filler(33).length, 33, 'not only whole 32-byte blocks');
  assert.ok(gzipSync(a).length > 970, 'the oracle prices compressed size: this must look like a proof, not like padding');
});

await test('typicalCalldata is as long as the real call it stands for, and decodes as it', () => {
  const typical = typicalCalldata(target('pool.transact'));
  const real = encodeFunctionData({ abi: POOL_ABI, functionName: 'transact', args: transactArgs() });
  assert.equal(typical.length, real.length, 'a payment: two 65-byte memos');
  const d = decodeFunctionData({ abi: POOL_ABI, data: typical });
  assert.equal(d.functionName, 'transact');
  assert.equal(d.args.length, 10);
  assert.equal(d.args[8].length, 2 + 130, 'a 65-byte memo');
  // the proof and the public inputs are most of the bytes and are full-size words, as a real proof is (ABI padding of the memos and the
  // addresses is zero in a real call too)
  const words = [...d.args[0], ...d.args[1].flat(), ...d.args[2], ...d.args[3]];
  assert.equal(words.length, 2 + 4 + 2 + 11);
  assert.ok(words.every((w) => w > 1n << 200n), 'no small or zero word where a proof has a field element');
  // every router call the keeper sends has a sample (an ABI type the sampler does not know would throw here)
  for (const f of ROUTER_ABI.filter((x) => x.type === 'function' && x.stateMutability !== 'view' && x.stateMutability !== 'pure')) {
    const data = typicalCalldata({ abi: ROUTER_ABI, functionName: f.name });
    assert.equal(decodeFunctionData({ abi: ROUTER_ABI, data }).functionName, f.name, f.name);
  }
  const sweep = decodeFunctionData({ abi: ROUTER_ABI, data: typicalCalldata(target('sweepReceive')) });
  assert.equal(sweep.args.length, 3, 'npk, feeBps, the transaction');
});

await test('makeL1Fee prices the envelope and the calldata, a typical call for a quote and the exact call when it has the arguments', async () => {
  const seen = [];
  const l1 = makeL1Fee({ target, readFee: async (raw) => { seen.push(raw); return BigInt((raw.length - 2) / 2) * 100n; } });
  const typical = await l1('pool.transact');
  const typicalBytes = (typicalCalldata(target('pool.transact')).length - 2) / 2;
  assert.equal(typical, BigInt(TX_ENVELOPE_BYTES + typicalBytes) * 100n, 'envelope plus calldata, per byte here');
  const exact = await l1('pool.transact', transactArgs(65, 200));
  const exactBytes = (encodeFunctionData({ abi: POOL_ABI, functionName: 'transact', args: transactArgs(65, 200) }).length - 2) / 2;
  assert.equal(exact, BigInt(TX_ENVELOPE_BYTES + exactBytes) * 100n, 'the call it was given, not the typical one');
  assert.ok(exact > typical, 'a longer memo costs more');
  assert.ok(seen.every((r) => r.startsWith('0x') && r.slice(2, 2 + TX_ENVELOPE_BYTES * 2).match(/../g).every((b) => b !== '00')), 'the envelope the oracle is told of has no zero byte, so it is priced like a signed transaction');
});

await test('makeL1Fee keeps a typical answer for ttlMs, never an exact one', async () => {
  let t = 1_000_000, reads = 0;
  const l1 = makeL1Fee({ target, readFee: async () => { reads++; return BigInt(reads); }, ttlMs: 10_000, now: () => t });
  assert.equal(await l1('sweepReceive'), 1n);
  assert.equal(await l1('sweepReceive'), 1n, 'within the ttl: one read');
  assert.equal(reads, 1);
  assert.equal(await l1('completeDeposit'), 2n, 'another function is its own answer');
  t += 11_000;
  assert.equal(await l1('sweepReceive'), 3n, 'after the ttl: read again');
  const args = transactArgs();
  assert.equal(await l1('pool.transact', args), 4n);
  assert.equal(await l1('pool.transact', args), 5n, 'an exact call is always read');
});

await test('makeL1Fee: an oracle that fails serves the last typical answer for an hour, and then refuses; with none it refuses at once, never zero', async () => {
  let t = 1_000_000, fail = false;
  const l1 = makeL1Fee({ target, readFee: async () => { if (fail) throw new Error('rpc down'); return 777n; }, ttlMs: 10_000, staleMs: 3_600_000, now: () => t });
  const never = makeL1Fee({ target, readFee: async () => { throw new Error('rpc down'); }, now: () => t });
  await assert.rejects(never('sweepReceive'), /L1 data fee of sweepReceive could not be read: rpc down/);
  await assert.rejects(never('pool.transact', transactArgs()), /could not be read/);
  assert.equal(await l1('sweepReceive'), 777n);
  fail = true;
  t += 60_000;
  assert.equal(await l1('sweepReceive'), 777n, 'a minute later: the last answer');
  assert.equal(await l1('sweepReceive', [1n, 25, { pA: [1n, 2n], pB: [[1n, 2n], [3n, 4n]], pC: [1n, 2n], publicInputs: Array(11).fill(1n), recipient: ETH, extAmount: 1n, relayer: ETH, fee: 1n, memo0: '0x', memo1: '0x' }]), 777n, 'an exact read that fails falls back on the typical answer of the same function');
  t += 3_600_000;
  await assert.rejects(l1('sweepReceive'), /could not be read/, 'after an hour it is an error');
});

await test('EVM_POOL_KEEPER_L1_FEE: off by default; op or 1 is the OP predeploy; an address names an oracle; anything else stops the keeper', () => {
  for (const off of [undefined, '', '0', 'off', 'OFF']) assert.equal(parseL1Fee(off), null, String(off));
  for (const op of ['op', 'OP', '1']) assert.equal(parseL1Fee(op), OP_GAS_PRICE_ORACLE, op);
  assert.equal(OP_GAS_PRICE_ORACLE.toLowerCase(), '0x420000000000000000000000000000000000000f');
  assert.equal(parseL1Fee('0x420000000000000000000000000000000000000f'), OP_GAS_PRICE_ORACLE, 'a lowercase address comes back checksummed');
  assert.match(parseL1Fee('0x' + 'ab'.repeat(20)), /^0x[0-9a-fA-F]{40}$/);
  assert.throws(() => parseL1Fee('yes'), /must be op, 1, 0 or an oracle address, not "yes"/);
  assert.throws(() => parseL1Fee('0x1234'), /must be op/);
  assert.equal(loadKeeperConfig(base).l1FeeOracle, null, 'a chain that sets nothing prices as before');
  assert.equal(loadKeeperConfig({ ...base, EVM_POOL_KEEPER_L1_FEE: 'op' }).l1FeeOracle, OP_GAS_PRICE_ORACLE);
  assert.throws(() => loadKeeperConfig({ ...base, EVM_POOL_KEEPER_L1_FEE: 'yes' }), /EVM_POOL_KEEPER_L1_FEE must be/);
});

await test('coverCheck and quoteFee count the L1 data fee in the cost, and with none they are what they were', () => {
  const cfg = loadKeeperConfig({ ...base, EVM_POOL_KEEPER_MIN_FEES: 'eth:100', EVM_POOL_KEEPER_MARGIN_BPS: '0' });
  // gas 1000 at price 2 = 2000 wei, ETH at 1:1
  assert.equal(quoteFee({ token: ETH, gas: 1000n, gasPrice: 2n, cfg }), 2000n);
  assert.equal(quoteFee({ token: ETH, gas: 1000n, gasPrice: 2n, cfg, l1: 0n }), 2000n);
  assert.equal(quoteFee({ token: ETH, gas: 1000n, gasPrice: 2n, cfg, l1: 5000n }), 7000n, 'gas plus the L1 data fee');
  assert.ok(!coverCheck({ reward: 6999n, token: ETH, gas: 1000n, gasPrice: 2n, cfg, l1: 5000n }).ok, 'a fee that pays the gas but not the L1 fee is refused');
  assert.ok(coverCheck({ reward: 7000n, token: ETH, gas: 1000n, gasPrice: 2n, cfg, l1: 5000n }).ok);
  assert.ok(coverCheck({ reward: 6999n, token: ETH, gas: 1000n, gasPrice: 2n, cfg }).ok, 'with no L1 fee given, the same reward was enough');
  assert.match(coverCheck({ reward: 6999n, token: ETH, gas: 1000n, gasPrice: 2n, cfg, l1: 5000n }).reason, /below the 7000 wei cost/);
  // the margin applies to the whole cost
  const m = { ...cfg, marginBps: 2000n };
  assert.equal(quoteFee({ token: ETH, gas: 1000n, gasPrice: 2n, cfg: m, l1: 5000n }), 8400n, '(2000 + 5000) × 1.2');
  assert.equal(coverCheck({ reward: 8399n, token: ETH, gas: 1000n, gasPrice: 2n, cfg: m, l1: 5000n }).ok, false);
  assert.equal(coverCheck({ reward: 8400n, token: ETH, gas: 1000n, gasPrice: 2n, cfg: m, l1: 5000n }).ok, true);
  // a token with no price is only held to its minimum: the L1 fee has nothing to be priced in, as the gas has not
  const noRate = { ...cfg, rates: new Map(), minFees: new Map([['0x' + '33'.repeat(20), 50n]]) };
  assert.equal(quoteFee({ token: '0x' + '33'.repeat(20), gas: 1000n, gasPrice: 2n, cfg: noRate, l1: 5000n }), 50n);
});

await test('reclaimWorth counts the L1 data fee: sending a box back is worth three times what it costs, all of it', () => {
  const cfg = loadKeeperConfig({ ...base, EVM_POOL_KEEPER_MIN_FEES: 'eth:1', EVM_POOL_KEEPER_MARGIN_BPS: '0' });
  // est 1000 gas at price 2 = 2000; with an L1 fee of 5000 the cost is 7000 and the balance must be 21,000
  assert.ok(reclaimWorth({ bal: 6000n, token: ETH, est: 1000n, price: 2n, cfg }), 'gas alone: 6000 is exactly three times 2000');
  assert.ok(!reclaimWorth({ bal: 20_999n, token: ETH, est: 1000n, price: 2n, cfg, l1: 5000n }));
  assert.ok(reclaimWorth({ bal: 21_000n, token: ETH, est: 1000n, price: 2n, cfg, l1: 5000n }));
});

await test('l1Of: zero for a chain that says nothing, the chain\'s answer otherwise, and an error is passed on, never zero', async () => {
  assert.equal(await l1Of({}, 'sweepReceive'), 0n, 'a chain object with no l1Fee (a test\'s, or one older than this)');
  const calls = [];
  const chain = { l1Fee: async (fn, args) => { calls.push([fn, args]); return args ? 20 : 10; } };
  assert.equal(await l1Of(chain, 'sweepReceive'), 10n);
  assert.equal(await l1Of(chain, 'sweepReceive', [1n]), 20n);
  assert.deepEqual(calls, [['sweepReceive', undefined], ['sweepReceive', [1n]]]);
  await assert.rejects(l1Of({ l1Fee: async () => { throw new Error('no oracle'); } }, 'sweepReceive'), /no oracle/);
});

console.log(`${n} passed`);
