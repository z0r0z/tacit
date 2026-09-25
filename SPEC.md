# Tacit protocol specification

**Version 1.** Bitcoin envelope version `0x01`; confidential-pool public-values version `1`.

Tacit is a metaprotocol for issuing assets and running confidential DeFi on Bitcoin. Its state
extends into a confidential zone on Ethereum through zero-knowledge reflection. This document is the
normative description of both halves and the bridge that joins them.

Where this document and the reference implementation disagree, the implementation wins, and the
disagreement is a bug in this document:

| Surface | Normative implementation |
|---|---|
| Bitcoin envelope encode/decode, client validator | [`dapp/tacit.js`](./dapp/tacit.js) |
| Bitcoin indexer (AMM, farms, fair-launch caps) | [`worker/src/index.js`](./worker/src/index.js) |
| Shared cryptography: kernels, range proofs, leaves, parsers | [`contracts/sp1/confidential/cxfer-core/`](./contracts/sp1/confidential/cxfer-core/) |
| Confidential-pool settle guest | [`contracts/sp1/confidential/src/main.rs`](./contracts/sp1/confidential/src/main.rs) |
| Bitcoin reflection guest | [`contracts/sp1/confidential/src/reflect.rs`](./contracts/sp1/confidential/src/reflect.rs) |
| Ethereum reflection guest | [`contracts/sp1/eth-reflection/`](./contracts/sp1/eth-reflection/) |
| Pool contract | [`contracts/src/ConfidentialPool.sol`](./contracts/src/ConfidentialPool.sol), [`ReflectionLib.sol`](./contracts/src/ReflectionLib.sol) |

Deployed addresses and verifying keys are in [`docs/DEPLOYMENTS.md`](./docs/DEPLOYMENTS.md).

---

## 1. Overview

Tacit has three layers.

1. **The Bitcoin metaprotocol.** Ops are envelopes carried in Taproot script-path witnesses. Bitcoin
   nodes do not interpret them. Any indexer that runs these rules over the same chain reaches the same
   state. Amounts are Pedersen commitments with range proofs, and conservation is proven by a kernel
   signature. Assets, transfers, atomic trades, an AMM, farms and self-custody BTC locks all live here.
2. **The confidential pool.** An immutable contract on Ethereum holds a Merkle tree of confidential
   notes. Every state change is one SP1 proof, verified on-chain against a pinned verifying key. The pool
   carries wrapping of ERC-20s and ETH, private transfer, AMM swaps and liquidity, OTC and bids, stealth
   payments, adaptor locks, a CDP issuing cUSD, cBTC minting, and farms. Any op can be relayed without gas,
   with the relayer's fee bound inside the proof.
3. **Reflection.** SP1 programs prove the state of each chain to the other.
   - Bitcoin to Ethereum: headers are relayed with full proof-of-work, and a guest folds every Tacit
     envelope in each block into reflected roots the pool accepts.
   - Ethereum to Bitcoin: a light-client guest proves pool storage, and the Bitcoin guest verifies that
     proof recursively.

   No multisig, federation or attestor set signs a bridge message.

The same secp256k1 Pedersen commitment is the note on both chains, so a note's value can move between
them without changing its commitment scheme.

### 1.1 Design principles

- **Validity from data alone.** Bitcoin state follows from the chain and this document. Ethereum state
  follows from contract storage, which a proof must justify.
- **Self-custody and key-only recovery.** Every balance and position can be rebuilt from the user's key
  and public chain data (§9).
- **Immutable core, additive growth.** The pool, its guests and their verifying keys cannot be changed.
  New capability arrives as new Bitcoin opcodes or as a new pool deployment that users opt into by exiting
  and re-entering (§8).
- **Placeholders for Bitcoin covenants.** Bytes and op codes are held for constructions that become
  trustless once Bitcoin can enforce spending conditions (§10).

---

## 2. Cryptographic primitives

### 2.1 Curves and generators

- **secp256k1** carries every chain-side commitment, signature and range proof. `G` is the standard
  generator.
- **`H`** is a nothing-up-my-sleeve generator. Let `seed = SHA-256("tacit-generator-H-v1")`. For
  `ctr = 0, 1, …, 255`, set `x = SHA-256(seed ‖ ctr)` and take the first `x` for which `0x02 ‖ x` is a
  valid compressed point. The result is `02bd7bf4…5e56`. Nobody knows `log_G H`.
- **BabyJubJub** over BN254's scalar field is used only inside the swap-batch circuit (§2.8).

### 2.2 Pedersen commitments

```
C = v·H + r·G        v ∈ [0, 2^64),  r ∈ Z_n
```

Commitments hide perfectly and add homomorphically. Values are unsigned 64-bit integers in the asset's
smallest unit.

### 2.3 Range proofs

Every hidden output carries a proof that its value lies in `[0, 2^64)`. Proofs aggregate over
`m ∈ {1, 2, 4, 8}` outputs. Two schemes are accepted, and the verifier chooses one by proof length:

- **Bulletproofs+**, the default for all new transfers. Size is `99 + 96 + 66·log2(64m)` bytes. See
  [`dapp/bulletproofs-plus.js`](./dapp/bulletproofs-plus.js).
- **Classic aggregated Bulletproofs**, still accepted so older notes stay valid. See
  [`dapp/bulletproofs.js`](./dapp/bulletproofs.js).

Generators and transcripts are domain-separated: `tacit-bpp-v1` for the Bulletproofs+ transcript,
`tacit-bp-v1` for the classic transcript, and `tacit-bp-G-v1`, `tacit-bp-H-v1` and `tacit-bp-Q-v1` for
generators.

### 2.4 Kernels (conservation)

Conservation is a Schnorr signature under the excess of a transaction: outputs, plus any public amount
leaving, minus inputs. Only someone who knows the blindings can sign under the excess. If the values did
not balance, the excess would have a nonzero `H` component and nobody could sign for it.

- **Bitcoin kernel.** The excess is `E = ΣC_out + burned·H − ΣC_in`, and `E` must not be the point at
  infinity. The kernel is a BIP-340 signature under `x(E)` over this message:

  ```
  SHA-256("tacit-kernel-v1" ‖ asset_id ‖ n_in(1) ‖ (txid_BE ‖ vout_LE)×n_in
          ‖ n_out(1) ‖ C_out×n_out ‖ burned(8 LE))
  ```

  `burned` is zero except for `T_BURN`.
- **Pool kernel.** The excess is `x = ΣC_in − ΣC_out − f·H`, where `f` is the op's total public amount
  (fee, payout, swap input and so on). Accept when `z·G = R + e·x`, where

  ```
  e = keccak(domain ‖ C_in… ‖ C_out… ‖ out_leaves… ‖ R)
  ```

  `OP_TRANSFER` signs under its own domain, `tacit-evm-transfer-kernel-v1`. Every other op signs under
  `tacit-evm-cxfer-kernel-v1`. The separate domain keeps a transfer kernel from standing in for any other
  op.

### 2.5 Opening proofs

- **Opening sigma** (`tacit-open-sigma-v1`) proves that `C` opens to a stated public value. It is bound to
  a 32-byte intent context covering the op tag, the chain binding, the assets, the output
  `(Cx, Cy, owner)` tuples and the amounts. A proof made for one intent cannot be reused for another.
- **Blind proof of knowledge** (`tacit-open-pok-blind-v1`) proves knowledge of `(v, r)` without revealing
  `v`.

