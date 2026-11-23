// lib/memo-pairing.js: a settle's memos are checked against the leaves the pool will pair them with, before the settle is paid for.
//
// The pool pairs the list by place (the first `leaves.length` memos with the note leaves, the rest with the lock leaves) and takes any order that hashes to the proof's root, so a
// stealth send's memo once landed on a transfer's note leaf. These tests run the check on the real public values of three mainnet settles (one of them the one that went wrong)
// and on built ones, and pin that the relay's settle paths make it.
//   node --test worker-relay/tests/memo-pairing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { settleLeafSets, memoPairingProblem, assertMemoPairing, memoClassOrderProblem } from '../src/lib/memo-pairing.js';
import { memoSafeOrder } from '../src/lib/memo-order.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(readFileSync(path.join(here, 'fixtures', 'memo-pairing.json'), 'utf8'));
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const leaf = (tag) => '0x' + tag.toString(16).padStart(64, '0');
// a memo of `bytes` bytes that is its own: the byte is the tag, so two memos of one size still differ
const memo = (tag, bytes) => '0x' + (tag & 0xff).toString(16).padStart(2, '0').repeat(bytes);
const memos = (shape) => shape.map(([tag, bytes]) => memo(tag, bytes));
// public values with the two arrays the check reads in the places ConfidentialPool.PublicValues puts them (head words 4 and 17, offsets from the struct's start)
function publicValues({ leaves = [], lockLeaves = [] }) {
  const HEAD = 32, words = Array(HEAD).fill(0n), tail = [];
  const put = (field, arr) => { words[field] = BigInt((HEAD + tail.length) * 32); tail.push(BigInt(arr.length), ...arr.map((l) => BigInt(l))); };
  put(4, leaves); put(17, lockLeaves);
  return '0x' + word(32) + [...words, ...tail].map(word).join('');
}
const real = (name) => ({ ...REAL[name], memos: REAL[name].memoBytes.map((b, i) => memo(i + 1, b)) });

test('the public values of three real settles are read as the chain read them', () => {
  for (const name of Object.keys(REAL)) {
    const sets = settleLeafSets(REAL[name].publicValues);
    assert.deepEqual(sets.leaves, REAL[name].leaves, `${name}: note leaves`);
    assert.deepEqual(sets.lockLeaves, REAL[name].lockLeaves, `${name}: lock leaves`);
  }
});

