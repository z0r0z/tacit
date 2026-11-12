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
// a land-shaped call placed ahead of the real one in a wrapper's calldata is not taken for the block that landed: the contract's Landed event says which
const word = (v) => b(32, v);
const pvOf = (state, root) => { const x = new Uint8Array(32 * 19).fill(9); x.set(word(state), 32); x.set(word(root), 96); return x; };
const realPv = pvOf(0xaa, 0xbb), decoyPv = pvOf(0xcc, 0xdd);
const real = landCalldata(realPv, proof, lists), decoy = landCalldata(decoyPv, b(40, 1), { ...lists, leaves: b(64, 8) });
const wrapped = new Uint8Array([...selector('relay(address,bytes,bytes)'), ...encode(['address', 'bytes', 'bytes'], ['0x' + '11'.repeat(20), decoy, real])]);
const expectReal = { state: hexOf(word(0xaa)), noteRoot: hexOf(word(0xbb)) };
assert.equal(hexOf(decodeLand(wrapped).publicValues), hexOf(decoyPv), 'with no event to go by, the first land-shaped call is taken, as before');
assert.equal(hexOf(decodeLand(wrapped, expectReal).publicValues), hexOf(realPv), 'with the event, the call whose public values match it is the one');
assert.equal(hexOf(decodeLand(wrapped, expectReal).lists.leaves), hexOf(lists.leaves), 'and its lists are its own');
assert.equal(decodeLand(wrapped, { state: hexOf(word(1)), noteRoot: hexOf(word(2)) }), null, 'no call matching the event is no block');
assert.equal(hexOf(decodeLand(real, expectReal).publicValues), hexOf(realPv), 'a direct call that matches the event');
assert.equal(decodeLand(real, { state: hexOf(word(0xaa)), noteRoot: hexOf(word(0xee)) }), null, 'a direct call whose note root is not the event\'s is refused');
console.log('leader abi: all passed');