### 2.6 Key derivations (Bitcoin)

All derivations are HMAC-SHA-256 with a domain tag. The anchor is the first asset input's outpoint
`txid_BE ‖ vout_LE`, which both sender and recipient can see.

| Value | Derivation |
|---|---|
| Recipient blinding | `HMAC(SHA-256(ECDH_x), "tacit-blind-v1" ‖ anchor ‖ vout_LE) mod n` |
| Recipient amount keystream | `HMAC(SHA-256(ECDH_x), "tacit-amount-v1" ‖ anchor ‖ vout_LE)[0..8]` |
| Change blinding / keystream | `HMAC(priv, "tacit-change-v1" / "tacit-amount-self-v1" ‖ anchor ‖ vout_LE)` |
| Etch blinding / keystream | `"tacit-etch-v1"` / `"tacit-etch-amount-v1"` from the issuer's key and the commit anchor |

`amount_ct` is the 8-byte little-endian value XORed with its keystream. The recipient re-derives every
credit from its private key and the sender pubkey visible in the input witness. There is no out-of-band
exchange.

### 2.7 Hashes and trees

- Bitcoin-side ids and messages use **SHA-256**.
- Pool-side leaves, nullifiers and ids use **keccak-256**. In this document `keccak(a ‖ b ‖ …)` is keccak
  over the concatenation.
- The pool keeps three **incremental Merkle trees** of depth 32: notes, locks and CDP positions. The zero
  leaf is `0` and `zeros[i+1] = keccak(zeros[i] ‖ zeros[i])`. Every root ever produced stays valid for
  membership proofs, so a proof never goes stale.
- Reflection keeps **indexed Merkle trees** (IMTs) for sets that need proofs of non-membership: spent
  nullifiers, bridge burns, consumed cross-outs and consumed sources.

### 2.8 Circuits and ceremonies

Most of Tacit needs no trusted setup. The pool, reflection, range proofs and kernels are transparent.
SP1 proofs are wrapped in Groth16 for cheap verification on Ethereum, using SP1's own setup.

Two finalized Phase-2 ceremonies supply Groth16 keys for privacy circuits that are expensive to express
any other way:

| Ceremony | Circuits | Phase 1 | Phase 2 |
|---|---|---|---|
| Mixer | `withdraw.circom`: Poseidon-Merkle depth 20, nullifier, unspent-leaf membership | Hermez `pot14` | 2,227 contributions + Bitcoin-block beacon (block 948,824) |
| AMM | `amm_swap_batch`, `amm_lp_add`, `amm_lp_remove` | Hermez `pot18` | 5,018 / 13,668 / 13,703 contributions + beacon (block 951,267) |

**Swap batch.** `amm_swap_batch` (about 171k constraints, at most 16 intents) proves one uniform clearing
price over hidden per-trader amounts, carried as BabyJubJub Pedersen commitments. Its verifying key is
compiled into both SP1 guests (`batch_vk.bin`, SHA-256 `31fd05cc…bbc7c`), so the key is fixed by the
guests' own verifying keys.
- The settle guest verifies it for `OP_SWAP_BLIND` (§5.6).
- The reflection guest verifies it for Bitcoin's `T_SWAP_BATCH` (§3.5).

A 169-byte Camenisch–Stadler sigma links each BabyJubJub commitment to a secp256k1 commitment. It shares a
320-bit response across both groups. Range checks on both sides lift that equality from modular to
integer.

**Mixer.** The mixer circuit and its artifacts are published. They back the legacy Bitcoin
fixed-denomination pool (`T_DEPOSIT` / `T_WITHDRAW`, §3.8) and are available for any denominated
anonymity pool built on Tacit.

Artifacts are content-addressed. [`docs/CEREMONY.md`](./docs/CEREMONY.md) lists every zkey, verifying key,
r1cs and witness generator with its CID and hash, including the finalized `amm_swap_batch` zkey
(`bafybeieb5haf…xefwqm`) used in production. Circuit sources are in [`dapp/circuits/`](./dapp/circuits/). The mixer
ceremony's attestations are in [`dapp/circuits/ceremony-bundle/`](./dapp/circuits/ceremony-bundle/).

### 2.9 SP1 programs

| Program | Proves | Verified by |
|---|---|---|
| Settle guest (`confidential-pool-prover`) | One settlement batch of pool ops (§5) | `ConfidentialPool.settle`, against `PROGRAM_VKEY` |
| Bitcoin reflection guest (`reflection-prover`) | Bitcoin headers and blocks folded into reflected roots (§6.2) | `attestBitcoinStateProven`, against `BITCOIN_RELAY_VKEY` |
| Ethereum reflection guest (`eth-reflection`) | Ethereum finality and pool storage slots (§6.4) | Recursively inside the Bitcoin reflection guest |
| Bitcoin shielded pool guest (`btc-pool-prover`) | One `T_BTC_SPEND` (§3.10). Not enabled. | Locally by pool indexers, against `btc_pool_vkey` |

Each ELF is pinned by SHA-256 to its vkey in
[`contracts/sp1/confidential/elf-vkey-pin.json`](./contracts/sp1/confidential/elf-vkey-pin.json). Each
rebuilds byte for byte from source; see [`docs/REPRODUCIBLE-BUILDS.md`](./docs/REPRODUCIBLE-BUILDS.md).

---

## 3. The Bitcoin metaprotocol

### 3.1 Envelope

An op is a commit/reveal pair.

- **Commit.** Pays to a P2TR output. Its internal key is the BIP-341 NUMS point `50929b74…3ac0`, and its
  script tree is a single leaf:

  ```
  <signer_xonly(32)> OP_CHECKSIG OP_FALSE OP_IF "TACIT" 0x01 <payload…> OP_ENDIF
  ```

- **Reveal.** Spends that output by script path as **`vin[0]`**. The witness is
  `[sig, leaf_script, control_block]`. The leaf's `OP_CHECKSIG` authorizes the op under the signer's key.

`payload = opcode(1) ‖ body`. It is split into pushes of at most 520 bytes. Canonical envelopes push
`"TACIT"` and the version byte separately, then the payload, using direct pushes, `PUSHDATA1` or
`PUSHDATA2` only; other encodings may not fold. Readers concatenate the payload pushes until
`OP_ENDIF`. Each opcode fixes its own length rules, and many require an exact length. Trailing
bytes are rejected.

**Input and output roles.**
- `vin[0]` carries the envelope. Asset inputs are `vin[1..]`. For atomic-trade ops, only the first
  `asset_input_count` of them are asset inputs; the rest are ordinary BTC inputs.
- A `T_BTC_SPEND` (§3.10) may ride any input whose witness is an envelope leaf, so one transaction can
  carry several.
- Output `i` carries note `i`, unless the opcode defines an interleaved layout: variable-amount atomic
  trades and bids place BTC payment, change and an 80-byte `OP_RETURN` at fixed positions.
- `OP_RETURN` never carries a payload. It appears only as an auxiliary binding output: a payload hash, or
  a recovery hint.

### 3.2 Validity and consensus

A Tacit UTXO is valid iff:
- the transaction that created it carries a well-formed envelope whose rules pass, and
- each of its asset inputs is itself a valid Tacit UTXO of the same `asset_id`.

**Pool seam.** In a transaction whose `vin[0]` holds no transparent op and some input of which carries a
`T_BTC_SPEND` (§3.10), an output is a Tacit UTXO iff the shielded pool's replay recorded an accepted exit
at it. Pool spends may ride inputs other than `vin[0]`, so the rule looks at every input.

