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
import { makeProofPool, turnOf, readWrapStdin, wrapExpect, wrapOpens, proofFits, verifyCalldata, proofPoolConfig, clientOf, PROOF_POOL } from '../worker/src/proof-pool.js';
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
  h.pool = makeProofPool({ kv: h.store, cfg: { ...PROOF_POOL, drawMs: 0, ...cfg }, now: () => h.t, random: () => `lease-${++n}`, verify: async (p) => { h.calls++; return h.verdict(p); } });
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
  assert.equal(proofPoolConfig({ POOL_DRAW_MS: '0' }).drawMs, 0, 'POOL_DRAW_MS=0 puts first-to-ask back');
  assert.equal(proofPoolConfig({ POOL_DRAW_MS: '45000' }).drawMs, 45_000);
  assert.equal(proofPoolConfig({ POOL_DRAW_MS: '-5' }).drawMs, PROOF_POOL.drawMs);
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

test('draw: a miner is offered a young job only once it has waited its turn, however often or from however many places it asks; past the draw, and to Tacit\'s own prover, a job goes to whoever asks', async () => {
  const D = 20_000, h = harness({ cfg: { drawMs: D } });
  const a = wrapJob(0);
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  // two addresses whose turns for this job are well apart, inside the draw
  const addr = (i) => '0x' + i.toString(16).padStart(40, '0');
  const turn = (m) => turnOf(a.id, m, D);
  const pick = Array.from({ length: 200 }, (_, i) => addr(i + 1)).filter((m) => turn(m) > 2000 && turn(m) < D - 2000).sort((x, y) => turn(x) - turn(y));
  const early = pick[0], late = pick[pick.length - 1];
  assert.ok(turn(late) - turn(early) > 4000);
  assert.equal(turnOf(a.id, early.toUpperCase().replace('0X', '0x'), D), turn(early), 'an address is the same address in any case');
  assert.equal(turnOf(a.id, early, 0), 0, 'no draw, no turn');

  for (let i = 0; i < 30; i++) assert.equal((await h.pool.lease({ miner: early, client: `place${i}` })).status, 204, 'asking from thirty places, before its turn, brings nothing');
  h.t += turn(early) - 500;
  assert.equal((await h.pool.lease({ miner: early, client: 'place0' })).status, 204, 'just before its turn');
  h.t += 1000;
  assert.equal((await h.pool.lease({ miner: late, client: 'laggard' })).status, 204, 'the later turn has not come');
  const got = await h.pool.lease({ miner: early, client: 'place0' });
  assert.deepEqual([got.status, got.body.id], [200, a.id], 'the earlier turn takes it');

  // a job that has waited the whole draw is open to any address
  const b = wrapJob(1);
  await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: b.expect, client: 'page2' });
  h.t += D + 1;
  assert.deepEqual([(await h.pool.lease({ miner: late, client: 'laggard' })).status], [200], 'past the draw it goes to whoever asks');

  // a job given back keeps its age, so it is open at once
  h.t += PROOF_POOL.leaseMs + 1;
  const again = await h.pool.lease({ miner: early, client: 'place9' });
  assert.equal(again.status, 200, 'a lease that ran out puts its job back where it was, past its draw');

  // Tacit's own prover is not made to wait for a turn
  const c = wrapJob(2);
  await h.pool.request({ type: 'wrap', stdin: c.stdin, expect: c.expect, client: 'page3' });
  assert.equal((await h.pool.lease({ house: 'box', client: 'house:box' })).status, 200);

  // stats say how long the oldest job has waited and the longest a lease has been out
  const d = wrapJob(3);
  await h.pool.request({ type: 'wrap', stdin: d.stdin, expect: d.expect, client: 'page4' });
  h.t += 90_000;
  const s = (await h.pool.stats()).body;
  assert.equal(s.oldestQueuedSecs, 90);
  assert.ok(s.oldestLeaseSecs >= 90 && s.oldestLeaseSecs <= 90 + 1, `the leases taken a minute and a half ago (${s.oldestLeaseSecs})`);
});

