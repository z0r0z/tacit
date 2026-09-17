#!/usr/bin/env node
// The generational rebase drain gate, checked in the assembler before a successor's first batch is emitted.
// The guest aborts a rebase whose witnessed on-chain consume count differs from the folded one, or whose folded
// cross-out count exceeds the on-chain crossOutCount; an on-chain crossOutCount above the folded count (a
// cross-out whose Bitcoin mint has not landed) is accepted. The assembler refuses the same batches up front, so
// the attester never spends a proving run on an input the guest will abort. `rebase.expectGuestReject` builds
// the aborting input anyway, for negative fixtures.
//   node tests/confidential-reflection-rebase-preflight.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const BLOCK_HEIGHT = 412000;
const FOLDED_CONSUMED = 4n, FOLDED_CROSSOUT = 3n;

let failures = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

function predecessor() {
  const state = pool.makeScanReflectionState();
  state.setHeight(BLOCK_HEIGHT - 1);
  state.setConsumedCount(FOLDED_CONSUMED);
  state.setFoldedCrossoutCount(FOLDED_CROSSOUT);
  return state;
}

// One block with a coinbase and a plain tx that folds nothing.
function plainBatch() {
  const prev = Buffer.alloc(32, 0xd9);
  const tx = cat([[0x02, 0x00, 0x00, 0x00], varint(1), prev, u32le(0), [0x00], [0xff, 0xff, 0xff, 0xff], varint(1), Buffer.alloc(8), [0x00], Buffer.alloc(4)]);
  const txid = computeTxid(tx);
  const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
  const header = mineHeader(computeMerkleRoot([cbTxid, txid]));
  return {
    anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')],
    blocks: [{ txs: [coinbaseSpec, { txData: '0x' + tx.toString('hex'), txid: '0x' + Buffer.from(txid).toString('hex'), vins: [{ prevTxid: '0x' + prev.toString('hex'), vout: 0 }], env: null }] }],
  };
}
const batch = plainBatch();

async function attempt(rebase) {
  const state = predecessor();
  try { return { input: await pool.assembleReflectionScanInput(state, { ...batch, rebase }, new Map()) }; }
  catch (e) { return { error: String(e && e.message || e) }; }
}

{
  const r = await attempt({});
  ok(r.input && r.input.rebaseMode === 1, 'drained predecessor (counts default to the folded ones) rebases');
}
{
  const r = await attempt({ predecessorConsumedCount: Number(FOLDED_CONSUMED), predecessorCrossOutCount: Number(FOLDED_CROSSOUT) });
  ok(r.input && r.input.predecessorConsumedCount === Number(FOLDED_CONSUMED), 'explicit equal counters rebase');
}
{
  const r = await attempt({ predecessorConsumedCount: Number(FOLDED_CONSUMED) + 2 });
  ok(r.error && /not drained/.test(r.error), 'on-chain consumes above folded are refused');
}
{
  const r = await attempt({ predecessorConsumedCount: Number(FOLDED_CONSUMED) - 1 });
  ok(r.error && /not drained/.test(r.error), 'on-chain consumes below folded are refused (the count must be exact)');
}
{
  const r = await attempt({ predecessorCrossOutCount: Number(FOLDED_CROSSOUT) + 2 });
  ok(r.input && r.input.predecessorCrossOutCount === Number(FOLDED_CROSSOUT) + 2, 'a cross-out recorded on-chain but not yet minted on Bitcoin still rebases');
}
{
  const r = await attempt({ predecessorCrossOutCount: Number(FOLDED_CROSSOUT) - 1 });
  ok(r.error && /inconsistent/.test(r.error), 'folded cross-outs above the on-chain count are refused');
}
{
  const r = await attempt({ predecessorConsumedCount: Number(FOLDED_CONSUMED) + 2, expectGuestReject: true });
  ok(r.input && r.input.predecessorConsumedCount === Number(FOLDED_CONSUMED) + 2, 'expectGuestReject builds the aborting input for a negative fixture');
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