This is checked recursively over the ancestry DAG ([`validateOutpoint`](./dapp/tacit.js)).

- **Failure is local.** If an op fails validation, none of its outputs are Tacit UTXOs. Its inputs are
  still spent on Bitcoin, so their value is destroyed.
- **Unknown or reserved opcodes** create no Tacit state. Any Tacit inputs they spend are consumed.
- **Ordering** comes from Bitcoin. Transfers need no first-seen rule, because a UTXO spends once.
  Indexer-maintained state (AMM reserves, farm accrual, fair-launch caps, wrapper attestations) is applied
  in `(height, tx_index)` order.
- **Depth.** Fair-launch mints, drop claims and mixer deposits credit at 3 confirmations. AMM and farm
  state applies as blocks are scanned. The indexer rewinds on reorgs up to 6 blocks.

The Bitcoin reflection guest (§6.2) is a second, independent implementation of these rules for every op
it folds. It skips, and never panics on, any envelope it cannot fold.

### 3.3 Assets

`asset_id = SHA-256(etch_txid_BE ‖ vout_LE)` for the etch output. An asset's ticker, decimals (0–8),
image URI and `mint_authority` are fixed at issuance.

A `mint_authority` of 32 zero bytes means supply is fixed forever; TAC is issued this way. An issuer may
publish its supply opening `(supply, blinding)`, which lets anyone check the announced supply against the
etch commitment. The reference dapp publishes it by default.

### 3.4 Core ops

**`T_CETCH` (0x21): issue an asset.**

```
0x21 ‖ tlen(1) ‖ ticker(1 ≤ tlen ≤ 16) ‖ decimals(1) ‖ C(33) ‖ amount_ct(8)
     ‖ rp_len(2 LE) ‖ rangeproof ‖ mint_authority(32) ‖ img_len(2 LE) ‖ image_uri(≤ 256)
```

The supply note is output 0.

**`T_CXFER_BPP` (0x22) and `T_CXFER` (0x23): confidential transfer.** The two share one layout; `0x22`
carries a Bulletproofs+ proof and `0x23` a classic Bulletproof.

```
op ‖ asset_id(32) ‖ kernel_sig(64) ‖ N(1 ∈ {1,2,4,8}) ‖ (C(33) ‖ amount_ct(8))×N
   ‖ rp_len(2 LE) ‖ rangeproof
```

The rules: the range proof must verify over all `N` outputs, and the kernel (§2.4) must verify with
`burned = 0`.

**`T_CXFER_BOUND` (0x39): transfer bound to a pool deployment.** Same as `0x22` with
`target_chain_binding(32)` inserted after the opcode. On Bitcoin it is an ordinary transfer. In reflection
its outputs become notes bound to that deployment, spendable in its fast lane (§6.3). Among plain
transfers, only TAC folds unbound; other assets onboard through `T_CXFER_BOUND`, a bridge burn, or as AMM,
farm and bid outputs.

**`T_MINT` (0x24): additional issuance.**

```
0x24 ‖ asset_id(32) ‖ etch_txid(32) ‖ C(33) ‖ amount_ct(8) ‖ rp_len(2 LE) ‖ rangeproof ‖ issuer_sig(64)
```

`issuer_sig` is a BIP-340 signature by `mint_authority` over:

```
SHA-256("tacit-mint-v1" ‖ asset_id ‖ commit_anchor(36) ‖ C ‖ amount_ct)
```

Binding the commit anchor stops the envelope being replayed in another commit/reveal pair.

**`T_BURN` (0x25): destroy supply.**

```
0x25 ‖ asset_id(32) ‖ burned(8 LE) ‖ kernel_sig(64) ‖ N(1 ∈ {0,1,2,4,8}) ‖ (C ‖ amount_ct)×N
     [‖ rp_len(2 LE) ‖ rangeproof]   (present only when N > 0)
```

The burned amount is public, so supply stays auditable.

**`T_PETCH` (0x27) / `T_PMINT` (0x28): fair launch.** `T_PETCH` declares a ticker, decimals, lifetime cap,
fixed per-mint amount and height window, and creates no supply. Anyone may broadcast `T_PMINT`. Each mint
creates exactly the per-mint amount and publishes its opening, so cumulative supply is auditable against
the cap.

### 3.5 Trading, AMM and farms

| Byte | Op | Rule summary |
|---|---|---|
| 0x26 / 0x3C | `T_AXFER` / `T_AXFER_BPP` | A transfer that admits non-Tacit BTC inputs: a confidential asset settles against a BTC payment in one transaction. |
| 0x5B / 0x5C | `T_PREAUTH_BID` / `_VAR` | Buyer-offline bids. The buyer pre-signs a BTC input plus a bid-context `OP_RETURN` under `SIGHASH_SINGLE\|ANYONECANPAY`. Any seller completes the transaction. `_VAR` pre-signs a grid of partial fills, with an indexer-enforced refund output. The decoder, validator and reflection fold are live; wallets gate the builders (see §10). |
| 0x2D | `T_LP_ADD` | Add liquidity; variant 1 is `POOL_INIT`. A pool's reserves are public numbers the indexer tracks. No UTXO holds pool funds. LP shares are ordinary Tacit assets. |
| 0x2E | `T_LP_REMOVE` | Burn LP shares for a pro-rata withdrawal. |
| 0x2F | `T_SWAP_BATCH` | Up to 16 hidden-amount intents clear at one price, proven by the ceremony's `amm_swap_batch` Groth16 proof. If the proof fails, every intent is refunded. |
| 0x32 | `T_SWAP_VAR` | Per-trade swap against the constant-product curve with a public input amount. Needs no circuit. |
| 0x33 | `T_SWAP_ROUTE` | Atomic route over 2–4 pools in one transaction. |
| 0x31 | `T_PROTOCOL_FEE_CLAIM` | Mint a pool's accrued protocol-fee skim to its configured recipient. |
| 0x34 / 0x3E | `T_FARM_INIT` / `T_FARM_REFUND` | A launcher funds a reward farm with a virtual treasury, and can reclaim what is left after the end of the farm plus a grace period. |
| 0x35 / 0x3B / 0x36 | `T_LP_BOND` / `T_LP_HARVEST` / `T_LP_UNBOND` | Bond LP shares, harvest rewards, unbond. Accrual uses a Q96 reward-per-share accumulator. |

### 3.6 cBTC locks

| Byte | Op | Rule summary |
|---|---|---|
| 0x66 | `T_CBTC_LOCK` | 197 bytes. Registers a self-custody BTC output and the note it pre-commits to. Mints nothing on Bitcoin. Reflection records the lock and its value, and the Ethereum pool mints cBTC against it (§5.7). |
| 0x67 | `T_CBTC_REDEEM` | 109 bytes. Unlocks a lock and burns exactly its value in cBTC in the same transaction. Reflection reports any lock spent without a redeem, and the collateral layer acts on that report. |

### 3.7 Bridge and cross-chain ops

