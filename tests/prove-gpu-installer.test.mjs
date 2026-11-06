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
import { spawnSync } from 'node:child_process';
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
