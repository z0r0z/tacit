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
import { assetField, poolShare, sharesFor, sharesToPay, worthOf } from '../dapp/tacit-chain-wallet.js';
const T = 100_000_000n; // 1 TAC in units
import { makeChainClient, sharesWorth, keyMessage } from '../dapp/tacit-chain-client.js';
import { secp } from '../dapp/vendor/tacit-deps.min.js';

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
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };

try {
  for (let i = 0; i < 60; i++) { try { await fetch(LEADER + '/state'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const { chain } = await api('GET', '/state');
  // what the client reads of the landing contract: its binding and asset, and the pool and shares it holds (here the node's, which
  // a landed block leaves equal to the contract's)
  const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const rpcCall = async (m, [{ data }]) => {
    if (data.startsWith('0x' + sel('CHAIN()'))) return chain;
    if (data.startsWith('0x' + sel('TAC_ASSET()'))) return assetHex;
    if (data.startsWith('0x' + sel('pool()'))) return word((await api('GET', '/state')).pool);
    if (data.startsWith('0x' + sel('shares()'))) return word((await api('GET', '/state')).shares);
    throw new Error('unexpected call');
  };
  const cfg = { blocks: BLOCKS, leader: LEADER };
  const aliceStore = store();
  const alice = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x11), system, storage: aliceStore });
  const bob = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x22), system, storage: store() });

  // Alice shields 1,000 TAC (the deposit on Ethereum is the landing contract's business; the node takes the spend): the first shares
  // are one unit each, less the margin a shield leaves for the rate to rise
  const sh = await alice.shield(1000n * T);
  assert.equal(sh.deposit.amount, 1000n * T);
  assert.equal(sh.deposit.shares, sharesFor(1000n * T, { pool: 0n, shares: 0n }));
  assert.ok(sh.depositCalldata.startsWith('0x' + sel('deposit(uint256,uint256,bytes32,bytes32,bytes32)')));
  await Promise.all([sh.submit(), landBlock()]);
  assert.equal(await alice.scan(), sh.deposit.shares);
  const r0 = await alice.rate();
  assert.deepEqual(r0, { pool: 1000n * T, shares: sh.deposit.shares }, 'the margin stayed with the pool');
  assert.ok(await alice.worth() <= 1000n * T && await alice.worth() >= 1000n * T * 9997n / 10000n, 'her shares are worth what she put in, less the margin');

  // Bob publishes his chain address; Alice pays him from the 32-byte hash alone
  await bob.publish();
  const to = await alice.resolve(await bob.lane());

  // a Tacit address from before the chain carries Bob's key but no chain lane: Alice finds his chain address under the key, signed by it
  const bobKey = secp.getPublicKey(new Uint8Array(32).fill(0x22), true);
  assert.deepStrictEqual(await alice.recipientOf({ btc: { spendPub: bobKey } }), to);
  assert.deepStrictEqual(await alice.recipientOf({ btc: { spendPub: bobKey }, chain: { hash: await bob.lane() } }), to);
  // no one else can name an address for his key, and a key that never signed has none
  const bobAddr = (await api('GET', `/address/${hx(await bob.lane())}`)).address;
  const forged = (await secp.signAsync(keyMessage(bobKey, bytes(bobAddr)), new Uint8Array(32).fill(0x33))).toCompactRawBytes();
  assert.ok(!(await api('POST', '/address', { address: bobAddr, key: hx(bobKey), sig: hx(forged) })).ok, 'a signature by another key is refused');
  await assert.rejects(alice.recipientOf({ btc: { spendPub: secp.getPublicKey(new Uint8Array(32).fill(0x33), true) } }), /not opened the Tacit chain/);
  // once the leader holds the payment (before its block lands) Alice's wallet reads as it will after: her note taken, her change counted;
  // a payment straight after it, with no other note, waits for that change
  let queued; const held = new Promise((r) => { queued = r; });
  const p1 = alice.pay(to, 300n * T, { onStatus: (x) => { if (x.status === 'queued') queued(); } });
  await held;
  const payShares = sharesWorth(300n * T, r0);
  assert.equal(alice.balance(), sh.deposit.shares - payShares - poolShare(r0), 'a payment the leader holds reads as landed');
  assert.ok(alice.settling(), 'and it is settling');
  const coming = await bob.incoming();
  assert.ok(coming >= 300n * T - 2n && coming <= 300n * T + T / 1000n, `Bob sees the 300 TAC coming before the block lands (${coming})`);
  assert.equal(await alice.incoming(), 0n, 'Alice\'s own change is not "incoming" to her');
  const each = await bob.incomingNotes();
  assert.equal(each.length, 1, 'one payment coming to Bob');
  assert.equal(each[0].units, coming, 'each payment\'s worth adds up to what is incoming');
  assert.ok(!bob.has(each[0].key), 'not his until its block lands');
  assert.deepEqual(await alice.incomingNotes(), [], 'nothing coming to Alice');
  await assert.rejects(alice.pay(to, 1n * T), /settling/, 'a payment straight after it waits for its change');
  await Promise.all([p1, landBlock()]);
  assert.ok(!alice.settling(), 'landed: nothing settles');
  assert.equal(await bob.incoming(), 0n, 'landed: nothing is incoming, it is Bob\'s');
  assert.equal(await alice.scan(), sh.deposit.shares - payShares - poolShare(r0));
  assert.equal(await bob.scan(), payShares);
  assert.ok(bob.has(each[0].key), 'landed and scanned: the payment that was coming is his');
  assert.ok(await bob.worth() >= 300n * T, 'bob holds at least what alice paid');
  { const q = await bob.quote('pay', 1000n * T), one = await bob.worth();
    assert.ok(q.first > 0n && q.first <= one && q.first + 2n >= one, `a quote names what the largest note is worth (one note: all of it; ${q.first} of ${one})`);
    assert.ok(q.most < 1000n * T && q.first + 0n >= q.most, 'and a payment over what fits is over its most'); }

  // a payment proved ahead (while a form is filled) is handed over later as it was proved; one proved from the same note goes stale once that
  // note is spent, and is not sent (Alice pays herself here: her wallet loses exactly the holders' pool share)
  const self = await alice.address(), rA = await alice.rate(), before = await alice.scan();
  const ahead = await alice.preparePay(self, 5n * T), twin = await alice.preparePay(self, 6n * T);
  assert.ok(alice.fresh(ahead) && alice.fresh(twin), 'proved ahead, both can go');
  await Promise.all([alice.send(ahead), landBlock()]);
  assert.equal(await alice.scan(), before - poolShare(rA), 'the payment proved ahead landed as proved');
  assert.ok(!alice.fresh(twin), 'the other spends a note that went: it is proved again');

  // a client made again from the same storage resumes from where its scan stopped
  const again = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x11), system, storage: aliceStore });
  await again.ready();
  assert.equal(again.balance(), alice.balance());

  // Bob withdraws exactly 120 TAC to Ethereum and hops exactly 100 into the confidential pool (the exit fee on top, in shares)
  const r1 = await bob.rate();
  const b1 = (await Promise.all([bob.withdraw('0x90F79bf6EB2c4f870365E785982E1f101E93b906', 120n * T), landBlock()]))[1];
  assert.equal(BigInt('0x' + b1.lists.exits.slice(2 + 64, 2 + 128)), 120n * T, 'the exit pays exactly 120 TAC');
  assert.equal(await bob.scan(), payShares - sharesToPay(120n * T, r1));
  const r2 = await bob.rate();
  assert.ok(r2.pool * r1.shares > r1.pool * r2.shares, 'the exit fee raised the rate');
  const b2 = (await Promise.all([bob.hop('0x' + '5a'.repeat(32), 100n * T), landBlock()]))[1];
  assert.equal(BigInt('0x' + b2.lists.hops.slice(2 + 64, 2 + 128)), 100n * T, 'the hop is exactly 100 TAC, as the confidential pool needs');
  await bob.scan();
  await assert.rejects(bob.pay(to, 1000n * T), /more than you hold/);
  assert.ok(!bob.settling(), 'nothing of Bob\'s settles once his spends landed');
  const r3 = await bob.rate();
  assert.equal(r3.pool, 1000n * T - 220n * T, 'the pool lost exactly what left');
  console.log(JSON.stringify({ ok: true, aliceTac: String(worthOf(again.balance(), r3)), bobTac: String(worthOf(bob.balance(), r3)), rate: String(r3.pool * 10n ** 8n / r3.shares) }));
} finally {
  server.kill();
}
