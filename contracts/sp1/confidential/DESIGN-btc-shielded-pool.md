# Bitcoin-native shielded pool: private payments on Bitcoin, no second chain

Status: DESIGN, reference implementation live on signet. Opcodes `0x6C`/`0x6D` are reserved in SPEC §3.10
and not enabled on mainnet. Companion analysis: `DESIGN-btc-shielded-pool-security.md`.

A shielded pool over Tacit's Bitcoin assets. Alice pays Bob: the amount, the note that funded the
payment, and the link between the two parties are hidden from everyone else. The pool lives entirely on
Bitcoin. Its state is a Merkle tree of note leaves and a nullifier set, which any indexer derives by
replaying Bitcoin. Each spend carries a proof made on the spender's own device, which every indexer
verifies natively with no Ethereum dependency.

The pool holds Tacit asset value, not raw BTC. Value enters by spending transparent Tacit UTXO notes into
it and leaves by creating new ones, and the pool conserves it exactly as the rest of the Bitcoin
metaprotocol does. BTC exposure comes from cBTC, Tacit's BTC-backed asset (SPEC §5.7), or from any
`T_CETCH` asset. The pool adds privacy and no custody: on today's Bitcoin, a transferable note cannot be
trustlessly redeemed against locked sats without a covenant or a bridge, so the pool does not pretend to
hold sats. It carries claims whose backing is whatever already backs the asset.

## 1. Why a new note model

A `T_CXFER` note is a real UTXO, and its kernel signs the spent `txid:vout` (SPEC §2.4), so a chain
observer sees which output funded every transfer. Hiding the source needs a note that is not a UTXO: an
opaque leaf in a tree, spent by publishing a nullifier that no observer can link to the leaf. The carrying
transaction's real inputs are then only the coins that pay its fee.

## 2. Keys, addresses and notes

**Primitives.** `p` is the BN254 scalar field order. BabyJubJub is circomlib's twisted Edwards curve over
`F_p`, with base point `B8` (circomlib `Base8`) generating the prime-order subgroup of order `l`.
`Poseidon` is circomlib's Poseidon over `F_p`. On secp256k1, `G` is the generator, `n` the order and `H`
the Pedersen generator of SPEC §2.1.

```
Hs(x)        keccak(x) as a big-endian integer mod n, rejected if zero
hsL(tag, m)  (SHA-256(tag ‖ m ‖ 0x00) ‖ SHA-256(tag ‖ m ‖ 0x01)) as a 512-bit big-endian integer mod l,
             rejected if zero
hsP(tag, m)  the same 512-bit integer mod p
```

**Wallet keys.** The viewing layer is secp256k1. Spend and nullifier keys are BabyJubJub, the curve the
spend circuit works in.

| Secret | Public | Role |
|---|---|---|
| `v` | `V = v·G` (secp256k1) | Viewing. Detects incoming notes and decrypts their amounts. |
| `a` | `A = a·B8` (BabyJubJub) | Spend authority. Signs spends. |
| `n` | `N = n·B8` (BabyJubJub) | Nullifier base. Derives each note's nullifier key. |