| Byte | Op | Rule summary |
|---|---|---|
| 0x2B | Bridge burn | Folded as a bridge burn only at exactly 161 bytes: `asset ‖ pool_root(unused) ‖ ν ‖ dest_commitment ‖ target_chain_binding`. Burns a note for the pool deployment named by the binding. `bridge_burn_id` commits to that binding, so one deployment and only one can pay the burn. |
| 0x65 | `T_CROSSOUT_MINT` | 161 bytes: `asset ‖ claim_id ‖ Cx ‖ Cy ‖ owner`. Re-mints on Bitcoin a note that was crossed out of the pool. Folded only if `claim_id` is proven a member of the pool's cross-out set (§6.4). |
| 0x68 | `T_BTC_CALL` | 201 bytes. A value-free, BIP-340-signed authorization of an Ethereum call. Reflection surfaces it, and `BtcCallExecutor` executes it (§6.5). |
| 0x69 | `T_ETH_CALL` | A 121-byte header plus payload. A message from Ethereum's `EthCallOutbox`, honored only if it is proven a member of the reflected outbox set. |

### 3.8 Legacy ops

These stay in the validator so existing UTXOs keep their meaning. New flows use the pool instead.

| Bytes | Ops |
|---|---|
| 0x29 / 0x2A | `T_DEPOSIT` / `T_WITHDRAW`: fixed-denomination mixer over the ceremony's `withdraw.circom` |
| 0x2B / 0x2C | `T_DROP` / `T_DCLAIM`: Bitcoin-side claim pools. Current distributions use Ethereum Merkle distributors. |
| 0x37 / 0x3D | `T_AXFER_VAR` / `_BPP`: variable-amount atomic trade. Builders are off; reflection does not fold it. |
| 0x38 | `T_WRAPPER_ATTEST`: an issuer-signed reserves and supply attestation for a wrapper asset. The first confirmed attestation wins per (asset, issuer, height). |
| 0x43–0x47 | cBTC.zk slots (`T_SLOT_MINT/BURN/ROTATE/SPLIT/MERGE`): BTC locked at a key derived from a mixer leaf |
| 0x60–0x64 | Early tETH bridge ops, kept for recovery |

### 3.9 Opcode map

| Range | Assignment |
|---|---|
| 0x21–0x28 | Issuance and transfer (§3.4) |
| 0x29–0x2A | Legacy mixer |
| 0x2B–0x2C | Legacy claim pools; `0x2B` is also the bridge burn |
| 0x2D–0x2F, 0x31–0x36, 0x3B, 0x3E | AMM and farms |
| 0x37, 0x38, 0x3D | Legacy |
| 0x39 | `T_CXFER_BOUND` |
| 0x3C | `T_AXFER_BPP` |
| 0x30, 0x3A, 0x3F–0x42 | Reserved names without a validator (e.g. `0x30` intent attestations); do not reuse without updating this table |
| 0x43–0x48, 0x4D–0x4E | cBTC.zk slots; 0x48, 0x4D and 0x4E reserved (§10) |
| 0x49–0x4C, 0x4F, 0x57–0x5A | Reserved (§10) |
| 0x50–0x56 | Unassigned. Governance is off-chain (§7.3). |
| 0x5B–0x5E | Pre-authorized bids; 0x5D and 0x5E reserved (§10) |
| 0x60–0x64 | Legacy bridge |
| 0x65–0x69 | Cross-chain and cBTC (§3.6–3.7) |
| 0x6C, 0x6D | Bitcoin-native shielded pool; reserved, not enabled (§3.10) |
| 0x6A, 0x6B, 0x6E–0xFF | Free |

A new opcode is claimed by updating this table together with `dapp/tacit.js`, `worker/src/index.js` and,
if it folds into the pool, `cxfer-core` and the reflection guest.

### 3.10 Bitcoin-native shielded pool (reserved, not enabled)

`0x6C`/`0x6D` are reserved and not enabled on mainnet. The reference implementation is in progress. The
design is [`DESIGN-btc-shielded-pool.md`](./contracts/sp1/confidential/DESIGN-btc-shielded-pool.md), and its
security and privacy analysis is
[`DESIGN-btc-shielded-pool-security.md`](./contracts/sp1/confidential/DESIGN-btc-shielded-pool-security.md).

The pool holds Tacit asset value, not BTC. A shield spends transparent notes of one asset into a pool
leaf. A spend publishes nullifiers and a proof, appends up to three new leaves, and optionally exits to a
new transparent note; a partial exit is one spend. Amounts stay hidden inside the pool, and at the
boundary unless the transparent note's opening is public. BTC exposure comes through cBTC (§5.7), and the
pool adds no custody.

- **Addresses and notes.** An address is `(V, A, N)`. Each note carries a one-time `spend_key` and
  nullifier key `nk_pub`, tweaked from `A` and `N` by an ECDH secret with `pk_eph`, and a 56-byte
  `ct_note` holding its opening. `leaf = keccak(asset ‖ Cx ‖ Cy ‖ spend_key ‖ nk_pub ‖
  "tacit-btc-pool-note-v1")` and `nf = keccak("tacit-btc-pool-nf-v1" ‖ leaf ‖ nk_note(32, BE) ‖
  leaf_index(8, BE))`, where `0 < nk_note < n`, `compress(nk_note·G) = nk_pub` and `leaf_index < 2^32`.
- **Proof.** The `btc-pool-prover` guest proves membership in the depth-32 keccak tree, the nullifiers,
  a BIP-340 signature by each input's `spend_key` over `keccak("tacit-btc-pool-spend-v1" ‖ body)`, `u64`
  openings of every input, output and exit, and `Σ v_in = Σ v_out + v_exit` over `u128` (`v_exit = 0`
  without an exit). Its public values are `abi.encode(uint16 1, root, keccak(body))`, where `body` is the
  payload before `proof_len`.
- **Acceptance.** The indexer replays leaves, nullifiers and per-block roots from Bitcoin, processing
  envelopes in block, transaction and input order, each accepted or rejected on its own. It validates the
  header chain by proof of work from a pinned checkpoint and checks each block against its merkle root and
  witness commitment; missing data, a block or an ancestor, halts it and never causes a rejection. A
  spend requires `H − 144 ≤ h_anchor ≤ H − 1`, a carrier input spending `bind` when `bind` is non-zero,
  nullifiers fresh against the set (including earlier envelopes in the same transaction),
  `proof_len ≤ 512`, for an exit an output not claimed by an earlier accepted exit or want in the
  transaction, in a carrier whose `vin[0]` holds no transparent op, and for a want an output, other than
  the exit's, not claimed by an earlier accepted exit or want, paying at least `value` sats to a script
  hashing to `spk_hash`. In a carrier with a `T_BTC_SHIELD`,
  only `vin[0]` is read. Leaf-creating envelopes are rejected once the tree holds `2^32` leaves. Shield
  inputs are validated by `validateOutpoint`, and a note bound to a pool deployment (`T_CXFER_BOUND`) is
  not a valid shield input. For ancestry through `T_CROSSOUT_MINT` or AMM outputs, `validateOutpoint` reads
  the worker's acceptance records for those ops. The indexer verifies each proof locally against the SP1
  Groth16 key with no Ethereum dependency. Reorgs roll back through a per-block undo log.
- **Relaying.** A carrier may be built by a relayer paid by a pool output of the spend. The relayer
  quotes one confirmed UTXO per batch as `bind`, so only it can post the payload; the carrier spends it
  and returns its value after the exit outputs. The relayer requires full receipt of its fee note,
  assigns `exit_vout` for a relayed exit before the sender signs, and keeps the carrier's output layout
  fixed.
- **Buy and shield.** A pre-authorized sale's lot is the shield's one input: `T_BTC_SHIELD` on `vin[0]`,
  the lot on `vin[1]` under the seller's `SIGHASH_SINGLE|ANYONECANPAY` signature, the seller's payout on
  `vout[1]`, the buyer's change on `vout[0]`. The kernel is signed from the sale's published opening.
