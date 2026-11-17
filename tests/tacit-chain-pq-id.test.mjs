// A PQ ID against the leader's node, with real Halo2 proofs: a wallet with notes under its Tacit key's chain keys takes a root no published key
// leads to; a payer of its unchanged Tacit address reaches the new keys, which the Tacit key alone cannot read; notes under the old keys move over
// in the free input slot of the next spends (one spend proving an old note beside a new one); a device without the root does not replace the key's
// record, and takes the root only from the passkey it was made with.
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-chain-pq-id.test.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeHalo2System } from '../dapp/btc-pool-halo2-prover.js';
import { assetField, worthOf } from '../dapp/tacit-chain-wallet.js';
import { makeChainClient } from '../dapp/tacit-chain-client.js';
import { keepRoot, keptRoot } from '../dapp/tacit-chain-lane.js';
import { secp } from '../dapp/vendor/tacit-deps.min.js';

const T = 100_000_000n;
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const D = join(HERE, '../dapp/btc-pool/');
const PORT = 19800 + Math.floor(Math.random() * 90);
const LEADER = `http://127.0.0.1:${PORT}`;
const BLOCKS = '0x00000000000000000000000000000000000b10c5';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const sel = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4)).toString('hex');
const pin = JSON.parse(readFileSync(D + 'pin.json', 'utf8'));
const system = () => makeHalo2System({ wasm: readFileSync(D + pin.wasm), params: readFileSync(D + pin.params), vk: readFileSync(D + pin.vk), pinnedVkHash: pin.vk_hash, worker: null });
const asset = assetField(Uint8Array.from([...new Array(12).fill(0), ...bytes(TAC)]));
const assetHex = '0x' + asset.toString(16).padStart(64, '0');
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };

// the device vault: the root comes back only under the key it was sealed with, and not from a changed record
{
  const s = store(), k = new Uint8Array(32).fill(0x11), r = new Uint8Array(32).fill(0x77);
  assert.equal(keptRoot(k, s), null, 'nothing kept yet');
  keepRoot(k, r, 'cred', s);
  assert.deepEqual(keptRoot(k, s), { root: r, credentialId: 'cred' });
  assert.equal(keptRoot(new Uint8Array(32).fill(0x12), s), null, 'another key has none');
  const [name, v] = [...s.m.entries()][0], j = JSON.parse(v);
  assert.ok(!v.includes(Buffer.from(r).toString('hex')), 'the root is not kept in the clear');
  s.setItem(name, JSON.stringify({ ...j, w: (j.w[0] === '0' ? '1' : '0') + j.w.slice(1) }));
  assert.equal(keptRoot(k, s), null, 'a changed record gives nothing');
}

