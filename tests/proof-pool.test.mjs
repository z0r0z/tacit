// The proof pool (worker/src/proof-pool.js) and its routes: a wrap's program input is read back and names its own deposit, leaf,
// chain binding and memo root; a page's request is deduped and capped; a miner leases the oldest job, one at a time, and a lease
// that runs out puts it back; a proof whose public values are not its job's, or that the verifier refuses, is a strike and the job
// goes back; a good proof is kept for the page without its input and credits its miner once, up to the day's cap; results, stats
// and the day's tally read what happened. The verifier is stubbed; the public values check runs on a real mainnet wrap's.
// Run: node --test tests/proof-pool.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { makeProofPool, readWrapStdin, wrapExpect, proofFits, verifyCalldata, proofPoolConfig, clientOf, PROOF_POOL } from '../worker/src/proof-pool.js';
import { stdinFor } from '../dapp/sp1-stdin.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import worker, { ethCallVerdict, simulateSettle } from '../worker/src/index.js';

const FIX = new URL('./fixtures/sp1-stdin/', import.meta.url);
const WRAP_OP = JSON.parse(readFileSync(new URL('wrap.op.json', FIX), 'utf8'));
const WRAP_BIN = new Uint8Array(readFileSync(new URL('wrap.bin', FIX)));
const MAINNET = JSON.parse(readFileSync(new URL('./fixtures/proof-pool/mainnet-wrap.json', import.meta.url), 'utf8'));
const hx = (b) => '0x' + bytesToHex(b);

// A wrap's input and what its proof must commit to; `i` makes a different deposit (the value), `memo` a different memo only.
function wrapJob(i = 0, memo = null) {
  const op = { ...WRAP_OP, value: String(1500 + i), ...(memo ? { memoHashes: [memo] } : {}) };
  const bytes = stdinFor('wrap', op);
  return { stdin: hx(bytes), bytes, expect: wrapExpect(readWrapStdin(bytes)), id: bytesToHex(sha256(bytes)).slice(0, 32) };
}
// abi.encode(PublicValues) as far as the pool reads it: the tuple's head (field k in word 1 + k) with the chain binding, the memo
// root and the offsets of `leaves` and `depositsConsumed`, then those two lists.
const word = (x) => BigInt(x).toString(16).padStart(64, '0');
function pvFor(e, { leaves = [e.leaf], deposits = [e.depositId], chainBinding = e.chainBinding, memoRoot = e.memoRoot } = {}) {
  const head = Array.from({ length: 32 }, () => word(0)), tail = [];
  head[0] = word(32); head[1] = word(1); head[2] = chainBinding.slice(2); head[28] = memoRoot.slice(2);
  head[5] = word(31 * 32); tail.push(word(leaves.length), ...leaves.map((x) => x.slice(2)));
  head[6] = word((31 + tail.length) * 32); tail.push(word(deposits.length), ...deposits.map((x) => x.slice(2)));
  return '0x' + head.join('') + tail.join('');
}
const PROOF = '0x' + 'ab'.repeat(260);
const MINER = '0x' + '11'.repeat(20), MINER2 = '0x' + '22'.repeat(20), MINER3 = '0x' + '33'.repeat(20);
const kv = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } }; };
const T0 = Date.UTC(2026, 9, 26, 1), DAY0 = Math.floor(T0 / 86_400_000);

// A pool on a fake KV and clock, with a verifier that answers `verdict` (default: takes every proof) and counts its calls.
function harness({ cfg = {}, verdict = () => ({ ok: true }) } = {}) {
  const h = { t: T0, calls: 0, store: kv(), verdict };
  let n = 0;
  h.pool = makeProofPool({ kv: h.store, cfg: { ...PROOF_POOL, ...cfg }, now: () => h.t, random: () => `lease-${++n}`, verify: async (p) => { h.calls++; return h.verdict(p); } });
  return h;
}

