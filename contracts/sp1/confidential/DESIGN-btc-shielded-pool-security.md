# Security and privacy analysis: Bitcoin-native shielded pool

Status: DESIGN, companion to `DESIGN-btc-shielded-pool.md` (the design), which defines the keys, notes,
opcodes, relation and replay analyzed here. Section references of the form "design §N" point there.

Each security goal is stated as an experiment with a named advantage term and reduced to the assumptions
in §1. The reductions are worked by hand and are the object of the external review listed in §7.

## 0. Scope and custody boundary

The pool conserves Tacit asset value. It does not create, hold or release BTC. Value enters only by
spending transparent Tacit notes that already exist and leaves only as new transparent notes of the same
asset, so the pool's backing is whatever already backs the asset. BTC exposure inside the pool is exposure
to cBTC and inherits cBTC's model exactly (SPEC §5.7): the lock is self-custodied, and its enforcement is
economic, not a Bitcoin script constraint.

A transferable note that anyone holding it can trustlessly redeem for locked sats is not achievable on
today's Bitcoin. Without a covenant, the lock's key holder can always spend the lock outside the protocol,
and without a bridge nothing else can pay the holder. This design does not claim that property. What it
claims is privacy for value that already exists: hidden amounts, sources and counterparties, with exact
conservation across the boundary.

## 1. Assumptions

**A1. Ledger.** Confirmed Bitcoin history is a common prefix among honest nodes except with negligible
probability, at a depth the indexer and wallet choose. Shallower reorgs are handled by the undo log
(design §5), not assumed away. The indexer reads blocks from a data source and validates the header chain
itself, by proof of work from a pinned checkpoint, following the most-work chain. A source can withhold
headers but cannot fabricate a chain without doing its proof of work.

**A2. Data availability.** Every accepted envelope's bytes, and the transactions its rules read (shield
inputs and their transparent ancestry, exit outputs), are retrievable from confirmed Bitcoin data. Each
block, and each ancestor transaction a rule reads, is checked against its header's merkle root and
coinbase witness commitment, so a source can withhold data but cannot substitute it. Missing data, a block
or an ancestor, is unavailability: the indexer halts and retries, and never rejects an envelope because
data is missing. A2 is therefore a liveness assumption: its failure stops an indexer and never changes
its result.

**A3. Proof system and circuit.**
- **A3a. Groth16.** Groth16 over BN254 is knowledge-sound for the constraint system of `spend.circom`,
  with advantage `Adv^ks`: from any prover that outputs an accepting proof for public inputs `x`, an
  extractor recovers an assignment `w` satisfying the constraints at `x`. This holds for a key whose
  phase 1 is the pinned Hermez `pot18` and whose phase 2 had at least one honest contributor. It is
  zero-knowledge, with advantage `Adv^zk`: a simulator `Sim(x)` produces proofs indistinguishable from
  real ones, since every proof samples fresh blinding. Non-malleability of proof bytes is not assumed.
  Groth16 proofs can be re-randomized, and nothing here treats a proof's bytes as an identity.
- **A3b. Circuit faithfulness.** An assignment satisfies the constraints of `spend.circom` at `x` iff it
  is a witness of the relation `R` of design §4 at `x`. This is the circuit's correctness, with no
  cryptographic term: an under-constrained signal would admit witnesses outside `R`. It is established by
  review against design §4 and by adversarial witness tests (`tests/btc-pool-zk.test.mjs`) that the
  constraint system rejects inflation, range wraps, false membership, each nullifier alias of §3.2, a
  non-empty value in an empty slot, a tampered body hash, a wrong owner, a sender who knows the tweaks, a
  delegated prover's redirect, and wrong deposit and exit openings. Below, `Adv^ks_R` stands for
  `Adv^ks` under A3b.

**A4. Hashes.**
- `Poseidon` (circomlib parameters over BN254) is collision-resistant and preimage-resistant
  (`Adv^cr_P`). The privacy and nullifier-secrecy arguments model it as a random oracle.
- `SHA-256` is collision-resistant, including reduced mod `p` for `bodyHash` and `asset_f`
  (`Adv^cr_S`). `hsL` and `hsP` are modeled as random oracles.
- `keccak`, used for the secp256k1 scalar hash `Hs`, the AEAD and `exit_root`, is modeled as a random
  oracle.

`q_H` counts the adversary's oracle queries across all three.

**A5. Curves and signatures.**
- **A5a.** Discrete log is hard on secp256k1 (`Adv^dl_s`) and in BabyJubJub's prime-order subgroup
  (`Adv^dl_b`).
- **A5b.** BIP-340 is existentially unforgeable under chosen-message attack (`Adv^euf_s`), and Schnorr
  signatures are proofs of knowledge of the signing key, extractable in the random-oracle model by
  forking. BIP-340 signs only shield kernels.
- **A5c.** Decisional Diffie–Hellman is hard on secp256k1 (`Adv^ddh`). This makes the stealth secret
  `s = e·V` pseudorandom to anyone without `e` or `v`.
- **A5d.** EdDSA-Poseidon on BabyJubJub (circomlib) is existentially unforgeable under chosen-message
  attack, including for keys with a known additive tweak `A + t·B8`, the related-key setting of BIP-341
  key tweaks (`Adv^euf_b`).

