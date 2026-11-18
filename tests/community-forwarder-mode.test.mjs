#!/usr/bin/env node
// `node tools/community-runner.mjs forward` runs a forwarder for the private route: no key, no chain, a health check, and a public address that is https.
//   node tests/community-forwarder-mode.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const free = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const run = (env) => spawn(process.execPath, ['tools/community-runner.mjs', 'forward'], { env: { ...process.env, ...env, RUNNER_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let n = 0; const ok = (m) => { n++; console.log(`ok - ${m}`); };

{ // it listens, answers /health, and needs neither a key nor ETH
  const port = await free(), p = run({ PORT: String(port), FORWARD_URL: '' });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  for (let i = 0; i < 50 && !/listening/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /listening on :\d+, carrying k/);
  const h = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(h.status, 200); assert.deepEqual(await h.json(), { ok: true });
  assert.equal((await fetch(`http://127.0.0.1:${port}/f/nope`, { method: 'POST', body: 'x' })).status, 404, 'an id it does not carry is refused');
  assert.match(out, /keeps nothing and holds no key/);
  p.kill();
  ok('forward listens, answers /health, refuses ids it does not carry, and needs no key');
}
{ // a plain-http public address is refused: a page will not use one
  const p = run({ PORT: String(await free()), FORWARD_URL: 'http://example.test' });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((res) => p.on('exit', res));
  assert.equal(code, 2); assert.match(err, /must be https/);
  ok('forward refuses a plain-http FORWARD_URL');
}
console.log(`${n} passed`);