A pool address is `V(33, compressed) ‖ A(32, packed) ‖ N(32, packed)`, 97 bytes, written as bech32m with
HRP `bp` on mainnet and `tbp` on signet (without BIP-173's 90-character cap). `A` and `N` must be
non-identity points of the prime-order subgroup. An address is given out once and reused freely. Only `a`
can spend.

**Internal address.** A fourth scalar `v_int`, with `V_int = v_int·G`, gives the wallet an internal
address `V_int ‖ A ‖ N`. The wallet pays its own change and padding there and never gives it out. Notes
paid to it have the same spend and nullifier keys as any other note of the wallet, and are found only
under `v_int`. Viewing tiers:

| Keys | Sees |
|---|---|
| `v` | Incoming notes to the external address and their amounts |
| `(v, v_int)` | Also change and padding, so what each spend sent out |
| `(v, v_int, n)` | Everything above, and which notes are spent |

**Derivation.** The wallet derives every key from one 32-byte seed, with the network (`mainnet`,
`signet`) in the hash, so one seed's wallets on two networks are unlinkable:

```
v         = Hs("tacit-btc-pool-wallet-view-v1"          ‖ network ‖ seed)
v_int     = Hs("tacit-btc-pool-wallet-view-internal-v1" ‖ network ‖ seed)
a         = hsL("tacit-btc-pool-zk-wallet-spend-v1", network ‖ seed)
n         = hsL("tacit-btc-pool-zk-wallet-nk-v1",    network ‖ seed)
exit_root = keccak("tacit-btc-pool-wallet-exit-v1" ‖ network ‖ seed)
```

Exit keys come from `exit_root` through a counter (§6), and exit openings and the ephemeral scalars of a
spend's outputs from the seed and the spend (§3), so a wallet recovers everything it holds from the seed
and chain data.

**Creating a note for an address.** The sender picks a fresh secp256k1 scalar `e` and computes:

```
E       = e·G                                    pk_eph, 33-byte compressed, published
s       = compress(e·V)                          33-byte shared secret, never published
t_a     = hsL("tacit-btc-pool-zk-auth-tweak-v1", s)
t_n     = hsL("tacit-btc-pool-zk-nk-tweak-v1",   s)
rho     = hsP("tacit-btc-pool-zk-rho-v1",        s)
k       = keccak("tacit-btc-pool-zk-aead-v1" ‖ s)
Ak      = A + t_a·B8                             the note's spend key
NK      = N + t_n·B8                             the note's nullifier point
npk     = Poseidon(Ak.x, Ak.y, NK.x, NK.y)
asset_f = SHA-256("tacit-btc-pool-zk-asset-v1" ‖ asset) mod p
leaf    = Poseidon(asset_f, v_amt, npk, rho)      32 bytes, published
ct_note = AEAD_k(v_amt(8, BE))                   24 bytes, published
```

The note has no value commitment: `v_amt` sits inside the leaf, hidden by `rho`, which only the sender
and the recipient can derive. The recipient recomputes `s = compress(v·E)` and the same tweaks, then
holds:

```
sk_note = a + t_a (mod l)          Ak = sk_note·B8, signs spends
nk_note = n + t_n (mod l)          NK = nk_note·B8, canonical: 0 ≤ nk_note < l
```

Because `e` is fresh, `leaf` and `pk_eph` are fresh on every note and cannot be linked to the address or
to each other without `v`. The sender knows `Ak`, `NK`, `rho` and `v_amt` but not `a` or `n`, so it cannot
sign for the note or compute its nullifier.

**Nullifier.**

```
nf = Poseidon(nk_note, leaf, leaf_index)          leaf_index < 2^32
```

`nk_note` is secret, so no observer can precompute `nf` from the public leaf. It is also unique per note:
the leaf commits `NK` through `npk`, and the relation requires `0 ≤ nk_note < l` with
`NK = nk_note·B8`, so exactly one value satisfies it. With the position included, each appended leaf of
non-zero value has exactly one nullifier, whoever proves the spend. Every leaf is fully funded when
created, so two identical leaves are two notes and both are spendable.

**AEAD.** Encrypt-then-MAC over keccak: keystream block `i` is `keccak(k ‖ i(2, LE))`, the ciphertext is
the 8-byte plaintext XOR the keystream, and the tag is `keccak("tacit-btc-pool-zk-aead-tag-v1" ‖ k ‖ ct)`
truncated to 16 bytes and compared in constant time. `k` belongs to one note.

**Receipt.** A note belongs to a wallet when `ct_note` decrypts under that wallet's `s`, and `leaf`
equals `Poseidon(asset_f, v_amt, npk, rho)` with `npk` and `rho` derived from `(A, N)` and `s`. A note
that fails either check is not received. A sender who seals the wrong amount only makes their own payment
undeliverable.

## 3. Opcodes

All integers on the wire are little-endian unless marked otherwise. Both envelopes ride the standard
Tacit carrier (SPEC §3.1). A field element on the wire is 32 bytes big-endian. Canonical parsing requires
every leaf and every nullifier to be a non-zero field element below `p`, every `pk_eph` and every
boundary's `C_secp` to be a valid compressed secp256k1 point, and no trailing bytes.

**Boundary.** Transparent notes are secp256k1 commitments; pool value enters and leaves the circuit as
BabyJubJub commitments. Each crossing carries:

```
boundary = C_secp(33) ‖ C_bjj(32) ‖ sigma(169) ‖ bpp(591)                     825 bytes

C_secp = v·H + r_s·G                  secp256k1, compressed
C_bjj  = v·H_BJJ + r_b·G_BJJ          BabyJubJub, packed; Tacit's NUMS generators (SPEC §2.8)
sigma  = the cross-curve Camenisch–Stadler proof of one amount in C_secp and C_bjj (SPEC §2.8)
bpp    = a 64-bit Bulletproofs+ range proof on C_secp
```

The indexer verifies the boundary natively: `C_bjj` is a non-identity point of the prime-order subgroup,
`sigma` verifies, and `bpp` verifies. The circuit range-checks the BabyJubJub side below `2^64`, and `bpp`
the secp256k1 side, so the sigma's equality modulo each group order is integer equality. At a shield,
`C_secp` is the pool side of the kernel and `C_bjj` enters the proof as `depC`. At an exit, `C_secp` is the
new transparent note and `C_bjj` enters the proof as `exitC`.

**`T_BTC_SHIELD` (0x6C): move transparent notes into the pool.**

```
0x6C ‖ asset(32) ‖ n_in(1) ‖ n_out(1) ‖ output(89)×n_out ‖ boundary(825) ‖ kernel_sig(64) ‖ proof_len(2) ‖ proof

output = leaf(32) ‖ pk_eph(33) ‖ ct_note(24)
```

`1 ≤ n_in ≤ 8`, `1 ≤ n_out ≤ 3`, and `body` is every byte before `kernel_sig`. The carrier's
`vin[1..n_in]` are the transparent notes being shielded, all of `asset`. With `E = C_secp − ΣC_in`, `E`
must not be the point at infinity, and `kernel_sig` is a BIP-340 signature under `x(E)` over:

```
SHA-256("tacit-btc-pool-zk-shield-v1" ‖ (txid ‖ vout_LE)×n_in ‖ body)
```

This is the `T_CXFER` kernel (SPEC §2.4) with the boundary's `C_secp` as its only output. Each `txid`
uses the byte order that kernel uses, the order a transaction input serializes it (the reverse of
display hex). The kernel signs the body, so every output and the boundary are fixed by it. The proof shows
that the outputs carry exactly the value committed in `depC = C_bjj`: it runs the spend relation (§4)
with `root = 0`, every input slot empty and no exit. A shield can pay up to three addresses directly. The
carrier creates no transparent outputs of `asset`. To shield part of a note, split it with `T_CXFER`
first.

**`T_BTC_SPEND` (0x6D): pay, exit, or both.**

```
0x6D ‖ asset(32) ‖ h_anchor(4) ‖ bind(36) ‖ n_in(1) ‖ nf(32)×n_in ‖ n_out(1) ‖ output(89)×n_out
     ‖ has_exit(1) ‖ [exit(861)] ‖ has_want(1) ‖ [want(44)] ‖ proof_len(2) ‖ proof

bind   = txid(32) ‖ vout(4)                                          all zero for none
output = leaf(32) ‖ pk_eph(33) ‖ ct_note(24)
exit   = exit_vout(4) ‖ dest_spk_hash(32) ‖ boundary(825)            present iff has_exit = 1
want   = vout(4) ‖ value(8) ‖ spk_hash(32)                           present iff has_want = 1
```

The constraints are `1 ≤ n_in ≤ 2`, `0 ≤ n_out ≤ 3`, `has_exit ∈ {0, 1}`, `has_want ∈ {0, 1}`,
`n_out + has_exit ≥ 1`, and `proof_len ≤ 4096`. The pinned proof system fixes the proof's length (2,080
bytes for Halo2-KZG), and a proof of any other length does not verify. `body` is every byte of the payload
before `proof_len`.

