// The tacit chain's leader: follows TacitBlocks on Ethereum, keeps tacit-block-node (the chain's state and the mempool wallets submit to) in
// step with it, and when it is this leader's turn builds a block from what is waiting and the forced queue, proves it, and lands it.
//
//   RPC_URL         an Ethereum JSON-RPC endpoint
//   BLOCKS          the TacitBlocks contract
//   FROM_BLOCK      the block it was deployed in (where history is read from)
//   LEADER_KEY      the key that lands blocks (a seat holder's, or any key once the window has passed); needs a little ETH
//   NODE_BIN        tacit-block-node (default: ../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node)
//   NODE_ADDR       where it serves wallets (default 127.0.0.1:8787); TACIT_NODE_ADMIN is the token its leader endpoints need
//   PROVER          'board' (Tacit's prover board: BOARD_URL, default https://api.tacit.finance, BOARD_TOKEN, BOARD_WAIT_SECS, then
//                   PROVER_FALLBACK, a command, if no proof that lands comes in time), 'stub' (a verifier that takes any proof, for
//                   tests) or a command that proves a guest input file, e.g.
//                   `tacit-block-gpu elf/tacit-block {stdin} --groth16`, leaving {stdin}.groth16 (0x proof, 0x public values)
//   MIN_SPENDS      build when this many spends are waiting (default 1)       MAX_WAIT_SECS   or when the oldest has waited this long (default 20)
//   POLL_SECS       how often it looks (default 6)                            ARCHIVE_DIR     every block built is kept here (blobs need it)
//   BATCH_GWEI      over this base fee a block waits for company (default 0.5) BATCH_TARGET    that many spends (default 4)
//   BATCH_WAIT_SECS but no longer than this (default 90): a payer is told "Sent" once the leader holds its spend, so the wait is its settling's
//   LEADER_CHAIN_SEED  the leader's chain keys (32 bytes, hex): every spend then pays it a fee as a note to its chain address, quoted on
//                   GET /fee and checked before a block takes the spend (fees.mjs has the terms, FEE_*); with none, no fee is asked
//
// A block's data goes in calldata here; blob mode is built into the program, the contract and the node (`POST /build {blobs: true}`) and is
// switched on once the sender of blob transactions is.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { decode, decodeLand, landCalldata, selector, encode, hexOf, bytesOf } from './abi.mjs';
import { makeRpc, send as sendTx, addressOf, num, suggestedTip } from './rpc.mjs';
import { feeTerms, readPrice, makeFeeDesk, admitPaying, blockReady } from './fees.mjs';
import { archiveEntry, loadArchive } from './archive.mjs';
import { makeBoardProver } from '../worker-relay/src/lib/board-prover.js';

