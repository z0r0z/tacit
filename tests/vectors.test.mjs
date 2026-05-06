// Deterministic test vectors. These pin the *exact bytes* an independent
// reimplementation (Rust indexer, Go indexer, etc.) must produce given
// matching inputs. If any of these change, every existing on-chain UTXO's
// derivation / asset_id / kernel-msg would silently shift.
//
// Inputs use fixed private keys and fixed outpoints so values are reproducible.
// Outputs were captured from the reference impl (./bulletproofs.mjs +
// ./composition.mjs, which mirror tacit.html).
//
// Run: `node vectors.test.mjs`
import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import {
  G, H, ZERO, modN,
  pedersenCommit, pointToBytes, bigintToBytes32, bytes32ToBigint,
} from './bulletproofs.mjs';
import {
  reverseBytes, assetIdFor,
  deriveBlinding, deriveChangeBlinding, deriveEtchBlinding,
  deriveAmountKeystreamECDH, deriveAmountKeystreamSelf, deriveEtchAmountKeystream,
  encryptAmount, decryptAmount, computeKernelMsg,
} from './composition.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}
const eqHex = (bytes, hex) => bytesToHex(bytes) === hex.toLowerCase();
const eqBig = (big, hex) => big.toString(16).padStart(64, '0') === hex.toLowerCase();

// --- Fixed inputs ---
const SK_A = hexToBytes('0101010101010101010101010101010101010101010101010101010101010101');
const SK_B = hexToBytes('0202020202020202020202020202020202020202020202020202020202020202');
const PK_A = secp.getPublicKey(SK_A, true);
const PK_B = secp.getPublicKey(SK_B, true);
const TXID_FIXED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const TXID_KERNEL_INPUT = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

const voutLE = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const ANCHOR = concatBytes(reverseBytes(hexToBytes('11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff')), voutLE(7));

console.log('Public-key derivations (sanity, not really tacit-specific):');
test('SK_A → PK_A (compressed) starts with 03 (odd-y)',
  () => eqHex(PK_A, '031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'));
test('SK_B → PK_B (compressed) starts with 02 (even-y)',
  () => eqHex(PK_B, '024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'));

console.log('\nNUMS H generator:');
test('H = derive("tacit-generator-H-v1") starts 02bd7bf4…',
  () => eqHex(pointToBytes(H), '02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56'));
test('H ≠ G (smoke check; otherwise Pedersen would be unbinding)',
  () => !H.equals(G));

console.log('\nPedersen commitments:');
test('C(1000, 7) bytes pinned',
  () => eqHex(pointToBytes(pedersenCommit(1000n, 7n)),
    '03925611857a1dcb094300ea201b3c963d1d144fd2b1c502022f14e4c234a02fcb'));
test('C(0, 1) ≡ G (algebraic identity)',
  () => pedersenCommit(0n, 1n).equals(G));
test('C(1, 0) ≡ H', () => pedersenCommit(1n, 0n).equals(H));

console.log('\nAsset ID:');
test('assetIdFor(TXID_FIXED, 0) bytes pinned',
  () => eqHex(assetIdFor(TXID_FIXED, 0),
    'dc68903e351194b48429d86b4a9cc499ae0dd1a726616a56bf33b70485037a5b'));
test('assetIdFor(TXID_FIXED, 1) bytes pinned',
  () => eqHex(assetIdFor(TXID_FIXED, 1),
    '7f51d9924eef5ca44b0b445903bdf089ddf7a9bd4881f97a0ac90e4fc196a401'));

console.log('\nAnchor encoding:');
test('anchor = txid_BE_reversed || vout(7)_LE bytes pinned',
  () => eqHex(ANCHOR,
    'ffeeddccbbaa00998877665544332211ffeeddccbbaa00998877665544332211' + '07000000'));

console.log('\nECDH-derived blindings:');
test('deriveBlinding(SK_A, PK_B, anchor, 0) bytes pinned',
  () => eqBig(deriveBlinding(SK_A, PK_B, ANCHOR, 0),
    '38919d697d9d3dbfce07914e56e51d9e15f2c10510facbf1eebd747759b2de0b'));
test('deriveBlinding is symmetric for sender ↔ recipient (cryptographic invariant)',
  () => deriveBlinding(SK_A, PK_B, ANCHOR, 0) === deriveBlinding(SK_B, PK_A, ANCHOR, 0));

