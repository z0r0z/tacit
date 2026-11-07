// The leader's fee and the escape hatch on a mainnet fork: real TacitSeats and TacitBlocks (a verifier that takes any proof stands in for
// the GPU), real TAC, the leader (tacit-leader/leader.mjs) with its chain keys, quoting its fee from Ethereum's base fee and TAC's price in
// the live confidential pool. Alice shields paying the fee; a spend that pays none is refused. Then the leader stops taking spends: Carol's
// shield (whose deposit only she may post) and Alice's withdrawal are posted to the forced queue from their own accounts, and the leader's
// next blocks take them.
//   TACIT_BLOCKS_FORK_RPC=https://ethereum-rpc.publicnode.com node tests/tacit-chain-force-fork.mjs
// Needs foundry (anvil, cast, forge) and the built tacit-block-node binary.
import assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeHalo2System } from '../dapp/btc-pool-halo2-prover.js';
import { worthOf } from '../dapp/tacit-chain-wallet.js';
import { makeChainClient } from '../dapp/tacit-chain-client.js';
import { makeFeeDesk, feeTerms } from '../tacit-leader/fees.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CONTRACTS = join(ROOT, 'contracts');
const D = join(ROOT, 'dapp/btc-pool/');
const FORK = process.env.TACIT_BLOCKS_FORK_RPC;
if (!FORK) { console.log('TACIT_BLOCKS_FORK_RPC is not set: skipped'); process.exit(0); }
const PORT = 17500 + Math.floor(Math.random() * 400);
const RPC = `http://127.0.0.1:${PORT}`;
const NODE = `127.0.0.1:${PORT + 1000}`;
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const CTAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const DEPLOYER = { addr: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' };
const LEADER = { addr: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' };
const ALICE = { addr: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' };
const CAROL = { addr: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', key: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' };
const BOB_L1 = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const SEED = '0x' + '5e'.repeat(32);
const UNIT = 10n ** 10n;
const T = 100_000_000n;
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', cwd: CONTRACTS, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cast = (...a) => sh('cast', a);
// a transaction that reverts is mined with a fixed gas limit, so its receipt's status is checked
const send = (to, sig, args, from) => { const out = cast('send', to, sig, ...args, '--private-key', from.key, '--rpc-url', RPC, '--gas-limit', '8000000'); if (/^status\s+0/m.test(out)) throw new Error(`${sig} reverted`); return out; };
const call = (to, sig, ...args) => cast('call', to, sig, ...args, '--rpc-url', RPC).split(' ')[0];

const procs = [];
const stop = () => procs.forEach((p) => p.kill());
process.on('exit', stop);

async function main() {
  procs.push(spawn('anvil', ['--fork-url', FORK, '--port', String(PORT), '--silent'], { stdio: 'ignore' }));
  for (let i = 0; i < 60; i++) { try { cast('block-number', '--rpc-url', RPC); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }

  const create = (path, ctor) => sh('forge', ['create', path, '--rpc-url', RPC, '--private-key', DEPLOYER.key, '--broadcast', ...(ctor ? ['--constructor-args', ...ctor] : [])]).match(/Deployed to: (0x[0-9a-fA-F]{40})/)[1];
  const spendVk = JSON.parse(readFileSync(join(CONTRACTS, 'test/fixtures/tacit-blocks-mainnet.json'), 'utf8')).spendVk;
  const verifier = create('test/TacitBlocks.t.sol:AcceptAll');
  const seats = create('src/TacitSeats.sol:TacitSeats', [TAC, '1000000000000000000000', '50', LEADER.addr]);
  const blocks = create('src/TacitBlocks.sol:TacitBlocks', [verifier, '0x0000000000000000000000000000000000000000000000000000000000000001', spendVk, seats, '600', '3600', TAC, POOL, CTAC]);
  const fromBlock = Number(cast('block-number', '--rpc-url', RPC));
  const chain = call(blocks, 'CHAIN()(bytes32)');
  const asset = call(blocks, 'TAC_ASSET()(bytes32)');

  cast('rpc', 'anvil_setBalance', POOL, '0x56BC75E2D63100000', '--rpc-url', RPC);
  cast('rpc', 'anvil_impersonateAccount', POOL, '--rpc-url', RPC);
  for (const who of [ALICE, CAROL]) {
    cast('send', TAC, 'mint(address,uint256)', who.addr, (5000n * T * UNIT).toString(), '--from', POOL, '--unlocked', '--rpc-url', RPC);
    send(TAC, 'approve(address,uint256)', [blocks, (5000n * T * UNIT).toString()], who);
  }

  const leader = spawn('node', [join(ROOT, 'tacit-leader/leader.mjs')], {
    env: { ...process.env, RPC_URL: RPC, BLOCKS: blocks, FROM_BLOCK: String(fromBlock), LEADER_KEY: LEADER.key, NODE_ADDR: NODE, PROVER: 'stub', MIN_SPENDS: '1', MAX_WAIT_SECS: '1', POLL_SECS: '1', ARCHIVE_DIR: join(mkdtempSync(join(tmpdir(), 'tacit-force-')), 'a'), TACIT_NODE_ADMIN: 'force-token', LEADER_CHAIN_SEED: SEED },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(leader);
  const leaderLog = [];
  leader.stdout.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) { leaderLog.push(l); if (process.env.VERBOSE) console.log(l); } });
  const api = async (method, path, body) => { const r = await fetch(`http://${NODE}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, status: r.status, ...(await r.json()) }; };
  for (let i = 0; i < 120; i++) { try { if ((await api('GET', '/fee')).address) break; } catch { } await new Promise((r) => setTimeout(r, 500)); }
  const quoted = await api('GET', '/fee');
  assert.ok(quoted.address && BigInt(quoted.fee) > 0n, 'the leader quotes a fee');
  console.log(`the leader asks ${Number(BigInt(quoted.fee)) / 1e8} TAC a spend (from the fork's base fee and the pool's price)`);
  assert.equal((await api('POST', '/fee', { fee: '0' })).status, 403, 'only the leader sets its fee');
  assert.ok(!('deposits' in (await api('GET', '/mempool'))), 'the mempool shows no deposits or permits');
  const height = () => Number(call(blocks, 'height()(uint256)'));
  const waitHeight = async (h) => { for (let i = 0; i < 180; i++) { if (height() >= h && (await api('GET', '/state')).height >= h) return; await new Promise((r) => setTimeout(r, 1000)); } throw new Error(`no block ${h}; the leader said:\n${leaderLog.slice(-6).join('\n')}`); };

  // the app's client, reading the landing contract on the fork
  let id = 0;
  const rpcCall = async (method, params) => { const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
  const pin = JSON.parse(readFileSync(D + 'pin.json', 'utf8'));
  const system = () => makeHalo2System({ wasm: readFileSync(D + pin.wasm), params: readFileSync(D + pin.params), vk: readFileSync(D + pin.vk), pinnedVkHash: pin.vk_hash, worker: null });
  const cfg = { blocks, leader: `http://${NODE}` };
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
  const aliceStore = store(), carolStore = store();
  const client = (seed, storage, fetchImpl) => makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(seed), system, storage, ...(fetchImpl ? { fetchImpl } : {}) });
  // a leader that takes no spend (it never answers one)
  const deaf = (u, o) => (String(u).endsWith('/spend') ? Promise.reject(new TypeError('fetch failed')) : fetch(u, o));
  const desk = makeFeeDesk({ seed: SEED, chain, asset, terms: feeTerms({}) });
  const wallet = { notes: (f, l) => api('GET', `/notes?from=${f}&limit=${l}`), spent: async (nf) => (await api('GET', `/spent/${nf}`)).spent };

  // 1. Alice shields 1,000 TAC: her deposit on Ethereum, then the spend with the leader's fee note, which the leader takes
  const alice = client(0xa1, aliceStore);
  const s = await alice.shield(1000n * T);
  assert.ok(s.fee > 0n, 'the shield pays the fee the leader quoted');
  const d = s.deposit;
  send(blocks, 'deposit(uint256,uint256,bytes32,bytes32,bytes32)', [String(d.shares), String(d.amount), d.cx, d.cy, d.body], ALICE);
  await s.submit({ from: ALICE.addr });
  await waitHeight(1);
  const fees1 = (await desk.wallet.scan(desk.keys, wallet)).notes;
  assert.equal(fees1.length, 1, 'the leader holds its fee note');
  assert.ok(worthOf(fees1[0].value, await alice.rate()) >= s.fee);
  console.log(`1. Alice shielded 1,000 TAC and paid the leader ${Number(s.fee) / 1e8} TAC`);

  // 2. a payment that pays no fee (its wallet read none) is refused, the leader's reason on its receipt
  const cheap = client(0xa1, aliceStore, (u, o) => (String(u).endsWith('/fee') ? Promise.resolve(new Response('{"fee":"0"}', { status: 200 })) : fetch(u, o)));
  await cheap.scan();
  const carol = client(0xc3, carolStore);
  const refused = await cheap.pay(await carol.address(), 10n * T).then(() => null, (e) => e);
  assert.match(refused?.message || '', /less than its fee/);
  assert.ok(leaderLog.some((l) => l.includes('"refused"')), 'the leader logged the refusal');
  console.log('2. a payment that paid no fee was refused');

  // 3. the leader stops taking spends. Carol shields anyway: her deposit is made with deposit(), so only she may post the spend that
  //    takes it in; she posts it from her own account and the leader's next block takes it from the queue
  const carolDeaf = client(0xc3, carolStore, deaf);
  const cs = await carolDeaf.shield(200n * T);
  const cd = cs.deposit;
  send(blocks, 'deposit(uint256,uint256,bytes32,bytes32,bytes32)', [String(cd.shares), String(cd.amount), cd.cx, cd.cy, cd.body], CAROL);
  const cErr = await cs.submit({ from: CAROL.addr }).then(() => null, (e) => e);
  assert.ok(cErr?.kept, 'kept when the leader does not answer');
  const cPayload = await carolDeaf.forcePayload(cErr.kept.submission);
  assert.throws(() => cast('call', blocks, 'force(bytes)', cPayload, '--from', DEPLOYER.addr, '--rpc-url', RPC), /NotDepositor|revert/, 'only the depositor posts a shield of a deposit()');
  send(blocks, 'force(bytes)', [cPayload], CAROL);
  await waitHeight(2);
  assert.ok(await carol.scan() > 0n, 'Carol holds her shield');
  assert.deepEqual(await carolDeaf.pending(), [], 'landed: no longer kept');
  console.log('3. Carol\'s shield went in through the forced queue, posted from the account that made its deposit');

  // 4. Alice's withdrawal, which the leader will not take either: anyone may post a spend of notes, and it pays out on Ethereum
  const aliceDeaf = client(0xa1, aliceStore, deaf);
  await aliceDeaf.scan();
  const wErr = await aliceDeaf.withdraw(BOB_L1, 100n * T).then(() => null, (e) => e);
  assert.ok(wErr?.kept);
  send(blocks, 'force(bytes)', [await aliceDeaf.forcePayload(wErr.kept.submission)], DEPLOYER);
  await waitHeight(3);
  assert.equal(BigInt(call(blocks, 'owed(address)(uint256)', BOB_L1)), 100n * T * UNIT, 'the posted withdrawal is credited');
  send(blocks, 'withdraw(address)', [BOB_L1], DEPLOYER);
  assert.equal(BigInt(call(TAC, 'balanceOf(address)(uint256)', BOB_L1)), 100n * T * UNIT, 'and sent on');
  console.log('4. Alice\'s withdrawal went in through the forced queue');

  const st = await api('GET', '/state');
  assert.equal(st.state, call(blocks, 'state()(bytes32)'), 'the leader\'s node agrees with the contract');
  assert.equal(BigInt(call(blocks, 'pool()(uint64)')), BigInt(st.pool));
  assert.equal(BigInt(call(TAC, 'balanceOf(address)(uint256)', blocks)), BigInt(st.pool) * UNIT, 'the contract holds exactly the pool');
  console.log(JSON.stringify({ ok: true, height: st.height, fee: quoted.fee, leaderNotes: (await desk.wallet.scan(desk.keys, wallet)).notes.length }));
}

main().then(() => { stop(); process.exit(0); }).catch((e) => { console.error(e); stop(); process.exit(1); });
