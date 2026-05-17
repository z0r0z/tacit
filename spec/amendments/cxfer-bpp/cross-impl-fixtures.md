# Cross-implementation byte-equality fixtures

Pinned proof bytes from two independent Bulletproofs+ implementations on secp256k1: the production JS port at [`dapp/bulletproofs-plus.js`](../../../dapp/bulletproofs-plus.js) and the blind Python re-derivation at [`python-port-blind.py`](python-port-blind.py).

Both implementations were exercised with the same deterministic RNG sequence: 32-byte chunks of `sha256("bpp-test-rng-v1" || u16_be(i))` for `i ∈ [0, 64)`. The RNG consumption order in both is: `alpha`, then per inner-product round `(dL, dR)`, then final `(r, s, d_, eta)`.

**Result: byte-identical proofs at every supported aggregation level.**

This is verified mechanically by `tests/bulletproofs-plus-python-parity.test.mjs` (JS side) and by running `python-port-blind.py` directly (Python side). Any future change to either implementation that drifts a single proof byte trips both tests.

---

## Test inputs

| m | values | blindings |
|---|---|---|
| 1 | `[12345]` | `[1]` |
| 2 | `[100, 200]` | `[2, 3]` |
| 4 | `[1, 2, 4, 8]` | `[4, 5, 6, 7]` |
| 8 | `[0, 1, 2³², 2⁶³, 2⁶⁴−1, 42, 1337, 999999999]` | `[8, 9, 10, 11, 12, 13, 14, 15]` |

---

## Pinned generator hex (both implementations agree byte-for-byte)

```
H        = 02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56
Gvec[0]  = 025cfa02a4913b0b122c4f275ae566e6ba52627d80036e25a43a3fd5d2062f28d4
Hvec[0]  = 02b78ed462f5c137b05d1e99daeb2619eb890ec4781acf098018628ca0ec0d20e2
```

These match the pinned hex in `SPEC.md §3.1` exactly.

---

## Pinned commitments and proofs

### m=1

**Commitments**
```
V[0] = 02822186317fe866c9bdbc024abf9908ac8baf13494fb6435dade371a47cc13bd7
```

**Proof (591 bytes)**
```
0256368b1f63fa00258e7336dd43f0ace79f6c6170701aaa0ea516c38702b6770c
0387a208d7844e29c3e14ce9376c7b00888d8c056bc830107b90cadf43ea5213b0
03e33b05c26b442f12c471ca934b7e65c56f92d09fca576b23427e444dfe6d8c81
24c4ce1bd03999b3de3f340cc798333bedcb6dd89f43249d5e865fd2d1c91eca7f
d858099c962e4506343e97dcb924fe26afac832a329270e5a5884c7674747beb83
5ea76f28bdc6abbbd0c7d61ec6bb12ca86f658133ebb45a92dad38c68cc6
0306 38bda9c809077becb2840fb7e626d245ad94d4dc2412d223c24c5e1ede8e18
02fa7c4ac2bb833c506c35bdc2c7668a2539de7d6efde1ca516d2b9ce40de981b0
0374f0fb379ac3dd8a96ec999138a77c428e6da6ed37f84d59fe1c5be38b93f2b8
02827fc7f610da99889ed024a80244eaf02eeefc48c74acf2f32f637440087345b
024d9c1ae09b6112d57e48363f4f4a2cc66a252d3327464086c84ed90f1fc3d668
02404be26ff56b96a160e06254ff5b80affacde97c71d8c16d62e7e41fd2192644
02db4e333b14c8fd121852058383f8c29e83c713f7858187b1923fb441bd5a9f16
020132a7e647f42d74db379f6ac0fe61b2aef1d96c242f80fdbd8f65d30190cc7c
028fa896f02b3b7c836a851ac7daba2cb7ef7ee1f114d649494fc3542c8fcd55f6
038064f7345696c8c19ffc29fccf2090a372157efc848a2896bbbdb0431b5eef2c
027124cfc6d638ba48d28881639ab19399680141d8bcddd28edd8c8a15e0a0af0d
036317dea1311eea394df6810c9db59a637f82e88c409529e0908b336b4607511f
```

### m=2

**Commitments**
```
V[0] = 03c3b0350f179cc4b2e0ef33a8bdec37c8c754b0476e75bb514c8630ecec77ef12
V[1] = 02434faeedf74e9b588864aad721635bd074560b8da8d4b8a9fa605b70407bf48a
```

**Proof (657 bytes)** — see `tests/bulletproofs-plus-python-parity.test.mjs` for the full hex string.

### m=4

**Commitments**
```
V[0] = 0295da875695a622c5edb5edb3e8038a9b8df874215f2ecc48f99ffd2057f850c8
V[1] = 02bbade8e1a736f358b8eb75227f66994595c880ac087bb85bcb721e8c5568b3b7
V[2] = 03871ad80aa06ddb374d831145080e9ea18659f2d755465700d841a538e5c41cd8
V[3] = 0208f3c97b7d98276660fae6aef722b9d773d8cfd913de47d12345d4719992e811
```

**Proof (723 bytes)** — see `tests/bulletproofs-plus-python-parity.test.mjs`.

### m=8

**Commitments**
```
V[0] = 022f01e5e15cca351daff3843fb70f3c2f0a1bdd05e5af888a67784ef3e10a2a01
V[1] = 03409f9441228957dd560d9f0c5808fffe40978e9c8e62c764b38331c541e3d812
V[2] = 03b7b2949d597decad90b2d76f6845b8739ee4dc950f5ca1fdc8022f1884db38b4
V[3] = 02e63174ebd1259d9d9cd48aebd94548c92bdac4beed084efd9810f76d796b2255
V[4] = 0339633ceb47e50d4e5d04347625e1e6cb742b6a50e3bb876233b7ef250ca13da9
V[5] = 036ffbd4c4a827381e33d7688c8c40047ebc1f87b16bd62d82ff6374dff670e0cc
V[6] = 02822f8f245e054971421524ecf1084caebf4d1fa82f35ddc92157e7f9de70b5d4
V[7] = 02132c3db9b899c88031527ce47835c488893ff68f269d4cafdbab9c133c3609e3
```

**Proof (789 bytes)** — see `tests/bulletproofs-plus-python-parity.test.mjs`.

---

## What byte-equality across implementations rules out

- Generator-derivation discrepancies (would change V byte values)
- Transcript-shape disagreement (would propagate to challenges → all subsequent rounds)
- Wire-format ordering / endianness errors (would scramble the proof bytes)
- Curve-substitution drift (e.g. a missed `INV_EIGHT` in one but not the other)
- Subtle algorithmic deviations in the WIPA folds (would diverge at the first L/R pair)

It does not rule out a bug that both implementations made the same way (e.g. both correctly following Monero, but Monero itself having a soundness bug — which the BP+ paper proofs and Monero's mainnet track record argue against).

---

## Reproducing

```sh
# From the repository root
cd tests
node bulletproofs-plus-python-parity.test.mjs

# Or independently with Python
python3 ../spec/amendments/cxfer-bpp/python-port-blind.py
```

Both should produce the proof hex listed above. The two outputs are byte-identical, character-for-character. If they differ, a regression has been introduced.
