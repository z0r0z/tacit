// A request body read as JSON with a size limit (src/lib/http-json.js), through a real server.
//   node worker-relay/tests/http-json.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readJson } from '../src/lib/http-json.js';

const server = createServer(async (req, res) => {
  try { res.end(JSON.stringify({ got: await readJson(req, 100) })); }
  catch (e) { res.statusCode = e.status || 500; if (e.status === 413) res.setHeader('Connection', 'close'); res.end(JSON.stringify({ error: e.message })); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const post = async (body) => { const r = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } }); return [r.status, await r.json().catch(() => null)]; };

assert.deepEqual(await post('{"a":1}'), [200, { got: { a: 1 } }]);
assert.deepEqual((await post('not json'))[0], 400);
assert.deepEqual((await post(''))[0], 400, 'an empty body is not JSON');
assert.deepEqual((await post(JSON.stringify({ pad: 'x'.repeat(500) })))[0], 413, 'a body past the limit is refused');
assert.deepEqual(await post('{"b":2}'), [200, { got: { b: 2 } }], 'and the server carries on');
console.log('ok - a body is read as JSON up to its limit; a larger one is 413 and one that is not JSON is 400');
server.close();
process.exit(0);