test('the settle that went wrong is refused: its stealth memo sits on note leaf 0 and a note memo on the lock leaf', () => {
  const s = real('shifted');
  assert.deepEqual(s.memoBytes, [322, 169, 169]);
  assert.match(memoPairingProblem(s.publicValues, s.memos), /memo 0 is 322 bytes, a stealth lock's, but the pool will put it on note leaf 0/);
  assert.throws(() => assertMemoPairing(s.publicValues, s.memos), (e) => e.code === 'memo_pairing' && /wrong leaves/.test(e.message));
});

test('the same memos in the order that pairs are taken, and so are two real settles that were right', () => {
  const s = real('shifted');
  assert.equal(memoPairingProblem(s.publicValues, [s.memos[1], s.memos[2], s.memos[0]]), null);
  for (const name of ['inOrder', 'fourNotes']) assert.equal(memoPairingProblem(real(name).publicValues, real(name).memos), null, name);
});

test('an empty memo is right on a note place and on a lock place (a swap\'s cut lock has none), and a note\'s on a note place', () => {
  const pv = publicValues({ leaves: [leaf(1), leaf(2)], lockLeaves: [leaf(3), leaf(4)] });
  assert.equal(memoPairingProblem(pv, memos([[1, 169], [2, 0], [3, 0], [4, 322]])), null);
  assert.equal(memoPairingProblem(pv, memos([[1, 0], [2, 169], [3, 145], [4, 322]])), null);
});

test('the size rule: a stealth-sized memo on a note place, a note-sized one on a lock place, nothing else', () => {
  const pv = publicValues({ leaves: [leaf(1), leaf(2)], lockLeaves: [leaf(3)] });
  assert.match(memoPairingProblem(pv, memos([[1, 169], [2, 145], [3, 322]])), /memo 1 is 145 bytes.*note leaf 1/);
  assert.match(memoPairingProblem(pv, memos([[1, 169], [2, 169], [3, 169]])), /memo 2 is 169 bytes.*lock leaf 0/);
  assert.equal(memoPairingProblem(pv, memos([[1, 169], [2, 169], [3, 33]])), null, 'a size this check has no view on is left to the pool');
});

test('a stealth send claimed ahead of a transfer: the list in claim order is refused, in the order the rule gives it is taken', () => {
  const pv = publicValues({ leaves: [leaf(1), leaf(2)], lockLeaves: [leaf(3)] });
  const lock = [[9, 322]], transfer = [[1, 169], [2, 169]];
  assert.ok(memoPairingProblem(pv, memos([...lock, ...transfer])));
  assert.equal(memoPairingProblem(pv, memos([...transfer, ...lock])), null);
});

test('a job that names its lock leaf must find its own memo at that lock\'s place, even among memos of one size', () => {
  const pv = publicValues({ lockLeaves: [leaf(10), leaf(11), leaf(12)] });
  const m = memos([[1, 322], [2, 322], [3, 322]]);
  const job = (n, type = 'stealthlock', extra = {}) => ({ type, op: { lockLeaf: leaf(10 + n) }, memos: [m[n]], ...extra });
  assert.equal(memoPairingProblem(pv, m, [job(0), job(1), job(2)]), null);
  const swapped = [m[1], m[0], m[2]];
  assert.match(memoPairingProblem(pv, swapped, [job(0), job(1), job(2)]), /stealthlock job's lock 0x0{8}… is lock 0/);
  assert.equal(memoPairingProblem(pv, swapped), null, 'with no job to name its lock, equal-sized memos cannot be told apart');
});

test('a batch of stealth locks is held to its ops\' leaves in the same way', () => {
  const pv = publicValues({ lockLeaves: [leaf(10), leaf(11)] });
  const m = memos([[1, 322], [2, 322]]);
  const batch = { type: 'stealthlockbatch', op: { ops: [{ lockLeaf: leaf(10) }, { lockLeaf: leaf(11) }] }, memos: m };
  assert.equal(memoPairingProblem(pv, m, [batch]), null);
  assert.ok(memoPairingProblem(pv, [m[1], m[0]], [batch]));
});

test('what a job does not declare is not guessed at: no leaf named, a leaf the proof does not hold, a memo count that does not fit', () => {
  const pv = publicValues({ lockLeaves: [leaf(10)] });
  const m = memos([[1, 322]]), other = memos([[7, 322]]);
  assert.equal(memoPairingProblem(pv, other, [{ type: 'stealthlock', op: {}, memos: m }]), null, 'sealed or foreign ops name nothing');
  assert.equal(memoPairingProblem(pv, other, [{ type: 'stealthlock', op: { lockLeaf: leaf(99) }, memos: m }]), null, 'a leaf this proof lacks says nothing about its pairing');
  assert.equal(memoPairingProblem(pv, other, [{ type: 'stealthlock', op: { lockLeaf: leaf(10) }, memos: [...m, ...m] }]), null, 'two memos for one lock is not a shape this reads');
  assert.equal(memoPairingProblem(pv, other, [{ type: 'transfer', op: { lockLeaf: leaf(10) }, memos: m }]), null, 'only the types that make a lock name one');
  assert.ok(memoPairingProblem(pv, other, [{ type: 'stealthlock', op: { lockLeaf: leaf(10) }, memos: m }]), 'named and present, a memo that is not its own is refused');
});

test('public values this does not read are left to the pool, never refused here', () => {
  for (const bad of [null, '', '0x', '0x1234', 'not hex', '0x' + word(32) + word(1), '0x' + word(2 ** 40)]) {
    assert.equal(settleLeafSets(bad), null, String(bad).slice(0, 20));
    assert.equal(memoPairingProblem(bad, memos([[1, 322]])), null);
  }
  const lies = '0x' + word(32) + [...Array(32).fill(0n)].map((x, i) => (i === 4 ? 32n * 32n : x)).map(word).join('') + word(1000000);
  assert.equal(settleLeafSets(lies), null, 'an array longer than the bytes there are');
});

test('the list a batch is proved with: no note-sized memo after a stealth-sized one', () => {
  assert.equal(memoClassOrderProblem(memos([[1, 169], [2, 169], [3, 322]])), null);
  assert.equal(memoClassOrderProblem(memos([[1, 169], [2, 0], [3, 322], [4, 145]])), null, 'a swap\'s cut lock has no memo and sits between');
  assert.equal(memoClassOrderProblem(memos([[1, 322], [2, 322]])), null);
  assert.equal(memoClassOrderProblem([]), null);
  assert.match(memoClassOrderProblem(memos([[3, 322], [1, 169], [2, 169]])), /note's memo \(1\) comes after a stealth lock's \(0\)/);
  assert.match(memoClassOrderProblem(memos([[1, 169], [3, 145], [2, 169]])), /\(2\) comes after.*\(1\)/);
});

test('the real settle that went wrong, as a batch list in claim order, is caught before it is proved', () => {
  assert.ok(memoClassOrderProblem(real('shifted').memos), 'a stealth memo ahead of two note memos');
  assert.equal(memoClassOrderProblem(real('inOrder').memos), null);
  assert.equal(memoClassOrderProblem(real('fourNotes').memos), null);
});

test('the two layers agree: every order the ops are claimed in, the rule\'s batch passes the list check and a raw claim order that puts a lock first does not', () => {
  const kinds = { transfer: [169, 169], wrap: [169], swap: [169, 169, 0], stealthlock: [322], stealthlockbatch: [322, 322, 322] };
  const mk = (type) => ({ type, memos: kinds[type].map((b, i) => memo(i + 1, b)) });
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  const flat = (jobs) => jobs.flatMap((j) => j.memos);
  let caught = 0;
  for (const order of perms(Object.keys(kinds).map(mk))) {
    assert.equal(memoClassOrderProblem(flat(memoSafeOrder(order).batch)), null, order.map((j) => j.type).join(','));
    const lock = (t) => t.startsWith('stealthlock'), notes = (t) => ['transfer', 'wrap', 'swap'].includes(t);
    const lockAheadOfNotes = order.some((j, i) => lock(j.type) && order.slice(i + 1).some((k) => notes(k.type)));
    assert.equal(memoClassOrderProblem(flat(order)) !== null, lockAheadOfNotes, order.map((j) => j.type).join(','));
    if (memoClassOrderProblem(flat(order))) caught++;
  }
  assert.ok(caught > 0, 'raw claim orders with a lock first exist and are caught');
});

// The relay's settle paths make the check: the pin the unit tests above cannot give.
const SRC = readFileSync(path.join(here, '..', 'src', 'settle-relay.js'), 'utf8');
const CODE = SRC.replace(/^\s*\/\/.*$/gm, '');
// a function's source without its comment lines, so a call that was commented out is not a call
const fn = (name) => { const i = SRC.indexOf(`async function ${name}(`); assert.ok(i >= 0, name); const j = SRC.indexOf('\n}\n', i); return SRC.slice(i, j).replace(/^\s*\/\/.*$/gm, ''); };

test('every settle submit makes the pairing check, and the paths that know their jobs hand them over', () => {
  assert.match(fn('submitSettle'), /assertMemosMatchProof\([^)]*\);[^]*assertMemoPairing\(proof\.publicValues, memos, jobs\)/);
  assert.match(fn('submitSettle'), /\{ competitive = false, jobs = \[\] \} = \{\}/);
  assert.match(fn('settleOne'), /submitSettle\(proof, j\.memos \|\| \[\], `job \$\{j\.jobId\}`, \{ jobs: \[j\] \}\)/);
  assert.match(fn('settleMixedBatch'), /submitSettle\(proof, memos, `batch\(\$\{jobs\.length\}\)`, \{ jobs \}\)/);
  assert.match(CODE, /submitSettle\(proof, memos, `batch\(\$\{jobs\.length\}\)`, \{ jobs \}\);\n\s+for \(const id of ids\) await confidentialAck\(\{ jobId: id, txHash, lane: proof\.lane \}\);\n\s+log\(`batch settled:/, 'the transfer batch too');
});

test('a mixed batch whose list is out of order is not proved: its members settle one by one', () => {
  const body = fn('settleMixedBatch');
  const check = body.indexOf('memoClassOrderProblem(memos)'), prove = body.indexOf('proveMixed(');
  assert.ok(check >= 0 && prove > check, 'the memos are read before the proof is asked for');
  assert.match(body.slice(check, prove), /for \(const j of jobs\) await settleOne\(j\);\s+return true;/);
});