**A6. Commitments and the boundary.**
- **A6a. Pedersen.** `C = v·H + r·G` on secp256k1 (`H` from SPEC §2.1) and `C = v·H_BJJ + r·G_BJJ` on
  BabyJubJub (Tacit's NUMS generators) are perfectly hiding and computationally binding. A second opening
  yields a discrete log, so `Adv^bind ≤ Adv^dl_s + Adv^dl_b`.
- **A6b. Cross-curve sigma and range proof.** The 169-byte cross-curve sigma is a proof of knowledge of
  one integer amount `a`, with `|a| < 2^320` fixed by its 320-bit shared response, and of blindings with
  `C_secp = a·H + r_s·G` and `C_bjj = a·H_BJJ + r_b·G_BJJ`, each read modulo its group order
  (`Adv^σ`, about `2^-125` for its 128-bit challenge). The 64-bit Bulletproofs+ range proof is sound
  (`Adv^bpp`): `C_secp` opens to a value below `2^64`. Both are honest-verifier zero-knowledge in the
  random-oracle model.

**A7. Canonical implementation.** Every correct indexer uses the same parser, acceptance order (block,
transaction, then input), leaf and nullifier derivation, anchor window, carrier-binding check, boundary
verifier, root retention, undo log, proof verifier and pinned key. Shield inputs are validated by Tacit's
canonical transparent validator (`validateOutpoint`), and every transparent validator applies the same
seam rule for outputs of `T_BTC_SPEND` carriers (design §5). No acceptance rule is
implementation-defined.

**A8. Wallet freshness.** Honest wallets sample or derive `e` (and so `pk_eph`, `s`, the tweaks, `rho` and
`k`) and every boundary blinding so that each is uniform to anyone without the wallet's secrets, and never
reuse them. A derived value is a keyed hash of wallet secrets and a per-spend unique input (design §3),
which the random-oracle model makes uniform. BIP-340 and EdDSA nonces are derived as specified. This is a
precondition on honest behavior, not a computational term.

**A9. Hosted acceptance records.** The acceptance records for `T_CROSSOUT_MINT` and AMM swaps that the Tacit
worker serves to `validateOutpoint` are correct. A9 is used only for shields whose inputs' ancestry
includes a `T_CROSSOUT_MINT` or AMM output, and applies until cross-out mints are proof-verified (design
§9) and the indexer tracks AMM state itself.

**A10. Wallet's replay source.** A wallet reads pool state (roots, paths, nullifier status, exit records)
from its own replay or from an indexer it trusts. The hosted replay service is one such indexer, not an
assumption of the protocol.

## 2. Goals

- **G1. Replay agreement.** Two correct indexers that process the same confirmed prefix derive the same
  leaves, nullifier set, root history and recorded exits.
- **G2. Double-spend resistance.** Each appended note of non-zero value has exactly one position and
  exactly one nullifier, and no nullifier is accepted twice, including across envelopes in one
  transaction.
- **G3. Conservation.** Shields and spends (pay, exit, or both) neither create nor destroy value of any
  asset, and every value that any party can later open is a `u64`. For an asset whose shielded notes
  descend from `T_CROSSOUT_MINT` or AMM outputs, G3 also rests on A9.
- **G4. Spend authorization.** A note is consumed only by a body its owner signed, including when the
  adversary is the note's sender or a delegated prover.
- **G5. Body binding.** A proof accepted for one body cannot be accepted for any other body, and a signed
  body cannot be redirected by whoever carries it.
- **G6. Transcript privacy.** Two histories that agree on the leakage function (§4) produce
  indistinguishable envelopes and replayed state.
- **G7. Recovery completeness.** A wallet holding its seed finds every note paid to its addresses and every
  exit it made, with openings, from chain data, and accepts no note it cannot spend.
- **G8. Delegated-party safety.** A prover given the witness for one spend, or a relayer or maker given
  the finished payload, cannot redirect funds, cannot spend the owner's other notes and cannot link them. A
  payload bound to a relayer's UTXO can be posted by that relayer alone. A payload with a want is accepted
  only in a carrier that pays the want, so no one takes its exit without paying for it.
- **G9. Batch independence.** Envelopes sharing a carrier are accepted or rejected independently, and
  batching weakens none of G1–G5.

## 3. Proofs

### 3.0 Setup

`Replay(C)` is the deterministic function of design §5 over a confirmed prefix `C` and, for shield
inputs with `T_CROSSOUT_MINT` or AMM ancestry, the A9 records. The adversary `A` is PPT. It assembles
prefixes and interacts with an honest-party oracle `O` that, on request, creates honest addresses; shields,
pays or exits honestly on their behalf; signs a body for an honest note; hands `A` a delegated witness for
a named spend; or hands `A`, as relayer, a finished payload that pays `A` a fee. `A` may also act as the
sender of any note, in which case it learns `(e, s, t_a, t_n, rho, k, v_amt, Ak, NK)` for that note but not
the recipient's `v`, `a` or `n`. Advantage is `Pr[win]` for a bad-event game and `|Pr[b' = b] − 1/2|` for
a distinguishing game.

### 3.1 G1: Replay agreement

**Claim.** `Adv^repl = 0` under A7, for indexers that read the same A9 records.

**Proof.** Design §5 processes envelopes in block, transaction and input order. Each check (parse, shield
input validation and kernel, anchor window, carrier binding, nullifier freshness, exit and want output
claims and hashes, boundary verification, proof verification) is a predicate of `C`, the state so far
and, for shield inputs of cross-out or AMM ancestry, the A9 records. A failing envelope changes nothing.
The state so far includes the effects of earlier envelopes in the same transaction, which is the only
coupling between envelopes (§3.9). Shield inputs are decided by the one canonical transparent validator.
Every public input of the proof is derived from the envelope and the replayed root history, and the
boundary and proof are verified in process against a pinned key with no network call. The anchor window
depends only on the envelope's block height `H`, not on a node's view of the tip. An indexer missing data,
or missing the pinned key, halts rather than deciding (A2), so incomplete data delays it and never
diverts it. After a reorg, the undo log restores the state at the fork point, and replaying the new branch
yields `Replay` of the new prefix. Two implementations of one total function agree on every input, so any
disagreement is a violation of A7 and not a cryptographic event. ∎

### 3.2 G2: Double-spend resistance

**Lemma 1 (one nullifier key per leaf).** For a fixed leaf, at most one `nk` satisfies `0 ≤ nk < l`, with
`NK = nk·B8` hashed into the leaf through `npk`, except with `Adv^cr_P`.

*Proof.* The circuit decomposes `nk` into 251 bits and requires `nk ≤ l − 1` (design §4 step 2). On
`[0, l)`, `nk ↦ nk·B8` is a bijection onto the prime-order subgroup. `npk = Poseidon(Ak, NK)` and
`leaf = Poseidon(asset_f, v, npk, rho)` fix `NK` up to a Poseidon collision, and so fix `nk`. ∎

The aliasing routes are therefore closed:

- **`nk` vs `nk + l`.** The same point, but `nk + l ≥ l` fails the range check.
- **`nk` vs `l − nk`.** `(l − nk)·B8 = −NK = (−x, y)`, a different point, so a different `npk` and a
  different leaf. Passing membership with it is a Poseidon collision.

**Lemma 2 (one position per leaf).** For an appended leaf of non-zero value at position `p`, exactly one
`leaf_index` passes design §4 step 4, namely `p`.

*Proof.* The tree has depth 32, so a membership path reads only the low 32 bits of the index: an index
`p + k·2^32` would authenticate the same leaf along the same path. The circuit decomposes the index into 32
bits, which leaves each position one index. An index `q ≠ p` below `2^32` passes only if the same leaf sits
at `q`, which makes it a spend of the note at `q`, not of the note at `p`; otherwise passing is a Poseidon
collision (A4). ∎

Without the bit decomposition, `p + 2^32` would satisfy membership and hash to a different nullifier,
giving the note a second nullifier. The range is part of nullifier uniqueness, not an encoding detail.

By Lemmas 1 and 2, `nf = Poseidon(nk_note, leaf, leaf_index)` is a function of the appended note alone,
meaning its leaf and its position, whoever proves the spend. The spend key `Ak` does not enter the
nullifier except through the leaf.

**Same note twice in one spend.** The circuit admits one note in both input slots, which publishes one
nullifier twice. The indexer rejects a body whose nullifiers repeat (design §4, indexer rules; design §5
step 4), so the note counts once.

**Zero-value inputs.** A non-empty input of value 0 skips membership (design §4 step 4). Its nullifier is
still `Poseidon(nk, leaf, index)` of a leaf it proves, and it contributes 0 to conservation, so it moves no
value and cannot collide with an honest note's nullifier except with `Adv^cr_P`. G2 is stated for notes of
non-zero value for this reason.

**Experiment.** `A` wins if `Replay(C)` accepts two spends that consume the same appended note of non-zero
value, or one spend that lists a nullifier twice.

**Claim.** `Adv^ds ≤ Adv^ks_R + Adv^cr_P`.

**Proof.** A repeat within one envelope fails acceptance step 4. Across envelopes, the nullifier set
rejects any nullifier already present. This includes envelopes in the same transaction: they are processed
one at a time in input order, and an accepted envelope's nullifiers are in the set before the next
envelope is checked. Two accepted spends of one note must therefore publish different nullifiers.
Extracting both witnesses (A3) yields either two nullifier keys for one leaf, which Lemma 1 rules out, or
two indices for one position, which Lemma 2 rules out, each up to `Adv^cr_P`, or a nullifier not computed
as specified, which is a knowledge-soundness failure. ∎

**Identical leaves.** Every leaf is fully funded when appended: a shield by its kernel inputs, a pay by
conservation. Two identical leaves at different positions are two notes and carry different nullifiers,
so both are spendable and neither destroys the other's value.

**Nullifier squatting.** Publishing an honest note's nullifier ahead of its owner requires either
computing it, which needs `nk_note = log_{B8} NK` (`≤ q_H·Adv^dl_b` in the random-oracle model; even the
note's sender, who knows `NK`, is in this position), or an accepted spend of a different leaf whose
nullifier collides with it (`Adv^cr_P`).

### 3.3 G3: Conservation

Define, per asset, supply as the sum of the values of unspent transparent notes plus the sum of the values
of unspent pool leaves. G3 says every accepted envelope leaves supply unchanged and every note it creates
opens to a `u64`. Batching does not change this: supply is additive over envelopes, and each accepted
envelope is checked on its own (§3.9).

**Boundary lemma.** If a boundary `(C_secp, C_bjj, sigma, bpp)` verifies and `C_bjj` opens to `w < 2^64`,
then `C_secp` opens to `w`, except with `Adv^σ + Adv^bpp + Adv^bind`.

*Proof.* By A6b, extract `a` with `|a| < 2^320` committed in both. By the range proof and binding,
`C_secp` opens to `u < 2^64` with `u ≡ a (mod n)`, so `a = u + k·n` with `|k| < 2^65`. By binding on
BabyJubJub, `w ≡ a (mod l)`. Then `k·n ≡ w − u (mod l)`: the vector `(k, w − u)` lies in the lattice
`{(k, j) : j ≡ k·n (mod l)}` with both coordinates below `2^65`. That lattice has determinant `l ≈ 2^251`,
and its shortest non-zero vector for the fixed orders of secp256k1 and BabyJubJub has both coordinates
near `2^125` (a Gauss reduction of the basis `(1, n mod l), (0, l)`). So `k = 0` and `u = w`. ∎

Both ranges are load-bearing. Without the secp256k1 range proof, an exit could create a transparent note
committing `w + k·l` behind a BabyJubJub commitment to `w`, minting on the transparent layer. Without the
in-circuit range on `C_bjj`, a pool value could wrap modulo `l`.

**Shield.** The kernel is the `T_CXFER` kernel (SPEC §2.4) with `C_secp` as its only output. Let
`E = C_secp − ΣC_in`. A valid `kernel_sig` under `x(E)` is, under A5b and forking in the random-oracle
model, a proof that the signer knows `x` with `±E = x·G`. Write `C_secp = u·H + ρ·G` for any opening. Then

```
(u − Σ v_in)·H = ±x·G + (Σ r_in − ρ)·G
```

so `u ≠ Σ v_in (mod n)` yields `log_G H`. Each input is a valid transparent note of `asset` as the
canonical `validateOutpoint` decides it, over full ancestry (acceptance step 4), and every valid
transparent note has a value in `[0, 2^64)` (SPEC §2.2–§2.3): by its creating op's range proof or public
amount, or, for a note created by an exit, by the boundary lemma. With `n_in ≤ 8`, `Σ v_in < 2^67 < n`, so
`u` is the exact integer sum. The range proof requires `u < 2^64`, so a shield whose inputs sum to `2^64`
or more is rejected. By the boundary lemma, `depC` opens to the same `u`. The proof, with every input slot
empty, gives `Σ v_out = v_dep = u` (design §4). So the shield's leaves carry exactly `Σ v_in`.
`Adv^cons_shield ≤ Adv^ext_kernel + Adv^dl_s + Adv^σ + Adv^bpp + Adv^bind + Adv^ks_R`, where
`Adv^ext_kernel` is the forking extractor's failure probability, as for every `T_CXFER` today.

The shield's inputs are Bitcoin-spent by the carrier, so the transparent layer cannot spend them again.
The kernel binds each `txid:vout` and every byte of the body, the output leaves and the boundary included,
so the signature cannot be moved to another carrier or other outputs. A rejected shield still spends its
inputs on Bitcoin (SPEC §3.2), so an oversized shield destroys the shielder's own value and creates none.

**Spend.** A pay, a full exit and a partial exit are one equation. Design §4 bounds every input, output and
exit value below `2^64` and requires `Σ v_in = Σ v_out + v_exit` with `v_dep = 0`, since `depC` is the
identity for a spend. There are at most six terms, so the field equation is integer equality. Each input of
non-zero value is a leaf of `root`, created on-chain, and its value is fixed inside the leaf up to
`Adv^cr_P`. Each appended leaf is `Poseidon(asset_f, v, npk, rho)` with `v < 2^64`. The exit's
`v_exit` opens `exitC`, and by the boundary lemma the new transparent note `C_secp` opens to the same
`v_exit`, a `u64`, as the transparent layer and a later shield require. So
`Adv^cons_spend ≤ Adv^ks_R + Adv^cr_P + Adv^σ + Adv^bpp + Adv^bind`.

A relayer's fee is an ordinary output, inside the same equation, so relaying adds no value term. The parse
rule `n_out + has_exit ≥ 1` excludes a spend that creates nothing.

**Asset separation.** `asset_f` is a public input the indexer derives from the body's `asset`, and every
input leaf and every output leaf is computed with it. Two assets with one `asset_f` is a SHA-256 collision
(`Adv^cr_S`). The exit records `(asset, C_secp)`. The shield requires every input to be of `asset` and signs
the body, which holds `asset`. No envelope can move value between assets.

**Seam.** An exit's transparent note exists exactly when the pool's replay recorded it, and transparent
validators consult that record for outputs of `T_BTC_SPEND` carriers whose `vin[0]` holds no transparent
op, whichever inputs carry the spends (A7). An output of such a carrier that the pool did not record is
not a Tacit note. The seam rule is load-bearing: a transparent validator that treated those outputs as
ordinary notes without the record would admit unrecorded value.

**Output claims.** Within one transaction each carrier output is claimed by at most one accepted exit or
want. Without that rule two exits in one carrier could record two notes at one outpoint. Bitcoin spends an
outpoint once, so one record's value would be unspendable and the seam would have no single answer for
that outpoint. With it, each recorded exit note has its own outpoint. A want moves no pool value, so G3
does not rest on it; its claim keeps one payment from satisfying two wants (§3.8).

**Hosted records.** A shield input's validity is decided over its full ancestry. Where that ancestry
includes a `T_CROSSOUT_MINT` or AMM output, the validator uses the A9 records for those ops, and
conservation for value of that ancestry holds under A9. Every other ancestry is decided from Bitcoin data.

**Bound notes.** A note bound to a pool deployment (`T_CXFER_BOUND`) is also spendable in that
deployment's fast lane until reflection retires it (SPEC §6.3). Shield acceptance refuses bound notes as
inputs (design §5), so a bound note never enters the pool.

Every term is negligible, so
`Adv^cons ≤ Adv^ext_kernel + 2·Adv^ks_R + Adv^dl_s + 2·(Adv^cr_P + Adv^σ + Adv^bpp + Adv^bind) + Adv^cr_S`,
under A9 for value of cross-out or AMM ancestry.

### 3.4 G4: Spend authorization

**Experiment.** `O` creates a target note `nt` for an honest address. `A` may act as its sender, may
request signatures from `O` on any body for any honest note, and may request delegated witnesses, which
include signatures. `A` wins if `Replay(C)` accepts a spend of `nt` whose body `O` never signed for `nt`.

**Claim.** `Adv^auth ≤ Adv^ks_R + Adv^euf_b + Adv^cr_S + Adv^cr_P`.

**Proof.** Extract the witness of the winning spend (A3). The leaf fixes `Ak = A + t_a·B8` of `nt` through
`npk`, up to `Adv^cr_P`, and the witness contains an EdDSA-Poseidon signature under that `Ak` on
`bodyHash = SHA-256("tacit-btc-pool-zk-body-v1" ‖ body) mod p`. If `O` signed a different body with the
same `bodyHash`, that is a SHA-256 collision. Otherwise the signature is a forgery under a known-tweak key
of the honest `A`: a sender knows `t_a` but not `a`, and a delegated prover holds signatures only on the
bodies `O` chose (A5d). The fresh `Ak` per note (A8) means a signature for one note is not a signature for
another. ∎

The nullifier key is a second, independent secret. A signature without `nk_note` cannot produce the
nullifier, and `nk_note` without a signature on the new body does not satisfy design §4 step 6.

### 3.5 G5: Body binding

The public inputs are `root, bodyHash, asset_f, nf, outLeaf, exitC, depC`, and the indexer derives every
one of them from the envelope bytes, its own root history and the verified boundary. `body` is every byte
before `proof_len` (before `kernel_sig` for a shield), so `bodyHash` covers `asset`, `h_anchor` (and
through it `root`), `bind`, every nullifier, `n_out`, every output field (`pk_eph` and `ct_note` included,
and so any relayer fee output), `has_exit`, for an exit `exit_vout`, `dest_spk_hash` and the boundary,
`has_want`, and for a want its `vout`, `value` and `spk_hash`.

**Claim.** A proof accepted for a spend body `b' ≠ b` that `O` did not sign is bounded by `Adv^auth`.

