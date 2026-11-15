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
import { makeProofPool, payFactor, payFor, drawOf, readWrapStdin, wrapExpect, wrapOpens, proofFits, verifyCalldata, proofPoolConfig, clientOf, PROOF_POOL } from '../worker/src/proof-pool.js';
import { stdinFor } from '../dapp/sp1-stdin.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import worker, { ethCallVerdict, simulateSettle } from '../worker/src/index.js';

const FIX = new URL('./fixtures/sp1-stdin/', import.meta.url);
const WRAP_OP = JSON.parse(readFileSync(new URL('wrap.op.json', FIX), 'utf8'));
const WRAP_BIN = new Uint8Array(readFileSync(new URL('wrap.bin', FIX)));
const MAINNET = JSON.parse(readFileSync(new URL('./fixtures/proof-pool/mainnet-wrap.json', import.meta.url), 'utf8'));
const hx = (b) => '0x' + bytesToHex(b);

// A wrap's input and what its proof must commit to; `i` makes a different deposit (the value), `memo` a different memo only. Each
// is signed as a page signs it, so it opens.
const KIT = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
function wrapJob(i = 0, memo = null, nonce = 0x77n + BigInt(i)) {
  const value = 1500n + BigInt(i), r = 0x1234n + BigInt(i);
  const { cx, cy } = KIT.commitXY(value, r);
  const dep = KIT.depositId(WRAP_OP.asset, value, cx, cy, WRAP_OP.owner);
  const sig = KIT.openingSigma(value, r, KIT.intentContext('tacit-wrap-intent-v1', WRAP_OP.chainBinding, WRAP_OP.asset, dep, [[cx, cy, WRAP_OP.owner]], [value]), nonce);
  const op = { ...WRAP_OP, value: String(value), cx, cy, sigR: sig.R, sigZ: sig.z, ...(memo ? { memoHashes: [memo] } : {}) };
  const bytes = stdinFor('wrap', op);
  return { stdin: hx(bytes), bytes, expect: wrapExpect(readWrapStdin(bytes)), id: bytesToHex(sha256(bytes)).slice(0, 32) };
}
// abi.encode(PublicValues): the tuple's 31 fields (field k in word 1 + k), the chain binding, the memo root, `leaves` and
// `depositsConsumed`, every other list empty and every other word zero unless `fields` names it (field 2 is spendRoot, 11 bitcoinSpentRoot).
const word = (x) => BigInt(x).toString(16).padStart(64, '0');
const PV_LISTS = new Set([3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 17, 18, 19, 22, 23, 24, 25, 26, 28, 29, 30]);
function pvFor(e, { leaves = [e.leaf], deposits = [e.depositId], chainBinding = e.chainBinding, memoRoot = e.memoRoot, fields = {} } = {}) {
  const head = [], tail = [];
  for (let f = 0; f < 31; f++) {
    if (!PV_LISTS.has(f)) { head.push(word(fields[f] ?? (f === 0 ? 1 : f === 1 ? chainBinding : f === 27 ? memoRoot : 0))); continue; }
    const items = f === 4 ? leaves : f === 5 ? deposits : [];
    head.push(word(32 * (31 + tail.length))); tail.push(word(items.length), ...items.map(word));
  }
  return '0x' + word(32) + head.join('') + tail.join('');
}
const PROOF = '0x' + 'ab'.repeat(260);
const MINER = '0x' + '11'.repeat(20), MINER2 = '0x' + '22'.repeat(20), MINER3 = '0x' + '33'.repeat(20);
const kv = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } }; };
const T0 = Date.UTC(2026, 9, 26, 1), DAY0 = Math.floor(T0 / 86_400_000);

// A pool on a fake KV and clock, with a verifier that answers `verdict` (default: takes every proof) and counts its calls.
function harness({ cfg = {}, verdict = () => ({ ok: true }) } = {}) {
  const h = { t: T0, calls: 0, store: kv(), verdict };
  let n = 0;
  h.pool = makeProofPool({ kv: h.store, cfg: { ...PROOF_POOL, turnMs: 0, ...cfg }, now: () => h.t, random: () => `lease-${++n}`, verify: async (p) => { h.calls++; return h.verdict(p); } });
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
  // The same wrap proved against a root (each one the settle checks against the pool's own), or with a deadline, is not this job's:
  // spendRoot, bitcoinSpentRoot, bitcoinBurnRoot, deadline, lockSetRoot, refundNotBefore, cdpPositionRoot, and the version.
  assert.equal(pvFor(MAINNET.expect), MAINNET.publicValues.toLowerCase(), 'the full encoding is the mainnet proof\'s, word for word');
  for (const f of [2, 11, 12, 15, 16, 20, 21]) assert.equal(proofFits(pvFor(a.expect, { fields: { [f]: '0x' + 'de'.repeat(32) } }), a.expect), false, `field ${f} set`);
  assert.equal(proofFits(pvFor(a.expect, { fields: { 0: 2 } }), a.expect), false, 'another version');
  for (const f of [2, 11, 12, 16, 21]) {
    const pv = MAINNET.publicValues.slice(0, 2 + 64 * (f + 1)) + 'de'.repeat(32) + MAINNET.publicValues.slice(2 + 64 * (f + 2));
    assert.equal(proofFits(pv, e), false, `the mainnet proof's public values with field ${f} changed`);
  }
  // cast calldata "verifyProof(bytes32,bytes,bytes)" 0x006c…e3 0x0102…35 0xabcdef
  assert.equal(verifyCalldata({ vkey: '0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3', publicValues: '0x0102030405060708091011121314151617181920212223242526272829303132333435', proof: '0xabcdef' }),
    '0x41493c60006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000023010203040506070809101112131415161718192021222324252627282930313233343500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003abcdef0000000000000000000000000000000000000000000000000000000000');
});

