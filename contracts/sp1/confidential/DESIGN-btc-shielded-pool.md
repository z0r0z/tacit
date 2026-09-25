# Bitcoin-native shielded pool: private payments on Bitcoin, no second chain

Status: DESIGN, reference implementation in progress. Opcodes `0x6C`/`0x6D` are reserved in SPEC §3.10
and not enabled on mainnet. Companion analysis: `DESIGN-btc-shielded-pool-security.md`.

A shielded pool over Tacit's Bitcoin assets. Alice pays Bob: the amount, the note that funded the
payment, and the link between the two parties are hidden from everyone else. The pool lives entirely on
Bitcoin. Its state is a Merkle tree of note leaves and a nullifier set, which any indexer derives by
replaying Bitcoin, and its proofs are verified locally with no Ethereum dependency.

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

**Wallet keys.** Three secp256k1 scalars, each with a public point:

| Secret | Public | Role |
|---|---|---|
| `v` | `V = v·G` | Viewing. Detects incoming notes and decrypts their amounts. |
| `a` | `A = a·G` | Spend authority. Signs spends. |
| `n` | `N = n·G` | Nullifier base. Derives each note's nullifier key. |

A pool address is `(V, A, N)`, each a 33-byte compressed point, given out once and reused freely. Only
`a` can spend.

**Internal address.** A fourth scalar `v_int`, with `V_int = v_int·G`, gives the wallet an internal
address `(V_int, A, N)`. The wallet pays its own change and padding there and never gives it out. Notes
paid to it have the same spend and nullifier keys as any other note of the wallet, and are found only
under `v_int`. Viewing tiers:

| Keys | Sees |
|---|---|
| `v` | Incoming notes to the external address and their amounts |
| `(v, v_int)` | Also change and padding, so what each spend sent out |
| `(v, v_int, n)` | Everything above, and which notes are spent |

**Derivation.** The wallet derives every scalar from one 32-byte seed, with the network (`mainnet`,
`signet`) in the hash, so one seed's wallets on two networks are unlinkable:

```
x         = Hs("tacit-btc-pool-wallet-<role>-v1" ‖ network ‖ seed)    role ∈ {view, spend, nk, view-internal}
exit_root = keccak("tacit-btc-pool-wallet-exit-v1" ‖ network ‖ seed)
```

Exit keys come from `exit_root` through a counter (§6), and exit openings and the ephemeral scalars of a
spend's outputs from the seed and the spend (§3), so a wallet recovers everything it holds from the seed
and chain data.

**Creating a note for an address.** The sender picks a fresh scalar `e` and computes:

```
E       = e·G                       pk_eph, 33-byte compressed, published
s       = compress(e·V)             33-byte shared secret, never published
t_a     = Hs("tacit-btc-pool-auth-tweak-v1" ‖ s)
t_n     = Hs("tacit-btc-pool-nk-tweak-v1"   ‖ s)
k       = keccak("tacit-btc-pool-aead-v1"   ‖ s)
P       = A + t_a·G                 spend_key = x(P), 32 bytes, published
NK      = N + t_n·G                 nk_pub = compress(NK), 33 bytes, published
C       = v_amt·H + r·G             Pedersen commitment, (Cx, Cy) published
ct_note = AEAD_k(v_amt(8, BE) ‖ r(32))   56 bytes, published
leaf    = keccak(asset ‖ Cx ‖ Cy ‖ spend_key ‖ nk_pub ‖ "tacit-btc-pool-note-v1")
```

`Hs(x)` is `keccak(x)` read as a big-endian integer and reduced mod the curve order, rejected if zero.
A blinding `r` is read as a 32-byte big-endian integer reduced mod the curve order, as in the other
guests. Only `nk_note` must be canonical, because it enters a hash.
The recipient recomputes `s = compress(v·E)` and the same tweaks, then holds:

```
sk_spend = a + t_a (mod n)          signs spends (BIP-340 negates it internally when P has odd y)
nk_note  = n + t_n (mod n)          canonical 32-byte big-endian, 0 < nk_note < n
```

Because `e` is fresh, `spend_key`, `nk_pub` and `pk_eph` are fresh on every note and cannot be linked to
the address or to each other without `v`. The sender knows `P` and `NK` but not `a` or `n`, so it cannot
spend the note or compute its nullifier.

**Nullifier.**

```
nf = keccak("tacit-btc-pool-nf-v1" ‖ leaf ‖ nk_note(32, BE) ‖ leaf_index(8, BE))
```

