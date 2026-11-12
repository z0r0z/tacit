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
// an endpoint that answers with a web page (a gateway error page) is passed over like one that is down, and said as that: its status, its
// domain, never its path (a key lives there)
{
  const page = (status) => ({ status, json: async () => { throw new SyntaxError('Unexpected token \'<\', "<!doctype "... is not valid JSON'); } });
  const urls = ['https://one.example.com/v2/KEYONE1234567890abcdef', 'https://two.example.org/KEYTWO1234567890abcdef', 'https://three.example.net/KEYTHREE1234567890abcdef'];
  const hit = [];
  const fetchPages = async (url, o) => { hit.push(url); if (url === urls[2]) return { status: 200, json: async () => ({ result: '0x3' }) }; return page(url === urls[0] ? 502 : 429); };
  const r1 = makeRpc(urls.join(','), { retries: 0, fetchImpl: fetchPages });
  assert.equal(await r1.call('eth_blockNumber'), '0x3', 'two endpoints answering with a web page: the third answers');
  assert.deepEqual(hit, urls, 'each was asked once, in order');
  const allPages = makeRpc(urls.join(','), { retries: 0, fetchImpl: async () => page(502) });
  const err = await allPages.call('eth_getLogs').then(() => null, (e) => e);
  assert.ok(err, 'every endpoint failing throws');
  assert.match(err.message, /answered eth_getLogs with a web page, not JSON \(HTTP 502\)/, 'said as a web page with its status, not as a parse error');
  assert.ok(!/Unexpected token/.test(err.message));
  assert.deepEqual(err.attempts.map((a) => a.split(':')[0]), ['example.com', 'example.org', 'example.net'], 'each endpoint named by its domain, in the order asked');
  assert.ok(!/KEY(ONE|TWO|THREE)/.test(JSON.stringify(err.attempts) + err.message), 'no path or key in what is reported');
}
assert.throws(() => makeRpc(' , '), /required/);
console.log('leader rpc: all passed');
