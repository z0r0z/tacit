// The eth-state sidecar's read of what is pending and confirmed: an API that refuses is a refusal, not "nothing pending, nothing confirmed"
// (2026-11-05: a 500/502 made the sidecar drop its in-flight candidate, prove another on the network and lose the publish race to the first).
// Offline: node --test worker-relay/tests/eth-state-read.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let handler = () => {};
const server = createServer((req, res) => handler(req, res)).listen(0);
await new Promise((r) => server.once('listening', r));
process.env.RPC_URL = 'http://127.0.0.1:1';
process.env.RELAY_KEY = '0x' + '11'.repeat(32);
process.env.BOX_TOKEN = 'test-box-token';
process.env.WORKER_BASE = `http://127.0.0.1:${server.address().port}`;
const { reflectionEthState } = await import('../src/lib/worker-client.js');
test.after(() => { server.closeAllConnections?.(); server.close(); });

const reply = (status, body) => (req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body == null ? '<html>bad gateway</html>' : JSON.stringify(body)); };

test('a refused read says so, with its status', async () => {
  handler = reply(502, null);
  assert.deepEqual(await reflectionEthState(), { unavailable: 502 });
  handler = reply(500, { error: 'internal error' });
  assert.deepEqual(await reflectionEthState(), { unavailable: 500 });
});

test('an answer is passed through, a pending of null included', async () => {
  const body = { network: 'mainnet', confirmed: { contentHash: '0xab' }, pending: null };
  handler = reply(200, body);
  const got = await reflectionEthState();
  assert.deepEqual(got, body);
  assert.equal(got.unavailable, undefined);
});