- **`bind`** is `txid ‖ vout_LE` of an outpoint the carrier must spend, at any input, or 36 zero bytes for
  none. `txid` is in the kernel's byte order. A relayer quotes one of its own UTXOs as `bind`, so only that
  relayer can post the payload (§6). With `bind` zero, anyone may carry the payload in their own
  transaction, which reproduces the same effects and moves no value.
- Each **output** appends a leaf: a payment, change, or a relayer's fee.
- An **exit** creates a transparent Tacit note `(asset, C_secp)` at the carrier's output `exit_vout`,
  whose amount stays hidden. It requires `SHA-256(scriptPubKey of exit_vout) = dest_spk_hash`. The body is
  signed, so nobody can move the exit to another output index or another script. The exit carries no
  `ct_note`, since only the exiter knows its opening, so it pays to a script the exiter controls. Paying
  someone else afterwards is an ordinary `T_CXFER`.
- **Outputs and an exit together** give a partial exit: take part of a note out and keep the change
  shielded, in one spend.
- A **want** requires the carrier's output `vout` to pay at least `value` sats to a script whose SHA-256 is
  `spk_hash`. It moves no pool value. It lets whoever carries the spend pay the spender in sats for it:
  exit to a maker's script with a want of the price (§9).

**Derived openings.** A wallet derives a spend's secrets from the seed and the spend's first input, so
they are recoverable without local state. With `nk_0` and `nf_0` the first input's `nk_note` and
nullifier, each 32 bytes big-endian:

