// A community proof for a public board job (src/lib/board-check.js): taken only when its public values consume exactly the job's deposits, so a
// racer cannot answer a user's wrap with a proof of its own wrap carrying the same memos.
// Run: node --test tests/board-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pvDeposits, consumesJobDeposits, wrapExpectation, judgeNodeposit } from '../src/lib/board-check.js';
import { stdinFor } from '../src/lib/spn/sp1-stdin.js';

const word = (x) => BigInt(x).toString(16).padStart(64, '0');
// abi.encode(PublicValues) as far as these read it: the head (word 6 the offset of depositsConsumed, word 5 of leaves) and the two lists.
function pv({ leaves = ['0x' + '11'.repeat(32)], deposits = ['0x' + 'aa'.repeat(32)] } = {}) {
  const head = Array.from({ length: 32 }, () => word(0)), tail = [];
  head[0] = word(32);
  head[5] = word(31 * 32); tail.push(word(leaves.length), ...leaves.map((x) => x.slice(2)));
  head[6] = word((31 + tail.length) * 32); tail.push(word(deposits.length), ...deposits.map((x) => x.slice(2)));
  return '0x' + head.join('') + tail.join('');
}
const USER = '0x' + 'aa'.repeat(32), OTHER = '0x' + 'bb'.repeat(32);

test('the deposits a settle consumes are read from its public values', () => {
  assert.deepEqual(pvDeposits(pv()), [USER]);
  assert.deepEqual(pvDeposits(pv({ deposits: [USER, OTHER] })), [USER, OTHER]);
  assert.deepEqual(pvDeposits(pv({ deposits: [] })), []);
  assert.equal(pvDeposits('0x1234'), null);
  assert.equal(pvDeposits('nope'), null);
});

test('a community proof must consume exactly the job\'s deposits', () => {
  assert.equal(consumesJobDeposits(pv(), [USER]), true);
  assert.equal(consumesJobDeposits(pv({ deposits: [OTHER] }), [USER]), false, 'its own deposit with the user\'s memos');
  assert.equal(consumesJobDeposits(pv({ deposits: [USER, OTHER] }), [USER]), false, 'one more than the job\'s');
  assert.equal(consumesJobDeposits(pv({ deposits: [] }), [USER]), false, 'none');
  assert.equal(consumesJobDeposits(pv(), []), false, 'a job whose deposits are not known takes no community proof');
  assert.equal(consumesJobDeposits(pv({ deposits: [USER.toUpperCase().replace('0X', '0x')] }), [USER]), true, 'case does not matter');
});

test('on a real mainnet wrap proof, the deposit read is the one its op consumed', async () => {
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('../../tests/fixtures/proof-pool/mainnet-wrap.json', import.meta.url), 'utf8'));
  assert.deepEqual(pvDeposits(fx.publicValues), [fx.expect.depositId.toLowerCase()]);
  assert.equal(consumesJobDeposits(fx.publicValues, [fx.expect.depositId]), true);
});

// ---- a wrap proved before its deposit: judged by the verifier, so a community proof can win the race when it is the job's own
const WRAP_OP = JSON.parse(readFileSync(new URL('../../tests/fixtures/sp1-stdin/wrap.op.json', import.meta.url), 'utf8'));
const STDIN = stdinFor('wrap', WRAP_OP);
const EXPECT = wrapExpectation('wrap', STDIN);
// abi.encode(PublicValues) as far as a wrap's fit is read: chain binding (word 2), the leaves and deposits lists, the memo root (word 28).
function pvFor(e, { leaves = [e.leaf], deposits = [e.depositId], chainBinding = e.chainBinding, memoRoot = e.memoRoot } = {}) {
  const head = Array.from({ length: 32 }, () => word(0)), tail = [];
  head[0] = word(32); head[1] = word(1); head[2] = chainBinding.slice(2); head[28] = memoRoot.slice(2);
  head[5] = word(31 * 32); tail.push(word(leaves.length), ...leaves.map((x) => x.slice(2)));
  head[6] = word((31 + tail.length) * 32); tail.push(word(deposits.length), ...deposits.map((x) => x.slice(2)));
  return '0x' + head.join('') + tail.join('');
}
const verifier = (answer) => { const calls = []; const verify = async (a) => { calls.push(a); return answer; }; verify.calls = calls; return verify; };

test('a plain wrap\'s input gives what its proof must commit to; any other op, and an input that cannot be read, give nothing', () => {
  assert.ok(EXPECT && /^0x[0-9a-f]{64}$/.test(EXPECT.depositId) && /^0x[0-9a-f]{64}$/.test(EXPECT.leaf) && /^0x[0-9a-f]{64}$/.test(EXPECT.chainBinding) && /^0x[0-9a-f]{64}$/.test(EXPECT.memoRoot));
  assert.equal(wrapExpectation('wrapswap', STDIN), null);
  assert.equal(wrapExpectation('wraptransfer', STDIN), null);
  assert.equal(wrapExpectation('wrap', new Uint8Array([1, 2, 3])), null);
  assert.equal(wrapExpectation('wrap', STDIN.subarray(0, STDIN.length - 1)), null);
});