test('the input: a wrap\'s program input is read back from its bytes, and names the deposit and leaf the pool computes for it', () => {
  const w = readWrapStdin(WRAP_BIN);
  assert.equal(w.value, 1500n);
  assert.equal(hx(w.asset), WRAP_OP.asset); assert.equal(hx(w.cx), WRAP_OP.cx); assert.equal(hx(w.owner), WRAP_OP.owner);
  const kit = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
  const e = wrapExpect(w);
  assert.equal(e.leaf, kit.leaf(WRAP_OP.asset, WRAP_OP.cx, WRAP_OP.cy, WRAP_OP.owner).toLowerCase());
  assert.equal(e.depositId, kit.depositId(WRAP_OP.asset, 1500n, WRAP_OP.cx, WRAP_OP.cy, WRAP_OP.owner).toLowerCase());
  assert.equal(e.chainBinding, WRAP_OP.chainBinding);
  assert.equal(e.memoRoot, hx(keccak_256(concatBytes(new Uint8Array(32), hexToBytes(WRAP_OP.memoHashes[0].slice(2))))));
  // Anything else is refused: another op, a root that is not zero, two memo hashes, a byte more or less.
  const bad = (bytes, re) => assert.throws(() => readWrapStdin(bytes), re);
  bad(new Uint8Array(readFileSync(new URL('transfer.bin', FIX))), /sixteen entries|wrap|zero|bytes/);
  const rooted = WRAP_BIN.slice(); rooted[8 + 8 + 40 + 8 + 8] = 1; bad(rooted, /no root/);
  bad(stdinFor('wrap', { ...WRAP_OP, memoHashes: [WRAP_OP.memoHashes[0], WRAP_OP.memoHashes[0]] }), /sixteen entries/);
  bad(concatBytes(WRAP_BIN, new Uint8Array(1)), /nothing after/);
  bad(WRAP_BIN.subarray(0, WRAP_BIN.length - 1), /ends early|nothing after/);
  const opType = WRAP_BIN.slice(); const at = 8 + 6 * 48 + 12 + 8; assert.equal(opType[at], 0); opType[at] = 1; bad(opType, /OP_WRAP/);
});

test('the proof: public values fit only their own wrap (read on a real mainnet wrap\'s); the verifier call is encoded as cast encodes it', () => {
  const e = MAINNET.expect;
  assert.equal(proofFits(MAINNET.publicValues, e), true);
  for (const k of ['leaf', 'depositId', 'chainBinding', 'memoRoot']) assert.equal(proofFits(MAINNET.publicValues, { ...e, [k]: '0x' + '00'.repeat(31) + '01' }), false, `another ${k}`);
  assert.equal(proofFits(MAINNET.publicValues.slice(0, 2 + 64 * 30), e), false, 'cut short');
  assert.equal(proofFits('0x1234', e), false);
  assert.equal(proofFits(null, e), false);
  // Its memo root is the running keccak over the one memo's hash, as the guest and the pool compute it.
  const memoHash = keccak_256(hexToBytes(MAINNET.memo.slice(2)));
  assert.equal(wrapExpect({ ...readWrapStdin(WRAP_BIN), memoHash }).memoRoot, e.memoRoot);
  // A synthetic proof of a test wrap fits it and no other: not one with another value, nor one with the same note and another memo.
  const a = wrapJob(0), b = wrapJob(1), c = wrapJob(0, '0x' + '77'.repeat(32));
  assert.equal(proofFits(pvFor(a.expect), a.expect), true);
  assert.equal(proofFits(pvFor(a.expect), b.expect), false);
  assert.equal(a.expect.depositId, c.expect.depositId); assert.equal(a.expect.leaf, c.expect.leaf);
  assert.equal(proofFits(pvFor(a.expect), c.expect), false, 'same deposit and leaf, another memo');
  assert.equal(proofFits(pvFor(a.expect, { leaves: [a.expect.leaf, a.expect.leaf] }), a.expect), false, 'a second leaf');
  assert.equal(proofFits(pvFor(a.expect, { deposits: [] }), a.expect), false, 'no deposit');
  // cast calldata "verifyProof(bytes32,bytes,bytes)" 0x006c…e3 0x0102…35 0xabcdef
  assert.equal(verifyCalldata({ vkey: '0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3', publicValues: '0x0102030405060708091011121314151617181920212223242526272829303132333435', proof: '0xabcdef' }),
    '0x41493c60006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000023010203040506070809101112131415161718192021222324252627282930313233343500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003abcdef0000000000000000000000000000000000000000000000000000000000');
});

test('config: the environment sets each number within its bounds, and a bad value keeps the default', () => {
  const c = proofPoolConfig({ POOL_REQ_IP_DAILY: '4', POOL_MAX_PENDING: '10', POOL_LEASE_MS: '600000', POOL_KEEP_MS: 'soon', POINTS_MINE_PER_PROOF: '25', POINTS_MINE_DAILY_CAP: '-1' });
  assert.equal(c.reqPerClientDay, 4); assert.equal(c.maxPending, 10); assert.equal(c.leaseMs, 600_000);
  assert.equal(c.keepMs, PROOF_POOL.keepMs); assert.equal(c.pointsPerProof, 25); assert.equal(c.proofsPerMinerDay, PROOF_POOL.proofsPerMinerDay);
  assert.deepEqual(proofPoolConfig({}), { ...PROOF_POOL });
});