**Proof.** Binding does not depend on proof non-malleability. Suppose `A` turns a proof for `b` into an
accepting proof for `b'`. Knowledge soundness extracts a witness for `b'`, which contains signatures by
every non-empty input's `Ak` over `bodyHash(b')`. For an honest input that is a G4 forgery. Changing a
field that no input owner signed is therefore impossible, whether the field is an output, a ciphertext,
the exit boundary or the anchor. ∎

**Carriage.** With `bind` non-zero, a carrier is accepted only if it spends the bound outpoint, so only
the holder of that UTXO can carry the payload, at any input of a batched carrier. With `bind` zero, anyone
may place a signed body and its proof in a different carrier; the effect is identical (the same
nullifiers and leaves), and the owner's own carrier then fails the freshness check. An exit binds its
destination through `exit_vout` and `dest_spk_hash`. A re-carried exit must place, at `exit_vout`, an
output whose scriptPubKey hashes to that value, so the new transparent note is controlled by the owner's
script at the carrier's expense. Because `h_anchor` is signed, a signed body expires once its anchor leaves
the 144-block window. Relaying is this case with the owner's consent (§3.8). A want binds its carrier the
same way: a re-carried body is accepted only where the output at `vout` pays at least `value` to the
owner's `spk_hash`.

The shield has the same property through its kernel. A shield proof has no signature, but its public
inputs derive from the body, and the kernel message covers every byte of the body, so no relayer can swap
a leaf, `pk_eph`, `ct_note` or the boundary and keep the kernel signature.

### 3.6 G6: Transcript privacy

**Experiment.** `A` chooses two histories `h_0`, `h_1` of honest shields, pays and exits that have equal
leakage `L(h_0) = L(h_1)` (§4). The notes in both histories are between honest addresses whose `v` and `n`
`A` does not hold, and none of them is delegated to `A` for proving. `A` may relay any of the spends; the
fee outputs then paid to `A` are `A`'s own notes and are part of `L`. The challenger runs `h_b` under A8,
and `A` sees every envelope, the replayed state and the oracles, and outputs `b'`. `A` may run any other
activity of its own alongside.