`nk_note` is secret, so no observer can precompute `nf` from the public leaf. It is also unique per note:
the leaf commits the full point `nk_pub` including its parity, and the relation requires
`0 < nk_note < n` with `compress(nk_note·G) = nk_pub`, so exactly one byte string satisfies it. With the
position included, each appended leaf has exactly one nullifier, whoever proves the spend. Every leaf is
fully funded when created, so two byte-identical leaves are two notes and both are spendable.

**AEAD.** Encrypt-then-MAC over keccak: keystream block `i` is `keccak(k ‖ i(2, LE))`, the ciphertext is
the 40-byte plaintext XOR the keystream, and the tag is `keccak("tacit-btc-pool-aead-tag-v1" ‖ k ‖ ct)`
truncated to 16 bytes and compared in constant time. `k` is used for exactly one note.

**Receipt.** A note belongs to a wallet when it decrypts under that wallet's `s`, the decrypted
`(v_amt, r)` opens `(Cx, Cy)`, and `spend_key` and `nk_pub` equal the values derived from `(A, N)` and
`s`. A note that fails any of these is not received. A sender who seals the wrong amount only makes their
own payment undeliverable.

## 3. Opcodes

All integers on the wire are little-endian unless marked otherwise. Both envelopes ride the standard
Tacit carrier (SPEC §3.1). Canonical parsing requires every `(Cx, Cy)` to be an on-curve point with both
coordinates below `p`, every 33-byte `nk_pub` and `pk_eph` to be a valid compressed point, and every
`spend_key` to be a valid x-only key.

**`T_BTC_SHIELD` (0x6C): move transparent notes into the pool.** 316 bytes:

```
0x6C ‖ asset(32) ‖ n_in(1) ‖ Cx(32) ‖ Cy(32) ‖ spend_key(32) ‖ nk_pub(33) ‖ pk_eph(33)
     ‖ ct_note(56) ‖ kernel_sig(64)
```

The carrier's `vin[1..n_in]` are the transparent notes being shielded, all of `asset`, with
`1 ≤ n_in ≤ 8`. The kernel proves the pool note carries exactly their value without revealing it. With
`C_pool = (Cx, Cy)`, the excess is `E = C_pool − ΣC_in`, it must not be the point at infinity, and
`kernel_sig` is a BIP-340 signature under `x(E)` over:

```
SHA-256("tacit-btc-pool-shield-v1" ‖ asset ‖ n_in(1) ‖ (txid ‖ vout_LE)×n_in
        ‖ Cx ‖ Cy ‖ spend_key ‖ nk_pub ‖ pk_eph ‖ ct_note)
```

This is the `T_CXFER` kernel (SPEC §2.4) with the pool note as its only output. Each `txid` uses the same
byte order that kernel uses, the order a transaction input serializes it (the reverse of display hex). The carrier creates no
transparent outputs of `asset`. To shield part of a note, split it with `T_CXFER` first.

**`T_BTC_SPEND` (0x6D): pay, exit, or both.**

```
0x6D ‖ asset(32) ‖ h_anchor(4) ‖ bind(36) ‖ n_in(1) ‖ nf(32)×n_in ‖ n_out(1) ‖ output(218)×n_out
     ‖ has_exit(1) ‖ [exit(100)] ‖ has_want(1) ‖ [want(44)] ‖ proof_len(2) ‖ proof

bind   = txid(32) ‖ vout(4)                                          all zero for none
output = Cx(32) ‖ Cy(32) ‖ spend_key(32) ‖ nk_pub(33) ‖ pk_eph(33) ‖ ct_note(56)
exit   = exit_vout(4) ‖ Cx(32) ‖ Cy(32) ‖ dest_spk_hash(32)          present iff has_exit = 1
want   = vout(4) ‖ value(8) ‖ spk_hash(32)                           present iff has_want = 1
```

The constraints are `1 ≤ n_in ≤ 2`, `0 ≤ n_out ≤ 3`, `has_exit ∈ {0, 1}`, `has_want ∈ {0, 1}`,
`n_out + has_exit ≥ 1`, and `proof_len ≤ 512`. `body` is every byte of the payload before `proof_len`.

- **`bind`** is `txid ‖ vout_LE` of an outpoint the carrier must spend, at any input, or 36 zero bytes for
  none. `txid` is in the kernel's byte order. A relayer quotes one of its own UTXOs as `bind`, so only that
  relayer can post the payload (§6). With `bind` zero, anyone may carry the payload in their own
  transaction, which reproduces the same effects and moves no value.