const server = spawn(BIN, ['serve', '1', `${BLOCKS}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TACIT_NODE_ASSET: assetHex } });
const api = async (method, path, body) => { const r = await fetch(LEADER + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, ...(await r.json()) }; };
async function landBlock() {
  for (let i = 0; i < 100 && !(await api('GET', '/mempool')).spends.length; i++) await new Promise((r) => setTimeout(r, 300));
  const b = await api('POST', '/build', { time: Math.floor(Date.now() / 1000), queue: [] });
  assert.ok(b.ok, b.error);
  const pv = bytes(b.publicValues);
  const words = Array.from({ length: pv.length / 32 }, (_, i) => hx(pv.subarray(32 * i, 32 * i + 32)));
  const leaves = b.lists.leaves.length > 2 ? b.lists.leaves.slice(2).match(/.{64}/g).map((x) => '0x' + x) : [];
  const memos = b.lists.memos.length > 2 ? b.lists.memos.slice(2).match(/.{2304}/g).map((x) => '0x' + x) : [];
  assert.ok((await api('POST', '/landed', { words, leaves, memos, nullifiers: b.lists.nullifiers })).ok);
  return b;
}
const go = (p) => Promise.all([p, landBlock()]).then(([x]) => x);
const pq = async (c) => { const s = await c.pqState(); assert.equal(s.olderUnits > 0n, s.older > 0n, 'what the old keys hold is valued'); return { on: s.on, elsewhere: s.elsewhere, older: s.older, credentialId: s.credentialId }; };

try {
  for (let i = 0; i < 60; i++) { try { await fetch(LEADER + '/state'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const { chain } = await api('GET', '/state');
  const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const rpcCall = async (m, [{ data }]) => {
    if (data.startsWith('0x' + sel('CHAIN()'))) return chain;
    if (data.startsWith('0x' + sel('TAC_ASSET()'))) return assetHex;
    if (data.startsWith('0x' + sel('pool()'))) return word((await api('GET', '/state')).pool);
    if (data.startsWith('0x' + sel('shares()'))) return word((await api('GET', '/state')).shares);
    throw new Error('unexpected call');
  };
  const cfg = { blocks: BLOCKS, leader: LEADER };
  const ALICE = new Uint8Array(32).fill(0x11), ROOT = new Uint8Array(32).fill(0x77), OTHER_ROOT = new Uint8Array(32).fill(0x78);
  const aliceStore = store();
  const alice = makeChainClient({ cfg, rpcCall, priv: ALICE, system, storage: aliceStore });
  const bob = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x22), system, storage: store() });
  const aliceKey = secp.getPublicKey(ALICE, true);

  // Before: Alice holds two notes under the chain keys made from her Tacit key, and her key's record names that address
  await go((await alice.shield(1000n * T)).submit());
  await go((await bob.shield(600n * T)).submit());
  await go((await alice.shield(200n * T)).submit());
  await go((await alice.shield(120n * T)).submit());
  await alice.publish(); await bob.publish();
  const oldLane = await alice.lane(), oldAddr = await alice.address();
  const lanes = { btc: { spendPub: aliceKey }, evm: { ownerPub: aliceKey }, chain: { hash: oldLane } };   // her Tacit address, as it stays
  assert.deepStrictEqual(await bob.recipientOf(lanes), oldAddr);
  const held0 = await alice.scan();
  assert.deepEqual(await pq(alice), { on: false, elsewhere: false, older: 0n, credentialId: null });

  // A PQ ID: new chain keys, the key's record names them, the old notes still hers
  const pqAddr = await alice.harden(ROOT, 'cred-a');
  assert.notDeepStrictEqual(pqAddr, oldAddr);
  assert.deepStrictEqual(await alice.address(), pqAddr);
  assert.equal(await alice.scan(), held0, 'the notes from before are still counted');
  assert.deepEqual(await pq(alice), { on: true, elsewhere: false, older: held0, credentialId: 'cred-a' });
  assert.deepStrictEqual(await bob.recipientOf(lanes), pqAddr, 'a payer of the same Tacit address reaches the PQ ID');

  // Bob pays her Tacit address: the note is sealed to the PQ ID's keys, which her Tacit key alone cannot open
  await go(bob.pay(await bob.recipientOf(lanes), 250n * T));
  const held1 = await alice.scan();
  assert.ok(held1 > held0 && (await alice.pqState()).older === held0, 'the payment is under the PQ ID');
  const keyOnly = makeChainClient({ cfg, rpcCall, priv: ALICE, system, root: null, storage: store() });
  assert.equal(await keyOnly.scan(), held0, 'from the Tacit key alone only the notes from before can be read');

  // A small payment (old notes 1,000, 200 and 120, a PQ ID note of 250): the smallest old note covers it, and the 200 rides in the free slot (it is
  // not one of the two largest left free, so the next payment can spend as much as before); both are gone after, the change under the PQ ID
  const bobAddr = await alice.recipientOf({ btc: { spendPub: secp.getPublicKey(new Uint8Array(32).fill(0x22), true) } });
  const olderBefore = (await alice.pqState()).older;
  await go(alice.pay(bobAddr, 50n * T));
  await alice.scan();
  const left = (await alice.pqState()).older;
  assert.ok(left > olderBefore / 2n && left < olderBefore * 4n / 5n, `two old notes went in one spend, the 1,000 stays (${left} of ${olderBefore})`);
  assert.equal(await keyOnly.scan(), left, 'the Tacit key alone reads only the old note left');

  // A payment the old note cannot cover alone: it is proved beside a PQ ID note, in one proof
  const before = alice.balance();
  await go(alice.pay(bobAddr, 1200n * T));
  await alice.scan();
  assert.equal((await alice.pqState()).older, 0n, 'the old note was spent beside a PQ ID note');
  assert.equal(await keyOnly.scan(), 0n, 'and the Tacit key alone reads nothing of hers');
  assert.ok(alice.balance() < before, 'the payment went');

  // Someone still paying her old chain address (by its lane, as a client from before this would): the note is found under the old keys, and moved
  // to the PQ ID at once on request
  await go(bob.pay(await bob.resolve(oldLane), 40n * T));
  await alice.scan();
  const older = (await alice.pqState()).older;
  assert.ok(older > 0n, 'a payment to the old address is still hers');
  const before2 = alice.balance();
  await go(alice.moveOlder());
  await alice.scan();
  assert.equal((await alice.pqState()).older, 0n, 'moved to the PQ ID');
  assert.ok(alice.balance() < before2 && alice.balance() > before2 - older, 'and she lost only the pool share');

  // Another device: without the root it reads the old keys only and does not replace the key's record; it takes the root only from her passkey
  const device = makeChainClient({ cfg, rpcCall, priv: ALICE, system, storage: store() });
  assert.equal(await device.publish(), null, 'the record is left as it is');
  assert.deepEqual((await device.pqState()).elsewhere, true, 'and the device knows there is a PQ ID to open');
  assert.deepStrictEqual(await bob.recipientOf(lanes), pqAddr);
  await assert.rejects(device.harden(OTHER_ROOT, 'cred-b'), /not the passkey/);
  assert.deepStrictEqual(await device.harden(ROOT, 'cred-a'), pqAddr);
  assert.equal(await device.scan(), await alice.scan(), 'with the root it reads all of hers');

  // the same storage gives the same wallet back with no passkey
  const again = makeChainClient({ cfg, rpcCall, priv: ALICE, system, storage: aliceStore });
  assert.deepStrictEqual(await again.address(), pqAddr);
  assert.equal(await again.scan(), alice.balance());
  const r = await alice.rate();
  console.log(JSON.stringify({ ok: true, aliceTac: String(worthOf(alice.balance(), r)) }));
} finally {
  server.kill();
}