// Twenty addresses ask for each of 150 jobs; one asks every second from three places, the others every five seconds from one. Whoever is
// offered a job proves it at once. With the draw each address takes about its share; without it the one asking fastest takes nearly all.
async function race(drawMs, jobs = 150) {
  const h = harness({ cfg: { drawMs } });
  const miners = Array.from({ length: 20 }, (_, i) => '0x' + (i + 1).toString(16).padStart(2, '0').repeat(20));
  const wins = new Array(20).fill(0);
  for (let j = 0; j < jobs; j++) {
    const w = wrapJob(100 + j);
    await h.pool.request({ type: 'wrap', stdin: w.stdin, expect: w.expect, client: `page${j}` });
    let won = null;
    for (let s = 1; s <= 40 && !won; s++) {
      h.t += 1000;
      for (let i = 0; i < 20 && !won; i++) {
        if (i && (s + i) % 5) continue;
        for (const c of i ? [`c${i}`] : ['f1', 'f2', 'f3']) {
          const r = await h.pool.lease({ miner: miners[i], client: c });
          if (r.status === 200) { won = { i, body: r.body }; break; }
        }
      }
    }
    assert.ok(won, 'every job is taken');
    await h.pool.submit({ id: won.body.id, lease: won.body.lease, publicValues: pvFor(w.expect), proof: PROOF });
    wins[won.i]++;
  }
  return wins;
}
test('draw: asking fast from several places does not win a job; without it the fastest asker takes nearly all', async () => {
  const jobs = 150, drawn = await race(PROOF_POOL.drawMs, jobs), plain = await race(0, jobs);
  const share = (w) => w[0] / jobs, others = (w) => Math.max(...w.slice(1));
  console.log(`# the fast asker's share of ${jobs} jobs: ${(100 * share(drawn)).toFixed(1)}% with the draw (a fair share is 5%, the busiest other takes ${others(drawn)}), ${(100 * share(plain)).toFixed(1)}% without`);
  assert.ok(share(plain) > 0.6, 'first to ask takes nearly everything');
  assert.ok(share(drawn) < 0.2, `with the draw the fast asker takes ${(100 * share(drawn)).toFixed(1)}%`);
  assert.ok(drawn.slice(1).filter((n) => n > 0).length >= 15, 'the jobs are spread over most of the other addresses');
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
  assert.deepEqual({ ...(await h.pool.stats()).body, top: undefined, terms: undefined }, { queued: 1, leased: 1, doneToday: 0, minersToday: 0, done24h: 0, miners24h: 0, oldestQueuedSecs: 120, oldestLeaseSecs: 0, top: undefined, terms: undefined });
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
  assert.deepEqual({ ...s, terms: undefined }, { queued: 0, leased: 0, doneToday: 4, minersToday: 2, done24h: 4, miners24h: 2, oldestQueuedSecs: 0, oldestLeaseSecs: 0, top: [{ miner: MINER, proofs: 3 }, { miner: MINER2, proofs: 1 }], terms: undefined });
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
  const env = { REGISTRY_KV: kv(), POOL_DRAW_MS: '0' };
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
  const h = harness();
  const a = wrapJob(0), b = wrapJob(1);
  await h.pool.request({ type: 'wrap', stdin: a.stdin, expect: a.expect, client: 'page' });
  await h.pool.request({ type: 'wrap', stdin: b.stdin, expect: b.expect, client: 'page' });
  let l = (await h.pool.lease({ miner: MINER, client: 'm1' })).body;
  h.t += 600_000;
  assert.equal((await h.pool.submit({ id: l.id, lease: l.lease, publicValues: pvFor(a.expect), proof: PROOF })).status, 200);
  l = (await h.pool.lease({ house: 'gpu', client: 'h' })).body;
  assert.equal((await h.pool.submit({ id: l.id, lease: l.lease, publicValues: pvFor(b.expect), proof: PROOF })).status, 200);
  const who = await h.pool.minedBy([a.expect.leaf.toUpperCase().replace('0X', '0x'), b.expect.leaf, '0x' + '00'.repeat(32)]);
  assert.deepEqual(who, { [a.expect.leaf.toLowerCase()]: { miner: MINER, points: PROOF_POOL.pointsPerProof }, [b.expect.leaf.toLowerCase()]: { house: true } });
  const feed = (await h.pool.recent()).body.proofs;
  assert.equal(feed.length, 2);
  assert.deepEqual({ house: feed[0].house, points: feed[0].points, miner: feed[0].miner }, { house: true, points: 0, miner: undefined }, 'the house earns nothing and names no address');
  assert.deepEqual({ miner: feed[1].miner, points: feed[1].points, secs: feed[1].secs }, { miner: MINER, points: PROOF_POOL.pointsPerProof, secs: 600 });
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