```
e_j    = Hs("tacit-btc-pool-zk-eph-v1"       ‖ nk_0 ‖ nf_0 ‖ j(1))                          output j
r_s    = Hs("tacit-btc-pool-zk-exit-secp-v1" ‖ nk_0 ‖ nf_0 ‖ exit_vout(4, BE) ‖ dest_spk_hash)
r_b    = hsL("tacit-btc-pool-zk-exit-bjj-v1",  nk_0 ‖ nf_0 ‖ exit_vout(4, BE) ‖ dest_spk_hash)
```

`r_s` and `r_b` are the exit boundary's blindings, and the boundary's sigma draws its nonces from `nk_0`.
A recovering wallet finds its spends by their nullifiers, recomputes `r_s`, and opens the exit as
`v_exit = Σ v_in − Σ v_out`, checking `C_secp = v_exit·H + r_s·G`. It reads `v_in` from its own notes and
`v_out` of its change and padding under `v_int`. An exit that shares a spend with a payment to another
address also needs that payment's amount: from the payment record, from the recipient's address (with
`e_j` the wallet reopens that output), or by a bounded search over the third-party total. `nf_0` is
spent once, so every derived value is fresh per spend. A shield samples its `e`, `r_s` and `r_b` fresh.

**Carriers.** A `T_BTC_SHIELD` rides `vin[0]`, because its shielded notes are `vin[1..n_in]`. In a
carrier with a shield, only `vin[0]` is read. A `T_BTC_SPEND` may ride any input whose witness is a Tacit
envelope leaf, so one Bitcoin transaction can carry many users' spends. The indexer processes a
transaction's pool envelopes in input order, each accepted or rejected on its own. Within one transaction,
each output can be claimed by at most one accepted exit or want. An exit is rejected when the carrier's
`vin[0]` holds a transparent Tacit op, so an exit never claims an output that op creates.

## 4. The relation

One relation proves every shield and spend: a join-split with two input slots and three output slots over
the depth-32 Poseidon tree. It is specified by `dapp/circuits/btc-pool/spend.circom` and implemented as a
Halo2 circuit in `btc-pool-halo2`, which proves the same statement over the same twelve public inputs. Its
reference model is `dapp/btc-pool-zk.js`, with Rust twins in `btc-pool-zk-core` and `btc-pool-halo2`.

**Public inputs**, twelve field elements in this order, each derived by the indexer from the envelope and
its own state:

```
root, bodyHash, asset_f, nf[2], outLeaf[3], exitC(x, y), depC(x, y)

root      R[h_anchor] for a spend; 0 for a shield
bodyHash  SHA-256("tacit-btc-pool-zk-body-v1" ‖ body) mod p
nf        the body's nullifiers, padded with 0
outLeaf   the body's output leaves, padded with 0
exitC     the exit boundary's C_bjj; the identity (0, 1) without an exit
depC      the shield boundary's C_bjj; the identity (0, 1) for a spend
```

**Input slot `i`** is empty iff `nf[i] = 0`. An empty slot has value 0 and nothing else about it is
checked. A non-empty slot proves:

1. `v_i < 2^64`.
2. `0 ≤ nk_i < l` and `NK_i = nk_i·B8`.
3. `leaf_i = Poseidon(asset_f, v_i, Poseidon(Ak_i.x, Ak_i.y, NK_i.x, NK_i.y), rho_i)`.
4. If `v_i ≠ 0`, `leaf_i` is a member of `root` at `index_i` in the depth-32 Poseidon(2) tree. Always
   `index_i < 2^32`, by its bit decomposition (a larger index would pass the same membership check under
   a different nullifier).
5. `nf[i] = Poseidon(nk_i, leaf_i, index_i)`.
6. A valid EdDSA-Poseidon signature under `Ak_i` over `bodyHash` (circomlib `EdDSAPoseidonVerifier`).

A non-empty slot of value 0 skips membership only. It consumes nothing and adds nothing, which lets a
wallet pad to two inputs with a zero-value note.

