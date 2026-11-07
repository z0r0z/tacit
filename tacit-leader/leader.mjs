// The tacit chain's leader: follows TacitBlocks on Ethereum, keeps tacit-block-node (the chain's state and the mempool wallets submit to) in
// step with it, and when it is this leader's turn builds a block from what is waiting and the forced queue, proves it, and lands it.
//
//   RPC_URL         an Ethereum JSON-RPC endpoint
//   BLOCKS          the TacitBlocks contract
//   FROM_BLOCK      the block it was deployed in (where history is read from)
//   LEADER_KEY      the key that lands blocks (a seat holder's, or any key once the window has passed); needs a little ETH
//   NODE_BIN        tacit-block-node (default: ../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node)
//   NODE_ADDR       where it serves wallets (default 127.0.0.1:8787); TACIT_NODE_ADMIN is the token its leader endpoints need
//   PROVER          'stub' (a verifier that takes any proof, for tests) or a command that proves a guest input file, e.g.
//                   `tacit-block-gpu elf/tacit-block {stdin} --groth16`, leaving {stdin}.groth16 (0x proof, 0x public values)
//   MIN_SPENDS      build when this many spends are waiting (default 1)       MAX_WAIT_SECS   or when the oldest has waited this long (default 20)
//   POLL_SECS       how often it looks (default 6)                            ARCHIVE_DIR     every block built is kept here (blobs need it)
//
// A block's data goes in calldata here; blob mode is built into the program, the contract and the node (`POST /build {blobs: true}`) and is
// switched on once the sender of blob transactions is.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { decode, decodeLand, landCalldata, selector, encode, hexOf, bytesOf } from './abi.mjs';
import { makeRpc, send as sendTx, addressOf, num } from './rpc.mjs';

// one transaction at a time from the leader's key, so the seed's, a sweep's, a landing's and the hops' never take the same nonce
let txLock = Promise.resolve();
const send = (...a) => { const r = txLock.then(() => sendTx(...a)); txLock = r.catch(() => {}); return r; };

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const need = (k) => { if (!env[k]) throw new Error(`${k} is required`); return env[k]; };
const RPC_URL = need('RPC_URL');
const BLOCKS = need('BLOCKS').toLowerCase();
const FROM_BLOCK = Number(env.FROM_BLOCK || 0);
const KEY = need('LEADER_KEY');
const NODE_ADDR = env.NODE_ADDR || '127.0.0.1:8787';
const NODE_BIN = env.NODE_BIN || join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const PROVER = env.PROVER || 'stub';
const MIN_SPENDS = Number(env.MIN_SPENDS || 1);
const MAX_WAIT = Number(env.MAX_WAIT_SECS || 20) * 1000;
const POLL = Number(env.POLL_SECS || 6) * 1000;
const ARCHIVE = env.ARCHIVE_DIR || join(HERE, 'archive');
const ADMIN = env.TACIT_NODE_ADMIN || '';
const MEMO_LEN = 1152;
const MAX_FORCED = 16;

const rpc = makeRpc(RPC_URL);
const me = addressOf(KEY);
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
const topic = (sig) => hexOf(keccak_256(new TextEncoder().encode(sig)));
const T_LANDED = topic('Landed(uint256,bytes32,bytes32,address)');
const T_FORCED = topic('Forced(uint256,address,bytes)');

async function view(sig, types, args = [], to = BLOCKS) {
  const data = hexOf(new Uint8Array([...selector(sig), ...encode(args.map(() => 'uint256'), args)]));
  const r = await rpc.call('eth_call', [{ to, data }, 'latest']);
  return decode(types, bytesOf(r));
}