- Each **output** appends a leaf: a payment, change, or a relayer's fee.
- An **exit** creates a transparent Tacit note `(asset, Cx, Cy)` at the carrier's output `exit_vout`, whose
  amount stays hidden. It requires `SHA-256(scriptPubKey of exit_vout) = dest_spk_hash`. The body is
  signed, so nobody can move the exit to another output index or another script. The exit carries no
  `ct_note`, since only the exiter knows its opening, so it pays to a script the exiter controls. Paying
  someone else afterwards is an ordinary `T_CXFER`.
- **Outputs and an exit together** give a partial exit: take part of a note out and keep the change
  shielded, in one spend.
- A **want** requires the carrier's output `vout` to pay at least `value` sats to a script whose SHA-256 is
  `spk_hash`. It moves no pool value. It lets whoever carries the spend pay the spender in sats for it:
  exit to a maker's script with a want of the price (§9).

**Derived openings.** A wallet derives a spend's secrets from the seed and the spend's first input, so
they are recoverable without local state. With `nk_note_0` and `nf_0` the first input's nullifier key and
nullifier:

```
r_exit = Hs("tacit-btc-pool-exit-v1" ‖ nk_note_0 ‖ body with the exit's Cx, Cy set to zero)
e_j    = Hs("tacit-btc-pool-eph-v1" ‖ nk_note_0 ‖ nf_0 ‖ j(1) ‖ Cx_j ‖ Cy_j)        output index j
```

A recovering wallet finds its spends by their nullifiers, recomputes `r_exit`, and opens the exit as
`v_exit = Σ v_in − Σ v_out`, checking `C_exit = v_exit·H + r_exit·G`. It reads `v_in` from its own notes
and `v_out` of its change and padding under `v_int`. An exit that shares a spend with a payment to another
address also needs that payment's amount: from the payment record, from the recipient's address (with
`e_j` the wallet reopens that output), or by a bounded search over the third-party total. Each `e_j` is
fresh per output, since `C_j` carries a fresh blinding, and a body rebuilt from the same inputs gets new
`e_j` and `r_exit`. A shield samples `e` fresh (§2).

**Carriers.** A `T_BTC_SHIELD` rides `vin[0]`, because its shielded notes are `vin[1..n_in]`. In a
carrier with a shield, only `vin[0]` is read. A `T_BTC_SPEND` may ride any input whose witness is a Tacit
envelope leaf, so one Bitcoin transaction can carry many users' spends. The indexer processes a
transaction's pool envelopes in input order, each accepted or rejected on its own. Within one transaction,
each output can be claimed by at most one accepted exit or want. An exit is rejected when the carrier's
`vin[0]` holds a transparent Tacit op, so an exit never claims an output that op creates.

## 4. The relation

A fourth SP1 guest (`btc-pool-prover`, pinned in `elf-vkey-pin.json` as `btc_pool_vkey`) reads `body` and a
private witness, and proves:

1. `body` parses canonically as a `T_BTC_SPEND` body (§3). `bind` and `want` are carrier rules checked at
   acceptance (§5); the relation binds them only through the signatures and `keccak(body)`.
2. For each input `i`:
   - `C_i = v_i·H + r_i·G` with `v_i` a `u64`;
   - `leaf_i` from §2 is a member of `root` at `index_i`, under the depth-32 keccak tree, with
     `index_i < 2^32` (a larger index would pass the same membership check under a different nullifier);
   - `0 < nk_note_i < n` and `compress(nk_note_i·G) = nk_pub_i`;
   - `nf_i = keccak("tacit-btc-pool-nf-v1" ‖ leaf_i ‖ nk_note_i ‖ index_i)` equals the body's `i`-th
     nullifier;
   - `sig_i` is a valid BIP-340 signature under `spend_key_i` over
     `msg = keccak("tacit-btc-pool-spend-v1" ‖ body)`.
3. The nullifiers are pairwise distinct.
4. Each output commitment and, if present, the exit commitment opens to a `u64` the prover knows. Each
   output's `spend_key` is a valid x-only key, and its `nk_pub` and `pk_eph` are valid compressed points.
5. `Σ v_in = Σ v_out + v_exit` over `u128`, with `v_exit = 0` when there is no exit. There is no public
   fee term. The carrier's Bitcoin fee is paid by whoever broadcasts it (§6).

The guest commits `abi.encode(uint16 version = 1, bytes32 root, bytes32 bodyHash)` with
`bodyHash = keccak(body)`. Every public field is inside `body`, so one hash binds them all.

