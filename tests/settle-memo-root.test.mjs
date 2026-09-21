// The memos a relay submits with a settle must be the ones the proof commits to (worker-relay/src/lib/memo-root.js):
// the memo root in the proof's public values is read from the ABI-encoded struct and compared with the root of the
// memos about to be shipped. Real proof fixtures carry the root over empty memos, one per inserted leaf.
//
// Run: node tests/settle-memo-root.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { memoRootOf, publicValuesMemoRoot, assertMemosMatchProof } = await import(join(ROOT, 'worker-relay/src/lib/memo-root.js'));
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, 'contracts/test/fixtures', `${name}_groth16.json`), 'utf8')).publicValues;

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const empties = (n) => Array(n).fill('0x');
// The struct's memoRoot head word replaced, so a proof can be paired with memos of real length.
const withMemoRoot = (pv, root) => {
  const hex = pv.replace(/^0x/, '');
  const at = (Number(BigInt('0x' + hex.slice(0, 64))) / 32 + 27) * 64;
  return '0x' + hex.slice(0, at) + root.replace(/^0x/, '') + hex.slice(at + 64);
};

await test('the memo root read from real proof public values matches the memos those proofs settle with', () => {
  assert.equal(publicValuesMemoRoot(fixture('unwrap')), memoRootOf([]), 'no leaves: zero root');
  assert.equal(publicValuesMemoRoot(fixture('wrap')), memoRootOf(empties(1)), 'one leaf');
  assert.equal(publicValuesMemoRoot(fixture('wraptransfer')), memoRootOf(empties(2)), 'two leaves');
  assert.equal(publicValuesMemoRoot(fixture('stealthlockbatch')), memoRootOf(empties(3)), 'three lock leaves');
});

await test('the memos the proof commits to pass; a different, reordered, missing or extra memo is refused', () => {
  const memos = ['0x' + 'ab'.repeat(169), '0x' + 'cd'.repeat(169)];
  const pv = withMemoRoot(fixture('wraptransfer'), memoRootOf(memos));
  assertMemosMatchProof(pv, memos);
  assertMemosMatchProof(pv, memos.map((m) => m.slice(2)));
  assert.throws(() => assertMemosMatchProof(pv, ['0x' + 'ab'.repeat(169), '0x' + 'ce'.repeat(169)]), /do not match/);
  assert.throws(() => assertMemosMatchProof(pv, [memos[1], memos[0]]), /do not match/);
  assert.throws(() => assertMemosMatchProof(pv, [memos[0]]), /do not match/);
  assert.throws(() => assertMemosMatchProof(pv, [...memos, '0x']), /do not match/);
});

await test('public values that cannot be read are refused rather than passed through', () => {
  assert.throws(() => assertMemosMatchProof('0x', []), /too short/);
  assert.throws(() => assertMemosMatchProof('0xaa', []), /too short/);
  assert.throws(() => assertMemosMatchProof('0x' + '00'.repeat(31) + '20' + '00'.repeat(64), []), /too short/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