Let `q_s` be the spends, `q_n` the notes and `q_c` the boundary crossings in the challenge history,
excluding fee notes paid to `A`. A relayed payload reaches `A` before broadcast, but it is the same bytes
that go on chain, so it adds nothing to the view beyond its arrival time and origin, which are
network-layer and outside `L`.

- **Game 0.** The real experiment.
- **Game 1.** Replace each Groth16 proof by `Sim(x)`, and each boundary's sigma and range proof by their
  simulators. Signatures, openings, paths, `rho` and nullifier keys appear only in the witness, so they
  vanish from the view. Loss: `q_s·Adv^zk + q_c·O(q_H/2^128)`.
- **Game 2.** For each note, replace `s = compress(e·V)` with the compression of an independent uniform
  point. `(G, V, E, s)` is a DDH tuple, and `E = e·G` stays published. Loss: `q_n·Adv^ddh`.
- **Game 3.** Replace `t_a`, `t_n`, `rho` and `k` with independent uniform values. `s` is now uniform and
  never queried by `A` except with probability `q_H·q_n/2^255`, and the domain tags separate the queries.
  The keystream and tag are uniform, so `ct_note` is uniform. With `rho` uniform and unknown, each
  `leaf = Poseidon(asset_f, v_amt, npk, rho)` is a random-oracle output on a fresh input, so it is uniform
  and independent of `asset`, `v_amt` and the address. Loss: `O(q_H·q_n/2^250)`.
