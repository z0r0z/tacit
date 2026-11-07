// The leader's fee, the escape hatch and a mempool no one entry can stop, with real Halo2 proofs against the leader's node: the leader
// quotes a fee (GET /fee) and opens each waiting spend's memos with its own keys (tacit-leader/fees.mjs, what leader.mjs runs); a shield
// that pays it lands, one that does not is refused with the reason on its receipt. A spend the leader will not take is posted to the
// forced queue instead: the node makes the bytes TacitBlocks.force takes, which the program's own parser (`tacit-block-node forced`)
// reads back as the spend byte for byte, and a block takes from the queue. A shield admitted at no margin that a rate-raising block makes
// underpriced leaves the mempool with its reason, and blocks go on being built.
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-chain-fee-force.test.mjs
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from 'poseidon-lite';
import { makeHalo2System } from '../dapp/btc-pool-halo2-prover.js';
import { makeChainWallet, assetField, sharesFor, worthOf } from '../dapp/tacit-chain-wallet.js';
import { makeChainClient, sharesWorth, forcedBytes } from '../dapp/tacit-chain-client.js';
import { makeFeeDesk, feeTerms, admitPaying } from '../tacit-leader/fees.mjs';

const T = 100_000_000n; // 1 TAC in units
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const D = join(HERE, '../dapp/btc-pool/');
const PORT = 19100 + Math.floor(Math.random() * 400);
const LEADER = `http://127.0.0.1:${PORT}`;
const BLOCKS = '0x00000000000000000000000000000000000b10c5';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const OUT_TO = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const FEE = 2_000_000n;   // 0.02 TAC
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const sel = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4)).toString('hex');
const poseidon = (xs) => ({ 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 })[xs.length](xs);

