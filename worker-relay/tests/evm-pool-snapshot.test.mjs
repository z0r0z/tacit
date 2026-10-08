// An EVM pool's state rebuilt from its Transact events (src/lib/evm-pool-snapshot.js): the note tree must reproduce every
// root the pool announced, the spent set gives the same sparse-tree root circomlib's does, and a history that does not add
// up is refused.
//   node worker-relay/tests/evm-pool-snapshot.test.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadZk } from '../src/lib/evm-pool-keeper-prover.js';
import { buildPoolHistory, smtRoot, PoolHistoryError } from '../src/lib/evm-pool-snapshot.js';

const zk = await loadZk();
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const rnd = () => BigInt('0x' + crypto.randomBytes(32).toString('hex')) % P;

// circomlibjs is the reference for the sparse tree where it is installed (the circuit's own dependency).
async function circomlibTrie() {
  for (const p of ['circomlibjs', new URL('../../dapp/circuits/node_modules/circomlibjs/main.js', import.meta.url), '/Users/z/tacit/dapp/circuits/node_modules/circomlibjs/main.js']) {
    try {
      if (typeof p !== 'string' || p === 'circomlibjs') return await import(p);
      if (existsSync(p.pathname ?? p)) return await import(pathToFileURL(p.pathname ?? p).href);
    } catch { /* try the next place */ }
  }
  return null;
}

{
  const cl = await circomlibTrie();
  if (!cl) console.log('skip - circomlibjs is not installed, so the sparse-tree root is not compared with the circuit\'s own library');
  else {
    for (const n of [0, 1, 2, 5, 60]) {
      const keys = Array.from({ length: n }, rnd);
      if (n >= 2) keys.push(keys[0] ^ (1n << 12n), keys[1] ^ (1n << 3n));            // keys that agree on many low bits
      const trie = await cl.newMemEmptyTrie();
      for (const k of keys) await trie.insert(k, 1n);
      assert.equal(smtRoot(keys, zk.H), trie.F.toObject(trie.root), `${keys.length} keys`);
    }
    console.log('ok - the sparse-tree root is circomlibjs\'s, for empty, single, shared-prefix and larger sets');
  }
  const keys = Array.from({ length: 20 }, rnd);
  assert.equal(smtRoot(keys, zk.H), smtRoot([...keys].reverse(), zk.H), 'the order the keys come in changes nothing');
  assert.equal(smtRoot([...keys, keys[3]], zk.H), smtRoot(keys, zk.H), 'a repeated key is one key');
  console.log('ok - the root depends on the set only');
}

// A pool that happened: deposits with one output, a private transfer with two, a withdrawal that inserts nothing.
const ref = zk.incTree();
const L = Array.from({ length: 9 }, rnd), NF = Array.from({ length: 4 }, rnd);
const ev = (block, logIndex, outs, nfs, extAmount = 0n, fee = 0n) => {
  const inserts = outs[0] !== 0n || outs[1] !== 0n;
  const firstIndex = BigInt(ref.size);
  if (inserts) ref.append(outs);
  return { blockNumber: block, logIndex, firstIndex, outLeaf0: outs[0], outLeaf1: outs[1], nf0: nfs[0], nf1: nfs[1], newRoot: ref.root, extAmount, fee };
};
const events = [
  ev(100, 0, [L[0], 0n], [0n, 0n], 5n * 10n ** 18n),    // a deposit, one output
  ev(100, 1, [L[1], L[2]], [0n, 0n], 2n * 10n ** 18n, 10n ** 15n),  // a deposit, two outputs, same block, a relayer fee
  ev(105, 0, [L[3], L[4]], [NF[0], 0n]),             // a transfer spending one note
  ev(110, 0, [0n, 0n], [NF[1], NF[2]], -(3n * 10n ** 18n)),   // a withdrawal: nothing inserted, two notes spent
  ev(120, 0, [L[5], 0n], [0n, 0n]),
];
const emptyRoot = zk.incTree().root;