test('config: the environment sets each number within its bounds, and a bad value keeps the default', () => {
  const c = proofPoolConfig({ POOL_REQ_IP_DAILY: '4', POOL_MAX_PENDING: '10', POOL_LEASE_MS: '600000', POOL_KEEP_MS: 'soon', POINTS_MINE_PER_PROOF: '25', POINTS_MINE_DAILY_CAP: '-1' });
  assert.equal(c.reqPerClientDay, 4); assert.equal(c.maxPending, 10); assert.equal(c.leaseMs, 600_000);
  assert.equal(c.keepMs, PROOF_POOL.keepMs); assert.equal(c.pointsPerProof, 25); assert.equal(c.proofsPerMinerDay, PROOF_POOL.proofsPerMinerDay);
  assert.deepEqual(proofPoolConfig({}), { ...PROOF_POOL });
  assert.equal(proofPoolConfig({ POOL_TURN_MS: '0' }).turnMs, 0, 'POOL_TURN_MS=0 puts first-to-ask back');
  assert.equal(proofPoolConfig({ POOL_TURN_MS: '45000' }).turnMs, 45_000);
  assert.equal(proofPoolConfig({ POOL_TURN_MS: '-5' }).turnMs, PROOF_POOL.turnMs);
  assert.equal(proofPoolConfig({ POOL_HOUSE_TAKEOVER_MS: '0' }).houseTakeoverMs, 0, 'POOL_HOUSE_TAKEOVER_MS=0 turns the takeover off');
  assert.equal(proofPoolConfig({ POOL_HOUSE_TAKEOVER_MS: '900000' }).houseTakeoverMs, 900_000);
  assert.equal(proofPoolConfig({ POOL_HOUSE_TAKEOVER_MS: 'soon' }).houseTakeoverMs, PROOF_POOL.houseTakeoverMs);
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

test('opening: an input opens only as the program checks it; one that does not is refused at the door, and an unmarked queued one is dropped when it comes up', async () => {
  assert.equal(wrapOpens(readWrapStdin(WRAP_BIN)), true, 'a page\'s own wrap opens');
  assert.equal(wrapOpens(readWrapStdin(wrapJob(3).bytes)), true);
  const changed = (patch) => readWrapStdin(stdinFor('wrap', { ...WRAP_OP, ...patch }));
  const plus1 = (x) => '0x' + (BigInt(x) + 1n).toString(16).padStart(64, '0');
  for (const [patch, why] of [
    [{ value: '1501' }, 'another value'], [{ chainBinding: '0x' + '01'.repeat(32) }, 'another chain'], [{ asset: '0x' + '02'.repeat(32) }, 'another asset'],
    [{ owner: '0x' + '03'.repeat(32) }, 'another owner'], [{ sigZ: plus1(WRAP_OP.sigZ) }, 'another z'], [{ sigR: '0x02' + 'ff'.repeat(32) }, 'an R that is no point'],
    [{ cy: plus1(WRAP_OP.cy) }, 'a commitment off the curve'], [{ cx: '0x' + '00'.repeat(32), cy: '0x' + '00'.repeat(32) }, 'no commitment'],
  ]) assert.equal(wrapOpens(changed(patch)), false, why);

  const h = harness();
  const bad = stdinFor('wrap', { ...WRAP_OP, value: '1501' }), badE = wrapExpect(readWrapStdin(bad)), badId = bytesToHex(sha256(bad)).slice(0, 32);
  const r = await h.pool.request({ type: 'wrap', stdin: hx(bad), expect: { depositId: badE.depositId, leaf: badE.leaf }, client: 'c1' });
  assert.deepEqual([r.status, r.body.code], [400, 'bad_opening']);
  assert.equal(await h.store.get(`pp:job:${badId}`), null, 'nothing kept');
  assert.equal((await h.pool.lease({ miner: MINER, client: 'm1' })).status, 204, 'nothing queued');

  // Jobs in the queue without the mark are checked as they come up: one that does not open is dropped and the next leased.
  const old = wrapJob(5);
  await h.store.put(`pp:job:${badId}`, JSON.stringify({ id: badId, type: 'wrap', stdin: hx(bad), expect: badE, status: 'open', postedAt: h.t }));
  await h.store.put(`pp:job:${old.id}`, JSON.stringify({ id: old.id, type: 'wrap', stdin: old.stdin, expect: old.expect, status: 'open', postedAt: h.t }));
  await h.store.put('pp:queue', JSON.stringify([{ id: badId, at: h.t, tries: 0, skip: [] }, { id: old.id, at: h.t + 1, tries: 0, skip: [] }]));
  const l = await h.pool.lease({ miner: MINER, client: 'm1' });
  assert.deepEqual([l.status, l.body.id], [200, old.id], 'the old job that opens is leased');
  assert.equal(await h.store.get(`pp:job:${badId}`), null, 'the one that does not is dropped');
  assert.deepEqual((await h.pool.results([badId])).body.results[badId], { status: 'gone' });
  assert.equal((await h.pool.lease({ miner: MINER2, client: 'm2' })).status, 204, 'and nothing else waits');
  // A job posted through the door is marked, so it is not checked again when it comes up.
  const fresh = wrapJob(6);
  assert.equal((await h.pool.request({ type: 'wrap', stdin: fresh.stdin, expect: fresh.expect, client: 'c2' })).status, 200);
  assert.equal(JSON.parse(await h.store.get(`pp:job:${fresh.id}`)).opens, true);
});

test('turns: a new job is held for the place whose turn it is, however often or under how many addresses the others ask; a holder that is gone stops holding it; Tacit\'s own prover is not held', async () => {
  const T = 30_000, h = harness({ cfg: { turnMs: T } });
  const addr = (i) => '0x' + i.toString(16).padStart(40, '0'), place = (i) => 'place' + i;
  const ask = (i, client = place(i)) => h.pool.lease({ miner: addr(i), client });
  const a = wrapJob(0);
  const turn = (id, i) => drawOf(id, place(i));                                                   // a turn belongs to the place
  const ids = Array.from({ length: 60 }, (_, i) => i + 1);
  const X = ids.slice().sort((p, q) => turn(a.id, p) - turn(a.id, q))[0];                       // the earliest turn for this job
  const Y = ids.slice().sort((p, q) => turn(a.id, q) - turn(a.id, p))[0];                       // a place whose turn is later than X's by a wide margin
  assert.ok(turn(a.id, Y) > turn(a.id, X) + 0.2);
  assert.equal(drawOf(a.id, addr(X)), drawOf(a.id, addr(X).toUpperCase().replace('0X', '0x')), 'an address is the same address in any case');

  await ask(X); await ask(Y);                                    // both are asking before the job comes
  h.t += 1000;
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  for (let s = 0; s < 20; s++) {                                 // Y asks every second, under five different addresses, and is offered nothing
    h.t += 1000;
    const r = await h.pool.lease({ miner: addr(Y + 100 + (s % 5)), client: place(Y) });
    assert.equal(r.status, 204, `second ${s}: it is not Y's place's turn however often or under whatever address Y asks`);
  }
  const got = await ask(X);                                      // X, asking only now, takes it
  assert.deepEqual([got.status, got.body.id], [200, a.id]);

  // a holder that asked once and is gone holds a job only until it stops counting as asking
  const b = wrapJob(1);
  const Z = ids.slice().sort((p, q) => turn(b.id, p) - turn(b.id, q))[0];
  const W = ids.filter((i) => i !== Z && i !== X && i !== Y).sort((p, q) => turn(b.id, q) - turn(b.id, p))[0];
  await ask(Z); await ask(W);
  const asked = h.t;
  h.t += 1000;
  await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: b.expect, client: 'page2' });
  let took = null;
  for (let s = 1; s <= 40 && !took; s++) { h.t += 1000; const r = await ask(W); if (r.status === 200) took = (h.t - asked) / 1000; }
  assert.ok(took > 20 && took <= 32, `W took it ${took} s after Z last asked: held for Z while Z counted, then free`);

  // Tacit's own prover is not held for anyone
  const c = wrapJob(2);
  await ask(Z); await ask(W);
  await h.pool.request({ type: 'wrap', stdin: c.stdin, expect: c.expect, client: 'page3' });
  assert.equal((await h.pool.lease({ house: 'box', client: 'house:box' })).status, 200);

  // a client that handed a job back is not the one it is held for next
  h.t += 2 * T;                                                  // the earlier askers have stopped counting
  const d = wrapJob(3);
  const P = ids.slice().sort((p, q) => turn(d.id, p) - turn(d.id, q))[0];
  const Q = ids.filter((i) => i !== P).sort((p, q) => turn(d.id, q) - turn(d.id, p))[0];
  await ask(P); await ask(Q);
  await h.pool.request({ type: 'wrap', stdin: d.stdin, expect: d.expect, client: 'page4' });
  const first = (await ask(P)).body;
  assert.equal(first.id, d.id);
  assert.equal((await h.pool.submit({ id: d.id, lease: first.lease, error: 'could not prove it' })).status, 200);
  h.t += 1000;
  assert.equal((await ask(P)).status, 204, 'handed back: P is not offered it again');
  assert.equal((await ask(Q)).status, 200, 'and it is held for the next, not for P');

  // a miner that took a job is proving, not asking: the next job is not held for it
  let f = null;
  for (let k = 10; k < 80 && !f; k++) { const w = wrapJob(k); if (turn(w.id, Q) < turn(w.id, P) - 0.1) f = w; }
  assert.ok(f, 'a job Q would be first for');
  await h.pool.request({ type: 'wrap', stdin: f.stdin, expect: f.expect, client: 'page6' });
  assert.equal((await ask(P)).status, 200, 'Q is busy with its job, so P is the one asking');

  // stats say how long the oldest job has waited and the longest a lease has been out
  const e = wrapJob(4);
  await h.pool.request({ type: 'wrap', stdin: e.stdin, expect: e.expect, client: 'page5' });
  h.t += 90_000;
  const s = (await h.pool.stats()).body;
  assert.equal(s.oldestQueuedSecs, 90);
  assert.ok(s.oldestLeaseSecs >= 90, `a lease taken a minute and a half ago (${s.oldestLeaseSecs})`);
});

