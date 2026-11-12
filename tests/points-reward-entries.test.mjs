// The reward tree is built from the ledger's rows. A row credited to the zero address cannot be claimed and is left out; the builder itself still refuses a tree that carries one.
import assert from 'node:assert/strict';
import { build, rewardEntries } from '../worker-relay/src/lib/points-merkle.js';
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), Z = '0x' + '0'.repeat(40);
const rows = [{ address: A, cumulativeWei: '5' }, { address: Z, cumulativeWei: '9' }, { address: B, cumulativeWei: '7' }];
assert.throws(() => build(rows.map((r) => ({ address: r.address, cumulativeAmountWei: BigInt(r.cumulativeWei) }))), /zero address/);
console.log('ok - the builder refuses a tree that carries the zero address');
const tree = build(rewardEntries(rows));
assert.equal(tree.count, 2);
assert.equal(tree.totalWei, '12');
assert.ok(Object.keys(tree.claims).every((a) => BigInt(a) !== 0n));
console.log('ok - the rows without it still make a root, and it does not carry the zero address');
assert.equal(rewardEntries([{ address: Z.toUpperCase().replace('0X', '0x'), cumulativeWei: '1' }]).length, 0);
console.log('ok - the zero address is left out in any letter case');