{
  const h = buildPoolHistory({ transacts: events, zk });
  assert.equal(h.events, 5);
  assert.equal(h.head.root, ref.root, 'the rebuilt tree is the pool\'s');
  assert.equal(h.head.size, 8);
  assert.deepEqual([h.head.leaves, h.head.nullifiers], [6, 3], 'six non-empty leaves in eight slots, three published nullifiers');
  assert.deepEqual(h.at(99), { root: emptyRoot, size: 0, leaves: 0, nullifiers: 0, flows: { deposits: 0, withdrawals: 0, in: 0n, out: 0n, fees: 0n, net: 0n } }, 'before the first event the pool is empty');
  assert.deepEqual([h.at(100).size, h.at(100).leaves], [4, 3], 'every event of a block counts: four slots (a deposit with one output inserts an empty one), three leaves');
  assert.deepEqual([h.at(107).size, h.at(107).nullifiers], [6, 1], 'a block between events keeps the state before it');
  assert.equal(h.at(110).root, h.at(107).root, 'a withdrawal that inserts nothing leaves the tree as it was');
  assert.equal(h.at(110).nullifiers, 3);
  assert.deepEqual([h.at(1e9).size, h.at(1e9).leaves], [8, 6], 'past the last event is the head');
  assert.deepEqual(h.at(100).flows, { deposits: 2, withdrawals: 0, in: 7n * 10n ** 18n, out: 0n, fees: 10n ** 15n, net: 7n * 10n ** 18n - 10n ** 15n }, 'a relayer fee leaves the pool');
  assert.deepEqual(h.at(110).flows, { deposits: 2, withdrawals: 1, in: 7n * 10n ** 18n, out: 3n * 10n ** 18n, fees: 10n ** 15n, net: 4n * 10n ** 18n - 10n ** 15n }, 'the public amounts and fees give the ETH in the pool exactly');
  assert.deepEqual(h.nullifiersAt(107), [NF[0]]);
  assert.equal(h.nfRootAt(107), smtRoot([NF[0]], zk.H));
  assert.equal(h.nfRootAt(110), smtRoot([NF[0], NF[1], NF[2]], zk.H));
  assert.equal(h.nfRootAt(99), 0n, 'nothing is spent in an empty pool');
  assert.equal(h.sizeOfRoot(emptyRoot), 0);
  assert.equal(h.sizeOfRoot(events[1].newRoot), 4, 'the size the pool had when a root was its head');
  assert.equal(h.sizeOfRoot(events[3].newRoot), h.sizeOfRoot(events[2].newRoot), 'a withdrawal that inserts nothing names the same head');
  assert.equal(h.sizeOfRoot(12345n), null, 'a root this history never reached');
  const shuffled = buildPoolHistory({ transacts: [...events].reverse(), zk });
  assert.equal(shuffled.head.root, h.head.root, 'the order the logs arrive in changes nothing');
  assert.equal(buildPoolHistory({ transacts: events.map((e) => ({ ...e, outLeaf0: '0x' + e.outLeaf0.toString(16), nf0: '0x' + e.nf0.toString(16), newRoot: '0x' + e.newRoot.toString(16) })), zk }).head.root, h.head.root, 'hex values read as numbers');
  console.log('ok - the pool\'s state at any block: tree root, size, spent notes and the sparse-tree root');
}

{
  const bad = (mut) => buildPoolHistory({ transacts: events.map((e, i) => mut(e, i)), zk });
  assert.throws(() => bad((e, i) => (i === 2 ? { ...e, newRoot: e.newRoot ^ 1n } : e)), PoolHistoryError, 'a root the tree does not reproduce is refused');
  assert.throws(() => bad((e, i) => (i === 3 ? { ...e, newRoot: e.newRoot ^ 1n } : e)), PoolHistoryError, 'so is one on an event that inserted nothing');
  assert.throws(() => bad((e, i) => (i === 2 ? { ...e, firstIndex: e.firstIndex + 2n } : e)), PoolHistoryError, 'an index that skips ahead is refused');
  assert.throws(() => buildPoolHistory({ transacts: events.filter((_, i) => i !== 1), zk }), PoolHistoryError, 'a missing event is refused');
  assert.throws(() => bad((e, i) => (i === 4 ? { ...e, nf1: NF[0] } : e)), PoolHistoryError, 'a nullifier spent twice is refused');
  console.log('ok - a history that does not reproduce the pool\'s own roots, skips an index or spends a note twice is refused');
}