// one transaction at a time from the leader's key, so the seed's, a sweep's, a landing's and the hops' never take the same nonce
let txLock = Promise.resolve();
const send = (...a) => { const r = txLock.then(() => sendTx(...a)); txLock = r.catch(() => {}); return r; };

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const need = (k) => { if (!env[k]) throw new Error(`${k} is required`); return env[k]; };
// RPC_URL: one endpoint or several, comma apart (the first that answers is used; one that refuses, rate-limits or drops old logs is passed over)
const RPC_URL = need('RPC_URL');
const BLOCKS = need('BLOCKS').toLowerCase();
const FROM_BLOCK = Number(env.FROM_BLOCK || 0);
const KEY = need('LEADER_KEY');
const NODE_ADDR = env.NODE_ADDR || '127.0.0.1:8787';
const NODE_BIN = env.NODE_BIN || join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const PROVER = env.PROVER || 'stub';
const MIN_SPENDS = Number(env.MIN_SPENDS || 1);
const MAX_WAIT = Number(env.MAX_WAIT_SECS || 20) * 1000;
const BATCH_GWEI = Number(env.BATCH_GWEI ?? 0.5), BATCH_TARGET = Number(env.BATCH_TARGET || 4), BATCH_WAIT = Number(env.BATCH_WAIT_SECS ?? 90) * 1000;
// At most this many of its own spends a block (MAX_SPENDS): with up to 16 entries of the queue beside them, a block's calldata stays under
// the 128 KB a node takes in one transaction (a spend's lists are about 2.4 KB). Blobs lift this.
const MAX_SPENDS = Number(env.MAX_SPENDS || 32);
// Launch cap: the most TAC (units of 1e-8) one shield may bring in through this leader (SHIELD_CAP, default 1,000 TAC; 0 for none). A
// larger one is dropped before its inbox is swept, its receipt saying so; its owner may still post it to Ethereum (force) or take it
// back. The contract has no cap: this is the leader's own, published with its fee (GET /fee `shieldCap`) so wallets refuse it first.
const SHIELD_CAP = BigInt(env.SHIELD_CAP ?? 100_000_000_000);
const POLL = Number(env.POLL_SECS || 6) * 1000;
const ARCHIVE = env.ARCHIVE_DIR || join(HERE, 'archive');
const ADMIN = env.TACIT_NODE_ADMIN || '';
const MEMO_LEN = 1152;
const MAX_FORCED = 16;
const CHAIN_SEED = env.LEADER_CHAIN_SEED || '';
const FEE_REFRESH = Number(env.FEE_REFRESH_SECS || 60) * 1000;

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
const swept = new Set(), permitRefused = new Set();
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
    // the permit's fee pays this leader's gas for the sweep: one under its quote is not sent (the holder asks for the fee again)
    const least = desk?.sweepAccepted(Math.floor(Date.now() / 1000));
    if (least != null && BigInt(permit.fee) < least) { log({ permitFeeShort: box, fee: String(permit.fee), need: String(least) }); return false; }
    const pTypes = [...types, 'address', 'uint256', 'uint256', 'uint256', 'bytes32', 'bytes32'];
    data = new Uint8Array([...selector('sweepWithPermit(uint256,uint256,bytes32,bytes32,bytes32,bytes32,address,uint256,uint256,uint8,bytes32,bytes32)'),
      ...encode(pTypes, [...args, permit.owner, BigInt(permit.fee), BigInt(permit.deadline), BigInt(permit.v), permit.r, permit.s])]);
    // the permit's pull must succeed now: a simulation that reverts (a moved balance, a used permit with no allowance left) sends nothing
    // (the first refusal of each inbox is logged, with why: the same one is tried again each round, quietly)
    try { await rpc.call('eth_call', [{ from: me, to: BLOCKS, data: hexOf(data) }, 'latest']); }
    catch (e) { if (!permitRefused.has(box)) { permitRefused.add(box); log({ permitRefused: box, owner: permit.owner, error: String(e?.message || e).slice(0, 240) }); } return false; }
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
  let head = num(await rpc.call('eth_blockNumber'));
  if (head <= syncedTo) return;
  // up to the head; a public RPC answers from several nodes, and one a block behind refuses logs up to another's head, so the read steps back a
  // block at a time (three at most) and what was read is what counts as synced
  let forcedLogs, landedLogs;
  for (let back = 0; ; back++) {
    try {
      forcedLogs = await logs(BLOCKS, [T_FORCED], syncedTo + 1, head);
      landedLogs = await logs(BLOCKS, [T_LANDED], syncedTo + 1, head);
      break;
    } catch (e) {
      if (!/beyond current head|block range/i.test(String(e?.message || e))) throw e;
      // the node answering is behind: nothing older to step back to (or stepped back enough) is read on the next pass, with no error
      if (back >= 3 || head - 1 <= syncedTo) return;
      head -= 1;
    }
  }
  for (const lg of forcedLogs) forced.set(num(lg.topics[1]), decode(['bytes'], bytesOf(lg.data))[0]);
  for (const lg of landedLogs) {
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
    // kept on disk, so a restart can rebuild from the disk (the leader's own blocks are kept when it builds them)
    try {
      const f = join(ARCHIVE, `${height}.json`);
      if (!existsSync(f)) { mkdirSync(ARCHIVE, { recursive: true }); writeFileSync(`${f}.tmp`, JSON.stringify(archiveEntry(call.publicValues, lists, num(lg.blockNumber)))); renameSync(`${f}.tmp`, f); }
    } catch (e) { log({ archiveNotKept: height, error: String(e.message || e) }); }
  }
  syncedTo = head;
}

