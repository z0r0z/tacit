// The app's chain client against the leader's node, with real Halo2 proofs: two Tacit keys, a shield, a payment to a chain address
// resolved from its lane hash, a withdrawal and a hop; each wallet's notes found by its own scan and kept between scans.
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-chain-client.test.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeHalo2System } from '../dapp/btc-pool-halo2-prover.js';
import { assetField } from '../dapp/tacit-chain-wallet.js';
import { makeChainClient } from '../dapp/tacit-chain-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const D = join(HERE, '../dapp/btc-pool/');
const PORT = 19900 + Math.floor(Math.random() * 90);
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
const server = spawn(BIN, ['serve', '1', `${BLOCKS}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TACIT_NODE_ASSET: assetHex } });
const api = async (method, path, body) => { const r = await fetch(LEADER + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, ...(await r.json()) }; };
// what the leader does between building a block and seeing it land
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
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };

try {
  for (let i = 0; i < 60; i++) { try { await fetch(LEADER + '/state'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const { chain } = await api('GET', '/state');
  // the contract's two words the client reads
  const rpcCall = async (m, [{ data }]) => (data.startsWith('0x' + sel('CHAIN()')) ? chain : data.startsWith('0x' + sel('TAC_ASSET()')) ? assetHex : (() => { throw new Error('unexpected call'); })());
  const cfg = { blocks: BLOCKS, leader: LEADER };
  const aliceStore = store();
  const alice = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x11), system, storage: aliceStore });
  const bob = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x22), system, storage: store() });

  // Alice shields 1,000 units (the deposit on Ethereum is the landing contract's business; the node takes the spend)
  const sh = await alice.shield(1000n);
  assert.equal(sh.deposit.value, 1000n);
  assert.ok(sh.depositCalldata.startsWith('0x' + sel('deposit(uint256,bytes32,bytes32,bytes32)')));
  await Promise.all([sh.submit(), landBlock()]);
  assert.equal(await alice.scan(), 1000n);

  // Bob publishes his chain address; Alice pays him from the 32-byte hash alone
  await bob.publish();
  const to = await alice.resolve(await bob.lane());
  await Promise.all([alice.pay(to, 300n), landBlock()]);
  assert.equal(await alice.scan(), 700n);
  assert.equal(await bob.scan(), 300n);

  // a client made again from the same storage resumes from where its scan stopped
  const again = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x11), system, storage: aliceStore });
  await again.ready();
  assert.equal(again.balance(), 700n);

  // Bob withdraws 120 to Ethereum and hops 100 into the confidential pool
  const b1 = (await Promise.all([bob.withdraw('0x90F79bf6EB2c4f870365E785982E1f101E93b906', 120n), landBlock()]))[1];
  assert.equal(b1.lists.exits.length, 2 + 96 * 2);
  assert.equal(await bob.scan(), 180n);
  const b2 = (await Promise.all([bob.hop('0x' + '5a'.repeat(32), 100n), landBlock()]))[1];
  assert.equal(b2.lists.hops.length, 2 + 96 * 2);
  assert.equal(await bob.scan(), 80n);
  await assert.rejects(bob.pay(to, 81n), /more than you hold/);
  console.log(JSON.stringify({ ok: true, alice: String(again.balance()), bob: String(bob.balance()) }));
} finally {
  server.kill();
}
