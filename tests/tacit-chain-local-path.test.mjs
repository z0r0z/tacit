// A spend on the tacit chain takes its membership paths from the chain's note tree kept in the wallet, and asks the leader for the root it states
// (which names no note) instead of the path of a particular note. No node, no proofs: the prover is a stand-in that records the witness it is given.
//   node tests/tacit-chain-local-path.test.mjs
import assert from 'node:assert';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeChainClient, chainSeed } from '../dapp/tacit-chain-client.js';
import { makeChainWallet } from '../dapp/tacit-chain-wallet.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from '../dapp/vendor/tacit-poseidon.min.js';
const PO = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
const poseidon = (x) => PO[x.length](x);
const w32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };

const seen = { prover: null };
const prover = { prove: async (input) => { seen.prover = JSON.stringify(input); throw new Error('stop here'); } };
const wallet = () => makeChainWallet({ poseidon, prover, chain: w32(7), asset: 9n });
const gen = wallet();
const me = gen.keys(chainSeed(new Uint8Array(32).fill(0x11))), addr = gen.address(me);
const mine = gen.makeNote(addr, 500n);                // the note to spend, at index 6
const filler = (i) => poseidon([BigInt(i + 1), 12345n]);
const make = (count) => Array.from({ length: count }, (_, i) => (i === 6 ? mine.leaf : filler(i)));
const reference = (leaves) => gen.Z.tree(leaves);

// a leader serving `leaves`, and counting what it is asked
function leaderOf(leaves, over = {}) {
  const calls = { path: 0, state: 0, notes: [] };
  const l = {
    calls, leaves,
    state: async () => { calls.state++; const t = reference(l.leaves); return { leaves: l.leaves.length, noteRoot: w32(over.root ?? t.root) }; },
    notes: async (from, limit) => { calls.notes.push(from); const to = Math.min(from + limit, l.leaves.length); return { from, next: to, total: l.leaves.length, leaves: l.leaves.slice(from, to).map(w32), memos: l.leaves.slice(from, to).map((_, i) => (from + i === 6 ? hx(mine.memo) : '0x' + '00'.repeat(1152))) }; },
    path: async () => { calls.path++; throw new Error('the leader was asked for a path'); },
    spent: async () => false,
  };
  return l;
}
const input = { index: 6, value: 500n, s: mine.s, leaf: mine.leaf };
const spendWith = async (w, leader) => { seen.prover = null; await w.spend(me, { inputs: [input], outputs: [], leader }).catch((e) => { if (!/stop here/.test(e.message)) throw e; }); return seen.prover; };

// 1. the path and root in the witness are the tree's own, and the leader is asked for no path
{
  const leaves = make(11), ref = reference(leaves), w = wallet(), L = leaderOf(leaves);
  const witness = await spendWith(w, L);
  ok(L.calls.path === 0, 'a spend asks the leader for no path');
  ok(witness.includes(String(ref.root)), 'the witness carries the chain\'s root');
  ok(ref.path(6).every((x) => witness.includes(String(x))), 'and the siblings of the note\'s own place');
  ok(L.calls.notes[0] === 0, 'the leaves were read from the start, a range every wallet reads alike');

  // 2. the leaves kept are not read again, only those added since
  const before = L.calls.notes.length;
  await spendWith(w, L);
  ok(L.calls.notes.length === before && L.calls.path === 0, 'a second spend reads no leaf again');
  L.leaves = [...leaves, filler(100), filler(101)];
  await spendWith(w, L);
  ok(L.calls.notes.slice(before).join() === '11', 'after two more landed, only those are read (from 11)');
  ok(reference(L.leaves).root !== ref.root && seen.prover.includes(String(reference(L.leaves).root)), 'and the witness carries the new root');

  // 3. what is kept can be put back, and what is not a leaf list is ignored
  const kept = w.leavesKept();
  ok(kept.length === 13 * 64, 'the kept leaves are 64 hex digits each');
  const w2 = wallet(); ok(w2.leavesKeep(kept) === true, 'they can be put back');
  const L2 = leaderOf(L.leaves); await spendWith(w2, L2);
  ok(L2.calls.notes.length === 0 && L2.calls.path === 0, 'a wallet that has them reads none');
  ok(w2.leavesKeep('zz') === false && w2.leavesKeep('ab'.repeat(33)) === false && w2.leavesKept() === kept, 'a string that is not a leaf list changes nothing');
}

// 4. a kept list that does not match the chain is rebuilt from the leaves, not trusted
{
  const leaves = make(9), w = wallet(), L = leaderOf(leaves);
  w.leavesKeep(Array.from({ length: 9 }, (_, i) => (BigInt(i + 50)).toString(16).padStart(64, '0')).join(''));
  const witness = await spendWith(w, L);
  ok(L.calls.notes[0] === 0 && L.calls.path === 0 && witness.includes(String(reference(leaves).root)), 'a wrong kept list is read again from the start');
  const w3 = wallet(); w3.leavesKeep(make(14).map((x) => BigInt(x).toString(16).padStart(64, '0')).join(''));
  await spendWith(w3, L);
  ok(L.calls.path === 0, 'a kept list longer than the chain is dropped');
}