// PROVER=board: the block goes to Tacit's prover board (BOARD_URL's /prover/jobs, with BOARD_TOKEN) as public work any community machine
// that proves the 'tacit-block' program may race for; the first proof a simulated landing of this very block accepts is used. A proof
// that would not land is refused (and counts against its maker), so the board can add provers but never a wrong block. If none comes
// within BOARD_WAIT_SECS, PROVER_FALLBACK (a command, as PROVER would be) proves it.
const BOARD_URL = (env.BOARD_URL || 'https://api.tacit.finance').replace(/\/$/, '');
const BOARD_WAIT = Number(env.BOARD_WAIT_SECS || 900) * 1000;
let board = null;
const listsOf = (l) => ({ leaves: bytesOf(l.leaves), memos: bytesOf(l.memos), nullifiers: l.nullifiers, anchors: l.anchors, deposits: bytesOf(l.deposits), exits: bytesOf(l.exits), hops: bytesOf(l.hops), claims: bytesOf(l.claims), blobs: bytesOf(l.blobs), migrations: bytesOf(l.migrations), migrationTotals: bytesOf(l.migrationTotals) });
/// bincode(SP1Stdin { buffer, ptr: 0, proofs: [] }) for the node's guest input (its buffers, each as the guest's read_vec reads it).
function sp1Stdin(file) {
  const f = bytesOf(file), dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  const n = dv.getUint32(0, true), bufs = [];
  for (let i = 0, at = 4; i < n; i++) { const len = dv.getUint32(at, true); bufs.push(f.subarray(at + 4, at + 4 + len)); at += 4 + len; }
  const out = new Uint8Array(24 + bufs.reduce((t, b) => t + 8 + b.length, 0)), ov = new DataView(out.buffer);
  let off = 0;
  const u64 = (v) => { ov.setBigUint64(off, BigInt(v), true); off += 8; };
  u64(bufs.length);
  for (const b of bufs) { u64(b.length); out.set(b, off); off += b.length; }
  u64(0);
  u64(0);
  return out;
}
async function boardApi(method, path, body) {
  const r = await fetch(BOARD_URL + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${env.BOARD_TOKEN || ''}` }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
}
async function proveOnBoard(built) {
  board ||= makeBoardProver({
    post: (b) => boardApi('POST', '/prover/jobs', b),
    status: (id) => boardApi('GET', `/prover/jobs?id=${encodeURIComponent(id)}`),
    cancel: (id, reason) => boardApi('POST', '/prover/jobs/cancel', { jobId: id, reason }),
    race: (jobId, worker, ok) => boardApi('POST', '/prover/jobs/race', { jobId, worker, ok }),
    verify: async () => false,
    waitMs: BOARD_WAIT, log: (m) => log({ board: m }),
  });
  const lists = listsOf(built.lists);
  // a proof is this block's only if the contract would land it now: the same public values, and a simulated land from this leader
  const check = async ({ publicValues, proof }) => {
    if (String(publicValues).toLowerCase() !== String(built.publicValues).toLowerCase()) return false;
    try { await rpc.call('eth_call', [{ from: me, to: BLOCKS, data: hexOf(landCalldata(bytesOf(publicValues), bytesOf(proof), lists)) }, 'latest']); return true; } catch (e) { return /NotYourTurn|BadTime|BadQueue|NotOnTop/i.test(String(e.message)) ? 'stale' : false; }
  };
  const r = await board.prove({ stdin: sp1Stdin(built.stdin), cls: 'public', program: 'tacit-block', cycleLimit: 2_000_000_000, gasLimit: 1e12, label: 'tacit-block', check });
  return r.proof;
}

async function prove(built) {
  if (PROVER === 'stub') return '0x';
  if (PROVER === 'board') {
    try { return await proveOnBoard(built); } catch (e) {
      if (!env.PROVER_FALLBACK) throw e;
      log({ boardMissed: String(e.message || e).slice(0, 200), fallback: true });
    }
  }
  const command = PROVER === 'board' ? env.PROVER_FALLBACK : PROVER;
  mkdirSync(ARCHIVE, { recursive: true });
  const file = join(ARCHIVE, `pending-${Date.now()}.stdin`);
  writeFileSync(file, bytesOf(built.stdin));
  await new Promise((res, rej) => {
    const p = spawn('sh', ['-c', command.replaceAll('{stdin}', file)], { stdio: ['ignore', 'inherit', 'inherit'] });
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
    const receipt = await send(rpc, KEY, turns, selector('turn()'), { chainId: num(await rpc.call('eth_chainId')), tip: 1_000_000_000n });
    seedKeptFor = Number(e);
    log({ seedKept: Number(e), tx: receipt.transactionHash });
  } finally {
    seedSending = false;
  }
}

// The fee: quoted on the node (GET /fee) from Ethereum's base fee and TAC's price in the confidential pool, refreshed every FEE_REFRESH_SECS
let desk = null;
async function quoteFee() {
  const blk = await rpc.call('eth_getBlockByNumber', ['latest', false]);
  const price = await readPrice(async (to, data) => rpc.call('eth_call', [{ to, data }, 'latest']), desk.terms).catch(() => null);
  const q = { ...desk.quote({ now: Math.floor(Date.now() / 1000), baseFee: BigInt(blk.baseFeePerGas || 0), price, tip: await suggestedTip(rpc) }), shieldCap: String(SHIELD_CAP) };
  await node('POST', '/fee', q);
  return q;
}

// Spends seen to pay the fee (by id): each is opened once; one that does not pay is refused, its receipt saying so
const paying = new Set();

const unfundedSince = new Map();
const DROP_UNFUNDED = Number(env.DROP_UNFUNDED_SECS || 3600) * 1000;

// A restart rebuilds the node from the blocks on this disk when they are the whole chain: every block from 1 to the contract's height is there, each
// starts where the one before ended, the first from the empty chain's state and the last at the contract's own state, and no forced entry waits (its
// text is in the logs). Anything less and the logs are read from FROM_BLOCK as before. Blocks the disk gives are checked by the node as any are.
async function replayArchive() {
  const [[height], [queued], [done]] = await Promise.all([view('height()', ['uint256']), view('queued()', ['uint256']), view('queueDone()', ['uint256'])]);
  if (!(height > 0n) || queued !== done) return log({ archiveSkipped: height > 0n ? 'a forced entry waits' : 'the chain is empty' });
  const seq = loadArchive(Number(height), (h) => { try { return readFileSync(join(ARCHIVE, `${h}.json`), 'utf8'); } catch { return null; } });
  if (!seq.ok) return log({ archiveSkipped: seq.why });
  const [onchain] = await view('state()', ['bytes32']), start = (await node('GET', '/state')).state;
  if (seq.first !== start || seq.last !== onchain) return log({ archiveSkipped: 'its blocks do not lead from the empty chain to the contract\'s state' });
  for (const b of seq.blocks) {
    await node('POST', '/landed', landedBody(b.pv, b.lists));
    nodeHeight = b.height;
  }
  syncedTo = num(await rpc.call('eth_blockNumber'));
  log({ replayedFromArchive: seq.blocks.length, syncedTo });
}

// what waited when the node last stopped (its TACIT_NODE_MEMPOOL file) is admitted again once, after the first sync has replayed the chain
let restored = false;
async function step() {
  await sync();
  if (!restored) { restored = true; log({ restored: await node('POST', '/restore', {}).catch((e) => ({ error: String(e.message || e) })) }); }
  const [done, queued, lastLanded, window_, forceDelay] = await Promise.all([
    view('queueDone()', ['uint256']), view('queued()', ['uint256']), view('lastLanded()', ['uint256']), view('WINDOW()', ['uint256']), view('FORCE_DELAY()', ['uint256']),
  ]).then((r) => r.map((x) => Number(x[0])));
  const ids = (await node('GET', '/mempool')).spends;
  if (desk) await admitPaying({ desk, node, paying, ids, log });
  const pool = await node('POST', '/pending', {});
  // the launch cap, before any inbox is swept for a shield over it
  const over = SHIELD_CAP > 0n ? pool.spends.filter((d) => d.deposit && BigInt('0x' + String(d.deposit).replace(/^0x/, '').slice(320, 384)) > SHIELD_CAP).map((d) => d.id) : [];
  if (over.length) {
    await node('POST', '/drop', { ids: over, reason: `this leader takes shields of at most ${Number(SHIELD_CAP) / 1e8} TAC for now: post it to Ethereum yourself, or take it back` });
    pool.spends = pool.spends.filter((d) => !over.includes(d.id));
    log({ overCap: over.length });
  }
  const fees = desk ? { only: pool.spends.map((s) => s.id).filter((id) => paying.has(id)) } : {};
  // a spend that takes a deposit in lands only if that deposit is waiting on Ethereum (and not queued behind a forced entry the block does not reach)
  const exclude = [];
  const pendingOf = (d) => view('pending(bytes32)', ['address', 'uint256', 'uint256'], [hexOf(keccak_256(bytesOf(d.deposit)))]);
  const looked = await Promise.all(pool.spends.filter((d) => d.deposit).map(async (d) => [d, await pendingOf(d)]));
  for (const [d, [from0]] of looked) {
    let from = from0;
    // a shield paid to its inbox (the confidential pool's unwrap pays one): sweep it in once it holds the deposit, trying each way
    // back it was sent with
    const backs = [...new Set([...(d.backs || []), ...(d.permit?.back ? [d.permit.back] : [])])];
    for (const back of BigInt(from) === 0n ? backs : []) {
      // (a permit with bad fields, or a failing read, leaves this one unfunded, to be dropped in time: it must not stop the block for the rest)
      let ok = false;
      try { ok = await sweepInbox(d.deposit, back, d.permit); } catch (e) { log({ sweepError: d.id, error: String(e?.message || e).slice(0, 200) }); }
      if (ok) { [from] = await pendingOf(d); break; }
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
  const waiting = pool.spends.filter((s) => !exclude.includes(s.id) && (!fees.only || fees.only.includes(s.id))).length + pool.settles.length;
  const entries = [];
  for (let i = done; i < Math.min(queued, done + MAX_FORCED); i++) {
    if (!forced.has(i)) throw new Error(`queue entry ${i} is not among the events read`);
    entries.push(forced.get(i));
  }
  if (!waiting && !entries.length) { firstSeen = null; return; }
  firstSeen ??= Date.now();
  // at once while gas is cheap; when it is dear, a short wait for other spends to share the block (fees.mjs blockReady)
  const blk = await rpc.call('eth_getBlockByNumber', ['latest', false]);
  if (!blockReady({ waiting, forced: entries.length, firstSeen, now: Date.now(), baseFee: BigInt(blk.baseFeePerGas || 0), minSpends: MIN_SPENDS, maxWaitMs: MAX_WAIT, batchGwei: BATCH_GWEI, target: BATCH_TARGET, waitMs: BATCH_WAIT })) return;
  // whose turn it is: the leader, or anyone once the window has passed with no block
  const now = num(blk.timestamp);
  if (now < lastLanded + window_) {
    const [lead] = await view('turn()', ['address'], [], (await view('TURNS()', ['address']))[0]);
    if (BigInt(lead) !== 0n && lead.toLowerCase() !== me.toLowerCase()) { log({ waiting: 'not this leader\'s turn', lead }); return; }
  }
  const built = await node('POST', '/build', { time: now, queue: entries.map((e) => hexOf(e)), max: MAX_SPENDS, exclude, ...fees });
  log({ built: nodeHeight + 1, spends: built.includes.length, queueTaken: built.queueTaken });
  const proof = await prove(built);
  const pv = bytesOf(built.publicValues);
  const l = built.lists;
  const lists = listsOf(l);
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
  // exits landed are paid out to their addresses (TacitBlocks.withdraw, which anyone may send): a holder needs no ETH to withdraw, and a payment to
  // an address is not tied to any wallet of the payer's by a transaction of its own. Each item is asset ‖ amount ‖ address, 96 bytes.
  // (PAY_OUT_EXITS=0 leaves them for the holders to send)
  const exitBytes = env.PAY_OUT_EXITS === '0' ? new Uint8Array() : bytesOf(l.exits), tos = new Set();
  for (let i = 0; i + 96 <= exitBytes.length; i += 96) tos.add(hexOf(exitBytes.subarray(i + 76, i + 96)));
  for (const to of tos) {
    try {
      const [owedTo] = await view('owed(address)', ['uint256'], [to]);
      if (!(BigInt(owedTo) > 0n)) continue;                               // already paid out (anyone may)
      const r = await send(rpc, KEY, BLOCKS, new Uint8Array([...selector('withdraw(address)'), ...encode(['address'], [to])]), { chainId });
      log({ paidOut: to, tx: r.transactionHash });
    } catch (e) { log({ payOutFailed: to, error: String(e.message || e) }); }
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
  if (CHAIN_SEED) {
    const [chain] = await view('CHAIN()', ['bytes32']);
    desk = makeFeeDesk({ seed: CHAIN_SEED, chain, asset: tacAsset, terms: feeTerms(env) });
    log({ fee: await quoteFee().then((q) => q.fee) });
    setInterval(() => quoteFee().catch((e) => log({ feeNotQuoted: String(e.message || e) })), FEE_REFRESH);
  } else await node('POST', '/fee', { fee: '0', shieldCap: String(SHIELD_CAP) });
  await replayArchive().catch((e) => log({ archiveReplayFailed: String(e.message || e) }));        // (never fatal: the logs are read for what it did not give)
  // the epoch's seed has a window of a few blocks: watched on its own, not between a block's proving and landing
  setInterval(() => keepSeed().catch((e) => log({ seedNotKept: String(e.message || e) })), 4000);
  for (;;) {
    try { await step(); } catch (e) { log({ error: String(e.message || e) }); }
    // between steps the node's mempool is looked at each second (a local read): a spend that arrives starts the next step at once, so a payment
    // is built into a block within a second of the leader taking it, not up to POLL later
    const since = Date.now(), had = await node('GET', '/mempool').then((m) => (m.spends || []).length + (m.settles || []).length, () => 0);
    while (Date.now() - since < POLL) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = await node('GET', '/mempool').then((m) => (m.spends || []).length + (m.settles || []).length, () => 0);
      if (now > had) break;
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
