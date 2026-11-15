// dapp/fixed-pool-notes.js: the split plan, the signature-derived secrets, the commitment, the deposit call and
// the note string.
//
// The vectors below were produced by the wallet keychain's own derivation code (a TypeScript package in the
// Kohaku wallet repo) from a public test key, so a deposit made by this module is one that keychain can open and
// spend. The module's BLAKE-256 and Pedersen hash were also checked against the reference implementations the
// keychain uses, over random inputs of every length from 0 to 300 bytes (BLAKE-256) and 1 to 100 bytes
// (Pedersen); the known-answer cases below keep the first of those from drifting.
//
// Run: node tests/fixed-pool-notes.test.mjs

import {
  planSplit, FIXED_POOLS, blake256, pedersenPoint, pedersenHash, noteTypedData, canonicalRS, deriveSecrets,
  depositCall, noteString, parseNoteString, commitmentBytes32, DEFAULT_MIN_DENOMINATION, DEFAULT_MAX_NOTES,
} from '../dapp/fixed-pool-notes.js';
import { keccak_256, secp, hexToBytes, bytesToHex, concatBytes } from '../dapp/vendor/tacit-deps.min.js';

let pass = 0, fail = 0;
const test = (label, fn) => {
  try { fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };
const E = 10n ** 18n;

console.log('plan');
test('under the smallest denomination everything goes to Tacit', () => {
  const p = planSplit(E - 1n, 1);
  eq(p.notes.length, 0); eq(p.remainder, E - 1n); eq(p.noteCount, 0);
});
test('the default smallest denomination is 1 ETH, so 0.5 ETH on a chain with a 0.1 pool stays whole', () => {
  eq(DEFAULT_MIN_DENOMINATION, E);
  const p = planSplit(5n * E / 10n, 1);
  eq(p.notes.length, 0); eq(p.remainder, 5n * E / 10n);
});
test('100.001234 ETH: one 100 note, the odd part to Tacit', () => {
  const amount = 100n * E + 1234n * 10n ** 12n;
  const p = planSplit(amount, 1);
  eq(p.notes.length, 1); eq(p.notes[0].denomination, 100n * E); eq(p.notes[0].count, 1);
  eq(p.remainder, 1234n * 10n ** 12n); eq(p.noteCount, 1);
});
test('largest first, and the parts add back to the amount', () => {
  const amount = 111n * E + 5n * 10n ** 17n + 7n;
  const p = planSplit(amount, 1, { maxNotes: 99 });
  const dens = p.notes.map((n) => n.denomination);
  eq(JSON.stringify(dens.map(String)), JSON.stringify([String(100n * E), String(10n * E), String(E)]));
  eq(p.notes.reduce((s, n) => s + n.denomination * BigInt(n.count), 0n) + p.remainder, amount);
  eq(p.remainder, 5n * 10n ** 17n + 7n);
});
test('the note cap sends what it leaves out to Tacit', () => {
  const p = planSplit(99n * E, 1);
  eq(p.noteCount, DEFAULT_MAX_NOTES);
  eq(p.notes.reduce((s, n) => s + n.count, 0), DEFAULT_MAX_NOTES);
  eq(p.notes.reduce((s, n) => s + n.denomination * BigInt(n.count), 0n) + p.remainder, 99n * E);
  eq(planSplit(99n * E, 1, { maxNotes: 0 }).remainder, 99n * E);
});
test('a lower smallest denomination uses the 0.1 pool', () => {
  const p = planSplit(E / 10n * 3n + 5n, 1, { minDenominationWei: E / 10n });
  eq(p.notes[0].denomination, E / 10n); eq(p.notes[0].count, 3); eq(p.remainder, 5n);
});
test('a chain with no pools gets nothing but the remainder', () => {
  const p = planSplit(500n * E, 8453);
  eq(p.notes.length, 0); eq(p.remainder, 500n * E);
});
test('Sepolia has no 100 ETH pool', () => {
  const p = planSplit(100n * E, 11155111, { maxNotes: 99 });
  eq(p.notes.length, 1); eq(p.notes[0].denomination, 10n * E); eq(p.notes[0].count, 10);
});
test('every listed pool is a checksummed-looking address, listed once, with a unique denomination per chain', () => {
  for (const [chain, pools] of Object.entries(FIXED_POOLS)) {
    eq(new Set(pools.map((p) => p.address.toLowerCase())).size, pools.length, `chain ${chain} addresses`);
    eq(new Set(pools.map((p) => p.denomination)).size, pools.length, `chain ${chain} denominations`);
    for (const p of pools) if (!/^0x[0-9a-fA-F]{40}$/.test(p.address)) throw new Error(`bad address ${p.address}`);
  }
});
test('a negative amount is refused', () => {
  let threw = false; try { planSplit(-1n, 1); } catch { threw = true; }
  eq(threw, true);
});

console.log('hashes');
const hex = (b) => bytesToHex(b);
test('BLAKE-256 known answers', () => {
  eq(hex(blake256(new Uint8Array(0))), '716f6e863f744b9ac22c97ec7b76ea5f5908bc5b2f67c61510bfc4751384ea7a');
  eq(hex(blake256(new Uint8Array(1))), '0ce8d4ef4dd7cd8d62dfded9d4edb0a774ae6a41929a74da23109e8f11139c87');
  eq(hex(blake256(new Uint8Array(72))), 'd419bad32d504fb7d44d460c42c5593fe544fa4c135dec31e21bd9abdcc22d41');
});
test('Pedersen hash of the packed point equals the packing of the point', () => {
  const m = new Uint8Array(62).map((_, i) => i * 7 + 1);
  const [x, y] = pedersenPoint(m);
  const packed = pedersenHash(m);
  let v = 0n; for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(i === 31 ? packed[i] & 0x7f : packed[i]);
  eq(v, y);
  eq((packed[31] & 0x80) !== 0, x > (21888242871839275222246405745257275088548364400416034343698204186575808495617n - 1n) / 2n);
});

console.log('secrets');
const TEST_ADDRESS = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
const VECTORS = [
  { nonce: 0, chainId: 1, pool: '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936', signature: '0xff77f2f406c836e7ee02cc09f19e6f2ce516f56a7d032e48b07a0e440b9aec4321b29d04f2764724b5939222b736e5067a6a485b669487e6c7e5d045177e10b01b', commitment: '12835225892590859773925035759362146102382624861804570551273234300053110344907', nullifierHash: '4421162913551255187565258613137729303119586078752544998892470642633069808385' },
  { nonce: 7, chainId: 11155111, pool: '0x8C4A04d872a6C1BE37964A21ba3a138525dFF50b', signature: '0x16fbeb1a0dc147465b54ed6253f00b71bacffd58ce0cd17b4563c77a9a085b4b43aa3cf654f64edf7823455a16cb5863f54918e567ab72be25a7ee372bb5368f1c', commitment: '7794230873673609796736835556618231228942493640714257442771883100781797408314', nullifierHash: '14565364874101919976563663567377212575473118641611777811158463062162790275999' },
  { nonce: 123456, chainId: 1, pool: '0xA160cdAB225685dA1d56aa342Ad8841c3b53f291', signature: '0x33cf08f921aa4c79bd9c7a266ba4b2b648f0af74f05a7539362cd2b975b00f4322d53e780c4a20493385207e60ba6698ecfeb7fa7df1e9113a594117df3c61f21b', commitment: '9512028510634418257330769837777432835737419748964676667993766714717209481305', nullifierHash: '1205311484172536424487280165489558024604071434976111203753024818251419276559' },
];
for (const v of VECTORS) {
  test(`secrets for nonce ${v.nonce} on chain ${v.chainId} match the keychain's`, () => {
    const s = deriveSecrets({ signature: v.signature, pool: v.pool });
    eq(s.commitment.toString(), v.commitment, 'commitment');
    eq(s.nullifierHash.toString(), v.nullifierHash, 'nullifierHash');
    eq(s.preimage.length, 62);
  });
}

// EIP-712, by hand: the digest of our typed data must be the one the vector signatures cover. If the wallet's
// signature recovers the test key's address, the typed data we send is the one the keychain signs.
const enc = new TextEncoder();
const word = (n) => hexToBytes(BigInt(n).toString(16).padStart(64, '0'));
function digestOf(td) {
  const dom = td.domain;
  const domainType = keccak_256(enc.encode('EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)'));
  const sep = keccak_256(concatBytes(domainType, keccak_256(enc.encode(dom.name)), keccak_256(enc.encode(dom.version)), word(dom.chainId), hexToBytes(dom.salt.slice(2))));
  const structType = keccak_256(enc.encode('TornadoCashNote(uint64 nonce)'));
  const struct = keccak_256(concatBytes(structType, word(td.message.nonce)));
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), sep, struct));
}
function recover(sigHex, digest) {
  const sig = hexToBytes(sigHex.slice(2));
  const rec = sig[64] - 27;
  const pub = secp.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(rec).recoverPublicKey(digest).toRawBytes(false);
  return '0x' + bytesToHex(keccak_256(pub.slice(1)).slice(12));
}
for (const v of VECTORS) {
  test(`the typed data for nonce ${v.nonce} on chain ${v.chainId} is what the vector signature covers`, () => {
    eq(recover(v.signature, digestOf(noteTypedData(v.nonce, v.chainId))), TEST_ADDRESS);
  });
}
test('typed data lists the domain type and pins primaryType', () => {
  const td = noteTypedData(3, 1);
  eq(td.primaryType, 'TornadoCashNote'); eq(td.message.nonce, '3'); eq(td.types.EIP712Domain.length, 4);
  eq(td.domain.salt, '0x' + bytesToHex(keccak_256(enc.encode('tornado'))));
});
test('the high-s twin of a signature gives the same secrets', () => {
  const v = VECTORS[0];
  const sig = hexToBytes(v.signature.slice(2));
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const s = BigInt('0x' + bytesToHex(sig.slice(32, 64)));
  const twin = concatBytes(sig.slice(0, 32), word(N - s), new Uint8Array([sig[64] === 27 ? 28 : 27]));
  eq(bytesToHex(canonicalRS('0x' + bytesToHex(twin))), bytesToHex(canonicalRS(v.signature)));
});
test('a signature that is not 65 bytes is refused', () => {
  let threw = false; try { canonicalRS('0x1234'); } catch { threw = true; }
  eq(threw, true);
});
test('the pool is part of the secret: one signature, two pools, two commitments', () => {
  const a = deriveSecrets({ signature: VECTORS[0].signature, pool: FIXED_POOLS[1][1].address });
  const b = deriveSecrets({ signature: VECTORS[0].signature, pool: FIXED_POOLS[1][2].address });
  eq(a.commitment === b.commitment, false);
});
test('the pool address is read without regard to case', () => {
  const lower = deriveSecrets({ signature: VECTORS[0].signature, pool: VECTORS[0].pool.toLowerCase() });
  eq(lower.commitment.toString(), VECTORS[0].commitment);
});