// 5. a leader whose leaves do not make its root is refused, and no path is asked for instead
{
  const L = leaderOf(make(8), { root: 123456789n }), w = wallet();
  const err = await w.spend(me, { inputs: [input], outputs: [], leader: L }).then(() => null, (e) => e);
  ok(err && /do not make the root/.test(err.message) && L.calls.path === 0, 'the leaves must make the root the leader states');
  const L4 = leaderOf(make(8)); const w4 = wallet();
  const err2 = await w4.spend(me, { inputs: [{ ...input, leaf: 77n }], outputs: [], leader: L4 }).then(() => null, (e) => e);
  ok(err2 && /not where the chain's tree holds it/.test(err2.message), 'a note that is not at its place in the tree is refused');
}

// 6. a leader that cannot state its root (a stand-in) still answers the path itself
{
  const leaves = make(8), ref = reference(leaves);
  const stand = { notes: async () => ({}), path: async (i) => { stand.asked = i; return { root: w32(ref.root), path: ref.path(i).map(w32) }; } };
  const witness = await spendWith(wallet(), stand);
  ok(stand.asked === 6 && witness.includes(String(ref.root)), 'a stand-in leader with no state is asked for the path');
}

// 7. a scan keeps the leaves it reads when they follow the ones kept, and nothing else
{
  const leaves = make(450), w = wallet(), L = leaderOf(leaves);
  const r = await w.scan(me, L, { from: 0, known: [] });
  ok(r.next === 450 && w.leavesKept().length === 450 * 64, 'a scan from the start keeps every leaf it reads');
  ok(r.notes.length === 1 && r.notes[0].index === 6, 'and still finds the wallet\'s own note');
  const w5 = wallet(); await w5.scan(me, L, { from: 200, known: [] });
  ok(w5.leavesKept() === '', 'a scan that starts past the kept leaves keeps none, so the list has no gap');
  const w6 = wallet(); await w6.scan(me, L, { from: 0, known: [], keep: false });
  ok(w6.leavesKept() === '', 'a scan told not to keep leaves keeps none');
  const w7 = wallet(); await w7.scan(me, { notes: L.notes, spent: L.spent }, { from: 0, known: [] });
  ok(w7.leavesKept() === '', 'a scan of a list that is not the leader\'s own keeps none');
}

// 8. the client keeps the leaves under a key of its own, and reads no path from the leader
{
  const BLOCKS = '0x00000000000000000000000000000000000b10c5';
  const sel = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4)).toString('hex');
  const rpcCall = async (m, [{ data }]) => {
    if (data.startsWith('0x' + sel('CHAIN()'))) return w32(7);
    if (data.startsWith('0x' + sel('TAC_ASSET()'))) return w32(9);
    throw new Error('unexpected ' + data);
  };
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
  const leaves = make(12), L = leaderOf(leaves), hits = [];
  const f = async (url) => {
    hits.push(new URL(url).pathname);
    const u = new URL(url), body = u.pathname === '/state' ? await L.state() : u.pathname === '/notes' ? await L.notes(Number(u.searchParams.get('from')), Number(u.searchParams.get('limit'))) : u.pathname.startsWith('/spent/') ? { spent: false } : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const st = store();
  const c = makeChainClient({ cfg: { blocks: BLOCKS, leader: 'http://leader.test' }, rpcCall, priv: new Uint8Array(32).fill(0x11), system: () => ({ prove: prover.prove }), storage: st, fetchImpl: f });
  await c.scan();
  const keys = [...st.m.keys()];
  ok(keys.some((k) => k.startsWith('tacit-chain-leaves-v1:')) && keys.some((k) => k.startsWith('tacit-chain-notes-v1:')), 'the leaves and the notes are kept under their own keys');
  ok(st.m.get(keys.find((k) => k.startsWith('tacit-chain-leaves-v1:'))).length === 12 * 64, 'the leaves kept are the chain\'s 12');
  const full = { getItem: (k) => (k.startsWith('tacit-chain-leaves-v1:') ? null : st.m.get(k) ?? null), setItem: (k, v) => { if (k.startsWith('tacit-chain-leaves-v1:')) throw new Error('quota'); st.m.set(k, v); }, removeItem() {} };
  const c2 = makeChainClient({ cfg: { blocks: BLOCKS, leader: 'http://leader.test' }, rpcCall, priv: new Uint8Array(32).fill(0x11), system: () => ({ prove: prover.prove }), storage: full, fetchImpl: f });
  await c2.scan();
  ok(await c2.scan().then(() => true, () => false) && [...st.m.keys()].some((k) => k.startsWith('tacit-chain-notes-v1:')), 'a store with no room for the leaves still scans and keeps the notes');
  ok(!hits.some((p) => p.startsWith('/path/')), 'no path was asked of the leader');
}
console.log(`${n} ok`);
