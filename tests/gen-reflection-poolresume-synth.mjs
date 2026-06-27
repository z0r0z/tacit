#!/usr/bin/env node
// Validate the Track-B pool-registry RESUME end-to-end: seed a NON-EMPTY pool registry in the prior state
// (the resume-wire handoff), scan a plain block (no effect), and confirm the reflection guest reconstructs
// the same registry and lands on the JS assembler's newDigest. The cBTC fixture had an EMPTY registry, so
// this is what actually exercises the n_pools resume path (reflect.rs reads the 9-field PoolReserveState +
// the harness writes it). A field-order/encoding drift in the non-empty case would surface as a digest miss.
//   node tests/gen-reflection-poolresume-synth.mjs > /tmp/poolresume-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const BLOCK_HEIGHT = 309000;

// A resumed C0-backed pool with a non-zero protocol-fee tier (so all 9 PoolReserveState fields are
// exercised in the resume: reserves, shares, backing flag, fee bps, k_last, accrued).
const reserveA = 1000000n, reserveB = 2000000n;
const poolEntry = {
  poolId: '0x' + '11'.repeat(32), assetA: '0x' + 'aa'.repeat(32), assetB: '0x' + 'bb'.repeat(32),
  reserveA: reserveA.toString(), reserveB: reserveB.toString(), totalShares: '1414213',
  c0Backed: true, protocolFeeBps: 30, kLast: (reserveA * reserveB).toString(), protocolFeeAccrued: '7',
};

const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.pools.load([poolEntry]);

// A plain (non-TACIT, non-segwit) tx — no envelope, no pool-UTXO spend → folds nothing; the pool registry
// rides through unchanged, so newDigest == the resumed priorDigest (which commits the registry).
const dummyPrev = Buffer.alloc(32, 0xee);
const tx = cat([
  [0x02, 0x00, 0x00, 0x00],
  varint(1), dummyPrev, u32le(0), [0x00], [0xff, 0xff, 0xff, 0xff],
  varint(1), Buffer.alloc(8), [0x00],
  Buffer.alloc(4),
]);
const txid = computeTxid(tx);
const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
const header = mineHeader(computeMerkleRoot([cbTxid, txid]));

const txSpec = { txData: '0x' + tx.toString('hex'), txid: '0x' + Buffer.from(txid).toString('hex'), vins: [{ prevTxid: '0x' + dummyPrev.toString('hex'), vout: 0 }], env: null };
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }],
}, new Map());

console.error(`pool-registry resume: nPools=${input.prior.pools.length} c0Backed=${input.prior.pools[0]?.c0Backed} feeBps=${input.prior.pools[0]?.protocolFeeBps} newDigest=${input.newDigest}`);
if (input.prior.pools.length !== 1) { console.error('FATAL: pool not carried in the prior'); process.exit(1); }
console.log(JSON.stringify(input));
