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
import { makeRpc, send, addressOf, num } from './rpc.mjs';

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

async function step() {
  await sync();
  const [done, queued, lastLanded, window_, forceDelay] = await Promise.all([
    view('queueDone()', ['uint256']), view('queued()', ['uint256']), view('lastLanded()', ['uint256']), view('WINDOW()', ['uint256']), view('FORCE_DELAY()', ['uint256']),
  ]).then((r) => r.map((x) => Number(x[0])));
  const pool = await node('GET', '/mempool');
  // a spend that takes a deposit in lands only if that deposit is waiting on Ethereum (and not queued behind a forced entry the block does not reach)
  const exclude = [];
  for (const d of pool.deposits) {
    const [from, , forcedAt] = await view('pending(bytes32)', ['address', 'uint256', 'uint256'], [hexOf(keccak_256(bytesOf(d.deposit)))]);
    if (BigInt(from) === 0n || Number(forcedAt) > done) exclude.push(d.id);
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
  const lists = { leaves: bytesOf(l.leaves), memos: bytesOf(l.memos), nullifiers: l.nullifiers, anchors: l.anchors, deposits: bytesOf(l.deposits), exits: bytesOf(l.exits), hops: bytesOf(l.hops), claims: bytesOf(l.claims), blobs: bytesOf(l.blobs) };
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
  for (;;) {
    try { await step(); } catch (e) { log({ error: String(e.message || e) }); }
    await new Promise((r) => setTimeout(r, POLL));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
