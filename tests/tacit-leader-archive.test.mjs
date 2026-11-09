// The blocks a leader keeps on its disk lead the node from the empty chain to the contract's state, or they are not used.
//   node tests/tacit-leader-archive.test.mjs
import assert from 'node:assert';
import { archiveEntry, loadArchive } from '../tacit-leader/archive.mjs';
import { hexOf } from '../tacit-leader/abi.mjs';

const w = (n) => new Uint8Array(32).fill(n);
// a block's public values: word 0 the state it starts from, word 1 the state it ends at, 17 more
const pv = (from, to) => new Uint8Array([...w(from), ...w(to), ...new Uint8Array(32 * 17)]);
const lists = { leaves: new Uint8Array(64).fill(1), memos: new Uint8Array(8).fill(2), nullifiers: [hexOf(w(3))] };
const files = new Map([1, 2, 3].map((h) => [h, JSON.stringify(archiveEntry(pv(h, h + 1), lists, 100 + h))]));
const read = (h) => files.get(h) ?? null;

const ok = loadArchive(3, read);
assert.ok(ok.ok && ok.blocks.length === 3, JSON.stringify(ok.why));
assert.equal(ok.first, hexOf(w(1)), 'block 1 starts from the empty chain');
assert.equal(ok.last, hexOf(w(4)), 'the last ends at the chain');
assert.equal(ok.blocks[0].lists.nullifiers[0], hexOf(w(3)));
assert.equal(JSON.parse(files.get(2)).ethBlock, 102, 'where it landed is kept when known');
assert.equal(loadArchive(0, read).blocks.length, 0);

// a gap, a block that starts elsewhere (another leader landed that height), one that does not read: not used
assert.match(loadArchive(4, read).why, /no file for block 4/);
const gap = new Map(files); gap.delete(2);
assert.match(loadArchive(3, (h) => gap.get(h) ?? null).why, /no file for block 2/);
const fork = new Map(files); fork.set(2, JSON.stringify(archiveEntry(pv(9, 5), lists)));
assert.match(loadArchive(3, (h) => fork.get(h) ?? null).why, /block 2 does not start where block 1 ended/);
const junk = new Map(files); junk.set(3, '{"publicValues":"0x00"}');
assert.match(loadArchive(3, (h) => junk.get(h) ?? null).why, /block 3's file does not read/);
const trunc = new Map(files); trunc.set(1, '{"publicValues":');
assert.match(loadArchive(3, (h) => trunc.get(h) ?? null).why, /block 1's file does not read/);
// a file written as the leader writes it when it builds a block (lists as the node gives them) reads too
const built = JSON.stringify({ publicValues: hexOf(pv(7, 8)), lists: { leaves: '0x' + '01'.repeat(32), memos: '0x', nullifiers: [], anchors: [], deposits: '0x' }, includes: ['abc'] });
assert.ok(loadArchive(1, () => built).ok);
console.log('leader archive: all passed');