console.log('\nSelf-derived blindings (sender change, etch supply):');
test('deriveChangeBlinding(SK_A, anchor, 1) bytes pinned',
  () => eqBig(deriveChangeBlinding(SK_A, ANCHOR, 1),
    '0698643988efaf27fa35d08ee78dc162457e74a88cad96f382121009c0fd6953'));
test('deriveEtchBlinding(SK_A, anchor) bytes pinned',
  () => eqBig(deriveEtchBlinding(SK_A, ANCHOR),
    '0aa637caf0e51ef750c94423e4a717a76518c5c66230ebae7d9f3d6d760fdbe9'));

console.log('\nAmount-encryption keystreams (8 bytes each):');
test('deriveAmountKeystreamECDH(SK_A, PK_B, anchor, 0) bytes pinned',
  () => eqHex(deriveAmountKeystreamECDH(SK_A, PK_B, ANCHOR, 0), 'b1697b0b93335da7'));
test('deriveAmountKeystreamSelf(SK_A, anchor, 1) bytes pinned',
  () => eqHex(deriveAmountKeystreamSelf(SK_A, ANCHOR, 1), '429ac902e11b2350'));
test('deriveEtchAmountKeystream(SK_A, anchor) bytes pinned',
  () => eqHex(deriveEtchAmountKeystream(SK_A, ANCHOR), 'ceb9e5269c17d71b'));

console.log('\nAmount encryption (XOR-OTP):');
test('encryptAmount(1000, ksECDH) bytes pinned',
  () => {
    const ks = deriveAmountKeystreamECDH(SK_A, PK_B, ANCHOR, 0);
    return eqHex(encryptAmount(1000n, ks), '596a7b0b93335da7');
  });
test('decrypt round-trips encrypt for arbitrary amount',
  () => {
    const ks = deriveAmountKeystreamECDH(SK_A, PK_B, ANCHOR, 0);
    return decryptAmount(encryptAmount(0xdeadbeefn, ks), ks) === 0xdeadbeefn;
  });

console.log('\nKernel message hash:');
test('computeKernelMsg(aid, [(input)], [(output)], burned=0) bytes pinned',
  () => {
    const aid = assetIdFor(TXID_FIXED, 0);
    const inputOps = [{ txid: TXID_KERNEL_INPUT, vout: 3 }];
    const outputCs = [pointToBytes(pedersenCommit(500n, 42n))];
    const km = computeKernelMsg(aid, inputOps, outputCs);
    return eqHex(km, 'bf51493e1c30a34c19a97b671743d3764684a885767b6e097b8222649889b695');
  });
test('kernel msg differs when asset_id changes',
  () => {
    const aid1 = assetIdFor(TXID_FIXED, 0);
    const aid2 = assetIdFor(TXID_FIXED, 1);
    const inputOps = [{ txid: TXID_KERNEL_INPUT, vout: 3 }];
    const outputCs = [pointToBytes(pedersenCommit(500n, 42n))];
    return !eqHex(computeKernelMsg(aid1, inputOps, outputCs),
                  bytesToHex(computeKernelMsg(aid2, inputOps, outputCs)));
  });
test('kernel msg differs when output commitment order changes',
  () => {
    const aid = assetIdFor(TXID_FIXED, 0);
    const inputOps = [{ txid: TXID_KERNEL_INPUT, vout: 3 }];
    const c1 = pointToBytes(pedersenCommit(500n, 42n));
    const c2 = pointToBytes(pedersenCommit(700n, 99n));
    const km1 = computeKernelMsg(aid, inputOps, [c1, c2]);
    const km2 = computeKernelMsg(aid, inputOps, [c2, c1]);
    return bytesToHex(km1) !== bytesToHex(km2);
  });
test('kernel msg differs when input outpoint vout changes',
  () => {
    const aid = assetIdFor(TXID_FIXED, 0);
    const c = pointToBytes(pedersenCommit(500n, 42n));
    const km1 = computeKernelMsg(aid, [{ txid: TXID_KERNEL_INPUT, vout: 0 }], [c]);
    const km2 = computeKernelMsg(aid, [{ txid: TXID_KERNEL_INPUT, vout: 1 }], [c]);
    return bytesToHex(km1) !== bytesToHex(km2);
  });

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