// Twenty addresses ask for 200 jobs. One asks every second from three places, the others every 5, 10, 20 and 30 seconds, and fifteen every 4.
// Whoever is offered a job proves it at once. First to ask takes everything; with turns each takes about its share and no job waits past turnMs.
async function race(turnMs, jobs = 200) {
  const h = harness({ cfg: { turnMs } });
  const miners = Array.from({ length: 20 }, (_, i) => '0x' + (i + 1).toString(16).padStart(2, '0').repeat(20));
  const cad = (i) => [1, 5, 10, 20, 30][i] ?? 4;
  const asks = async (i, s) => {
    if (s % cad(i)) return null;
    for (const c of i ? [`c${i}`] : ['f1', 'f2', 'f3']) { const r = await h.pool.lease({ miner: miners[i], client: c }); if (r.status === 200) return r.body; }
    return null;
  };
  for (let s = 0; s < 40; s++) { h.t += 1000; for (let i = 0; i < 20; i++) await asks(i, s); }   // everyone has been asking a while
  const wins = new Array(20).fill(0), waited = [];
  for (let j = 0; j < jobs; j++) {
    const w = wrapJob(100 + j);
    await h.pool.request({ type: 'wrap', stdin: w.stdin, expect: w.expect, client: `page${j}` });
    const posted = h.t; let won = null;
    for (let s = 1; s <= 80 && !won; s++) {
      h.t += 1000;
      for (let i = 0; i < 20 && !won; i++) { const body = await asks(i, s + j * 7 + i); if (body) won = { i, body }; }
    }
    assert.ok(won, 'every job is taken');
    waited.push((h.t - posted) / 1000);
    await h.pool.submit({ id: won.body.id, lease: won.body.lease, publicValues: pvFor(w.expect), proof: PROOF });
    wins[won.i]++;
  }
  waited.sort((x, y) => x - y);
  return { wins, share: (i) => wins[i] / jobs, median: waited[waited.length >> 1], max: waited[waited.length - 1] };
}
test('turns: asking fast does not win jobs, a place has the same chance however it asks, and a miner asking every 10 s gets close to its share; no job waits past turnMs', async () => {
  const plain = await race(0), turns = await race(PROOF_POOL.turnMs);
  const pct = (x) => (100 * x).toFixed(1) + '%', rest = turns.wins.slice(5);
  console.log(`# first to ask: the fast asker takes ${pct(plain.share(0))}. With turns (fair share 5%): fast asker from three places ${pct(turns.share(0))}, every 5 s ${pct(turns.share(1))}, 10 s ${pct(turns.share(2))}, 20 s ${pct(turns.share(3))}, 30 s ${pct(turns.share(4))}, the fifteen at 4 s average ${pct(rest.reduce((x, y) => x + y, 0) / 15 / 200)}; a job waits ${turns.median} s at the median and ${turns.max} s at most`);
  assert.ok(plain.share(0) > 0.9, 'first to ask takes nearly everything');
  assert.ok(turns.share(0) < 0.22, `the fast asker, with three places and so three draws, takes ${pct(turns.share(0))} (three places in twenty-two, about 14%)`);
  assert.ok(turns.share(2) > 0.025 && turns.share(1) > 0.035, 'a miner asking every 5 or 10 s gets at least half its share');
  assert.ok(turns.wins.every((n) => n > 0), 'every address wins some');
  assert.ok(rest.every((n) => n / 200 > 0.02 && n / 200 < 0.09), 'the fifteen alike take alike');
  assert.ok(turns.median <= 5 && turns.max <= 31, `jobs wait ${turns.median} s at the median, ${turns.max} s at most`);
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
  assert.deepEqual({ ...(await h.pool.stats()).body, top: undefined, terms: undefined }, { queued: 1, leased: 1, doneToday: 0, minersToday: 0, done24h: 0, miners24h: 0, oldestQueuedSecs: 120, oldestLeaseSecs: 0, lapsedToday: 4, lapsedPlacesToday: 4, top: undefined, terms: undefined });
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
  assert.deepEqual({ ...s, terms: undefined }, { queued: 0, leased: 0, doneToday: 4, minersToday: 2, done24h: 4, miners24h: 2, oldestQueuedSecs: 0, oldestLeaseSecs: 0, lapsedToday: 0, lapsedPlacesToday: 0, top: [{ miner: MINER, proofs: 3 }, { miner: MINER2, proofs: 1 }], terms: undefined });
  assert.deepEqual(s.terms, { pointsPerProof: 20, proofsPerMinerDay: 2, leaseMs: PROOF_POOL.leaseMs, pay: { fullSecs: 60, floorSecs: 600, floorPct: 50 }, takeoverSecs: PROOF_POOL.houseTakeoverMs / 1000 });
  assert.equal(JSON.stringify(s).includes(jobs[0].stdin.slice(2, 40)), false, 'no inputs');
  let c = (await h.pool.credits(DAY0)).body;
  assert.deepEqual(c, { day: DAY0, over: false, pointsPerProof: 20, miners: [{ miner: MINER, proofs: 3, points: 40 }, { miner: MINER2, proofs: 1, points: 20 }] });
  assert.equal((await h.pool.credits(DAY0 + 1)).status, 400, 'not a day yet');
  h.t += 86_400_000;
  c = (await h.pool.credits(DAY0)).body;
  assert.equal(c.over, true);
  assert.deepEqual((await h.pool.credits(DAY0 + 1)).body.miners, []);
  assert.equal((await h.pool.stats()).body.doneToday, 0, 'a new day');
  assert.equal((await h.pool.stats()).body.done24h, 0, 'and a day after, nothing in the last 24 hours either');
  h.t -= 30 * 60_000; // 00:30 the next day: the proofs were made at 01:00 the day before
  const s2 = (await h.pool.stats()).body;
  assert.ok(s2.doneToday === 0 && s2.done24h === 4 && s2.miners24h === 2, `past midnight the day is new, the last 24 hours still hold the proofs (${s2.doneToday} ${s2.done24h})`);
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

test('hold: while a page is about to ask for a proof, Tacit\'s own provers lease nothing (miners still do); holds that run on unbroken past the cap are not extended', async () => {
  const h = harness({ cfg: { holdMs: 45_000, holdMaxMs: 120_000 } });
  const a = wrapJob(0), b = wrapJob(1);
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: b.expect, client: 'page' });
  assert.equal((await h.pool.hold()).body.until, T0 + 45_000);
  assert.equal((await h.pool.lease({ client: 'house:a5000', house: 'a5000' })).status, 204, 'held: the GPU stays free for the page');
  assert.equal((await h.pool.lease({ client: 'm1', miner: MINER })).body.id, a.id, 'a miner still leases');
  h.t += 46_000;
  assert.equal((await h.pool.lease({ client: 'house:a5000', house: 'a5000' })).body.id, b.id, 'the hold lapsed: the house takes work again');
  // a page asking without end: extended while the run is under the cap, then left to lapse
  h.t += 60_000;
  const start = h.t;
  for (let i = 0; i < 4; i++) { await h.pool.hold(); h.t += 30_000; }
  assert.equal(h.t - start, 120_000);
  assert.equal((await h.pool.hold()).body.until, start + 90_000 + 45_000, 'past the cap the hold is not extended');
  h.t = start + 90_000 + 45_000 + 1;
  assert.equal((await h.pool.hold()).body.until, h.t + 45_000, 'once it lapsed, a new run starts');
  const off = harness({ cfg: { holdMs: 0 } });
  assert.equal((await off.pool.hold()).body.until, 0, 'POOL_HOLD_MS=0 turns holds off');
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
  const env = { REGISTRY_KV: kv(), POOL_TURN_MS: '0' };
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

test('a pool proof names who made the leaf it inserts and joins the recent feed: a community miner by address, Tacit\'s own GPU as the house', async () => {
  const h = harness(), HALF = PROOF_POOL.pointsPerProof / 2; // the proof comes back ten minutes after its lease: the floor of the pay
  const a = wrapJob(0), b = wrapJob(1);
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: b.expect, client: 'page' });
  let l = (await h.pool.lease({ miner: MINER, client: 'm1' })).body;
  h.t += 600_000;
  assert.equal((await h.pool.submit({ id: l.id, lease: l.lease, publicValues: pvFor(a.expect), proof: PROOF })).status, 200);
  l = (await h.pool.lease({ house: 'gpu', client: 'h' })).body;
  assert.equal((await h.pool.submit({ id: l.id, lease: l.lease, publicValues: pvFor(b.expect), proof: PROOF })).status, 200);
  const who = await h.pool.minedBy([a.expect.leaf.toUpperCase().replace('0X', '0x'), b.expect.leaf, '0x' + '00'.repeat(32)]);
  assert.deepEqual(who, { [a.expect.leaf.toLowerCase()]: { miner: MINER, points: HALF }, [b.expect.leaf.toLowerCase()]: { house: true } });
  const feed = (await h.pool.recent()).body.proofs;
  assert.equal(feed.length, 2);
  assert.deepEqual({ house: feed[0].house, points: feed[0].points, miner: feed[0].miner }, { house: true, points: 0, miner: undefined }, 'the house earns nothing and names no address');
  assert.deepEqual({ miner: feed[1].miner, points: feed[1].points, secs: feed[1].secs }, { miner: MINER, points: HALF, secs: 600 });
  assert.equal((await h.pool.stats()).body.top.length, 1, 'the house is never on the leaderboard');
});