- **Game 4.** Every boundary blinding is fresh and uniform (A8), so `C_secp` and `C_bjj` are uniform
  points independent of the amount (A6a, perfect hiding). At a shield, `E = C_secp − ΣC_in` is then
  uniform, and `kernel_sig` is simulated by programming the oracle (Schnorr HVZK). Loss:
  `O(q_H·q_c/2^250)`.
- **Game 5.** Replace each published nullifier with a uniform field element. After Game 3,
  `nk_note = n + t_n` is uniform and independent of everything else in the view; `NK` appears only inside
  `npk`, itself hidden inside a uniform leaf. `A` distinguishes only by querying Poseidon at `nk_note`.
  Loss: `O(q_H·q_s/2^250)` (random-oracle model).

Game 5 depends on `b` only through `L`. Proofs are simulated from their public inputs, and every nullifier,
leaf, `pk_eph`, `ct_note`, boundary commitment and kernel signature is independently uniform. Which leaf a
spend consumed, the amounts and the parties do not appear. Therefore

```
Adv^priv ≤ q_s·Adv^zk + q_n·Adv^ddh + O(q_H·q_c/2^128) + O(q_H·(q_n + q_s + q_c)/2^250).
```

A8 is a precondition on admissible histories, not a term. A reused `e` repeats `pk_eph` and the tweaks,
and a reused boundary blinding correlates two commitments, either of which `A` detects by inspection.

### 3.7 G7: Recovery completeness

**Completeness.** The recipient computes `compress(v·E) = compress(v·e·G) = compress(e·V) = s`, so it
derives the same `t_a`, `t_n`, `rho` and `k` as the sender, decrypts `ct_note`, and recomputes the leaf
from `(A, N)`, `s` and the decrypted amount. An honest note paid to it passes with probability 1. Because
every output field is signed (G5), no relayer can make an honest payment undeliverable.

**Soundness.** A note that passes receipt is spendable. The wallet knows `sk_note = a + t_a` with
`Ak = sk_note·B8`, `nk_note = n + t_n` with `NK = nk_note·B8` (canonical, as in Lemma 1), `rho` and the
amount, and the leaf equality fixes them up to `Adv^cr_P`. With the leaf's path from replay, that is a full
witness. A note meant for another address passes only if its tag verifies under this wallet's `k` and its
leaf matches this wallet's derivation, which happens with probability `O(q_H/2^128)` from the 16-byte tag.
A sender who seals a wrong amount or builds the leaf from other keys makes only its own payment
undeliverable.

**Exits.** A wallet finds its own spends by the nullifiers of its notes. The exit's secp256k1 blinding is
`r_s = Hs("tacit-btc-pool-zk-exit-secp-v1" ‖ nk_0 ‖ nf_0 ‖ exit_vout ‖ dest_spk_hash)`, and each output's
`e_j` is derived from `nk_0`, `nf_0` and the output index (design §3), so `r_s` and the wallet's own
outputs are recomputable from the seed. With every input value and output value of the spend known,
`v_exit` is their difference, checked against `C_secp`. Exit scripts come from the seed by a counter
(design §6), so the wallet also finds the exit outputs by script.

**Viewing tiers.** Change and padding are paid to the internal address `V_int ‖ A ‖ N` (design §2).

| Keys | Sees | Cannot |
|---|---|---|
| `v` | Incoming notes to the external address and their amounts | See change, see what was spent or sent, spend |
| `(v, v_int)` | Also change and padding, so the amount each spend sent out | See which notes are spent, spend |
| `(v, v_int, n)` | Everything above, every nullifier, the balance net of spends | Spend |
| `(v, v_int, a, n)` | Everything | — |

### 3.8 G8: Delegated-party safety

**Delegated prover.** Proving is local by default (design §6). A device that cannot prove may delegate. A
delegated prover receives the witness for one spend: `bodyHash`, and for each input its value, `rho`,
`nk_note`, `Ak`, index, path and EdDSA signature; for each output its value, `npk` and `rho`; and the exit's
value and BabyJubJub blinding. It does not receive `v`, `a`, `n`, `sk_note`, `s` or the tweaks.

