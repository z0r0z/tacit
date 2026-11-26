// The take of an ETH-for-Bitcoin swap, signed ahead except for t (dapp/take-presig.js): the pre-signature completes to a valid BIP-340 signature for the lock
// output key once t is known, whatever the parities of the keys, and not otherwise; the committed output cannot be changed; the sighash and the lock agree with
// the wallet's own (dapp/bitcoin-taproot-wallet.js, dapp/adaptor-btc-lock.js). Offline.
//   node tests/take-presig.test.mjs
import assert from 'node:assert/strict';
import { sha256, bytesToHex, hexToBytes, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { G, SECP_N, bigintToBytes32, verifySchnorr } from '../dapp/bulletproofs.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { deriveLock, claimSecret } from '../dapp/adaptor-btc-lock.js';
import * as P from '../dapp/take-presig.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const te = (s) => new TextEncoder().encode(s);
const scalar = (tag) => (BigInt('0x' + bytesToHex(sha256(te(tag)))) % (SECP_N - 1n)) + 1n;
globalThis.fetch = async () => { throw new Error('offline test'); };
const prims = makeBtcWallet({ priv: bigintToBytes32(scalar('w')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 1 }).prims;
const DEST = '0014' + 'ab'.repeat(20);
const lockerXonly = G.multiply(scalar('locker')).toRawBytes(true).slice(1);

// one swap's terms from a label: the user's key d, the provider's t, the lock outpoint, and the pre-signature
function swap(label, { value = 200_000, fee = 1500, dest = DEST, csv = 144 } = {}) {
  const d = scalar('d/' + label), t = scalar('t/' + label), T = G.multiply(t), claimerPub = G.multiply(d).toRawBytes(true);
  const lockOut = { txid: bytesToHex(sha256(te('lock/' + label))), vout: 1, value };
  const sTilde = bytesToHex(bigintToBytes32(scalar('s~/' + label)));
  const p = P.makePresig({ dUser: d, claimerPub, T, lockerXonly, csvBlocks: csv, lockOut, dest, fee, sTilde, lockNu: bytesToHex(sha256(te('nu/' + label))), deadline: 1_900_000_000 });
  return { d, t, T, claimerPub, lockOut, p, sTilde };
}
const lockFor = (s, csv = 144) => deriveLock({ prims, claimerPub: s.claimerPub, T: s.T, lockerXonly, csvBlocks: csv });

test('the lock output and the sighash agree with the wallet\'s own derivation', () => {
  const s = swap('a'), lock = lockFor(s), v = P.verifyPresig(s.p);
  assert.ok(v.ok, v.reasons.join());
  assert.equal(v.spk, bytesToHex(lock.spk));
  const tx = { version: 2, locktime: 0, inputs: [{ txid: s.lockOut.txid, vout: 1, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: s.lockOut.value - 1500, script: hexToBytes(DEST) }] };
  const want = prims.tapSighashKeyPath(tx, 0, [{ value: s.lockOut.value, script: lock.spk }], 0x83);
  assert.equal(bytesToHex(v.sighash), bytesToHex(want));
});

test('s\' + e*t is a valid BIP-340 signature for the take under the lock key, for random keys and every parity', () => {
  const seen = new Set();
  for (let n = 0; n < 80; n++) {
    const s = swap('prop' + n), lock = lockFor(s), v = P.verifyPresig(s.p);
    assert.ok(v.ok, v.reasons.join());
    seen.add(`${lock.internalOddY ? 'I' : 'i'}${v.lock.qOdd ? 'Q' : 'q'}${s.T.toRawBytes(true)[0] === 3 ? 'T' : 't'}${s.claimerPub[0] === 3 ? 'P' : 'p'}`);
    const sig = P.completeSig(s.p, s.t);
    assert.ok(verifySchnorr(sig, v.sighash, lock.outputXonly), 'verifies as BIP-340 under the output key');
    const sk = claimSecret({ dClaimer: s.d, t: s.t, lock });
    assert.equal(bytesToHex(G.multiply(BigInt('0x' + bytesToHex(sk))).toRawBytes(true).slice(1)), bytesToHex(lock.outputXonly));
  }
  for (const a of ['I', 'i']) for (const b of ['Q', 'q']) assert.ok([...seen].some((k) => k.startsWith(a + b)), `a case with ${a}${b}`);
  for (const a of ['T', 't']) assert.ok([...seen].some((k) => k.includes(a)), `a case with T parity ${a}`);
  for (const a of ['P', 'p']) assert.ok([...seen].some((k) => k.includes(a)), `a case with P parity ${a}`);
});

test('the pre-signature alone does not verify, and a wrong t does not complete it', () => {
  const s = swap('b'), v = P.verifyPresig(s.p), lock = lockFor(s);
  const bare = concatBytes(hexToBytes(s.p.R), hexToBytes(s.p.sPre));
  assert.equal(verifySchnorr(bare, v.sighash, lock.outputXonly), false);
  assert.throws(() => P.completeSig(s.p, s.t + 1n), /does not open T/);
  assert.equal(P.extractT(s.p, 12345n), null);
});

test('the pre-signature is deterministic and names no secret', () => {
  const a = swap('c'), b = swap('c');
  assert.deepEqual(a.p, b.p);
  const text = JSON.stringify(a.p);
  for (const k of [a.d, a.t]) assert.ok(!text.includes(bytesToHex(bigintToBytes32(k))));
  const other = swap('c', { fee: 1600 });
  assert.notEqual(other.p.R, a.p.R, 'a different take gets its own nonce');
});

test('a modified destination, amount, outpoint or fee fails verification', () => {
  const s = swap('d');
  const bad = [
    { ...s.p, dest: '0014' + 'cd'.repeat(20) },
    { ...s.p, fee: s.p.fee + 1 },
    { ...s.p, lock: { ...s.p.lock, value: s.p.lock.value + 1 } },
    { ...s.p, lock: { ...s.p.lock, vout: 2 } },
    { ...s.p, lock: { ...s.p.lock, txid: 'ee'.repeat(32) } },
    { ...s.p, csv: 145 },
    { ...s.p, sPre: bytesToHex(bigintToBytes32(scalar('junk'))) },
    { ...s.p, R: bytesToHex(G.multiply(scalar('junk2')).toRawBytes(true).slice(1)) },
  ];
  for (const b of bad) assert.equal(P.verifyPresig(b).ok, false, JSON.stringify(b).slice(0, 80));
  assert.equal(P.verifyPresig({ ...s.p, fee: 150_000 }).ok, false, 'a fee over half the lock is refused');
  assert.equal(P.verifyPresig({ ...s.p, dest: '6a00' }).ok, false, 'a non-standard script is refused');
});

test('the built take pays exactly the committed output, and a changed output makes it unbroadcastable', () => {
  const s = swap('e'), take = P.buildTake(s.p, s.t);
  assert.equal(take.tx.outputs.length, 1);
  assert.equal(take.tx.outputs[0].value, s.lockOut.value - 1500);
  assert.equal(bytesToHex(take.tx.outputs[0].script), DEST);
  assert.equal(take.tx.inputs[0].witness[0].length, 65);
  assert.equal(P.sameCommitted(take.tx, s.p), true);
  const moved = { ...take.tx, outputs: [{ value: take.tx.outputs[0].value, script: hexToBytes('0014' + 'cd'.repeat(20)) }] };
  assert.equal(P.sameCommitted(moved, s.p), false);
  const less = { ...take.tx, outputs: [{ value: take.tx.outputs[0].value - 1, script: take.tx.outputs[0].script }] };
  assert.equal(P.sameCommitted(less, s.p), false);
  assert.equal(take.txid.length, 64);
  assert.equal(take.vsize, P.vsizeOf(take.tx));
});

test('anyone may add inputs and outputs after the committed ones: the signature still holds', () => {
  const s = swap('f');
  const ext = { inputs: [{ txid: 'aa'.repeat(32), vout: 0, value: 50_000, script: DEST }], outputs: [{ value: 40_000, script: '0014' + '11'.repeat(20) }], sign: () => [[new Uint8Array(64), new Uint8Array(33)]] };
  const take = P.buildTake(s.p, s.t, ext);
  assert.equal(take.tx.inputs.length, 2);
  assert.equal(take.tx.outputs.length, 2);
  assert.equal(P.sameCommitted(take.tx, s.p), true);
  assert.equal(bytesToHex(take.tx.outputs[0].script), DEST);
});

test('serialization and txid agree with the wallet\'s', () => {
  const s = swap('g'), take = P.buildTake(s.p, s.t);
  assert.equal(take.hex, bytesToHex(prims.serializeTx(take.tx)));
  assert.equal(take.txid, prims.txid(take.tx));
});

test('t is read from the claim kernel z of the user\'s own pre-signature', () => {
  const s = swap('h'), sT = BigInt('0x' + s.sTilde), z = (sT + s.t) % SECP_N;
  assert.equal(P.extractT(s.p, z), s.t);
  assert.equal(P.extractT(s.p, '0x' + z.toString(16).padStart(64, '0')), s.t);
  assert.equal(P.extractT(s.p, (z + 1n) % SECP_N), null);
});

test('the committed fee pays a sensible rate and takeFee sizes it', () => {
  const s = swap('i');
  assert.ok(P.committedRate(s.p) > 5 && P.committedRate(s.p) < 20, String(P.committedRate(s.p)));
  const f = P.takeFee({ dest: DEST, feeRate: 10, lockValue: 200_000 });
  assert.ok(f > 900 && f < 1300, String(f));
  assert.equal(P.takeFee({ dest: DEST, feeRate: 10_000, lockValue: 20_000 }), 10_000, 'capped at half the lock');
});

let failed = 0;
for (const [name, fn] of tests) { try { await fn(); console.log('  ok - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n    ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n    ')); } }
console.log(failed ? `${failed} failed` : `${tests.length} passed`);
process.exit(failed ? 1 : 0);