test('request: the input names the job, the same input is one job, expect must be what the input proves; a client\'s day and the pool\'s size are capped', async () => {
  const h = harness({ cfg: { reqPerClientDay: 2, maxPending: 3 } });
  const a = wrapJob(0);
  let r = await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'c1' });
  assert.deepEqual(r, { status: 200, body: { ok: true, id: a.id } });
  assert.equal(a.id, bytesToHex(sha256(a.bytes)).slice(0, 32), 'the id tacit-prover gives the same input');
  r = await h.pool.request({ type: 'wrap', stdin: a.stdin.toUpperCase().replace('0X', '0x'), expect: { depositId: a.expect.depositId, leaf: a.expect.leaf }, client: 'c1' });
  assert.deepEqual(r.body, { ok: true, id: a.id, deduped: true }, 'the same input again is the same job, and costs nothing');
  const b = wrapJob(1);
  assert.equal((await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: a.expect, client: 'c1' })).body.code, 'bad_expect', 'a deposit the input does not prove');
  assert.equal((await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: { depositId: b.expect.depositId }, client: 'c1' })).body.code, 'bad_expect');
  assert.equal((await h.pool.request({ type: 'transfer', stdin: b.stdin, expect: b.expect, client: 'c1' })).body.code, 'bad_type');
  assert.equal((await h.pool.request({ type: 'wrap', stdin: '0x1234', expect: b.expect, client: 'c1' })).body.code, 'bad_stdin');
  assert.equal((await h.pool.request({ type: 'wrap', stdin: '0x' + '00'.repeat(PROOF_POOL.maxStdinBytes + 1), expect: b.expect, client: 'c1' })).body.code, 'bad_stdin');
  assert.equal((await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: b.expect, client: 'c1' })).status, 200);
  r = await h.pool.request({ type: 'wrap', stdin: wrapJob(2).stdin, expect: wrapJob(2).expect, client: 'c1' });
  assert.deepEqual([r.status, r.body.code], [429, 'pool_cap'], 'two a day from one client');
  assert.equal((await h.pool.request({ type: 'wrap', stdin: wrapJob(2).stdin, expect: wrapJob(2).expect, client: 'c2' })).status, 200);
  r = await h.pool.request({ type: 'wrap', stdin: wrapJob(3).stdin, expect: wrapJob(3).expect, client: 'c3' });
  assert.deepEqual([r.status, r.body.code], [429, 'pool_full'], 'three waiting is full');
  h.t += 86_400_000;
  assert.equal((await h.pool.request({ type: 'wrap', stdin: wrapJob(4).stdin, expect: wrapJob(4).expect, client: 'c1' })).body.code, 'pool_full', 'a new day resets the client, not the queue');
});