- **No redirection.** It holds signatures on one `bodyHash` only. Any other accepted spend of those inputs
  is a G4 forgery, and any change to the body changes `bodyHash` (G5). It can prove the body as signed,
  which is what the owner asked for, or withhold the proof. Withholding is a liveness failure only, since
  the owner can prove elsewhere, and the signed body lapses when its anchor ages out.
- **No spending of other notes.** Each other note has its own `Ak'`, whose discrete log is `a + t_a'` with
  `t_a'` pseudorandom (A5c, A4). The prover's signatures are under different keys, so spending another
  note needs a forgery (A5d).
- **No linking.** `nk_note = n + t_n` and `sk_note = a + t_a` are masked by pseudorandom tweaks the prover
  does not know, and each note's masks are independent. Knowing `nk_note` and `Ak` for delegated notes
  reveals nothing about `n`, `a`, or any other note's tweaks. Deciding whether another leaf belongs to the
  same address requires distinguishing its `(leaf, pk_eph, ct_note)` from uniform given the address. That
  is Game 2–3 of §3.6 with the delegated notes' secrets as extra, independent information, so the
  advantage is bounded by `q_n·Adv^ddh + O(q_H·q_n/2^250)`. EdDSA signatures under `Ak` reveal nothing
  about `sk_note` beyond `Ak` (Schnorr zero-knowledge in the random-oracle model).
- **What it does learn.** The openings, leaves and `nk_note` of the notes it proves, so which leaves are
  consumed, their amounts, the output amounts, the exit amount and the nullifiers. That spend is not
  private from the prover. The default wallet proves locally.

**Relayer.** A relayer (design §6) receives the finished payload, `body ‖ proof_len ‖ proof`, after the
sender has signed and proved. It is strictly weaker than a delegated prover: its view is a function of the
prover's view with the witness removed, plus the payload's arrival time and network origin. Every bound
above therefore holds for it, and on chain data alone its linking advantage is the chain observer's
(§3.6).

- **No redirection.** The body is signed, so the relayer cannot change any output, the fee output
  included, nor move an exit (G5). For a relayed exit it assigns `exit_vout` before the sender signs, and
  it builds the carrier, but the exit is accepted only if that output's scriptPubKey hashes to the signed
  `dest_spk_hash`. It can pay the sender's script or make the exit fail, nothing else.
- **No spending.** It never sees `sk_note`, `nk_note` or any opening.
- **What it does learn.** Its own fee note, which it receives like any payment; the payload's arrival
  time and network origin; and, for an exit, which origin owns which exit script. The sender needs no
  Bitcoin wallet, so no fee-paying input of the sender's appears on chain. Submission over an anonymizing
  transport removes the origin.
- **What it marks.** A relayer's envelope key and change script recur across its carriers, so chain
  observers see which relayer carried a spend. Relayer choice partitions the anonymity set by relayer.
- **What it can do.** Withhold, delay, or choose the batch. The owner can submit elsewhere with a new
  body, and the old body lapses when its anchor leaves the window or when its bound UTXO is spent.
- **Relayer's own safety.** Before paying the Bitcoin fee it checks natively that the exit boundary and
  the proof verify against its own replayed root, that the nullifiers are unspent, that `bind` is its
  quoted UTXO, and that an output is received under its viewing key (design §2) for at least its quoted
  fee. An envelope that passes these and is then accepted pays the relayer. `bind` means no one else can
  post the payload first. Its remaining exposure is a conflicting spend of the same nullifiers, in another
  body, confirming first, which costs it that carrier's fee share (§6). The relayer duties of design §6
  bound it.

**Maker (exit to sats, design §9).** A maker receives the finished payload of a spend that exits `amount` to
the maker's script at `exit_vout` and wants `sats` at `vout` to the owner's script, plus the exit's
secp256k1 opening.