test('a note is paid for once: its input posted again with another signature is a new job the same proof answers, and earns nothing', async () => {
  const h = harness();
  const a = wrapJob(0);
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  let l = (await h.pool.lease({ miner: MINER, client: 'm1' })).body;
  assert.equal((await h.pool.submit({ id: l.id, lease: l.lease, publicValues: pvFor(a.expect), proof: PROOF })).body.points, PROOF_POOL.pointsPerProof);
  // the same wrap signed again with another nonce: a different input, the same leaf and deposit
  const b = wrapJob(0, null, 0x99n);
  assert.notEqual(b.stdin, a.stdin);
  assert.deepEqual(b.expect, a.expect, 'the check reads the same leaf, deposit, chain and memos');
  assert.equal((await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: b.expect, client: 'page2' })).status, 200);
  l = (await h.pool.lease({ miner: MINER2, client: 'm2' })).body;
  assert.notEqual(l.id, a.id, 'a new job');
  const r = await h.pool.submit({ id: l.id, lease: l.lease, publicValues: pvFor(a.expect), proof: PROOF });
  assert.deepEqual([r.status, r.body.points], [200, 0], 'kept for the page, paid nothing');
  assert.deepEqual(await h.pool.minedBy([a.expect.leaf]), { [a.expect.leaf.toLowerCase()]: { miner: MINER, points: PROOF_POOL.pointsPerProof } }, 'the first prover stays named');
  assert.equal((await h.pool.recent()).body.proofs.length, 1, 'and the feed shows the one proof');
});

