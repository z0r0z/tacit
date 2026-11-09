// The leader's RPC client with several endpoints: it moves on from one that refuses or fails, comes back to the first that answers, and does not
// try another for what is the call's own answer.
//   node tests/tacit-leader-rpc.test.mjs
import assert from 'node:assert';
import { makeRpc } from '../tacit-leader/rpc.mjs';

const seen = [];
const answers = { 'https://a': (m) => ({ error: { code: -32602, message: 'Archive requests require a personal token' } }), 'https://b': (m) => ({ result: '0xb' }), 'https://c': (m) => ({ result: '0xc' }) };
const fetchImpl = async (url, o) => { const m = JSON.parse(o.body).method; seen.push(url); const a = answers[url](m); if (a instanceof Error) throw a; return { json: async () => a }; };
const rpc = makeRpc('https://a, https://b,https://c', { retries: 0, fetchImpl });
assert.equal(await rpc.call('eth_getLogs'), '0xb', 'a refuses (archive): b answers');
assert.deepEqual(seen, ['https://a', 'https://b']);
seen.length = 0;
assert.equal(await rpc.call('eth_blockNumber'), '0xb', 'b is used from then on, a is not asked first again');
assert.deepEqual(seen, ['https://b']);
// b goes down (a network error): c answers
answers['https://b'] = () => new Error('fetch failed');
seen.length = 0;
assert.equal(await rpc.call('eth_blockNumber'), '0xc');
assert.deepEqual(seen, ['https://b', 'https://c']);
// a revert is the call's own answer: thrown, no other endpoint asked
answers['https://c'] = () => ({ error: { code: 3, message: 'execution reverted' } });
seen.length = 0;
await assert.rejects(rpc.call('eth_call'), /execution reverted/);
assert.deepEqual(seen, ['https://c'], 'a revert is not tried elsewhere');
// every endpoint failing throws the last error
answers['https://c'] = () => new Error('down c');
answers['https://a'] = () => new Error('down a');
await assert.rejects(rpc.call('eth_blockNumber'), /down|fetch failed/);
assert.throws(() => makeRpc(' , '), /required/);
console.log('leader rpc: all passed');
