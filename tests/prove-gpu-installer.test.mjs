// dapp/prove-gpu.sh on cards SP1's GPU server cannot take: run as it is served (piped into `sh -s --`), with stand-ins for uname, ldd,
// ldconfig, nvidia-smi and curl on the PATH and the regular node's installer served from a local file, so nothing here touches this
// machine's GPU, services or the network.
//
// What matters: a card under 16 GB, or older than compute capability 8.0, gets the regular node for the same address instead of a dead
// end; TACIT_GPU_ONLY=1 stops there instead; a card of 16 GB or more of a new enough kind goes past both gates to the worker's download;
// a card under 24 GB also gets the pinned smaller GPU server and the settings that size its proofs to its memory, and takes no batches.
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

// nvidia-smi as a machine with these cards would answer: the list of (index, memory) and, per card (--id=N), its compute capability
function smiShim(cards) {
  const list = cards.map((c, i) => `${i}, ${c.mem}`).join('\\n');
  const ccs = cards.map((c, i) => `*--id=${i}*compute_cap*) echo "${c.cc}" ;;`).join(' ');
  return `case "$*" in *index,memory.total*) printf '${list}\\n' ;; ${ccs} *memory.used*) echo 10 ;; *) echo ok ;; esac`;
}

function world({ mem, cc = '8.9', cards = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'prove-gpu-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const shim = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  shim('uname', 'case "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac');
  shim('ldd', 'echo "ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35"');
  shim('ldconfig', 'exit 1');
  shim('nvidia-smi', smiShim(cards || [{ mem, cc }]));
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

test('a 12 GB card gets the regular node for the same address', () => {
  const w = world({ mem: 12288 });
  const r = run(w);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /This GPU has 12288 MiB, and SP1's GPU prover needs a 16 GB card\. Setting up the regular node instead/);
  assert.match(r.stdout, /node set up for 0x1234567890abcdef1234567890abcdef12345678/);
  assert.equal(readFileSync(w.log, 'utf8'), `node installer for ${ADDR}\n`);
});

test('TACIT_GPU_ONLY=1 stops instead of setting up the node', () => {
  const w = world({ mem: 8192 });
  const r = run(w, { TACIT_GPU_ONLY: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /This GPU has 8192 MiB/);
  assert.equal(existsSync(w.log), false);
});

test('a 16 GB card of a new enough kind goes past both gates to the worker', () => {
  const w = world({ mem: 16376, cc: '8.6' });
  const r = run(w);
  assert.match(r.stdout, /Downloading tacit-prover-worker/);
  assert.equal(existsSync(w.log), false, 'no node installed for a card the GPU lane takes');
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

// ── The whole install against a release served here: the worker, and for a card under 24 GB the smaller GPU server, each checked ──
const pinOf = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(SCRIPT)[1];

async function releaseWorld({ mem, cc = '8.6', cards = null, serverBytes = null }) {
  const dir = mkd(join(tmpdir(), 'prove-gpu-release-'));
  const home = join(dir, 'home'); mkdirSync(home);
  // the Groth16 files already in place, so the fetch is skipped
  mkdirSync(join(home, '.sp1/circuits/groth16', pinOf('PIN_CIRCUITS')), { recursive: true });
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const shim = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  shim('uname', 'case "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac');
  shim('ldd', 'echo "ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35"');
  shim('ldconfig', 'exit 1');
  shim('nvidia-smi', smiShim(cards || [{ mem, cc }]));
  shim('sha256sum', 'exec shasum -a 256 "$@"');
  shim('setsid', 'exec "$@"');
  // the worker as served: it writes down what it was started with and ends the loop around it
  const worker = Buffer.from(`#!/bin/sh\nenv > "${join(dir, 'worker-env.txt')}"\nkill -9 $PPID 2>/dev/null\nexit 0\n`);
  const server = serverBytes || Buffer.from('#!/bin/sh\necho 6.3.1\n');
  const files = { '/prover-bins-v18/tacit-prover-worker': worker, '/prover-bins-v18/sp1-gpu-server-lowmem': server };
  const hits = [];
  const http_ = http.createServer((req, res) => { hits.push(req.url); const b = files[req.url]; if (!b) { res.writeHead(404); return res.end(); } res.writeHead(200); res.end(b); });
  await new Promise((r) => http_.listen(0, '127.0.0.1', r));
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const script = SCRIPT
    .replace(/^BASE=.*$/m, `BASE="http://127.0.0.1:${http_.address().port}"`)
    .replace(/^PIN_TAG=.*$/m, 'PIN_TAG=prover-bins-v18')
    .replace(/^PIN_WORKER=.*$/m, `PIN_WORKER=${sha(worker)}`)
    .replace(/^PIN_SERVER_LOWMEM=.*$/m, `PIN_SERVER_LOWMEM=${sha(Buffer.from('#!/bin/sh\necho 6.3.1\n'))}`);
  return { dir, home, bin, server, http: http_, hits, script, gpuHome: join(home, '.tacit-gpu') };
}

function install(w) {
  return new Promise((resolve) => {
    // TACIT_GPU_ONLY: a card that would get the regular node stops instead of fetching it
    const c = spawn('sh', ['-s', '--', ADDR], { env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home, TACIT_GPU_HOME: w.gpuHome, TACIT_PROC_VERSION: '/dev/null', TACIT_GPU_ONLY: '1' } });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr }));
    c.stdin.end(w.script);
  });
}

// the worker's environment once run.sh has started it
async function startedWith(w) {
  const f = join(w.dir, 'worker-env.txt');
  for (let i = 0; i < 50 && !existsSync(f); i++) await new Promise((r) => setTimeout(r, 100));
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

test('a 16 GB card gets the pinned smaller server and its pool-only settings', async () => {
  const w = await releaseWorld({ mem: 16376 });
  const r = await install(w);
  const env = await startedWith(w);
  w.http.close();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Downloading SP1's GPU server for a card under 24 GB/);
  assert.deepEqual(readFileSync(join(w.home, '.sp1/bin/sp1-gpu-server')), w.server, 'where the SDK looks for it');
  assert.match(r.stdout, /This card proves the pool's wraps \(a Bitcoin batch needs 24 GB\)/);
  assert.match(env, /^BTC_STATE=0$/m);
  assert.match(env, new RegExp(`^SP1_GPU_ELEMENT_THRESHOLD=${pinOf('SHARD_16GB')}$`, 'm'));
  assert.match(env, /^SP1_GPU_MIN_GB=16$/m);
  assert.match(env, new RegExp(`^POOL_LEASE_FILE=${w.gpuHome}/pool-lease.json$`, 'm'));
  assert.match(env, new RegExp(`^COMMUNITY_MINER=${ADDR}$`, 'm'));
  assert.match(env, /^POOL_EVERY_SECS=10$/m);
});

test('a 20 GB card proves the pool\'s wraps too', async () => {
  const w = await releaseWorld({ mem: 20470 });
  const r = await install(w);
  const env = await startedWith(w);
  w.http.close();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(env, new RegExp(`^SP1_GPU_ELEMENT_THRESHOLD=${pinOf('SHARD_16GB')}$`, 'm'));
  assert.match(env, /^BTC_STATE=0$/m);
});

test('a 24 GB card keeps the stock server and its batches', async () => {
  const w = await releaseWorld({ mem: 24576 });
  const r = await install(w);
  const env = await startedWith(w);
  w.http.close();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(w.hits.includes('/prover-bins-v18/sp1-gpu-server-lowmem'), false);
  assert.equal(existsSync(join(w.home, '.sp1/bin/sp1-gpu-server')), false, 'the worker\'s SDK fetches the stock one');
  assert.match(r.stdout, /Bitcoin batches the relay takes from it earn that address TAC/);
  assert.doesNotMatch(env, /^BTC_STATE=/m);
  assert.doesNotMatch(env, /^SP1_GPU_/m);
  assert.match(env, /^POOL_LEASE_FILE=/m);
});

test('a smaller server that does not match its pin is not installed and nothing is started', async () => {
  const w = await releaseWorld({ mem: 16376, serverBytes: Buffer.from('#!/bin/sh\necho tampered\n') });
  const r = await install(w);
  w.http.close();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the server's sha256 is [0-9a-f]{64}, not the pinned/);
  assert.equal(existsSync(join(w.home, '.sp1/bin/sp1-gpu-server')), false);
  assert.equal(existsSync(join(w.home, '.sp1/bin/sp1-gpu-server.part')), false);
  assert.equal(existsSync(join(w.gpuHome, 'run.sh')), false);
});

test('on a machine with two cards the one with the most memory proves, and only it is checked', async () => {
  const w = await releaseWorld({ cards: [{ mem: 8192, cc: '7.5' }, { mem: 24576, cc: '8.9' }] });
  const r = await install(w);
  const env = await startedWith(w);
  w.http.close();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(env, /^GPU_DEVICE=1$/m);
  assert.match(env, /^CUDA_DEVICE_ORDER=PCI_BUS_ID$/m);
  assert.doesNotMatch(env, /^BTC_STATE=/m, 'the 24 GB card takes batches');
  assert.doesNotMatch(r.stdout, /compute capability/, 'the small old card is not the one checked');
});

test('a single card proves as card 0', async () => {
  const w = await releaseWorld({ mem: 16376 });
  const r = await install(w);
  const env = await startedWith(w);
  w.http.close();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(env, /^GPU_DEVICE=0$/m);
});
