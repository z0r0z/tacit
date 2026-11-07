// A user's whole story on a mainnet fork, wallet to Ethereum and back: Alice deposits TAC on L1 and shields it (the chain wallet's real Halo2
// proof), pays Bob privately, Bob withdraws part of it to an Ethereum address and hops part into the live confidential pool; the leader
// follows the chain, lands every block and sends the hop on. At the end the contract holds exactly what the notes are worth.
//   TACIT_BLOCKS_FORK_RPC=https://ethereum-rpc.publicnode.com node tests/tacit-chain-user-story.mjs
// Needs foundry (anvil, cast, forge) and the built tacit-block-node binary. A verifier that takes any proof stands in for the GPU.
import assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from 'poseidon-lite';
import { makeHalo2System } from '../dapp/btc-pool-halo2-prover.js';
import { makeChainWallet, hopOp, poolOp, poolShare, sharesToPay, worthOf } from '../dapp/tacit-chain-wallet.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CONTRACTS = join(ROOT, 'contracts');
const D = join(ROOT, 'dapp/btc-pool/');
const FORK = process.env.TACIT_BLOCKS_FORK_RPC;
if (!FORK) { console.log('TACIT_BLOCKS_FORK_RPC is not set: skipped'); process.exit(0); }
const PORT = 18500 + Math.floor(Math.random() * 400);
const RPC = `http://127.0.0.1:${PORT}`;
const NODE = `127.0.0.1:${PORT + 1000}`;
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const CTAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const DEPLOYER = { addr: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' };
const LEADER = { addr: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' };
const USER = { addr: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' };
const BOB_L1 = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const UNIT = 10n ** 10n;
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', cwd: CONTRACTS, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cast = (...a) => sh('cast', a);
const send = (to, sig, args, from = USER) => cast('send', to, sig, ...args, '--private-key', from.key, '--rpc-url', RPC, '--gas-limit', '8000000');
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
  const asset = BigInt(call(blocks, 'TAC_ASSET()(bytes32)'));

  cast('rpc', 'anvil_setBalance', POOL, '0x56BC75E2D63100000', '--rpc-url', RPC);
  cast('rpc', 'anvil_impersonateAccount', POOL, '--rpc-url', RPC);
  cast('send', TAC, 'mint(address,uint256)', USER.addr, (10000n * 100_000_000n * UNIT).toString(), '--from', POOL, '--unlocked', '--rpc-url', RPC);
  send(TAC, 'approve(address,uint256)', [blocks, (10000n * 100_000_000n * UNIT).toString()]);

  const leader = spawn('node', [join(ROOT, 'tacit-leader/leader.mjs')], {
    env: { ...process.env, RPC_URL: RPC, BLOCKS: blocks, FROM_BLOCK: String(fromBlock), LEADER_KEY: LEADER.key, NODE_ADDR: NODE, PROVER: 'stub', MIN_SPENDS: '1', MAX_WAIT_SECS: '1', POLL_SECS: '1', ARCHIVE_DIR: join(mkdtempSync(join(tmpdir(), 'tacit-story-')), 'a'), TACIT_NODE_ADMIN: 'story-token' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(leader);
  const leaderLog = [];
  leader.stdout.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) { leaderLog.push(l); if (process.env.VERBOSE) console.log(l); } });
  for (let i = 0; i < 120; i++) { try { await fetch(`http://${NODE}/state`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }

  const api = async (method, path, body) => { const r = await fetch(`http://${NODE}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, status: r.status, ...(await r.json()) }; };
  const wallet = { path: (i) => api('GET', `/path/${i}`), notes: (f, l) => api('GET', `/notes?from=${f}&limit=${l}`), spent: async (nf) => (await api('GET', `/spent/${nf}`)).spent };
  const height = () => Number(call(blocks, 'height()(uint256)'));
  const waitHeight = async (h) => { for (let i = 0; i < 180; i++) { if (height() >= h && (await api('GET', '/state')).height >= h) return; await new Promise((r) => setTimeout(r, 1000)); } throw new Error(`no block ${h}; the leader said:\n${leaderLog.slice(-6).join('\n')}`); };

  const poseidon = (xs) => ({ 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 })[xs.length](xs);
  const pin = JSON.parse(readFileSync(D + 'pin.json', 'utf8'));
  const prover = makeHalo2System({ wasm: readFileSync(D + pin.wasm), params: readFileSync(D + pin.params), vk: readFileSync(D + pin.vk), pinnedVkHash: pin.vk_hash, worker: null });
  const w = makeChainWallet({ poseidon, prover, chain, asset });
  const alice = w.keys(new Uint8Array(32).fill(0xa1));
  const bob = w.keys(new Uint8Array(32).fill(0xb2));
  const submit = async (s, extra = {}) => { const r = await api('POST', '/spend', { ...s.submission, ...extra }); assert.ok(r.ok, `the leader refused a spend: ${r.error}`); };

  // shares and the rate: one unit a share to start; the exit fee and pool shares raise it
  const rate = async () => { const st = await api('GET', '/state'); return { pool: BigInt(st.pool), shares: BigInt(st.shares) }; };
  const T = 100_000_000n; // 1 TAC in units

  // 1. Alice shields 1,000 TAC (she makes the deposit on Ethereum, then proves the spend that takes it in)
  const tacBefore = BigInt(call(TAC, 'balanceOf(address)(uint256)', blocks));
  const shield = await w.spend(alice, { dep: { v: 1000n * T, amount: 1000n * T }, leader: wallet });
  const d = shield.deposit;
  send(blocks, 'deposit(uint256,uint256,bytes32,bytes32,bytes32)', [String(d.shares), String(d.amount), d.cx, d.cy, d.body]);
  await submit(shield);
  await waitHeight(1);
  console.log('1. Alice shielded 1,000 TAC');

  // 1b. Carol comes from the confidential pool: its unwrap mints her TAC straight to her shield's inbox (no address of hers, no
  //     approval), and the leader sweeps it in before it lands her shield
  const carol = w.keys(new Uint8Array(32).fill(0xc3));
  const cshield = await w.spend(carol, { dep: { v: 250n * T, amount: 250n * T }, leader: wallet });
  const cd = cshield.deposit;
  const back = '0x' + 'b4'.repeat(32);
  const box = call(blocks, 'inbox(uint256,uint256,bytes32,bytes32,bytes32,bytes32)(address)', String(cd.shares), String(cd.amount), cd.cx, cd.cy, cd.body, back);
  cast('send', TAC, 'mint(address,uint256)', box, (250n * T * UNIT).toString(), '--from', POOL, '--unlocked', '--rpc-url', RPC);
  await submit(cshield, { back });
  await waitHeight(2);
  assert.deepEqual((await w.scan(carol, wallet)).notes.map((n) => n.value), [250n * T]);
  assert.ok(leaderLog.some((l) => l.includes('"swept"')), 'the leader swept the inbox');
  console.log('1b. Carol shielded 250 TAC straight from a confidential pool unwrap, through her inbox');

  // 2. she pays Bob 300 privately, giving the holders their pool share
  const aliceNotes = (await w.scan(alice, wallet)).notes;
  assert.deepEqual(aliceNotes.map((n) => n.value), [1000n * T]);
  const share = poolShare(await rate());
  await submit(await w.spend(alice, { inputs: aliceNotes, outputs: [{ to: w.address(bob), value: 300n * T }], exit: { v: share, amount: 0n, op: poolOp() }, leader: wallet }));
  await waitHeight(3);
  const bobNotes = (await w.scan(bob, wallet)).notes;
  assert.deepEqual(bobNotes.map((n) => n.value), [300n * T]);
  console.log('2. Alice paid Bob 300 TAC; Bob found the note from the chain\'s memos alone');

  // 3. Bob withdraws exactly 120 TAC to an Ethereum address, the exit fee on top in shares
  const out = sharesToPay(120n * T, await rate());
  await submit(await w.spend(bob, { inputs: bobNotes, exit: { v: out, amount: 120n * T, to: BOB_L1 }, leader: wallet }));
  await waitHeight(4);
  assert.equal(BigInt(call(blocks, 'owed(address)(uint256)', BOB_L1)), 120n * T * UNIT);
  send(blocks, 'withdraw(address)', [BOB_L1]);
  assert.equal(BigInt(call(TAC, 'balanceOf(address)(uint256)', BOB_L1)), 120n * T * UNIT);
  console.log('3. Bob withdrew 120 TAC to an Ethereum address');

  // 4. Bob hops exactly 100 TAC into the confidential pool: the leader sends it on, the pool burns the TAC held here
  const bobLeft = (await w.scan(bob, wallet)).notes;
  assert.deepEqual(bobLeft.map((n) => n.value), [300n * T - out]);
  const supplyBefore = BigInt(call(TAC, 'totalSupply()(uint256)'));
  const hopOut = sharesToPay(100n * T, await rate());
  await submit(await w.spend(bob, { inputs: bobLeft, exit: { v: hopOut, amount: 100n * T, op: hopOp('0x' + '5a'.repeat(32)) }, leader: wallet }));
  await waitHeight(5);
  for (let i = 0; i < 30 && !leaderLog.some((l) => l.includes('hopsSent')); i++) await new Promise((r) => setTimeout(r, 1000));
  assert.ok(leaderLog.some((l) => l.includes('hopsSent')), 'the leader sent the hop on');
  assert.equal(supplyBefore - BigInt(call(TAC, 'totalSupply()(uint256)')), 100n * T * UNIT, 'the confidential pool burned exactly the hopped TAC');
  console.log('4. Bob hopped 100 TAC into the confidential pool');

  // 5. the contract holds exactly the pool, the pool is the program's, and the fees stayed with the holders
  const r = await rate();
  assert.equal(r.pool, 1030n * T, '1,250 in, 220 out');
  assert.equal(BigInt(call(blocks, 'pool()(uint64)')), r.pool);
  assert.equal(BigInt(call(blocks, 'shares()(uint64)')), r.shares);
  const held = BigInt(call(TAC, 'balanceOf(address)(uint256)', blocks)) - tacBefore;
  assert.equal(held, r.pool * UNIT, 'the contract holds exactly the pool');
  const notes = async (k) => (await w.scan(k, wallet)).notes.reduce((t, n) => t + n.value, 0n);
  const [aliceEnd, bobEnd, carolEnd] = [await notes(alice), await notes(bob), await notes(carol)];
  assert.equal(aliceEnd + bobEnd + carolEnd, r.shares, 'every share is in someone\'s notes');
  assert.ok(worthOf(carolEnd, r) > 250n * T, 'Carol earned from the others\' fees without moving');
  const st = await api('GET', '/state');
  assert.equal(st.state, call(blocks, 'state()(bytes32)'));
  console.log(JSON.stringify({ ok: true, height: st.height, aliceTac: Number(worthOf(aliceEnd, r)) / 1e8, bobTac: Number(worthOf(bobEnd, r)) / 1e8, carolTac: Number(worthOf(carolEnd, r)) / 1e8, heldTac: Number(held / UNIT) / 1e8 }));
}

main().then(() => { stop(); process.exit(0); }).catch((e) => { console.error(e); stop(); process.exit(1); });