**Output slot `k`** is empty iff `outLeaf[k] = 0`, and then carries value 0. A non-empty slot proves
`v_k < 2^64` and `outLeaf[k] = Poseidon(asset_f, v_k, npk_k, rho_k)`.

**Boundary values.** `exitC = v_exit·H_BJJ + r_exit·G_BJJ` and `depC = v_dep·H_BJJ + r_dep·G_BJJ`, with
`v_exit, v_dep < 2^64` and `r_exit, r_dep < 2^251`. The identity forces the value to 0.

**Conservation.** `Σ v_in + v_dep = Σ v_out + v_exit`. Every term is below `2^64` and there are at most
seven, so the field equation is integer equality.

**Spend authority.** The signature is `R8 = r·B8`, `h = Poseidon(R8.x, R8.y, Ak.x, Ak.y, bodyHash)`,
`S = r + 8·h·sk_note mod l`, with `r = hsL("tacit-btc-pool-zk-eddsa-nonce-v1", sk_note ‖ bodyHash)`. The
witness holds the signature, never `sk_note`, so a prover can prove only the body the owner signed. Every
public field of the envelope is inside `body`, so `bodyHash` binds them all.

**Indexer rules outside the circuit.** The circuit allows one note in both input slots; the indexer
requires non-zero nullifiers to be pairwise distinct, which stops it counting twice. A spend has at least
one non-empty input, and a shield has none.

**Proof system.** Halo2 with KZG commitments over BN254 (PSE `halo2_proofs` v0.3.0, SHPLONK multi-open,
BLAKE2b transcript), k = 13. The SRS is the pinned Hermez `pot18` powers of tau, converted without new
randomness; there is no circuit-specific setup. The wire proof is the transcript, exactly 2,080 bytes. The
verification key is pinned by `vk_hash = BLAKE2b-512(vk.bin)` in `dapp/btc-pool/pin.json`, together with
the SHA-256 of `vk.bin`, the params file and the prover wasm. Proving and verification keys are derived
deterministically from the SRS and the circuit, so anyone can rebuild and check them. The wallet proves on
the user's device (one browser thread, 12–15 s on a laptop) and checks its own proof before handing it out. A device
that cannot prove may delegate the witness to a prover running the same circuit.

**What a prover learns.** A delegated prover learns the openings, leaves and `nk_note` of the notes it
proves, the output openings, and so which leaves are spent. It holds signatures and `nk_note` but never
`a`, `n` or `sk_note`, so it cannot redirect the spend: any change to the body changes `bodyHash` and
invalidates the signatures. It also cannot link the owner's other notes, because each note's `nk_note`
and `Ak` are masked by independent tweaks without `a` and `n`.

## 5. Replay and acceptance

An indexer keeps a Poseidon tree of leaves, a nullifier set, the root after each block, and an undo log
per block. It processes envelopes block by block in canonical transaction order. An envelope that fails
any check changes nothing.

**Block data.** The indexer reads blocks from a source it does not trust:

- it validates the header chain by proof of work from a pinned checkpoint, and follows the most-work chain;
- it checks each block's transactions against the header's merkle root and its coinbase witness
  commitment, since envelopes live in witness data;
- any ancestor transaction a rule reads is checked against its block the same way;
- missing data, a block or an ancestor, is unavailability: the indexer halts and retries. It never rejects
  an envelope because data is missing.

**`T_BTC_SHIELD` in block `H`:**

1. Canonical parse.
2. **Capacity:** the tree has room for `n_out` more leaves.
3. The carrier has at least `n_in + 1` inputs.
4. Each `vin[1..n_in]` is a valid transparent note of `asset`, and its commitment is resolved. "Valid"
   means exactly what Tacit's transparent validator `validateOutpoint` decides (full ancestry, every
   opcode's rules), or the pool's own record for an output created by an accepted exit. For ancestry
   through `T_CROSSOUT_MINT` or AMM outputs, the validator reads the Tacit worker's acceptance records for
   those ops (security analysis A9).
5. No input is a note bound to a pool deployment (an output of `T_CXFER_BOUND`, SPEC §3.4), since such a
   note is also spendable in that deployment's fast lane (SPEC §6.3).
6. `E = C_secp − ΣC_in` is not the point at infinity, and `kernel_sig` verifies.
7. The boundary verifies (§3), yielding `depC`.
8. The proof verifies against the pinned key with public inputs `(0, bodyHash, asset_f, 0, 0, leaves padded
   with 0, identity, depC)`.