test('leases a client lets run out or hands back count against it for the day; Tacit\'s own provers are not counted', async () => {
  const h = harness({ cfg: { lapsesPerDay: 3 } });
  for (let i = 0; i < 6; i++) { const j = wrapJob(10 + i); await h.pool.request({ type: 'wrap', stdin: j.stdin, expect: j.expect, client: 'page' + i }); }
  // two hand-backs and one lease left to run out, from one place under three addresses
  let l = (await h.pool.lease({ miner: MINER, client: 'm1' })).body;
  await h.pool.submit({ id: l.id, lease: l.lease, error: 'cannot' });
  l = (await h.pool.lease({ miner: MINER2, client: 'm1' })).body;
  await h.pool.submit({ id: l.id, lease: l.lease, error: 'cannot' });
  await h.pool.lease({ miner: MINER3, client: 'm1' });
  h.t += PROOF_POOL.leaseMs + 1;
  const r = await h.pool.lease({ miner: MINER, client: 'm1' });
  assert.deepEqual([r.status, r.body.code], [403, 'lapsed_out']);
  assert.equal((await h.pool.lease({ miner: MINER, client: 'm2' })).status, 200, 'the address leases from elsewhere: only the place is held to it');
  // the house hands back as often as it needs
  for (let i = 0; i < 4; i++) { const x = (await h.pool.lease({ house: 'gpu', client: 'h' })).body; if (!x?.lease) break; await h.pool.submit({ id: x.id, lease: x.lease, error: 'busy' }); }
  assert.notEqual((await h.pool.lease({ house: 'gpu', client: 'h' })).status, 403);
});