- **Exit to sats.** One spend exits to a maker's script with a want of the quoted sats to a fresh key of the
  spender's, keeping the change shielded. The maker checks the exit's opening and the want, then carries it
  from its own coins; a carrier that underpays or omits the want output is rejected.

| Byte | Op | Rule summary |
|---|---|---|
| 0x6C | `T_BTC_SHIELD` | 316 bytes: `0x6C ‖ asset ‖ n_in(1) ‖ Cx ‖ Cy ‖ spend_key ‖ nk_pub(33) ‖ pk_eph(33) ‖ ct_note(56) ‖ kernel_sig(64)`. Rides `vin[0]` only. Spends the transparent notes `vin[1..n_in]` (`1 ≤ n_in ≤ 8`) of `asset` into one pool leaf. `kernel_sig` is the §2.4 kernel under `x(E)`, `E = C_pool − ΣC_in`, in domain `tacit-btc-pool-shield-v1`; `E ≠ ∞` and `C_pool ≠ ∞`. It creates no transparent outputs of `asset`. |
| 0x6D | `T_BTC_SPEND` | Variable: `0x6D ‖ asset ‖ h_anchor(4) ‖ bind(36) ‖ n_in(1) ‖ nf×n_in ‖ n_out(1) ‖ output(218)×n_out ‖ has_exit(1) ‖ [exit(100)] ‖ has_want(1) ‖ [want(44)] ‖ proof_len(2) ‖ proof`, with `output = Cx ‖ Cy ‖ spend_key ‖ nk_pub(33) ‖ pk_eph(33) ‖ ct_note(56)`, `exit = exit_vout(4) ‖ Cx ‖ Cy ‖ dest_spk_hash`, present iff `has_exit = 1`, and `want = vout(4) ‖ value(8) ‖ spk_hash(32)`, present iff `has_want = 1`. `bind = txid ‖ vout_LE` of an outpoint the carrier must spend at any input, or all zero for none. `1 ≤ n_in ≤ 2`, `0 ≤ n_out ≤ 3`, `has_exit ∈ {0, 1}`, `has_want ∈ {0, 1}`, `n_out + has_exit ≥ 1`. Integers are little-endian. Each output appends a leaf. The exit creates the transparent note `(asset, Cx, Cy)` at `exit_vout`, whose scriptPubKey must hash (SHA-256) to `dest_spk_hash`. The want requires the carrier's output `vout` to pay at least `value` sats to a script hashing (SHA-256) to `spk_hash`; within a transaction each output is claimed by at most one accepted exit or want. May ride any envelope input of a carrier. |

---

## 4. The confidential pool: notes and state

### 4.1 Notes

A note is `(asset_id, C, owner)` with `C = v·H + r·G`, the same commitment as on Bitcoin.

| Note kind | Leaf | Nullifier ν |
|---|---|---|
| Pool-native, owned | `keccak(asset ‖ Cx ‖ Cy ‖ owner)`, where `owner = keccak(nk ‖ "tacit-native-owner-v1")` | `keccak(nk ‖ leaf ‖ "tacit-native-nullifier-v1")` |
| Pool-native, bearer (`owner = 0`; spendable by anyone who knows the opening) | `keccak(asset ‖ Cx ‖ Cy ‖ 0)` | `keccak(leaf ‖ "spent")` |
| Bitcoin-homed | `keccak(asset ‖ Cx ‖ Cy ‖ auth_key ‖ "tacit-btc-note-v1")` | `keccak(leaf ‖ "spent")` |
| Bitcoin-homed, bound to a deployment | `keccak(asset ‖ Cx ‖ Cy ‖ auth_key ‖ chain_binding ‖ "tacit-btc-note-bound")` | `keccak(leaf ‖ "spent")` |

- `nk` is the owner's nullifier key, derived from the wallet identity.
- `auth_key` is the x-only key of the note's Bitcoin output.
- Spending a Bitcoin-homed note needs a BIP-340 signature under `auth_key` over a message in domain
  `tacit-btc-note-spend-v1`. The message covers the chain binding, an op tag, the input leaf, ν, the output
  leaves, the fee and the deadline.

Each note carries an encrypted memo so its owner can recover it (§9). The contract checks that
`keccak(memo_i)` values chain to the proof's `memoRoot`.

### 4.2 Assets and units

- An asset is keyed by a 32-byte id shared across chains. Bitcoin assets keep their `asset_id`.
- An Ethereum escrow asset registers permissionlessly under
  `SHA-256("tacit-evm-token-v1" ‖ chainid ‖ token)`. Its in-pool precision is `min(decimals, 8)`, and a
  note of value `v` pays out `v · unitScale` base units, where `unitScale = 10^(decimals − 8)`.
- Native ETH is registered under its Bitcoin-side (tETH) link id with scale `1e10`.
- An escrow token can never claim a Bitcoin-side id. Links to Bitcoin assets are set at construction, or
  registered lazily from asset metadata proven by reflection.
- Each pool-minted asset has a canonical ERC-20, minted only by the pool. Unwrapping mints it and
  wrapping burns it.
- Other ids:
  - LP share: `keccak(pool_id ‖ "lp")`
  - CDP debt: `keccak("tacit-cdp-debt-v1" ‖ controller)`
  - AMM pool: `pool_id = keccak(asset_low ‖ asset_high ‖ fee_be32)`, with `‖ recipient(33) ‖ pf_bps_be32`
    appended for a pool with a protocol-fee switch

### 4.3 Pool state

- **Trees:** note tree, lock set and CDP position set (§2.7). Every historical root stays known.
- **Spent sets:** note nullifiers, lock nullifiers and position nullifiers. Each set rejects a repeat.
- **Deposits:** `wrap` escrows the asset and records
  `deposit_id = keccak(asset ‖ v_be32 ‖ keccak(Cx ‖ Cy ‖ owner))` as pending. Only a proof can consume it.
- **Reflected Bitcoin state:** the current reflected pool, spent and burn roots, cBTC lock records, pending
  Bitcoin calls, and the consumed and cross-out counters (§6).
- **AMM reserves:** public per-pool reserves and LP share supply.
- **Chain binding:** `CHAIN_BINDING = keccak(chainid ‖ address(this))`. Every proof, bound note and bridge
  burn commits to it, so nothing proven for one deployment is valid in another.

---

## 5. The confidential pool: settlement and ops

### 5.1 Batches

The settle guest proves a batch: a header followed by up to 256 ops, each with at most 256 inputs,
outputs, intents or legs.

The header fixes:
- `chainBinding`
- `spendRoot`: the root the inputs are proven against
- `bitcoinSpentRoot` and `bitcoinBurnRoot`: reflected Bitcoin state
- `lockSetRoot` and `cdpPositionRoot`

A batch is **Bitcoin-homed** when its `spendRoot` is a reflected Bitcoin root. It must carry the current,
non-zero `bitcoinSpentRoot`, and its inputs are deployment-bound Bitcoin notes. Each input must carry an
`auth_key` signature and be proven absent from the reflected Bitcoin spent set.

Within a batch the guest checks, per op:
- membership of every input leaf;
- the range proofs;
- the kernel or opening proofs;
- op-specific rules.

It then asserts that every nullifier in the batch is distinct.

### 5.2 Public values and `settle`

