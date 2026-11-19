// dapp/sealed-input.js: a sealed input opens only with the worker's key, carries what was sealed, and picks a live keyed
// worker. Run: node --test tests/sealed-input.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { sealTo, unsealWith, pickWorker, SEALED_DOMAIN } from '../dapp/sealed-input.js';

const workerPriv = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const workerPub = '0x' + Buffer.from(secp.getPublicKey(workerPriv, true)).toString('hex');

test('seal to a worker, open with its key; another key fails; the ciphertext differs per call', async () => {
  const stdin = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 255);
  const sealed = await sealTo({ secp, pubkey: workerPub, stdin });
  assert.match(sealed.epk, /^0x0[23][0-9a-f]{64}$/);
  assert.equal(Buffer.from(sealed.iv, 'base64').length, 12);
  assert.equal(Buffer.from(sealed.ct, 'base64').length, stdin.length + 16);
  const back = await unsealWith({ secp, priv: workerPriv, sealed });
  assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(stdin)), 0);
  const other = Uint8Array.from({ length: 32 }, (_, i) => 99 - i);
  await assert.rejects(unsealWith({ secp, priv: other, sealed }));
  const again = await sealTo({ secp, pubkey: workerPub, stdin });
  assert.notEqual(again.ct, sealed.ct);
  assert.equal(SEALED_DOMAIN, 'tacit-sealed-input-v1');
});

test('a tampered ciphertext or iv does not open; bad keys and inputs are refused', async () => {
  const stdin = new Uint8Array([1, 2, 3]);
  const sealed = await sealTo({ secp, pubkey: workerPub, stdin });
  const ct = Buffer.from(sealed.ct, 'base64'); ct[0] ^= 1;
  await assert.rejects(unsealWith({ secp, priv: workerPriv, sealed: { ...sealed, ct: ct.toString('base64') } }));
  await assert.rejects(sealTo({ secp, pubkey: '0x04' + 'aa'.repeat(64), stdin }), /compressed/);
  await assert.rejects(sealTo({ secp, pubkey: workerPub, stdin: 'nope' }), /input bytes/);
});

test('pickWorker: a live keyed worker, the preferred name or prefix first', () => {
  const s = { workers: [
    { name: 'alice', pubkey: workerPub, lastSeenSeconds: 3 },
    { name: 'tacit-a5000', pubkey: workerPub, lastSeenSeconds: 1 },
    { name: 'tacit-old', pubkey: workerPub, lastSeenSeconds: 900 },
    { name: 'nokey', lastSeenSeconds: 0 },
  ] };
  assert.equal(pickWorker(s).name, 'tacit-a5000');
  assert.equal(pickWorker(s, { prefer: 'alice' }).name, 'alice');
  assert.equal(pickWorker({ workers: [{ name: 'tacit-old', pubkey: workerPub, lastSeenSeconds: 900 }] }), null);
  assert.equal(pickWorker(null), null);
});

test('pickWorker: a worker polling now is chosen over one that has gone quiet (restarting its GPU server), whatever its name', () => {
  const two = (a, b) => ({ workers: [{ name: 'tacit-a5000', pubkey: workerPub, lastSeenSeconds: a }, { name: 'tacit-b5000', pubkey: workerPub, lastSeenSeconds: b }] });
  assert.equal(pickWorker(two(1, 2)).name, 'tacit-a5000', 'both polling: the first of equal preference, as before');
  assert.equal(pickWorker(two(20, 1)).name, 'tacit-b5000', 'the first has been quiet 20 s (a restart): the second takes it');
  assert.equal(pickWorker(two(2, 25)).name, 'tacit-a5000', 'and the other way round');
  assert.equal(pickWorker(two(12, 25)).name, 'tacit-a5000', 'neither polling: the one seen most recently');
  assert.equal(pickWorker(two(40, 25)).name, 'tacit-b5000', 'one past the half minute is not live at all');
  assert.equal(pickWorker({ workers: [{ name: 'tacit-a5000', pubkey: workerPub, lastSeenSeconds: 20 }] }).name, 'tacit-a5000', 'a single worker, quiet but live, is still the answer: nothing else to seal to');
  assert.equal(pickWorker({ workers: [{ name: 'alice', pubkey: workerPub, lastSeenSeconds: 1 }, { name: 'tacit-a5000', pubkey: workerPub, lastSeenSeconds: 20 }] }).name, 'alice', 'a polling worker beats a preferred one that is restarting');
});
