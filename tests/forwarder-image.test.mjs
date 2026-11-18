// The forwarder's image (worker-relay/Dockerfile.evm-pool-forwarder) copies an explicit list of files, so a module the forwarder starts to import has to be added to
// the list or the image cannot load it, which its own build step catches only on Render. This lays the image out as the Dockerfile copies it, in a scratch directory
// without the rest of the repo, and runs the Dockerfile's own load check there.
//   node tests/forwarder-image.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, posix } from 'node:path';
import { spawnSync } from 'node:child_process';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const repo = resolve(new URL('..', import.meta.url).pathname);
const docker = readFileSync(join(repo, 'worker-relay/Dockerfile.evm-pool-forwarder'), 'utf8');

// the image's files: what each COPY puts where, with WORKDIR as it stands
function layOut(root, { without = [] } = {}) {
  let wd = '/';
  for (const raw of docker.split('\n')) {
    const line = raw.trim();
    const w = /^WORKDIR\s+(\S+)/.exec(line);
    if (w) { wd = posix.resolve(wd, w[1]); continue; }
    const c = /^COPY\s+(.+)$/.exec(line);
    if (!c || c[1].startsWith('--')) continue;
    const parts = c[1].trim().split(/\s+/), dest = parts.pop();
    const asDir = parts.length > 1 || dest.endsWith('/');
    const to = posix.resolve(wd, dest);
    for (const src of parts) {
      assert.ok(!/[*?]/.test(src), `${src}: this check reads plain paths`);
      if (without.includes(src)) continue;
      assert.ok(existsSync(join(repo, src)), `the Dockerfile copies ${src}, which is not in the repo`);
      const target = join(root, asDir ? posix.join(to, posix.basename(src)) : to);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(repo, src), target);
    }
  }
  return join(root, 'app/worker-relay');
}
// the Dockerfile's own load check
const smoke = (/^RUN node -e "(.+)"$/m.exec(docker) || [])[1];
assert.ok(smoke, 'the Dockerfile has a load check');
const load = (cwd) => spawnSync(process.execPath, ['-e', smoke], { cwd, encoding: 'utf8' });

await check('laid out as the Dockerfile copies it, the forwarder service and its library load, with the registry routes in', () => {
  const root = mkdtempSync(join(tmpdir(), 'forwarder-image-'));
  try {
    const r = load(layOut(root));
    assert.equal(r.status, 0, r.stderr.split('\n').slice(0, 4).join(' | '));
    assert.match(r.stdout, /forwarder ok/);
    assert.match(smoke, /src\/evm-pool-forwarder\.js/, 'the check loads the service file too, not only the library');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
await check('without a file the forwarder imports, the load check fails (so this test would have caught a missing one)', () => {
  for (const missing of ['worker-relay/src/lib/safe-https.js', 'worker-relay/src/lib/relay-registry-reader.js', 'dapp/evm-pool-open-relays.js', 'dapp/evm-pool-relays.js', 'dapp/sealed-request.js']) {
    const root = mkdtempSync(join(tmpdir(), 'forwarder-image-'));
    try {
      const r = load(layOut(root, { without: [missing] }));
      assert.notEqual(r.status, 0, `${missing} is left out and the image still loads`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
console.log(`\n${n} passed`);