- **No exit without payment.** Suppose a carrier `T` accepted by `Replay` records the exit of a body `b` with
  a want `(vout, value, spk_hash)`. Acceptance (design §5 step 6) required `T.vout[vout]` to exist with
  value at least `value` and `SHA-256(scriptPubKey) = spk_hash`, and `b` is the signed body (G5): a maker
  that edits `want` in `b'` needs a signature by every input's `Ak` over `bodyHash(b')`, which is a G4
  forgery. A carrier omitting or underpaying the output, or paying another script, is rejected whole, so
  the nullifiers stay unspent and no exit is recorded. The claim rule gives each output of `T` to at most
  one accepted exit or want, so one payment cannot satisfy two wants, nor double as the exit it pays for.
  Finding a second script with the same SHA-256 is a collision (A4).
- **No redirection.** The exit's `exit_vout` and `dest_spk_hash` are signed, so the maker can pay only its
  own agreed script. The pool outputs (change, padding) are signed like any output.
- **What it does learn.** The exit's opening, which it needs to spend the resulting transparent note; the
  payout script, a fresh key of the owner's (design §6); the payload's arrival time and origin. The change
  stays under the owner's internal address.
- **Maker's own safety.** Before building the carrier it checks that `C_secp` opens to the agreed amount,
  that the exit pays its script at its index, that the want asks at most the agreed sats to the script it
  was given, that `bind` is the outpoint it chose (or zero), and optionally the boundary and the proof
  against its replayed root. With `bind` zero, a third party may carry the payload; it then pays the owner
  the want and delivers the exit to the maker, which moves value only from that third party.

### 3.9 G9: Batching

A `T_BTC_SPEND` may ride any input of a carrier whose witness is a Tacit envelope leaf, so one Bitcoin
transaction carries many spends. `T_BTC_SHIELD` stays at `vin[0]`, since its shielded notes are
`vin[1..n_in]`. Envelopes in one transaction are processed one at a time in input order.

- **Independent acceptance.** Each envelope is accepted or rejected on its own checks against the state
  left by the envelopes before it, and a rejected envelope changes nothing. One invalid envelope does not
  invalidate the others.
- **Nullifier distinctness.** An accepted envelope's nullifiers are inserted before the next envelope is
  checked, so two envelopes in one transaction that share a nullifier cannot both be accepted: the later
  one fails freshness (§3.2).
- **Output-claim uniqueness.** Each carrier output is claimed by at most one accepted exit or want in the
  transaction (§3.3, §3.8).
- **No carrier position in the proof.** The public inputs are derived from the body and the root history.
  The carrier terms, `bind` and `want`, are inside `body` and name an outpoint the carrier spends at any
  input and an output index, so they do not depend on the envelope's input position or on the other
  envelopes. Batching changes no proof and no signature, and spends bound to one UTXO share a carrier.
- **Anchors.** Every spend in block `H` anchors to a root of a block at or below `H − 1`, so intra-block
  order never changes which roots an envelope may use.

**Claim.** G1–G5 hold for batched carriers with the same bounds. G1 holds because input order is part of
the canonical order (A7). G2 and G3 hold by the sequential nullifier and output-claim rules. G4 and G5
reference the carrier only through the signed `bind` and `want`. ∎

### 3.10 Native verification and the key

Indexers, relayers and makers verify every proof in process: a Groth16 BN254 check of the 256-byte wire
proof against the verification key, with the twelve public inputs in circuit order. The JS verifier and
the Rust twin (`btc-pool-zk-core`) read the same wire and the same public-input order. The key is pinned by
`vk_hash`, SHA-256 over `alpha1 ‖ beta2 ‖ gamma2 ‖ delta2 ‖ IC` as 32-byte big-endian limbs, which both
implementations compute. A key that does not match the pin, or a pin for another network, disables
verification, and the indexer halts at the first pool envelope rather than deciding it (G1).

A3a rests on the key's setup. Phase 1 is Hermez `pot18`, already pinned for the AMM circuits. Phase 2 is
specific to `spend.circom`. The mainnet key comes from a multi-party phase-2 ceremony on Tacit's
coordinator, with a Bitcoin-block beacon, and is sound if one contributor was honest. Signet runs a
single-contributor development key, pinned for signet only, which never carries mainnet value. The
circuit is frozen before the ceremony, since any change to it needs a new phase 2.

### 3.11 Assumption dependencies

| Goal | Reduces to |
|---|---|
| G1 replay agreement | A7 (no cryptographic term), A1 for input agreement, A2 for liveness, A9 for shield inputs of cross-out or AMM ancestry |
| G2 double-spend resistance | A3, A4 (Poseidon); A5a for squatting |
| G3 conservation | A3, A4, A5a, A5b (kernel extraction), A6 (boundary lemma), A7 (seam, transparent validator); A9 for assets of cross-out or AMM ancestry |
| G4 spend authorization | A3, A4, A5d, A8 |
| G5 body binding | A3, A4, A5b, A5d |
| G6 transcript privacy | A3a (zero-knowledge), A4 (random oracle), A5c, A6, A8 |
| G7 recovery completeness | A4, A5c, A8, A10 |
| G8 delegated-party safety | A4 (random oracle, SHA-256 collision resistance for `spk_hash`), A5c, A5d, A8 |
| G9 batching | A7, and the goals it preserves |

## 4. Leakage function

`L(h)` of a history is exactly the design §7 table's public column, stated precisely:

- **Bitcoin metadata.** Block height, transaction order and fee of each carrier, and which envelopes share
  a carrier at which inputs.
- **Fee-paying inputs, when self-broadcast.** A sender who broadcasts its own carrier exposes its fee
  inputs and any clustering they carry. A relayed carrier's inputs are the relayer's and say nothing about
  the sender.
- **Shape.** The opcode, `n_in`, `n_out`, `has_exit`, `has_want`, whether `bind` is set, the envelope size,
  and the positions of appended leaves. Under the wallet defaults every pay has 3 outputs with zero-value
  padding, and 2 inputs when the wallet holds a second note of the asset, else 1. A wallet's first spend
  after a shield is therefore 1-in.
- **Anchor age.** `H − h_anchor` for each spend. Under the shared anchor policy (`tip − 6`, rounded down to
  a multiple of 6), the age reveals only the proving-to-confirmation delay to within six blocks, the same
  for every wallet following the policy.
- **Shield boundary.** Which transparent notes were shielded (their outpoints and so their transparent
  history), the asset, and the shield's output count.
- **Exit boundary.** The exit's carrier output and its script, the asset, and the new transparent note's
  outpoint. Under the wallet defaults each exit pays to a fresh key, so the script links to nothing else.
- **Public openings.** The amount of any shielded transparent note whose opening is public (sale lots,
  public mints, published etch supply), and of any exit later sold.
- **Wants.** A want's output index, sats and payout script, so the price of an exit to sats and the
  carrier that paid it. Under the wallet defaults the payout script is a fresh key. To the maker only: the
  exit's opening.
- **Relayer.** Which relayer carried each spend, since its envelope key and change script recur across
  its carriers. To the relayer only: its own fee notes, received as ordinary payments, the arrival time
  and origin of each payload it relays, and which origin owns which exit script.
- **Delegated prover.** To a prover the owner chose to delegate to, and to it only: the spend it proves
  (§3.8).

Not in `L`: any amount inside the pool; amounts at shield and exit, other than public openings; which
leaf a spend consumes; sender and recipient; whether two notes were paid to one address; and, when
relayed, the sender's Bitcoin wallet.

**Anonymity set.** The nominal set for a spend is every leaf of `asset` in the anchor root. The effective
set is smaller by whatever an observer knows beyond `L`: leaves it created or received, timing, and the
transparent history of shielded notes, since a shield followed shortly by an exit of the same asset
narrows it. A wallet that departs from the defaults (odd arity, its own anchor rule, a reused exit script,
self-broadcast, delegated proving) adds its own fingerprint or exposure. Relaying removes the sender's fee
inputs, and batching many senders into one carrier removes the one-carrier-per-spend timing signal. Each
relayer's carriers form their own subset, so the set seen by an observer is partitioned by relayer.
Network-layer observation (mempool, broadcast origin) is outside `L` and outside this analysis.

## 5. Comparison with "Shielded Bitcoin" (allocinit, Sep 2026)

That paper states a transfer layer with a canonical-implementation assumption, a double-spend lemma
(knowledge soundness plus a collision term), a hybrid-game privacy theorem over admissible challenge
pairs, and an explicit leakage function. It defers peg-in and peg-out to a follow-up paper and does not
claim trustless entry or exit.

| Goal | Shielded Bitcoin | This design |
|---|---|---|
| Replay agreement | Canonical implementation assumed | Same (A7), with native verification, height-based anchor window and an undo log |
| Double-spend resistance | Knowledge soundness plus collision term | Knowledge soundness plus a Poseidon collision term, with every nullifier alias closed in-circuit (Lemmas 1 and 2) and repeats refused by the indexer |
| Conservation, in-pool | Proved | Proved (§3.3) |
| Conservation, boundary | Deferred | Proved: the `T_CXFER` kernel at shield, and the boundary lemma (cross-curve sigma with range on both sides) at shield and exit, plus the seam rule |
| Spend authorization | Proved for its relation | Proved, against the note's sender and a delegated prover (§3.4) |
| Body binding | Public-input binding | Every body byte is hashed into a public input and signed by each input owner, so binding holds without proof non-malleability (§3.5) |
| Transcript privacy | Hybrid argument | Hybrid argument (§3.6) |
| Boundary amounts | No working boundary | Hidden at shield and exit, except where the transparent note's opening is public |
| Boundary custody | Not claimed trustless | Not claimed trustless. The pool adds no custody, and BTC exposure is cBTC's (§0) |
| Setup | The paper's own instantiation | Hermez `pot18` and a public multi-party phase 2 for the one circuit (§3.10) |
| Proving | Not addressed | On the user's device; delegation optional, redirect-proof and unlinkable, with the prover's view stated (G8) |
| Batching | Out of scope | Many spends per carrier, each accepted independently, with sequential nullifier and output-claim rules (§3.9) |
| Fee payment | Left to future PIPE fee vaults | A relayer paid by an in-pool fee output; the sender needs no Bitcoin wallet and exposes no fee inputs (§3.8) |

**Where this design goes further.** Boundary amounts are hidden unless the transparent note's opening is
public. The boundary works today through existing Tacit assets, rather than being deferred. Proofs are made
on the user's device, so no prover sees a spend by default, and proving can be delegated without handing
over spend authority or linkability. Spends batch into shared carriers, and fees are paid inside the pool
through relayers, so a sender needs no Bitcoin wallet.

**Where the paper is more rigorous.** It is a standalone formal treatment, and this analysis is not yet
independently reviewed. Circuit faithfulness (A3b) is established by review and adversarial witness
tests, not by a machine-checked proof. The related-key unforgeability of tweaked EdDSA-Poseidon is assumed
here, not proved (A5d). The boundary lemma rests on the sigma's integer extraction (A6b). The kernel's
knowledge extraction is the non-tight forking argument that already underlies `T_CXFER`.

## 6. Residual risks

- **Self-inflicted loss.** A shield whose inputs sum to `2^64` or more is rejected and its inputs are
  spent. An output leaf built from keys with no known preimage, a wrong amount in `ct_note`, and a
  duplicate leaf each strand only the value of the party that created them. The canonical wallet refuses
  to build them.
- **Setup.** Groth16 soundness rests on the phase-2 ceremony having one honest contributor (A3a). The
  mainnet key comes from a public multi-party ceremony; the signet development key is pinned for signet
  only.
- **Circuit faithfulness.** An under-constrained signal would admit witnesses outside the relation (A3b).
  The circuit is reviewed against design §4 and frozen before its ceremony, and the adversarial witness
  suite runs against the compiled constraint system.
- **Seam divergence.** A transparent validator that mishandles outputs of `T_BTC_SPEND` carriers either
  rejects valid exit notes (liveness) or accepts unrecorded ones (supply). Both validators must share the
  pool's record (A7).
- **Reorgs deeper than retained undo history** require a replay from an earlier checkpoint. They do not
  change the result, only the cost.
- **Data unavailability** halts an indexer until the data is found (A2). It is a liveness risk, not a
  divergence risk.
- **Hosted records.** Shields of cross-out or AMM ancestry rely on A9 until cross-out mints are
  proof-verified (design §9) and the indexer tracks AMM state itself.
- **Fast-lane lag.** A bound Bitcoin-homed note is spendable in the Ethereum fast lane until reflection
  retires it on Bitcoin. Wallets and the indexer refuse bound notes as shield inputs, so this lag does
  not reach the pool. Transparent spends of a bound note during the lag are the fast lane's own rules
  (SPEC §6.3).
- **Relayer exposure.** A relayer pays the Bitcoin fee before the spend confirms. `bind` stops anyone else
  from posting its payload. If a conflicting spend of the same nullifiers, in another body, confirms
  first, its envelope is rejected and it loses that carrier's fee share. The relayer duties (design §6)
  bound this. It affects only the relayer.
- **Relayer liveness.** A relayer can withhold or delay a payload. The owner can submit a new body
  elsewhere; the old one lapses with its anchor or its bound UTXO.
- **Maker liveness.** A maker can withhold an exit-to-sats payload. The owner signs another body elsewhere;
  the old one lapses with its anchor, and cannot be carried without paying its want.
- **Delegated proving.** A delegated prover sees the spend it proves (§3.8). Wallets prove locally by
  default.
- **Viewing-key scope.** `v` reveals every note received at the external address and its amount; `v_int`
  adds change and padding; neither shows which notes are spent.

## 7. For external review

- The reductions in §3, in particular Lemmas 1 and 2, the boundary lemma, the kernel extraction at the
  shield, the Game 3 and Game 5 hops, and the G8 linking argument.
- A3b: `spend.circom` against design §4, including canonical `nk_note < l` (251-bit decomposition and the
  `l − 1` comparison), `leaf_index < 2^32`, empty-slot semantics for inputs and outputs, the zero-value
  membership skip, the disabled signature on empty slots, the 64-bit and 251-bit ranges in the
  BabyJubJub Pedersen gadget, the identity forcing a zero value, the conservation equation, and the
  public-input order. The adversarial witness suite (`tests/btc-pool-zk.test.mjs`) as coverage evidence.
- A3a as instantiated: the phase-2 transcript of the mainnet key, its beacon, and the pinned `vk_hash`.
- A5d's related-key clause for `A + t·B8`, as used for `Ak`.
- A6b: the sigma's integer extraction under its 128-bit challenge and 320-bit response, and the lattice
  bound the boundary lemma uses for the fixed orders of secp256k1 and BabyJubJub.
- The indexer's parser against design §3 (non-zero field elements below `p`, point validity), and its
  acceptance order within a transaction, carrier binding, exit and want output claims, boundary check
  before proof, root retention at the window edge, undo log, header-chain validation, and the transparent
  seam, under adversarial replay and reorg tests, including a carrier whose `vin[0]` holds a transparent
  op whose outputs could coincide with an `exit_vout`.
