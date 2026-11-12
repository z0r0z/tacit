// The chain wallet against the leader's node, with real Halo2 proofs from the pool's wasm prover: Alice shields, pays Bob, Bob hops into the
// confidential pool. Each spend is built by the wallet, checked by the node (proof, body, memos, nullifiers), landed in a block the node
// builds, and the notes are found again by scanning the chain's memos with the recipients' keys alone.
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-chain-wallet.test.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from 'poseidon-lite';
import { makeHalo2System } from '../dapp/btc-pool-halo2-prover.js';
import { makeChainWallet, assetField, hopOp, poolOp, poolShare, sharesToPay } from '../dapp/tacit-chain-wallet.js';
const T = 100_000_000n; // 1 TAC in units

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const D = join(HERE, '../dapp/btc-pool/');
const PORT = 19000 + Math.floor(Math.random() * 900);
const LANDER = '0x00000000000000000000000000000000000b10c5';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

const poseidon = (xs) => ({ 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 })[xs.length](xs);
const pin = JSON.parse(readFileSync(D + 'pin.json', 'utf8'));
const prover = makeHalo2System({ wasm: readFileSync(D + pin.wasm), params: readFileSync(D + pin.params), vk: readFileSync(D + pin.vk), pinnedVkHash: pin.vk_hash, worker: null });
const asset = assetField(Uint8Array.from([...new Array(12).fill(0), ...Buffer.from(TAC.slice(2), 'hex')]));
const assetHex = '0x' + asset.toString(16).padStart(64, '0');

