#!/usr/bin/env node
// Pending burn-deposits and the Mode-B sync-committee anchor in the JS reflection mirror (cxfer-core
// ScanReflection.pending_deposit_* / eth_sync_committee, reflect.rs fold_burn_deposit + the completions section):
//   1. a scanned burn-deposit whose provenance is withheld is recorded pending: a real insert witness, count 2,
//      the digest moves, nothing is onboarded;
//   2. a later batch completes it: the note, spent and burn sets move, the completion carries a membership witness;
//   3. a completion whose envelope fields differ from the pending record, one for an outpoint never recorded, and
//      one that does not verify are left out (the guest aborts on each) and reported as dropped;
//   4. the pending set and its records survive an indexer snapshot/load;
//   5. Mode-B chains the sync committee: the proof must start from the genesis committee, then from the committee
//      the last cycle ended on; a wrong start or a zero end is refused;
//   6. the real-provenance generator scenarios (pending, complete, completion with a different dest) run clean.
//   node tests/confidential-reflection-pending-deposit.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
const pool = makeConfidentialPool(deps);

let failures = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };
const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const Z = v(0);

const ASSET = v(0xa55e7), NU = v(0x17ad), DEST = v(0xde57), TARGET = v(0x7c7c);
const BURNED_TXID = v(0xb117), BURN_TXID = v(0xb0b0);

const burnTx = (ctx) => ({
  txData: '0xbb', txid: BURN_TXID, vins: [{ prevTxid: BURNED_TXID, vout: 0 }],
  env: { type: 'burn', assetId: ASSET, nullifier: NU, dest: DEST, target: TARGET, burnDeposit: ctx },
});
const withheld = {
  valid: false, nu: NU, dest: DEST, target: TARGET, burnedTxid: BURNED_TXID, burnedVout: 0, burnedCx: Z, burnedCy: Z, burnedNoteLeaf: Z,
  witness: { burnWtxidSiblings: [], burnCbTxidSiblings: [], provHeaders: [], blob: '0x' },
};
const completion = (extra = {}) => ({
  valid: true, burnedTxid: BURNED_TXID, burnedVout: 0, asset: ASSET, nu: NU, dest: DEST, target: TARGET,
  burnedCx: v(0xc1), burnedCy: v(0xc2), burnedNoteLeaf: v(0x1eaf),
  witness: { provHeaders: ['0x' + '00'.repeat(80)], blob: '0x01' }, ...extra,
});
const plainBlock = { txs: [{ txData: '0xcc', txid: v(0xc0), vins: [{ prevTxid: v(0xc1c1), vout: 0 }], env: null }] };

// ── 1. withheld provenance → pending ──
const state = pool.makeScanReflectionState();
const control = pool.makeScanReflectionState();
state.setHeight(99); control.setHeight(99);
const in1 = await pool.assembleReflectionScanInput(state, { anchorHeight: 100, headers: [], blocks: [{ txs: [burnTx(withheld)] }] }, new Map());
await pool.assembleReflectionScanInput(control, { anchorHeight: 100, headers: [], blocks: [plainBlock] }, new Map());
const bd = in1.blocks[0].txs[0].burnDeposit;
ok(bd && bd.pendingInsert && bd.pendingInsert.pLowPath.length === 32 && bd.pendingInsert.pNewPath.length === 32 && bd.pendingInsert.pLowIndex === 0, 'pending: a real insert witness (low = the sentinel)');
ok(state.pendingDepositCount() === 2, 'pending: count 2');
ok(state.pendingDepositRoot() !== control.pendingDepositRoot() && in1.newDigest !== control.digest(), 'pending: the pending root and the digest move');
ok(state.counts().note === 0 && state.counts().burn === 1 && state.counts().spent === 1, 'pending: nothing is onboarded');
ok(in1.prior.pendingDepositCount === 1 && in1.prior.ethSyncCommittee === Z, 'prior carries the genesis pending count and sync committee');
const m = state.pendingDepositWitness(BURNED_TXID, 0);
ok(m && m.value === pool.pendingDepositValue(ASSET, NU, DEST, TARGET), 'pending: the record is keyed by the burned outpoint and valued over the envelope fields');

// ── 4. snapshot / load ──
{
  const a = makeScanReflectionIndexer(deps);
  a.load(null);
  // Drive the indexer's own state through the same pending fold, then round-trip it.
  await pool.assembleReflectionScanInput(a.state(), { anchorHeight: 100, headers: [], blocks: [{ txs: [burnTx(withheld)] }] }, new Map());
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const b = makeScanReflectionIndexer(deps);
  b.load(snap);
  ok(b.digest() === a.digest(), 'snapshot: the restored digest matches (pending set + committee ride the snapshot)');
  ok(b.state().pendingDepositRecords().length === 1 && b.state().pendingDepositRecords()[0].nu === NU, 'snapshot: the pending record is restored');
}

// ── 3. dropped completions leave the state untouched ──
{
  const before = state.digest();
  const probe = async (cc) => pool.assembleReflectionScanInput(state, { anchorHeight: 101, headers: [], blocks: [], depositCompletions: [cc] }, new Map());
  const wrongDest = await probe(completion({ dest: v(0xbad) }));
  ok(wrongDest.depositCompletions.length === 0 && wrongDest.droppedDepositCompletions.length === 1, 'dropped: a completion with a different dest fails membership');
  const wrongOutpoint = await probe(completion({ burnedVout: 1 }));
  ok(wrongOutpoint.depositCompletions.length === 0 && wrongOutpoint.droppedDepositCompletions.length === 1, 'dropped: an outpoint never recorded pending');
  const unverified = await probe(completion({ valid: false, reason: 'stub' }));
  ok(unverified.depositCompletions.length === 0 && unverified.droppedDepositCompletions[0].reason === 'stub', 'dropped: a completion that does not verify');
  ok(state.digest() === before, 'dropped: the state is untouched');
}

