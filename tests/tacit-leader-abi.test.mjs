// The leader reads the block it lands, or one landed by someone else through a contract of theirs, from the transaction's calldata.
//   node tests/tacit-leader-abi.test.mjs
import assert from 'node:assert';
import { decodeLand, landCalldata, encode, selector, hexOf } from '../tacit-leader/abi.mjs';

const b = (n, v) => new Uint8Array(n).fill(v);
const lists = { leaves: b(64, 1), memos: b(10, 2), nullifiers: [hexOf(b(32, 3))], anchors: [hexOf(b(32, 4))], deposits: b(0, 0), exits: b(0, 0), hops: b(0, 0), claims: b(0, 0), blobs: b(0, 0), migrations: b(0, 0), migrationTotals: b(0, 0) };
const pv = b(32 * 19, 9), proof = b(40, 7);
const direct = landCalldata(pv, proof, lists);
const same = (c) => c && hexOf(c.publicValues) === hexOf(pv) && hexOf(c.proof) === hexOf(proof) && hexOf(c.lists.leaves) === hexOf(lists.leaves) && c.lists.nullifiers[0] === lists.nullifiers[0];
assert.ok(same(decodeLand(direct)), 'a direct land call');
// through a contract: relay(address,bytes) and execute(bytes), the land call as the bytes passed on
const viaA = new Uint8Array([...selector('relay(address,bytes)'), ...encode(['address', 'bytes'], ['0x' + '11'.repeat(20), direct])]);
const viaB = new Uint8Array([...selector('execute(bytes)'), ...encode(['bytes'], [direct])]);
assert.ok(same(decodeLand(viaA)), 'through relay(address,bytes)');
assert.ok(same(decodeLand(viaB)), 'through execute(bytes)');
assert.equal(decodeLand(new Uint8Array([...selector('transfer(address,uint256)'), ...b(64, 0)])), null, 'a call that is not a land is not one');
assert.equal(decodeLand(new Uint8Array([...selector('execute(bytes)'), ...b(8, 5)])), null, 'nor is junk');
console.log('leader abi: all passed');