**What a prover learns.** A delegated prover learns everything about the note it proves, including which
leaf is spent. It holds a signature and `nk_note` but never `sk_spend`, so it cannot redirect the spend: any
change to the body invalidates the signature. It also cannot link the owner's other notes, because each
note's `nk_note` is independent without `n`.

## 5. Replay and acceptance

An indexer keeps a keccak tree of leaves, a nullifier set, the root after each block, and an undo log per
block. It processes envelopes block by block in canonical transaction order. An envelope that fails any
check changes nothing.

**Block data.** The indexer reads blocks from a source it does not trust:

- it validates the header chain by proof of work from a pinned checkpoint, and follows the most-work chain;
- it checks each block's transactions against the header's merkle root and its coinbase witness
  commitment, since envelopes live in witness data;
- any ancestor transaction a rule reads is checked against its block the same way;
- missing data, a block or an ancestor, is unavailability: the indexer halts and retries. It never rejects
  an envelope because data is missing.

**`T_BTC_SHIELD` in block `H`:**

1. **Capacity:** the tree has room for one more leaf.
2. Canonical parse. The carrier has at least `n_in + 1` inputs.
3. Each `vin[1..n_in]` is a valid transparent note of `asset`, and its commitment is resolved. "Valid"
   means exactly what Tacit's transparent validator `validateOutpoint` decides (full ancestry, every
   opcode's rules), or the pool's own record for an output created by an accepted exit. For ancestry
   through `T_CROSSOUT_MINT` or AMM outputs, the validator reads the Tacit worker's acceptance records for
   those ops (security analysis A9).
4. No input is a note bound to a pool deployment (an output of `T_CXFER_BOUND`, SPEC §3.4), since such a
   note is also spendable in that deployment's fast lane (SPEC §6.3).
5. Neither `E = C_pool − ΣC_in` nor `(Cx, Cy)` is the point at infinity, and `kernel_sig` verifies.
6. Append the leaf.

**`T_BTC_SPEND` in block `H`:**

1. Canonical parse, and `proof_len ≤ 512`.
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
8. The proof verifies locally against `btc_pool_vkey`, with public values
   `abi.encode(1, R[h_anchor], keccak(body))`.
9. Insert the nullifiers. For a pay, append the output leaves. For an exit, record the transparent note
   `(asset, Cx, Cy)` at `(txid, exit_vout)`. A want claims its output for the rest of the transaction.

**End of block.** Record `R[H]` for the block, carrying the previous root forward if nothing changed.
Roots `R[H−144]` through `R[H−1]` stay available while block `H` is processed. Prune older roots only
after the block commits. A reorg replays from the fork point by undoing each rolled-back block's leaves,
nullifiers, recorded exits and root. The undo log covers 288 blocks, and a deeper reorg rescans from the
pool's start height.

**Verification is local.** `sp1_verifier::Groth16Verifier` checks the proof against the SP1 Groth16 key.
That is the same key the immutable mainnet leaf `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` embeds, and the
proof's 4-byte selector must match it. Proof verification makes no network call, so two indexers replaying
the same chain agree on every proof.

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

Before paying anything, the relayer checks locally that:

- the proof verifies against its own replayed root;
- the nullifiers are unspent, in its replayed set and among payloads it already holds;
- `bind` is its quoted UTXO, and the spend has no want;
- one output is fully received by the relayer under §2: it decrypts under the relayer's viewing key, its
  opening matches `(Cx, Cy)`, its `spend_key` and `nk_pub` match the relayer's derived keys, and its value
  is at least the quoted fee.

It then wraps the payload in a carrier funded from its own coins, batching many senders' spends into one
transaction where it can; spends bound to one UTXO share a carrier. The relayer cannot change the body
(signed) and cannot spend the inputs (it never sees `sk_spend`). The sender needs no Bitcoin wallet and
leaves no fee-input trail.

For a relayed exit, the relayer assigns `exit_vout` before the sender signs and keeps the carrier's
output layout fixed. If a sender in the batch drops out, its exit output stays in place, paid to the
relayer's own change, so every other signed `exit_vout` still names the right output.

**Relayer duties.**

- Bound the cost of each check (proof size, parse) and rate-limit submissions.
- Reserve the payload's carrier slot and its nullifiers at submission.
- Track nullifiers from its replayed tip through the mempool, and refuse payloads that conflict.
- Check `h_anchor` against the chain tip with a margin, so the payload confirms inside the window.
- Fee-bump a carrier near its anchor's expiry, or cancel it by double-spending the bound UTXO.
- Cancel its carrier when a conflicting spend of the payload's nullifiers appears elsewhere.

Submission to a relayer goes over an anonymizing transport, since the relayer sees when and from where a
payload arrives.

