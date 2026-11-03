// A request line that is no URL is answered, never thrown: a service whose handler throws on `GET //` ends its whole process.
//   node --test tests/safe-url.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseUrl, badRequest } from '../src/lib/safe-url.js';

const BAD = ['//', '///', '//[', '//:', '//a:b', '//a b', '/\\'];

test('a request line that is no URL parses to null, and a real one to a URL', () => {
  for (const u of BAD) assert.equal(parseUrl({ url: u }), null, JSON.stringify(u));
  assert.equal(parseUrl({ url: '/health?x=1' }).pathname, '/health');
  assert.equal(parseUrl({ url: '/a' }, 'http://board').host, 'board');
});

test('badRequest answers 400 with a body, and does not throw when the socket is gone', () => {
  let code = null, body = null;
  badRequest({ writeHead: (c) => { code = c; }, end: (b) => { body = b; } });
  assert.equal(code, 400);
  assert.deepEqual(JSON.parse(body), { error: 'bad request' });
  assert.doesNotThrow(() => badRequest({ writeHead: () => { throw new Error('socket closed'); }, end: () => {} }));
});

test('no service parses its request line bare: every `new URL(req.url …` is guarded', () => {
  const bare = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
        if (/new URL\((req|request|r)\.url\b/.test(l) && !/try\s*\{/.test(l) && !l.trim().startsWith('//')) bare.push(`${p}:${i + 1}`);
      });
    }
  };
  walk(new URL('../src', import.meta.url).pathname);
  assert.deepEqual(bare, [], `bare parses of a request line: ${bare.join(', ')}`);
});

test('every service that parses a request line imports the helper from a path that exists', () => {
  const files = ['pool-maker', 'points-indexer', 'sp-tweak-index', 'btc-pool-indexer', 'sats-faucet', 'join-board', 'lib/btc-pool-relayer', 'lib/sp-hints'];
  for (const f of files) {
    const path = new URL(`../src/${f}.js`, import.meta.url);
    const src = readFileSync(path, 'utf8'), spec = /from '(\.[^']*safe-url\.js)'/.exec(src)?.[1];
    assert.ok(spec, `${f} imports the helper`);
    assert.ok(statSync(new URL(spec, path)).isFile(), `${f}: ${spec} resolves`);
    assert.match(src, /parseUrl\(req/, `${f} uses it`);
  }
  // the lib modules have no main of their own, so they load as they are
  return Promise.all(['lib/btc-pool-relayer', 'lib/sp-hints', 'lib/evm-pool-keeper-intake', 'lib/evm-pool-forwarder'].map((f) => import(`../src/${f}.js`)));
});
