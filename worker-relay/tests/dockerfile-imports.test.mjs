// What a worker-relay image can run is what its Dockerfile COPY lines take from the build context, and the context is the tracked files that the root
// .dockerignore (an allowlist: `*`, then `!` for each path let through) does not leave out. Two ways this has gone wrong, and Render only says so at deploy:
//   - a service imports a dapp file the Dockerfile does not copy (`COPY dapp/*.js` takes the top level only): the image builds and the service exits at once,
//     "Cannot find module '/app/dapp/trade/rpc.js'";
//   - a COPY names a file the .dockerignore leaves out: the build stops, `"/dapp/trade/rpc.js": not found`.
// This follows each entrypoint's imports (static, dynamic with a string, and `path.join(DAPP, 'file.js')`) and checks both.
//   node --test tests/dockerfile-imports.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { ROOT, contextFiles, copyLines, takenBy } from './helpers/docker-context.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const IMPORT = /(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const DAPP_JOIN = /DAPP\s*,\s*['"]([^'"]+\.m?js)['"]/g, DAPP_LITERAL = /['"](?:\.\.\/)+dapp\/([^'"]+\.m?js)['"]/g;

function depsOf(file) {
  if (!existsSync(join(ROOT, file)) || !/\.m?js$/.test(file)) return [];
  const src = read(file), out = [];
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[1] || m[2] || m[3];
    if (spec?.startsWith('.')) out.push(normalize(join(dirname(file), spec.split('?')[0])));      // packages and the browser's absolute paths are not files of the image
  }
  if (file.startsWith('worker-relay/')) for (const re of [DAPP_JOIN, DAPP_LITERAL]) for (const m of src.matchAll(re)) out.push(`dapp/${m[1]}`);
  return out;
}
function chainOf(entry) {
  const seen = new Set(), todo = [entry];
  while (todo.length) { const f = todo.pop(); if (seen.has(f)) continue; seen.add(f); todo.push(...depsOf(f)); }
  return [...seen];
}

// image → what it runs (worker-relay/render.yaml, and the dashboard for the keepers)
const IMAGES = {
  'Dockerfile.pool-maker': ['worker-relay/src/pool-maker.js'],
  'Dockerfile.btc-pool': ['worker-relay/src/btc-pool-indexer.js'],
  'Dockerfile.sats-faucet': ['worker-relay/src/sats-faucet.js', 'worker-relay/src/bridge-recover.js'],
  'Dockerfile.sp-index': ['worker-relay/src/sp-tweak-index.js'],
  'Dockerfile.join-board': ['worker-relay/src/join-board.js'],
  'Dockerfile.evm-pool-keeper': ['worker-relay/src/evm-pool-keeper.js', 'worker-relay/src/evm-pool-keepers.js'],
};
const FILES = contextFiles();

for (const [dockerfile, entries] of Object.entries(IMAGES)) {
  test(`${dockerfile}: every COPY finds its files in the build context`, () => {
    const empty = [];
    for (const { sources } of copyLines(dockerfile)) for (const s of sources) if (!takenBy(s, FILES).length) empty.push(s);
    assert.deepEqual(empty, [], `${dockerfile} copies ${empty.join(', ')}, which the build context does not have (a path the root .dockerignore leaves out needs a "!" line there)`);
  });
  test(`${dockerfile}: every dapp file its services import is copied`, () => {
    const taken = new Set();
    for (const { sources } of copyLines(dockerfile)) for (const s of sources) for (const f of takenBy(s, FILES)) taken.add(f);
    const missing = new Set();
    for (const entry of entries) for (const f of chainOf(entry)) if (f.startsWith('dapp/') && existsSync(join(ROOT, f)) && !taken.has(f)) missing.add(f);
    assert.deepEqual([...missing], [], `${dockerfile} does not take: ${[...missing].join(', ')} (the service exits at start without them)`);
  });
}

test('the context follows Docker: the allowlist lets the top of dapp/ through and leaves the rest out unless a line names it', () => {
  assert.ok(FILES.includes('dapp/tacit.js') && FILES.includes('dapp/vendor/tacit-deps.min.js') && FILES.includes('worker-relay/src/pool-maker.js'));
  assert.ok(!FILES.includes('dapp/swap/card.js') && !FILES.includes('worker-relay/tests/dockerfile-imports.test.mjs'), 'files nothing names are out');
});
test('pool-maker reaches trade/rpc.js through tacit.js and confidential-pool-ux.js', () => {
  const chain = chainOf('worker-relay/src/pool-maker.js');
  for (const f of ['dapp/tacit.js', 'dapp/confidential-pool-ux.js', 'dapp/trade/rpc.js', 'dapp/rpc-body.js']) assert.ok(chain.includes(f), `${f} is in its chain`);
});
