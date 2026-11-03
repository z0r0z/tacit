#!/usr/bin/env node
// POST /reflection/note-witness with `nullifiers`: the witnesses a fast-lane spend carries, from the persisted reflection
// state. Each unspent nullifier gets its low link and path, which open to `spentRoot` and bracket it; a spent one is
// named spent; malformed or too many are refused. Membership of the notes' leaves is answered as before.
//   node tests/note-witness-unspent.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import worker from '../worker/src/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const hex = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');

const spent = pool.makeImtAccumulator();
const spentNus = [1, 2, 3, 4, 5].map((i) => hex('spent/' + i));
spentNus.forEach((nu) => spent.insert(nu));
const leaves = [0, 1, 2].map((i) => hex('leaf/' + i));
const kv = new Map([['reflection:scan:mainnet', JSON.stringify({ attestedHeight: 900000, snapshot: { noteLeaves: leaves, spentLinks: spent.links() } })]]);
const env = { REGISTRY_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
const ask = async (body) => {
  const r = await worker.fetch(new Request('https://api.test/reflection/note-witness?network=mainnet', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://tacit.finance' }, body: JSON.stringify(body) }), env, {});
  return { status: r.status, body: await r.json() };
};
let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };

const fresh = hex('not-spent');
const r = await ask({ leaves: [leaves[1]], nullifiers: [fresh, spentNus[2]] });
ok(r.status === 200, 'answers');
ok(r.body.spentRoot === spent.root(), 'spentRoot is the reflected spent set\'s root');
ok(r.body.witnesses[leaves[1]]?.leafIndex === 1, 'the leaf\'s membership is answered as before');
const w = r.body.unspent[fresh];
const big = (x) => BigInt(x);
ok(big(w.value) < big(fresh) && (big(w.next) === 0n || big(fresh) < big(w.next)), 'the low link brackets the nullifier');
ok(JSON.stringify(spent.nonMembershipWitness(fresh)) === JSON.stringify({ lowValue: w.value, lowNext: w.next, lowIndex: w.index, path: w.path }), 'the same witness the accumulator gives');
ok(r.body.unspent[spentNus[2]]?.spent === true, 'a spent nullifier is named spent');

ok((await ask({ leaves: [leaves[0]], nullifiers: ['0x12'] })).status === 400, 'a malformed nullifier is refused');
ok((await ask({ leaves: [leaves[0]], nullifiers: Array.from({ length: 9 }, (_, i) => hex('x' + i)) })).status === 400, 'more than eight are refused');
const plain = await ask({ leaves: [leaves[2]] });
ok(plain.status === 200 && plain.body.spentRoot === undefined && plain.body.unspent === undefined, 'a request without nullifiers is answered as before');
console.log(`${n} ok`);
