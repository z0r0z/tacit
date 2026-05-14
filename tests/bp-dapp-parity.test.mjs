// Pinned dapp-parity bulletproof test vector.
//
// Catches transcript / generator / encoding regressions in tests/bulletproofs.mjs
// at PR-time — BEFORE the live mainnet canary runs — by verifying a real
// dapp-generated, mainnet-confirmed bulletproof rangeproof against the
// test suite's BP machinery.
//
// Prior to this test landing:
//   - tests/bulletproofs.mjs used transcript domain `tacit-bp-v2` while
//     dapp/tacit.js + SPEC.md §3 normatively pinned `tacit-bp-v1`.
//   - tests/bulletproofs.mjs used unprefixed transcript appends while
//     dapp/tacit.js used length-prefixed (4-byte LE u32) appends.
//   - Both divergences were silent because the test suite only round-tripped
//     self-generated proofs and never cross-verified against on-chain dapp
//     artifacts. The drift was surfaced when the TAC mainnet canary
//     (tests/canary-asset-tac-mainnet.test.mjs) tried to verify a real
//     on-chain rangeproof and failed.
//
// This test is the cheap, offline, deterministic guard against either
// divergence sneaking back in. It runs in milliseconds, no network. If
// it fails, someone changed BP generators / transcript / serialization
// in a way incompatible with the SPEC-normative on-chain protocol —
// fix tests/bulletproofs.mjs to match the dapp, OR formally bump the
// SPEC + dapp + on-chain envelope version (with the existing TAC asset's
// historical rangeproofs grandfathered).
//
// FIXTURE: one confirmed TAC mainnet trade (tx
// 1a9c4fec86b651287daeda409a5f9fdceb9fa2062ef429eb62d9867496b394dc),
// asset_id f0bbe868… (TAC), N=1 output, 688-byte aggregated bulletproof
// rangeproof. Extracted from vin[0].witness[1] of the confirmed Bitcoin
// transaction at canary creation time.

import { hexToBytes } from '@noble/hashes/utils';
import { bytesToPoint, bpRangeAggVerify } from './bulletproofs.mjs';

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

// === Pinned fixture: TAC trade tx 1a9c4fec…, vin[0] T_AXFER N=1 ===
const PIN = Object.freeze({
  txid_short:    '1a9c4fec86b6',
  asset_id_hex:  'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b',
  commitment_hex: '0263756609c957db2406df41bd131c4dce56f92a268c3d76419a7c4c5ac9cd975a',
  // 688-byte aggregated bulletproof rangeproof for m=1, n=64.
  // Captured from the on-chain dapp-generated T_AXFER envelope.
  proof_hex:
    '021633b50b19a2a56e50a3ba873bd1a01b0b418e1c6e92e99b2db66b2b4135056f' +
    '02445268a431b2bd65227bdc44d78388a142491c0538f67dba97d46ff16302c452' +
    '02a28030a9918767cd14ca9707b027f8fccdd59b4d820a23a93d008ba0dd972b83' +
    '03600008f3a4d873d397d9843f77243da5c0a8df39f24d9eea82a735a769c61704' +
    'e7360ad557f505e9899c3254b347103b169fe18bb839f60c0ce8d7e93e09897a54' +
    'd692dac45e20cb1843f86a3fa44a1e45e8c029b7f48230238195cf6b3fe81ea584' +
    '31b1d41452aa16cd10b5061068ee0820a3a6e751fa70fa1bfdda17419da50362d7' +
    'c049e6d711d54a9d9ff2f06bf91c8e973531b902fb5daae8713b141897dd0257a0' +
    '47bd35226bbb0bb5ddae60c4b13d9209b396433ec6da4f310d1ba09d133c0260e7' +
    '380e97e1f3beffd9fdeec8a6ed2bd398ce38c1c188cda540bb5680cbc263038285' +
    '952066e6e92d0c1ed894e78bb951fb5e1007ea03f0220ae829f4b72fc571023a6f' +
    '885cc9733d18dfa20d9830316a3098f571fb6d27787e0068467b47c3d01c03f209' +
    'b0d2a3c9fe89ffa92d05136e32e8e7cbe9f5bac848fc54167f64f1966072031878' +
    'a4da2ab0123704e82873c1d8ed966897586c07985ad0e1fd59fac9a11936027de9' +
    '86e719330f147fb8ced4f247df21cf7a9e0d73a98144b921c1ae01e87a0b0374b3' +
    'aa1648c5074272eb85f0405dfacd0475f31d22461686441ce3dce491572f03b0ef' +
    '07f31ed30f37f49e5b548cb35ba1cf8c6c85859df9fb3f72ee5f0c03042803932e' +
    '7aa8f5f6b1b3b123a91eb803941d434e1b8339a57cb36ca32f946105341f023002' +
    'f5c09b42e31cb8477ceffa1626f14b8d16830e47e30bc771085dc49cc1011e5838' +
    '25bfcc1b93e54d0ece619577971d8e8e6a7b6c465a3e72297bcee2607cd53fa761' +
    '453b7d7f96652937ca3bc233e8a7cf2623f44c9a309e2a235136de7f',
});

console.log(`\n=== bulletproof dapp-parity (pinned TAC trade ${PIN.txid_short}…) ===\n`);

test('pinned commitment parses as compressed secp256k1 point', () => {
  const P = bytesToPoint(hexToBytes(PIN.commitment_hex));
  return P !== null && P !== undefined;
});

test('pinned rangeproof is the expected 688 bytes (m=1, n=64)', () => {
  // m=1 BP: 33*4 (A,S,T1,T2) + 32*3 (t_hat, tau_x, mu) + log2(64)*33*2 (Lk,Rk) + 32*2 (a_final, b_final)
  // = 132 + 96 + 6*66 + 64 = 132 + 96 + 396 + 64 = 688
  return hexToBytes(PIN.proof_hex).length === 688;
});

test('pinned rangeproof verifies under SPEC-normative crypto stack (tacit-bp-v1, length-prefixed transcript, canonical generators)', () => {
  const V_pts = [bytesToPoint(hexToBytes(PIN.commitment_hex))];
  const proof = hexToBytes(PIN.proof_hex);
  const ok = bpRangeAggVerify(V_pts, proof);
  if (!ok) {
    console.log(`     This means tests/bulletproofs.mjs has drifted from the dapp + SPEC §3.`);
    console.log(`     The dapp's on-chain bulletproof can no longer be verified by tests'.`);
    console.log(`     Check: BP transcript domain (must be 'tacit-bp-v1'),`);
    console.log(`            transcript append shape (must be length-prefixed u32-LE),`);
    console.log(`            generator domains (tacit-bp-{G,H,Q}-v1, tacit-generator-H-v1),`);
    console.log(`            commitment encoding (33-byte compressed secp256k1).`);
  }
  return ok;
});

console.log(`\n=== ${pass} passed · ${fail} failed ===`);
if (fail > 0) process.exit(1);