The guest commits ABI-encoded `PublicValues`, version 1. The fields are:
- nullifiers and new leaves
- consumed deposits
- withdrawals and fees
- consumed Bitcoin burns and cross-outs
- the Bitcoin roots used
- swap and liquidity settlements
- deadline
- lock-set and CDP deltas
- cBTC mints
- `memoRoot`
- consumed Bitcoin sources
- consumed bridge-burn ids
- harvest action ids

New fields are appended at the end.

`settle(publicValues, proof, memos)` does the following, and every step reverts the whole batch on
failure:

1. Verifies the proof against `PROGRAM_VKEY`, checks the version, `chainBinding` and `deadline`, and
   requires `block.timestamp > refundNotBefore`.
2. Requires `spendRoot` to be a known note root, or, for a Bitcoin-homed batch, a known reflected Bitcoin
   root. It requires the reflected spent and burn roots to be current.
3. For a Bitcoin-homed batch, records every ν as a consumed Bitcoin source so that reflection can retire
   the source note on Bitcoin (§6.3). Such a batch may not consume deposits, create or spend locks, or
   mint from Bitcoin burns, and its direct withdrawals and fees must be pool-minted assets.
4. Checks memos against `memoRoot`, then marks nullifiers and lock nullifiers.
5. Applies CDP, farm and cBTC effects through the collateral and farm controllers (§5.7–5.8).
6. Marks consumed deposits, then consumes bridge burns: each `burn_id` pays once, and its roots must be
   known reflected roots.
7. Appends leaves. It keeps the invariant that the number of spent native notes never exceeds the number of
   notes ever created.
8. Pays withdrawals to their recipients and **fees to `msg.sender`**, scaling by `unitScale`. A
   pool-minted asset is minted; anything else is released from escrow.
9. Records cross-outs:
   - `claim_id = keccak(destChain ‖ destCommitment ‖ ν ‖ asset)`, with `destChain = 1` meaning Bitcoin;
   - the ν must be spent in this batch.
10. Checks each swap against live reserves: `pre = live`, posts in `(0, 2^64)`, and `k_post ≥ k_pre`.
    Checks liquidity adds against the exact pre-state and removes pro-rata against live reserves. The first add locks `MINIMUM_LIQUIDITY = 1000` shares
    permanently.

### 5.3 Op table

Op codes are a `u8` inside the batch. This namespace never appears on Bitcoin.

| # | Op | Effect |
|---|---|---|
| 0 | `OP_WRAP` | A pending public deposit becomes a note. An opening sigma binds its value. |
| 1 | `OP_TRANSFER` | n notes → m notes with hidden amounts. Transfer-domain kernel, optional relay fee. |
| 2 | `OP_UNWRAP` | A note → a public payout of `v − fee`. The sigma binds recipient, value, fee and deadline. |
| 3 | `OP_BRIDGE_BURN` | A note → a cross-out to Bitcoin (§6.4). |
| 4 | `OP_BRIDGE_MINT` | A reflected Bitcoin bridge burn → a note, one per `burn_id`. |
| 5 | `OP_COVENANT_MINT` | **Reserved for Bitcoin covenants** (§10). No handler; rejected. |
| 6 | `OP_SWAP` | Multi-intent AMM batch against public reserves at one uniform price. |
| 7 | `OP_LP_ADD` | Add liquidity → LP-share note. The first add initializes the pool. |
| 8 | `OP_LP_REMOVE` | LP-share note → pro-rata notes of both assets. |
| 9 | `OP_OTC` | Two-party direct swap of notes. |
| 10 | `OP_BID` | Buyer-offline partial-fill limit order with pre-signed fill grid. |
| 11 | `OP_SWAP_ROUTE` | Route through at most 4 pools with an end-to-end minimum output. |
| 12–14 | `OP_ADAPTOR_LOCK` / `_CLAIM` / `_REFUND` | Lock a note under `(T, deadline, recipient, locker)`. The claim reveals the completed signature scalar `s`, so it can drive a swap on the other chain. The locker can refund after the deadline. |
| 15 | `OP_CDP_MINT` | Lock a collateral basket and mint a debt note. |
| 16 | `OP_CDP_CLOSE` | Burn the exact debt and reclaim the basket. Owner signature. |
| 17 | `OP_CDP_LIQUIDATE` | Burn the exact debt and seize the basket. The controller must attest that the position is unhealthy. |
| 18 | `OP_CBTC_MINT` | Mint cBTC against a reflected `T_CBTC_LOCK` (§5.7). |
| 19 | `OP_CDP_TOPUP` | Replace a position with a strictly larger basket at the same debt. |
| 20–22 | `OP_FARM_BOND` / `_HARVEST` / `_UNBOND` | Farm receipts over LP-share notes (§5.8). |
| 23–25 | `OP_STEALTH_LOCK` / `_CLAIM` / `_REFUND` | Pay to a recipient's one-time key: the recipient claims with a signature, and the payer can refund after a deadline. |
| 26 | `OP_BRIDGE_STEALTH_MINT` | A Bitcoin bridge burn straight into a stealth lock. |
| 27 | `OP_WRAP_TRANSFER` | Deposit → hidden recipient and change notes in one step. |
| 28 | `OP_SEND_AND_UNWRAP` | Hidden note → public payout plus hidden change. |
| 29 | `OP_LP_BOND` | LP add fused with farm bond. |
| 30 | `OP_WRAP_CDP_MINT` | Deposits as collateral straight into a CDP mint. |
| 31 | `OP_SWAP_BLIND` | Prover-blind AMM batch (§5.6). |
| 32 | `OP_WRAP_LP` | Two public deposits → LP-share note. |
| 33 | `OP_WRAP_SWAP` | Public deposit → swap output note. Pools without a protocol fee only. |
| 34 | `OP_SURPLUS_DRAW` | Governance re-mints accrued stability-fee surplus as cUSD. Dormant until the fee is enabled. |

Codes 35–255 are free. Any other code aborts the proof.

### 5.4 Fees and relaying

Any op can be submitted by anyone. A relayed op pays its fee as a public `FeePayment` to whoever calls
`settle`.

The fee is bound by one or more of: the kernel's `f·H` term, the opening-proof context, or the
Bitcoin-note spend signature. A relayer therefore cannot redirect a payout, raise the fee or reuse the
proof. Deadlines bound into those proofs become the batch deadline.

A fee must be zero or have at most two significant decimal digits. A user who proves locally and calls
`settle` needs no relayer. See
[`docs/INTEGRATOR-PLAYBOOK.md`](./docs/INTEGRATOR-PLAYBOOK.md).

### 5.5 AMM

A pool is a constant-product curve with a fee tier, plus an optional protocol-fee switch. The switch
directs a fraction of the fee to a recipient fixed in `pool_id`. Reserves are public.

- **`OP_SWAP`** clears up to many intents at one uniform price. Traders in one batch clear at the same
  price, so they cannot sandwich each other. Each trader gets a hidden output note with a minimum-output
  bound and a signed deadline. The prover sees the amounts.
- **`OP_SWAP_ROUTE`** composes hops atomically.

A separate `TacitPublicAmm` contract applies the same reserves to plaintext ERC-20 swaps. Public and
confidential liquidity therefore share one curve.

### 5.6 Prover-blind swaps

