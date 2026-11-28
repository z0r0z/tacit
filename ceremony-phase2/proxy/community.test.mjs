import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handleCommunity } from './community.mjs';

const listen = async (fn) => {
  const s = createServer(fn).listen(0, '127.0.0.1');
  await new Promise((ok) => s.once('listening', ok));
  return { server: s, url: `http://127.0.0.1:${s.address().port}` };
};
const close = (s) => new Promise((ok) => s.close(ok));

test('a signed queue place receives bounded tiers from current holdings', async () => {
  const token = 'ab'.repeat(16), address = '0x' + '12'.repeat(20);
  let upgrade = null, precompile = null;
  const upstream = await listen(async (req, res) => {
    if (req.url === '/api/slot') {
      if (req.headers['x-ceremony-token'] !== token) { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ahead":4,"state":"waiting"}');
    }
    if (req.url === '/api/community') {
      let raw = ''; for await (const c of req) raw += c;
      upgrade = { headers: req.headers, body: JSON.parse(raw) };
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ahead":1,"state":"waiting"}');
    }
    res.writeHead(404); res.end('{}');
  });
  let calls = 0;
  const rpc = await listen(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const j = JSON.parse(raw); let result;
    if (j.method === 'web3_sha3') result = '0x' + 'aa'.repeat(32);
    else if (j.params[0].to.toLowerCase().endsWith('01')) { precompile = j.params[0].data; result = '0x' + '00'.repeat(12) + address.slice(2); }
    else result = calls++ < 2 ? '0x1' : '0x0';
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
  const proxy = await listen((req, res) => handleCommunity(req, res, { upstream: upstream.url, cors: {}, rpcURL: rpc.url, priorityKey: 'private-key', enabled: true }));
  try {
    const headers = { 'x-ceremony-token': token };
    const challenge = await fetch(proxy.url + '/api/community/challenge', { method: 'POST', headers }).then((r) => r.json());
    assert.match(challenge.message, /cannot move funds/);
    assert.match(challenge.message, /Queue: [0-9a-f]{64}/);
    const signature = '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b';
    const response = await fetch(proxy.url + '/api/community/verify', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ address, signature }) });
    const out = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(out.signals, ['tac', 'wei']);
    assert.equal(out.level, 2, 'two or three signals are capped at tier two');
    assert.equal(upgrade.headers['x-ceremony-priority-key'], 'private-key');
    assert.deepEqual(upgrade.body, { supporter: address, level: 2, signals: ['tac', 'wei'] });
    assert.equal(precompile, '0x' + 'aa'.repeat(32) + '1b'.padStart(64, '0') + '11'.repeat(32) + '22'.repeat(32));
    const replay = await fetch(proxy.url + '/api/community/verify', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ address, signature }) });
    assert.equal(replay.status, 409, 'a challenge is one-shot');
  } finally { await Promise.all([close(proxy.server), close(rpc.server), close(upstream.server)]); }
});
