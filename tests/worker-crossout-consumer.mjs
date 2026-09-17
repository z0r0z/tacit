#!/usr/bin/env node
// Worker-side CrossOut consumer factory (Mode B reverse reflection, app glue). Locks:
//  - crossoutMintLeaf is byte-identical to the canonical confidential-pool leaf (so a hinted
//    T_CROSSOUT_MINT's recomputed leaf matches the recorded destCommitment);
//  - buildCrossoutConsumer is INERT (returns null) until a ConfidentialPool is deployed;
//  - once deployed, scanOnce() fetches the eth tip + records a finalized Bitcoin-destined
//    CrossOutRecorded via the injected RPC, advancing the cursor.
//
// Run: node tests/worker-crossout-consumer.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';
import { CONFIDENTIAL_POOL_DEPLOYMENTS } from '../dapp/confidential-crossout-consumer.js';
import { buildCrossoutConsumer, crossoutMintLeaf } from '../worker/src/crossout-consumer.js';

const keccak256 = (b) => keccak_256(b);
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const cpool = makeConfidentialPool({ secp, keccak256, sha256 });
const evmLog = makeConfidentialEvmLog({ keccak256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const b32 = (tag) => '0x' + Buffer.from(tag.padEnd(32, '\0')).toString('hex');
const ZERO32 = '0x' + '00'.repeat(32);
const strip = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const u256 = (v) => BigInt(v).toString(16).padStart(64, '0');

// ── 1. crossoutMintLeaf == the guest's btc_note_leaf under the mint's vout-0 P2TR key (the bind hinge) ──
{
  const asset = b32('TAC'), cx = b32('cx'), cy = b32('cy');
  const key = '0x' + '7b'.repeat(32);
  const spk = '5120' + '7b'.repeat(32); // esplora scriptpubkey hex of a P2TR output
  const want = cpool.btcNoteLeaf(asset, cx, cy, key);
  assert.strictEqual(crossoutMintLeaf(keccak256, { assetId: asset, cx, cy, destScriptPubKey: spk }), want, 'leaf = btc_note_leaf(asset, Cx, Cy, vout-0 x-only key)');
  assert.strictEqual(crossoutMintLeaf(keccak256, { assetId: asset, cx, cy, destScriptPubKey: '0x' + spk }), want, '0x-prefixed script accepted');
  assert.notStrictEqual(want, cpool.leaf(asset, cx, cy, key), 'not the native leaf layout');
  assert.strictEqual(crossoutMintLeaf(keccak256, { assetId: asset, cx, cy, destScriptPubKey: '0014' + '11'.repeat(20) }), null, 'non-P2TR vout 0 has no leaf');
  assert.strictEqual(crossoutMintLeaf(keccak256, { assetId: asset, cx, cy, destScriptPubKey: '5120' + '00'.repeat(32) }), null, 'zero key has no leaf');
  assert.strictEqual(crossoutMintLeaf(keccak256, { assetId: asset, cx, cy }), null, 'missing script has no leaf');
  // A burn records destCommitment = btcDestLeaf under the destination key; the mint rebuilds the same leaf.
  assert.strictEqual(want, cpool.btcNoteLeaf(asset, cx, cy, key));
  ok('crossoutMintLeaf reproduces the guest btc_note_leaf from the vout-0 P2TR key (null for any other script)');
}

// ── 2. INERT until a pool is deployed (no pool → buildCrossoutConsumer returns null) ──
{
  const env = { REGISTRY_KV: { get: async () => null, put: async () => {} } };
  CONFIDENTIAL_POOL_DEPLOYMENTS.signet.pool = null;
  const cc = buildCrossoutConsumer(env, { network: 'signet', keccak256, rpcsForNetwork: () => ['http://mock'] });
  assert.strictEqual(cc, null, 'no pool deployed → consumer is null (cron/dispatch are no-ops)');
  const cc2 = buildCrossoutConsumer({ /* no KV */ }, { network: 'signet', keccak256, rpcsForNetwork: () => [] });
  assert.strictEqual(cc2, null, 'no REGISTRY_KV → null');
  ok('buildCrossoutConsumer is inert (null) until a ConfidentialPool is deployed');
}

// ── 3. scanOnce(): eth tip via RPC + record a finalized Bitcoin-destined CrossOutRecorded ──
{
  const map = new Map();
  const env = { REGISTRY_KV: { get: async (k) => (map.has(k) ? map.get(k) : null), put: async (k, v) => { map.set(k, v); } } };

  const CLAIM = b32('claimQ'), ASSET = b32('TAC'), DEST = b32('destQ');
  const logBlock = 100, tip = 200; // safeTip = tip − 36 = 164 ≥ 100 → finalized
  const crossOutLog = {
    topics: [evmLog.TOPIC0.CrossOutRecorded, CLAIM],
    data: '0x' + u256(1) /* destChain=Bitcoin */ + strip(DEST) + strip(b32('nuQ')) + strip(ASSET),
    blockNumber: '0x' + logBlock.toString(16),
  };
  // Injected RPC: eth_blockNumber → tip; eth_getLogs → [crossOutLog].
  const fetchFn = async (_rpc, opts) => {
    const m = JSON.parse(opts.body).method;
    const result = m === 'eth_blockNumber' ? '0x' + tip.toString(16)
                 : m === 'eth_getLogs' ? [crossOutLog]
                 : null;
    return { ok: true, json: async () => ({ result }) };
  };

  CONFIDENTIAL_POOL_DEPLOYMENTS.signet.pool = '0xPoolAddr';
  CONFIDENTIAL_POOL_DEPLOYMENTS.signet.deployBlock = 0;
  const cc = buildCrossoutConsumer(env, { network: 'signet', keccak256, rpcsForNetwork: () => ['http://mock'], fetchFn });
  assert.ok(cc, 'consumer built once a pool is deployed');
  assert.strictEqual(await cc.ethTip(), tip, 'ethTip reads eth_blockNumber over the RPC list');

  const r = await cc.scanOnce();
  assert.strictEqual(r.recorded, 1, 'scanOnce records the finalized Bitcoin-destined crossOut');
  assert.strictEqual(r.toBlock, tip - 36, 'scanned up to tip − confirmations');
  const rec = await cc.consumer.getRecorded('signet', CLAIM);
  assert.ok(rec && rec.destCommitment === DEST, 'recorded with destCommitment carried verbatim');

  // cursor advanced → a re-scan records nothing new
  const r2 = await cc.scanOnce();
  assert.strictEqual(r2.recorded, 0, 're-scan is idempotent (cursor advanced)');
  ok('scanOnce fetches the eth tip and records a finalized CrossOutRecorded, advancing the cursor');

  CONFIDENTIAL_POOL_DEPLOYMENTS.signet.pool = null; // restore the gated default
  CONFIDENTIAL_POOL_DEPLOYMENTS.signet.deployBlock = 0;
}

console.log(`\n${n}/3 worker cross-out consumer (factory + leaf-parity) checks passed`);