const server = spawn(BIN, ['serve', '1', `${LANDER}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, TACIT_NODE_ASSET: assetHex } });
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  return { ok: r.ok, status: r.status, ...j };
};
// what a wallet reads of a leader
const leader = {
  path: async (i) => (await api('GET', `/path/${i}`)),
  notes: async (from, limit) => api('GET', `/notes?from=${from}&limit=${limit}`),
  spent: async (nf) => (await api('GET', `/spent/${nf}`)).spent,
  address: async (h) => (await api('GET', `/address/${h}`)).address,
  publish: async (a) => (await api('POST', '/address', { address: a })).hash,
};
/// What the real leader does between a block's build and its landing on Ethereum, here without the chain.
async function landBlock() {
  const b = await api('POST', '/build', { time: Math.floor(Date.now() / 1000), queue: [] });
  assert.ok(b.ok, `build: ${b.error}`);
  const pv = bytes(b.publicValues);
  const words = Array.from({ length: pv.length / 32 }, (_, i) => hx(pv.subarray(32 * i, 32 * i + 32)));
  const leaves = b.lists.leaves.length > 2 ? b.lists.leaves.slice(2).match(/.{64}/g).map((x) => '0x' + x) : [];
  const memos = b.lists.memos.length > 2 ? b.lists.memos.slice(2).match(/.{2304}/g).map((x) => '0x' + x) : [];
  const landed = await api('POST', '/landed', { words, leaves, memos, nullifiers: b.lists.nullifiers });
  assert.ok(landed.ok, `landed: ${landed.error}`);
  return b;
}

try {
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/state`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const st0 = await api('GET', '/state');
  const w = makeChainWallet({ poseidon, prover, chain: st0.chain, asset });
  const alice = w.keys(new Uint8Array(32).fill(0xa1));
  const bob = w.keys(new Uint8Array(32).fill(0xb2));
  const time = (label, t0) => console.log(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // addresses round-trip
  const enc = w.encodeAddress(w.address(bob));
  assert.deepEqual(w.decodeAddress(enc).scanPub, w.address(bob).scanPub);
  assert.equal(w.decodeAddress(enc).A[0], w.address(bob).A[0]);

  // 1. Alice shields 1,000 units: a deposit with no inputs, her note and a zero-valued one made
  let t0 = Date.now();
  const shield = await w.spend(alice, { dep: { v: 1000n * T, amount: 1000n * T }, leader });
  time('shield proof', t0);
  assert.equal(shield.deposit.shares, 1000n * T);
  assert.equal(shield.deposit.amount, 1000n * T);
  assert.equal(shield.created.length, 2, 'padded to two output notes');
  let r = await api('POST', '/spend', shield.submission);
  assert.ok(r.ok, `shield refused: ${r.error}`);
  const b1 = await landBlock();
  assert.equal(b1.lists.deposits.length, 2 + 192 * 2, 'the block takes the deposit in');
  const rate = async () => { const st = await api('GET', '/state'); return { pool: BigInt(st.pool), shares: BigInt(st.shares) }; };
  assert.deepEqual(await rate(), { pool: 1000n * T, shares: 1000n * T }, 'one unit a share to start');

  // 2. Alice finds her note from the chain's memos alone
  let mine = await w.scan(alice, leader);
  assert.deepEqual(mine.notes.map((n) => n.value), [1000n * T]);

  // 3. Bob's Tacit address carries only the 32-byte hash of his chain address; he publishes the full one to the leader's
  //    directory and Alice resolves it from the hash (a directory that answers with any other address is caught)
  const bobHash = w.chainAddressHash(w.address(bob));
  assert.equal(await w.publish(bob, leader), hx(bobHash));
  const bobResolved = await w.resolve(bobHash, leader);
  assert.deepEqual(bobResolved.kemPub, w.address(bob).kemPub);
  await assert.rejects(w.resolve(new Uint8Array(32), leader), /no leader knows/);
  const liar = { address: async () => w.encodeAddress(w.address(alice)).slice(3) };
  await assert.rejects(w.resolve(bobHash, liar), /another address/);

  // Alice pays Bob 300 and keeps 700
  t0 = Date.now();
  const share = poolShare(await rate());
  // a payment with no pool share is refused by the program, so the leader will not take it
  const bare = await w.spend(alice, { inputs: mine.notes, outputs: [{ to: bobResolved, value: 300n * T }], leader });
  assert.ok(!(await api('POST', '/spend', bare.submission)).ok, 'a payment gives the holders their pool share');
  const pay = await w.spend(alice, { inputs: mine.notes, outputs: [{ to: bobResolved, value: 300n * T }], exit: { v: share, amount: 0n, op: poolOp() }, leader });
  time('payment proof', t0);
  r = await api('POST', '/spend', pay.submission);
  assert.ok(r.ok, `payment refused: ${r.error}`);
  const dup = await api('POST', '/spend', pay.submission);
  assert.ok(dup.ok && dup.id === r.id, 'the same spend twice is one submission');
  await landBlock();

  // 4. Bob finds 300; Alice finds her change and her old note spent
  const bobScan = await w.scan(bob, leader);
  assert.deepEqual(bobScan.notes.map((n) => n.value), [300n * T]);
  const aliceScan = await w.scan(alice, leader);
  assert.deepEqual(aliceScan.notes.map((n) => n.value), [700n * T - share]);
  assert.deepEqual(aliceScan.spent.map((n) => n.value), [1000n * T]);
  {
    // with the leader's list of spent nullifiers a scan finds the same notes and never asks about one of them
    const asked = { spent: 0, feed: 0, from: [] };
    const feedLeader = { ...leader, state: () => api('GET', '/state'),
      spent: async (nf) => { asked.spent++; return leader.spent(nf); },
      nullifiers: async (from, limit) => { asked.feed++; asked.from.push(from); return api('GET', `/nullifiers?from=${from}&limit=${limit}`); } };
    // the node's list: in the order it took them, a page is a slice of it, and no page is longer than 2000
    const nfs = await api('GET', '/nullifiers?from=0&limit=1000');
    assert.equal(nfs.total, (await api('GET', '/state')).nullifiers, 'the list is as long as the nullifiers the chain has spent');
    assert.ok(nfs.total > 0 && nfs.nullifiers.length === nfs.total && nfs.nullifiers.every((h) => /^0x[0-9a-f]{64}$/.test(h)));
    const past = await api('GET', `/nullifiers?from=${nfs.total + 50}&limit=10`);
    assert.deepEqual([past.from, past.next, past.nullifiers.length], [nfs.total, nfs.total, 0], 'a start past the end is the end');
    assert.deepEqual((await api('GET', '/nullifiers?from=1&limit=1')).nullifiers, nfs.nullifiers.slice(1, 2), 'a page is a slice of the list');
    assert.ok((await api('GET', '/nullifiers?from=0&limit=999999')).nullifiers.length <= 2000, 'a page is at most 2000');
    const viaFeed = await w.scan(alice, feedLeader);
    assert.deepEqual(viaFeed.notes.map((n) => n.value), aliceScan.notes.map((n) => n.value), 'the same unspent notes');
    assert.deepEqual(viaFeed.spent.map((n) => n.value), aliceScan.spent.map((n) => n.value), 'the same spent notes');
    assert.equal(asked.spent, 0, 'no note is asked about one by one');
    assert.ok(asked.feed >= 1 && asked.from[0] === 0, 'the list is read from its start');
    const kept = w.nullifiersKept();
    assert.equal(kept.length, 64 * (await api('GET', '/state')).nullifiers, 'the list is kept whole');
    asked.feed = 0; asked.from.length = 0;
    await w.scan(alice, feedLeader);
    assert.deepEqual(asked.from, [kept.length / 64], 'a second scan reads only what is new');
    // a wallet that loads the kept list reads only what is new
    const fresh = makeChainWallet({ poseidon, prover, chain: st0.chain, asset });
    assert.ok(fresh.nullifiersKeep(kept) && fresh.nullifiersKept() === kept, 'the kept list loads');
    assert.ok(!fresh.nullifiersKeep(kept + 'zz') && !fresh.nullifiersKeep('0x' + kept) && !fresh.nullifiersKeep(kept.slice(1)), 'a list that is not 32-byte hex is refused');
    asked.feed = 0; asked.from.length = 0; asked.spent = 0;
    const loaded = await fresh.scan(alice, feedLeader);
    assert.deepEqual(loaded.spent.map((n) => n.value), [1000n * T]);
    assert.deepEqual(asked.from, [kept.length / 64]);
    // a leader that holds fewer than are kept: the list starts over from it
    const shrunk = makeChainWallet({ poseidon, prover, chain: st0.chain, asset });
    shrunk.nullifiersKeep(kept + 'ab'.repeat(32));
    const reread = await shrunk.scan(alice, feedLeader);
    assert.deepEqual(reread.spent.map((n) => n.value), [1000n * T]);
    assert.equal(shrunk.nullifiersKept(), kept, 'it holds what the leader holds');
    // a leader with no list (an older one) is asked about each note, as before; one that sends something else is not trusted
    const old = { ...feedLeader, nullifiers: async () => ({ ok: false, status: 404, error: 'not found' }) };
    asked.spent = 0;
    assert.deepEqual((await makeChainWallet({ poseidon, prover, chain: st0.chain, asset }).scan(alice, old)).spent.map((n) => n.value), [1000n * T]);
    assert.ok(asked.spent > 0, 'an older leader is asked about each note');
    const odd = { ...feedLeader, nullifiers: async () => ({ ok: true, total: 1, nullifiers: ['not a nullifier'] }) };
    asked.spent = 0;
    const wOdd = makeChainWallet({ poseidon, prover, chain: st0.chain, asset });
    assert.deepEqual((await wOdd.scan(alice, odd)).spent.map((n) => n.value), [1000n * T]);
    assert.ok(asked.spent > 0 && wOdd.nullifiersKept() === '', 'a list that is not nullifiers is dropped and the notes are asked about');
  }
  const r1 = await rate();
  assert.deepEqual(r1, { pool: 1000n * T, shares: 1000n * T - share }, 'the pool share ended shares and kept their TAC');
  const nobody = w.keys(new Uint8Array(32).fill(0x77));
  assert.deepEqual((await w.scan(nobody, leader)).notes, [], 'no one else sees them');

  // 5. a spend of a note that is already spent is refused
  const again = await w.spend(alice, { inputs: mine.notes, outputs: [{ to: w.address(bob), value: 1n * T }], exit: { v: share, amount: 0n, op: poolOp() }, leader }).catch((e) => e);
  assert.ok(again.submission, 'the wallet still builds it');
  r = await api('POST', '/spend', again.submission);
  assert.ok(!r.ok, 'the leader refuses a note already spent');

  // 6. Bob hops 100 into the confidential pool, keeping 200
  t0 = Date.now();
  const commit = '0x' + '5a'.repeat(32);
  const hopShares = sharesToPay(100n * T, r1);
  const hop = await w.spend(bob, { inputs: bobScan.notes, exit: { v: hopShares, amount: 100n * T, op: hopOp(commit) }, leader });
  time('hop proof', t0);
  r = await api('POST', '/spend', hop.submission);
  assert.ok(r.ok, `hop refused: ${r.error}`);
  const b3 = await landBlock();
  assert.equal(b3.lists.hops.length, 2 + 96 * 2, 'the block sends one hop');
  const bobAfter = await w.scan(bob, leader);
  assert.deepEqual(bobAfter.notes.map((n) => n.value), [300n * T - hopShares]);
  const r2 = await rate();
  assert.equal(r2.pool, 900n * T, 'exactly 100 TAC left');
  assert.ok(r2.pool * r1.shares > r1.pool * r2.shares, 'the exit fee stayed: each share is worth more');

  // 7. a spend of another asset, and one naming a root no block ended at, cannot be admitted
  const other = makeChainWallet({ poseidon, prover, chain: st0.chain, asset: asset + 1n });
  const wrongAsset = await other.spend(other.keys(new Uint8Array(32).fill(1)), { dep: { v: 5n * T, amount: 5n * T }, leader });
  r = await api('POST', '/spend', wrongAsset.submission);
  assert.ok(!r.ok && /only TAC/.test(r.error), 'only TAC moves here');

  const st = await api('GET', '/state');
  console.log(JSON.stringify({ ok: true, height: st.height, leaves: st.leaves, nullifiers: st.nullifiers }));
} finally {
  server.kill();
}