test('lease: the oldest job first, one lease per address on a client and a few on a client, 204 when nothing waits; a lease that runs out puts its job back at its age; three tries and it is dropped', async () => {
  const h = harness({ cfg: { leaseMs: 60_000 } });
  const a = wrapJob(0), b = wrapJob(1);
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  h.t += 1000;
  await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: b.expect, client: 'page' });
  assert.equal((await h.pool.lease({ miner: 'nobody', client: 'm1' })).body.code, 'bad_miner');
  let r = await h.pool.lease({ miner: MINER, client: 'm1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, id: a.id, type: 'wrap', stdin: a.stdin, lease: 'lease-1', leaseMs: 60_000, points: 20 });
  r = await h.pool.lease({ miner: MINER, client: 'm1' });
  assert.deepEqual([r.status, r.body.code, r.body.id], [429, 'lease_open', a.id], 'one per address on a client');
  h.t += 30_000;
  // Another client may lease under the same address: an address only says where the points go, so it never holds anyone back.
  assert.equal((await h.pool.lease({ miner: MINER, client: 'm2' })).body.id, b.id);
  assert.equal((await h.pool.lease({ miner: MINER3, client: 'm3' })).status, 204, 'nothing left');
  assert.deepEqual((await h.pool.results([a.id, b.id])).body.results, { [a.id]: { status: 'leased' }, [b.id]: { status: 'leased' } });
  // The first lease runs out: its job is queued again, ahead of anything newer, and not offered to the miner that let it lapse.
  h.t += 30_000;
  assert.deepEqual((await h.pool.results([a.id, b.id])).body.results, { [a.id]: { status: 'queued' }, [b.id]: { status: 'leased' } });
  assert.equal((await h.pool.lease({ miner: MINER2, client: 'm1' })).status, 204, 'the client that let it lapse is not offered it again, under any address');
  const c = wrapJob(2);
  await h.pool.request({ type: 'wrap', stdin: c.stdin, expect: c.expect, client: 'page' });
  assert.equal((await h.pool.lease({ miner: MINER3, client: 'm3' })).body.id, a.id, 'oldest first');
  // Two more lapses (three tries) and the job is dropped: an input that never proves does not go round forever.
  h.t += 60_000;
  const fourth = '0x' + '44'.repeat(20);
  assert.equal((await h.pool.lease({ miner: fourth, client: 'm4' })).body.id, a.id, 'still ahead of b, whose lease has run out too');
  h.t += 60_000;
  assert.equal((await h.pool.results([a.id])).body.results[a.id].status, 'queued', 'read as queued until the lapse is seen');
  const r2 = await h.pool.lease({ miner: '0x' + '55'.repeat(20), client: 'm5' });
  assert.equal(r2.body.id, b.id);
  assert.equal((await h.pool.results([a.id])).body.results[a.id].status, 'gone');
  assert.deepEqual({ ...(await h.pool.stats()).body, top: undefined, terms: undefined }, { queued: 1, leased: 1, doneToday: 0, minersToday: 0, top: undefined, terms: undefined });
});

test('submit: public values that are not the job\'s are refused before the verifier is asked; ones the verifier refuses are refused after; either is a strike and the job goes back', async () => {
  const h = harness({ verdict: () => ({ ok: false, reverted: true, definite: true }) });
  const a = wrapJob(0), b = wrapJob(1);
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: b.expect, client: 'page' });
  let l = (await h.pool.lease({ miner: MINER, client: 'm1' })).body;
  assert.equal(l.id, a.id);
  // Another job's proof (a valid one, say) is not this job's.
  let r = await h.pool.submit({ id: a.id, lease: l.lease, publicValues: pvFor(b.expect), proof: PROOF });
  assert.deepEqual([r.status, r.body.code], [400, 'bad_proof']);
  assert.equal(h.calls, 0, 'the verifier was not asked');
  assert.equal((await h.pool.submit({ id: a.id, lease: l.lease, publicValues: pvFor(a.expect), proof: PROOF })).body.code, 'no_lease', 'the lease is gone with it');
  assert.equal((await h.pool.results([a.id])).body.results[a.id].status, 'queued', 'back in the queue');
  // The right public values with a proof the verifier refuses.
  l = (await h.pool.lease({ miner: MINER, client: 'm1' })).body;
  assert.equal(l.id, b.id, 'the job it failed is not offered to it again');
  r = await h.pool.submit({ id: b.id, lease: l.lease, publicValues: pvFor(b.expect), proof: PROOF });
  assert.deepEqual([r.status, r.body.code], [400, 'bad_proof']);
  assert.equal(h.calls, 1);
  // A node that only says "reverted" in words refuses the proof but strikes nobody.
  h.verdict = () => ({ ok: false, reverted: true, definite: false });
  l = (await h.pool.lease({ miner: MINER2, client: 'm2' })).body;
  assert.equal((await h.pool.submit({ id: l.id, lease: l.lease, publicValues: pvFor(l.id === a.id ? a.expect : b.expect), proof: PROOF })).body.code, 'bad_proof');
  const day = JSON.parse(h.store.m.get(`pp:day:${DAY0}`));
  assert.equal(day.clients.m1, 2); assert.equal(day.clients.m2 ?? 0, 0, 'no strike on an unsure answer');
  assert.equal(day.miners[MINER]?.strikes, undefined, 'an address is never struck');
  // A third strike and the client is offered nothing more today, under any address; the address may still mine from elsewhere.
  const c = wrapJob(2);
  await h.pool.request({ type: 'wrap', stdin: c.stdin, expect: c.expect, client: 'page' });
  l = (await h.pool.lease({ miner: MINER, client: 'm1' })).body;
  assert.equal(l.id, c.id);
  await h.pool.submit({ id: c.id, lease: l.lease, publicValues: pvFor(a.expect), proof: PROOF });
  assert.deepEqual([(await h.pool.lease({ miner: MINER3, client: 'm1' })).status, (await h.pool.lease({ miner: MINER, client: 'm1' })).body.code], [403, 'struck_out']);
  assert.notEqual((await h.pool.lease({ miner: MINER, client: 'm9' })).status, 403, 'another client is not struck by it');
  h.t += 86_400_000;
  const d = wrapJob(3);
  await h.pool.request({ type: 'wrap', stdin: d.stdin, expect: d.expect, client: 'page' });
  assert.equal((await h.pool.lease({ miner: MINER, client: 'm1' })).body.id, d.id, 'a new day; the jobs it failed are still not its');
});

