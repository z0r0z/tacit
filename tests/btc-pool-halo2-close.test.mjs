// A halo2 system that is done is closed: its worker ends, and nothing else holds it. A later call starts a new worker.
//   node tests/btc-pool-halo2-close.test.mjs
import assert from 'node:assert/strict';
import { makeHalo2System, HALO2_PROOF_LEN } from '../dapp/btc-pool-halo2-prover.js';

const PIN = 'ab'.repeat(64);
const workers = [];
// A worker that answers like halo2-worker.js: init → the key's digest, prove → a proof of the right length.
const makeWorker = () => {
  const w = { terminated: false, inits: 0, proves: 0, onmessage: null, onerror: null,
    postMessage({ op, id }) {
      if (w.terminated) return;
      queueMicrotask(() => {
        if (op === 'init') { w.inits++; w.onmessage({ data: { id, ok: true, vkDigest: PIN } }); }
        else if (op === 'prove') { w.proves++; w.onmessage({ data: { id, ok: true, out: JSON.stringify({ proof: '00'.repeat(HALO2_PROOF_LEN), publics: Array(12).fill('1') }) } }); }
      });
    },
    terminate() { w.terminated = true; } };
  workers.push(w);
  return w;
};

const system = makeHalo2System({ wasm: new Uint8Array([1]), params: new Uint8Array([2]), vk: new Uint8Array([3]), pinnedVkHash: PIN, worker: makeWorker });

const a = await system.prove({});
assert.equal(a.wire.length, HALO2_PROOF_LEN);
assert.equal(workers.length, 1);
assert.equal(workers[0].terminated, false, 'a worker lives while its system is in use');

system.close();
assert.equal(workers[0].terminated, true, 'closing ends the worker');

// Used again, it starts a new worker and checks the key again.
const b = await system.prove({});
assert.equal(b.wire.length, HALO2_PROOF_LEN);
assert.equal(workers.length, 2);
assert.equal(workers[1].inits, 1);
system.close();
assert.equal(workers[1].terminated, true);

// Closing a system that never started a worker, or twice, does nothing.
const idle = makeHalo2System({ wasm: new Uint8Array([1]), params: new Uint8Array([2]), vk: new Uint8Array([3]), pinnedVkHash: PIN, worker: makeWorker });
idle.close(); idle.close();
assert.equal(workers.length, 2, 'no worker was started for it');

// In process (no worker) there is nothing to end.
const local = makeHalo2System({ wasm: new Uint8Array([1]), params: new Uint8Array([2]), vk: new Uint8Array([3]), pinnedVkHash: PIN, worker: null });
local.close();

console.log('btc-pool-halo2-close: all checks passed');
