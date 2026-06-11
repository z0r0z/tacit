#!/usr/bin/env node
// Phase 4.4 — the worker attester cycle (worker/src/reflection-attest.js): ingest confirmed effects,
// rebuild the canonical state by replaying the log, assemble the un-attested batch, prove (mock box),
// submit (mock contract), advance the attested cursor. Validates the orchestration; the real box
// prove + on-chain verify are validated elsewhere (the GPU proof + ConfidentialReflectionProofReal).
//
// Run: node tests/reflection-attest.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeReflectionAttester } from '../worker/src/reflection-attest.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
const pool = makeConfidentialPool(deps);
const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

// in-memory KV
let stored = null;
const storage = { load: async () => stored, save: async (s) => { stored = JSON.parse(JSON.stringify(s)); } };

// mock box prove: capture the input, return a dummy proof bound to the newDigest
let lastInput = null;
const prove = async (input) => { lastInput = input; return { vkey: '0x00116c02', publicValues: '0x' + '00', proofBytes: '0x' + 'ab' }; };
let submitted = null;
const submit = async (publicValues, proofBytes) => { submitted = { publicValues, proofBytes }; return '0xtxhash'; };
const getHeaders = async (_blocks) => ['00'.repeat(80)];

const attester = makeReflectionAttester({ deps, storage, prove, submit, getHeaders });

const asset = v(0xa5);
// 2 prior notes as deposits
const notes = [0, 1].map((i) => { const { cx, cy } = pool.commitXY(1000n + BigInt(i), 7n + BigInt(i)); return { cx, cy, txid: v(0xd0 + i), vout: i }; });
const outs = [0, 1].map((i) => { const { cx, cy } = pool.commitXY(2000n + BigInt(i), 9n + BigInt(i)); return pool.compressXY(cx, cy); });

async function main() {
  for (const n of notes) {
    await attester.ingest({ kind: 'deposit', height: 100, deposit: { assetId: asset, txid: n.txid, vout: n.vout, cx: n.cx, cy: n.cy } });
  }
  // a confirmed transfer spending both, creating 2 outputs
  await attester.ingest({
    kind: 'transfer', height: 307547,
    raw: {
      txid: v(0x7777), assetId: asset, height: 307547, blockIndex: 307547,
      txData: '00', txIndex: 6, txids: [v(0x01)],
      spentVins: notes.map((n) => ({ prevTxid: n.txid, vout: n.vout })),
      outputCommitments: outs,
    },
  });
  ok(stored.effectLog.length === 3, 'effect log persisted (2 deposits + 1 transfer)');
  eq(stored.attestedCount, 0, 'nothing attested yet');

  const res = await attester.runCycle();
  ok(res !== null, 'cycle ran (had pending)');
  eq(res.attested, 1, 'attested the 1 pending transfer');
  ok(lastInput && lastInput.effects.length === 1, 'prover input assembled with the transfer');
  eq(lastInput.effects[0].spends.length, 2, 'input carries 2 spend witnesses');
  eq(lastInput.anchorHeight, 307547, 'anchorHeight = the batch block height');
  ok(submitted !== null, 'attestation submitted');
  eq(stored.attestedCount, 1, 'attested cursor advanced');

  // a second cycle with nothing new is a no-op
  const res2 = await attester.runCycle();
  eq(res2, null, 'idempotent: no pending → no-op');

  // ── box-poll model: assembleJob serves the batch WITHOUT proving/advancing; ackJob advances ──
  const cur = await storage.load(); await storage.save({ ...cur, attestedCount: 0 }); // rewind cursor
  const job = await attester.assembleJob();
  ok(job && job.pending === 1, 'assembleJob returns the pending batch');
  ok(job.input.effects.length === 1, 'job carries the assembled prover input');
  ok(job.jobId === job.input.newDigest, 'jobId = the batch newDigest');
  eq((await storage.load()).attestedCount, 0, 'assembleJob does NOT advance the cursor (box acks after on-chain)');
  await attester.ackJob(job.attestedTo);
  eq((await storage.load()).attestedCount, 1, 'ackJob advances the cursor to attestedTo');
  eq(await attester.assembleJob(), null, 'no pending after ack → assembleJob null');
  await attester.ackJob(0); // stale ack
  eq((await storage.load()).attestedCount, 1, 'stale ack (attestedTo <= current) is a no-op');

  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS — attester cycle + box-poll job/ack assemble, serve, advance');
  process.exit(failures ? 1 : 0);
}
main();