test('submit: a verifier that cannot be asked leaves the lease held for another try; a good proof is kept without its input and credits its miner once', async () => {
  const h = harness({ verdict: () => ({ ok: false }) });
  const a = wrapJob(0);
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  const l = (await h.pool.lease({ miner: MINER, client: 'm1' })).body;
  let r = await h.pool.submit({ id: a.id, lease: l.lease, publicValues: pvFor(a.expect), proof: PROOF });
  assert.deepEqual([r.status, r.body.code], [503, 'chain_unreadable']);
  assert.equal((await h.pool.results([a.id])).body.results[a.id].status, 'leased');
  assert.equal((await h.pool.submit({ id: a.id, lease: 'lease-x', publicValues: pvFor(a.expect), proof: PROOF })).body.code, 'no_lease', 'another token is no lease');
  assert.equal((await h.pool.submit({ id: a.id, lease: l.lease, publicValues: 'zz', proof: PROOF })).body.code, 'bad_request');
  h.verdict = () => ({ ok: true });
  r = await h.pool.submit({ id: a.id, lease: l.lease, publicValues: pvFor(a.expect).toUpperCase().replace('0X', '0x'), proof: PROOF });
  assert.deepEqual(r, { status: 200, body: { ok: true, points: 20 } });
  assert.deepEqual((await h.pool.results([a.id])).body.results[a.id], { status: 'done', publicValues: pvFor(a.expect), proof: PROOF });
  const kept = JSON.parse(h.store.m.get(`pp:job:${a.id}`));
  assert.equal('stdin' in kept, false, 'the input is dropped once proved');
  assert.equal((await h.pool.submit({ id: a.id, lease: l.lease, publicValues: pvFor(a.expect), proof: PROOF })).body.code, 'no_lease', 'credited once');
  assert.deepEqual((await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' })).body, { ok: true, id: a.id, deduped: true }, 'asking again finds the proof');
  // Kept for its time, then gone.
  h.t += PROOF_POOL.keepMs;
  assert.deepEqual((await h.pool.results([a.id, 'f'.repeat(32), 'nonsense'])).body.results, { [a.id]: { status: 'gone' }, ['f'.repeat(32)]: { status: 'gone' }, nonsense: { status: 'gone' } });
});

test('points: each passing proof earns its address the day\'s points up to the cap, after which proofs are still kept for nothing; stats and the day\'s tally', async () => {
  const h = harness({ cfg: { proofsPerMinerDay: 2, pointsPerProof: 20 } });
  const jobs = [0, 1, 2, 3].map((i) => wrapJob(i));
  for (const j of jobs) await h.pool.request({ type: 'wrap', stdin: j.stdin, expect: j.expect, client: `page${j.id}` });
  const prove = async (miner, client) => {
    const l = (await h.pool.lease({ miner, client })).body;
    const j = jobs.find((x) => x.id === l.id);
    return { lease: l, r: await h.pool.submit({ id: l.id, lease: l.lease, publicValues: pvFor(j.expect), proof: PROOF }) };
  };
  assert.equal((await prove(MINER, 'm1')).r.body.points, 20);
  assert.equal((await prove(MINER, 'm1')).r.body.points, 20);
  const third = await prove(MINER, 'm1');
  assert.equal(third.lease.points, 0, 'the lease says it would earn nothing');
  assert.deepEqual(third.r.body, { ok: true, points: 0 }, 'past the cap: kept, not credited');
  assert.equal((await prove(MINER2, 'm2')).r.body.points, 20);
  const s = (await h.pool.stats()).body;
  assert.deepEqual({ ...s, terms: undefined }, { queued: 0, leased: 0, doneToday: 4, minersToday: 2, top: [{ miner: MINER, proofs: 3 }, { miner: MINER2, proofs: 1 }], terms: undefined });
  assert.deepEqual(s.terms, { pointsPerProof: 20, proofsPerMinerDay: 2, leaseMs: PROOF_POOL.leaseMs });
  assert.equal(JSON.stringify(s).includes(jobs[0].stdin.slice(2, 40)), false, 'no inputs');
  let c = (await h.pool.credits(DAY0)).body;
  assert.deepEqual(c, { day: DAY0, over: false, pointsPerProof: 20, miners: [{ miner: MINER, proofs: 3, points: 40 }, { miner: MINER2, proofs: 1, points: 20 }] });
  assert.equal((await h.pool.credits(DAY0 + 1)).status, 400, 'not a day yet');
  h.t += 86_400_000;
  c = (await h.pool.credits(DAY0)).body;
  assert.equal(c.over, true);
  assert.deepEqual((await h.pool.credits(DAY0 + 1)).body.miners, []);
  assert.equal((await h.pool.stats()).body.doneToday, 0, 'a new day');
});

test('a miner hands back a job it cannot prove: it goes back for someone else, counted as a try', async () => {
  const h = harness();
  const a = wrapJob(0);
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  const l = (await h.pool.lease({ miner: MINER, client: 'm1' })).body;
  assert.equal((await h.pool.submit({ id: a.id, lease: 'nope', error: 'execution failed' })).body.code, 'no_lease');
  assert.deepEqual((await h.pool.submit({ id: a.id, lease: l.lease, error: 'execution failed' })).body, { ok: true, released: true });
  assert.equal((await h.pool.lease({ miner: MINER, client: 'm1' })).status, 204, 'not offered to it again');
  const l2 = (await h.pool.lease({ miner: MINER2, client: 'm2' })).body;
  assert.equal(l2.id, a.id);
  await h.pool.submit({ id: a.id, lease: l2.lease, error: 'execution failed' });
  const l3 = (await h.pool.lease({ miner: MINER3, client: 'm3' })).body;
  await h.pool.submit({ id: a.id, lease: l3.lease, error: 'execution failed' });
  assert.equal((await h.pool.results([a.id])).body.results[a.id].status, 'gone', 'three tries');
  assert.equal(h.calls, 0);
});

test('house: while miners are about, a job younger than minAgeMs is left for them; Tacit\'s own prover takes what has waited, and its proof is kept but earns nothing and is in no tally', async () => {
  const h = harness({ cfg: { minerIdleMs: 60 * 60_000 } });
  const a = wrapJob(0), b = wrapJob(1);
  assert.equal((await h.pool.lease({ client: 'm1', miner: MINER })).status, 204, 'a miner asks, with nothing queued yet');
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  h.t += 10 * 60_000;
  await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: b.expect, client: 'page' });
  assert.equal((await h.pool.lease({ client: 'house:a5000', house: 'a5000', minAgeMs: 15 * 60_000 })).status, 204, 'nothing has waited 15 minutes');
  h.t += 5 * 60_000;
  let l = (await h.pool.lease({ client: 'house:a5000', house: 'a5000', minAgeMs: 15 * 60_000 })).body;
  assert.deepEqual([l.id, l.points], [a.id, 0], 'the job that has waited 15 minutes, for no points');
  assert.equal((await h.pool.lease({ client: 'm1', miner: MINER, minAgeMs: 15 * 60_000 })).status, 204, 'the younger one is not old enough for anyone asking for age');
  assert.equal((await h.pool.lease({ client: 'm1', miner: MINER })).body.id, b.id, 'a miner takes it at once');
  assert.deepEqual((await h.pool.submit({ id: a.id, lease: l.lease, publicValues: pvFor(a.expect), proof: PROOF })).body, { ok: true, points: 0 });
  assert.equal((await h.pool.results([a.id])).body.results[a.id].status, 'done', 'kept for the page');
  const day = JSON.parse(h.store.m.get(`pp:day:${DAY0}`));
  assert.deepEqual([day.done, day.house, day.points, Object.keys(day.miners)], [1, 1, 0, []]);
  assert.deepEqual((await h.pool.credits(DAY0)).body.miners, [], 'no house row for the campaign to pay');
  assert.equal((await h.pool.stats()).body.minersToday, 0);
});

