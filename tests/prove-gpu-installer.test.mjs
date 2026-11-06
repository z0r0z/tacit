// dapp/prove-gpu.sh on cards SP1's GPU server cannot take: run as it is served (piped into `sh -s --`), with stand-ins for uname, ldd,
// ldconfig, nvidia-smi and curl on the PATH and the regular node's installer served from a local file, so nothing here touches this
// machine's GPU, services or the network.
//
// What matters: a card under 24 GB, or older than compute capability 8.0, gets the regular node for the same address instead of a dead
// end; TACIT_GPU_ONLY=1 stops there instead; a 24 GB card of a new enough kind goes past both gates to the worker's download.
//
// Run: node --test tests/prove-gpu-installer.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = readFileSync(new URL('../dapp/prove-gpu.sh', import.meta.url), 'utf8');
const ADDR = '0x1234567890abcdef1234567890abcdef12345678';

function world({ mem, cc = '8.9' }) {
  const dir = mkdtempSync(join(tmpdir(), 'prove-gpu-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const shim = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  shim('uname', 'case "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac');
  shim('ldd', 'echo "ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35"');
  shim('ldconfig', 'exit 1');
  shim('nvidia-smi', `case "$*" in *memory.total*) echo "${mem}" ;; *compute_cap*) echo "${cc}" ;; *memory.used*) echo 10 ;; *) echo ok ;; esac`);
  // the node's installer comes from a file; anything else would be the network, which this test never reaches
  shim('curl', 'case "$*" in *file://*) exec /usr/bin/curl "$@" ;; *) echo "curl: no network here: $*" >&2; exit 22 ;; esac');
  const node = join(dir, 'prove.sh');
  writeFileSync(node, `#!/bin/sh\nprintf 'node installer for %s\\n' "$1" >> "${join(dir, 'node.log')}"\necho "node set up for $1"\n`);
  return { dir, bin, node, log: join(dir, 'node.log') };
}

function run(w, env = {}) {
  return spawnSync('sh', ['-s', '--', ADDR], {
    input: SCRIPT,
    encoding: 'utf8',
    env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.dir, TACIT_GPU_HOME: join(w.dir, '.tacit-gpu'), TACIT_NODE_SCRIPT: `file://${w.node}`, TACIT_PROC_VERSION: '/dev/null', ...env },
  });
}

test('a 16 GB card gets the regular node for the same address', () => {
  const w = world({ mem: 16376 });
  const r = run(w);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /This GPU has 16376 MiB, and a Bitcoin batch needs a 24 GB card\. Setting up the regular node instead/);
  assert.match(r.stdout, /node set up for 0x1234567890abcdef1234567890abcdef12345678/);
  assert.equal(readFileSync(w.log, 'utf8'), `node installer for ${ADDR}\n`);
});

test('TACIT_GPU_ONLY=1 stops instead of setting up the node', () => {
  const w = world({ mem: 12288 });
  const r = run(w, { TACIT_GPU_ONLY: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /This GPU has 12288 MiB/);
  assert.equal(existsSync(w.log), false);
});

test('a 24 GB card older than compute capability 8.0 gets the node too', () => {
  const w = world({ mem: 24576, cc: '7.5' });
  const r = run(w);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /compute capability 7\.5/);
  assert.equal(readFileSync(w.log, 'utf8'), `node installer for ${ADDR}\n`);
});

test('a 24 GB card of a new enough kind goes past both gates to the worker', () => {
  const w = world({ mem: 24576, cc: '8.6' });
  const r = run(w);
  assert.match(r.stdout, /Downloading tacit-prover-worker/);
  assert.equal(existsSync(w.log), false, 'no node installed for a card the GPU lane takes');
});

// ── SP1's Groth16 files: fetched in ranges, resumed where a connection dropped, checked, unpacked and moved into place whole ──
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync, readdirSync, mkdtempSync as mkd } from 'node:fs';

// the fetch function alone, as the installer defines it, with the pins pointed at a payload made here
function circuitsHarness(payload, sha, url) {
  const src = SCRIPT.split('\n');
  const fn = src.slice(src.findIndex((l) => l.startsWith('fetch_circuits() {')), src.findIndex((l, i) => i > src.findIndex((x) => x.startsWith('fetch_circuits() {')) && l === '}') + 1).join('\n');
  return `set -eu
say() { printf '%s\\n' "$*"; }
PIN_CIRCUITS=v6.1.0
PIN_CIRCUITS_BYTES=${payload.length}
PIN_CIRCUITS_SHA256=${sha}
CIRCUITS_URL=${url}
${fn}
fetch_circuits && echo "rc=0" || echo "rc=$?"
`;
}