// TacitBlocks.sweep for a deposit record (asset ‖ shares ‖ cx ‖ cy ‖ body ‖ amount) whose inbox holds its TAC, or, with a holder's
// permit for the inbox, TacitBlocks.sweepWithPermit, which pulls it (the leader pays the gas and takes the permit's fee); false if
// neither can be done yet.
const swept = new Set();
async function sweepInbox(record, back, permit = null) {
  const r = bytesOf(record);
  const w = (i) => hexOf(r.subarray(32 * i, 32 * i + 32));
  const shareCount = BigInt(w(1)), amount = BigInt(w(5));
  const args = [shareCount, amount, w(2), w(3), w(4), back];
  const types = ['uint256', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'bytes32'];
  const [box] = decode(['address'], bytesOf(await rpc.call('eth_call', [{ to: BLOCKS, data: hexOf(new Uint8Array([...selector('inbox(uint256,uint256,bytes32,bytes32,bytes32,bytes32)'), ...encode(types, args)])) }, 'latest'])));
  if (swept.has(box)) return false;
  const [tac] = await view('TAC()', ['address']);
  const [held] = decode(['uint256'], bytesOf(await rpc.call('eth_call', [{ to: tac, data: hexOf(new Uint8Array([...selector('balanceOf(address)'), ...encode(['address'], [box])])) }, 'latest'])));
  let data;
  if (BigInt(held) >= amount * 10n ** 10n) {
    data = new Uint8Array([...selector('sweep(uint256,uint256,bytes32,bytes32,bytes32,bytes32)'), ...encode(types, args)]);
  } else if (permit && permit.back === back) {
    const pTypes = [...types, 'address', 'uint256', 'uint256', 'uint256', 'bytes32', 'bytes32'];
    data = new Uint8Array([...selector('sweepWithPermit(uint256,uint256,bytes32,bytes32,bytes32,bytes32,address,uint256,uint256,uint8,bytes32,bytes32)'),
      ...encode(pTypes, [...args, permit.owner, BigInt(permit.fee), BigInt(permit.deadline), BigInt(permit.v), permit.r, permit.s])]);
    // the permit's pull must succeed now: a simulation that reverts (a moved balance, a used permit with no allowance left) sends nothing
    try { await rpc.call('eth_call', [{ from: me, to: BLOCKS, data: hexOf(data) }, 'latest']); } catch { return false; }
  } else return false;
  swept.add(box);
  try {
    const receipt = await send(rpc, KEY, BLOCKS, data, { chainId: num(await rpc.call('eth_chainId')) });
    log({ swept: box, shares: String(shareCount), amount: String(amount), permit: !!permit, tx: receipt.transactionHash });
    return true;
  } catch (e) {
    swept.delete(box);
    log({ sweepFailed: box, error: String(e.message || e) });
    return false;
  }
}

