// The leader reads the block it lands, or one landed by someone else through a contract of theirs, from the transaction's calldata.
//   node tests/tacit-leader-abi.test.mjs
import assert from 'node:assert';
import { decodeLand, landCalldata, encode, selector, hexOf, listHash, listsMatch, landInputFromTrace } from '../tacit-leader/abi.mjs';
import { sha256, concatBytes } from '../dapp/vendor/tacit-deps.min.js';

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
// public values that commit the lists, as the block program's do (outputs in word 4, nullifiers in 5, hops in 12, word 15 zero)
const committed = (x, l) => {
  const te = new TextEncoder(), n = l.leaves.length / 32, items = new Uint8Array(64 * n);
  for (let i = 0; i < n; i++) { items.set(l.leaves.subarray(32 * i, 32 * i + 32), 64 * i); items.set(sha256(concatBytes(te.encode('tacit-block-memo-v1'), l.memos.subarray(1152 * i, 1152 * (i + 1)))), 64 * i + 32); }
  const put = (i, h) => x.set(Uint8Array.from(Buffer.from(h.slice(2), 'hex')), 32 * i);
  put(4, listHash(1, n, items)); put(5, listHash(2, l.nullifiers.length, concatBytes(...l.nullifiers.map((h) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'))))));
  put(12, listHash(6, l.hops.length / 96, l.hops)); x.set(new Uint8Array(32), 32 * 15);
  return x;
};
lists.memos = b(2 * 1152, 2);
const realPv = committed(pvOf(0xaa, 0xbb), lists), decoyPv = pvOf(0xcc, 0xdd);
const real = landCalldata(realPv, proof, lists), decoy = landCalldata(decoyPv, b(40, 1), { ...lists, leaves: b(64, 8) });
const wrapped = new Uint8Array([...selector('relay(address,bytes,bytes)'), ...encode(['address', 'bytes', 'bytes'], ['0x' + '11'.repeat(20), decoy, real])]);
const expectReal = { state: hexOf(word(0xaa)), noteRoot: hexOf(word(0xbb)) };
assert.equal(hexOf(decodeLand(wrapped).publicValues), hexOf(decoyPv), 'with no event to go by, the first land-shaped call is taken, as before');
assert.equal(hexOf(decodeLand(wrapped, expectReal).publicValues), hexOf(realPv), 'with the event, the call whose public values match it is the one');
assert.equal(hexOf(decodeLand(wrapped, expectReal).lists.leaves), hexOf(lists.leaves), 'and its lists are its own');
assert.equal(decodeLand(wrapped, { state: hexOf(word(1)), noteRoot: hexOf(word(2)) }), null, 'no call matching the event is no block');
assert.equal(hexOf(decodeLand(real, expectReal).publicValues), hexOf(realPv), 'a direct call that matches the event');
assert.equal(decodeLand(real, { state: hexOf(word(0xaa)), noteRoot: hexOf(word(0xee)) }), null, 'a direct call whose note root is not the event\'s is refused');
// a land-shaped call that copies the real call's public values but carries other lists is passed over: its lists are not the ones committed
assert.ok(listsMatch(realPv, lists), 'the real lists are the committed ones');
const copy = landCalldata(realPv, b(40, 1), { ...lists, leaves: b(64, 8) });
const copied = new Uint8Array([...selector('relay(address,bytes,bytes)'), ...encode(['address', 'bytes', 'bytes'], ['0x' + '11'.repeat(20), copy, real])]);
assert.equal(hexOf(decodeLand(copied, expectReal).lists.leaves), hexOf(lists.leaves), 'a copy of the public values with other lists is not the block');
assert.equal(decodeLand(copy, expectReal), null, 'and on its own it is no block');
assert.ok(!listsMatch(realPv, { ...lists, nullifiers: [hexOf(b(32, 6))] }), 'other nullifiers do not match');
assert.ok(!listsMatch(realPv, { ...lists, hops: b(96, 1) }), 'other hops do not match');
// a landing whose calldata hides the call: found in a callTracer trace, as the call to the blocks contract
const BLK = '0x' + '42'.repeat(20);
const masked = direct.map((x) => x ^ 0x5a);
const trace = { to: '0x' + '11'.repeat(20), input: hexOf(new Uint8Array([...selector('go(bytes)'), ...encode(['bytes'], [masked])])), calls: [
  { to: BLK, input: hexOf(copy), error: 'execution reverted' },
  { to: '0x' + '33'.repeat(20), input: '0x', calls: [{ to: BLK.toUpperCase().replace('0X', '0x'), input: hexOf(real) }] }] };
assert.equal(decodeLand(trace.input, expectReal), null, 'the masked calldata reads as no block');
const inputs = landInputFromTrace(trace, BLK);
assert.equal(inputs.length, 1, 'a reverted inner call is not taken');
assert.equal(hexOf(decodeLand(inputs[0], expectReal).publicValues), hexOf(realPv), 'the traced call is the block');
console.log('leader abi: all passed');