// A turn for a job is its place's draw. Holding a lease without proving it makes the job wait out the whole lease (45 minutes),
// and a job that old used to go to whoever asked first, in the very second the lease ran out, which the one that sat on it knows: it could then have it for itself.
const turnRig = (cfg = {}) => {
  const T = 30_000, h = harness({ cfg: { turnMs: T, ...cfg } });
  const addr = (i) => '0x' + i.toString(16).padStart(40, '0'), place = (i) => 'place' + i;
  const ask = (i, client = place(i)) => h.pool.lease({ miner: addr(i), client });
  const ids = Array.from({ length: 60 }, (_, i) => i + 1);
  const order = (job) => ids.slice().sort((p, q) => drawOf(job.id, place(p)) - drawOf(job.id, place(q)));
  return { T, h, addr, place, ask, ids, order };
};

// Thirty honest askers (one address, one place each) and a swarm that asks under every (wallet, place) pair it has. Each job is posted with everyone asking; whoever
// is offered it proves it at once. The share the swarm takes is what the turn rule gives it.
async function swarmShare(wallets, places, jobs = 120) {
  const h = harness({ cfg: { turnMs: PROOF_POOL.turnMs } });
  const hex = (n) => '0x' + n.toString(16).padStart(40, '0');
  const askers = Array.from({ length: 30 }, (_, i) => ({ miner: hex(i + 1), client: `honest${i}`, swarm: false }));
  for (let w = 0; w < wallets; w++) for (let p = 0; p < places; p++) askers.push({ miner: hex(1000 + w), client: `swarm${p}`, swarm: true });
  let won = 0;
  for (let j = 0; j < jobs; j++) {
    h.t += 2000;
    for (const a of askers) await h.pool.lease({ miner: a.miner, client: a.client });
    const w = wrapJob(300 + j);
    await h.pool.request({ type: 'wrap', stdin: w.stdin, expect: w.expect, client: `page${j}` });
    h.t += 1000;
    let took = null;
    for (const a of askers) { const r = await h.pool.lease({ miner: a.miner, client: a.client }); if (r.status === 200) { took = { a, body: r.body }; break; } }
    assert.ok(took, 'every job is taken');
    if (took.a.swarm) won++;
    await h.pool.submit({ id: took.body.id, lease: took.body.lease, publicValues: pvFor(w.expect), proof: PROOF });
  }
  return won / jobs;
}
test('turns: wallets add no turns, a swarm gains only by places (equally for every place), and the same swarm held to the older pair rule would have taken most jobs', async () => {
  const one = await swarmShare(1, 1), wallets = await swarmShare(10, 1), places = await swarmShare(1, 10), grid = await swarmShare(10, 10);
  const pct = (x) => (100 * x).toFixed(0) + '%';
  console.log(`# against 30 honest places: 1 wallet at 1 place ${pct(one)} (fair 3%), 10 wallets at 1 place ${pct(wallets)}, 1 wallet at 10 places ${pct(places)}, 10 wallets x 10 places ${pct(grid)} (ten places in forty, 25%; the old pair rule gave this swarm about 60%)`);
  assert.ok(wallets < 0.1, `ten wallets at one place take ${pct(wallets)}: one place has one turn`);
  assert.ok(grid < 0.4, `ten wallets over ten places take ${pct(grid)}: ten places, and the wallets add nothing`);
  assert.ok(Math.abs(grid - places) < 0.15, `the wallets change nothing: ${pct(grid)} with ten, ${pct(places)} with one`);
  assert.ok(places > one * 2, `ten places do take more than one (${pct(places)} against ${pct(one)}): a place is the scarce thing`);
});

test('turns: a lease that runs out puts its job back for a fresh turn, not for whoever asks first; the place that sat on it is not the one it is held for', async () => {
  const { T, h, ask, order } = turnRig();
  const a = wrapJob(0);
  const o = order(a), X = o[0], Z = o[1], W = o[o.length - 1];          // X sits on the lease; Z has the next best turn; W the worst
  await ask(X); await ask(Z); await ask(W);
  h.t += 1000;
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  h.t += 1000;
  const first = await ask(X);
  assert.deepEqual([first.status, first.body.id], [200, a.id], 'X, whose turn it is, takes the job and sits on it');
  h.t += PROOF_POOL.leaseMs - 5000;
  await ask(Z); await ask(W);                                           // both are asking as the lease runs out
  h.t += 5000;                                                          // the second it ends
  assert.equal((await ask(W)).status, 204, 'W, asking in that very second, is not given the job: it is old, but it goes by turn again');
  const got = await ask(Z);
  assert.deepEqual([got.status, got.body.id], [200, a.id], 'Z, whose turn it is, has it');
  assert.equal((await ask(X)).status, 204, 'and X, which sat on it, is not offered it again');
  assert.equal((await h.pool.stats()).body.lapsedToday, 1);
});

