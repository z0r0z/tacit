// Cross-implementation byte-equality check between our JS BP+ port and
// an independently-derived Python port at .local/bpp-python-port/bpp.py.
//
// The Python port was hand-written by a separate agent that NEVER saw our
// JS code — only the Monero C++ reference + SPEC amendment. Both
// implementations:
//
//   1. Use the same secp256k1 curve and SHA-256 transcript
//   2. Derive generators from the same SPEC §3.1 domain tags
//   3. Implement BP+ §4.4 (Aggregated Range Proof) per the same paper
//
// If they produce byte-identical proofs given the same (values, blindings,
// RNG bytes), then either:
//
//   (a) Both correctly implement BP+ on secp256k1 (the desired conclusion)
//   (b) Both have the same bug at the same algorithmic position (extremely
//       unlikely without one referencing the other)
//
// Two independent ports converging on the same proof bytes is the
// strongest static-analysis evidence available — comparable to Monero's
// cross-impl test corpus on ed25519, but for our specific secp256k1 port.
//
// What's pinned: the Python port produced these exact proof bytes when
// run on 2026-05-18 with RNG bytes = sha256("bpp-test-rng-v1" + counter_BE_u16)
// concatenated for 64 counters. The same RNG sequence is replicated below
// in the JS test by overriding crypto.getRandomValues.

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

// Replicate Python's RNG: sha256(b"bpp-test-rng-v1" + i.to_bytes(2, "big"))
// concatenated for i in 0..63.
const RNG_SEED_PREFIX = new TextEncoder().encode('bpp-test-rng-v1');
let _rng_chunks = null;
function _initRngChunks() {
  if (_rng_chunks) return;
  _rng_chunks = new Uint8Array(64 * 32);
  for (let i = 0; i < 64; i++) {
    const counter = new Uint8Array(2);
    counter[0] = (i >> 8) & 0xff;
    counter[1] = i & 0xff;
    const chunk = sha256(new Uint8Array([...RNG_SEED_PREFIX, ...counter]));
    _rng_chunks.set(chunk, i * 32);
  }
}
let _rng_offset = 0;