test('house: with no miner asking for work lately, Tacit\'s own prover takes a page\'s job at once; one asking again brings the wait back', async () => {
  const h = harness();
  const a = wrapJob(0), b = wrapJob(1);
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  const l = (await h.pool.lease({ client: 'house:a5000', house: 'a5000', minAgeMs: 10 * 60_000 })).body;
  assert.equal(l.id, a.id, 'nobody mining: the new job is proved at once');
  assert.equal((await h.pool.lease({ client: 'm1', miner: MINER })).status, 204, 'a miner turns up');
  await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: b.expect, client: 'page' });
  h.t += 60_000;
  assert.equal((await h.pool.lease({ client: 'house:b', house: 'b', minAgeMs: 10 * 60_000 })).status, 204, 'with a miner about, the house waits for the job to age');
  h.t += 6 * 60_000;
  assert.equal((await h.pool.lease({ client: 'house:b', house: 'b', minAgeMs: 10 * 60_000 })).body.id, b.id, 'the miner gone quiet for over five minutes: the house takes it');
});

test('urgent: the size a page expects to press first is taken by Tacit\'s own prover at once, even with a miner about and older jobs waiting; past the daily cap it is asked as any other', async () => {
  const h = harness();
  const old = wrapJob(0), hot = wrapJob(1), more = Array.from({ length: 7 }, (_, i) => wrapJob(10 + i));
  await h.pool.request({ type: 'wrap', stdin: old.stdin, expect: old.expect, client: 'page' });
  assert.equal((await h.pool.lease({ client: 'm1', miner: MINER })).body.id, old.id, 'a miner is about (and takes the old job)');
  const wait = { client: 'house:u', house: 'u', minAgeMs: 10 * 60_000 };
  await h.pool.request({ type: 'wrap', stdin: more[0].stdin, expect: more[0].expect, client: 'other' });
  h.t += 30_000;
  await h.pool.request({ type: 'wrap', stdin: hot.stdin, expect: hot.expect, client: 'page', urgent: true });
  assert.equal((await h.pool.lease(wait)).body.id, hot.id, 'the urgent job is leased at once; the ordinary one older than it still waits for the miners');
  // the cap: six a day from one place
  const c = harness();
  const ids = [];
  for (const j of more.slice(0, 7)) { await c.pool.request({ type: 'wrap', stdin: j.stdin, expect: j.expect, client: 'busy', urgent: true }); ids.push(j.id); }
  await c.pool.lease({ client: 'm2', miner: MINER2 });                 // a miner is about
  c.t += 60_000;
  const got = [];
  for (let i = 0; i < 4; i++) { const r = await c.pool.lease({ client: `house:c${i}`, house: `c${i}`, minAgeMs: 10 * 60_000 }); if (r.status === 200) got.push(r.body.id); }
  assert.equal(got.length, 4, 'four house provers each take one of the urgent ones (the first was the miner\'s)');
  assert.ok(!got.includes(ids[6]), 'the seventh, past the cap of six, was not urgent and waits');
});

