// lib/memo-order.js: a mixed batch's memos pair with the leaves they were sealed for.
//
// The pool pairs a settle's memo list with the note leaves first, one for one, then the lock leaves; the batch's list is each op's memos in op order. An op that makes locks in
// front of an op that makes notes shifts every memo after it (a stealth send's memo landed on a transfer's note leaf, and the transfer's own memos moved up by one), and the
// pool takes it. This is the rule that keeps that from happening, and the checks that keep the rule true to the guest and to the types the relay batches.
//   node --test worker-relay/tests/memo-order.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { memoSafeOrder, makesNotesOnly, makesLocksOnly } from '../src/lib/memo-order.js';
import { OPEN_TYPES } from '../../worker/src/confidential-settle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const range = (n) => Array.from({ length: n }, (_, i) => i);
// a claimed job: its memos are its notes' and then its locks', each tagged with the leaf it was sealed for
const job = (id, type, notes, locks) => ({ jobId: id, type, notes, locks, memos: [...range(notes).map((i) => `${id}:n${i}`), ...range(locks).map((i) => `${id}:l${i}`)] });
// what the pool does with the list: the first run of memos go to the note leaves in op order, the rest to the lock leaves in op order
const paired = (batch) => {
  const list = batch.flatMap((j) => j.memos);
  const leaves = [...batch.flatMap((j) => range(j.notes).map((i) => `${j.jobId}:n${i}`)), ...batch.flatMap((j) => range(j.locks).map((i) => `${j.jobId}:l${i}`))];
  return list.length === leaves.length && list.every((m, i) => m === leaves[i]);
};
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));

test('the case that happened: a stealth send claimed before a transfer shifted both, and the rule puts the transfer first', () => {
  const lock = job('lock', 'stealthlock', 0, 1), transfer = job('xfer', 'transfer', 2, 0);
  assert.equal(paired([lock, transfer]), false, 'in claim order the memos land on the wrong leaves');
  const { batch, alone } = memoSafeOrder([lock, transfer]);
  assert.deepEqual(batch.map((j) => j.jobId), ['xfer', 'lock']);
  assert.deepEqual(alone, []);
  assert.equal(paired(batch), true);
});

test('every order the ops could be claimed in comes out paired, and no op is lost or doubled', () => {
  const pool = [job('t', 'transfer', 2, 0), job('w', 'wrap', 1, 0), job('s', 'swap', 2, 1), job('l1', 'stealthlock', 0, 1), job('lb', 'stealthlockbatch', 0, 3)];
  for (const order of perms(pool)) {
    const { batch, alone } = memoSafeOrder(order);
    assert.equal(paired(batch), true, order.map((j) => j.jobId).join(','));
    assert.deepEqual([...batch, ...alone].map((j) => j.jobId).sort(), pool.map((j) => j.jobId).sort());
    assert.equal(alone.length, 0, 'one swap and any locks-only ops share a batch');
  }
});

test('a swap makes notes and may make a lock: only one rides, and it comes after every notes-only op and before the locks-only ones', () => {
  const a = job('a', 'swap', 2, 1), b = job('b', 'swap', 2, 1), t = job('t', 'transfer', 2, 0), l = job('l', 'stealthlock', 0, 1);
  const { batch, alone } = memoSafeOrder([l, a, b, t]);
  assert.deepEqual(batch.map((j) => j.jobId), ['t', 'a', 'l']);
  assert.deepEqual(alone.map((j) => j.jobId), ['b'], 'the second swap settles on its own');
  assert.equal(paired(batch), true);
  assert.equal(paired([a, b]), false, 'two swaps with locks in claim order do not pair');
});

test('ops that make notes only keep the order they came in', () => {
  const ids = ['q1', 'q2', 'q3', 'q4'];
  const jobs = [job('q1', 'transfer', 2, 0), job('lock', 'stealthlock', 0, 1), job('q2', 'wrap', 1, 0), job('q3', 'unwrap', 1, 0), job('q4', 'lp', 2, 0)];
  assert.deepEqual(memoSafeOrder(jobs).batch.filter((j) => ids.includes(j.jobId)).map((j) => j.jobId), ids);
});

test('a type the list does not know is treated like a swap: one at most, after the notes', () => {
  const m1 = job('m1', 'mystery', 2, 1), m2 = job('m2', 'other', 2, 1), t = job('t', 'transfer', 2, 0);
  const { batch, alone } = memoSafeOrder([m1, m2, t]);
  assert.deepEqual(batch.map((j) => j.jobId), ['t', 'm1']);
  assert.deepEqual(alone.map((j) => j.jobId), ['m2']);
  assert.equal(paired(batch), true);
});

test('every type the relay batches is classified: notes only, locks only, or the swap', () => {
  for (const t of OPEN_TYPES) {
    const known = makesNotesOnly(t) || makesLocksOnly(t) || t === 'swap';
    assert.ok(known, `${t} is in OPEN_TYPES but memo-order.js does not say whether it makes locks`);
  }
  for (const t of ['stealthlock', 'stealthlockbatch']) assert.ok(makesLocksOnly(t) && !makesNotesOnly(t));
  assert.ok(!makesNotesOnly('swap') && !makesLocksOnly('swap'));
});

test('the guest makes lock leaves in the four ops the rule knows (add a new one to lib/memo-order.js first)', () => {
  const src = readFileSync(path.join(here, '..', '..', 'contracts', 'sp1', 'confidential', 'src', 'main.rs'), 'utf8').split('\n');
  const arms = new Set();
  src.forEach((line, i) => {
    if (!/lock_leaves\.push\(/.test(line)) return;
    for (let k = i; k >= 0; k--) {
      const m = /^\s{8,}(OP_[A-Z_]+(?:\s*\|\s*OP_[A-Z_]+)*)\s*=>\s*\{/.exec(src[k]);
      if (m) { m[1].split('|').forEach((x) => arms.add(x.trim())); break; }
    }
  });
  assert.deepEqual([...arms].sort(), ['OP_ADAPTOR_LOCK', 'OP_BRIDGE_STEALTH_MINT', 'OP_STEALTH_LOCK', 'OP_SWAP'], 'the guest makes lock leaves somewhere new or somewhere less: memo-order.js lists which ops do');
});

test('the relay proves a mixed batch in that order and settles the rest alone', () => {
  const src = readFileSync(path.join(here, '..', 'src', 'settle-relay.js'), 'utf8');
  const a = src.indexOf('async function settleMixed(claimed)'), b = src.indexOf('async function settleMixedBatch(jobs)');
  assert.ok(a > 0 && b > a, 'settleMixed takes the claimed jobs and hands a batch on');
  const body = src.slice(a, b);
  assert.match(body, /memoSafeOrder\(claimed\)/);
  assert.match(body, /settleMixedBatch\(batch\)/);
  assert.match(body, /for \(const j of alone\) await settleOne\(j\)/);
  assert.match(src, /if \(mixedOn\(\)\) return await settleMixed\(jobs\)/);
});
