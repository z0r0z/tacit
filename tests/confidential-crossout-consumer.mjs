#!/usr/bin/env node
// Bitcoin-side CrossOut consumer — read (phase 1) + bind (phase 2) test. Mocks eth_getLogs + KV, uses the
// REAL CrossOutRecorded decoder, and locks: records a Bitcoin-destined crossOut past the finality gate;
// skips Ethereum-destined ones; never records inside the unfinalized window; dedups on re-scan; does NOT
// advance the cursor on an RPC failure (a skipped range would strand a burned note); and binds a recorded
// crossOut to a matching Bitcoin output exactly once (claimId consume-lock), rejecting dest-mismatch and
// unrecorded claimIds.
//
// Run: node tests/confidential-crossout-consumer.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';
import { makeCrossoutConsumer } from '../dapp/confidential-crossout-consumer.js';
import assert from 'node:assert';

const keccak256 = (b) => keccak_256(b);
const evmLog = makeConfidentialEvmLog({ keccak256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const NET = 'mainnet', POOL = '0xPoolAddr';
const b32 = (tag) => '0x' + Buffer.from(tag.padEnd(32, '\0')).toString('hex');
const u256 = (v) => BigInt(v).toString(16).padStart(64, '0');
const strip = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const mkLog = (claimId, destChain, dest, nu, asset, blockNumber) => ({
  topics: [evmLog.TOPIC0.CrossOutRecorded, claimId],
  data: '0x' + u256(destChain) + strip(dest) + strip(nu) + strip(asset),
  blockNumber,
});

const CLAIM_A = b32('claimA'), CLAIM_B = b32('claimB'), CLAIM_C = b32('claimC'), ASSET = b32('TAC');
const LOGS = [
  mkLog(CLAIM_A, 1, b32('destA'), b32('nuA'), ASSET, 100), // Bitcoin-destined, finalizes first
  mkLog(CLAIM_B, 2, b32('destB'), b32('nuB'), ASSET, 101), // Ethereum-destined → skip
  mkLog(CLAIM_C, 1, b32('destC'), b32('nuC'), ASSET, 199), // Bitcoin-destined, in the unfinalized zone first
];

function harness() {
  const kv = new Map();
  let rpcFail = false;
  const kvGet = async (k) => (kv.has(k) ? kv.get(k) : null);
  const kvPut = async (k, v) => { kv.set(k, v); };
  const ethGetLogs = async (net, pool, fromBlock, toBlock, topic0) => {
    if (rpcFail) return null;
    return LOGS.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && l.topics[0] === topic0);
  };
  const consumer = makeCrossoutConsumer({ ethGetLogs, kvGet, kvPut, evmLog, confirmations: 36 });
  return { kv, consumer, setRpcFail: (v) => { rpcFail = v; } };
}

// ── 1. records the Bitcoin-destined, finalized crossOut; skips Ethereum-destined; respects finality ──
{
  const { consumer } = harness();
  const r = await consumer.scan({ network: NET, pool: POOL, tipHeight: 150, fromBlock: 0 }); // safeTip = 114
  assert.strictEqual(r.recorded, 1, 'exactly one recorded (CLAIM_A)');
  assert.strictEqual(r.toBlock, 114, 'scanned up to tip − confirmations');
  assert.ok(await consumer.getRecorded(NET, CLAIM_A), 'CLAIM_A recorded');
  assert.strictEqual(await consumer.getRecorded(NET, CLAIM_B), null, 'CLAIM_B (Ethereum-destined) not recorded');
  assert.strictEqual(await consumer.getRecorded(NET, CLAIM_C), null, 'CLAIM_C (unfinalized) not recorded');
  const rec = await consumer.getRecorded(NET, CLAIM_A);
  assert.strictEqual(rec.destCommitment, b32('destA'), 'recorded destCommitment carried verbatim');
  ok('records the Bitcoin-destined finalized crossOut; skips Ethereum-destined; respects the finality gate');
}

// ── 2. finality gate: CLAIM_C records only once tip − confirmations reaches its block ──
{
  const { consumer } = harness();
  await consumer.scan({ network: NET, pool: POOL, tipHeight: 150, fromBlock: 0 });
  const from = await consumer.nextFromBlock(NET, POOL, 0);
  assert.strictEqual(from, 115, 'cursor advanced past the scanned range');
  const noop = await consumer.scan({ network: NET, pool: POOL, tipHeight: 150, fromBlock: from }); // safeTip 114 < 115
  assert.strictEqual(noop.recorded, 0, 'no-op while nothing new is final');
  assert.strictEqual(noop.advancedCursorTo, null, 'cursor not advanced on a no-op');
  const r2 = await consumer.scan({ network: NET, pool: POOL, tipHeight: 250, fromBlock: from }); // safeTip 214 ≥ 199
  assert.strictEqual(r2.recorded, 1, 'CLAIM_C recorded once it crosses the finality gate');
  assert.ok(await consumer.getRecorded(NET, CLAIM_C), 'CLAIM_C now recorded');
  ok('a crossOut in the unfinalized window is recorded only after it crosses the finality gate');
}

// ── 3. dedup: re-scanning the same range never double-records ──
{
  const { consumer, kv } = harness();
  await consumer.scan({ network: NET, pool: POOL, tipHeight: 300, fromBlock: 0 }); // records A + C
  const before = [...kv.keys()].filter((k) => k.startsWith('crossout-recorded:')).length;
  const r = await consumer.scan({ network: NET, pool: POOL, tipHeight: 300, fromBlock: 0 });
  const after = [...kv.keys()].filter((k) => k.startsWith('crossout-recorded:')).length;
  assert.strictEqual(r.recorded, 0, 're-scan records nothing new');
  assert.strictEqual(before, after, 'no duplicate records');
  ok('re-scanning the same range is idempotent (claimId dedup)');
}

// ── 4. RPC failure must NOT advance the cursor (never skip a range) ──
{
  const h = harness();
  h.setRpcFail(true);
  const r = await h.consumer.scan({ network: NET, pool: POOL, tipHeight: 300, fromBlock: 0 });
  assert.strictEqual(r.rpcFailed, true, 'scan reports the RPC failure');
  assert.strictEqual(r.advancedCursorTo, null, 'cursor NOT advanced on RPC failure');
  assert.strictEqual(await h.consumer.nextFromBlock(NET, POOL, 7), 7, 'fromBlock falls back to deployBlock (no cursor written)');
  h.setRpcFail(false);
  const r2 = await h.consumer.scan({ network: NET, pool: POOL, tipHeight: 300, fromBlock: 0 });
  assert.strictEqual(r2.recorded, 2, 'after recovery the same range scans A + C — nothing skipped');
  ok('an RPC failure is a no-op that retries the range — a skipped range can never strand a burned note');
}

// ── 5. bind + gate: a T_CXFER carrying a recorded claimId mints once, dest must match ──
{
  const { consumer } = harness();
  await consumer.scan({ network: NET, pool: POOL, tipHeight: 150, fromBlock: 0 }); // records CLAIM_A (destA)
  const bound = await consumer.bindBitcoinOutput({ network: NET, claimId: CLAIM_A, outputLeaf: b32('destA') });
  assert.strictEqual(bound.bound, true, 'a matching T_CXFER output binds the recorded crossOut');
  const replay = await consumer.bindBitcoinOutput({ network: NET, claimId: CLAIM_A, outputLeaf: b32('destA') });
  assert.strictEqual(replay.rejected, 'already-consumed', 'a second bind on the same claimId is rejected (one-mint-per-claimId)');
  ok('bind + gate: a recorded crossOut mints exactly once (claimId consume-lock = the bridgeMinted mirror)');
}

// ── 6. bind rejects a destCommitment mismatch and an unrecorded claimId ──
{
  const { consumer } = harness();
  await consumer.scan({ network: NET, pool: POOL, tipHeight: 150, fromBlock: 0 }); // records CLAIM_A (destA)
  const mism = await consumer.bindBitcoinOutput({ network: NET, claimId: CLAIM_A, outputLeaf: b32('WRONG') });
  assert.strictEqual(mism.rejected, 'dest-mismatch', 'a T_CXFER output not matching the recorded destCommitment is rejected');
  const unknown = await consumer.bindBitcoinOutput({ network: NET, claimId: CLAIM_B, outputLeaf: b32('destB') });
  assert.strictEqual(unknown.bound, false, 'unrecorded claimId does not bind');
  assert.strictEqual(unknown.reason, 'no-recorded-crossout', 'binding an unrecorded claimId is refused (nothing to mint against)');
  ok('bind rejects a destCommitment mismatch and an unrecorded claimId (no unbacked mint)');
}

console.log(`\n${n}/6 cross-out consumer (read + bind) checks passed`);