`OP_SWAP_BLIND` keeps trade sizes out of the SP1 witness. The batcher that assembles the batch computes
the clearing and produces the Groth16 proof, so it sees the amounts. The SP1 prover and the chain do not.
Each trader submits:
- a BabyJubJub commitment to the input,
- a cross-curve sigma to its secp256k1 note,
- a blind opening proof,
- a signed relay tip.

The batch carries one `amm_swap_batch` Groth16 proof (§2.8), which the guest verifies against the
compiled ceremony key. Conservation per asset is a Schnorr kernel over the blinding excess. Each output
carries a Bulletproofs+ proof. The op accepts up to 16 intents, on pools without a protocol fee.

The input note is spent whole, and each trader signs its output and a share of the per-asset kernel
after the clearing is known. The op is enabled in the deployed guest. Swaps settle as `OP_SWAP_ROUTE` or
`OP_SWAP` until a blind-batch coordinator and pricing for its larger proving cost are wired into the relay.

### 5.7 CDP, cUSD and cBTC

**CDP.** A position is a leaf in the CDP tree holding a collateral basket and a debt. The owner cannot be
linked to the position, but the amounts are visible, because the controller prices them.

Policy lives in a controller contract, the `CollateralEngine`: prices, ratios, the rate accumulator and
the debt asset. The pool calls the controller during `settle`, and the controller can only accept or
reject. The first debt asset is **cUSD**. Its collateral is cBTC.

- Mint requires 150% collateralization. Liquidation is possible below 130%.
- Close and top-up need the owner's signature.
- Liquidation needs the engine to judge the position unhealthy, and the liquidator burns the full accrued
  debt.
- A stability fee and a savings rate are built in and dormant.

Every change that works against borrowers takes effect only after notice. For example, a feed change or a
raised liquidation ratio starts a 6-hour grace period that blocks liquidations, new mints and escrow
flagging, and the escrow grace window can never be set below 3 days.

**cBTC** is fungible BTC on Ethereum, backed by real BTC in self-custody locks:

1. A user creates a `T_CBTC_LOCK` on Bitcoin.
2. Reflection records the lock's value `v_btc`.
3. `OP_CBTC_MINT` mints a note opening to `v_btc − fee`, once per lock. It requires the engine to confirm
   a wstETH escrow of at least the engine's escrow ratio times the lock value (1.5× today; governance may
   set it between 1× and 10×). Anyone may fund the escrow.

A lock spent without `T_CBTC_REDEEM` is visible in reflection, and anyone can slash the locker's escrow
into the insurance reserve. After a proven redeem, or before any mint, each funder reclaims its own share.

cBTC's supply is bounded by reflected locks, not by an oracle. Custody is economic: the locker holds the
key, and the escrow makes spending the lock unprofitable. §10 describes the covenant path to custody that
is enforced outright.

### 5.8 Farms and locks

- **Farms.** `OP_FARM_BOND` locks LP-share notes into a receipt: a note-tree leaf committing to
  `(shares, owner, nonce)`. The `FarmManager` controller stamps the entry reward-per-share.
  `OP_FARM_HARVEST` mints the accrued reward and consumes a one-shot action id. `OP_FARM_UNBOND` returns
  the shares. Bond, harvest and unbond reach the controller as CDP records with the sentinel
  `positionLeaf = 1`, which the pool never inserts into the CDP tree. The controller escrows the reward
  asset.
- **Lock set.** Adaptor and stealth locks live in the lock tree under their own leaf domains:
  `tacit-adaptor-lock-v1`, `tacit-stealth-lock-v1` and `tacit-stealth-lock-blind-v1`. A lock is
  nullified once, by claim or by refund. A refund is valid only after its `refundNotBefore` time.

---

## 6. Reflection and the bridge

### 6.1 Header relay

`BitcoinLightRelay` is a permissionless, heaviest-work Bitcoin header relay. It checks full proof-of-work,
stores retargets, and starts from a genesis checkpoint set at deployment. Anyone can submit headers.

### 6.2 Bitcoin → Ethereum

The reflection guest proves a range of Bitcoin blocks. For each block it:

1. re-hashes every transaction to the header's Merkle root, checks the witness commitment, and excludes the
   coinbase as an envelope source;
2. nullifies every input that spends a reflected note into the spent-set IMT, whether or not the spending
   transaction is a Tacit op;
3. folds each Tacit envelope it understands:
   - transfers and atomic trades append notes after re-verifying kernel, range, asset and output layout;
   - AMM, farm and swap-batch ops update reflected pools;
   - bridge burns enter the burn IMT;
   - cBTC locks and redeems update lock records;
   - `T_BTC_CALL`s are queued;
4. extends a digest chain over its outputs.

Among plain transfers, only TAC folds unbound. Other assets onboard through `T_CXFER_BOUND`, a bridge
burn, or as AMM, farm and bid outputs. Unbound leaves are not spendable in the fast lane.

`attestBitcoinStateProven` accepts a proof only if:
- its prior digest equals the stored digest (for a successor's first attest, the predecessor's handoff
  record or its current attested state);
- its tip is an ancestor of the relay tip buried at least `REFLECTION_CONFIRMATIONS` deep (24 on mainnet)
  and within `REFLECTION_MAX_LAG = 2016` blocks;
- its consumed and cross-out counts equal the pool's live counters.

It then records the new roots and lock state.

### 6.3 Two ways Bitcoin value reaches Ethereum

- **Bridge burn → `OP_BRIDGE_MINT`.** The note is destroyed on Bitcoin, and the pool mints it once, keyed
  by `burn_id`. A burn of a note that was never reflected can still be onboarded: its provenance is proven
  back to transaction-derived leaves.
- **Fast lane.** A Bitcoin-homed note is spent directly in a Bitcoin-homed batch (§5.1). It must be absent
  from the reflected spent set and signed by its `auth_key`. The pool records the consumed source. Reverse
  reflection (§6.4) later proves that record to Bitcoin, which retires the note there.

### 6.4 Ethereum → Bitcoin

The Ethereum reflection guest is built on the sp1-helios sync-committee light client. It proves
finalized Ethereum state and storage slots of the pool:
- `crossOutCommitment`
- the consumed-source set
- `EthCallOutbox` messages

The committee chains from period to period, and each step is committed in the resume digest. The Bitcoin
reflection guest verifies this proof recursively and folds, by membership:
- `T_CROSSOUT_MINT` (0x65) re-mints crossed-out notes;
- `T_ETH_CALL` (0x69) delivers outbox messages;
- consumed sources retire fast-lane notes.

### 6.5 Value-free calls

- **Bitcoin → Ethereum.** A `T_BTC_CALL` is a Bitcoin-signed authorization of an Ethereum call. Once
  reflected, `BtcCallExecutor` executes it; it moves no pool value.
- **Ethereum → Bitcoin.** `EthCallOutbox` logs messages that reflection delivers as `T_ETH_CALL`.

### 6.6 Liveness

Reflection advances only when someone runs the provers. The reference relayer does, and anyone else can.
Ethereum-homed notes stay spendable regardless. A Bitcoin reorg deeper than the confirmation depth halts
reflection rather than rewriting it.

---

## 7. Contracts, roles and governance

### 7.1 Immutable surface

`ConfidentialPool`, `ReflectionLib`, `ConfidentialRouter`, the canonical asset factory and the three SP1
guests have no owner, no proxy and no pause. Every external address the pool uses is an immutable set in
its constructor, as are the verifier, both vkeys and the confirmation depth. The SP1 verifier is the
immutable Groth16 verifier, not an upgradeable gateway.