// ── 2. completion ──
{
  const burnRoot = state.burnRoot(), noteCount = state.counts().note;
  const in2 = await pool.assembleReflectionScanInput(state, { anchorHeight: 101, headers: [], blocks: [plainBlock], depositCompletions: [completion()] }, new Map());
  const c = in2.depositCompletions[0];
  ok(in2.depositCompletions.length === 1 && c.pendingIndex === m.index && c.pendingPath.length === 32 && c.pendingNext === m.next, 'complete: one completion with the pending membership witness');
  ok(c && c.asset === ASSET && c.nu === NU && c.dest === DEST && c.target === TARGET && c.burnedTxid === BURNED_TXID && c.burnedVout === 0, 'complete: the record fields in the writer shape');
  ok(c && c.deposit.spentInsert.sLowPath.length === 32 && c.deposit.burnInsert.bLowPath.length === 32 && c.deposit.coIsMember === 0 && c.deposit.notePath.length === 32, 'complete: the deposit witness in read_deposit_witness order');
  ok(state.counts().note === noteCount + 1 && state.burnRoot() !== burnRoot && state.counts().spent === 2, 'complete: note, spent and burn sets move');
  ok(state.pendingDepositCount() === 2, 'complete: nothing is removed from the pending set');
  ok(state.pendingDepositRecords()[0].completed === true, 'complete: the record is marked completed (off-digest)');
  const none = await pool.assembleReflectionScanInput(state, { anchorHeight: 102, headers: [], blocks: [] }, new Map());
  ok(Array.isArray(none.depositCompletions) && none.depositCompletions.length === 0, 'no completions: an empty list (the writer emits n = 0)');
}

// ── 5. Mode-B sync-committee chaining ──
{
  const st = pool.makeScanReflectionState();
  st.setHeight(9);
  const coRoot = pool.makeImtAccumulator().root();
  const EMPTY = '0x27ae5ba08d7291c96c8cbddcc148bf48a6d68c7974b94356f53754ef6171d757';
  const POOL = '0x' + '5a'.repeat(20);
  const pv = (end, start) => pool.buildEthPv(coRoot, EMPTY, 0, 0, POOL, EMPTY, 0, null, end, start);
  const modeB = (ethPv) => ({ ethPv, crossoutSetRoot: coRoot, consumedSetRoot: EMPTY, consumed: [], messages: [] });
  const run = async (ethPv) => { try { return { input: await pool.assembleReflectionScanInput(st, { anchorHeight: 10, headers: [], blocks: [], modeB: modeB(ethPv) }, new Map()) }; } catch (e) { return { error: e.message }; } };
  const C1 = v(0xc0331), C2 = v(0xc0332);
  const bad = await run(pv(C1, C2));
  ok(bad.error && /starts from sync committee/.test(bad.error), 'mode-b: a first proof not starting from the genesis committee is refused');
  const d0 = st.digest();
  const first = await run(pv(C1, null));
  ok(first.input && st.getEthSyncCommittee() === C1, 'mode-b: the first proof starts from genesis and the state takes the committee it ends on');
  ok(first.input && first.input.newDigest !== d0, 'mode-b: the committee rides the digest');
  const stale = await run(pv(C2, null));
  ok(stale.error && /starts from sync committee/.test(stale.error), 'mode-b: a later proof restarting from genesis is refused');
  const next = await run(pv(C2, C1));
  ok(next.input && st.getEthSyncCommittee() === C2, 'mode-b: a later proof chains from the last committee');
  const zeroEnd = pool.buildEthPv(coRoot, EMPTY, 0, 0, POOL, EMPTY, 0, null, null, C2).slice(0, 2 + 7 * 64) + '00'.repeat(32) + pool.buildEthPv(coRoot, EMPTY, 0, 0, POOL, EMPTY, 0, null, null, C2).slice(2 + 8 * 64);
  const zr = await run(zeroEnd);
  ok(zr.error && /zero sync-committee/.test(zr.error), 'mode-b: a proof ending on a zero committee is refused');
  const pre = pool.makeScanReflectionState();
  pre.setEthSyncCommittee(C2);
  const kept = pre.getEthSyncCommittee();
  pre.rebase();
  ok(pre.getEthSyncCommittee() === kept, 'rebase: the sync committee is preserved');
}

// ── 6. real-provenance generator scenarios ──
const gen = (env) => spawnSync(process.execPath, [new URL('./gen-reflection-burn-deposit.mjs', import.meta.url).pathname], {
  env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
{
  const p = gen({ BURNDEP_SCENARIO: 'pending' });
  const f = p.status === 0 ? JSON.parse(p.stdout) : null;
  ok(f && f.blocks[0].txs[1].burnDeposit.pendingInsert && f.blocks[0].txs[1].burnDeposit.blob === '0x', 'generator pending: a withheld burn with a pending insert');
  const c = gen({ BURNDEP_SCENARIO: 'complete' });
  const g = c.status === 0 ? JSON.parse(c.stdout) : null;
  ok(g && g.prior.pendingDepositCount === 2 && g.depositCompletions.length === 1 && g.depositCompletions[0].deposit.blob !== '0x', 'generator complete: the admitted completion is emitted');
  const w = gen({ BURNDEP_SCENARIO: 'complete', BURNDEP_COMPLETION_DEST: v(0xeeee) });
  const h = w.status === 0 ? JSON.parse(w.stdout) : null;
  ok(h && h.depositCompletions.length === 0 && h.droppedDepositCompletions.length === 1, 'generator complete with a different dest: dropped, not emitted');
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