test('routes: open to any origin; a page requests, a miner leases and submits (the verifier asked over eth_call), the page reads the proof', async () => {
  const env = { REGISTRY_KV: kv() };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), call: body.params[0] });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const call = (path, init = {}, ip = '203.0.113.7') => worker.fetch(new Request(`https://api.tacit.finance${path}`, { ...init, headers: { Origin: 'https://tacit.finance', 'CF-Connecting-IP': ip, ...(init.headers || {}) } }), env, { waitUntil() {} });
    const post = (o) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
    let r = await call('/prover/pool/request', { method: 'OPTIONS' });
    assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const a = wrapJob(0);
    r = await call('/prover/pool/request', post({ type: 'wrap', stdin: a.stdin, expect: { depositId: a.expect.depositId, leaf: a.expect.leaf } }));
    assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await r.json(), { ok: true, id: a.id });
    r = await call('/prover/pool/lease', post({ miner: MINER }), '198.51.100.9');
    const l = await r.json();
    assert.equal(l.id, a.id); assert.equal(l.stdin, a.stdin); assert.equal(typeof l.lease, 'string'); assert.equal(l.lease.length, 32);
    r = await call('/prover/pool/lease', post({ miner: MINER }), '198.51.100.9');
    assert.equal(r.status, 429, 'one lease per address on a client');
    r = await call('/prover/pool/lease', post({ miner: MINER2 }), '198.51.100.10');
    assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), '*');
    r = await call('/prover/pool/submit', post({ id: a.id, lease: l.lease, publicValues: pvFor(a.expect), proof: PROOF }), '198.51.100.9');
    assert.deepEqual(await r.json(), { ok: true, points: 20 });
    // A board worker's token leases as Tacit's own prover; any other token is refused.
    const tok = 'w'.repeat(24);
    env.PROVER_WORKER_TOKENS = `a5000:${tok}`;
    r = await call('/prover/pool/lease', { ...post({ minAgeMs: 0 }), headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + 'x'.repeat(24) } });
    assert.equal(r.status, 401);
    r = await call('/prover/pool/lease', { ...post({ minAgeMs: 0 }), headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tok } });
    assert.equal(r.status, 204, 'a house lease with nothing queued');
    const asked = seen.find((s) => s.call && s.call.to === '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2');
    assert.ok(asked, 'the pool\'s SP1 verifier was asked');
    assert.equal(asked.call.data, verifyCalldata({ vkey: '0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3', publicValues: pvFor(a.expect), proof: PROOF }));
    r = await call(`/prover/pool/result?ids=${a.id},${'0'.repeat(32)}`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await r.json(), { results: { [a.id]: { status: 'done', publicValues: pvFor(a.expect), proof: PROOF }, ['0'.repeat(32)]: { status: 'gone' } } });
    r = await call(`/prover/pool/result?ids=${Array.from({ length: 33 }, (_, i) => i.toString(16).padStart(32, '0')).join(',')}`);
    assert.equal(r.status, 400, 'at most 32 ids');
    r = await call('/prover/pool');
    assert.equal(r.headers.get('cache-control'), 'max-age=10');
    const s = await r.json();
    assert.equal(s.doneToday, 1); assert.deepEqual(s.top, [{ miner: MINER, proofs: 1 }]);
    r = await call(`/prover/pool/credits?day=${Math.floor(Date.now() / 86_400_000)}`);
    assert.deepEqual((await r.json()).miners, [{ miner: MINER, proofs: 1, points: 20 }]);
    assert.equal((await call('/prover/pool/lease', { method: 'GET' })).status, 404);
    assert.equal((await call('/prover/pool/nothing', post({}))).status, 404);
    // The client is kept as a hash, never the address.
    assert.equal([...env.REGISTRY_KV.m.keys()].some((k) => k.includes('203.0.113.7')), false);
    assert.ok([...env.REGISTRY_KV.m.keys()].some((k) => k.includes(clientOf('203.0.113.7'))));
  } finally { globalThis.fetch = realFetch; }
});