9. Append the output leaves.

**`T_BTC_SPEND` in block `H`:**

1. Canonical parse, and `proof_len ≤ 4096`.
2. `H − 144 ≤ h_anchor ≤ H − 1`, and a root is retained for `h_anchor`.
3. **Carrier binding:** if `bind` is non-zero, some input of the carrier spends that outpoint.
4. No nullifier is already in the set, and they are pairwise distinct.
5. **With an exit:** the carrier's `vin[0]` holds no transparent Tacit op, `exit_vout` names an output of
   the carrier that no earlier accepted exit or want in this transaction claimed, and `SHA-256` of its
   scriptPubKey equals `dest_spk_hash`.
6. **With a want:** `vout` names an output of the carrier, differs from `exit_vout`, and no earlier accepted
   exit or want in this transaction claimed it; its value is at least `value`, and `SHA-256` of its
   scriptPubKey equals `spk_hash`.
7. **Capacity:** the tree has room for the spend's outputs. At `2^32` leaves, leaf-creating envelopes are
   rejected, and the pool continues as a successor (SPEC §8).
8. **With an exit:** the exit boundary verifies (§3), yielding `exitC`.
9. The proof verifies against the pinned key with public inputs `(R[h_anchor], bodyHash, asset_f,
   nullifiers padded with 0, leaves padded with 0, exitC or the identity, identity)`.
10. Insert the nullifiers. Append the output leaves. For an exit, record the transparent note
    `(asset, Cx, Cy)`, the decompressed `C_secp`, at `(txid, exit_vout)`. A want claims its output for the
    rest of the transaction.

**End of block.** Record `R[H]` for the block, carrying the previous root forward if nothing changed.
Roots `R[H−144]` through `R[H−1]` stay available while block `H` is processed. Prune older roots only
after the block commits. A reorg replays from the fork point by undoing each rolled-back block's leaves,
nullifiers, recorded exits and root. The undo log covers 288 blocks, and a deeper reorg rescans from the
pool's start height.

**Verification is native.** The indexer verifies each Halo2 proof and each boundary in process, against
the key pinned by `vk_hash`, with no network call, so two indexers replaying the same chain agree on every
proof. An indexer whose key is missing or does not match the pin halts at the first shield or spend
rather than deciding it.

**Seam with the transparent layer.** A shield consumes transparent notes, which Bitcoin already marks as
spent. An exit creates one. In a carrier whose `vin[0]` holds no transparent Tacit op, an output is a
transparent note iff the pool recorded an accepted exit at it. A pool spend may ride any input, so the rule
applies whichever inputs carry the spends. Transparent validators, meaning the indexer's outpoint validation
and the dapp's `validateOutpoint`, apply it.

**Hosted records.** Shield-input validation reads Bitcoin data, plus the Tacit worker's acceptance
records for two ops. `T_CROSSOUT_MINT` is valid by membership in the Ethereum pool's cross-out set (SPEC
§6.4). AMM swap outputs depend on reserves the indexer tracks from Bitcoin (SPEC §3.5), which any indexer
running the reference worker recomputes. A shield whose inputs' ancestry includes either relies on those
records (security analysis A9) until cross-out mints are proof-verified (§9) and the indexer tracks AMM
state itself. A wallet crediting an exit note reads the pool's record from its own replay or an indexer it
trusts.

## 6. Relaying and wallet defaults

**Relayed spends.** Anyone may broadcast their own carrier, but then their fee-paying inputs show that
they sent a pool spend. A relayer removes that: it holds a pool address and BTC for fees, and quotes a fee
in the spend's asset and one of its own UTXOs as `bind`. The sender puts that outpoint in `bind`, adds an
output paying the fee to the relayer's address, signs, proves, and hands the relayer the payload. Only a
carrier that spends the bound UTXO can carry the payload, so no one else can post it ahead of the relayer.

The bind is per batch: one confirmed relayer UTXO, reserved when the batch opens and quoted to every sender
in it. The carrier spends it after the envelope inputs and returns its value to the relayer after the exit
outputs, so it moves no signed `exit_vout`. A batch past its close time takes no new quotes; it is carried
once every quote it issued is used or expired, so a sender who proves slowly still lands in it.

Before paying anything, the relayer checks natively that:

- the exit boundary, if any, verifies, and the proof verifies against its own replayed root;
- the nullifiers are unspent, in its replayed set, in recent blocks, among payloads it already holds and
  in the mempool;
- `bind` is its quoted UTXO, the spend has no want, and an exit pays the script it quoted;
- one output is fully received by the relayer under §2: it decrypts under the relayer's viewing key, its
  leaf matches the relayer's derived keys, and its value is at least the quoted fee.

It then wraps the payload in a carrier funded from its own coins, batching many senders' spends into one
transaction where it can; spends bound to one UTXO share a carrier. The relayer cannot change the body
(signed) and cannot spend the inputs (it never sees `sk_note` or `nk_note`). The sender needs no Bitcoin
wallet and leaves no fee-input trail.

For a relayed exit, the relayer assigns `exit_vout` before the sender signs and keeps the carrier's
output layout fixed. If a sender in the batch drops out, its exit output stays in place, paid to the
relayer's own change, so every other signed `exit_vout` still names the right output.

**Relayer duties.**

- Bound the cost of each check (payload size, parse) and rate-limit submissions.
- Reserve the payload's carrier slot and its nullifiers at submission.
- Track nullifiers from its replayed tip through the mempool, and refuse payloads that conflict.
- Check `h_anchor` against the chain tip with a margin, so the payload confirms inside the window.
- Fee-bump a carrier near its anchor's expiry, or cancel it by double-spending the bound UTXO.
- Cancel its carrier when a conflicting spend of the payload's nullifiers appears elsewhere.

Submission to a relayer goes over an anonymizing transport, since the relayer sees when and from where a
payload arrives.

**Wallet defaults.** Each of these narrows what §7's public columns reveal:

- **Local proving.** The wallet proves on the user's device, so no prover sees the spend. Delegation is
  opt-in.
- **Anchor.** `h_anchor = floor((tip − 6) / 6) · 6`, so anchor age does not fingerprint a wallet.
- **Arity.** Every pay has 3 outputs, padded with zero-value notes to the wallet's internal address. It
  has 2 inputs when the wallet holds a second note of the asset, else 1, so a wallet's first spend after a
  shield is 1-in.
- **Internal change.** Change and padding go to the internal address (§2), so `v` alone does not show
  what a spend sent out.
- **Fresh exit keys.** Each exit, and each want the wallet is paid through, pays to a new key derived from
  the seed by a counter,
  `Hs("tacit-btc-pool-exit-key-v1" ‖ exit_root ‖ counter(4, BE))`, paid as a BIP-86 key-path P2TR
  output (or P2WPKH), and never to a reused script.
- **Network binding.** Every key derivation includes the network (§2).

## 7. Leakage

| Hidden | Public |
|---|---|
| Amounts inside the pool | Block height and fee of each carrier |
| Amounts at shield and exit, unless the transparent note's opening is public | The amount of a shielded note whose opening is public (sale lots, public mints, published etch supply), and of an exit later sold |
| Which leaf a spend consumes | Arity: 3 outputs per pay under the wallet defaults; 1 input on a wallet's first spend after a shield; a shield's output count |
| Sender and recipient identity | The age of `h_anchor` (coarse under the wallet defaults) |
| The link between two notes paid to one address | Which transparent notes were shielded |
| The sender's Bitcoin wallet, when relayed | The script an exit pays to |
| | Which relayer built a carrier, by its envelope key and change script |
| | Fee-paying inputs, when self-broadcast |
| | A want's output and value, so the price of an exit to sats and the maker that paid it |

## 8. What it reuses

It reuses:

- Pedersen commitments and the `T_CXFER` kernel (SPEC §2.2–§2.4), at the shield;
- BIP-340 signing, for the kernel;
- BabyJubJub Pedersen commitments, the cross-curve sigma and a secp256k1-side Bulletproofs+ range proof,
  the boundary `T_SWAP_BATCH` already ships (SPEC §2.8, §3.5);