test('turns: a place that let a lease run out is last in line for the rest of the day, and picks up only what nobody else is asking for', async () => {
  const { T, h, ask, order, ids } = turnRig({ lapsesPerDay: 4 });
  const j0 = wrapJob(20), d = wrapJob(21), e = wrapJob(22);
  const o = order(d), P = o[0], Q = o[1], R = ids.filter((i) => i !== P && i !== Q)[0];    // P has the earliest turn for d, Q the next
  // P takes a job and hands it back; R takes it from there and proves it
  await ask(P);
  await h.pool.request({ type: 'wrap', stdin: j0.stdin, expect: j0.expect, client: 'pageA' });
  h.t += 1000;
  const l0 = (await ask(P)).body;
  assert.equal(l0.id, j0.id);
  await h.pool.submit({ id: l0.id, lease: l0.lease, error: 'cannot' });
  const r0 = await ask(R);
  assert.equal(r0.status, 200);
  assert.equal((await h.pool.submit({ id: r0.body.id, lease: r0.body.lease, publicValues: pvFor(j0.expect), proof: PROOF })).status, 200);
  const st = (await h.pool.stats()).body;
  assert.deepEqual([st.lapsedToday, st.lapsedPlacesToday], [1, 1], 'one lapse, from one place');
  // for d, P's own draw is the earlier, but P let a lease run out today: Q is the one it is held for
  h.t += 2 * T;
  await ask(P); await ask(Q);
  await h.pool.request({ type: 'wrap', stdin: d.stdin, expect: d.expect, client: 'pageB' });
  h.t += 1000;
  assert.equal((await ask(P)).status, 204, 'P is behind every place that has kept its leases');
  const q = await ask(Q);
  assert.deepEqual([q.status, q.body.id], [200, d.id], 'Q has it, though its draw was later');
  // with nobody else asking, P still gets what is there: it is behind the others, not shut out
  h.t += 2 * T;
  await ask(P);
  await h.pool.request({ type: 'wrap', stdin: e.stdin, expect: e.expect, client: 'pageC' });
  h.t += 1000;
  const p = await ask(P);
  assert.deepEqual([p.status, p.body.id], [200, e.id], 'alone, P takes the next job');
});

test('pay: a proof earns in full within a minute and less the longer it took, down to half at ten minutes, so a laptop still earns', () => {
  const c = { ...PROOF_POOL };
  assert.deepEqual([0, 8, 60].map((s) => payFactor(s, c)), [1, 1, 1], 'full up to payFullSecs');
  assert.equal(payFactor(330, c), 0.75, 'a straight line between');
  assert.deepEqual([600, 900, 86_400].map((s) => payFactor(s, c)), [0.5, 0.5, 0.5], 'half at the floor and beyond: a 15-minute laptop still earns');
  assert.deepEqual([8, 90, 270, 480, 900].map((s) => payFor(s, c)), [20, 19, 16, 12, 10]);
  assert.equal(payFor(500, { ...c, pointsPerProof: 1 }), 1, 'at least a point while any are paid');
  assert.equal(payFor(500, { ...c, pointsPerProof: 0 }), 0, 'nothing when nothing is paid');
  assert.equal(payFor(900, { ...c, payFloorPct: 100 }), 20, 'a floor of 100 pays every proof the same');
  assert.equal(payFor(900, { ...c, payFloorSecs: 60 }), 20, 'a floor no later than the full time is no slope');
  assert.equal(payFor(900, { ...c, payFullSecs: 700, payFloorSecs: 600 }), 20);
  assert.equal(payFor(Number.NaN, c), 20, 'an unreadable time is not held against a proof');
});

test('pay: a job that came back is paid by its age from the page\'s request, not from the lease that proved it; one on its first lease is timed from the lease', async () => {
  const h = harness({ cfg: { pointsPerProof: 20 } });
  const [a, b, c] = [50, 51, 52].map((i) => wrapJob(i));
  const post = (j, k) => h.pool.request({ type: 'wrap', stdin: j.stdin, expect: j.expect, client: `pg${k}` });
  const proof = (l, j) => h.pool.submit({ id: l.id, lease: l.lease, publicValues: pvFor(j.expect), proof: PROOF });
  // handed back after 400 s, then proved in 8 s by another: the page has waited 408 s
  await post(a, 1);
  let l = (await h.pool.lease({ miner: MINER, client: 'm1' })).body;
  h.t += 400_000;
  await h.pool.submit({ id: l.id, lease: l.lease, error: 'cannot' });
  l = (await h.pool.lease({ miner: MINER2, client: 'm2' })).body;
  h.t += 8_000;
  const r1 = (await proof(l, a)).body;
  assert.equal(r1.points, payFor(408, PROOF_POOL), `408 s of the page's wait, not 8 s of the proof (${r1.points})`);
  assert.ok(r1.points < 20 && r1.points > 10);
  // a lease that ran out: the retaker of a job that waited the whole lease is paid at the floor for a proof it made in 8 s
  await post(b, 2);
  l = (await h.pool.lease({ miner: MINER, client: 'm3' })).body;
  h.t += PROOF_POOL.leaseMs + 1;
  l = (await h.pool.lease({ miner: MINER3, client: 'm4' })).body;
  assert.equal(l.id, b.id);
  h.t += 8_000;
  assert.equal((await proof(l, b)).body.points, Math.round(20 * PROOF_POOL.payFloorPct / 100), 'at the floor');
  // a job on its first lease that merely waited for someone to ask is timed from the lease
  await post(c, 3);
  h.t += 1000_000;
  l = (await h.pool.lease({ miner: MINER, client: 'm5' })).body;
  h.t += 8_000;
  assert.equal((await proof(l, c)).body.points, 20, 'nobody had come for it: no fault of the miner that did');
  const feed = (await h.pool.recent()).body.proofs;
  assert.deepEqual(feed.map((e) => [e.secs, e.points, e.waited]), [[8, 20, undefined], [8, 10, PROOF_POOL.leaseMs / 1000 + 8], [8, 14, 408]], 'the feed (newest first) keeps how long the proof took, and says how long the page had waited when that was more');
});

