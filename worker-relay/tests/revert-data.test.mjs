// lib/revert-data.js: a settle's revert selector from the error or from public nodes, and an op's own expiry.
//   node worker-relay/tests/revert-data.test.mjs
import { selectorIn, revertSelector, opExpiry } from '../src/lib/revert-data.js';

let fails = 0;
const ok = (c, m) => { if (c) console.log('  ok -', m); else { fails++; console.log('  FAIL -', m); } };

// The error chain's own data wins, at any depth, and the signature viem prints is read too.
ok(selectorIn({ cause: { cause: { data: '0x203D82D8' } } }) === '0x203d82d8', 'a selector deep in the cause chain is found, lower-cased');
ok(selectorIn({ message: 'The contract function "settle" reverted with the following signature:\n0x8a98f245' }) === '0x8a98f245', 'the signature viem prints is read');
ok(selectorIn({ shortMessage: 'Execution reverted for an unknown reason.' }) === null, 'a revert with no data names none');

// A node that drops the data: public nodes are asked the same call, and the first that names a selector answers.
const call = { from: '0x7a0F0511E1DcF399C2F7bbe8414b6a0D1ABc4331', to: '0x000000000Ed1eabD231Be41d93b719056F7febFC', data: '0x717fd7f2' };
const asked = [];
const fetchImpl = async (url, init) => {
  asked.push([url, JSON.parse(init.body)]);
  if (url === 'a') throw new Error('down');
  if (url === 'b') return { json: async () => ({ error: { code: 3, message: 'execution reverted' } }) };
  return { json: async () => ({ error: { code: 3, message: 'execution reverted', data: '0x203d82d8' } }) };
};
const sel = await revertSelector({ shortMessage: 'Execution reverted for an unknown reason.' }, call, { rpcs: ['a', 'b', 'c', 'd'], fetchImpl });
ok(sel === '0x203d82d8' && asked.length === 3, `the first node that names it answers, past a node that is down and one with no data (${sel}, ${asked.length} asked)`);
ok(asked[2][1].method === 'eth_call' && asked[2][1].params[0].to === call.to && asked[2][1].params[0].data === call.data && asked[2][1].params[1] === 'latest', 'the same call is asked at the latest block');
asked.length = 0;
ok(await revertSelector({ data: '0xb115d857' }, call, { rpcs: ['c'], fetchImpl }) === '0xb115d857' && asked.length === 0, 'a selector the error carries needs no node');
ok(await revertSelector({}, call, { chainId: 8453, rpcs: ['c'], fetchImpl }) === null && asked.length === 0, 'off mainnet, the public mainnet nodes are not asked');
ok(await revertSelector({}, call, { rpcs: ['b'], fetchImpl }) === null, 'no node naming one leaves it unnamed');

// The op's own expiry: the deadline the guest gates settle on, only for the types whose deadline means that.
ok(opExpiry({ type: 'unwrap', op: { deadline: '1792000800' } }) === 1792000800, 'an unwrap\'s deadline is its expiry');
ok(opExpiry({ type: 'wrapswap', op: { opDeadline: '1792000800', deadline: '5' } }) === 1792000800, 'opDeadline is read first where both ride');
ok(opExpiry({ type: 'unwrap', op: { deadline: '0' } }) === 0 && opExpiry({ type: 'unwrap', op: {} }) === 0, 'zero or absent: no expiry');
ok(opExpiry({ type: 'stealthrefund', op: { deadline: '1700000000' } }) === 0, 'a refund\'s deadline (valid only after it) is never read as an expiry');
ok(opExpiry({ type: 'bridgemint', op: { deadline: '1700000000' } }) === 0 && opExpiry(null) === 0, 'nor any type outside the list');

// A settle's failed ack carries the revert's selector as " (0x…)", on every path that acks one, for the pages to turn into words. The path of a batch member the chain refused
// (settleOne) dropped it, and a swap that lost a race to a trade read "Execution reverted for an unknown reason." where the pool had said why.
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/settle-relay.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function settleOne('));
  const ack = fn.slice(fn.indexOf('const sel = '), fn.indexOf('abandoned.remember'));
  ok(/e\.revertSelector/.test(ack) && /\$\{sel\}/.test(ack) && /confidentialAck\(/.test(ack), 'a refused batch member\'s ack carries the revert\'s selector');
}

if (fails) { console.log(`${fails} revert-data check(s) FAILED`); process.exit(1); }
console.log('all revert-data checks passed');
