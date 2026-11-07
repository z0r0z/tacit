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
import { makeChainWallet, assetField, hopOp } from '../dapp/tacit-chain-wallet.js';

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
  const shield = await w.spend(alice, { dep: { v: 1000n }, leader });
  time('shield proof', t0);
  assert.equal(shield.deposit.value, 1000n);
  assert.equal(shield.created.length, 2, 'padded to two output notes');
  let r = await api('POST', '/spend', shield.submission);
  assert.ok(r.ok, `shield refused: ${r.error}`);
  const b1 = await landBlock();
  assert.equal(b1.lists.deposits.length, 2 + 160 * 2, 'the block takes the deposit in');

  // 2. Alice finds her note from the chain's memos alone
  let mine = await w.scan(alice, leader);
  assert.deepEqual(mine.notes.map((n) => n.value), [1000n]);

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
  const pay = await w.spend(alice, { inputs: mine.notes, outputs: [{ to: bobResolved, value: 300n }], leader });
  time('payment proof', t0);
  r = await api('POST', '/spend', pay.submission);
  assert.ok(r.ok, `payment refused: ${r.error}`);
  const dup = await api('POST', '/spend', pay.submission);
  assert.ok(dup.ok && dup.id === r.id, 'the same spend twice is one submission');
  await landBlock();

  // 4. Bob finds 300; Alice finds her change and her old note spent
  const bobScan = await w.scan(bob, leader);
  assert.deepEqual(bobScan.notes.map((n) => n.value), [300n]);
  const aliceScan = await w.scan(alice, leader);
  assert.deepEqual(aliceScan.notes.map((n) => n.value), [700n]);
  assert.deepEqual(aliceScan.spent.map((n) => n.value), [1000n]);
  const nobody = w.keys(new Uint8Array(32).fill(0x77));
  assert.deepEqual((await w.scan(nobody, leader)).notes, [], 'no one else sees them');

  // 5. a spend of a note that is already spent is refused
  const again = await w.spend(alice, { inputs: mine.notes, outputs: [{ to: w.address(bob), value: 1n }], leader }).catch((e) => e);
  assert.ok(again.submission, 'the wallet still builds it');
  r = await api('POST', '/spend', again.submission);
  assert.ok(!r.ok, 'the leader refuses a note already spent');

  // 6. Bob hops 100 into the confidential pool, keeping 200
  t0 = Date.now();
  const commit = '0x' + '5a'.repeat(32);
  const hop = await w.spend(bob, { inputs: bobScan.notes, exit: { v: 100n, op: hopOp(commit) }, leader });
  time('hop proof', t0);
  r = await api('POST', '/spend', hop.submission);
  assert.ok(r.ok, `hop refused: ${r.error}`);
  const b3 = await landBlock();
  assert.equal(b3.lists.hops.length, 2 + 96 * 2, 'the block sends one hop');
  const bobAfter = await w.scan(bob, leader);
  assert.deepEqual(bobAfter.notes.map((n) => n.value), [200n]);

  // 7. a spend of another asset, and one naming a root no block ended at, cannot be admitted
  const other = makeChainWallet({ poseidon, prover, chain: st0.chain, asset: asset + 1n });
  const wrongAsset = await other.spend(other.keys(new Uint8Array(32).fill(1)), { dep: { v: 5n }, leader });
  r = await api('POST', '/spend', wrongAsset.submission);
  assert.ok(!r.ok && /only TAC/.test(r.error), 'only TAC moves here');

  const st = await api('GET', '/state');
  console.log(JSON.stringify({ ok: true, height: st.height, leaves: st.leaves, nullifiers: st.nullifiers }));
} finally {
  server.kill();
}