const pin = JSON.parse(readFileSync(D + 'pin.json', 'utf8'));
const system = () => makeHalo2System({ wasm: readFileSync(D + pin.wasm), params: readFileSync(D + pin.params), vk: readFileSync(D + pin.vk), pinnedVkHash: pin.vk_hash, worker: null });
const asset = assetField(Uint8Array.from([...new Array(12).fill(0), ...bytes(TAC)]));
const assetHex = '0x' + asset.toString(16).padStart(64, '0');
const env = { ...process.env, TACIT_NODE_ASSET: assetHex };
delete env.TACIT_NODE_ADMIN;   // the test is the leader, from loopback
const server = spawn(BIN, ['serve', '1', `${BLOCKS}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'ignore', 'inherit'], env });
const api = async (method, path, body) => { const r = await fetch(LEADER + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, status: r.status, ...(await r.json()) }; };
const node = async (method, path, body) => { const r = await api(method, path, body); if (!r.ok) throw new Error(`${path}: ${r.error}`); return r; };
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
const until = async (f, what) => { for (let i = 0; i < 300; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 200)); } throw new Error(`timed out: ${what}`); };

// what leader.mjs does between building a block and seeing it land: the fee checked, only spends that pay taken
const paying = new Set();
async function landBlock({ queue = [], exclude = [] } = {}) {
  await admitPaying({ desk, node, paying, ids: (await node('GET', '/mempool')).spends });
  const b = await node('POST', '/build', { time: Math.floor(Date.now() / 1000), queue, exclude, only: [...paying] });
  const pv = bytes(b.publicValues);
  const words = Array.from({ length: pv.length / 32 }, (_, i) => hx(pv.subarray(32 * i, 32 * i + 32)));
  const leaves = b.lists.leaves.length > 2 ? b.lists.leaves.slice(2).match(/.{64}/g).map((x) => '0x' + x) : [];
  const memos = b.lists.memos.length > 2 ? b.lists.memos.slice(2).match(/.{2304}/g).map((x) => '0x' + x) : [];
  await node('POST', '/landed', { words, leaves, memos, nullifiers: b.lists.nullifiers });
  return b;
}
let desk;

try {
  await until(async () => { try { await fetch(LEADER + '/state'); return true; } catch { return false; } }, 'the node');
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

  // the leader's desk: its chain keys from a seed, its fee quoted on the node
  desk = makeFeeDesk({ seed: hx(new Uint8Array(32).fill(0x5e)), chain, asset, terms: feeTerms({ FEE_MIN: String(FEE) }) });
  const q = desk.quote({ now: Math.floor(Date.now() / 1000), baseFee: 0n, price: null });
  assert.equal(q.fee, String(FEE), 'with no price, the fee is the minimum');
  await node('POST', '/fee', q);
  const leaderReads = { notes: (f, l) => api('GET', `/notes?from=${f}&limit=${l}`), spent: async (nf) => (await api('GET', `/spent/${nf}`)).spent };

  const aliceStore = store();
  const alice = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x11), system, storage: aliceStore });
  assert.equal((await alice.fee()).units, FEE, 'the client reads the leader\'s fee');

  // 1. Alice shields 1,000 TAC: her note and the leader's fee note; the leader opens it and takes the shield
  const sh = await alice.shield(1000n * T);
  assert.equal(sh.submission.memos.length, 2, 'her note and the fee note');
  await Promise.all([sh.submit(), until(async () => (await api('GET', '/mempool')).spends.length > 0, 'the shield').then(() => landBlock())]);
  const r1 = await alice.rate();
  const aliceShares = await alice.scan();
  assert.equal(aliceShares, sharesFor(1000n * T, { pool: 0n, shares: 0n }) - sharesWorth(FEE, { pool: 0n, shares: 0n }), 'her note is the shares less the fee');
  let fees = (await desk.wallet.scan(desk.keys, leaderReads)).notes;
  assert.equal(fees.length, 1);
  assert.ok(worthOf(fees[0].value, r1) >= FEE, 'the leader\'s note is worth its fee');
  console.log('1. a shield that pays the leader landed; the leader found its fee note');

  // 2. a spend that pays no fee (its wallet read none) is refused, the reason on its receipt; it never reaches a block
  const bob = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x22), system, storage: store(),
    fetchImpl: (u, o) => (String(u).endsWith('/fee') ? Promise.resolve(new Response('{"fee":"0"}', { status: 200 })) : fetch(u, o)) });
  const bare = await bob.shield(50n * T);
  assert.equal(bare.submission.memos.length, 2, 'his note padded with a zero one, no fee note');
  const refused = bare.submit().then(() => null, (e) => e);
  await until(async () => (await api('GET', '/mempool')).spends.length > 0, 'bob\'s shield');
  // the leader quotes on every pass; proofs on a busy machine can outlast the quote window, so quote again before checking
  await node('POST', '/fee', desk.quote({ now: Math.floor(Date.now() / 1000), baseFee: 0n, price: null }));
  const out = await admitPaying({ desk, node, paying, ids: (await node('GET', '/mempool')).spends });
  assert.equal(out.length, 1, 'the leader refused it');
  const err = await refused;
  assert.ok(err && /less than its fee/.test(err.message), `refused with its reason: ${err?.message}`);
  assert.ok(err.kept?.submission, 'the refused spend stays kept, to be posted to Ethereum');
  assert.equal((await api('GET', '/mempool')).spends.length, 0, 'it left the mempool');
  assert.ok(!(await api('POST', '/spend', bare.submission)).ok, 'sent again, it is refused again');
  console.log('2. a spend that pays no fee was refused, with its reason');

  // 3. Carol's shield buys its shares at no margin at all: takeable now, and waiting
  const W = makeChainWallet({ poseidon, prover: system(), chain, asset });
  const carol = W.keys(new Uint8Array(32).fill(0x33));
  const tight = await W.spend(carol, { dep: { v: sharesFor(50n * T, r1, 0n), amount: 50n * T }, outputs: [{ to: desk.wallet.address(desk.keys), value: sharesWorth(FEE, r1) }], leader: leaderReads });
  const c = await api('POST', '/spend', tight.submission);
  assert.ok(c.ok, `carol's shield is admitted: ${c.error}`);

  // 4. the leader will not take Alice's withdrawal (here: it never answers a spend), so she posts it to the forced queue herself. The
  //    node makes the bytes; the program's parser reads them back as her spend, and the client's own rebuild agrees but for the hints
  const censored = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x11), system, storage: aliceStore,
    fetchImpl: (u, o) => (String(u).endsWith('/spend') ? Promise.reject(new TypeError('fetch failed')) : fetch(u, o)) });
  await censored.scan();
  const wErr = await censored.withdraw(OUT_TO, 100n * T).then(() => null, (e) => e);
  assert.ok(wErr?.kept, 'the withdrawal is kept');
  assert.equal((await censored.pending()).length, 1, 'kept until it lands');
  const payload = await censored.forcePayload(wErr.kept.submission);
  const dir = mkdtempSync(join(tmpdir(), 'tacit-forced-'));
  writeFileSync(join(dir, 'p.hex'), payload);
  const parts = JSON.parse(execFileSync(BIN, ['forced', join(dir, 'p.hex')], { encoding: 'utf8' }));
  const sub = wErr.kept.submission;
  assert.equal(parts.publics, sub.publics, 'publics');
  assert.equal(parts.proof, sub.proof, 'proof');
  assert.equal(parts.data, sub.data, 'the spend data, memo hashes included');
  assert.deepEqual(parts.memos.filter((m) => !/^0x0+$/.test(m)), sub.memos, 'a memo per output slot');
  assert.equal(bytes(parts.hints).length, 1280, 'hints');
  assert.equal(hx(forcedBytes(sub, parts.hints)), payload, 'the client rebuilds the same bytes around the hints');
  assert.ok(parts.bytes >= 384 + 2080 + 1280 + 3 * 1152 + 54, 'at least the landing contract\'s smallest posting');
  const bad = await api('POST', '/forced', { ...sub, proof: sub.proof.slice(0, -2) + (sub.proof.endsWith('00') ? '01' : '00') });
  assert.ok(!bad.ok, 'a spend whose proof does not verify gets no posting');

  // the next block takes the posted withdrawal from the queue (not Carol's shield, held back here), and its exit fee raises the rate
  const b2 = await landBlock({ queue: [payload], exclude: [c.id] });
  assert.equal(b2.queueTaken, 1);
  assert.equal(BigInt('0x' + b2.lists.exits.slice(2 + 64, 2 + 128)), 100n * T, 'the block pays the posted exit');
  assert.equal(b2.includes.length, 0, 'nothing from the mempool');
  assert.deepEqual(await censored.pending(), [], 'landed: no longer kept');
  const r2 = await alice.rate();
  assert.ok(worthOf(1000n * T, r2) > worthOf(1000n * T, r1), 'the rate rose');
  console.log('3. a withdrawal the leader would not take went in through the forced queue');

  // 5. the rate passed Carol's margin: her shield left the mempool with its reason, and blocks go on being built
  const rc = await api('GET', `/receipt/${c.id}`);
  assert.equal(rc.status, 'refused');
  assert.match(rc.error, /no longer takeable/);
  assert.equal((await api('GET', '/mempool')).spends.length, 0);
  const bob2 = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x22), system, storage: store() });
  const sh2 = await bob2.shield(40n * T);
  await Promise.all([sh2.submit(), until(async () => (await api('GET', '/mempool')).spends.length > 0, 'bob\'s shield').then(() => landBlock())]);
  assert.ok(await bob2.scan() > 0n);
  console.log('4. an underpriced shield was dropped with its reason; the next block built and landed');

  fees = (await desk.wallet.scan(desk.keys, leaderReads)).notes;
  assert.equal(fees.length, 3, 'the leader holds a fee note from each spend that landed');
  const st = await api('GET', '/state');
  console.log(JSON.stringify({ ok: true, height: st.height, leaderFees: String(worthOf(fees.reduce((t, n) => t + n.value, 0n), await alice.rate())) }));
} finally {
  server.kill();
}