// Override globalThis.crypto.getRandomValues to consume our deterministic
// stream in 32-byte chunks (matching Python's RngBuf semantics).
_initRngChunks();
const _det_getRandomValues = (buf) => {
  if (buf.length !== 32) throw new Error(`getRandomValues called with len=${buf.length} (expected 32)`);
  buf.set(_rng_chunks.slice(_rng_offset, _rng_offset + 32));
  _rng_offset += 32;
  return buf;
};
try {
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    value: _det_getRandomValues, writable: true, configurable: true,
  });
} catch {
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

function resetRng() { _rng_offset = 0; }

// Pinned outputs from the Python port. Generated with:
//   python3 /Users/z/tacit/.local/bpp-python-port/bpp.py
// using the same (values, blindings) and RNG seed as below.
//
// IMPORTANT: these fixtures are populated lazily — empty strings mean
// "not yet pinned". If the JS prove output doesn't match, the test
// PRINTS the captured hex so it can be pasted in. First-run produces
// the pinned strings; subsequent runs assert byte-equality.

const PYTHON_FIXTURES = [
  {
    m: 1, values: [12345n], blindings: [1n],
    py_V_hex: '02822186317fe866c9bdbc024abf9908ac8baf13494fb6435dade371a47cc13bd7',
    py_proof_hex: '0256368b1f63fa00258e7336dd43f0ace79f6c6170701aaa0ea516c38702b6770c0387a208d7844e29c3e14ce9376c7b00888d8c056bc830107b90cadf43ea5213b003e33b05c26b442f12c471ca934b7e65c56f92d09fca576b23427e444dfe6d8c8124c4ce1bd03999b3de3f340cc798333bedcb6dd89f43249d5e865fd2d1c91eca7fd858099c962e4506343e97dcb924fe26afac832a329270e5a5884c7674747beb835ea76f28bdc6abbbd0c7d61ec6bb12ca86f658133ebb45a92dad38c68cc6030638bda9c809077becb2840fb7e626d245ad94d4dc2412d223c24c5e1ede8e1802fa7c4ac2bb833c506c35bdc2c7668a2539de7d6efde1ca516d2b9ce40de981b00374f0fb379ac3dd8a96ec999138a77c428e6da6ed37f84d59fe1c5be38b93f2b802827fc7f610da99889ed024a80244eaf02eeefc48c74acf2f32f637440087345b024d9c1ae09b6112d57e48363f4f4a2cc66a252d3327464086c84ed90f1fc3d66802404be26ff56b96a160e06254ff5b80affacde97c71d8c16d62e7e41fd219264402db4e333b14c8fd121852058383f8c29e83c713f7858187b1923fb441bd5a9f16020132a7e647f42d74db379f6ac0fe61b2aef1d96c242f80fdbd8f65d30190cc7c028fa896f02b3b7c836a851ac7daba2cb7ef7ee1f114d649494fc3542c8fcd55f6038064f7345696c8c19ffc29fccf2090a372157efc848a2896bbbdb0431b5eef2c027124cfc6d638ba48d28881639ab19399680141d8bcddd28edd8c8a15e0a0af0d036317dea1311eea394df6810c9db59a637f82e88c409529e0908b336b4607511f',
  },
  {
    m: 2, values: [100n, 200n], blindings: [2n, 3n],
    py_V_hex: '03c3b0350f179cc4b2e0ef33a8bdec37c8c754b0476e75bb514c8630ecec77ef12,02434faeedf74e9b588864aad721635bd074560b8da8d4b8a9fa605b70407bf48a',
    py_proof_hex: '0337b4c712aa9ffbcf42720a1b52bc8710f097b25b96696fd024e7b946cbd3f99c028fae3b680fd03fea354a69e629f33f4229a9780708fd732a3a2522ac13b48484020b1390995b46e493d187bfafcebbb68178771a710dd3578e6d032b1d4d842312569d74026983c3710f932633b085166b40411dcfe4f30e9c633efeea937b590bdc6e471a68b58340bc827e24c98074f8e6d7605fe822454b0b59f7ef173f88aba9d21cf50d922dd4c44b572463c4f949d7c1464aace5b75c15e3c536cf83afa8037200b91c779d87017b55792d3b6dea3a6d25e14bee7beb633641ebc4bf14555902ed33af3d77391ad6637f2a7aa6c732e09a1ec1587219615ea42a51b81b89c1a5034a306aed9b982be15ae35079ca0a9b1c6cf42499dca8eb6514644d3d7db1d3c2038981f223a1f7701ee0eea09b9a436f98055faae6594328672120ffb46df6aff602e6bdfbda85353b231232552d56a1f823e3348121c1ebcad9cd6351511f5caa01023c77c4b18c9fdb4d82318703f301c5d7f85d4cfe735fb3d0e46f811e84164fd302d5f60c1bef4cdf00b7579fc82b3dcc7b2d34114b2b2aa1bc84ef64852b437b0603f460f35df3acb23eb263bd33561584fc36946abf3f21d9d5ec7af2c0212fcecc02883b33f27d1299e78f143d30eaff1448cf9319f0ab6f2e323e6af772ebd7ac4e024589b5d80cfce2498085264a3cd19ff5e7b91d2716570e616e896e26eebe3fa603649b5f171b9dcf0dd40b3446ac0c624490d85e04fb2861ae251157e3a33ea220024de606bd8dbcad5ce8efce956a53eb2760c111248432340aa89dd654e531bb9002067111396a6e4153ace2f5b9c0b387bc540ccb705ba62128d96719b128aa277e028e57c206c9e6316204eaf313a250063e55c1df116e4bf1ff83336dc95d57f599',
  },
  {
    m: 4, values: [1n, 2n, 4n, 8n], blindings: [4n, 5n, 6n, 7n],
    py_V_hex: '0295da875695a622c5edb5edb3e8038a9b8df874215f2ecc48f99ffd2057f850c8,02bbade8e1a736f358b8eb75227f66994595c880ac087bb85bcb721e8c5568b3b7,03871ad80aa06ddb374d831145080e9ea18659f2d755465700d841a538e5c41cd8,0208f3c97b7d98276660fae6aef722b9d773d8cfd913de47d12345d4719992e811',
    py_proof_hex: '03eee26a95371c3fd49cadfb768ec9c777b9405335c72800779a00b1c335843e9903091bd2f1cef1218f0dee2fc73d28798b15ce872fa32fee271f6f1bc85e86bdfc0398b2cf0bb3c867e576bcc2fc08cba18a77115d850262f32d87a68c941c350ad3a6ebbd9123255b9ca10511ddbfb572f46d9a53c8cb48524cc90f26f2250fcf880fed08eaa14b89661ed6a0360507abbe7afb82821e4032b22ad1d4b8564042ccb8331d914e4dde1a8f594fd680fde781d525384cb9c7b4878316ae4b2688663302cdb9829b06104cc67ac6dd1f79616335212f8b43ecb9193dd8527ea0bfa0f27f0351cdcec87406da33b9c17c9e7fe82b53cc0b444613ab881659ed689e86ad1bff02ccd91ef03597438df6ad6ca2ebcadb8c651a58a57ca05c6a652d9a4e6306c3b102c7be1e86bc476f63daaba1202093cffb273d56ff47ecbbb7acc79bc2ac92bb0f031162a105866e9086094d15935e4c635d9a97feb9eb0a50341a86a8420892f788027215e6bb5c91f225bab7e205d27bddc0fd67b640818e22fcdf7b080e559f276302db76661561f447e7022bec5f718f4529ff7af110d622e920301b473d34c4751703244f1c5d5f1dd093039b56281ad2d67a15c17d6a1dde18b6dffe39322f3edfe4031e760a414c69daea309d1f331f2d582b844e29962379d05f88a90a11d06bcc2103f398bf8fe20365826277e4f3c7a769a3a0cc12e33b3d89763414618e854677830396e1070a4f1fb9f081a842ec8951951084150bfc1d483bbef744cdcb175549fa027ab17441934326125c2a0fe262bb5f8943a9d20bec38c252d416a5b9e60cf6c8029cb7e3ad0ec57a6493774d959d12ca7e943fddc4a6466c4360c776f901edc959024c757254b698075244a5e2d2fe2d7f297acc69cd72ea31f86df0a731ef702a8c03ae3297de82bec4b58108720cde0765b1b69b79ecdffb03ec0e7a90e56f42ab8e027100a7214e39f870a3fc254b8b53ebc410d995675f33b9bb5c10614f3d813877',
  },
  {
    m: 8,
    values: [0n, 1n, (1n << 32n), (1n << 63n), (1n << 64n) - 1n, 42n, 1337n, 999_999_999n],
    blindings: [8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n],
    py_V_hex: '022f01e5e15cca351daff3843fb70f3c2f0a1bdd05e5af888a67784ef3e10a2a01,03409f9441228957dd560d9f0c5808fffe40978e9c8e62c764b38331c541e3d812,03b7b2949d597decad90b2d76f6845b8739ee4dc950f5ca1fdc8022f1884db38b4,02e63174ebd1259d9d9cd48aebd94548c92bdac4beed084efd9810f76d796b2255,0339633ceb47e50d4e5d04347625e1e6cb742b6a50e3bb876233b7ef250ca13da9,036ffbd4c4a827381e33d7688c8c40047ebc1f87b16bd62d82ff6374dff670e0cc,02822f8f245e054971421524ecf1084caebf4d1fa82f35ddc92157e7f9de70b5d4,02132c3db9b899c88031527ce47835c488893ff68f269d4cafdbab9c133c3609e3',
    py_proof_hex: '02e0df6ac4de071eb6e8bfd733dad2e64c7fa46e6bdc2485aad95845efe7c0ac4502d5b15b37fcafc243877beb06ad3f345e42db012980755897ca231c0a97724ee4038483f4b6189fbc433b941cb5435c2c6b1c4a3d284fbd757858586639954fc251119c5453da9c2e58b8024bd73e88d9a62b09c5f85a0493f96adfc29dd18e7e6ad0ab77362c0a87957fe3b5ba447a5e16d8c71ec9f490761371ab84fd2f359a831eddaf6fc6b825c29940a953ed4513cfca82119954c5a88784992a05f8d14a4f0242ebf78ebb84cc1ebfbd39ab78502f6ae9c0708cbcc4e7400a5486da5b9dff7a0206e166c3d6c8fae7515c80f52f13bb72a9b16da3eff04febd89ff74f62c641b60227f9ab2640757e90de2ed6c359f625ab6ebe7defad723b8d093d921ad9a633e40276c025c7ed61fc223245747266449d04acc32cd2bb4ca0006c1be3b614758d9a025d7144358581fafb3457cfcba0982fbce025a54ff0da6c8ca89a8fc959cb023a02b9592fd928f842d69fd5115b578b5aa4a1b9b11b41997fadac6939c6b89f0c1703a0f1277c6cb9a9b62ca2988c70fa26eccceb9464a3683610d05ef32f33e88a6a0276845a3cdeecba0196309c3bed0d7faaa6e566177a17bb812fcd53472a5a7fa603cb986393b12aee55c5eef0f612f2fe9b9648bd365484734a259e4608edbc69e502f8924e7f0b6540e4b277bd2a61ab63fb6377be2b6553dd3098248823d65da4f50304c7a33ff8b1fb2a13e69849ffde6cf8dc1bcf4507f8da2c6046dcd4dad5188503660f392a2fe67b1f853bcd2de756848300b661c32b9047de0095252dbf5a1466026f358d465e23ba8470e504932aaa5ff7f828a33368190a0d13f3732b2c2bcb08029e7ead22618beeb98bb4bcfb1466b86c47ecb6e9b20a0e076955f2c2be9661780282914de082aec974f04dd4438f3ee23c49d28d976326f061df769cf87d2fba260383e41255bdfd3f279c81222c2e81225e066ab6fe2fcaad51dfcfed1d8852925303f65f8e2426a533787c97837190cec889c9b0077a81c3546d1c1df4b765afbd77025b50df814ddb1c30e2f870426f7139913356dec2d9e2879b0a9a77fcef4efb92',
  },
];

group('JS prover with Python-equivalent RNG seed');
for (const f of PYTHON_FIXTURES) {
  resetRng();
  const r = bpp.bppRangeProve(f.values, f.blindings);
  const jsProofHex = bytesToHex(r.proof);
  const jsVHex = r.commitments.map(c => bytesToHex(bpp.pointToBytes(c))).join(',');

  ok(`m=${f.m}: proof length ${r.proof.length} matches BP+ spec`,
    r.proof.length === 99 + 96 + (Math.log2(f.m) + 6) * 66);
  ok(`m=${f.m}: prove → verify round-trip`,
    bpp.bppRangeVerify(r.commitments, r.proof) === true);

  // Byte-compare with Python output if pinned
  if (f.py_proof_hex && !f.py_proof_hex.startsWith('__PY_')) {
    ok(`m=${f.m}: JS proof byte-identical to Python port`,
      jsProofHex === f.py_proof_hex,
      `JS=${jsProofHex.slice(0,32)}…${jsProofHex.slice(-16)} PY=${f.py_proof_hex.slice(0,32)}…${f.py_proof_hex.slice(-16)}`);
    ok(`m=${f.m}: JS commitments byte-identical to Python port`,
      jsVHex === f.py_V_hex);
  } else {
    console.log(`  (m=${f.m}: Python fixture not yet pinned — JS captured for review)`);
    console.log(`     V_hex     = ${jsVHex}`);
    console.log(`     proof_hex = ${jsProofHex}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