The pool has three privileged callers:

| Caller | Authority |
|---|---|
| `LINEAGE_STEWARD` | `createNextGen`, callable once (§8) |
| `PUBLIC_AMM` | Applies plaintext AMM trades to shared reserves |
| Farm controller | Reclaims its own reward escrow |

None of them can move a user's note or escrow.

### 7.2 Governed periphery

The ops multisig is 2-of-4. A 2-of-4 call executes after a built-in one-hour delay, and a call signed by
all four owners executes immediately. It governs:

- `CollateralEngine`: feeds, CDP ratios (the liquidation ratio is capped), the stability fee (capped),
  escrow enforcement and insurance draws. Changes that work against borrowers take effect only after
  notice (§5.7).
- `FarmManager`: reward weights. A reweight is queued publicly for 7 days, must execute within 14 days,
  changes a weight by at most ±25%, and can happen at most once every 30 days, adding a pool included.
  While a program runs, its total reward rate cannot be lowered and its end cannot move earlier.
- `TacAirdrop`: a guardian that can pause and sweep. It cannot change the root, token or deadline.

The pool consults each of them only through accept-or-reject callbacks.

### 7.3 TAC

TAC is the protocol's native asset. It was issued on Bitcoin with a fixed supply and a zero
`mint_authority`, and it has an ERC-20 face minted by the pool. Holders govern through off-chain votes
(Snapshot) that the ops multisig executes. Bitcoin governance opcodes are not assigned.

---

## 8. Deployment lineage

A pool is immutable, so the protocol evolves by deploying a successor that users opt into.

- **Isolation.** A pool's nullifiers, bridge claims, locks, roots and canonical tokens are all local to it,
  and every proof is bound to its `CHAIN_BINDING`. A pool deployed by anyone else is an isolated system
  that cannot touch this one.
- **Succession.** `createNextGen(initCode, salt)` deploys the successor from the pool's own address and
  sets `successor`. It is callable once, only by `LINEAGE_STEWARD`. The successor names this pool as its
  predecessor, and its first reflection attest rebases on
  `keccak(pred_digest ‖ consumed_count ‖ crossout_count)`, taken from the predecessor's handoff record
  (frozen at its first attest after retirement) or from its current attested state. The shared Bitcoin lane therefore continues without
  a gap.
- **Retirement.** Once `successor` is set:
  - Closed: new value, including external wraps, swaps, liquidity adds, cBTC and CDP mints, farm bonds, and
    Bitcoin-homed spends.
  - Open: every exit and every release of value already committed, including unwraps, transfers, LP
    removals, position closes and liquidations, harvests, lock claims and refunds, mints of burns that
    targeted this pool, and cross-outs once the handoff record exists.

  Reflection stays open. The steward chooses the successor's code, and has no other power.
- **Migration** is user-driven: exit one pool and enter the next. Nothing moves value automatically. At
  most one pool per lineage accepts new value at a time.

The current deployment is the root of this lineage.

---

## 9. Recovery

A wallet rebuilds every balance and position from its private key and public chain data.

| Kind | How it is recovered |
|---|---|
| Bitcoin transfers | Trial-derive blinding and keystream (§2.6) against the sender pubkey in each input witness. |
| Own etches, mints and change | Re-derive them from the wallet key and the commit anchor. |
| Fair-launch mints, AMM and farm positions | Their openings are public or derived from the key and a per-transaction anchor. |
| Stealth-address receipts | Re-derive the per-transaction tweak from ECDH and the anchor. The spend key is `sk + b mod n`. |
| Pool notes | Decrypt the memos in `LeavesInserted` events with keys derived from the wallet. Match `Wrap` deposit ids to derived wrap notes. |
| CDP and farm positions | `CdpPositionInserted` and `Bonded` events plus settle calldata, checked against the spent mappings. |

[`docs/RECOVERY.md`](./docs/RECOVERY.md) lists the exact reads.

---

## 10. Extensions and covenant placeholders

Some constructions need Bitcoin to enforce where an output can be spent. Until a covenant primitive
activates (CTV, `OP_CAT`, `OP_CHECKSIGFROMSTACK`, `OP_VAULT` or an equivalent), Tacit keeps their bytes
reserved and ships a weaker interim form.

| Reserved | Holds | Interim form today |
|---|---|---|
| Pool op `5` `OP_COVENANT_MINT` | cBTC minted against a lock whose output can only be spent into a redemption. The mint path reuses `OP_CBTC_MINT`'s value binding with no escrow. | `OP_CBTC_MINT` with wstETH escrow and slashing (§5.7) |
| Bitcoin `0x4D` / `0x4E` | Fractionalize a cBTC.zk slot into fungible shares, and reconsolidate | cBTC through the pool |
| Bitcoin `0x48` | Encrypted slot note attachment | — |
| Bitcoin `0x5D` / `0x5E` | Batched preauth-bid fills; matching both sides offline | `T_PREAUTH_BID(_VAR)` guarded by a watchtower |
| Bitcoin `0x49`–`0x4C`, `0x4F`, `0x57`–`0x5A` | Bitcoin-native fungible-BTC positions | cBTC through the pool |

With covenants:
- a cBTC lock becomes a vault whose sats can only leave through `T_CBTC_REDEEM`, so cBTC no longer needs
  escrow;
- a buyer's pre-signed bid input can be bound to its bid template on-chain;
- cBTC.zk slots can be split into fungible shares with no shared vault at all.

Other extension points are live today:
- `T_BTC_CALL` / `EthCallOutbox` for value-free cross-chain messages;
- the controller pattern (§5.7), for new debt assets and reward programs without touching the pool;
- free op codes 35–255 in the settle guest and `0x6A`–`0xFF` on Bitcoin, for a future pool deployment and
  future indexers.

---

## 11. Security properties and limits

**Enforced by proof:**
- no value is created: kernels, range proofs, reserve checks;
- no note is spent twice on either chain: nullifier sets, and the reflected spent set checked before any
  Bitcoin-homed spend;
- every spend is authorized: knowledge of the opening, `nk`, or an `auth_key` signature;
- relayers cannot redirect or inflate: fee and destination binding;
- a bridge message is paid exactly once, in exactly one deployment.

**Hidden:**
- amounts on both chains;
- which note a pool spend consumes, for owned notes (bearer and Bitcoin-homed nullifiers derive from the
  leaf alone);
- trade sizes in `OP_SWAP_BLIND` and `T_SWAP_BATCH`, from the chain and the SP1 prover;
- recipient identity for stealth receipts.

**Public:**
- Bitcoin addresses and the transaction graph;
- `asset_id` on Bitcoin transfers;
- the pool's deposit and withdrawal boundary;
- AMM reserves;
- burn amounts.

Whoever proves a batch sees its witness. `OP_SWAP_BLIND` keeps trade sizes out of that witness, though
its batcher sees them. Proving locally keeps a witness on one device end to end.

**Trusted:**
- Bitcoin and Ethereum consensus;
- SP1 and Groth16 soundness;
- the Phase-2 ceremonies, which are sound if at least one contributor was honest, and are used only by
  the circuits in §2.8;
- the sp1-helios sync committee;
- the ops multisig, within the bounds of §7.2;
- the oracle that prices cUSD.

**Not trusted:**
- relayers, the hosted API, IPFS gateways and block explorers. None of them can change validity, and the
  protocol works without them.

Security reviews are indexed in [`audit/AUDITS.md`](./audit/AUDITS.md).