- circomlib Poseidon and EdDSA-Poseidon (the relation's hash and signature), and the pinned Hermez `pot18`
  powers of tau (SPEC §2.8) as the Halo2 SRS;
- the stealth one-time-key construction behind pay-by-stealth;
- the standard Tacit carrier.

It is new in three places: the note model and nullifier derivation above, the spend circuit, and the pool
replay state.

## 9. Relationship to the rest of Tacit

- **The EVM confidential pool** stays unchanged. Neither pool touches the other's contracts, circuits or
  guests.
- **Moving value between them** goes through the transparent layer. Inbound, a cBTC note crossed out of
  the EVM pool (`T_CROSSOUT_MINT`) is shielded like any other transparent note. Outbound, an exited note
  crosses to Ethereum once the reflection guest folds `T_BTC_SHIELD` and `T_BTC_SPEND`. The reflection
  guest's key is immutable in a deployment, so that fold ships in a successor deployment (SPEC §8). In the
  current deployment, exited notes stay on Bitcoin.
- **Real sats in and out** each take one transaction: buy and shield, and exit to sats, below.
- **The immutable core** (`ConfidentialPool.sol`, the settle and reflection guests, their keys) is not
  touched.
- **Governance** gains no new surface. The window, arity caps, proof cap and pinned key are protocol
  constants.
- **Upgrades** follow SPEC §8's lineage. A changed relation means new domain tags, a new circuit and
  key, and new opcodes, while old notes stay spendable under the old circuit and key.

**Buy and shield.** A pre-authorized sale (README, "Trade atomically") sells a transparent lot for BTC. The
seller signs its lot input and its payout `SIGHASH_SINGLE|ANYONECANPAY` and publishes the lot's opening. The
buyer's carrier is the shield:

| | Index 0 | Index 1 |
|---|---|---|
| Input | `T_BTC_SHIELD` envelope (buyer), `n_in = 1` | the lot, with the seller's signature |
| Output | the buyer's change | the seller's payout, exactly as signed |

The shield's input is `vin[1]` and the sale's signature is for `vin[1]`/`vout[1]`, so the two layouts
coincide. The BIP-143 preimage of a `SINGLE|ANYONECANPAY` signature covers the input's outpoint, value and
`nSequence` and the output at the same index, not the index itself. The kernel is signed from the published
opening, which the buyer first checks against the lot's validated on-chain commitment, and the buyer proves
the shield on its own device. The buyer's envelope output funds the price and the fee. The buyer pays BTC
and receives a shielded note in one transaction.
Reference: `dapp/btc-pool-zap.js` `buyAndShield`.

**Exit to sats.** A maker quotes `sats` for `amount` of an asset. The user signs and proves one spend:

- an exit of `amount` to the maker's script at `exit_vout`;
- a want of `sats` at the maker's chosen `vout`, to a fresh key of the user's (§6);
- change to the user's internal address, padded to three outputs.

The user hands the maker the payload, the exit's opening `(amount, r_s)` and the payout script. The maker
checks that `C_secp` opens to `amount`, that the exit pays its script at its index, that the want asks at
most `sats` to the given script, and optionally the boundary and the proof. It then builds the carrier
from its own coins, paying both outputs. The body is signed, so a carrier that does not pay the want is
rejected whole, and the exit is recorded only in a carrier that pays it.
Reference: `dapp/btc-pool-zap.js` `exitToSats`, `validateExitToSats`.

**Proof-verified cross-out mints.** A `T_CROSSOUT_MINT` envelope, or a companion envelope in the same
carrier, carries a succinct proof that the cross-out it re-mints is final on Ethereum: a sync-committee
light client from the pinned genesis, as the Ethereum reflection guest already proves (SPEC §6.4), and
membership of `claim_id` in the pool's cross-out set. Bitcoin-side indexers verify it natively against a
pinned key, with no network call. Cross-out validity is then a function of Bitcoin data, and shields of
that ancestry need no hosted record.

## 10. Rollout

1. The reference relation (circuit, JS model, Rust twin), boundary, indexer, wallet and native verifier,
   each with adversarial tests, including adversarial witnesses against the circuit.
2. A signet run: shield, pay, scan, exit with real transactions and Halo2 proofs made on the client.
3. The replay service on Render, serving roots, paths, the note feed and nullifier status.
4. The transparent-layer seam in the indexer and the dapp: `validateOutpoint` covers `T_CROSSOUT_MINT`
   and pool exits, the worker values exit outputs, and the dapp builds buy-and-shield and exit-to-sats
   carriers.
5. A reflection fold for `T_BTC_SHIELD` and `T_BTC_SPEND` in a successor deployment (SPEC §8), so exited
   notes join the reflected live set.
6. Independent review of the Halo2 circuit and the boundary. The verification key, params and prover
   wasm are pinned by hash and content address.
7. Mainnet enablement with a value cap.
8. Proof-verified cross-out mints (§9).
