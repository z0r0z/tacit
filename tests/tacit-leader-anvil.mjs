// The leader end to end on a mainnet fork: real TacitSeats and TacitBlocks (with a verifier that takes any proof, so no GPU is needed),
// the real TAC and the live confidential pool, the fixture chain's real spends submitted to the leader's mempool over HTTP block by
// block, the leader following the chain, building each block, landing it and sending its hops on; at the end the contract's state must be
// the fixture's final state, byte for byte.
//   TACIT_BLOCKS_FORK_RPC=https://ethereum-rpc.publicnode.com node tests/tacit-leader-anvil.mjs
// Needs foundry (anvil, cast, forge) and the built tacit-block (host) and tacit-block-node (node) binaries.
import assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CONTRACTS = join(ROOT, 'contracts');
const HOST = join(CONTRACTS, 'sp1/confidential/tacit-block/host/target/release/tacit-block');
const FORK = process.env.TACIT_BLOCKS_FORK_RPC;
if (!FORK) { console.log('TACIT_BLOCKS_FORK_RPC is not set: skipped'); process.exit(0); }
const PORT = 18500 + Math.floor(Math.random() * 400);
const RPC = `http://127.0.0.1:${PORT}`;
const NODE = `127.0.0.1:${PORT + 1000}`;
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const CTAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
// anvil's well-known accounts
const DEPLOYER = { addr: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' };
const LEADER = { addr: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' };
const USER = { addr: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' };
const MEMO_LEN = 1152;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', cwd: CONTRACTS, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const cast = (...a) => sh('cast', a);
const send = (to, sig, args, from = USER) => cast('send', to, sig, ...args, '--private-key', from.key, '--rpc-url', RPC, '--gas-limit', '8000000');
const call = (to, sig, ...args) => cast('call', to, sig, ...args, '--rpc-url', RPC);

const procs = [];
const stop = () => procs.forEach((p) => p.kill());
process.on('exit', stop);

async function main() {
  procs.push(spawn('anvil', ['--fork-url', FORK, '--port', String(PORT), '--silent'], { stdio: 'ignore' }));
  for (let i = 0; i < 60; i++) { try { cast('block-number', '--rpc-url', RPC); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }

  // the contracts, in a fixed order so the chain's address is known before its fixture is made
  const nonce = Number(cast('nonce', DEPLOYER.addr, '--rpc-url', RPC));
  const lander = cast('compute-address', DEPLOYER.addr, '--nonce', String(nonce + 2)).match(/0x[0-9a-fA-F]{40}/)[0];
  const spendVk = JSON.parse(readFileSync(join(CONTRACTS, 'test/fixtures/tacit-blocks-mainnet.json'), 'utf8')).spendVk;
  const dir = mkdtempSync(join(tmpdir(), 'tacit-leader-'));
  const fixture = join(dir, 'chain.json');
  console.log(`making the fixture for ${lander} …`);
  execFileSync(HOST, ['fixture', fixture, '1', lander], { stdio: ['ignore', 'ignore', 'inherit'] });
  const fx = JSON.parse(readFileSync(fixture, 'utf8'));

  const create = (path, ctor) => sh('forge', ['create', path, '--rpc-url', RPC, '--private-key', DEPLOYER.key, '--broadcast', ...(ctor ? ['--constructor-args', ...ctor] : [])]).match(/Deployed to: (0x[0-9a-fA-F]{40})/)[1];
  const verifier = create('test/TacitBlocks.t.sol:AcceptAll');
  const seats = create('src/TacitSeats.sol:TacitSeats', [TAC, '1000000000000000000000', '50', LEADER.addr]);
  const blocks = create('src/TacitBlocks.sol:TacitBlocks', [verifier, '0x0000000000000000000000000000000000000000000000000000000000000001', spendVk, seats, '600', '3600', TAC, POOL, CTAC]);
  assert.equal(blocks.toLowerCase(), lander.toLowerCase(), 'TacitBlocks is where the fixture\'s spends expect it');
  assert.equal(call(blocks, 'CHAIN()(bytes32)'), fx.chain, 'the contract derives the binding the fixture\'s spends carry');
  const fromBlock = Number(cast('block-number', '--rpc-url', RPC));

  // TAC for the depositors: the confidential pool is its minter
  cast('rpc', 'anvil_setBalance', POOL, '0x56BC75E2D63100000', '--rpc-url', RPC);
  cast('rpc', 'anvil_impersonateAccount', POOL, '--rpc-url', RPC);
  cast('send', TAC, 'mint(address,uint256)', USER.addr, '100000000000000000000000', '--from', POOL, '--unlocked', '--rpc-url', RPC);
  send(TAC, 'approve(address,uint256)', [blocks, '100000000000000000000000']);
  const deposit = (d) => send(blocks, 'deposit(uint256,bytes32,bytes32,bytes32)', [String(d.value), d.cx, d.cy, d.body]);

  const leaderEnv = { ...process.env, RPC_URL: RPC, BLOCKS: blocks, FROM_BLOCK: String(fromBlock), LEADER_KEY: LEADER.key, NODE_ADDR: NODE, PROVER: 'stub', MIN_SPENDS: '1', MAX_WAIT_SECS: '1', POLL_SECS: '1', ARCHIVE_DIR: join(dir, 'archive'), TACIT_NODE_ADMIN: 'test-admin-token' };
  const leader = spawn('node', [join(ROOT, 'tacit-leader/leader.mjs')], { env: leaderEnv, stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(leader);
  const leaderLog = [];
  leader.stdout.on('data', (d) => { for (const l of String(d).split('\n').filter(Boolean)) { leaderLog.push(l); if (process.env.VERBOSE) console.log(l); } });
  for (let i = 0; i < 120; i++) { try { await fetch(`http://${NODE}/state`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }

  const api = async (method, path, body) => { const r = await fetch(`http://${NODE}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, status: r.status, ...(await r.json()) }; };
  const height = () => Number(call(blocks, 'height()(uint256)').split(' ')[0]);
  const waitHeight = async (h) => { for (let i = 0; i < 180; i++) { if (height() >= h) return; await new Promise((r) => setTimeout(r, 1000)); } throw new Error(`the chain did not reach height ${h}; the leader said:\n${leaderLog.slice(-8).join('\n')}`); };

  // a leader that was not told by the admin token could not move the node: the public endpoints refuse it
  const refused = await fetch(`http://${NODE}/landed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok(refused.status === 200 || refused.status === 400 || refused.status === 403, 'answered');

  const file = (b) => readFileSync(`${fixture}.b${b}.stdin`);
  const readStdin = (f) => { const n = f.readUInt32LE(0); let at = 4; const out = []; for (let i = 0; i < n; i++) { const len = f.readUInt32LE(at); out.push(f.subarray(at + 4, at + 4 + len)); at += 4 + len; } return out; };
  const { createHash } = await import('node:crypto');
  const memoHash = (x) => createHash('sha256').update(Buffer.concat([Buffer.from('tacit-block-memo-v1'), x])).digest();

  for (let b = 0; b < fx.blocks.length; b++) {
    const blk = fx.blocks[b];
    const bufs = readStdin(file(b));
    const n = bufs[1].readUInt32LE(0);
    let at = 2;
    const spends = [];
    for (let k = 0; k < n; k++) { spends.push({ publics: bufs[at], proof: bufs[at + 1], data: bufs[at + 3] }); at += 4; }
    const nSettles = bufs[at++].readUInt32LE(0);
    const settles = [];
    for (let k = 0; k < nSettles; k++) settles.push(bufs[at++]);
    const time = Number(bufs[at++].readBigUInt64LE(0));
    at++; // blobs
    const m = bufs[at++].readUInt32LE(0);
    const queue = [];
    for (let k = 0; k < m; k++) { queue.push(bufs[at]); at += 2; }

    if (b === 0) deposit(fx.deposit);
    if (b === 5) fx.lockDeposits.forEach(deposit);
    // the chain's clock: a refund is taken only from its lock's deadline
    const now = Number(cast('block', 'latest', '--field', 'timestamp', '--rpc-url', RPC));
    if (time > now) { cast('rpc', 'evm_setNextBlockTimestamp', String(time + 60), '--rpc-url', RPC); cast('rpc', 'evm_mine', '--rpc-url', RPC); }
    for (const q of queue) send(blocks, 'force(bytes)', [hx(q)]);

    const memoPool = Buffer.from(blk.memos.replace(/^0x/, ''), 'hex');
    const pool = Array.from({ length: memoPool.length / MEMO_LEN }, (_, k) => memoPool.subarray(MEMO_LEN * k, MEMO_LEN * (k + 1)));
    const byHash = (h) => { const f = pool.find((x) => memoHash(x).equals(h)); assert.ok(f, `block ${b}: a memo for ${h.toString('hex').slice(0, 8)}`); return f; };
    for (const s of spends) {
      const outs = [5, 6, 7].map((w) => s.publics.subarray(32 * w, 32 * w + 32)).map((x) => x.some((v) => v !== 0));
      const memos = [0, 1, 2].filter((k) => outs[k]).map((k) => hx(byHash(s.data.subarray(32 * k, 32 * k + 32))));
      let o = 148; o += s.data[o] === 1 ? 41 : 1; o += s.data[o] === 1 ? 41 : 1;
      const opMemos = s.data[o] === 1 && s.data[o + 1] === 2 ? [hx(byHash(s.data.subarray(s.data.length - 32)))] : [];
      const r = await api('POST', '/spend', { publics: hx(s.publics), proof: hx(s.proof), data: hx(s.data), memos, opMemos });
      assert.ok(r.ok, `block ${b}: the leader refused a spend: ${r.error}`);
    }
    for (const s of settles) {
      const t = 1 + 32 + 8;
      const memoAt = s[0] === 1 ? t + 40 + 64 : t + 136 + 64;
      const r = await api('POST', '/settle', { settle: hx(s), memo: hx(byHash(s.subarray(memoAt, memoAt + 32))) });
      assert.ok(r.ok, `block ${b}: the leader refused a settle: ${r.error}`);
    }
    await waitHeight(b + 1);
    const want = '0x' + blk.publicValues.slice(2 + 64, 2 + 128);
    assert.equal(call(blocks, 'state()(bytes32)'), want, `block ${b}: the contract's state is the fixture's`);
    console.log(`block ${b}: ${n} spends, ${nSettles} settles, ${m} queued — landed by the leader (state ${want.slice(0, 10)}…)`);
  }

  // the leader's node agrees with the contract, hops were sent on into the confidential pool, nothing is left in the mempool
  const st = await api('GET', '/state');
  assert.equal(st.state, call(blocks, 'state()(bytes32)'));
  assert.equal(st.height, fx.blocks.length);
  assert.equal(st.pending + st.settles, 0, 'the mempool is empty');
  const sent = leaderLog.filter((l) => l.includes('hopsSent')).length;
  assert.ok(sent >= 1, 'the leader sent hops into the confidential pool');
  console.log(JSON.stringify({ ok: true, height: st.height, hopTransactions: sent, state: st.state }));
}

main().then(() => { stop(); process.exit(0); }).catch((e) => { console.error(e); stop(); process.exit(1); });
