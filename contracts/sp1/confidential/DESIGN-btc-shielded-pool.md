# Bitcoin-native shielded pool: private payments on Bitcoin, no second chain

Status: DESIGN, reference implementation in progress. Opcodes `0x6C`/`0x6D` are reserved in SPEC §3.10
and not enabled on mainnet. Companion analysis: `DESIGN-btc-shielded-pool-security.md`.

A shielded pool over Tacit's Bitcoin assets. Alice pays Bob: the amount, the note that funded the
payment, and the link between the two parties are hidden from everyone else. The pool lives entirely on
Bitcoin. Its state is a Merkle tree of note leaves and a nullifier set, derived by any indexer from
Bitcoin data alone, and its proofs are verified locally with no Ethereum dependency.

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

A pool address is `(V, A, N)`, each a 33-byte compressed point, given out once and reused freely. `v`
alone finds and reads incoming notes. `(v, n)` also sees which of them are spent. Only `a` can spend.

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
0x6D ‖ asset(32) ‖ h_anchor(4) ‖ n_in(1) ‖ nf(32)×n_in ‖ n_out(1) ‖ output(218)×n_out
     ‖ has_exit(1) ‖ [exit(100)] ‖ proof_len(2) ‖ proof

output = Cx(32) ‖ Cy(32) ‖ spend_key(32) ‖ nk_pub(33) ‖ pk_eph(33) ‖ ct_note(56)
exit   = exit_vout(4) ‖ Cx(32) ‖ Cy(32) ‖ dest_spk_hash(32)          present iff has_exit = 1
```

The constraints are `1 ≤ n_in ≤ 2`, `0 ≤ n_out ≤ 3`, `has_exit ∈ {0, 1}`, `n_out + has_exit ≥ 1`, and
`proof_len ≤ 512`. `body` is every byte of the payload before `proof_len`.

- Each **output** appends a leaf: a payment, change, or a relayer's fee.
- An **exit** creates a transparent Tacit note `(asset, Cx, Cy)` at the carrier's output `exit_vout`, whose
  amount stays hidden. It requires `SHA-256(scriptPubKey of exit_vout) = dest_spk_hash`. The body is
  signed, so nobody can move the exit to another output or another carrier. The exit carries no
  `ct_note`, since only the exiter knows its opening, so it pays to a script the exiter controls. Paying
  someone else afterwards is an ordinary `T_CXFER`.
- **Outputs and an exit together** give a partial exit: take part of a note out and keep the change
  shielded, in one spend.

**Carriers.** A `T_BTC_SHIELD` rides `vin[0]`, because its shielded notes are `vin[1..n_in]`. In a
carrier with a shield, only `vin[0]` is read. A `T_BTC_SPEND` may ride any input whose witness is a Tacit
envelope leaf, so one Bitcoin transaction can carry many users' spends. The indexer processes a
transaction's pool envelopes in input order, each accepted or rejected on its own. Within one transaction,
each output can be claimed by at most one accepted exit. An exit is rejected when the carrier's `vin[0]`
holds a transparent Tacit op, so an exit never claims an output that op creates.

## 4. The relation

A fourth SP1 guest (`btc-pool-prover`, pinned in `elf-vkey-pin.json` as `btc_pool_vkey`) reads `body` and a
private witness, and proves:

1. `body` parses canonically as a `T_BTC_SPEND` body (§3).
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
check changes nothing. Envelopes live in witness data, so an indexer that fetches blocks from an untrusted
source checks each block against its header's merkle root and its coinbase witness commitment.

**`T_BTC_SHIELD` in block `H`:**

1. Canonical parse. The carrier has at least `n_in + 1` inputs.
2. Each `vin[1..n_in]` is a valid transparent note of `asset`, and its commitment is resolved. "Valid"
   means exactly what Tacit's transparent validator `validateOutpoint` decides (full ancestry, every
   opcode's rules), or the pool's own record for an output created by an accepted exit. If data is
   unavailable, the indexer halts and retries; it never rejects on unavailability.
3. Neither `E = C_pool − ΣC_in` nor `(Cx, Cy)` is the point at infinity, and `kernel_sig` verifies.
4. Append the leaf.

**`T_BTC_SPEND` in block `H`:**

1. Canonical parse, and `proof_len ≤ 512`.
2. `H − 144 ≤ h_anchor ≤ H − 1`, and a root is retained for `h_anchor`.
3. No nullifier is already in the set, and they are pairwise distinct.
4. **With an exit:** the carrier's `vin[0]` holds no transparent Tacit op, `exit_vout` names an output of
   the carrier that no earlier accepted exit in this transaction claimed, and `SHA-256` of its scriptPubKey
   equals `dest_spk_hash`.
5. **Capacity:** the tree has room for the spend's outputs. At `2^32` leaves, leaf-creating envelopes are
   rejected, and the pool continues as a successor (SPEC §8).
6. The proof verifies locally against `btc_pool_vkey`, with public values
   `abi.encode(1, R[h_anchor], keccak(body))`.
7. Insert the nullifiers. For a pay, append the output leaves. For an exit, record the transparent note
   `(asset, Cx, Cy)` at `(txid, exit_vout)`.

**End of block.** Record `R[H]` for the block, carrying the previous root forward if nothing changed.
Roots `R[H−144]` through `R[H−1]` stay available while block `H` is processed. Prune older roots only
after the block commits. A reorg replays from the fork point by undoing each rolled-back block's leaves,
nullifiers, recorded exits and root. The undo log covers 288 blocks, and a deeper reorg rescans from the
pool's start height.

**Verification is local.** `sp1_verifier::Groth16Verifier` checks the proof against the SP1 Groth16 key.
That is the same key the immutable mainnet leaf `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` embeds, and the
proof's 4-byte selector must match it. No network call is on the acceptance path, so two indexers replaying
the same chain agree.

**Seam with the transparent layer.** A shield consumes transparent notes, which Bitcoin already marks as
spent. An exit creates one, which is valid exactly when the pool's replay accepted that exit. Transparent
validators, meaning the indexer's outpoint validation and the dapp's `validateOutpoint`, consult the pool's
record for outputs created by `T_BTC_SPEND`.

## 6. Relaying and wallet defaults

**Relayed spends.** Anyone may broadcast their own carrier, but then their fee-paying inputs show that
they sent a pool spend. A relayer removes that: it holds a pool address and BTC for fees, and quotes a fee
in the spend's asset. The sender adds an output paying that fee to the relayer's address, signs, proves,
and hands the relayer the payload. Before paying anything, the relayer checks locally that:

- the proof verifies against its own replayed root;
- the nullifiers are unspent, in its replayed set and among payloads it already holds;
- one output is fully received by the relayer under §2: it decrypts under the relayer's viewing key, its
  opening matches `(Cx, Cy)`, its `spend_key` and `nk_pub` match the relayer's derived keys, and its value
  is at least the quoted fee.

It then wraps the payload in a carrier funded from its own coins, batching many senders' spends into one
transaction where it can. The relayer cannot change the body (signed), cannot spend the inputs (it never
sees `sk_spend`), and learns only its own fee note. The sender needs no Bitcoin wallet and leaves no
fee-input trail.

For a relayed exit, the relayer assigns `exit_vout` before the sender signs and keeps the carrier's
output layout fixed. If a sender in the batch drops out, its exit output stays in place, paid to the
relayer's own change, so every other signed `exit_vout` still names the right output. A sender who hands
the same nullifiers to two relayers makes one of them pay a fee for a rejected envelope. The relayer bounds
this by holding each payload's nullifiers until its carrier confirms or is replaced, and by rejecting
payloads that conflict with the mempool. Submission to a relayer should go over an anonymizing transport,
since the relayer sees when and from where a payload arrives.

**Wallet defaults.** Each of these narrows what §7's public columns reveal:

- **Uniform arity.** Every pay has 2 inputs and 3 outputs, padded with zero-value notes to the sender's
  own address.
- **Shared anchor policy.** `h_anchor` is the tip minus 6, rounded down to a multiple of 6, so anchor age
  does not fingerprint a wallet.
- **Fresh exit keys.** Each exit pays to a new key the wallet derives, never a reused address.

## 7. Leakage

| Hidden | Public |
|---|---|
| Amounts, at shield, pay and exit alike | Block height and fee of each carrier |
| Which leaf a spend consumes | Arity (uniform under the wallet defaults) |
| Sender and recipient identity | The age of `h_anchor` (coarse under the wallet defaults) |
| The link between two notes paid to one address | Which transparent notes were shielded |
| The sender's Bitcoin wallet, when relayed | The script an exit pays to |
| | Fee-paying inputs, when self-broadcast |

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
  crosses to Ethereum once the reflection guest folds `T_BTC_SHIELD` and `T_BTC_SPEND` into its live set
  (rollout step 5).
- **Real sats in and out** use the existing Bitcoin-side pre-authorized sales, which sell an asset for BTC
  in one transaction (README, "Trade atomically"). The seller signs only its own input and its BTC payout
  (`SIGHASH_SINGLE|ANYONECANPAY`), and publishes the lot's opening. So the buyer's carrier can be the
  shield itself: a `T_BTC_SHIELD` in `vin[0]` with the lot as `vin[1]`, the seller's payout untouched, and
  the kernel signed from the published opening. The buyer pays BTC and receives a shielded note in one
  transaction. To cash out, a holder exits to its own script and sells the resulting note the same way.
- **The immutable core** (`ConfidentialPool.sol`, the settle and reflection guests, their keys) is not
  touched.
- **Governance** gains no new surface. The window, arity caps and proof cap are protocol constants.
- **Upgrades** follow SPEC §8's lineage. A changed relation means a new leaf domain and new opcodes, while
  old notes stay spendable under the old guest.

## 10. Rollout

1. The reference relation, guest, indexer, wallet and local verifier, each with adversarial tests.
2. A signet run: shield, pay, scan, exit with real transactions and real proofs.
3. The replay service on Render, serving roots, paths, the note feed and nullifier status.
4. The transparent-layer seam in the indexer and the dapp: `validateOutpoint` covers `T_CROSSOUT_MINT`
   and pool exits, the worker values exit outputs, and the dapp builds buy-and-shield carriers.
5. A reflection fold for `T_BTC_SHIELD` and `T_BTC_SPEND`, so exited notes join the reflected live set.
6. Independent review, then mainnet enablement with a value cap.
