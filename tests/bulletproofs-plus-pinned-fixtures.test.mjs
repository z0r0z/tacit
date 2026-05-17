// Pinned deterministic proof fixtures for the BP+ port.
//
// Seeds the prover's randomness with a deterministic sequence, generates
// proofs at every m ∈ {1, 2, 4, 8}, and pins the resulting hex bytes here.
// Any future change to the prover algorithm, the curve substitution, the
// transcript shape, the generator derivation, or any scalar arithmetic
// path that drifts a single byte WILL fail this test.
//
// Catches regressions, not soundness bugs. The point is to freeze current
// behavior so a future contributor can't silently change how proofs are
// produced (which would split the verifier ecosystem) without re-running
// this file and explicitly updating the pinned hex.
//
// Re-generating: delete the PROOF_HEX values, run, copy printed output.

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

// Replace crypto.getRandomValues with a deterministic stream sourced from
// a known seed BEFORE importing bpp. Each call returns the next 32 bytes
// of sha256-extending the seed.
const SEED = sha256(new TextEncoder().encode('tacit-bpp-pinned-fixtures-v1'));
let _rng_offset = 0;
function _det_bytes(n) {
  const out = new Uint8Array(n);
  let remaining = n, dst = 0;
  while (remaining > 0) {
    const idxBytes = new Uint8Array(4);
    new DataView(idxBytes.buffer).setUint32(0, _rng_offset, false);
    const chunk = sha256(new Uint8Array([...SEED, ...idxBytes]));
    const take = Math.min(remaining, 32);
    out.set(chunk.slice(0, take), dst);
    remaining -= take; dst += take; _rng_offset++;
  }
  return out;
}
// Node 20+ has a read-only `crypto` global; override just getRandomValues.
const _det_getRandomValues = (buf) => {
  const b = _det_bytes(buf.length);
  for (let i = 0; i < buf.length; i++) buf[i] = b[i];
  return buf;
};
try {
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    value: _det_getRandomValues, writable: true, configurable: true,
  });
} catch {
  // Fallback: replace the entire crypto via property descriptor
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues: _det_getRandomValues }, writable: true, configurable: true,
  });
}

