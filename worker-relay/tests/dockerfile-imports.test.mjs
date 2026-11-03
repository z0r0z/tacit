// Every image that runs a worker-relay service copies the dapp files by name (`COPY dapp/*.js` takes the top level only), so a service whose import chain
// reaches a dapp file the Dockerfile does not copy builds, deploys, and exits at once: "Cannot find module '/app/dapp/trade/rpc.js'". This follows each
// entrypoint's imports (static, dynamic with a string, and `path.join(DAPP, 'file.js')`) and checks that each dapp file in them is one the image copies.
//   node --test tests/dockerfile-imports.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
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
// the sources of the Dockerfile's COPY lines, as patterns on repo paths (a `*` stays inside one directory)
function copiedBy(dockerfile) {
  const pats = [];
  for (const line of read(`worker-relay/${dockerfile}`).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('COPY') || t.includes('--from')) continue;
    for (const src of t.split(/\s+/).slice(1, -1)) pats.push(new RegExp(`^${src.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`));
  }
  return pats;
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

for (const [dockerfile, entries] of Object.entries(IMAGES)) {
  test(`${dockerfile} copies every dapp file its services import`, () => {
    const pats = copiedBy(dockerfile), missing = new Set();
    for (const entry of entries) for (const f of chainOf(entry)) if (f.startsWith('dapp/') && existsSync(join(ROOT, f)) && !pats.some((re) => re.test(f))) missing.add(f);
    assert.deepEqual([...missing], [], `${dockerfile} does not copy: ${[...missing].join(', ')} (add a COPY for each; the service exits at start without them)`);
  });
}

test('the follower finds what it should: pool-maker reaches trade/rpc.js through tacit.js and confidential-pool-ux.js', () => {
  const chain = chainOf('worker-relay/src/pool-maker.js');
  for (const f of ['dapp/tacit.js', 'dapp/confidential-pool-ux.js', 'dapp/trade/rpc.js', 'dapp/rpc-body.js']) assert.ok(chain.includes(f), `${f} is in its chain`);
});