test('the eth_call verdict: a return is ok; a revert with a code or data is certain, one in words only is not; nodes that fail are skipped; none answering is neither', async () => {
  const realFetch = globalThis.fetch;
  const answer = (list) => { let i = 0; globalThis.fetch = async () => { const a = list[Math.min(i++, list.length - 1)]; return typeof a === 'number' ? new Response('busy', { status: a }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...a }), { status: 200 }); }; };
  const call = [{ to: '0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2', data: '0x' }, 'latest'];
  try {
    answer([{ result: '0x' }]);
    assert.deepEqual(await ethCallVerdict({}, call), { ok: true });
    answer([429, { error: { code: 3, message: 'execution reverted', data: '0xd58aec58' } }]);
    assert.deepEqual(await ethCallVerdict({}, call), { ok: false, reverted: true, definite: true, data: '0xd58aec58' });
    answer([{ error: { code: -32000, message: 'execution reverted' } }]);
    assert.deepEqual(await ethCallVerdict({}, call), { ok: false, reverted: true, definite: false, data: null });
    answer([{ error: { code: -32005, message: 'rate limited' } }]);
    assert.deepEqual(await ethCallVerdict({}, call), { ok: false });
    // The open board's settle simulation reads the same verdict as before.
    answer([{ error: { code: 3, message: 'execution reverted', data: { data: '0x8a98f245' } } }]);
    assert.deepEqual(await simulateSettle({}, { publicValues: '0x' + '00'.repeat(64), proof: '0x00', memos: [] }), { ok: false, reverted: true, definite: true, error: 'settle reverts (0x8a98f245)' });
    answer([{ error: { message: 'Reverted' } }]);
    assert.deepEqual(await simulateSettle({}, { publicValues: '0x' + '00'.repeat(64), proof: '0x00', memos: [] }), { ok: false, reverted: true, definite: false, error: 'settle reverts' });
    answer([500]);
    assert.deepEqual(await simulateSettle({}, { publicValues: '0x' + '00'.repeat(64), proof: '0x00', memos: [] }), { ok: false, error: 'the chain could not be read just now; try again' });
    answer([{ result: '0x' }]);
    assert.deepEqual(await simulateSettle({}, { publicValues: '0x' + '00'.repeat(64), proof: '0x00', memos: [] }), { ok: true });
  } finally { globalThis.fetch = realFetch; }
});