const bpp = await import('../dapp/bulletproofs-plus.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// Reset rng for reproducibility before each prove
function resetRng() { _rng_offset = 0; }

// ===== Fixture definitions =====
// Each entry: (values_hex_csv, blindings_hex_csv) → pinned proof hex.
// blindings are hardcoded (not RNG-derived) so reproducibility doesn't
// depend on the RNG choice for them — only the internal randomScalar calls
// (alpha, dL/dR per round, r, s, d_, eta) consume RNG.

const FIXTURES = [
  {
    m: 1,
    values: [12345n],
    blindings: [
      0x1111111111111111111111111111111111111111111111111111111111111111n,
    ],
    proof_hex: null,           // populated on first run
    commit_hex: null,
  },
  {
    m: 2,
    values: [100n, 200n],
    blindings: [
      0x2222222222222222222222222222222222222222222222222222222222222222n,
      0x3333333333333333333333333333333333333333333333333333333333333333n,
    ],
    proof_hex: null,
    commit_hex: null,
  },
  {
    m: 4,
    values: [1n, 2n, 4n, 8n],
    blindings: [
      0x4444444444444444444444444444444444444444444444444444444444444444n,
      0x5555555555555555555555555555555555555555555555555555555555555555n,
      0x6666666666666666666666666666666666666666666666666666666666666666n,
      0x7777777777777777777777777777777777777777777777777777777777777777n,
    ],
    proof_hex: null,
    commit_hex: null,
  },
  {
    m: 8,
    values: [0n, 1n, (1n << 32n), (1n << 63n), (1n << 64n) - 1n, 42n, 1337n, 999_999_999n],
    blindings: [
      0x8888888888888888888888888888888888888888888888888888888888888888n,
      0x9999999999999999999999999999999999999999999999999999999999999999n,
      0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaan,
      0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbn,
      0xccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccn,
      0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddn,
      0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeen,
      0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0fn,
    ],
    proof_hex: null,
    commit_hex: null,
  },
];

// Pinned hex captured from a clean run with the seed above. Update by
// deleting these lines, re-running, and pasting the printed output.
FIXTURES[0].proof_hex  = '0390c2f2dbf975b12b7db2130f732da303c6378c4a94525864b7383e0d972b75e103cc5e65ebc94883e6519edf767e088a02e355be537f350edb45ac645d4fce5a8c03531822c3aac6976066829f496637093aa55b4b61566e0e9931293c287e6b823f5570030b011e344bb975e0364545b2c35adf88f4c2338abe65b042d5f7d2c2a07b2aa9aaa582ec3801020aa93828281dc8a498f3305d51efee7087c3175690a2a4cee8c65ea6af0d9e997717b0ea9d60e74f4afe1bb9ce56b7c2760aafa93c77024cbba8d517f564c02dab17ac735efdd59e190be848e06f4f8c4bfd6d9f5bb1b902d2ac3303a3b728bd58aa8aff3b43f47b0c7499b146e02a5c14053b16bcaf654502ddb3b0b1d5a08449da6f2428acabaa8c976eb37c99200c52de52d8f7f4adab1202fb75c30a1f8e52ed8f2c79674bde62304205f80c50544c66768517b7131ce30e02b69c22dce736480923af1c68c82573f00f1a5c655aa7dee5d997c4aea4d24de3024b868b642e4601a7b9ea6d6fd3be5c0cecab1a8472a2fb45a597db4b58c1aba203d4c5d986bd4626709215e7b7751e8c330690bab19d8d36aa5f600bdfdfc3e07203e33ee4cb43b4cef2fbe10adbff85e8eb0962dce493152950195c823c7f12781b020f1fa7970a518434dc6421c4eea1dcd6bbac907cc5fd1fd9f91d3b4b514dcd41038c504892b9056b4a67a9ff234668f9518f7c9f3aaef0bc84d584b96616f54e33034ce20e71fec7f7444b6ce0b3d66cc68cdec5915ba5d255daf810d9f0f82cfc1d0265c52e80c3ed8b8310407ef3bb04b0ab28be4810fcd069a5a2a557e1448a6edb';
FIXTURES[0].commit_hex = '0395befebc5e316ffe3fe29d394360a2b8a291bfea002f7562b0d3c9b500ffdc51';
FIXTURES[1].proof_hex  = '03d58a03174f45734e7033adb01f2c617bb98bd0e450d135ff80726dc3f3b128d102192ee056015fa16459e5e7aa0c6525497a7e9a83410c0ed1fe0569a5293a58c003cf31eefbc1a5b799d4023d77e25f21b1f20eb68385285d417d90e5e7b8a84f55d6b8b0520b4a754505401564ad6695a52d9654fd1e81eee1da5b6338e8eb929b491aadda2854e7decf582eac8c6e0d96eac7b725229d8f70d10fc575ba81c6279e03b4ef042dc69ebff4f88b23b9ef5bed7ef426c0bed501ce3a8a7046b5b00603fdcd9ab9caec7bff66d6a97aae50010dfd9b10fe980a97925ac7dacc7e67ab470248df62292ac79efd237a41333a18c56600ae83a6124d0ccc2e32b1937319352702cb76ddd469328a998ba2fc8006f0b920c27d1d1e670021cafd7c2216806f9be103b08da8706ce5867ecea32ce99ad6fe5803b0aef6ca117d677730a69638db2dce021da92e49ef0990a610f6debd1ca562aee76b3b032f97ffed7b015bbb26968b2e021435d369d248b819e6a122387ddd95108221687884ed5e0c2935d8d773519b4902baa764dcd6973fb08956d14271cf3697df7e2eb37b75072a39960c00655c18e3026ecfde97c28ade8142862ae4a2c51ddbbefc097a1de72b8edfbc40aeaf50083802177f1afa27cbb246aa150086a29781f278a4e8c08db6919cf2a8d3897cf6931a03c3294c26e7eabdebe127f83cdda32bf43520e750e70f7fd27ea26d655e6e88fb0307b4fe87b6a5740752598d5c039d8b31b7b96d40a043ef75cedc7fef47ea3f090285527171cec1f5f74c560f6a6ca87d90b352bcc18864e08581d9b8e448af57980373b19ad9610024791da2160c20bbd3b0df96456fb298e9a0180aa509b50752dc0332798efde3ec38db08572248f8d3e25ece9cebdc95f9e08bef92f0177b54b283';
FIXTURES[1].commit_hex = '03a3930cbdce518e9f4e0801b4537a69e18335ea8ac634b8b634f60e95675d0e8e,0285080d11d7e2e4b521132c7772bd37a9047ffce40ced88c2a067c156006d7b1e';
FIXTURES[2].proof_hex  = '0211960c6a27861628ca8efb2dd4e8070256bea1232aaad12e824cec42f98fd7b4031a9e606f34128782c836c35a635fb2e82467fdf7bba756b31e8f2430e1bde60e0322edde87af72d392e9be1ecea58800151ea3fd3215f97ecc4982849f632671569ad66c083981c4dc497acb99da6dc157a8749aff292b5b6719cacdcca8b8ad9b555e415ec04ef1d7e0f4dac7688116e7c5e18bd1b5e0d6764d9a23c77a4b76827197dfeaf2774a9098505d731a7ee27c621ac0d180539e332301476078a6d402037820dd31f9a46cf38ae70215e1f1707c6752c367fe9b29846e820520544a1d9d03a9766f65139dc4588e471e413394ef2542f4da898107f9d8f797ac5d42fc487f03ac50f006716d47d1149825eef6d4fa62932c0a0e63c8028a02e412f7893587f6033bac64025679ea23c52b2a482a097caa29c91b70742125c93174cf7812a90408037ed40f2fddb58cb0a7d3246163dad997605c116cbf9ac8955d92591f913eff4e0292bdc88b430075028e9b1c7ed89a89056d3e6f956eeed206e023b3ace712869f0243de394b3fccc997fca06843f04efd167251f8b695cb883b7089d1e32854015403be98a540c0fd6071c5da564a1cf789ca51053af8dc40ad9f6d0e55907c1eef0d0292a5d6f408b181353134b3098d9250e28068fbcf930083891f51fc5860f0ab60022961cb52eca636dc7b35d551dcd79ff6a1946e88084fea906ddb587cfbef1c6602a1cd27d379fc92917728c4bd58c9732933ec305a0aca62c3b211d7403f7e951303cb2ca6574e4bcdc30b784410782ee959d47c862116e5e5c06e3adcf242b83f9003754d6181c444232ebb686756616a54dc7ec84b181aa6de013aef8b590b41267202d57c46fc5015d6d317aec27a93f11a42a9ab9d16ac1a1ab6d832e42ced928cd40340a8305188e4e4afe137c8a4bfd9d84c16acd0306d7dd61a3e9ba248b023e631030f7cbf9df6ebbcbb173f10631bbf2e10e88d27b92b9f778d33f5dcf254727dbb';
FIXTURES[2].commit_hex = '0387c113ab780cffda13bb0513dbaabbeb59a2e126177c7023132d2e9a9e002750,03f4d75363982f1d57fcbaa0cb8bbb1d5aebfa3282efe236a10bb8eb69bc84a499,03b85524212f5a186c5aa2ea04f2809d5a16244975a36a7b805632568c0d1be2f2,037ef4af7e48cf4ceb4ace315c714933938dbf7490fdedf05dbf33f997888ec119';
FIXTURES[3].proof_hex  = '0330c93c9da5665e20819522d995d3b44c35c54d822679b7bd606004c7ddffe39c03415c45ffa043bd10fdeb20c71fb6288846797ffa109673e2e50e3041101bb4590311bbd8c74696c3f587661e1bf45a30de898891b8ad1279c46675e8a77544bf7bcc14dd9f312cfbd0d01c54dfece76999c3ced2d1bdbb1c944a816997a32e70578f540fc38c548c81a57d8585125018f4b8dcf37c740dd1b31632c7f17d67fa29b511767af2dfe67552d472ca10a277e085bede3bbcd3faacc48373c9a3e5ce9102c6131b9dec878b7e7b101d9550c51ef490c90fc51a573db60ac1b4a3eaa583cd0296940a0a9ed4a920dd4f43a32d77c2e93a69af74badadbcc1d68e138c713795002846c7386670bf506e12c71f299beafd8d5fcb42772a6d82c30e8a1c32500f19c0297607463625f66a119b0bd09974215e9f1d8ce97f1fad40c9ef0ffb56527d27403ccf9c96ada3300343559488cf42bd7d980b6a1d653b45388abe43772a28e0ec003b5634a2c7560a1a7b30088bb0e1445ccea4d790ac011d31cd093ca5f1d32b29c03daaa6fd1d8afabc0df2f3d3ab815e40d8def70ed7e4254e7266afcadd8d47328036950fa4bffbd7767170de29d04b84b8b5cf0bdc4734c3c0b35af8fb12307b8620258b66367d2f4578ceaebc60363f70625ef6d72d2e6e10bfdbc1c196dd60f28550232b6a7f918143027303589467ee4c4391d1825904a807a4af9fdab961c9d565902d255921f5949471c3eeae03667109049d63dbfbe757f9b7de57c18062832fada02b96de288930bb8c0dc54239b03be48b1d223ca9eb9df38f053f2ffc963f5746903fd32ca13a2d826ad77c2f23db31d6be3a805f41af5f873215025c975500452cd036a92ccac50ad751f01cd23da59850eb499f16fd39259f50e95745156d7dbff1102bc4edda760e94bf0e74d68c34c340fc5c0865cf719d42cb2905cc9f96527d5e903b97f77cf42d23e7b22e608934934938fbc611d993973fa5ae3ff869fb911be5e03a86b35a0f4618c7394fa8358a4cdaa88a290ad68b7e0bbe506ac23f15edb77c00373faa6ff12c5f2b43710c64fae2eea0676c2f9123ca504741ac19eb30c8e46a0';
FIXTURES[3].commit_hex = '021617d38ed8d8657da4d4761e8057bc396ea9e4b9d29776d4be096016dbd2509b,029a393a58d9694caab56e032a2ebb5adbe8352aa7b9e132f0ee42735743ad8983,02adcba739156e146190987393012d7ba7bf06544b6ca8ec5eacca8cf8049f9063,03797fa672da19ae21967044d050c4dbfcb39b0e3a56337dea42d23ffbbeecc92a,029d0a50de3e10adef23621a454fb29a4d77c83b5b99b381885b6181ad276b3fbc,02f56805a72ec7b742c49ccef5e901319778c7779063fe09069022d8be8ec9b0e1,02c57c816b9e1428c2603891d5593d0c9ab4457e62cfe3365741cf4ccbf26b2608,0242665f3ffb8f5ee3d926f522fef69bf8f5ba883cdf5763b5f0f8be0661087f9f';

group('Determinism + reproducibility');
{
  // Run prove twice with the same seed — proofs MUST be byte-identical.
  resetRng();
  const a = bpp.bppRangeProve([7777n], [0xabcd1234n]);
  resetRng();
  const b = bpp.bppRangeProve([7777n], [0xabcd1234n]);
  ok('same seed → byte-identical proof', bytesToHex(a.proof) === bytesToHex(b.proof));
  ok('same seed → byte-identical commitments',
    bytesToHex(bpp.pointToBytes(a.commitments[0])) ===
    bytesToHex(bpp.pointToBytes(b.commitments[0])));
}

group('Pinned proofs at each m');
const captured = [];
for (const f of FIXTURES) {
  resetRng();
  const r = bpp.bppRangeProve(f.values, f.blindings);
  const proofHex = bytesToHex(r.proof);
  const commitHex = r.commitments.map(c => bytesToHex(bpp.pointToBytes(c))).join(',');
  captured.push({ m: f.m, proof_hex: proofHex, commit_hex: commitHex });

  ok(`m=${f.m}: proof length matches BP+ spec`,
    r.proof.length === 99 + 96 + (Math.log2(f.m) + 6) * 66);
  ok(`m=${f.m}: prove → verify round-trip`,
    bpp.bppRangeVerify(r.commitments, r.proof) === true);

  if (f.proof_hex && !f.proof_hex.startsWith('__PIN_')) {
    ok(`m=${f.m}: proof hex matches pinned fixture`,
      proofHex === f.proof_hex,
      `got ${proofHex.slice(0, 32)}…${proofHex.slice(-16)} expected ${f.proof_hex.slice(0, 32)}…${f.proof_hex.slice(-16)}`);
  } else {
    console.log(`  (m=${f.m}: no fixture pinned yet — captured for review)`);
  }
  if (f.commit_hex && !f.commit_hex.startsWith('__COMMIT_')) {
    ok(`m=${f.m}: commitment hex matches pinned fixture`,
      commitHex === f.commit_hex);
  }
}

group('Pinned generator hex (SPEC §3.1, extended)');
{
  const { Gvec, Hvec, H } = bpp.bppGens();
  // Extended KAT: the original smoke test only pins Gvec[0] / Hvec[0].
  // Pinning [0..3] makes silent index-encoding drift loud.
  const PINNED_G = [
    '025cfa02a4913b0b122c4f275ae566e6ba52627d80036e25a43a3fd5d2062f28d4',
    '027608f5161dd88146ab22635ad357622a7e3fd9a293efd6fc21d18b50efab7c4e',
    '022f8c08dda9ade0264065a6770b219a5ee82c872f627d4503c4c3292472f1fb23',
    '02add28339b32e0e27075cb6cdee409acf07860ba5bf7cdca07cabf50947ed5a55',
  ];
  const PINNED_H = [
    '02b78ed462f5c137b05d1e99daeb2619eb890ec4781acf098018628ca0ec0d20e2',
    '02ac4ee8f1ded833bf18be0815b9602b4fe0d586ade57923b35ef22e3e7c1e6ce2',
    '02795d359afdced0c4c7735bf61f24cdab214d43301f5210eefd46b96657a708a8',
    '02b65a170dfd727dd403cda635ddd2419882da910f6f79e10b24c4e5f3d171c76c',
  ];
  const PINNED_H_VAL = '02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56';

  ok('H matches SPEC §3.1', bytesToHex(bpp.pointToBytes(H)) === PINNED_H_VAL);

  for (let i = 0; i < 4; i++) {
    const gi = bytesToHex(bpp.pointToBytes(Gvec[i]));
    const hi = bytesToHex(bpp.pointToBytes(Hvec[i]));
    if (PINNED_G[i].startsWith('__G')) {
      console.log(`  (Gvec[${i}] unpinned — captured: ${gi})`);
    } else {
      ok(`Gvec[${i}] matches pinned`, gi === PINNED_G[i], `got ${gi}`);
    }
    if (PINNED_H[i].startsWith('__H')) {
      console.log(`  (Hvec[${i}] unpinned — captured: ${hi})`);
    } else {
      ok(`Hvec[${i}] matches pinned`, hi === PINNED_H[i], `got ${hi}`);
    }
  }
}

// Print captured proof hex so first-run fixture insertion is mechanical.
console.log('\n--- captured fixtures (paste into FIXTURES[].proof_hex / .commit_hex above) ---');
for (const c of captured) {
  console.log(`m=${c.m}:`);
  console.log(`  proof_hex  = '${c.proof_hex}'`);
  console.log(`  commit_hex = '${c.commit_hex}'`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
