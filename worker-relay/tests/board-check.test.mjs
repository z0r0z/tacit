// A community proof for a public board job (src/lib/board-check.js): taken only when its public values consume exactly the job's deposits, so a
// racer cannot answer a user's wrap with a proof of its own wrap carrying the same memos.
// Run: node --test tests/board-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pvDeposits, consumesJobDeposits } from '../src/lib/board-check.js';

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