test('Tacit\'s own worker\'s proof made before its deposit is judged by the verifier alone', async () => {
  for (const answer of [true, 'unchecked', false]) {
    const verify = verifier(answer);
    assert.equal(await judgeNodeposit({ community: false, publicValues: pvFor(EXPECT, { deposits: ['0x' + 'ee'.repeat(32)] }), proof: '0xab', want: [EXPECT.depositId], expect: EXPECT, verify }), answer);
    assert.equal(verify.calls.length, 1);
  }
});

test('a community proof that is the job\'s own and that the verifier takes wins: the race for a prove-first wrap is a real one', async () => {
  const verify = verifier(true);
  assert.equal(await judgeNodeposit({ community: true, publicValues: pvFor(EXPECT), proof: '0xab', want: [EXPECT.depositId], expect: EXPECT, verify }), true);
  assert.deepEqual(verify.calls, [{ publicValues: pvFor(EXPECT), proof: '0xab' }]);
});

test('a community proof the verifier refuses, or cannot judge, is not taken, and is marked only when refused', async () => {
  assert.equal(await judgeNodeposit({ community: true, publicValues: pvFor(EXPECT), proof: '0xab', want: [EXPECT.depositId], expect: EXPECT, verify: verifier(false) }), false);
  assert.equal(await judgeNodeposit({ community: true, publicValues: pvFor(EXPECT), proof: '0xab', want: [EXPECT.depositId], expect: EXPECT, verify: verifier('unchecked') }), 'unchecked');
});

test('a community proof that is not the job\'s is refused before the verifier is asked: another deposit, one more, a wrong chain, a wrong memo root, a wrong leaf', async () => {
  const OTHER_DEP = '0x' + 'bb'.repeat(32), OTHER = '0x' + 'cd'.repeat(32);
  const cases = {
    'its own deposit': pvFor(EXPECT, { deposits: [OTHER_DEP] }),
    'one more deposit': pvFor(EXPECT, { deposits: [EXPECT.depositId, OTHER_DEP] }),
    'another chain': pvFor(EXPECT, { chainBinding: OTHER }),
    'another memo root': pvFor(EXPECT, { memoRoot: OTHER }),
    'another leaf': pvFor(EXPECT, { leaves: [OTHER] }),
  };
  for (const [what, publicValues] of Object.entries(cases)) {
    const verify = verifier(true);
    assert.equal(await judgeNodeposit({ community: true, publicValues, proof: '0xab', want: [EXPECT.depositId], expect: EXPECT, verify }), false, what);
    assert.equal(verify.calls.length, 0, `${what}: the verifier is not asked`);
  }
});

test('a community proof for a job whose deposits are not known is never taken; for an op that is not a plain wrap it is held to the deposits alone', async () => {
  const verify = verifier(true);
  assert.equal(await judgeNodeposit({ community: true, publicValues: pvFor(EXPECT), proof: '0xab', want: null, expect: EXPECT, verify }), false);
  assert.equal(await judgeNodeposit({ community: true, publicValues: pvFor(EXPECT), proof: '0xab', want: [], expect: EXPECT, verify }), false);
  assert.equal(verify.calls.length, 0);
  assert.equal(await judgeNodeposit({ community: true, publicValues: pvFor(EXPECT, { chainBinding: '0x' + 'cd'.repeat(32) }), proof: '0xab', want: [EXPECT.depositId], expect: null, verify }), true, 'no expectation for a wrap-swap: the deposit match and the verifier');
  assert.equal(verify.calls.length, 1);
});

test('prover.js hands a community proof to the same judgment, with the job\'s deposits and expectation, and no longer leaves it unchecked', () => {
  const src = readFileSync(new URL('../src/lib/prover.js', import.meta.url), 'utf8');
  assert.ok(/judgeNodeposit\(\{ community, publicValues, proof, want, expect, verify: proofOnly\(null\) \}\)/.test(src), 'the nodeposit branch asks judgeNodeposit');
  assert.ok(!/if \(community\) return 'unchecked'/.test(src), 'the community case is not skipped');
  assert.ok(/verifySettle\(\{ \.\.\.c, want, expect \}\)/.test(src) && /const expect = pub \? wrapExpectation\(type, stdin\) : null/.test(src), 'the check carries the job\'s deposits and expectation');
  assert.ok(/c\.community && !consumesJobDeposits\(c\.publicValues, want\) \? false/.test(src), 'and a community proof is still refused outright when it is not the job\'s deposits');
});