**Wallet defaults.** Each of these narrows what §7's public columns reveal:

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
| Which leaf a spend consumes | Arity: 3 outputs per pay under the wallet defaults; 1 input on a wallet's first spend after a shield |
| Sender and recipient identity | The age of `h_anchor` (coarse under the wallet defaults) |
| The link between two notes paid to one address | Which transparent notes were shielded |
| The sender's Bitcoin wallet, when relayed | The script an exit pays to |
| | Which relayer built a carrier, by its envelope key and change script |
| | Fee-paying inputs, when self-broadcast |
| | A want's output and value, so the price of an exit to sats and the maker that paid it |

## 8. What it reuses

It reuses:

- Pedersen commitments and the `T_CXFER` kernel (SPEC §2.2–§2.4);
- BIP-340 signing;
- the keccak tree shape of the confidential pool;
- the stealth one-time-key construction behind pay-by-stealth;
- the SP1 toolchain, and Succinct's shared Groth16 setup, so there is no new ceremony;
- the standard Tacit carrier.

It is new in three places: the note model and nullifier derivation above, the fourth guest, and the pool
replay state.

## 9. Relationship to the rest of Tacit

- **The EVM confidential pool** stays unchanged. Neither pool touches the other's contracts or guests.
- **Moving value between them** goes through the transparent layer. Inbound, a cBTC note crossed out of
  the EVM pool (`T_CROSSOUT_MINT`) is shielded like any other transparent note. Outbound, an exited note
  crosses to Ethereum once the reflection guest folds `T_BTC_SHIELD` and `T_BTC_SPEND`. The reflection
  guest's key is immutable in a deployment, so that fold ships in a successor deployment (SPEC §8). In the
  current deployment, exited notes stay on Bitcoin.
- **Real sats in and out** each take one transaction: buy and shield, and exit to sats, below.
- **The immutable core** (`ConfidentialPool.sol`, the settle and reflection guests, their keys) is not
  touched.
- **Governance** gains no new surface. The window, arity caps and proof cap are protocol constants.
- **Upgrades** follow SPEC §8's lineage. A changed relation means a new leaf domain and new opcodes, while
  old notes stay spendable under the old guest.

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
opening, which the buyer first checks against the lot's validated on-chain commitment. The buyer's envelope
output funds the price and the fee. The buyer pays BTC and receives a shielded note in one transaction.
Reference: `dapp/btc-pool-zap.js` `buyAndShield`.

**Exit to sats.** A maker quotes `sats` for `amount` of an asset. The user signs one spend:

- an exit of `amount` to the maker's script at `exit_vout`;
- a want of `sats` at the maker's chosen `vout`, to a fresh key of the user's (§6);
- change to the user's internal address, padded to three outputs.

The user hands the maker the payload, the exit's opening and the payout script. The maker checks that the
exit opens to `amount` at its script and index, that the want asks at most `sats` to the given script, and
optionally the proof. It then builds the carrier from its own coins, paying both outputs. The body is
signed, so a carrier that does not pay the want is rejected whole, and the exit is recorded only in a carrier
that pays it.
Reference: `dapp/btc-pool-zap.js` `exitToSats`, `validateExitToSats`.

**Proof-verified cross-out mints.** A `T_CROSSOUT_MINT` envelope, or a companion envelope in the same
carrier, carries an SP1 Groth16 proof that the cross-out it re-mints is final on Ethereum: a sync-committee
light client from the pinned genesis, as the Ethereum reflection guest already proves (SPEC §6.4), and
membership of `claim_id` in the pool's cross-out set. Bitcoin-side indexers verify it locally on the same
`sp1_verifier` path as pool spends, with no network call. Cross-out validity is then a function of Bitcoin
data, and shields of that ancestry need no hosted record.

## 10. Rollout

1. The reference relation, guest, indexer, wallet and local verifier, each with adversarial tests.
2. A signet run: shield, pay, scan, exit with real transactions and real proofs.
3. The replay service on Render, serving roots, paths, the note feed and nullifier status.
4. The transparent-layer seam in the indexer and the dapp: `validateOutpoint` covers `T_CROSSOUT_MINT`
   and pool exits, the worker values exit outputs, and the dapp builds buy-and-shield and exit-to-sats
   carriers.
5. A reflection fold for `T_BTC_SHIELD` and `T_BTC_SPEND` in a successor deployment (SPEC §8), so exited
   notes join the reflected live set.
6. Independent review, then mainnet enablement with a value cap.
7. Proof-verified cross-out mints (§9).