async function circuitsWorld() {
  const dir = mkd(join(tmpdir(), 'circuits-'));
  const tree = join(dir, 'tree'); mkdirSync(join(tree, 'v'), { recursive: true });
  writeFileSync(join(tree, 'v', 'groth16_pk.bin'), Buffer.alloc(300_000, 7));
  writeFileSync(join(tree, 'v', 'groth16_vk.bin'), 'vk');
  const tgz = join(dir, 'a.tgz');
  execFileSync('tar', ['czf', tgz, '-C', tree, '.']);
  const payload = readFileSync(tgz);
  const hits = { n: 0 };
  // ranges, and every first attempt at a range dies after half of it, so the fetch has to pick up where it stopped
  const seen = new Set();
  const server = http.createServer((req, res) => {
    hits.n++;
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200); return res.end(payload); }
    const [a, b] = [Number(m[1]), Number(m[2])];
    const body = payload.subarray(a, b + 1);
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${payload.length}`, 'content-length': body.length });
    if (!seen.has(m[1]) && body.length > 4) { seen.add(m[1]); res.write(body.subarray(0, body.length >> 1)); setTimeout(() => res.destroy(), 20); return; }
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = join(dir, 'home'); mkdirSync(home);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
  return { dir, payload, sha: createHash('sha256').update(payload).digest('hex'), url: `http://127.0.0.1:${server.address().port}/groth16.tgz`, server, hits, home, bin };
}

// async: the server answering the script's requests lives in this process, which a synchronous spawn would block
function runCircuits(w, { sha = w.sha, extra = {} } = {}) {
  return new Promise((resolve) => {
    const c = spawn('sh', ['-c', circuitsHarness(w.payload, sha, w.url)], { env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home, TACIT_CIRCUITS_PARTS: '4', TACIT_CIRCUITS_POLL: '1', TACIT_CIRCUITS_MIN_GB: '0', ...extra } });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', () => resolve({ stdout, stderr }));
  });
}
const circuitsDir = (w) => join(w.home, '.sp1/circuits/groth16');

test('the Groth16 files are fetched in ranges that pick up after a drop, checked, unpacked and moved into place whole', async () => {
  const w = await circuitsWorld();
  const r = await runCircuits(w);
  w.server.close();
  assert.match(r.stdout, /rc=0/, r.stdout + r.stderr);
  assert.match(r.stdout, /over 4 connections/);
  assert.equal(readFileSync(join(circuitsDir(w), 'v6.1.0/v/groth16_vk.bin'), 'utf8'), 'vk');
  assert.equal(readFileSync(join(circuitsDir(w), 'v6.1.0/v/groth16_pk.bin')).length, 300_000);
  assert.deepEqual(readdirSync(circuitsDir(w)), ['v6.1.0'], 'no part folder left behind');
  assert.equal(existsSync(join(circuitsDir(w), 'v6.1.0/artifacts.tar.gz')), false);
});

test('files that do not match the pin are not used and leave nothing behind', async () => {
  const w = await circuitsWorld();
  const r = await runCircuits(w, { sha: '00'.repeat(32) });
  w.server.close();
  assert.match(r.stdout, /did not match their pin/);
  assert.match(r.stdout, /rc=1/);
  assert.deepEqual(readdirSync(circuitsDir(w)), [], 'neither the folder the worker reads nor a part folder');
});

test('a folder a fetch cut short left (it holds the half-fetched archive) is cleared and fetched again; a finished one is left alone', async () => {
  const w = await circuitsWorld();
  const dest = join(circuitsDir(w), 'v6.1.0');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'artifacts.tar.gz'), 'half');
  const r = await runCircuits(w);
  assert.match(r.stdout, /rc=0/, r.stdout + r.stderr);
  assert.equal(existsSync(join(dest, 'artifacts.tar.gz')), false);
  assert.equal(readFileSync(join(dest, 'v/groth16_vk.bin'), 'utf8'), 'vk');
  const before = w.hits.n;
  const again = await runCircuits(w);
  w.server.close();
  assert.match(again.stdout, /rc=0/);
  assert.equal(w.hits.n, before, 'a finished folder is not fetched again');
});

test('with too little room it says so and leaves the fetch to the worker', async () => {
  const w = await circuitsWorld();
  const r = await runCircuits(w, { extra: { TACIT_CIRCUITS_MIN_GB: '99999999' } });
  w.server.close();
  assert.match(r.stdout, /only \d+ GB are free/);
  assert.match(r.stdout, /rc=1/);
  assert.equal(w.hits.n, 0);
});