test('house: Tacit\'s own prover takes over a lease held past the takeover time and proves it; the miner\'s late proof is not taken, its place counts a lapse, and the house earns nothing', async () => {
  const h = harness(), TAKE = PROOF_POOL.houseTakeoverMs;
  const [a, b, c] = [60, 61, 62].map((i) => wrapJob(i));
  const post = (j, k) => h.pool.request({ type: 'wrap', stdin: j.stdin, expect: j.expect, client: `pg${k}` });
  const house = () => h.pool.lease({ house: 'gpu', client: 'house:gpu' });
  const proof = (id, lease, j) => h.pool.submit({ id, lease, publicValues: pvFor(j.expect), proof: PROOF });
  await post(a, 1);
  const l = (await h.pool.lease({ miner: MINER, client: 'm1' })).body;
  assert.equal(l.id, a.id);
  h.t += TAKE - 1000;
  assert.equal((await house()).status, 204, 'a lease that has not been held the takeover time is the miner\'s');
  h.t += 1000;
  const x = await house();
  assert.deepEqual([x.status, x.body.id, x.body.points, x.body.stdin], [200, a.id, 0, a.stdin], 'the house takes it over');
  assert.equal((await house()).status, 429, 'one lease at a time for the house too');
  const late = await proof(a.id, l.lease, a);
  assert.deepEqual([late.status, late.body.code], [409, 'no_lease'], 'the miner\'s late proof is not taken');
  assert.equal((await h.pool.stats()).body.lapsedToday, 1, 'counted against the place that held it');
  h.t += 60_000;
  const done = await proof(a.id, x.body.lease, a);
  assert.deepEqual([done.status, done.body.points], [200, 0]);
  assert.equal((await h.pool.results([a.id])).body.results[a.id].status, 'done', 'the page has its proof');
  assert.deepEqual((await h.pool.credits(DAY0)).body.miners, [], 'in no tally');
  assert.equal((await h.pool.recent()).body.proofs.at(-1).house, true);
  // a job that is waiting is taken before any takeover; the house never takes over its own lease or a miner's that is young
  await post(b, 2);
  await h.pool.lease({ miner: MINER2, client: 'm2' });
  h.t += TAKE;
  await post(c, 3);
  const y = await house();
  assert.equal(y.body.id, c.id, 'the queued job first');
  assert.equal((await proof(c.id, y.body.lease, c)).status, 200);
  const z = await house();
  assert.equal(z.body.id, b.id, 'then the miner\'s old lease');
  assert.equal((await h.pool.stats()).body.lapsedToday, 2);
  assert.equal((await h.pool.stats()).body.terms.takeoverSecs, TAKE / 1000);
  // off at 0: the lease runs its whole time
  const off = harness({ cfg: { houseTakeoverMs: 0 } });
  await off.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'pgx' });
  await off.pool.lease({ miner: MINER, client: 'm1' });
  off.t += TAKE + 60_000;
  assert.equal((await off.pool.lease({ house: 'gpu', client: 'house:gpu' })).status, 204);
});

test('pay config: each term is read within its bounds, and a bad one keeps the default', () => {
  const c = proofPoolConfig({ POOL_PAY_FULL_SECS: '30', POOL_PAY_FLOOR_SECS: '300', POOL_PAY_FLOOR_PCT: '40' });
  assert.deepEqual([c.payFullSecs, c.payFloorSecs, c.payFloorPct], [30, 300, 40]);
  const d = proofPoolConfig({ POOL_PAY_FULL_SECS: 'fast', POOL_PAY_FLOOR_SECS: '0', POOL_PAY_FLOOR_PCT: '5' });
  assert.deepEqual([d.payFullSecs, d.payFloorSecs, d.payFloorPct], [60, 600, 50], 'a floor under 10% is not read: nobody is paid next to nothing by a typo');
  assert.equal(proofPoolConfig({ POOL_PAY_FLOOR_PCT: '100' }).payFloorPct, 100, 'flat pay is one setting away');
});

test('pay: the points a proof earns follow the time from its lease; the tally, the feed and the answer agree, and the lease still says the most', async () => {
  const h = harness({ cfg: { pointsPerProof: 20 } });
  const jobs = [0, 1, 2, 3].map((i) => wrapJob(i));
  for (const j of jobs) await h.pool.request({ type: 'wrap', stdin: j.stdin, expect: j.expect, client: `page${j.id}` });
  const prove = async (miner, client, secs) => {
    const l = (await h.pool.lease({ miner, client })).body;
    h.t += secs * 1000;
    const j = jobs.find((x) => x.id === l.id);
    return { lease: l, r: (await h.pool.submit({ id: l.id, lease: l.lease, publicValues: pvFor(j.expect), proof: PROOF })).body };
  };
  const fast = await prove(MINER, 'm1', 8);
  const mid = await prove(MINER2, 'm2', 330);
  const slow = await prove(MINER2, 'm2', 900);
  assert.deepEqual([fast.r.points, mid.r.points, slow.r.points], [20, 15, 10]);
  assert.deepEqual([fast.lease.points, mid.lease.points, slow.lease.points], [20, 20, 20], 'the lease names the most a proof can earn');
  const c = (await h.pool.credits(DAY0)).body;
  assert.deepEqual(c.miners.map((m) => [m.miner, m.proofs, m.points]).sort(), [[MINER, 1, 20], [MINER2, 2, 25]].sort());
  const feed = (await h.pool.recent()).body.proofs;
  assert.deepEqual(feed.map((e) => [e.secs, e.points]), [[900, 10], [330, 15], [8, 20]], 'the feed shows what each earned and how long it took');
});
