// The chain bot against the leader's node with real Halo2 proofs, blocks built and landed here as the leader would: a permitted shield
// into A, payments A↔B found by the receiver, a merge, a withdrawal to the account, the state kept on disk across a restart, a pause on an
// unhealthy leader or unreadable Ethereum. Ethereum is a stub answering what the bot and the client read.
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-bot-e2e.test.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { assetField, makeChainWallet } from '../dapp/tacit-chain-wallet.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from '../dapp/vendor/tacit-poseidon.min.js';
import { makeBot, halo2System } from '../tacit-bot/bot.mjs';
import { tac, fmt, UNIT } from '../tacit-bot/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = process.env.TACIT_NODE_BIN || join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
if (!existsSync(BIN)) { console.log('tacit-block-node is not built: skipped'); process.exit(0); }
const PORT = 19700 + Math.floor(Math.random() * 90);
const LEADER = `http://127.0.0.1:${PORT}`;
const BLOCKS = '0x00000000000000000000000000000000000b10c5';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const sel = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4)).toString('hex');
const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const asset = assetField(Uint8Array.from([...new Array(12).fill(0), ...bytes(TAC)]));
const assetHex = '0x' + asset.toString(16).padStart(64, '0');
const server = spawn(BIN, ['serve', '1', `${BLOCKS}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TACIT_NODE_ASSET: assetHex } });
const api = async (method, path, body) => { const r = await fetch(LEADER + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, ...(await r.json()) }; };
let lastLanded = Math.floor(Date.now() / 1000), landing = false, blocks = 0;
async function landBlock() {
  const b = await api('POST', '/build', { time: Math.floor(Date.now() / 1000), queue: [] });
  if (!b.ok) return;
  const pv = bytes(b.publicValues);
  const words = Array.from({ length: pv.length / 32 }, (_, i) => hx(pv.subarray(32 * i, 32 * i + 32)));
  const leaves = b.lists.leaves.length > 2 ? b.lists.leaves.slice(2).match(/.{64}/g).map((x) => '0x' + x) : [];
  const memos = b.lists.memos.length > 2 ? b.lists.memos.slice(2).match(/.{2304}/g).map((x) => '0x' + x) : [];
  assert.ok((await api('POST', '/landed', { words, leaves, memos, nullifiers: b.lists.nullifiers })).ok);
  lastLanded = Math.floor(Date.now() / 1000); blocks++;
}
// the leader's loop: a block as soon as it holds a spend
const lander = setInterval(async () => {
  if (landing) return; landing = true;
  try { if ((await api('GET', '/mempool')).spends.length) await landBlock(); } catch { } finally { landing = false; }
}, 500);

let eoaTac = tac('500') * UNIT, broken = false;
const permits = [];
const rpcCall = async (m, [{ data, to }]) => {
  if (broken) throw new Error('node down');
  const st = await api('GET', '/state');
  const d = data.slice(2, 10);
  if (d === sel('CHAIN()')) return st.chain;
  if (d === sel('TAC_ASSET()')) return assetHex;
  if (d === sel('pool()')) return word(st.pool);
  if (d === sel('shares()')) return word(st.shares);
  if (d === sel('height()')) return word(st.height);
  if (d === sel('lastLanded()')) return word(lastLanded);
  if (d === sel('TAC()')) return word(BigInt(TAC));
  if (d === sel('inbox(uint256,uint256,bytes32,bytes32,bytes32,bytes32)')) return word(BigInt('0x' + Buffer.from(keccak_256(bytes(data))).subarray(12).toString('hex')));
  if (d === '70a08231') return word(eoaTac);                  // balanceOf
  if (d === '3644e515') return word(7);                       // DOMAIN_SEPARATOR
  if (d === '7ecebe00') return word(permits.length);          // nonces
  throw new Error('unexpected call ' + d + ' to ' + to);
};

const T0 = Date.now();
try {
  for (let i = 0; i < 60; i++) { try { await fetch(LEADER + '/state'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  // the leader's terms, as the live one names them
  const SWEEP = 454_358_580_000_000_000n;
  // a leader fee note to an address of its own, as the live leader asks
  const lw = makeChainWallet({ poseidon: (xs) => ({ 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 })[xs.length](xs), prover: null, chain: (await api('GET', '/state')).chain, asset });
  const leaderAddr = lw.encodeAddress(lw.address(lw.keys(new Uint8Array(32).fill(0x77))));
  assert.ok((await api('POST', '/fee', { address: leaderAddr, fee: '24989722', shieldCap: String(tac('1000')), sweepFee: String(SWEEP) })).ok);

  const stateDir = mkdtempSync(join(tmpdir(), 'tacit-bot-'));
  const cfg = { blocks: BLOCKS, leader: LEADER };
  const sys = halo2System();
  const lines = [];
  const env = { BOT_PAY_MAX_TAC: '20', BOT_MAX_FAILURES: '3' };
  // rand: 0.9 keeps away from the occasional actions; queued answers pick them
  let rs = [];
  const rand = () => (rs.length ? rs.shift() : 0.9);
  const make = () => makeBot({ seed: 'c0'.repeat(32), cfg, rpcCall, system: () => sys, stateDir, env, rand, log: (o) => { lines.push(o); console.log(JSON.stringify(o)); } });
  let bot = await make();

  // 1. nothing on the chain: a shield into A, sent in by a permit of the account's
  let r = await bot.tick();
  assert.equal(r.action, 'shield', JSON.stringify(r)); assert.ok(r.ok, r.error); assert.equal(r.units, '150');
  const v1 = await bot.view();
  assert.ok(v1.a.worth > tac('149.5') && v1.a.worth <= tac('150'), fmt(v1.a.worth));
  const held = (await api('POST', '/pending', {})).spends;
  assert.equal(held.length, 0, 'nothing left with the leader');
  eoaTac -= tac('150') * UNIT + SWEEP; permits.push(1);

  // 2. payments, A → B and back, each found by the receiver
  for (const q of [[0.9, 0.9, 0.5, 0.5], [0.9, 0.9, 0.9, 0.5]]) {
    rs = [...q];
    r = await bot.tick();
    assert.equal(r.action, 'pay', JSON.stringify(r)); assert.ok(r.ok, r.error);
    assert.ok(Number.isInteger(r.height));
  }
  const v2 = await bot.view();
  assert.ok(v2.b.worth > 0n, 'B holds what it was paid');
  // 3. a merge (A pays itself) and a withdrawal to the account
  await bot.clients.a.publish();
  const m = await bot.clients.a.pay(await bot.clients.a.resolve(await bot.clients.a.lane()), tac('1'), { timeoutMs: 120e3 });
  assert.ok(Number.isInteger(m.height), 'a payment to itself lands');
  rs = [0.9, 0.01, 0.5];
  r = await bot.tick();
  assert.equal(r.action, 'withdraw', JSON.stringify(r)); assert.ok(r.ok, r.error);
  assert.ok(Number(r.units) >= 5 && Number(r.units) <= 40);

  // 4. a restart from the same disk: the same wallets, nothing lost
  const before = await bot.view();
  bot = await make();
  await bot.resume(30e3);
  const after = await bot.view();
  assert.equal(after.a.worth + after.b.worth, before.a.worth + before.b.worth, 'restored from disk');
  assert.ok(bot.snapshot().actions >= 4);

  // 5. an unhealthy leader pauses (no failure counted), and so does Ethereum unreadable
  const t = await makeBot({ seed: 'c0'.repeat(32), cfg: { ...cfg, leader: 'http://127.0.0.1:9' }, rpcCall, system: () => sys, stateDir: mkdtempSync(join(tmpdir(), 'tacit-bot-')), env, log: () => {} });
  assert.equal((await t.tick()).action, 'pause');
  assert.equal(t.snapshot().failures, 0);
  broken = true;
  const statusPause = await bot.tick();
  assert.equal(statusPause.action, 'pause', 'Ethereum unreadable: paused');
  broken = false;
  r = await bot.tick();
  assert.ok(r.ok, JSON.stringify(r));
  const health = bot.snapshot();
  assert.equal(health.paused, null);
  assert.ok(!JSON.stringify(health).includes('c0c0c0'), 'no secret in the health answer');
  assert.ok(health.balances && health.feesToday);
  console.log(JSON.stringify({ ok: true, blocks, ms: Date.now() - T0, health }));
} finally {
  clearInterval(lander);
  server.kill();
}