async function node(method, path, body) {
  const r = await fetch(`http://${NODE_ADDR}${path}`, { method, headers: { 'content-type': 'application/json', ...(ADMIN ? { authorization: `Bearer ${ADMIN}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
  return j;
}

const words = (pv) => Array.from({ length: pv.length / 32 }, (_, i) => hexOf(pv.subarray(32 * i, 32 * i + 32)));
const chunks = (b, n) => Array.from({ length: b.length / n }, (_, i) => hexOf(b.subarray(n * i, n * i + n)));

/// What /landed takes for a block, from the lists it published.
function landedBody(pv, l) {
  return { words: words(pv), leaves: chunks(bytesOf(l.leaves), 32), memos: chunks(bytesOf(l.memos), MEMO_LEN), nullifiers: l.nullifiers };
}

let syncedTo = FROM_BLOCK - 1;
let nodeHeight = 0;
const forced = new Map();

async function logs(address, topics, from, to) {
  const out = [];
  for (let a = from; a <= to; a += 4000) out.push(...(await rpc.call('eth_getLogs', [{ address, topics, fromBlock: '0x' + a.toString(16), toBlock: '0x' + Math.min(a + 3999, to).toString(16) }])));
  return out;
}

/// Reads the blocks that landed since the last look and replays them into the node, and the forced queue's entries.
async function sync() {
  const head = num(await rpc.call('eth_blockNumber'));
  if (head <= syncedTo) return;
  for (const lg of await logs(BLOCKS, [T_FORCED], syncedTo + 1, head)) forced.set(num(lg.topics[1]), decode(['bytes'], bytesOf(lg.data))[0]);
  for (const lg of await logs(BLOCKS, [T_LANDED], syncedTo + 1, head)) {
    const height = num(lg.topics[1]);
    if (height <= nodeHeight) continue;
    const tx = await rpc.call('eth_getTransactionByHash', [lg.transactionHash]);
    const call = decodeLand(tx.input);
    if (!call) throw new Error(`block ${height} was landed by a call this leader cannot read (${lg.transactionHash})`);
    let lists = call.lists;
    if (lists.blobs.length) {
      const f = join(ARCHIVE, `${height}.json`);
      if (!existsSync(f)) throw new Error(`block ${height} carries its data in blobs and this leader has no archive of it (${f})`);
      const a = JSON.parse(readFileSync(f, 'utf8'));
      lists = { ...lists, leaves: bytesOf(a.lists.leaves), memos: bytesOf(a.lists.memos), nullifiers: a.lists.nullifiers };
    }
    await node('POST', '/landed', landedBody(call.publicValues, lists));
    nodeHeight = height;
    log({ synced: height, by: lg.topics[2] && '0x' + lg.topics[2].slice(26) });
  }
  syncedTo = head;
}

async function prove(built) {
  if (PROVER === 'stub') return '0x';
  mkdirSync(ARCHIVE, { recursive: true });
  const file = join(ARCHIVE, `pending-${Date.now()}.stdin`);
  writeFileSync(file, bytesOf(built.stdin));
  await new Promise((res, rej) => {
    const p = spawn('sh', ['-c', PROVER.replaceAll('{stdin}', file)], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`the prover exited ${c}`))));
  });
  const [proof, pv] = readFileSync(`${file}.groth16`, 'utf8').trim().split('\n');
  if (pv.trim() !== built.publicValues) throw new Error('the prover committed other public values than the block');
  return proof.trim();
}

let firstSeen = null;

// An epoch's turns are drawn from the beacon randomness of the first block of its first SEED_BLOCKS in which anyone keeps it
// (TacitSeats.turn): kept by no one in time, the epoch has no leader. A leader keeps it as the epoch begins.
let seedKeptFor = -1, seedSending = false;
async function keepSeed() {
  if (seedSending) return;
  const [turns] = await view('TURNS()', ['address']);
  const [[slot], [epochSlots], [seedBlocks], [lead], [seats]] = await Promise.all([
    view('SLOT_BLOCKS()', ['uint256'], [], turns), view('EPOCH_SLOTS()', ['uint256'], [], turns), view('SEED_BLOCKS()', ['uint256'], [], turns),
    view('leader()', ['address'], [], turns), view('seats()', ['uint256'], [], turns),
  ]);
  const b = BigInt(num(await rpc.call('eth_blockNumber')));
  const len = BigInt(slot) * BigInt(epochSlots), e = b / len;
  // `b` is the latest block: a transaction sent now lands in b + 1 or later, which must be one of the epoch's blocks 1 to SEED_BLOCKS
  if (BigInt(seats) === 0n || BigInt(lead) !== 0n || b - e * len >= BigInt(seedBlocks) || Number(e) === seedKeptFor) return;
  seedSending = true;
  try {
    const receipt = await send(rpc, KEY, turns, selector('turn()'), { chainId: num(await rpc.call('eth_chainId')), tip: 3_000_000_000n });
    seedKeptFor = Number(e);
    log({ seedKept: Number(e), tx: receipt.transactionHash });
  } finally {
    seedSending = false;
  }
}

const unfundedSince = new Map();
const DROP_UNFUNDED = Number(env.DROP_UNFUNDED_SECS || 3600) * 1000;

async function step() {
  await sync();
  const [done, queued, lastLanded, window_, forceDelay] = await Promise.all([
    view('queueDone()', ['uint256']), view('queued()', ['uint256']), view('lastLanded()', ['uint256']), view('WINDOW()', ['uint256']), view('FORCE_DELAY()', ['uint256']),
  ]).then((r) => r.map((x) => Number(x[0])));
  const pool = await node('GET', '/mempool');
  // a spend that takes a deposit in lands only if that deposit is waiting on Ethereum (and not queued behind a forced entry the block does not reach)
  const exclude = [];
  const pendingOf = (d) => view('pending(bytes32)', ['address', 'uint256', 'uint256'], [hexOf(keccak_256(bytesOf(d.deposit)))]);
  const looked = await Promise.all(pool.deposits.map(async (d) => [d, await pendingOf(d)]));
  for (const [d, [from0]] of looked) {
    let from = from0;
    // a shield paid to its inbox (the confidential pool's unwrap pays one): sweep it in once it holds the deposit, trying each way
    // back it was sent with
    const backs = [...new Set([...(d.backs || []), ...(d.permit?.back ? [d.permit.back] : [])])];
    for (const back of BigInt(from) === 0n ? backs : []) {
      if (await sweepInbox(d.deposit, back, d.permit)) { [from] = await pendingOf(d); break; }
    }
    if (BigInt(from) === 0n) {
      exclude.push(d.id);
      unfundedSince.set(d.id, unfundedSince.get(d.id) ?? Date.now());
    } else unfundedSince.delete(d.id);
  }
  // a shield whose deposit has not come within DROP_UNFUNDED_SECS is dropped, so unfunded ones cannot fill the mempool
  const stale = [...unfundedSince].filter(([, t]) => Date.now() - t > DROP_UNFUNDED).map(([id]) => id);
  if (stale.length) {
    await node('POST', '/drop', { ids: stale });
    for (const id of stale) unfundedSince.delete(id);
    log({ dropped: stale.length });
  }
  const waiting = pool.spends.length - exclude.length + pool.settles.length;
  const entries = [];
  for (let i = done; i < Math.min(queued, done + MAX_FORCED); i++) {
    if (!forced.has(i)) throw new Error(`queue entry ${i} is not among the events read`);
    entries.push(forced.get(i));
  }
  if (!waiting && !entries.length) { firstSeen = null; return; }
  firstSeen ??= Date.now();
  const ready = waiting >= MIN_SPENDS || entries.length > 0 || Date.now() - firstSeen >= MAX_WAIT;
  if (!ready) return;
  // whose turn it is: the leader, or anyone once the window has passed with no block
  const blk = await rpc.call('eth_getBlockByNumber', ['latest', false]);
  const now = num(blk.timestamp);
  if (now < lastLanded + window_) {
    const [lead] = await view('turn()', ['address'], [], (await view('TURNS()', ['address']))[0]);
    if (BigInt(lead) !== 0n && lead.toLowerCase() !== me.toLowerCase()) { log({ waiting: 'not this leader\'s turn', lead }); return; }
  }
  const built = await node('POST', '/build', { time: now, queue: entries.map((e) => hexOf(e)), max: 64, exclude });
  log({ built: nodeHeight + 1, spends: built.includes.length, queueTaken: built.queueTaken });
  const proof = await prove(built);
  const pv = bytesOf(built.publicValues);
  const l = built.lists;
  const lists = { leaves: bytesOf(l.leaves), memos: bytesOf(l.memos), nullifiers: l.nullifiers, anchors: l.anchors, deposits: bytesOf(l.deposits), exits: bytesOf(l.exits), hops: bytesOf(l.hops), claims: bytesOf(l.claims), blobs: bytesOf(l.blobs), migrations: bytesOf(l.migrations), migrationTotals: bytesOf(l.migrationTotals) };
  mkdirSync(ARCHIVE, { recursive: true });
  writeFileSync(join(ARCHIVE, `${nodeHeight + 1}.json`), JSON.stringify({ publicValues: built.publicValues, lists: l, includes: built.includes }));
  const chainId = num(await rpc.call('eth_chainId'));
  let receipt;
  try {
    receipt = await send(rpc, KEY, BLOCKS, landCalldata(pv, bytesOf(proof), lists), { chainId });
  } catch (e) {
    log({ landFailed: String(e.message || e) });
    firstSeen = null;
    return;
  }
  await node('POST', '/landed', landedBody(pv, lists));
  nodeHeight += 1;
  firstSeen = null;
  log({ landed: nodeHeight, tx: receipt.transactionHash, gas: num(receipt.gasUsed) });
  // hops landed are sent on into the confidential pool, together
  const hopBytes = bytesOf(l.hops);
  if (hopBytes.length) {
    const values = [];
    const commits = [];
    for (let i = 0; i < hopBytes.length; i += 96) {
      values.push(BigInt(hexOf(hopBytes.subarray(i + 32, i + 64))));
      commits.push(hexOf(hopBytes.subarray(i + 64, i + 96)));
    }
    try {
      const r = await send(rpc, KEY, BLOCKS, new Uint8Array([...selector('sendHops(uint256[],bytes32[])'), ...encode(['uint256[]', 'bytes32[]'], [values, commits])]), { chainId });
      log({ hopsSent: values.length, tx: r.transactionHash });
    } catch (e) { log({ hopsFailed: String(e.message || e) }); }
  }
}

async function main() {
  const [chainHeight] = await view('height()', ['uint256']);
  log({ leader: me, blocks: BLOCKS, chainHeight: Number(chainHeight) });
  const [lander] = [BLOCKS];
  const [tacAsset] = await view('TAC_ASSET()', ['bytes32']);
  const child = spawn(NODE_BIN, ['serve', String(num(await rpc.call('eth_chainId'))), `${lander}@${NODE_ADDR}`], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, TACIT_NODE_ASSET: tacAsset } });
  child.on('exit', (c) => { log({ nodeExited: c }); process.exit(1); });
  const stopNode = () => child.kill();
  process.on('exit', stopNode);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopNode(); process.exit(0); });
  for (let i = 0; i < 120; i++) { try { await fetch(`http://${NODE_ADDR}/state`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  // the epoch's seed has a window of a few blocks: watched on its own, not between a block's proving and landing
  setInterval(() => keepSeed().catch((e) => log({ seedNotKept: String(e.message || e) })), 4000);
  for (;;) {
    try { await step(); } catch (e) { log({ error: String(e.message || e) }); }
    await new Promise((r) => setTimeout(r, POLL));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