console.log('deposit and note');
test('deposit(bytes32) call carries the commitment and the denomination', () => {
  const pool = FIXED_POOLS[1][1];
  const call = depositCall(pool, BigInt(VECTORS[0].commitment));
  eq(call.to, pool.address); eq(call.value, E);
  eq(call.data.slice(0, 10), '0xb214faa5');
  eq(call.data.length, 10 + 64);
  eq(BigInt('0x' + call.data.slice(10)).toString(), VECTORS[0].commitment);
  eq(bytesToHex(keccak_256(enc.encode('deposit(bytes32)')).slice(0, 4)), 'b214faa5');
});
test('commitment bytes are 32 wide even when the value is small', () => {
  eq(commitmentBytes32(1n), '0x' + '0'.repeat(63) + '1');
});
test('a note string round-trips to the same commitment and nullifier hash', () => {
  const s = deriveSecrets({ signature: VECTORS[0].signature, pool: VECTORS[0].pool });
  const text = noteString({ denomination: E, chainId: 1, preimage: s.preimage });
  eq(text.startsWith('tornado-eth-1-1-0x'), true);
  const back = parseNoteString(text);
  eq(back.commitment.toString(), VECTORS[0].commitment);
  eq(back.nullifierHash.toString(), VECTORS[0].nullifierHash);
  eq(back.amount, '1'); eq(back.chainId, 1);
});
test('a tenth of an ether is written 0.1', () => {
  const text = noteString({ denomination: E / 10n, chainId: 11155111, preimage: new Uint8Array(62) });
  eq(text.startsWith('tornado-eth-0.1-11155111-0x'), true);
});
test('malformed notes are refused', () => {
  for (const bad of ['', 'nonsense', 'tornado-eth-1-1-0x1234', 'tornado-eth-1-1-' + '0'.repeat(124)]) {
    let threw = false; try { parseNoteString(bad); } catch { threw = true; }
    eq(threw, true, JSON.stringify(bad));
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
