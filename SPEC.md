# tacit protocol specification

> **Status:** v1. Wire format is envelope version `0x01`, opcodes 0x21–0x2A (0x26 = `T_AXFER`, atomic OTC settlement; §5.7. 0x27 / 0x28 = `T_PETCH` / `T_PMINT`, permissionless public-mint mode; §5.8–§5.9. 0x29 / 0x2A = `T_DEPOSIT` / `T_WITHDRAW`, shielded mixer pool; §5.10–§5.11 — Groth16 verifier in production, Phase 2 trusted setup finalized 2026-05-11 with 2,227 contributions + Bitcoin-block beacon, see §10). Runs on signet + mainnet — the dApp's in-page privkey (auto-generated, imported, or locally bound to an external wallet's address) is what signs every protocol op (see §2). This spec is the authoritative reference for indexer implementations and audit review.

## 1. Overview

tacit is a **confidential token meta-protocol on Bitcoin**. It rides on Bitcoin's existing consensus by encoding asset-protocol envelopes inside Taproot script-path witness data. Token validity is enforced by an **indexer** running over chain data — there is no consensus change, no federation, no off-chain proof exchange.

Compared to other Bitcoin token meta-protocols:
- **Runes / BRC-20** — public amounts. tacit hides amounts via Pedersen commitments + bulletproofs + Mimblewimble-style kernel signatures.
- **RGB / Taproot Assets** — privacy via off-chain proof distribution; recipient must receive validity proofs from the sender out-of-band. tacit keeps everything on chain at the cost of larger witnesses, with the benefit of trustless privkey-only recovery.
- **Liquid Confidential Transactions** — same CT primitives, federated sidechain. tacit lives on Bitcoin proper.

Operations:
| | Op | Description |
|---|---|---|
| `0x21` | `CETCH` | Issue a new asset with a hidden initial supply. Optionally mintable. |
| `0x23` | `CXFER` | Transfer (split) confidential value between parties. |
| `0x24` | `T_MINT` | Issuer issues additional supply on a mintable asset. |
| `0x25` | `T_BURN` | Any holder destroys part or all of their balance. Burn amount is public. |
| `0x26` | `T_AXFER` | CXFER variant that allows non-tacit auxiliary inputs (e.g., a buyer's BTC payment) in the same Bitcoin tx, enabling atomic single-tx OTC settlement. §5.7. |
| `0x27` | `T_PETCH` | Permissionless-mint deployment record. Declares ticker, decimals, lifetime cap, fixed per-mint amount, and a height window. Creates **no** supply UTXO; deployer receives zero tokens. §5.8. |
| `0x28` | `T_PMINT` | Permissionless mint event against a `T_PETCH` ancestor. Anyone may broadcast. Mints exactly `mint_limit` tokens; reveals `(amount, blinding)` so any chain reader can audit cumulative supply against the cap. §5.9. |
| `0x29` | `T_DEPOSIT` | Lock a fixed-denomination UTXO into a shielded pool — appends a Poseidon leaf commitment `Poseidon(secret, ν, denomination)` to the pool's Merkle tree. Deposit itself is publicly attributable; unlinkability comes at withdraw time (§5.11). The same opcode with `denomination = 0` is `POOL_INIT` (creates a new pool). §5.10. |
| `0x2A` | `T_WITHDRAW` | Anonymous mint from a shielded pool. Produces a fresh tacit UTXO of the pool's denomination at vout[0], gated on a Groth16 proof of unspent leaf membership. Withdraw recipient is unlinkable to any specific deposit. §5.11. |
| `0x2B` | `T_DROP` | Lock existing supply of an asset into a public-claim pool. Spends one or more tacit UTXOs of `asset_id` summing to `cap_amount`; declares `(per_claim, cap_amount, merkle_root)` in the envelope. Supply-preserving — the deposited tokens are not destroyed, they shift from the depositor's wallet into the pool's accounting. Creates **no** tacit UTXO of the asset. §5.12. |
| `0x2C` | `T_DCLAIM` | Permissionless claim event against a `T_DROP` ancestor. Anyone may broadcast (subject to the parent drop's optional Merkle-eligibility gate). Mints exactly `per_claim` tokens from the drop pool to `vout[0]`; reveals `(per_claim, blinding)` so chain readers can audit cumulative claims against the cap. Claimant pays their own Bitcoin tx fee. §5.13. |

## 2. Trust model

| Trusted for | Mitigation if compromised |
|---|---|
| **Bitcoin (host chain)** — tx ordering, witness integrity, no double-spends | None: this is the substrate |
| **Indexer code** (the dApp HTML or a re-implementation) — correct enforcement of the rules in this spec | Re-host, audit, pin by content hash. Two browsers running the same code reach the same verdict |
| **`@noble/secp256k1` and `@noble/hashes`** — crypto primitives | Vendored under `dapp/vendor/tacit-deps.min.js` and pinned by IPFS CID alongside `dapp/index.html` + `dapp/tacit.js`. Build pipeline at `build/`; runtime KAT in `runStartupKAT()` is independent defense |
| **In-page tacit privkey** (localStorage) — signs every tacit op (P2WPKH spend, taproot script-path, kernel sig, mint authority) and is the HMAC key for blinding/keystream derivations | This is the wallet for tacit assets. It can be (a) auto-generated on first load, (b) imported from a privkey hex the user holds, or (c) **locally bound** to an external wallet's address when the user connects Xverse/UniSat/Leather. All three paths store the privkey under a `localStorage` key namespaced by **network** (`tacit-wallet-v1:signet` vs `tacit-wallet-v1:mainnet`) and, in case (c), additionally by the external wallet's address (`tacit-wallet-v1:<network>:by:<extAddr>`); reconnecting the same external wallet on the same network *in the same browser profile* re-binds to the same tacit identity. **Note:** the locally-bound case is local binding, not cryptographic derivation from the external wallet's seed — clearing localStorage or switching browsers/devices will yield a different tacit identity even if the external wallet is the same. In all three cases this in-page key is what controls asset UTXOs and must be exported and backed up. Mainnet UX gates every value-creating op behind an export-and-acknowledge step. Hardware-wallet signing for the protocol's signing paths (kernel sig, taproot script-path, HMAC-blinding) is a future enhancement — current external-wallet support does not expose those primitives. |
| **The asset's etcher (issuer)** — *the announced initial supply is what they say it is* | Out of scope cryptographically at the protocol layer (Pedersen hides the supply, so no third party can verify the announcement without the issuer's opening). Resolved at the client layer by publishing the `(supply, blinding)` opening — §7.3 spells out the IPFS-primary, worker-cached attestation flow that the reference dApp ships on by default. The protocol guarantees no inflation *downstream of etch* either way. |
| **The asset's mint authority** (mintable assets only) — *minting decisions* | Holder of the `mint_authority` private key from the CETCH envelope |

What is **not** trusted:
- Any external server (worker, IPFS gateway, mempool API) for protocol-level validity. Workers in this repo are pure caches/conveniences; setting `WORKER_BASE = ''` disables them and the protocol still works.
- Off-chain proof distribution (RGB-style). Wallets recover full balance from privkey + chain alone.
- Watchtowers, federation members, or any third party.

## 3. Cryptographic primitives

### 3.1 Curve and generators

- Curve: **secp256k1** (BIP-340 conventions for Schnorr).
- `G`: standard secp256k1 base point. Used as the **blinding generator**.
- `H`: NUMS (nothing-up-my-sleeve) generator, derived as:
  ```
  seed   = SHA256("tacit-generator-H-v1")
  for counter in 0..256:
      x = SHA256(seed || [counter])
      candidate = 0x02 || x   # try compressed, even Y
      if (point parses && nonzero):
          H = candidate
          break
  ```
  Used as the **value generator** in Pedersen commitments.

- Bulletproof vector generators `G_vec[i]`, `H_vec[i]` (`i ∈ [0, 64·8)`): same try-and-increment pattern with domain `"tacit-bp-G-v1"` and `"tacit-bp-H-v1"` plus 4-byte LE index.
- Bulletproof aux generator `Q`: derived with domain `"tacit-bp-Q-v1"`.

All of these have **no known discrete log** with respect to each other, justified by NUMS construction.

**Reference test vectors** (compressed-point hex, for cross-implementation parity):

```
H        = 02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56
Q        = 0279b66e857697b21949facaa998d6c31e4636f81f442c63f84bea33e83baafda4
G_vec[0] = 025cfa02a4913b0b122c4f275ae566e6ba52627d80036e25a43a3fd5d2062f28d4
G_vec[1] = 027608f5161dd88146ab22635ad357622a7e3fd9a293efd6fc21d18b50efab7c4e
G_vec[2] = 022f8c08dda9ade0264065a6770b219a5ee82c872f627d4503c4c3292472f1fb23
G_vec[3] = 02add28339b32e0e27075cb6cdee409acf07860ba5bf7cdca07cabf50947ed5a55
H_vec[0] = 02b78ed462f5c137b05d1e99daeb2619eb890ec4781acf098018628ca0ec0d20e2
H_vec[1] = 02ac4ee8f1ded833bf18be0815b9602b4fe0d586ade57923b35ef22e3e7c1e6ce2
H_vec[2] = 02795d359afdced0c4c7735bf61f24cdab214d43301f5210eefd46b96657a708a8
H_vec[3] = 02b65a170dfd727dd403cda635ddd2419882da910f6f79e10b24c4e5f3d171c76c
```

A re-implementation that types one of the domain strings wrong silently produces different generators and rejects every proof from the canonical implementation. These vectors are the cross-check.

### 3.2 Pedersen commitment

`C = a · H + r · G` where `a` is the amount (BigInt), `r` is the blinding scalar.

Properties:
- **Hiding** (perfect / information-theoretic): for uniformly random `r`, `C` is uniformly distributed in the group regardless of `a`, so `C` alone reveals nothing about `a` even to an unbounded adversary.
- **Binding** (computational, under the unknown-discrete-log assumption for `H` w.r.t. `G`): finding a different opening `(a', r') ≠ (a, r)` with the same `C` is equivalent to computing `log_G(H)`. The NUMS construction in §3.1 is what justifies this assumption.
- **Additively homomorphic**: `C₁ + C₂ = (a₁+a₂)·H + (r₁+r₂)·G`.

### 3.3 Bulletproofs aggregated rangeproof

Bünz et al. 2017 §3 (IPA) + §4.3 (aggregated range proof) at **n = 64 bits**. m ∈ {1, 2, 4, 8} aggregation.

Public inputs: `m` Pedersen commitments `V_j = v_j · H + γ_j · G`. Proof: `v_j ∈ [0, 2⁶⁴)` for all j.

Verifier optimizations in this implementation:
- **IPA verifier collapse**: reduce log(nm) recursive G/H vector updates to a single multi-scalar multiplication.
- **Pippenger MSM**: signed-digit windowed buckets (`c=4` for 33–128 points, `c=5` for >128). Cuts naïve O(N · 256) point-ops to O(N + 2 · 2^c) per window.
- **Batch verification**: combine N range proofs into one multi-exp using random linear combination with per-proof α (t̂ check) and β (IPA check). Soundness: failure probability ≤ 2/order ≈ 2⁻²⁵⁵.

### 3.4 BIP-340 Schnorr

Standard. Used for:
- Tap-script-path signatures on commit-reveal flows.
- **Kernel signatures** for CXFER / BURN (under the message hash defined in §5.2).
- **Mint authorization signatures** for T_MINT (under the message hash defined in §5.5).

### 3.5 Domain-separated HMAC-SHA256 derivations

All deterministic blindings + amount-encryption keystreams are HMAC-SHA256 keyed by either:
- `wallet_priv` (self-derivations), or
- `SHA256(ECDH(my_priv, their_pub).x)` (peer-derivations).

Tagged by a v1 domain string + per-output `(anchor || vout_LE)`. Domain tags **for on-chain blinding/keystream derivations** (the set this section governs):

| Tag | Purpose | Where used |
|---|---|---|
| `tacit-blind-v1` | ECDH-derived recipient blinding scalar | CXFER recipient output |
| `tacit-change-v1` | Self-derived change blinding scalar | CXFER + BURN change outputs |
| `tacit-etch-v1` | Etcher's supply blinding scalar | CETCH supply commitment |
| `tacit-mint-blind-v1` | Issuer's mint blinding scalar | T_MINT new-supply commitment |
| `tacit-amount-v1` | ECDH-derived recipient amount keystream (8B) | CXFER recipient `amount_ct` |
| `tacit-amount-self-v1` | Self-derived amount keystream (8B) | CXFER + BURN change `amount_ct` |
| `tacit-etch-amount-v1` | Etcher's supply keystream (8B) | CETCH `amount_ct` |
| `tacit-mint-amount-v1` | Issuer's mint keystream (8B) | T_MINT `amount_ct` |

Other domain-separated v1 tags appear where they're used and are not part of this table: BIP-340 Schnorr signature-message tags (`tacit-kernel-v1` §5.2, `tacit-mint-v1` §5.3, `tacit-disclosure-v1` §5.6, `tacit-axintent-{v1,claim-v2,fulfilment-v1,cancel-v1}` §5.7.6, `tacit-pool-init-v1` §5.10.1, `tacit-deposit-v1` §5.10, `tacit-withdraw-bind-v1` §5.11, `tacit-drop-v1` §5.12, `tacit-drop-reclaim-v1` §5.12.1) — note `tacit-withdraw-bind-v1` is the SHA256 domain for the withdraw bind_hash, not a Schnorr message; a related HMAC keystream `tacit-axintent-blinding-v1` (§5.7.6); generator derivations `tacit-generator-H-v1` and `tacit-bp-{G,H,Q}-v1` (§3.1); the bulletproof Fiat-Shamir transcript domain `tacit-bp-v1` (§3.3); and off-chain coordination tags (`tacit-opening-v1`, `tacit-listing-{v1,cancel-v1,claim-v1}`, `tacit-listing-range-{v1,cancel-v1,claim-v1}`, `tacit-airdrop-{leaf-v1,node-v1}`, `tacit-airdrop-claim-v1` reused by §5.13's canonical claim msg) defined by their worker endpoints in §8 — these last live entirely outside the on-chain protocol except where §5.13 explicitly reuses the airdrop leaf/node/claim-msg formats.

**Endianness convention.** Throughout this spec, `txid_BE` denotes the txid in the byte order that `SHA256(serialized_tx)` natively produces — the same bytes a Bitcoin transaction puts on the wire when it references a previous output. This is the **reverse** of the displayed/RPC hex form (e.g. `getrawtransaction` output, block-explorer URLs). In wider Bitcoin documentation this on-wire order is often called "internal" or "LE"; tacit's `_BE` label is not standard but is fixed by the test vectors in §3.1 (and `tests/vectors.test.mjs`). Implementers should treat any `_BE` field as `reverseBytes(hexToBytes(displayed_txid))`. `_LE` on integer fields (e.g. `vout_LE`, `amount_LE`) means standard little-endian integer encoding.

Anchor construction:
- **CXFER / T_AXFER / BURN**: `anchor = first_asset_input_txid_BE || first_asset_input_vout_LE`. The first asset input is `tx.vin[1]` in all three opcodes (asset inputs come immediately after the envelope-bearing `vin[0]`; T_AXFER's aux BTC inputs are appended at the tail). Per-tx entropy prevents cross-tx correlation (`(C₁ − C₂) = (a₁ − a₂) · H` leak).
- **CETCH / T_MINT**: `anchor = first_commit_input_txid_BE || first_commit_input_vout_LE`. Anchor predates the envelope (a pre-existing UTXO), breaking the envelope/commitment cycle. Scanners read it via `reveal_tx.vin[0]` → fetch commit tx → `commit_tx.vin[0]`.

**Uniqueness invariant.** Bitcoin consensus prevents any outpoint from being spent twice, so each anchor is unique across all valid txs that reference it as a first input. Combined with the per-output `vout_LE` suffix in every keystream/blinding domain, no two outputs across all valid envelopes can ever reuse the same `(domain, anchor, vout)` triple under a given keystream. This is what makes the deterministic recovery of openings from chain + privkey alone safe.

### 3.6 Poseidon hash + per-pool Merkle tree

Mixer-pool envelopes (§5.10, §5.11) require a SNARK-friendly hash and a tree-membership proof. The reference choice is **Poseidon** over BN254 with rate=2, capacity=1, and the parameters of Grassi et al. 2020 (8 full + 57 partial rounds, MDS matrix as published, S-box `x⁵`).

For each `(asset_id, denomination)` pool that has been initialized (§5.10.1), indexers maintain a deterministic **append-only Merkle tree** of fixed depth `L = 20` (≈ 1.05M leaves). Empty leaves are the constant `EMPTY_LEAF = poseidon(0)` — single-input Poseidon over the field-element zero. Deposit leaves are appended in canonical chain order: by confirmed block height, then by `(tx_index, vin[1].outpoint)` within a block. Indexers MUST cache the last 32 historical roots per pool; withdrawals (§5.11) may reference any one of them, providing a liveness window for in-flight proofs against recently-grown trees.

Two indexers running over the same chain history reach byte-identical merkle roots and nullifier sets — pool state is a deterministic function of confirmed envelopes.

### 3.7 Groth16 zk-SNARK (per-pool)

The withdrawal envelope (§5.11) carries a Groth16 proof over **BN254 (alt_bn128)** under a per-pool verifying key (`vk`). The `vk` is fixed at pool creation time (§5.10.1), pinned to IPFS by content hash, and embedded in indexer registries.

Trusted setup: Powers-of-Tau followed by a per-circuit Groth16 ceremony (Phase 2). The ceremony is **per pool** — no protocol-wide ceremony exists. Soundness assumes ≥ 1 honest contributor across the ceremony's participants for that specific pool. Privacy (the witness hides) does *not* depend on the ceremony — Groth16 has perfect zero-knowledge unconditionally.

Pool initializers (§5.10.1) bear the responsibility of running an MPC ceremony with credible contributor diversity before broadcasting the `POOL_INIT` envelope. The ceremony transcripts are pinned to IPFS and committed to in the on-chain envelope; anyone can verify the contributor count and re-run Beacon-pinning offline.

### 3.8 Withdrawal circuit (canonical reference)

Public inputs (in BN254 scalar field `Fr`):
- `merkle_root`
- `nullifier_hash`
- `denomination`
- `r_leaf` — the on-chain Pedersen blinding scalar, derived deterministically from the witness (constraint 4)
- `bind_hash`

Private inputs (witness):
- `secret`, `nullifier_preimage` ∈ `Fr`
- `path_elements[L]`, `path_indices[L]`

Constraints:

1. `leaf = poseidon(secret, nullifier_preimage, denomination)`.
2. Walking `path_elements`/`path_indices` from `leaf` reproduces `merkle_root`.
3. `nullifier_hash == poseidon(nullifier_preimage)`.
4. `r_leaf == poseidon(secret, nullifier_preimage)`. The on-chain Pedersen blinding is *forced* to a deterministic function of the depositor's secret pair, so the validator's external Pedersen check (§5.11) — `pedersenCommit(denomination, r_leaf) == recipient_commitment` — fully closes the soundness gap against an inflation attack. The malicious-withdrawer attack against an in-circuit-skipped Pedersen check fails here because they cannot pick `r_leaf` freely; the circuit constrains it. **Equivalent to an in-circuit secp256k1 multi-scalar Pedersen at ~100× lower constraint cost.**
5. `bind_squared == bind_hash * bind_hash`. No-op arithmetic constraint that binds `bind_hash` into the proof's polynomial system. Without it, a relayer or mempool observer could replay a copied proof against a substituted public input. `bind_hash` covers `(asset_id, denomination, nullifier_hash, recipient_commitment, r_leaf)` — see §5.11 for the canonical computation.

Total constraint count is dominated by the merkle path (20 levels × 1 Poseidon-2) plus 3 standalone Poseidons (leaf, nullifier, r_leaf) ≈ **5–7k constraints**. Prove time on a 2024 laptop is sub-second; verify is microseconds. The footprint fits comfortably in pot17 (130k constraints) so smaller ceremonies are practical.

## 4. Asset identity

`asset_id = SHA256(reveal_txid_BE || reveal_vout_LE)` where `reveal_vout = 0` for CETCH and T_PETCH (the etch envelope is always at the start of the reveal tx and asset_id keys off the canonical first-output position regardless of whether that vout actually carries a tacit UTXO).

This deterministically derives a 32-byte asset_id from the etch reveal transaction. T_MINT and T_PMINT envelopes reference the same `asset_id` and include `etch_txid` so the validator can resolve the originating etch envelope (CETCH for T_MINT, T_PETCH for T_PMINT — the validator rejects any cross-mode reference).

The `ticker` field is **not** unique. Multiple etches with `ticker = "USDC"` are valid; they will have distinct `asset_id` values. Wallets must display `asset_id` alongside ticker for disambiguation (same as ERC-20 contract addresses). Ticker collisions span CETCH and T_PETCH alike — the etch mode is part of an asset's identity but not part of its display name, so a CETCH `"USDC"` and a T_PETCH `"USDC"` collide on display the same way two CETCH `"USDC"` etches would.

## 5. Envelope wire format

All envelopes ride in `tx.vin[0].witness[1]` (the script-path leaf data) of a Taproot script-path spend. The witness layout is:

```
witness[0] = schnorr_sig(64 B)
witness[1] = envelope_script
witness[2] = control_block
```

`envelope_script` structure:

```
<32-byte signing pubkey> OP_CHECKSIG
OP_FALSE OP_IF
  PUSH "TACIT" (5 bytes)
  PUSH 0x01    (envelope version)
  PUSH <payload>  (split across PUSHDATA chunks ≤ 520 B each)
OP_ENDIF
```

The internal pubkey of the Taproot output is **BIP-341 NUMS** (`50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0`), so script-path is the only spend path. `OP_FALSE OP_IF … OP_ENDIF` makes the entire envelope unexecuted (similar to ordinals inscriptions).

`payload[0]` is the opcode byte. Subsections below specify each opcode's payload.

### 5.1 CETCH (`0x21`) — initial issuance

```
T_CETCH(1)
|| ticker_len(1)         u8, 1..16
|| ticker(ticker_len)    UTF-8
|| decimals(1)           u8, 0..8
|| commitment(33)        Pedersen C = supply·H + r·G (compressed)
|| amount_ct(8)          u64 LE supply XOR HMAC-keystream
|| rp_len(2)             u16 LE rangeproof length
|| rangeproof(rp_len)    aggregated bulletproof, m=1, n=64
|| mint_authority(32)    x-only Schnorr pubkey, OR all-zero (=non-mintable)
|| img_len(2)            u16 LE, 0..256
|| image_uri(img_len)    UTF-8 (typically "ipfs://bafk…")
```

Constraints:
- `decimals ≤ 8` matches Bitcoin's native unit. With 64-bit range, max display supply per asset_id at d decimals is `(2⁶⁴ − 1) / 10ᵈ`.
- `mint_authority` is permanent. A fixed-supply etch sets it to `0x00…00`; a mintable etch sets it to the issuer's wallet x-only pubkey. There is no protocol-level mechanism to rotate or transfer mint authority short of a hard fork.
- Etcher recovers `(supply, blinding)` from chain via `tacit-etch-v1` / `tacit-etch-amount-v1` derivations + commit-input anchor.

### 5.2 CXFER (`0x23`) — confidential transfer

```
T_CXFER(1)
|| asset_id(32)
|| kernel_sig(64)            Schnorr sig over kernel_msg, see below
|| N(1)                      number of outputs, ∈ {1,2,4,8}
|| (commitment(33) || amount_ct(8))  ×N
|| rp_len(2)
|| rangeproof(rp_len)        aggregated bulletproof, m=N, n=64
```

Kernel message (`in_count` and `out_count` are 1-byte unsigned; encoder and validator both reject `in_count > 255` and `out_count > 255` rather than truncating silently):
```
kernel_msg = SHA256(
    "tacit-kernel-v1"
    || asset_id(32)
    || in_count(1) || (input_txid_BE(32) || input_vout_LE(4))*in_count
    || out_count(1) || output_commitment(33)*out_count
    || burned_amount_LE(8)    # 0 for CXFER, >0 for BURN
)
```

The kernel sig verifies under `E'.x_only()` where:
```
E' = (Σ output_commitments) − (Σ input_commitments)
```
Sign with `excess = (Σ output_blindings) − (Σ input_blindings)`. If amounts balance, `E' = excess · G` (no H component) and the signature verifies. If amounts don't balance, `E'` has a non-zero H component (`δ · H + excess · G`) and producing a valid sig requires breaking DLP for H w.r.t. G — which is hard since H is NUMS.

### 5.3 T_MINT (`0x24`) — issue more supply on a mintable asset

```
T_MINT(1)
|| asset_id(32)              must equal SHA256(etch_txid_BE || 0_LE) for canonical bind
|| etch_txid(32)             reference to the original CETCH reveal tx
|| commitment(33)             Pedersen C = mint_amount·H + r_m·G
|| amount_ct(8)              u64 LE mint_amount XOR HMAC-keystream (issuer-only)
|| rp_len(2)
|| rangeproof(rp_len)        aggregated bulletproof, m=1, n=64
|| issuer_sig(64)            Schnorr sig under mint_authority pubkey
```

Mint authorization message:
```
mint_msg = SHA256(
    "tacit-mint-v1"
    || asset_id(32)
    || commit_anchor(36)         # commit_tx.vin[0].txid_BE || commit_tx.vin[0].vout_LE
    || commitment(33)
    || amount_ct(8)
)
```

The anchor binds the issuer's signature to a specific commit/reveal pair. Without it, the mint envelope payload (asset_id, commitment, amount_ct, rangeproof, issuer_sig) is fully observable on chain and an attacker could rewrap the same payload into their own commit/reveal pair to plant a validator-accepted supply UTXO at their own address. With the attestation pattern from §8 leaking the (amount, blinding) opening, that planted UTXO becomes spendable, doubling the auditable supply. The anchor is the same value the issuer already derives for the mint blinding (§3.5), so verifiers can re-derive it from `reveal_tx.vin[0].txid` → fetch commit tx → `commit_tx.vin[0]`.

Validator checks:
1. `asset_id == SHA256(etch_txid_BE || 0_LE)`.
2. Fetch the CETCH ancestor at `etch_txid`. Confirm `mint_authority ≠ 0x00…00` (asset is mintable) and `verifySchnorr(issuer_sig, mint_msg, mint_authority) == true`.
3. Range proof verifies for `commitment`.
4. `vout = 0` of the reveal tx holds the new supply UTXO. Its on-chain output script (typically a P2WPKH controlled by the issuer) is **not** validator-enforced — `mint_authority` is x-only and so does not by itself determine a unique compressed-pubkey output script. Spendability of the new supply is whatever Bitcoin rules say about that output's script, exactly as for any other tacit UTXO.

The new supply UTXO can subsequently be CXFER'd or BURN'd like any other holding.

### 5.4 T_BURN (`0x25`) — destroy supply

```
T_BURN(1)
|| asset_id(32)
|| burned_amount(8)          u64 LE — public
|| kernel_sig(64)            Schnorr sig under E' = burn·H + Σ_out − Σ_in
|| N(1)                      ∈ {0,1,2,4,8}; N=0 ⇒ burn-everything
|| (commitment(33) || amount_ct(8))  ×N
|| rp_len(2)                 omitted if N=0
|| rangeproof(rp_len)        omitted if N=0
```

Kernel message: same form as §5.2, with non-zero `burned_amount` field.

Validator equation (commitment space):
```
Σ input_commitments == burned_amount · H + Σ output_commitments
```

Equivalently, `E' = (Σ outputs) + (burned · H) − (Σ inputs)` and the kernel sig must verify under `E'.x_only()`. Soundness rests on the same DLP argument as CXFER's kernel sig.

Burns are permissionless: any holder of asset UTXOs can burn part or all of their balance. The burned amount is public so observers can audit supply reduction.

### 5.5 Validator algorithm

The validator inspects bytes at `tx.vin[0].witness[1]` and tries to decode them as a tacit envelope. It does **not** assert that the input is actually a Taproot script-path spend with the BIP-341 NUMS internal key — "envelope-bearing input" is a byte-pattern test, not a script-semantics test. Soundness for each opcode is supplied by a different mechanism, all chain-verifiable without re-checking Taproot semantics:

- **CXFER, T_AXFER, T_BURN.** A malformed or non-script-path input cannot satisfy the kernel sig + aggregated range proof: the kernel binds asset_id, every asset input outpoint, every output commitment, and the public burned amount, and the range proof bounds outputs. Tampering with any of that breaks one or both checks. `T_AXFER` (§5.7) additionally allows non-tacit aux inputs at `vin[1+asset_input_count..]`; those don't enter the kernel msg, so they can't affect the asset-side balance equation.
- **T_MINT.** The issuer's BIP-340 sig under `mint_authority` (resolved from the parent CETCH) is bound to the `commit_anchor` (commit_tx.vin[0].outpoint), so an attacker rewrapping the on-chain mint payload into their own commit/reveal pair would need a fresh issuer sig over the new anchor.
- **CETCH.** No kernel sig and no anchor sig — anyone can broadcast a CETCH-shaped envelope. This is intentional: there is no "the asset" to forge, because `asset_id = SHA256(reveal_txid_BE || 0_LE)` makes every well-formed CETCH a *new* asset whose identity is bound to the tx that carried it. Soundness for CETCH is just that its supply commitment carries a valid range proof; a forger has nothing to gain by re-using bytes from another etch since they would only be re-etching it under a fresh `asset_id`.
- **T_PETCH.** Same posture as CETCH — no sig, no anchor. Forging gives a fresh `asset_id` under the forger's reveal-tx, not control of an existing one. Soundness here additionally requires `cap_amount % mint_limit == 0` and the height-window invariants (§5.8) so the mint state machine is well-defined.
- **T_PMINT.** No signature. Soundness rests on three indexer-enforced invariants, all derivable from confirmed chain state: (1) `amount == petch.mint_limit`, (2) the T_PMINT's confirmed block height lies within the height window declared by the parent T_PETCH, and (3) the cumulative count of canonically-earlier valid T_PMINTs against the same `asset_id`, multiplied by `mint_limit`, is strictly less than `cap_amount`. Replay of a published T_PMINT envelope into a fresh commit/reveal pair is allowed but cost-symmetric with honest minting (§5.9 *Replay analysis*) — it consumes a cap slot at full Bitcoin-fee cost and produces a UTXO at the rewrapper's output script with the same opening; it does not steal the original miner's UTXO.
- **T_DROP.** Kernel sig on the asset-side balance equation `Σ C_in − cap_amount · H == excess · G`, exactly as in T_DEPOSIT (§5.10). The Mimblewimble argument is identical: the depositor cannot produce a valid x-only signature unless the consumed inputs' committed amounts sum to `cap_amount`. Per-drop `(per_claim, cap_amount, merkle_root, expiry_height)` are envelope plaintext; the indexer fixes them at drop-creation time and they cannot subsequently mutate.
- **T_DCLAIM.** No signature on the claim itself — the *eligibility witness* (eth_sig + merkle proof) IS the authentication when the parent drop sets a non-zero `merkle_root`. Soundness rests on four indexer-enforced invariants, all derivable from confirmed chain state: (1) `amount == drop.per_claim`, (2) `confirmed_height ≤ drop.expiry_height` (or no expiry if zero), (3) cumulative `(prior valid T_DCLAIMs against drop_id) × per_claim + amount ≤ cap_amount`, and (4) if `drop.merkle_root ≠ 0`, then the witness's merkle proof verifies against `(eth_address, per_claim, leaf_index)`, the eth_sig recovers `eth_address` from the EIP-191 hash of the canonical claim msg over `vout[0]`'s recipient pubkey, and `(drop_id, leaf_index)` is not already in the claimed-leaf set. Replay of a published T_DCLAIM envelope into a fresh commit/reveal pair is allowed but cost-symmetric with honest claiming (§5.13 *Replay analysis*).

The Taproot script-path framing in §5 (`OP_FALSE OP_IF` envelope, NUMS internal key) describes the canonical encoding — what writers SHOULD produce — and is what makes the witness slot cheap and inert under Bitcoin consensus. Validators do not enforce it. A future revision that requires Taproot validation would not change protocol soundness; it would only narrow what a writer is allowed to produce.

For each wallet UTXO, walk back through ancestry:

```
validateOutpoint(txid, vout):
    if cached:                                return cached
    fetch parent tx; decode envelope at vin[0].witness[1]
    if envelope.opcode == T_CETCH:
        verify range proof on its commitment
        vout must == 0
        record metadata (ticker, decimals, mint_authority, image_uri)
        return true
    if envelope.opcode == T_MINT:
        verify asset_id == SHA256(etch_txid_BE || 0_LE)
        fetch CETCH ancestor; recursively validateOutpoint(etch_txid, 0)
        confirm mintable and issuer_sig under mint_authority (with commit_anchor binding)
        verify range proof on mint commitment
        vout must == 0
        return true
    if envelope.opcode in {T_CXFER, T_BURN}:
        recursively validateOutpoint each input outpoint (tx.vin[1..])
        verify aggregated range proof for outputs (skip if BURN with N=0)
        verify asset_id consistency: every input's parent envelope must declare the same asset_id
        compute E' (with burned·H term if BURN) and verify kernel_sig under E'.x_only()
        return true
    if envelope.opcode == T_AXFER:
        # See §5.7. Identical to CXFER except aux BTC inputs at
        # vin[1+asset_input_count..] are not validated as tacit ancestors.
        decode asset_input_count from payload
        require 1 <= asset_input_count <= len(tx.vin) - 1
        recursively validateOutpoint each in tx.vin[1 .. 1+asset_input_count]
        verify aggregated range proof for outputs[0..N]
        verify asset_id consistency across asset_inputs only
        compute E' from asset_inputs + outputs (no burn term) and verify kernel_sig under E'.x_only()
        return true
    if envelope.opcode == T_PETCH:
        # See §5.8. Deployment record only — no UTXO produced at any vout.
        # T_PETCH is reached during ancestry walks only when a wallet
        # accidentally treats the reveal tx's vout 0 as a tacit UTXO; the
        # correct answer is "not a tacit UTXO". Indexer cron records T_PETCH
        # metadata via a separate non-recursive scan path.
        return false
    if envelope.opcode == T_PMINT:
        verify asset_id == SHA256(etch_txid_BE || 0_LE)
        # Parent lookup is a metadata read, not an ancestry recursion: T_PETCH
        # has no spendable parent UTXO to validate. The validator looks up
        # T_PETCH metadata by etch_txid (cached during cron scan, or fetched
        # ad-hoc by decoding the reveal tx at etch_txid).
        petch = lookupPetchMetadata(etch_txid)
        require petch != null and petch.opcode == T_PETCH
        verify amount == petch.mint_limit
        let effective_start = petch.mint_start_height ≠ 0 ? petch.mint_start_height : (petch.etch_height + 1)
        let effective_end   = petch.mint_end_height   ≠ 0 ? petch.mint_end_height   : ∞
        verify confirmed_height ∈ [effective_start, effective_end]
        verify (count of canonically-earlier confirmed T_PMINTs against this
                asset_id at depth ≥ 3) * mint_limit + amount <= cap_amount
        verify 0 < blinding < curve_order
        verify pedersenCommit(amount, blinding) == commitment
        vout must == 0
        return true
    if envelope.opcode == T_DEPOSIT:
        # See §5.10. Consumes the asset input and appends a leaf to the per-
        # pool merkle tree; produces no tacit UTXO. POOL_INIT (denomination
        # sentinel = 0) is a metadata event handled by the same scan path.
        return false
    if envelope.opcode == T_WITHDRAW:
        # See §5.11. Produces a fresh tacit UTXO at vout[0] gated on a Groth16
        # proof of unspent leaf membership in the pool. Recursive validation
        # of any UTXO produced by T_WITHDRAW does NOT recurse through pool
        # ancestry — the proof + nullifier check is the protocol-level
        # validity. Pool-level state (tree, nullifiers, registered vk) is
        # maintained by the cron-mode scan path described in §3.6 and §5.10.
        require pool registered for (asset_id, denomination)
        require merkle_root in last 32 canonical roots of this pool
        require nullifier_hash NOT in this pool's spent-nullifier set
        verify Groth16 proof under pool.vk over public inputs
            [merkle_root, nullifier_hash, denomination,
             recipient_commitment.x, recipient_commitment.y, bind_hash]
        record nullifier_hash as spent
        vout must == 0
        return true
    if envelope.opcode == T_DROP:
        # See §5.12. Consumes asset inputs whose committed amounts sum to
        # cap_amount; declares the drop pool's parameters; produces no tacit
        # UTXO of the asset. The pool's accounting (cap_amount, per_claim,
        # merkle_root, cumulative_claimed, claimed_leaf_set) is maintained
        # by the cron-mode scan path; the recursive validator merely returns
        # false so ancestors don't treat the reveal tx's vout 0 as a tacit
        # asset UTXO.
        return false
    if envelope.opcode == T_DCLAIM:
        # Parent lookup is a metadata read, not an ancestry recursion: T_DROP
        # consumes the supply and produces no asset UTXO. The validator
        # fetches the parent tx by drop_reveal_txid (carried in the T_DCLAIM
        # payload) and decodes its envelope; drop_id = SHA256(drop_reveal_txid_BE
        # || 0_LE) is the indexer's KV key, derived locally.
        drop_id = SHA256(drop_reveal_txid_BE || 0_LE)
        parent_tx = fetch(drop_reveal_txid)
        parent_env = decode(parent_tx.vin[0].witness[1])
        require parent_env != null and parent_env.opcode == T_DROP
        drop = decodeDropPayload(parent_env.payload)
        require drop != null and drop.per_claim > 0    # reject reclaim variant as a claim parent
        verify asset_id == drop.asset_id
        verify amount == drop.per_claim
        let effective_end = drop.expiry_height ≠ 0 ? drop.expiry_height : ∞
        verify confirmed_height ≤ effective_end
        verify (count of canonically-earlier confirmed T_DCLAIMs against this
                drop_id at depth ≥ 3) * per_claim + amount <= cap_amount
        if drop.merkle_root != 0:
            # Eligibility-gated drop. Witness MUST carry (recipient_pub,
            # leaf_index, eth_address, eth_sig, merkle_proof). recipient_pub
            # is the 33-byte compressed pubkey controlling vout[0]; the
            # eth_sig binds them by signing the canonical claim msg over
            # their tacit pubkey.
            verify hash160(witness.recipient_pub) == vout[0].scriptpubkey[2:22]
            verify merkle_proof(drop.merkle_root, witness.leaf_index,
                                leaf(witness.eth_address, per_claim, witness.leaf_index))
            verify eth_sig recovers witness.eth_address from EIP-191 hash of
                canonical_claim_msg(drop.merkle_root, drop.network, asset_id,
                                    witness.eth_address, witness.leaf_index, per_claim,
                                    drop.ticker, drop.decimals, witness.recipient_pub)
            verify (drop_id, witness.leaf_index) NOT in claimed_leaf_set
            record (drop_id, witness.leaf_index) as claimed
        verify 0 < blinding < curve_order
        verify pedersenCommit(amount, blinding) == commitment
        vout must == 0
        return true
    return false
```

Recursion is memoized via a `(txid, vout) → bool` map. In production-mode optimization, all rangeproofs are deferred into a batched bulletproof verify (one multi-exp); falls back to per-proof verify if batch fails.

### 5.6 Range disclosure (`balance ≥ K`)

A holder may publish a zero-knowledge proof that the sum of their balances across a chosen set of UTXOs of a given asset is at least `K`, without revealing the actual balance. This is an **off-chain** primitive: nothing about it touches Bitcoin's witness data. The proof is published to the worker's `/assets/:asset_id/disclosures` endpoint and any third party can verify it from chain data + the proof bytes alone.

Soundness sketch. Let `C_i = a_i · H + r_i · G` be the holder's UTXO commitments for the asset. Define `C_sum = Σ C_i = a_sum · H + r_sum · G` (additively homomorphic, §3.2). The prover computes `v = a_sum − K` and produces a 64-bit aggregated bulletproof on the commitment `C' = v · H + r_sum · G`. Equivalently, `C' = C_sum − K · H` — the verifier reconstructs `C'` from the on-chain commitments without ever learning `a_sum` or `r_sum`. A valid range proof on `C'` bounds `v ∈ [0, 2⁶⁴)`, which is `a_sum ≥ K` (modulo the `a_sum < 2⁶⁴ + K` precondition required by the proof system).

Disclosure message:
```
disclosure_msg = SHA256(
    "tacit-disclosure-v1"
    || asset_id(32)
    || N_LE(2)                    # u16 LE, count of utxos
    || (txid_BE(32) || vout_LE(4)) × N
    || threshold_LE(8)            # u64 LE
    || rangeproof_bytes
    || owner_pubkey(33)           # compressed
)
```

Disclosure record (stored shape; `asset_id` is taken from the URL path on POST and echoed in `GET` responses, the other fields are the POST body):
```
{
  asset_id:     hex(32),          # from URL path /assets/:asset_id/disclosures
  utxos:        [{txid, vout}, …],
  threshold:    decimal string, 0 < K < 2⁶⁴,
  rangeproof:   hex,
  owner_pubkey: hex(33),
  sig:          hex(64)           # BIP-340 Schnorr over disclosure_msg, x-only key from owner_pubkey
}
```

The reference worker enforces `1 ≤ utxos.length ≤ 64` on POST. The wire format above (the canonical reference for interop) only requires `0 < N_LE < 2¹⁶`; deployments may pick a different cap.

Verifier requirements:
1. `0 < K < 2⁶⁴`.
2. For every listed UTXO: parent tx exists; vout's `scriptpubkey` is P2WPKH whose 20-byte hash equals `HASH160(owner_pubkey)`; parent's `vin[0].witness[1]` decodes as a tacit envelope; `getParentEnvelopeData(env, vout)` returns a commitment with the declared `asset_id`.
3. BIP-340 Schnorr verify of `sig` over `disclosure_msg` under `owner_pubkey` (x-only).
4. Bulletproof verifies on `C' = (Σ on-chain C_i) − K · H`.

Privacy caveats.
- `utxos[]` is public — the verifier learns *which* UTXOs back the disclosure (graph privacy is not a goal of v1, §9).
- `owner_pubkey` is published in cleartext, equal to the spending key of every listed UTXO.
- `K` itself is public.
- The disclosure does not prevent double-counting: the same UTXO may be referenced by two disclosures from the same owner. Consumers requiring exclusivity must pin disclosures to a UTXO set they consider canonical at observation time.

Replay rules.
- Disclosures are not bound to a timestamp or block height. A disclosure remains "true" only as long as every listed UTXO is still owned by `owner_pubkey` and unspent. Any verifier that needs current truth MUST re-check UTXO ownership and unspent-ness against the chain at query time. The worker may garbage-collect disclosures that reference spent UTXOs.
- The worker dedupes by `(asset_id, owner_pubkey, K)`: re-publishing for the same triple overwrites the earlier UTXO set, proof, and timestamp. Different `K` values from the same owner coexist as separate disclosures.

This primitive is implementation-defined in v1: the wire format above is the canonical reference for any implementation that wants to interoperate. Indexer-level validity is unaffected — disclosures live entirely outside the on-chain protocol.

### 5.7 T_AXFER (`0x26`) — atomic OTC settlement

CXFER is structurally complete for confidential transfers but presupposes that *every* `vin` after the envelope-bearing `vin[0]` is a tacit asset input. That precludes mixing a tacit transfer with a non-tacit Bitcoin payment in the same Bitcoin tx — the use case for atomic OTC settlement, where a maker's CXFER reveal and a taker's BTC payment must close together so neither party can grief.

`T_AXFER` is a CXFER variant that explicitly declares how many of `tx.vin[1..]` are tacit asset inputs. Subsequent inputs are auxiliary — Bitcoin-only, ungoverned by tacit semantics. Old wallets/indexers running v1.0 of this spec see opcode `0x26`, fail to decode, and reject the UTXO; once they upgrade, every UTXO they previously rejected validates the same way they validate CXFER today, with no chain rewrite.

```
T_AXFER(1)
|| asset_id(32)
|| asset_input_count(1)        u8, 1..255 — vin[1..1+asset_input_count] are tacit asset inputs
|| kernel_sig(64)              Schnorr sig over kernel_msg, see below
|| N(1)                        number of tacit outputs, ∈ {1,2,4,8}
|| (commitment(33) || amount_ct(8))  ×N
|| rp_len(2)
|| rangeproof(rp_len)          aggregated bulletproof, m=N, n=64
```

Constraints enforced at decode:
- `asset_input_count ≥ 1` (a `T_AXFER` with no asset inputs is rejected — it's a degenerate "create-from-nothing" attempt the kernel sig already prevents, but rejecting up-front is cheaper than letting the kernel sig do the work).
- `asset_input_count + 1 ≤ tx.vin.length` (the declared asset inputs must actually exist in the tx).
- `N ∈ {1,2,4,8}` (same aggregation constraint as CXFER).

Kernel message — **identical to CXFER's kernel msg in §5.2**, with `in_count := asset_input_count`:
```
kernel_msg = SHA256(
    "tacit-kernel-v1"
    || asset_id(32)
    || asset_input_count(1) || (input_txid_BE(32) || input_vout_LE(4))*asset_input_count
    || N(1) || output_commitment(33)*N
    || burned_amount_LE(8)    # always 0 for T_AXFER; T_BURN's analog is out of scope here
)
```

The same domain tag (`"tacit-kernel-v1"`) is reused deliberately. The kernel msg semantics are identical between `CXFER (0x23)` and `T_AXFER (0x26)` — both bind exactly the asset side of the transfer (asset_id, asset input outpoints, output commitments, burned=0). A signature for one verifies the same balance equation under the other; this is harmless because the asset inputs and output commitments are themselves part of the msg, and the prover cannot synthesize a valid sig over a different tx's asset side. The opcode byte is a presentation choice — what `vin[1+asset_input_count..]` are allowed to be — not a cryptographic invariant.

The kernel sig verifies under `E'.x_only()` exactly as in §5.2, computed only over the declared asset inputs and the declared tacit outputs:
```
E' = (Σ output_commitments[0..N]) − (Σ asset_input_commitments)
```
Auxiliary `vin[1+asset_input_count..]` and `vout[N..]` do not enter `E'`. Their security is whatever Bitcoin's own consensus rules give them: each aux input must be signed by its owner per standard Bitcoin script semantics; each aux output is just satoshis going somewhere. None of that touches tacit asset value.

#### 5.7.1 Validator algorithm extension

Insert between the CETCH/MINT and the existing CXFER/BURN branches:

```
if envelope.opcode == T_AXFER:
    decode asset_input_count, kernel_sig, outputs[0..N], rangeproof from payload
    require asset_input_count >= 1 and asset_input_count + 1 <= len(tx.vin)
    require N in {1,2,4,8}
    asset_inputs = tx.vin[1 .. 1+asset_input_count]
    # tx.vin[1+asset_input_count..] are auxiliary BTC inputs — NOT validated here
    recursively validateOutpoint each input outpoint in asset_inputs
    verify aggregated range proof for outputs (m=N)
    verify asset_id consistency: every parent envelope of asset_inputs declares the same asset_id
    compute E' from asset_inputs + outputs and verify kernel_sig under E'.x_only()
    return true
```

Vouts beyond `N-1` are not tacit UTXOs. A wallet querying `validateOutpoint(reveal_txid, vout >= N)` against a `T_AXFER` envelope returns `false` — the indexer correctly identifies that vout as outside the tacit footprint of the tx. The user's wallet treats it as a regular Bitcoin UTXO. This matches CXFER's behavior on out-of-range vouts.

#### 5.7.2 Soundness

Same argument as §5.2, restricted to the asset side of the tx:

- **No inflation downstream.** `E' = Σ_out_tacit C − Σ_asset_in C`. A balanced tx has `δ = Σa_out − Σa_in = 0` and `E' = excess·G` (no H component); kernel sig verifies under `excess`. An unbalanced tx has `δ ≠ 0`, `E' = δ·H + excess·G`, and producing a sig under `E'.x_only()` requires breaking DLP for H w.r.t. G. Aux BTC inputs/outputs never enter this equation, so they cannot inflate or deflate the tacit side.
- **No negative-amount smuggling.** Aggregated bulletproof on `outputs[0..N]` bounds each amount to `[0, 2⁶⁴)` — same as CXFER.
- **Replay protection.** Kernel msg binds `(asset_id, asset_input_outpoints, output_commitments, burned=0)`. A `T_AXFER` payload reused in a different tx must reuse those exact asset inputs; Bitcoin consensus prevents any outpoint from being spent twice, so cross-tx replay of the kernel sig is impossible.
- **Aux BTC tampering.** A taker reorders or replaces aux BTC inputs/outputs *after* the maker signed the reveal — see §5.7.3 for the SIGHASH discipline that makes this safe (or unsafe) on a per-implementation basis. The kernel sig itself is unaffected because the kernel msg doesn't bind aux inputs/outputs.

#### 5.7.3 Off-chain coordination (PSBT-style flow)

`T_AXFER` is the on-chain shape. The atomic-settlement choreography is implementation-defined and lives off-chain; this section describes the canonical pattern the reference dApp follows so other implementations can interop.

**Maker (seller) prepares a partially-signed reveal tx:**
1. Picks the asset UTXOs being sold; computes the CXFER reveal kernel sig + bulletproof + envelope script as in §5.2.
2. Builds the reveal tx with:
   - `vin[0]` = the commit-tx P2TR (envelope-bearing), signed via taproot script-path with `SIGHASH_SINGLE | ANYONECANPAY` (= `0x83`)
   - `vin[1..1+asset_input_count]` = the maker's tacit asset UTXOs, each signed via P2WPKH with `SIGHASH_SINGLE | ANYONECANPAY`
   - `vout[0..N-1]` = the tacit output commitments (recipient + change)
   - The tx is "open-ended": the taker can append `vin[1+asset_input_count..]` and `vout[N..]` without invalidating the maker's sigs (SIGHASH_SINGLE binds vin[i] to vout[i] only; ANYONECANPAY drops binding to other inputs).
3. Encodes the partial reveal as a tacit-PSBT (PSBT with the proprietary keys defined in §5.7.4) and shares with the taker.

**Taker (buyer) finalizes:**
1. Parses the tacit-PSBT; runs §5.7's validator algorithm against the in-flight reveal to confirm the kernel sig + bulletproof + envelope are well-formed and that the output to the taker decrypts to the agreed amount.
2. Appends:
   - `vin[1+asset_input_count..]` = the taker's BTC funding input(s), signed `SIGHASH_ALL` (taker pins the whole tx now that no further changes are allowed).
   - `vout[N..]` with the BTC payment to the maker's address (`price_sats` to maker; optional change back to taker; optional fee delta).
3. The maker's vin[0] sig signs over `(vin[0], vout[0])` only — vout[0] is the recipient tacit commitment, fixed at maker-sign time. The taker cannot modify vout[0] without invalidating that sig.
4. The maker's `vin[1..1+asset_input_count]` sigs each sign over `(vin[i], vout[i])` only. Vouts at index `i` for `1 ≤ i < N` are tacit change/recipient commitments; `vout[N..]` are aux BTC and are NOT bound by any maker sig (SIGHASH_SINGLE on vin[k] for k ≥ N has no corresponding vout — implementations MUST sign with SIGHASH_NONE | ANYONECANPAY for such inputs, or arrange for at least one tacit vout per maker asset input). The reference dApp constrains tx layout so each maker input has a tacit-vout counterpart, sidestepping this.
5. Broadcasts.

**What's protected vs. what isn't:**
- Maker cannot rug-pull post-broadcast: the kernel sig + tacit-input sigs are committed to the recipient's tacit commitment. The taker sees this on-chain alongside their own BTC payment.
- Taker cannot get tokens without paying: a reveal tx with `vout[N..]` BTC stripped/redirected would invalidate the taker's own SIGHASH_ALL sig, so the tx wouldn't broadcast.
- Maker double-spend race: between PSBT delivery and broadcast, the maker can spend their asset UTXOs in another tx. Mitigation is operational (taker broadcasts promptly, CPFP if needed) — this matches Magic Eden's ordinals listings.

#### 5.7.4 Tacit-PSBT proprietary keys

PSBT (BIP-174) supports proprietary key types under the `0xfc` keytype prefix with a per-application identifier. For tacit-PSBT, identifier = ASCII `"TACIT"` (5 bytes). Within the `TACIT` namespace:

| Subtype | Key-data | Value | Where |
|---|---|---|---|
| `0x00` | (empty) | envelope script bytes (the leaf script of `vin[0]`) | input map at `vin[0]` |
| `0x01` | (empty) | control block bytes (the script-path control block of `vin[0]`) | input map at `vin[0]` |
| `0x02` | (empty) | u8: `asset_input_count` (matches the on-chain field width in §5.7) | global map |
| `0x03` | u8: input index (0..N-1) | `(commitment(33) || amount_ct(8) || blinding_hint(33))` for the recipient — the blinding hint is the sender's compressed pubkey, which the recipient combines with their own privkey via ECDH per §3.5 to recover the blinding | global map |

The `blinding_hint` lets the taker pre-verify their tacit-output commitment without a separate share-link. Other tacit outputs (change to maker, recipient outputs to other parties) are not annotated; the taker has no need to open them and the maker recovers their own change via §6.

Implementations that don't ship a PSBT extension can fall back to a JSON envelope of the same shape; the proprietary-key form is provided so a future Sparrow/Specter/etc. plugin can do the listing-take flow with their existing tooling.

#### 5.7.5 Comparison with CXFER

| | `CXFER` (0x23) | `T_AXFER` (0x26) |
|---|---|---|
| All `vin[1..]` must be tacit asset inputs | yes | no — only `vin[1..1+asset_input_count]` are |
| Allows BTC payments in the same Bitcoin tx | no | yes (at `vin[1+asset_input_count..]` and `vout[N..]`) |
| Kernel msg | binds all of `vin[1..]` | binds only the declared asset inputs |
| Aggregated bulletproof | over `outputs[0..N]` | over `outputs[0..N]` (unchanged) |
| Recovery (§6) | unchanged | unchanged — recipient/change derivations key off the asset side, ignoring aux inputs |
| Use cases | private transfers, etcher's own change, simple sends | OTC marketplace settlement, atomic asset-for-BTC swaps |

Both opcodes are first-class. A confidential send between two known parties has no reason to use `T_AXFER`; the witness is a few bytes smaller as `CXFER`. Marketplace settlement (where a taker funds the same Bitcoin tx) uses `T_AXFER`. The validator handles both interchangeably as ancestors of any future descendant CXFER/BURN.

#### 5.7.6 Atomic intents (browse-and-take)

§5.7.3 covers the targeted-recipient flow: the maker knows the taker's pubkey at intent-build time and signs a partial reveal that's complete except for the taker's BTC-side inputs. That works for one-shot bilateral OTC but rules out a public marketplace, because a CXFER recipient blinding is `HMAC(ECDH(maker_priv, taker_pub), …)` (§3.5) — without the taker's pubkey, the maker can't compute the recipient commitment, so they can't sign the kernel.

**Atomic intents** lift that restriction with one wire-format-irrelevant trick: the maker generates a fresh per-intent recipient blinding as a uniform-random scalar and uses it to fix the recipient commitment at intent-publish time, independent of any taker pubkey. The Bitcoin output script (`P2WPKH(taker_pub)`) still binds the recipient identity — that's set at fulfilment time, after a specific taker has claimed the intent. Atomicity is preserved end-to-end.

The blinding scalar `r` is **never published cleartext**. Doing so would let any observer recover the listed amount via baby-step-giant-step over `a·H = C - r·G` (≈seconds for 64-bit amounts; milliseconds for low-decimal assets). Instead, the maker holds `r` privately on their device and, at fulfilment time, encrypts it to the claimant's pubkey via an ECDH-derived 32-byte keystream:

```
ks = HMAC-SHA256(SHA256(ECDH(maker_priv, taker_pub)),
                 "tacit-axintent-blinding-v1" || intent_id || asset_id)
enc_recipient_blinding = r XOR ks            // 32 bytes
```

The keystream is bound to `(intent_id, asset_id)` so a ciphertext from one intent cannot be replayed against another. Symmetric ECDH means the claimant decrypts with `(taker_priv, maker_pub)` to recover the same `ks` and hence `r`. The worker stores the ciphertext opaquely and forwards it on the fulfilment GET; only the named claimant can decrypt.

This is purely a coordination layer on top of `T_AXFER` — no new opcode, no new wire format, no consensus implication. The reference dApp ships it; an alternative implementation can ignore it and still validate intent-mediated settlements correctly because the on-chain bytes are indistinguishable from a §5.7.3-style targeted offer.

##### Records

The off-chain marketplace stores three records per intent:

```
intent {
  intent_id            16 bytes / 32 hex chars (sha256(commit_txid_BE || maker_pubkey)[:16])
  asset_id, maker_pubkey (33B compressed), maker_address (bech32),
  amount               u64 base units (cleartext — the listed amount)
  price_sats           u64
  expiry               unix-seconds (≤ 365 days from publish)
  commit_txid          the maker's already-broadcast commit tx
  commit_value         u64 sats locked in the commit P2TR
  p2tr_spk_hex         34-byte segwit script (00 20 || tweaked-key)
  asset_utxo           { txid, vout, value }
  envelope_script_hex  the leaf script committed in the commit P2TR
                       (carries the on-chain recipient commitment in its T_AXFER payload)
  control_block_hex    the 33-byte tapscript control block
  intent_sig           BIP-340 over intent_msg, under maker_pubkey
}

  // The recipient_blinding scalar `r` is NOT in this record (deliberately —
  // see the privacy paragraph above). The maker holds it locally; the
  // taker receives it encrypted at fulfilment time.

claim {
  intent_id, taker_pubkey (33B),
  taker_utxo { txid, vout, value }   // P2WPKH-controlled by taker_pubkey,
                                     // value ≥ intent.price_sats. Worker
                                     // verifies on-chain at claim time as a
                                     // proof-of-funds gate; not locked, just
                                     // attested.
  sig, claimed_at, expires_at        // 5-min TTL
}

fulfilment {
  intent_id, taker_pubkey,
  partial_reveal           JSON-encoded partial Bitcoin tx with maker
                           SIGHASH_SINGLE_ACP sigs targeted at the claimant's pubkey
  enc_recipient_blinding   32-byte hex — `r XOR HMAC-SHA256(SHA256(ECDH(maker_priv,
                           taker_pub)), "tacit-axintent-blinding-v1" || intent_id || asset_id)`
  fulfilment_sig           BIP-340 over fulfilment_msg, under maker_pubkey
  fulfilled_at             unix-seconds — fulfilments older than 24h are GC'd
                           on read so the maker can re-fulfil for a new claimant
}
```

##### Canonical messages

```
intent_msg = SHA256(
    "tacit-axintent-v1"
    || asset_id(32) || intent_id(16) || maker_pubkey(33)
    || amount_LE(8) || price_LE(8) || expiry_LE(8)
    || commit_txid_BE(32) || asset_utxo_txid_BE(32) || asset_utxo_vout_LE(4)
)

claim_msg     = SHA256("tacit-axintent-claim-v2"     || asset_id || intent_id || taker_pubkey
                       || taker_utxo_txid_BE(32) || taker_utxo_vout_LE(4))
// The bound funding UTXO outpoint pins the claim to a specific source of
// sats — a captured sig cannot be re-aimed at a different outpoint. The
// worker re-checks that the bound UTXO is P2WPKH-controlled by
// taker_pubkey and value ≥ intent.price_sats before accepting the claim
// (proof-of-funds gate; not locked).
fulfilment_msg = SHA256("tacit-axintent-fulfilment-v1" || asset_id || intent_id || taker_pubkey
                       || SHA256(partial_reveal_json))
cancel_msg    = SHA256("tacit-axintent-cancel-v1"    || asset_id || intent_id)
```

`intent_id` is `SHA256(commit_txid_BE || maker_pubkey)[:16]` — stable per intent, derivable by anyone given the commit txid and maker pubkey, and unique because commit_txid is unique in Bitcoin.

##### Lifecycle (state machine)

```
[publish]   maker:   build & broadcast commit tx + post intent → intent stored
[browse]    anyone:  GET /atomic-intents → discover open intents
[claim]     taker:   POST /:intent_id/claim with taker_pubkey + a committed
                     funding UTXO (P2WPKH, value ≥ price_sats) → 5-min lock
[fulfil]    maker:   POST /:intent_id/fulfilment with partial reveal targeted at claimant
[take]      taker:   GET fulfilment, append BTC funding signed SIGHASH_ALL, broadcast
[settled]   anyone:  the on-chain T_AXFER is indistinguishable from a §5.7.3 settlement
```

If the taker doesn't broadcast within the claim window, the lock expires and the intent goes back to "browse" state. The maker's commit tx is unaffected and a new claim can come in. If the maker doesn't fulfil within the claim window, the same applies.

##### Trust analysis

The atomic intent flow inherits §5.7.2 soundness from `T_AXFER` itself, plus three coordination-layer guarantees:

- **Maker can't redirect the taker's payment.** The maker's `vin[1]` (asset input) is signed `SIGHASH_SINGLE_ACP`, binding `vout[1]` = BTC payment to maker. If the taker rewrote `vout[1]` (e.g., to redirect payment), maker's sig becomes invalid → Bitcoin consensus rejects.
- **Taker can't get tokens without paying.** The taker's `SIGHASH_ALL` sig on their funding input commits to the entire tx including the maker's payment output. Removing `vout[1]` invalidates the taker's sig. The taker can't sign a fresh sig that excludes payment because that would make `vin[1]`'s sig (maker's, unchanged) bound to a nonexistent vout.
- **Maker can't fulfil for a different taker than the one who claimed.** `fulfilment_msg` binds `taker_pubkey` and the partial reveal's hash. The worker rejects mismatches; clients cross-check the partial reveal's `vout[0].scriptpubkey` is `P2WPKH(hash160(claim.taker_pubkey))`.

What atomic intents *don't* protect against:

- **Maker double-spend race.** Between fulfilment-posting and taker-broadcast, the maker could in principle race-spend the asset UTXO in another tx. Same race as ordinals atomic listings. Mitigation is operational: the taker broadcasts immediately on receiving fulfilment (the dApp's "Take" button does this).
- **Maker liveness.** Fulfilment requires the maker to be online during the 5-min claim window. If they're offline, the claim expires and a fresh claim from anyone can replace it.
- **Abandoned commits.** If no one claims the intent before its expiry, the commit P2TR sits unspent on chain. The maker can reclaim by spending it via the script-path with the envelope as the leaf — the reclaim is exactly a take-by-self with the maker as both maker and taker.

##### Privacy of the listed amount

Atomic intents publish the listed UTXO's amount in cleartext — the taker needs to know what they're buying. The recipient blinding `r` is **not** published; it's encrypted to the claimant at fulfilment time (see above). The maker's *other* UTXOs of the same asset are unaffected — observers learn the amount of the listed UTXO from the cleartext `amount` field, but not its `r`, so the on-chain commitment remains computationally unrecoverable to anyone except the named claimant. Range-disclosed listings (§5.6 + listings layer) cover the symmetric case (no atomicity, but no listed amount either); the two primitives coexist for different use cases.

##### Recovery model exception

Because `r` is random rather than ECDH-derived, an atomic-intent recipient UTXO is **not recoverable from chain + privkey alone** in the sense of §6 paths 2–5. The taker's wallet records the opening locally on take (path 1), so recovery works from local cache as long as the wallet hasn't been wiped. If the wallet is wiped, the taker can re-fetch the encrypted fulfilment from the worker and decrypt — provided it's still within the worker's 24-hour fulfilment TTL. Beyond the TTL, the UTXO becomes a "ghost" entry: the BTC sats are spendable by privkey, but the asset amount is unrecoverable without the maker re-providing the encrypted blinding off-band.

This is the only recovery-model exception in tacit and is unique to the atomic-intent coordination layer; targeted §5.7.3 settlements use ECDH-derived blindings and recover normally via §6 path 2.

**Maker-side recovery.** A maker who reimports their privkey on a fresh device after losing local state recovers the listed asset UTXO via §6 paths normally — its `r` was set at the asset's originating CXFER / CETCH / T_AXFER, not at intent-publish time, so it is unaffected by the loss of the per-intent random `r`. The unspent commit P2TR's BTC sats are reclaimable via script-path spend using the privkey plus the leaf-script and control-block bytes the worker holds in the intent record (or any cached copy of the intent payload). What is irretrievably lost is the per-intent random `r` itself: any in-flight claim becomes un-fulfillable, the claim lock expires, and the maker must publish a fresh intent with a new `r` to relist. No asset value is destroyed — only the listing.

##### Worker endpoints (reference)

```
POST   /assets/:asset_id/atomic-intents
GET    /assets/:asset_id/atomic-intents
DELETE /assets/:asset_id/atomic-intents/:intent_id          (signed cancel)
POST   /assets/:asset_id/atomic-intents/:intent_id/claim    (signed by taker)
POST   /assets/:asset_id/atomic-intents/:intent_id/fulfilment (signed by maker)
GET    /assets/:asset_id/atomic-intents/:intent_id/fulfilment
```

The worker validates ownership at every step (P2WPKH hash160 match for the asset UTXO, BIP-340 sig verification under the appropriate pubkey for each canonical msg) but does not verify the bulletproof inside the partial reveal — clients re-verify at take time, same policy as the standalone disclosure endpoint (§5.6).

This primitive is implementation-defined in v1: the wire format above is the canonical reference for any implementation that wants to interoperate with the reference dApp's marketplace. Indexer-level validity is unaffected — atomic intents live entirely outside the on-chain protocol.

#### 5.7.7 Bid intents (off-chain buyer-side coordination)

§5.7.6 covers the seller-initiated flow: a holder publishes an intent to sell N units at price P, any taker claims. §5.7.7 mirrors that for the **buyer-initiated** direction: a would-be holder publishes an intent to BUY N units at price P, any seller claims by spinning up a §5.7.6 atomic intent **specifically targeted at the bidder's pubkey**, which the bidder then takes through the existing §5.7.3 flow. **Settlement reuses the existing T_AXFER opcode** — no new wire format, no validator change.

**Why bid intents are off-chain in v1.** A naïve "buyer commits sats with a script-path P2TR" design doesn't work in current Bitcoin script: the T_AXFER envelope's kernel signature binds the seller's asset input outpoints, but those outpoints are unknown at bid-publish time, so the buyer can't precompute the envelope and can't commit it into their P2TR's tap-tree. Bitcoin script lacks the introspection covenants (no `OP_CHECKVOUTPUTSPK`, no `OP_CTV`) that would let the buyer's lock be conditionally unlocked by a tx-structure check. v1 bids therefore live entirely in the worker layer, with the trust model of any off-chain order book: the bidder is trusted to follow through on their take. Anti-spam mitigations (sig-required POSTs, per-IP rate limits, bid-expiry caps) sit in the worker.

A future protocol revision with on-chain escrow (true buyer-funded atomic settlement) is feasible via either (a) BIP-119 OP_CTV / BIP-345 OP_VAULT once one ships at consensus, or (b) a two-commit architecture where buyer and seller each pre-broadcast a commit and the reveal spends both — operationally heavier (3 txs per settlement vs §5.7.6's 2) but viable today. v1 keeps the simpler off-chain pattern; v2 can add escrow as a separate primitive.

##### Records

The off-chain bid book stores three records per bid, all worker-managed:

```
bid_intent {
  bid_id            16 bytes / 32 hex chars  (sha256(asset_id || buyer_pubkey || nonce)[:16])
  asset_id          32 bytes
  buyer_pubkey      33 bytes (compressed) — where the bid-converted axintent
                    will deliver. The bidder's tacit recipient pubkey.
  buyer_address     bech32, derived as P2WPKH(buyer_pubkey). Sellers compare
                    hash160 against the eventual claim's vout[0] script.
  amount            u64 base units (cleartext — what the bidder wants to receive)
  price_sats        u64 (cleartext — total sats the bidder agrees to pay)
  expiry            unix-seconds (≤ 30 days from publish — shorter than ask
                    intents because no on-chain lock exists)
  nonce             32 bytes (random, included so a bidder can post multiple
                    independent bids on the same asset)
  intent_sig        BIP-340 over bid_intent_msg, under buyer_pubkey
  created_at        unix-seconds (worker-stamped)
}

bid_claim {
  bid_id, seller_pubkey (33B compressed), seller_utxo_txid, seller_utxo_vout,
  axintent_id       16B — the atomic intent the seller has published in
                    response, targeted at this bid's buyer_pubkey
  sig               BIP-340 over bid_claim_msg under seller_pubkey
  claimed_at        unix-seconds, expires_at = claimed_at + 30 minutes
}
```

There is **no separate `bid_fulfilment` record** — fulfilment is just the bidder taking the axintent the seller published, which uses §5.7.6's existing `axintent_fulfilment` flow.

##### Canonical messages

```
bid_intent_msg = SHA256(
    "tacit-bid-intent-v1"
    || asset_id(32) || bid_id(16) || buyer_pubkey(33)
    || amount_LE(8) || price_LE(8) || expiry_LE(8)
    || nonce(32)
)

bid_claim_msg = SHA256(
    "tacit-bid-claim-v1"
    || asset_id || bid_id || seller_pubkey
    || axintent_id(16)
)

bid_cancel_msg = SHA256("tacit-bid-cancel-v1" || asset_id || bid_id)
```

`bid_id` derives from `(asset_id, buyer_pubkey, nonce)` — same bidder can post multiple independent bids on the same asset, distinguishable by nonce.

##### Lifecycle

```
[publish]   buyer:   sign bid_intent_msg → POST /bid-intents → stored
[browse]    anyone:  GET /assets/:aid/bid-intents → discover open bids
[accept]    seller:  decide to fulfil a bid; build an atomic intent
                     (§5.7.6) targeted at bid.buyer_pubkey from one of their
                     asset UTXOs; broadcast the axintent's commit tx;
                     POST /bid-intents/:bid_id/claim with axintent_id →
                     30-min lock on the bid record
[take]      buyer:   GET the claim; reads the linked axintent_id; treats it
                     as a regular §5.7.6 axintent and goes through the take
                     flow (POST claim, GET fulfilment, append BTC funding
                     SIGHASH_ALL, broadcast)
[settled]   anyone:  on-chain T_AXFER is indistinguishable from a §5.7.3
                     settlement (or §5.7.6) — bid intents converge to the
                     same wire format
```

If the seller doesn't claim within `bid.expiry`, the bid simply expires (no on-chain reclaim needed — there was nothing locked on-chain). The buyer can re-publish at any time.

##### Trust analysis

Bid intents are **off-chain coordination only**. Concrete properties:

- **Buyer doesn't risk sats at bid time.** Nothing is locked. They sign a directive saying "I'd pay this." If they ghost at take time, they lose nothing (and so does anyone else, since the seller hasn't broadcast the axintent yet — only the commit-tx is on chain, and the seller can self-cancel via §5.7.6's reclaim path).
- **Seller risks one commit-tx fee** when they choose to claim a bid. If the bidder ghosts after the seller has published the axintent, the seller can reclaim their asset by self-cancelling the axintent (the existing flow). They lose only the commit-tx cost (~$1–3 mainnet).
- **No buyer→seller trust required for delivery.** The §5.7.6 flow is fully atomic: when the bidder takes the axintent, settlement is guaranteed in one tx.
- **Spam vector.** Bidders can post bid intents with no follow-through cost. Mitigations: (a) BIP-340 sig required on POST, so spammers must control the bidder pubkey they're impersonating; (b) per-IP rate limit on `/bid-intents` POSTs (mirrors the airdrop-claim rate-limit pattern); (c) `expiry ≤ 30 days` cap, so stale bids GC.
- **Liveness.** Both sides must be online during the take window. Same as §5.7.6.

##### Worker endpoints (reference)

```
POST   /assets/:asset_id/bid-intents
GET    /assets/:asset_id/bid-intents
DELETE /assets/:asset_id/bid-intents/:bid_id              (signed cancel)
POST   /assets/:asset_id/bid-intents/:bid_id/claim        (signed by seller, links axintent_id)
GET    /assets/:asset_id/bid-intents/:bid_id              (returns intent + claim if any)
```

The worker validates: BIP-340 sig per canonical msg; bid_id derivation from (asset_id, buyer_pubkey, nonce); reasonable amount/price/expiry bounds.

##### Comparison with §5.7.6

|  | §5.7.6 (ask) | §5.7.7 (bid) |
|---|---|---|
| Initiator | seller | buyer |
| On-chain commit at intent | yes (seller's commit P2TR with envelope) | no — bid is purely off-chain |
| Sats locked at intent | n/a (sats not yet involved) | no |
| Cost to publish | ~1 commit tx fee (~$1-3 mainnet) | zero |
| Cost to ghost | maker forfeits commit tx fee | bidder forfeits nothing (reputation risk) |
| Settlement wire format | T_AXFER opcode 0x26 | T_AXFER opcode 0x26 (via auto-converted axintent) |
| Settlement tx count | 2 (commit + reveal) | 3 (no buyer commit, but seller still posts an axintent commit + reveal — the bid intent itself is off-chain) |
| Recovery semantics | §5.7.6 exception (random `r`) | inherited (the converted axintent uses §5.7.6 recovery) |

Both flows can coexist on the same asset: a buyer can post a bid at the same time another holder posts an ask. Whichever gets matched first settles; the other expires.

This primitive is implementation-defined in v1: the wire format above is the canonical reference for any implementation that wants to interoperate with the reference dApp's marketplace. Indexer-level validity is unaffected — bid intents live entirely outside the on-chain protocol; all settlement is normal `T_AXFER` via §5.7.6.


### 5.8 T_PETCH (`0x27`) — permissionless-mint deployment record

`T_PETCH` declares an asset whose supply is issued by **anyone**, in fixed tranches of `mint_limit`, until a lifetime cap is reached. The deploying tx receives **zero tokens**: a `T_PETCH` envelope creates no tacit UTXO. To hold tokens, the deployer (or anyone else) must broadcast `T_PMINT` like any other participant.

This is a complement to CETCH's mint-authority model, not a replacement. CETCH+T_MINT covers issuer-controlled distribution with hidden supply changes; drops/claims (§8 marketplace layer) cover snapshot-based whitelist distribution; `T_PETCH`+`T_PMINT` covers open-participation fair-launch issuance with publicly auditable supply.

```
T_PETCH(1)
|| ticker_len(1)         u8, 1..16
|| ticker(ticker_len)    UTF-8
|| decimals(1)           u8, 0..8
|| cap_amount(8)         u64 LE base units, > 0 — lifetime mint cap
|| mint_limit(8)         u64 LE base units, > 0 — exact per-T_PMINT amount
|| mint_start_height(4)  u32 LE — 0 ⇒ "etch_height + 1" (next confirmed block)
|| mint_end_height(4)    u32 LE — 0 ⇒ no end height (open until cap)
|| img_len(2)            u16 LE, 0..256
|| image_uri(img_len)    UTF-8 (typically "ipfs://bafk…")
```

Constraints (envelope-level; rejected as malformed if violated):
- `ticker_len ∈ [1, 16]`, `decimals ∈ [0, 8]` — same as CETCH.
- `cap_amount > 0`, `mint_limit > 0`.
- `cap_amount % mint_limit == 0`. The cap MUST be reachable — a non-divisible cap leaves a residual that can never be minted, which produces user confusion and gameable end-of-mint races. Validators reject any T_PETCH with a non-zero remainder.
- If `mint_start_height ≠ 0`, then `mint_start_height ≥ etch_height + 1`. A `T_PETCH` cannot open minting in its own block — this is the structural defense of the "zero deployer allocation" property. `mint_start_height = 0` is the canonical "next block after etch confirms" sentinel, not "active immediately".
- If `mint_end_height ≠ 0`, then `mint_end_height > mint_start_height_effective` where `mint_start_height_effective = mint_start_height ≠ 0 ? mint_start_height : etch_height + 1`.

Properties:
- **No supply UTXO is created.** Vout 0 of the `T_PETCH` reveal tx is treated as regular Bitcoin output by tacit; it carries no asset balance. `validateOutpoint(T_PETCH_reveal_txid, 0)` returns `false`. The deployer typically uses vout 0 for change.
- **No commitment, no rangeproof.** There is no hidden supply at deploy time, so neither primitive is needed.
- **Anyone may broadcast a T_PETCH** for any ticker — same posture as CETCH (§5.5). Ticker collisions across CETCH and T_PETCH are resolved at the wallet/UI layer (display) not the protocol layer (asset_id is canonical).
- `asset_id = SHA256(reveal_txid_BE || 0_LE)` — the same derivation as CETCH (§4), so all downstream tooling resolves T_PETCH-rooted assets identically.

Soundness for T_PETCH. Like CETCH, T_PETCH has no kernel sig and no anchor sig — anyone can broadcast a T_PETCH-shaped envelope. There is no "the asset" to forge because every well-formed T_PETCH defines a *new* `asset_id`. A forger has nothing to gain by re-using bytes since they would only be re-deploying under a fresh identity.

### 5.9 T_PMINT (`0x28`) — permissionless mint event

```
T_PMINT(1)
|| asset_id(32)              must equal SHA256(etch_txid_BE || 0_LE)
|| etch_txid(32)             reference to the originating T_PETCH reveal tx
|| commitment(33)            Pedersen C = amount·H + blinding·G (compressed)
|| amount(8)                 u64 LE — public; MUST equal petch.mint_limit
|| blinding(32)              public scalar — 0 < blinding < curve_order
```

Validator checks:
1. `asset_id == SHA256(etch_txid_BE || 0_LE)`.
2. Fetch the etch ancestor at `etch_txid`. The parent envelope MUST be `T_PETCH` (opcode `0x27`). A T_PMINT that names a `CETCH` (opcode `0x21`) parent — or any other opcode — is rejected. T_MINT and T_PMINT are intentionally non-substitutable: the issuance trust models differ, and the asset's mode is part of its on-chain identity even though both etch opcodes derive `asset_id` the same way.
3. `amount == petch.mint_limit`.
4. Compute `effective_start = petch.mint_start_height ≠ 0 ? petch.mint_start_height : (petch.etch_height + 1)`. Compute `effective_end = petch.mint_end_height ≠ 0 ? petch.mint_end_height : ∞`. Reject if the T_PMINT's confirmed block height is `< effective_start` or `> effective_end`.
5. Let `prior_count` be the count of T_PMINTs against this `asset_id` confirmed at canonically-earlier `(height, tx_index)` positions. Reject if `(prior_count + 1) × petch.mint_limit > petch.cap_amount`.
6. Verify `blinding ∈ (0, curve_order)` and `pedersenCommit(amount, blinding) == commitment`. The commitment field is what subsequent CXFER / BURN walks consume as an input commitment for kernel-sig verification (§5.2 / §5.4).
7. `vout = 0` of the reveal tx holds the new supply UTXO. Spendability of the on-chain output script follows Bitcoin rules, exactly as in T_MINT (§5.3 step 4).

The new supply UTXO can subsequently be CXFER'd, T_AXFER'd, or BURN'd like any other holding.

**Cap-overflow ordering.** When two T_PMINTs are mined in the same block and the cap can fit one but not both, canonical ordering is by `tx_index` within the block: lower `tx_index` wins. The losing T_PMINT is decoded but rejected at step 5. Its commit/reveal pair stays on chain; it produces no spendable tacit UTXO, and the rejected miner forfeits their Bitcoin tx fees. This is the same outcome as any other invalid envelope.

**Why no signature.** T_PMINT carries no Schnorr signature. Anyone may produce the bytes; the blinding is public; the recipient is implicit (whoever controls the reveal tx's `vout[0]` output script). This is intentional — there is no "the minter" to authenticate. The validity gate is the cap counter plus the height window, both enforced from indexer state, not from cryptographic authentication.

Replay analysis. An attacker who copies a published T_PMINT envelope and rewraps its bytes into their own commit/reveal pair must pay full Bitcoin tx fees. Their reveal-tx `vout[0]` commits to the *same* `(amount, blinding)` opening, so the resulting UTXO sits at *their* output script with the *same* opening as the original. This is not a theft of the original miner's UTXO (which lives at the original reveal tx's `vout[0]` permanently), but it does consume one cap slot. Since reproducing a T_PMINT costs the same as honest minting, there is no asymmetric grief vector — the rewrap path *is* the honest path under a different label. The cap eventually fills; that is the design.

Cross-network replay is prevented by Bitcoin's network-level tx isolation: signet and mainnet asset_ids derive from different reveal txids, so byte-identical envelope bytes broadcast on both networks produce different `asset_id`s and never collide.

**Privacy disclosure.** Because every T_PMINT publishes `(amount, blinding)` in cleartext and `amount == mint_limit` is public, **cumulative supply is fully observable** for `T_PETCH`-rooted assets (`cumulative_minted = (count of valid T_PMINTs) × mint_limit`). This is a deliberate departure from CETCH's hidden-supply property — the asset class trades supply-side confidentiality for permissionless issuance and on-chain auditable cap enforcement. Per-holder balances remain confidential after the first CXFER (§3.5 re-blinds outputs). Wallets SHOULD surface this distinction at etch time so deployers and minters understand the trade-off.

**Confirmation depth for cap correctness.** Step 5's `prior_count` is order-sensitive on canonical chain history. Two T_PMINTs that each look valid against the chain near tip may collectively violate the cap when canonically ordered. Indexers MUST therefore compute `prior_count` only over T_PMINTs at confirmation depth ≥ 3 (the standard Bitcoin 3-confirmation rule, where a tx in block N has 1 confirmation when tip == N — the same depth Bitcoin reorg risk crosses below ~1% under reasonable hashrate assumptions). Tip-state T_PMINTs surface as "pending" to UI layers; they are not credited to wallets nor counted toward the cap until the depth threshold is crossed. On a reorg, indexers MUST re-run step 5 over the new canonical chain — a previously-credited T_PMINT may become invalid (cap-overflow under new ordering) and its UTXO MUST be revoked from holdings. This is a stronger reorg sensitivity than CETCH+T_MINT, where credit depends only on the issuer's signature, not on aggregate chain state.

Recovery semantics. T_PMINT-produced UTXOs are publicly opened — `(amount, blinding)` are in chain data — so any wallet with the privkey for the `vout[0]` output script can recover the UTXO from chain alone, with no derivation required. The first CXFER from such a UTXO produces fresh blindings (§3.5) and restores forward confidentiality for that holder. Wallets MAY surface a one-time hint encouraging a self-CXFER after mint, but the protocol does not require it and the UTXO is fully spendable in its open state.


### 5.10 T_DEPOSIT (`0x29`) — anonymize a UTXO into a pool

Spends one tacit UTXO of `asset_id` whose committed amount equals `denomination`. The input commitment is consumed (no tacit-side output produced); a leaf is appended to the pool's Merkle tree (§3.6) for `(asset_id, denomination)`.

```
T_DEPOSIT(1)
|| asset_id(32)
|| denomination(8)              u64 LE — public, the pool's fixed amount
|| leaf_commitment(32)          poseidon(secret, nullifier_preimage, denomination)
|| kernel_sig(64)               Schnorr sig over kernel_msg (below)
```

Constraints enforced at decode:
- `denomination > 0` (the `denomination = 0` payload shape is the `POOL_INIT` variant; see §5.10.1).
- A canonical pool for `(asset_id, denomination)` must already be initialized. Deposits to uninitialized pools are silently ignored by the indexer (return `false`).
- `vin.length ≥ 2`; `vin[1]` is the asset input being deposited.

Kernel message:
```
kernel_msg = SHA256(
    "tacit-deposit-v1"
    || asset_id(32)
    || denomination_LE(8)
    || input_txid_BE(32) || input_vout_LE(4)
    || leaf_commitment(32)
)
```

The kernel sig verifies under `(C_in − denomination · H).x_only()` where `C_in` is the input commitment fetched from `vin[1]`'s parent envelope. Sign with `excess = r_in` (the input's blinding). If the input's committed amount equals `denomination`, the H component vanishes and `(C_in − denomination·H) = r_in·G`; if it doesn't, the residual H component makes producing a valid x-only signature equivalent to breaking DLP for `H` w.r.t. `G` — same Mimblewimble argument as §5.2.

This kernel proves *exactly `denomination` of `asset_id` was consumed into the pool*, without revealing the input's blinding. The leaf is Poseidon-bound to a `(secret, nullifier_preimage)` pair only the depositor knows.

Validator algorithm extension:
```
if envelope.opcode == T_DEPOSIT:
    if denomination == 0:
        # POOL_INIT path — see §5.10.1
        decode pool_denom, vk_cid, ceremony_cid, init_sig
        if no canonical pool exists for (asset_id, pool_denom) at this height:
            register {vk_cid, ceremony_cid, init_height: this_block} as canonical
        return false
    require pool registered for (asset_id, denomination)
    require vin.length >= 2 and vin[1] is a tacit UTXO of asset_id
    recursively validateOutpoint(vin[1])
    let C_in = parent envelope commitment for vin[1]
    let E' = C_in - denomination·H
    verify kernel_sig under E'.x_only() over kernel_msg
    append leaf_commitment to pool's merkle tree at canonical position
    return false   # T_DEPOSIT produces no tacit UTXO
```

**Implementation note.** Indexers MAY split this validator step between (a) a forward-state crawl that performs the kernel re-verify + canonical-position tree append, and (b) a recursive ancestry-walk discriminator that returns `false` to stop ancestors from treating a T_DEPOSIT-bearing reveal-tx output as a tacit UTXO. The reference worker handles the forward-state crawl in its scheduled scan and exposes pool state via `/pools`; the dapp mirrors the worker's pool snapshot in `scanPools` (with kernel + canonical-order re-checks per the three-verifier model) and the dapp's recursive validator merely returns `false` for any T_DEPOSIT it encounters during ancestry walks. Either layout satisfies the algorithm above.

`vout[0]` of the reveal tx is BTC change, not a tacit UTXO. Recovery walks (§6) do not recurse through T_DEPOSIT envelopes.

#### 5.10.1 POOL_INIT (variant of T_DEPOSIT, `denomination = 0` sentinel)

Pool creation reuses opcode `0x29` with a `denomination = 0` sentinel. The remainder of the payload differs:

```
T_DEPOSIT (POOL_INIT shape)
|| asset_id(32)
|| denomination(8) = 0
|| pool_denom(8)              u64 LE — the actual pool denomination, > 0
|| vk_cid_len(1)              u8, 1..64
|| vk_cid(vk_cid_len)         IPFS CID of the Groth16 verifying key (UTF-8)
|| ceremony_cid_len(1)        u8, 1..64
|| ceremony_cid(...)          IPFS CID of MPC ceremony transcripts (UTF-8)
|| init_sig(64)               BIP-340 sig over init_msg by initializer pubkey at vin[1].witness[1]
```

Init message:
```
init_msg = SHA256(
    "tacit-pool-init-v1"
    || asset_id(32)
    || pool_denom_LE(8)
    || vk_cid(vk_cid_len)
    || ceremony_cid(ceremony_cid_len)
)
```

Once a pool is initialized, its `vk_cid` is fixed forever — content-addressed, no rotation, no soft-fork mechanism to migrate. Multiple `POOL_INIT` envelopes for the same `(asset_id, pool_denom)` are tolerated; the indexer treats only the *first canonically-ordered confirmed* one as canonical and ignores the rest. **No special privilege governs pool initialization** — the same first-mover dynamic as ticker disambiguation in CETCH (§4) applies.

**`init_sig` is attestation-of-authorship, not soundness-enforcing.** Because pool init is permissionless and first-canonically-confirmed-wins, an unsigned (or arbitrarily-signed) POOL_INIT can claim the canonical slot exactly as well as a "properly" signed one. Indexers MAY surface the initializer pubkey for off-chain reputation / UI purposes, but MUST NOT make canonicalization or any soundness check contingent on `init_sig` validity. The field is preserved in the wire format to expose initializer identity to off-chain attestation systems and to allow a future soft-rule that gates canonicalization on signature validity should one ever be needed; v1 indexers do not verify it.

Pool initialization is a metadata event only — no tacit UTXO is produced and the validator returns `false` for any vout against a POOL_INIT envelope.

### 5.11 T_WITHDRAW (`0x2A`) — anonymous mint from a pool

Produces one fresh tacit UTXO of `asset_id` at `vout[0]`, contingent on a Groth16 proof of unspent leaf membership in the pool tree. Consumes no tacit input — the asset value comes from the pool's accumulated deposits.

```
T_WITHDRAW(1)
|| asset_id(32)
|| denomination(8)              u64 LE — the pool
|| merkle_root(32)              claimed pool root (must match a recent canonical root)
|| nullifier_hash(32)           public; must be unique within the pool
|| recipient_commitment(33)     compressed Pedersen point: denomination·H + r_leaf·G
|| r_leaf(32)                   public Pedersen blinding scalar (BN254 Fr / secp256k1 scalar)
|| bind_hash(32)                see below
|| proof_len(2)                 u16 LE
|| proof(proof_len)             Groth16 proof bytes
```

`r_leaf` is published in cleartext on chain — identical privacy posture to T_PMINT's `(amount, blinding)` pair (§5.9). Because `denomination` is also public (the pool's fixed amount), publishing `r_leaf` does not leak any additional information about the depositor: the leaf at deposit was `poseidon(secret, ν, denomination)` and `r_leaf = poseidon(secret, ν)` is a one-way function of the same secret pair; an observer cannot invert either to identify which deposit corresponds to a given withdraw.

`bind_hash` is computed as:
```
bind_hash = SHA256(
    "tacit-withdraw-bind-v1"
    || asset_id(32)
    || denomination_LE(8)
    || nullifier_hash(32)
    || recipient_commitment(33)
    || r_leaf(32)
)
```

Public inputs to the Groth16 verifier (in BN254 scalar field, see §3.8):
`[merkle_root, nullifier_hash, denomination, r_leaf, bind_hash]`.

Validator algorithm extension:
```
if envelope.opcode == T_WITHDRAW:
    require pool registered for (asset_id, denomination)
    require merkle_root in last 32 canonical roots of this pool
    require nullifier_hash NOT in this pool's spent-nullifier set
    verify bind_hash matches recompute over (asset_id, denomination,
        nullifier_hash, recipient_commitment, r_leaf)
    verify Groth16 proof under pool.vk over [merkle_root, nullifier_hash,
        denomination, r_leaf, bind_hash]
    # External secp256k1 Pedersen check — closes the inflation-attack vector.
    # The circuit constrains r_leaf to be poseidon(secret, ν), so a malicious
    # withdrawer cannot fabricate a recipient_commitment with a freely-chosen
    # blinding for an inflated amount. SPEC §3.8 constraint 4.
    require recipient_commitment == denomination · H + r_leaf · G
    record nullifier_hash as spent
    require validated vout index == 0   # T_WITHDRAW produces its tacit UTXO at vout[0]; any other vout index is rejected
    return true
```

Recipient blinding & amount recovery: trivial. Both `denomination` (public) and `r_leaf` (public, in envelope) are read directly from chain; the recipient — whose pubkey controls `vout[0]`'s P2WPKH — uses them as the input opening for any future CXFER. **No share-link needed for tornado-flow-to-other**: the recipient simply sees a UTXO paying their address, reads the envelope, and has everything required to spend. Recovery is identical for self-withdraw and for-other; the wallet does not need to track which case applies.

#### 5.11.1 Soundness

- **No pool inflation.** Each T_DEPOSIT consumes exactly `denomination` of asset value (kernel sig under `C_in − denom·H`); each T_WITHDRAW produces exactly `denomination` of asset value and consumes one previously-unseen nullifier. The indexer's nullifier set + leaf count maintain the invariant `(# leaves − # nullifiers) ≥ 0` as a per-pool reserve obligation.
- **No double-withdraw.** Nullifiers are committed in plaintext as a public input to the proof. The indexer maintains a `(asset_id, denomination) → set<nullifier_hash>` and rejects any T_WITHDRAW whose nullifier is already present.
- **No proof replay across recipients.** `bind_hash` is squared inside the circuit, binding the proof's polynomial system to the specific `(asset_id, denomination, nullifier_hash, recipient_commitment, r_leaf)` tuple. A relayer or mempool observer cannot reuse a proof with a substituted recipient; the verifier rejects.
- **No inflation via fabricated recipient_commitment.** The circuit forces `r_leaf == poseidon(secret, nullifier_preimage)` (constraint 4), and the validator forces `recipient_commitment == denomination · H + r_leaf · G` externally. A malicious withdrawer cannot construct a recipient_commitment opening to an amount larger than the pool's denomination — Pedersen binding is computationally infeasible to forge for a fixed `r_leaf` and `denomination`.
- **No proof replay across pools.** `asset_id` and `denomination` are committed in `bind_hash`; cross-pool replay fails the `bind_hash` check.
- **No proof replay across roots.** `merkle_root` is a public input to the Groth16 statement; replaying a proof against a different root would require the prover to have generated a leaf-membership proof against that other root, which is not the case for a copied proof.

#### 5.11.2 Anonymity set

The withdrawer's anonymity set within a pool is **all leaves with currently-unspent nullifiers at the moment the proof is broadcast**, restricted to leaves whose owners have not otherwise leaked their `(secret, nullifier_preimage)` tuple to outside parties. With Groth16 zero-knowledge and Poseidon collision-resistance, a chain analyst observing the on-chain T_WITHDRAW envelope learns no information about which leaf was spent beyond the count of currently-unspent leaves.

Practical anonymity scales with **pool depth** (number of unspent leaves) and **temporal mixing** (time elapsed between deposit and withdraw, during which other deposits and withdraws have occurred). A withdrawer who deposits and then immediately withdraws when their leaf is the only unspent one in the pool gets ≤ 1 anonymity. The dApp surfaces an "anonymity set size" reading on the withdraw screen so users can wait for adequate set size before withdrawing.

#### 5.11.3 Trusted setup

Soundness rests on the Groth16 ceremony for the per-pool `vk` having ≥ 1 honest contributor. Privacy does *not* — Groth16 has perfect zero-knowledge unconditionally. The ceremony is per-pool and per-circuit; pools serving popular `(asset_id, denomination)` pairs SHOULD run a publicly-coordinated ceremony with high contributor diversity (Tornado Cash's reference model: ≥ 1100 contributors over a public window). Smaller pools may run smaller ceremonies, with the understanding that soundness rests on whatever contributor set they assembled. Ceremony transcripts are pinned to IPFS at pool init and committed to in the `POOL_INIT` envelope; any third party can verify contributor count and re-run Beacon-pinning offline before depositing.

**Phase 1 (Powers-of-Tau) provenance is also a soundness prerequisite.** Phase 2 contributions cannot rescue a backdoored Phase 1; if the `ptau` file used at pool initialization was generated by a single party who retained the toxic waste, every withdraw proof is forgeable by that party regardless of how many Phase 2 contributors participated. Pool initializers MUST source their `ptau` from a publicly-attested ceremony with disjoint contributors (e.g., the Perpetual Powers of Tau ceremony) and pin the SHA256 hash in the `POOL_INIT` envelope's `ceremony_cid` payload alongside the Phase 2 transcript. Indexers MAY refuse to recognize pools whose `ptau` is not on a known-good list.

#### 5.11.4 Privacy threat model + operational hygiene

The cryptographic unlinkability of T_WITHDRAW follows from **Groth16's zero-knowledge property + the hiding/binding assumptions of the commitment + hash construction** (§3.6–§3.8); trusted setup affects soundness, not privacy. An observer reading the on-chain `T_WITHDRAW` envelope learns no information about which leaf the withdraw is unspending, beyond the count of currently-unspent leaves in the pool. Operational privacy (the practical "is the withdrawer linkable to the depositor on the Bitcoin chain graph?" question) depends on three things outside the protocol's control:

1. **Anonymity-set size.** Cryptographic unlinkability hides one withdraw within the set of currently-unspent leaves. A pool with 1 unspent leaf provides ≤ 1 anonymity. The dApp surfaces the live anonymity-set count on the withdraw screen and SHOULD warn when it falls below a configurable threshold (default 5 = strong warning, default 50 = caution). Pool operators SHOULD be honest in user-facing copy: the mixer's privacy strength scales with that pool's per-denomination volume; a tacit asset whose mixer sees 40 deposits a year provides nominal privacy, not real privacy.

2. **Bitcoin-level fee linkage.** The `T_WITHDRAW` reveal tx must pay BTC miner fees from a sat UTXO. If the withdrawer broadcasts from a wallet whose fee-source UTXOs trace to the depositor's wallet via chain-graph clustering, the SNARK privacy is operationally wasted. **For pay-to-someone-else withdraws (Alice deposits, Bob withdraws to Bob's wallet), no chain-graph link exists between Alice and Bob.** For self-mix (Alice deposits, Alice withdraws to a fresh receive address), the fee-source link must be broken via either (a) a fresh BTC wallet funded from an unlinked source (CoinJoin output, Lightning channel close, fresh exchange withdrawal), or (b) a relayer marketplace where a third party pays the fee in exchange for compensation taken from the recipient_commitment. The protocol does not require relayers — they are a UX convenience for the self-mix case.

3. **Network and timing correlation.** Broadcasting `T_WITHDRAW` from the same node IP / mempool propagation pattern as the corresponding `T_DEPOSIT` is trivially linkable by mempool monitors and broadcast-time analysis. Privacy-conscious users SHOULD route broadcasts through Tor or equivalent and SHOULD wait long enough between deposit and withdraw that timing-correlation is noisy (recommended minimum: hours, ideally days, for self-mix).

**Soundness invariants (indexer-enforced).** Every conforming indexer MUST enforce all five before crediting a `T_WITHDRAW` output as a spendable UTXO:

| # | Invariant | Enforcement |
|---|---|---|
| 1 | **Conservation** | Each `T_DEPOSIT` consumes exactly one tacit UTXO of `(asset_id, denomination)` (kernel sig over `C_in − denomination·H`). Pool reserve = `(# included leaves − # spent nullifiers) × denomination`, where "included" means a leaf whose depositing tx has reached confirmation depth ≥ `MIXER_DEPOSIT_CONFIRMATION_DEPTH` (§5.10 reorg-safety gate). |
| 2 | **Membership** | The proven leaf must lie in a recently-canonical merkle root (last `POOL_RECENT_ROOTS_WINDOW = 32` roots per §3.6). |
| 3 | **Non-double-spend** | The published `nullifier_hash` MUST NOT appear in the pool's spent-set. Indexers atomically check + insert. |
| 4 | **Output validity** | Recipient commitment is bound by `pedersenCommit(denomination, r_leaf) == recipient_commitment` (validator) AND by `bind_hash` squared into the proof (circuit constraint 5). Together these close the inflation-attack vector and the relayer-replay vector. |
| 5 | **Fee unlinkability (operational, NOT protocol-enforced)** | Pay-to-someone-else: structurally satisfied. Self-mix: requires user discipline (fresh wallet, Tor, timing) OR a relayer. The protocol provides no protocol-level mechanism; the dApp's withdraw confirm dialog surfaces the threat model. |

**Recipient-substitution attack and its closure.** A mempool observer who sees an in-flight `T_WITHDRAW` reveal tx could attempt to lift the proof + public inputs and rebroadcast with a different `recipient_commitment` to steal the withdrawal. The defense is the `bind_hash` covering `recipient_commitment` (along with the other fields), squared into the proof's polynomial system per §3.8 constraint 5. An attacker who substitutes `recipient_commitment`:

- Reusing the original `bind_hash` → the dapp's decoder rejects on `bind_hash` recompute mismatch (§5.11 validator step + indexer-determinism §11).
- Computing a fresh `bind_hash` for the substituted recipient → the SNARK rejects because `bind_hash` is a circuit-public input bound to the proof's polynomial system; the attacker would need to re-prove with their own witness, which they don't have.

The two checks (validator-side `bind_hash` recompute + circuit-side `bind_hash²` constraint) together close the substitution attack.

**Three-verifier model.** The `T_WITHDRAW` proof is verified at three trust boundaries:

| Verifier | Role | Authority |
|---|---|---|
| **Dapp browser (snarkjs)** | Verifies the proof before the user's wallet credits the new UTXO as spendable | **Authoritative for that user's wallet credit.** A failed verify here means the user does not see the UTXO as theirs, regardless of indexer state. |
| **Indexer cron (worker)** | Indexers MAY additionally run snarkjs offline to flag invalid proofs in returned `/pools/:aid/:denom` responses; this Groth16 layer is the optional one. | **Convenience caching.** The reference worker performs structural decode + kernel-sig re-verify (Conservation) + `bind_hash` recompute, but NOT Groth16 proof verification (no snarkjs in the worker runtime). Indexer correctness is bounded by the dapp's authoritative re-verify. |
| **Light clients / third-party indexers** | Anyone running the spec MAY verify proofs locally to maintain trustlessness without trusting our worker | **Required for trustless wallet operation.** Clients that delegate proof-validity to a remote indexer accept that indexer's honesty assumption. |

#### 5.11.5 Withdraw output and post-withdraw privacy

The `T_WITHDRAW` reveal tx produces one tacit UTXO at `vout[0]` with the `recipient_commitment` opening to `(denomination, r_leaf)`. The recipient address (the BTC P2WPKH at `vout[0]`'s scriptpubkey) controls spending the dust output. Because both `denomination` and `r_leaf` are public on chain, **the recipient — or anyone observing the chain — can construct a CXFER consuming this UTXO without any share-link**. This makes the mixer's withdraw output a first-class participant in the standard confidential-transfer protocol.

**Privacy does not end at the withdraw.** Once the recipient consumes the UTXO via CXFER, the resulting outputs are full Pedersen-committed amounts under `tacit-blind-v1` ECDH derivation — amounts are hidden from chain observers as in any other CXFER. The mixer breaks the deposit ↔ withdraw chain-graph edge; CXFER continues to hide amounts on every subsequent transfer. A user who withdraws and then immediately CXFERs to spread the amount across multiple destinations gets cumulative privacy: the mixer hides the source, CXFER hides the amounts.

**Caveat: post-withdraw identity if recipient wallet is publicly linked.** If the withdraw recipient's pubkey is publicly associated with a real-world identity (e.g., reused across known-person addresses), the chain-graph privacy of the *withdraw* is preserved but the *recipient* is identified as "received funds from this pool's mixer." For full anonymity, the recipient pubkey should be a fresh wallet whose history begins with the withdraw.

### 5.12 T_DROP (`0x2B`) — public-claim pool over existing supply

`T_DROP` consumes one or more existing tacit UTXOs of `asset_id` and locks the total committed amount into a **public-claim pool**. Anyone (subject to an optional Merkle-eligibility gate) may subsequently claim `per_claim` tokens from the pool via `T_DCLAIM` (§5.13) until the cumulative claimed amount reaches `cap_amount`, at which point the pool is drained.

This is the existing-supply analog of `T_PETCH` (§5.8). `T_PETCH` creates *new* supply permissionlessly out of nothing under a declared cap; `T_DROP` *redistributes* already-issued supply under the same FCFS-with-cap model. The two complement each other: a CETCH-rooted asset can be airdropped via `T_DROP` without ever migrating to `T_PETCH` semantics, and a `T_PETCH`-rooted asset's mint output can be re-routed through `T_DROP` for downstream redistribution. Asset identity (`asset_id`) is invariant across both.

`T_DROP` is **supply-preserving**, like `T_DEPOSIT` (§5.10): the deposited tokens are not destroyed and re-minted but rather shifted from the depositor's wallet into the pool's accounting, and reconstituted at each claimant's wallet by `T_DCLAIM`. Total `asset_id` supply is invariant across the full lifecycle.

```
T_DROP(1)
|| asset_id(32)              the existing token's asset_id (CETCH, T_PETCH, T_MINT, or T_PMINT root)
|| cap_amount(8)             u64 LE base units, > 0 — total pool supply, MUST equal Σ consumed input amounts
|| per_claim(8)              u64 LE base units, > 0 — exact per-T_DCLAIM amount
|| merkle_root(32)           eligibility gate; all-zeros = open FCFS, otherwise the root of an off-chain
                             (eth_address, per_claim, leaf_index) merkle tree per the §8 airdrop helpers
|| expiry_height(4)          u32 LE — 0 ⇒ no expiry; otherwise highest height at which T_DCLAIM is accepted
|| ticker_len(1)             u8, 0..16 — convenience copy for claim-msg construction; MAY be 0 (deferred to drop's CETCH/T_PETCH ancestor)
|| ticker(ticker_len)        UTF-8 (typically copied from the asset's parent etch envelope)
|| decimals(1)               u8, 0..8 — convenience copy; same role as ticker
|| asset_input_count(1)      u8, 1..16 — number of asset inputs being consumed
|| kernel_sig(64)            Schnorr sig over kernel_msg (below)
```

`drop_id` is derived from the reveal tx the same way `asset_id` derives from CETCH (§4):
```
drop_id = SHA256(reveal_txid_BE || 0_LE)
```

Tx structure:
```
vin[0]     = commit P2TR     ← taproot script-path spend; envelope in witness[1]
vin[1..N]  = asset UTXOs of asset_id summing to cap_amount   ← signed P2WPKH SIGHASH_ALL
            (N = asset_input_count)
vin[N+1..] = (optional) sats funding inputs                  ← signed P2WPKH SIGHASH_ALL
vout[0]    = (no tacit UTXO of asset_id is created — pool marker; safe to spend as a regular Bitcoin output)
vout[1..]  = sats change to depositor (regular P2WPKH)
```

Kernel message:
```
kernel_msg = SHA256(
    "tacit-drop-v1"
    || asset_id(32)
    || cap_amount_LE(8)
    || per_claim_LE(8)
    || merkle_root(32)
    || expiry_height_LE(4)
    || asset_input_count(1)
    || for each asset input i in [1..N]:
         input_txid_BE(32) || input_vout_LE(4)
)
```

The kernel sig verifies under `(Σ C_in − cap_amount · H).x_only()` where `C_in` is each asset input's parent-envelope commitment. Sign with `excess = Σ r_in` (the sum of input blindings — the depositor knows these because they're spending their own UTXOs). If the consumed inputs' committed amounts sum to exactly `cap_amount`, the H component vanishes and the residual `(Σ r_in) · G` is a valid x-only signing key; if they don't, the residual H component makes producing a valid x-only signature equivalent to breaking DLP for `H` w.r.t. `G` — the same Mimblewimble argument as §5.2 and §5.10. No additional blinding field appears in the envelope — `T_DROP` is supply-locking, not supply-creating, so unlike `T_PMINT` it has no output commitment whose opening would need to be published.

Constraints (envelope-level; rejected as malformed if violated):
- `cap_amount > 0`, `per_claim > 0`.
- `cap_amount % per_claim == 0`. The cap MUST be reachable — a non-divisible cap leaves a residual that can never be claimed (same reasoning as `T_PETCH`'s `cap_amount % mint_limit` constraint, §5.8).
- `asset_input_count ∈ [1, 16]`. The cap on the number of inputs bounds tx size and kernel-msg length; a depositor with more than 16 small UTXOs MUST first consolidate via CXFER.
- `merkle_root` is 32 bytes; an all-zero value is the canonical "open FCFS, no eligibility gate" sentinel.
- `expiry_height = 0` means no expiry. Non-zero values MUST satisfy `expiry_height > drop_reveal_height` (a drop cannot expire in its own block — symmetric with §5.8's deferred-start constraint).
- If `ticker_len ≠ 0`, then `ticker_len ∈ [1, 16]` and `decimals ∈ [0, 8]`. If `ticker_len = 0`, the `decimals` byte is still present (set to 0) and the indexer / dapp resolves both fields from the asset's parent etch envelope at claim-msg construction time.

Properties:
- **No tacit UTXO is created.** Vout 0 of the `T_DROP` reveal tx is treated as a regular Bitcoin output by tacit; it carries no asset balance. `validateOutpoint(T_DROP_reveal_txid, 0)` returns `false`. The depositor typically uses vout 0 as the pool-marker dust slot and `vout[1+]` for sats change.
- **No range proof.** `cap_amount` is plaintext, so range-proof bounding is unnecessary; the soundness invariant is `Σ C_in − cap_amount · H == excess · G`, which the kernel sig already enforces.
- **Anyone may broadcast a `T_DROP` against any `asset_id`.** Posting a drop is permissionless at the protocol layer; the soundness gate is "the depositor controlled UTXOs summing to `cap_amount`." A depositor cannot publish a drop they cannot fund.
- **Pool accounting is indexer-state.** Like `T_PETCH`, `T_DROP` is reached during ancestry walks only when a wallet accidentally treats the reveal tx's `vout[0]` as a tacit UTXO; the correct answer there is "not a tacit UTXO." Indexer cron records `T_DROP` metadata via a separate non-recursive scan path (parallel to T_PETCH's metadata path in §5.8).
- **First-canonically-confirmed-wins per `drop_id`.** Two `T_DROP` envelopes computing the same `drop_id` are impossible by construction (`drop_id` derives from the reveal tx). Distinct `drop_id`s for the same `asset_id` coexist freely; a token can be airdropped across multiple concurrent campaigns.

Soundness for T_DROP. Like CETCH and T_PETCH, T_DROP has no anchor sig — the kernel sig binds the asset inputs but not the commit_anchor, so rewrapping the same envelope bytes into a fresh commit/reveal pair is allowed in principle. However, the rewrapped tx would need to spend the same set of asset inputs (the kernel msg commits to each `(input_txid, input_vout)`); since those inputs are spent by the original `T_DROP`, the rewrap cannot confirm. Replay across asset_ids is prevented because `asset_id` is in the kernel msg. Replay against a different cap/per_claim/merkle_root is prevented because each of those fields is in the kernel msg.

**Reorg sensitivity.** If a confirmed `T_DROP` is reorged out, all `T_DCLAIM`s referencing its `drop_id` become invalid — they reference a non-existent parent. The standard Bitcoin 3-confirmation rule (§5.9 *Confirmation depth*) applies symmetrically: indexers SHOULD NOT credit `T_DCLAIM` outputs whose parent `T_DROP` is at depth < 3. Drops in tip-state are surfaced as "pending" to UI layers; claims against them are likewise pending until depth crosses the threshold.

#### 5.12.1 Reclaim path

If `expiry_height ≠ 0` and the current chain height exceeds it, the depositor may reclaim any unclaimed remainder of the pool by broadcasting a follow-up `T_DROP_RECLAIM` envelope.

Reclaim is not a separate opcode — it reuses `T_DROP` (`0x2B`) with `per_claim = 0` as the "reclaim variant" sentinel. The payload diverges:

```
T_DROP (RECLAIM shape, per_claim = 0)
|| asset_id(32)
|| cap_amount(8)             u64 LE — MUST equal the unclaimed remainder
                                       = original_cap - (count_of_valid_T_DCLAIMs * original_per_claim)
|| cap_blinding(32)          opening for the synthetic output commitment recipient_commitment
|| per_claim(8) = 0          sentinel
|| reclaim_drop_id(32)       reference to the original T_DROP being reclaimed
|| reclaim_sig(64)           BIP-340 sig under depositor pubkey over reclaim_msg (below)
```

```
reclaim_msg = SHA256(
    "tacit-drop-reclaim-v1"
    || reclaim_drop_id(32)
    || asset_id(32)
    || cap_amount_LE(8)
)
```

The depositor pubkey is the x-only pubkey at the original `T_DROP`'s `vin[1].witness[1]` (the first asset input's P2WPKH controller). Reclaim produces one fresh tacit UTXO of `asset_id` at `vout[0]` with `pedersenCommit(cap_amount, cap_blinding)` opening to the unclaimed remainder. The pool is closed; subsequent `T_DCLAIM` envelopes against the original `drop_id` are rejected.

Validator algorithm for the reclaim shape:
```
require reclaim_drop_id resolves to a confirmed T_DROP at depth ≥ 3
require current_height > original_drop.expiry_height
require cap_amount == (original_drop.cap_amount
                      - count_of_valid_T_DCLAIMs(reclaim_drop_id) * original_drop.per_claim)
require reclaim_sig verifies under (depositor_pubkey).x_only() over reclaim_msg
verify pedersenCommit(cap_amount, cap_blinding) == output_commitment at vout[0]
mark drop_id as closed
return true   # produces a tacit UTXO at vout[0]
```

The reclaim-variant `T_DROP` is the **only** opcode the protocol allows to mint a fresh asset UTXO without a kernel sig over input commitments — and only because the pool's accumulated reserve is a function of indexer state (the original drop's commit minus the cumulative claims), not of a freshly-consumed input. Soundness here is symmetric with `T_WITHDRAW` (§5.11) where the asset value also comes from accumulated indexer state rather than a directly-consumed input.

**Reclaim broadcast timing (UX gate, not consensus rule).** The depositor MUST wait for the chain to settle past `expiry_height` before broadcasting a reclaim. Specifically: the canonical T_DCLAIM count used in the equality check `cap_amount == original_cap - count_of_valid_T_DCLAIMs × per_claim` is recomputed at **reclaim's depth-3 acceptance**, not at broadcast time. A T_DCLAIM mined at `height = expiry_height` reaches depth 3 at `expiry_height + 2`; if Bob broadcasts a reclaim at `expiry_height + 1` declaring a count that excludes that pending T_DCLAIM, the reclaim is REJECTED when the canonical count overshoots Bob's declaration (no inflation: reject prevents overshoot). Bob can re-broadcast with the corrected count, but he has burned the failed-reclaim's fees. Recommended discipline: wait `current_height ≥ expiry_height + 2 * confirmation_depth = expiry_height + 6` before constructing the reclaim, so the canonical T_DCLAIM count is stable. The protocol enforces no minimum-wait; the rejection-on-mismatch is the safety mechanism, and the UX gate is purely fee-saving.

### 5.13 T_DCLAIM (`0x2C`) — permissionless claim event

```
T_DCLAIM(1)
|| asset_id(32)              must equal drop.asset_id
|| drop_reveal_txid(32)      the on-chain txid of the originating T_DROP reveal tx;
                             validator fetches parent envelope from this txid
                             (same pattern as T_PMINT's `etch_txid`, §5.9)
|| commitment(33)            Pedersen C = amount · H + blinding · G (compressed)
|| amount(8)                 u64 LE — public; MUST equal drop.per_claim
|| blinding(32)              public scalar — 0 < blinding < curve_order
|| witness_len(2)            u16 LE — 0 for open drops, > 0 if drop.merkle_root ≠ 0
|| witness(witness_len)      eligibility witness; see structure below
```

`drop_id` (the indexer's KV key, used for cap accounting and the claimed-leaf nullifier set) is derived as `SHA256(drop_reveal_txid_BE || 0_LE)` — the same construction as `asset_id` from a CETCH `etch_txid` (§4). The wire payload carries `drop_reveal_txid` (not `drop_id`) so the validator can fetch the parent T_DROP tx directly; `drop_id` is a per-indexer derivation.

For Merkle-gated drops (`drop.merkle_root ≠ 0`), the witness is:
```
witness:
|| recipient_pub(33)         compressed pubkey controlling vout[0]; MUST satisfy hash160(recipient_pub) == vout[0].scriptpubkey[2:22]
|| leaf_index(4)             u32 LE — position of the claimant's leaf in the snapshot merkle tree
|| eth_address(20)           the claimant's Ethereum address bound in the snapshot leaf
|| eth_sig(65)               r(32) || s(32) || v(1), EIP-191 signature over canonical_claim_msg
|| proof_len(1)              u8, 0..32 — number of 32-byte sibling hashes
|| proof_path(proof_len * 32) sibling hashes, ordered leaf-up
```

`recipient_pub` is published in the witness rather than recovered from the reveal tx because Bitcoin P2WPKH outputs commit only to `HASH160(pubkey)`, not the pubkey itself — the validator needs the full pubkey to reconstruct the canonical claim msg and verify the eth_sig recovery. The `hash160(recipient_pub) == vout[0].scriptpubkey[2:22]` check binds the witness-supplied pubkey to the actual output script.

For open drops (`drop.merkle_root == 0`), `witness_len` MUST be `0` and any non-zero witness payload is rejected as malformed.

The canonical claim msg the eth_sig MUST sign is **byte-for-byte identical** to the §8 worker-mediated airdrop msg — including the `Drop: merkle_root_hex` line. The on-chain and off-chain flows share the same wire format so a recipient's eth_sig is interchangeable between them; an issuer who has accumulated signed tuples for the worker flow can reuse them directly in T_DCLAIM witnesses.

```
canonical_claim_msg = utf8(
    "tacit airdrop claim v1\n"
  + "\n"
  + "Drop:    " + merkle_root_hex + "\n"
  + "Network: " + ("mainnet" | "signet") + "\n"
  + "Asset:   " + asset_id_hex + "\n"
  + "Address: 0x" + eth_address_hex + "\n"
  + "Leaf:    " + decimal(leaf_index) + "\n"
  + "Amount:  " + display(per_claim, decimals) + " " + ticker
                  + " (" + decimal(per_claim) + ")\n"
  + "Tacit:   " + recipient_pub_compressed_hex + "\n"
  + "\n"
  + "By signing, you authorize the airdrop issuer to send the above amount of "
  + ticker + " to the tacit pubkey listed."
)
```

**Cross-pool sig replay note.** Because `merkle_root` (not `drop_id`) keys the canonical msg, a recipient's eth_sig is valid for *any* `T_DROP` using the same snapshot. This is intentional: if a depositor publishes two `T_DROP`s against the same snapshot (e.g., to top up an exhausted pool), the recipient is entitled to claim from both with one signing operation. Each `T_DROP` has its own `(drop_id, leaf_index)` nullifier set, so the leaf is independently single-use per drop — no double-claim within a single drop, but two drops against the same snapshot is by-design two distinct campaigns.

The merkle leaf is computed exactly as in §8:
```
leaf = SHA256(
    "tacit-airdrop-leaf-v1"
    || eth_address(20)
    || per_claim_LE(8)
    || leaf_index_LE(4)
)
```

Sort-pair sibling hashes (`SHA256("tacit-airdrop-node-v1" || min(L,R) || max(L,R))`) are also identical, so a snapshot built by the existing dapp airdrop tooling is directly usable as a `T_DROP` snapshot with no re-hashing.

Validator checks:
1. `asset_id == drop.asset_id`. Mismatch is rejected.
2. Compute `drop_id = SHA256(drop_reveal_txid_BE || 0_LE)`. Fetch the parent tx at `drop_reveal_txid`; decode its `vin[0].witness[1]` envelope. The envelope MUST be `T_DROP` (opcode `0x2B`) with `per_claim ≠ 0` (the reclaim variant is not a valid `T_DCLAIM` parent). The drop must be at confirmation depth ≥ 3 (§5.12 reorg sensitivity).
3. `amount == drop.per_claim`.
4. If `drop.expiry_height ≠ 0`, the T_DCLAIM's confirmed block height MUST satisfy `confirmed_height ≤ drop.expiry_height`. Claims past expiry are rejected even if cap remains.
5. Let `prior_count` be the count of valid T_DCLAIMs against this `drop_id` confirmed at canonically-earlier `(height, tx_index)` positions and at depth ≥ 3. Reject if `(prior_count + 1) × drop.per_claim > drop.cap_amount`.
6. If `drop.merkle_root ≠ 0` (Merkle-gated):
   - Read `recipient_pub` from the witness. Verify `hash160(recipient_pub) == vout[0].scriptpubkey[2:22]` (i.e., vout[0] is a P2WPKH paying the supplied pubkey). Reject on mismatch.
   - Recompute `canonical_claim_msg` using `drop.merkle_root`, `drop.network`, `asset_id`, witness `eth_address`, witness `leaf_index`, `drop.per_claim`, `drop.ticker`, `drop.decimals`, and `witness.recipient_pub`. If `drop.ticker_len == 0`, resolve `ticker`/`decimals` from the asset's parent etch envelope.
   - Recover `eth_addr_recovered` from `keccak256(EIP-191(canonical_claim_msg))` and witness `eth_sig`. Reject if `eth_addr_recovered ≠ witness.eth_address`.
   - Recompute `leaf` from `(witness.eth_address, drop.per_claim, witness.leaf_index)`. Verify the merkle proof against `drop.merkle_root` using sort-pair sibling hashes.
   - Reject if `(drop_id, witness.leaf_index)` is already in the claimed-leaf set.
   - Record `(drop_id, witness.leaf_index)` as claimed.
7. If `drop.merkle_root == 0` (open FCFS): no witness checks beyond `witness_len == 0`. Anti-sybil is by Bitcoin tx fees — each claim costs the claimant a real fee.
8. Verify `0 < blinding < curve_order` and `pedersenCommit(amount, blinding) == commitment`.
9. `vout = 0` of the reveal tx holds the new supply UTXO at `P2WPKH(hash160(recipient_pub))`.

The new supply UTXO can subsequently be CXFER'd, T_AXFER'd, BURN'd, or DEPOSIT'd like any other holding.

**Cap-overflow ordering.** Two T_DCLAIMs mined in the same block whose claims would collectively exceed the cap are ordered by `tx_index`: lower wins (identical to §5.9 *Cap-overflow ordering*). The losing claim's commit/reveal pair stays on chain and produces no spendable tacit UTXO. The claimant forfeits their Bitcoin tx fees and (if Merkle-gated) the `(drop_id, leaf_index)` is NOT recorded as claimed — they may re-attempt in a later block.

**Why no Schnorr sig on the envelope itself.** `T_DCLAIM` carries no protocol-layer Schnorr signature, mirroring `T_PMINT` (§5.9). The validity gate is (a) for Merkle-gated drops, the eth_sig recovering the snapshot's eth_address from the canonical claim msg, and (b) for open drops, simply the cap counter. The recipient is implicit (whoever controls `vout[0]`'s output script) — claimants signal their tacit identity by funding the reveal tx from a wallet they control.

Replay analysis. An attacker who copies a published `T_DCLAIM` envelope and rewraps its bytes into their own commit/reveal pair:

- **Open drop case.** The rewrapped tx produces a fresh `vout[0]` UTXO at *their* output script with the same `(amount, blinding)` opening. This is not theft (the original claimant's UTXO at the original reveal tx's `vout[0]` is permanent), but it does consume one cap slot. Since reproducing a `T_DCLAIM` costs the same as honest claiming, there is no asymmetric grief vector — the rewrap path *is* the honest path under a different label. Identical posture to `T_PMINT` (§5.9).
- **Merkle-gated drop case.** The witness's `canonical_claim_msg` binds `recipient_pubkey_compressed_hex`. An attacker who rewraps a published `T_DCLAIM` MUST also substitute the recipient pubkey at `vout[0]` (otherwise they're just paying fees to deposit dust to the original claimant). But substituting the recipient changes the canonical msg, which changes the EIP-191 hash, which changes what `eth_sig` recovers to. The rewrap fails step 6 (eth_addr_recovered ≠ witness.eth_address). The merkle gate is therefore robust to envelope-byte replay — a recipient's signed claim is bound to their tacit pubkey by the same mechanism that closes the relayer-substitution attack in `T_WITHDRAW` (§5.11.4).

Cross-network replay is prevented by Bitcoin's network-level tx isolation (signet and mainnet `drop_id`s derive from different reveal txids) and additionally by the `Network:` field in the canonical claim msg.

**Privacy disclosure.** Like `T_PMINT`, `T_DCLAIM` publishes `(amount, blinding)` in cleartext and `amount == drop.per_claim` is public. Cumulative claims are fully observable on chain (`cumulative_claimed = (count of valid T_DCLAIMs against drop_id) × per_claim`). For Merkle-gated drops, the witness additionally publishes `(eth_address, leaf_index)` per claim — the snapshot's eligibility list is already public information (anchored in the IPFS-pinned snapshot blob), so this leaks no new identity but does timestamp which leaves have been claimed when. Per-holder balances regain confidentiality on the first CXFER (§3.5 re-blinds outputs).

Wallets SHOULD surface this distinction at drop-creation time so depositors understand the trade-off vs. the §8 worker-mediated airdrop (which preserves per-claim privacy until fulfilment broadcast, modulo the IPFS-pinned snapshot which is identical in both flows).

**Smart-contract wallet limitation.** On-chain `T_DCLAIM` only supports recipients whose snapshot `eth_address` is controlled by an ECDSA private key (EOA wallets — MetaMask, Rainbow, Rabby, Coinbase Wallet, Trust, Frame). Smart-contract wallets (Safe, Argent, Ambire) that authenticate via ERC-1271's `isValidSignature(bytes32, bytes)` cannot have their sigs verified by a Bitcoin-context validator — ERC-1271 verification requires an `eth_call` to the contract, which is not available in the validator's execution environment. Smart-wallet recipients MUST use the §8 worker-mediated airdrop flow (which retains the ERC-1271 fallback path) for any drop whose snapshot includes their address. Issuers SHOULD either filter smart-contract wallets out of merkle-gated `T_DROP` snapshots, or publish dual coverage (a `T_DROP` for EOA recipients + a worker-mediated airdrop offering the same merkle root for smart-wallet recipients).

#### 5.13.1 Soundness

| # | Invariant | Enforcement |
|---|---|---|
| 1 | **Conservation** | The drop pool's reserve = `cap_amount - cumulative_claimed`. `T_DROP` kernel sig binds inputs summing to `cap_amount`. Each `T_DCLAIM` decrements the reserve by exactly `per_claim`. `T_DROP_RECLAIM` (5.12.1) consumes the remainder. The cumulative invariant `(claims × per_claim) + (reclaim_amount) ≤ cap_amount` holds across the pool's lifecycle. |
| 2 | **Cap enforcement** | Step 5 of the T_DCLAIM validator: `(prior_count + 1) × per_claim ≤ cap_amount`. Indexers compute `prior_count` only over T_DCLAIMs at depth ≥ 3. |
| 3 | **No double-claim (Merkle-gated)** | The `(drop_id, leaf_index)` tuple acts as the nullifier — analogous to `nullifier_hash` in `T_WITHDRAW`. The indexer maintains a per-`drop_id` claimed-leaf set; step 6 rejects reuse. |
| 4 | **No relayer substitution (Merkle-gated)** | `recipient_pub` is bound into the canonical claim msg; substituting recipient invalidates the eth_sig recovery (replay analysis above). |
| 5 | **Output validity** | Pedersen binding: `pedersenCommit(amount, blinding) == commitment`. `amount` and `blinding` are both public; the commitment field is what subsequent CXFER / BURN walks consume as an input commitment for kernel-sig verification (§5.2 / §5.4). |
| 6 | **Reorg safety** | All cap-counter / claimed-leaf-set updates run at depth ≥ 3. On a reorg, indexers MUST re-run steps 2 and 5 over the new canonical chain. A previously-credited `T_DCLAIM` may become invalid under new ordering and its UTXO MUST be revoked from holdings. Stronger reorg sensitivity than CETCH+T_MINT, matching `T_PMINT`'s posture. |

#### 5.13.2 Comparison: T_DCLAIM vs. §8 worker-mediated airdrop

Both flows use the same merkle-leaf schema (`tacit-airdrop-leaf-v1`), the same node-hash schema (`tacit-airdrop-node-v1`), and the same canonical claim msg (modulo `drop_id` vs. `merkle_root` in the `Drop:` line). A snapshot built by the existing dapp Drops-tab tooling is directly usable in either flow.

|  | §8 worker-mediated airdrop | §5.12/§5.13 T_DROP/T_DCLAIM |
|---|---|---|
| **Issuer cost (N=1000 mainnet)** | ~$1–1.4K (143 batched CXFERs × 7 recipients each) | ~$10 (one T_DROP tx) |
| **Recipient cost** | $0 (issuer pays) | ~$5–10/claim (claimant pays own reveal) |
| **Self-service** | No — recipients submit claims to the worker queue and wait for the issuer to fulfil | Yes — claimants self-broadcast `T_DCLAIM` without issuer involvement |
| **Eligibility gate** | Off-chain (issuer verifies merkle + eth_sig before broadcasting CXFER) | On-chain (indexer verifies merkle + eth_sig as part of `T_DCLAIM` validation) |
| **Privacy of claim list** | Tuples sit in worker queue until fulfilled; chain only reveals the final batched CXFER amounts under Pedersen | Each `T_DCLAIM` publishes `(eth_address, leaf_index)` and `(per_claim, blinding)` in plaintext, identical to T_PMINT's posture |
| **Trust model** | Worker is dumb-storage; canonical truth is the issuer's batched CXFERs | Pure protocol; no worker trust needed for claim validity |
| **When to choose** | Small-to-medium drops where issuer wants to control timing, keep per-claim amounts private until fulfilment, or batch into fewer txs | Large public drops, fair-launch-style distributions of existing supply, or any scenario where issuer being online for N fulfilments is impractical |

The two flows coexist: an issuer may publish both an §8 announcement and a `T_DROP` against the same snapshot, letting recipients pick which path they prefer. The snapshot, merkle root, and eth_sig wire formats are identical across both, so there is no per-flow re-tooling.

## 6. Recovery semantics

A wallet with only its **private key** can recover its full balance from chain data alone for every UTXO produced by the **on-chain protocol layer** (CETCH / CXFER / T_MINT / T_BURN / T_PMINT / T_DCLAIM, including targeted §5.7.3 T_AXFER settlements and reclaim-shape T_DROP outputs). Atomic-intent recipient UTXOs are the one exception — see §5.7.6 "Recovery model exception" — because their recipient blinding is a uniform-random scalar fixed at intent-publish time rather than ECDH-derived; recovery from chain + privkey alone is impossible by design, and recovery falls back to local opening cache or re-fetching the encrypted fulfilment from the worker. T_PMINT and T_DCLAIM recovery are the *easiest* of all paths because `(amount, blinding)` are published in the envelope rather than derived — no HMAC keystream, no ECDH (§5.9 *Recovery semantics*, §5.13 *Privacy disclosure*).

For each UTXO the wallet owns:

1. **Local opening cache** (`localStorage`): `(amount, blinding)` if the wallet has previously seen this UTXO. **Required** for atomic-intent recipient UTXOs (or re-fetching from the worker's encrypted fulfilment record while it's within the 24h TTL).
2. **As recipient (CXFER, targeted T_AXFER §5.7.3)**: ECDH against sender's pubkey at `tx.vin[1].witness[1]`. Try `tacit-blind-v1` blinding + `tacit-amount-v1` keystream. Verify `pedersenCommit(decrypted_amount, blinding) == on_chain_commitment`.
3. **As own change (CXFER / BURN)**: Try `tacit-change-v1` blinding + `tacit-amount-self-v1` keystream against the change vout.
4. **As own etched supply (CETCH)**: Try `tacit-etch-v1` + `tacit-etch-amount-v1` against the etcher's commit-input anchor.
5. **As own minted supply (T_MINT)**: Try `tacit-mint-blind-v1` + `tacit-mint-amount-v1` against the mint commit-input anchor.
6. **As T_PMINT-minted supply (own or other)**: Read `(amount, blinding)` directly from the T_PMINT envelope. No derivation required — both fields are public. The wallet recognizes ownership by matching its pubkey's HASH160 against `vout[0].scriptpubkey`. Confirm `pedersenCommit(amount, blinding) == commitment` to reject tampered envelopes (the same authenticity check as paths 2–5).
7. **As mixer-pool withdrawal (T_WITHDRAW)**: Read `denomination` and `r_leaf` directly from the envelope (both are public — same recovery pattern as T_PMINT). Verify `pedersenCommit(denomination, r_leaf) == on_chain_commitment` to reject tampered envelopes. Recovery works identically whether the withdrawer === recipient or not — the public `r_leaf` makes share-links unnecessary.
8. **As T_DCLAIM-claimed supply**: Read `(amount, blinding)` directly from the envelope (both public — identical recovery pattern to T_PMINT, §5.13). The wallet recognizes ownership by matching its pubkey's HASH160 against `vout[0].scriptpubkey`. Verify `pedersenCommit(amount, blinding) == commitment` to reject tampered envelopes. For Merkle-gated drops the witness's `(eth_address, leaf_index)` is also on chain, but those fields are not required for amount-side recovery — only for re-verifying eligibility post-hoc.
9. **As T_DROP reclaim output**: Read `(cap_amount, cap_blinding)` from the reclaim-shape envelope payload (§5.12.1). Same opening primitive as paths 6–8.

If none of the paths produce a valid `(amount, blinding)` opening, the UTXO is recorded as a **"ghost"** — the wallet sees that it owns the BTC sat output but cannot decrypt the asset amount. This indicates either a legacy/incompatible sender, a misuse, or an atomic-intent recipient whose local cache and remote encrypted fulfilment are both unavailable; it does not represent loss of value (the BTC sats are still spendable by the wallet privkey).

**`amount_ct` is a raw XOR keystream — authenticity is load-bearing on the commitment check.** Decryption produces a candidate amount; the wallet MUST verify `pedersenCommit(candidate, blinding) == on_chain_commitment` before accepting it. The Pedersen binding property is what rejects tampered ciphertexts: if anyone flips a bit in `amount_ct`, the decrypted candidate differs from the originally-committed value and the equality fails. Recovery paths 2–5 above all perform this check; skipping it would let an attacker forge spurious ghost-UTXO openings.

## 7. Security properties

### 7.1 Privacy

- **Amount confidentiality** of every commitment. Perfect Pedersen hiding + bulletproof zero-knowledge. Observers see range bounds and structure but not the value.
- **Pedersen perfect-hiding is the load-bearing privacy primitive; the keystream is a recovery channel, not a privacy mechanism.** The on-chain Pedersen commitment `C = a·H + r·G` reveals nothing about `a` to any observer who lacks `r`, regardless of whether `amount_ct` is also published. Even total exposure of every wallet's keystream-derivation key — or stripping `amount_ct` from the wire entirely — would not break amount confidentiality at the commitment layer; it would only force recipients to learn `a` out-of-band (sender→recipient share-link, etc.) rather than reconstruct it from chain. `amount_ct` exists so the recipient (and only the recipient) can decode `a` from chain alone, fulfilling §6's privkey-only recovery property.
- **Keystream uniqueness across transactions** (NOT forward secrecy): the keystream that XOR-encrypts each `amount_ct` is bound to a per-tx anchor (`vin[0]` outpoint) and per-output `vout` index. The same (sender, recipient, amount) tuple produces a different ciphertext every transaction because the anchor is unique. This prevents the OTP key-reuse attack (where two ciphertexts under the same keystream leak their XOR difference) but does **not** provide forward secrecy in the cryptographic sense — the keystream derives from `HMAC(SHA256(ECDH(maker_priv, taker_pub)), …)` (or `HMAC(wallet_priv, …)` for self-derived amounts), all of which are static long-term keys. **If either party's tacit privkey is compromised, every past `amount_ct` for transactions involving that key becomes decryptable from chain alone.** Real forward secrecy would require ephemeral key exchange per transaction, which the in-page key-custody model (a single static privkey reused for every op) does not support. The fall-back to Pedersen perfect-hiding (above) is what keeps amount confidentiality intact even under that compromise: a privkey leak makes amounts recoverable to the holder of the leaked key, not to anyone else.
- **No off-chain metadata leak on the send path.** A vanilla CXFER (and a targeted §5.7.3 T_AXFER) produces a Bitcoin tx broadcast and nothing else — no worker call, no IPFS pin, no third-party service is contacted as part of the transfer. Setting `WORKER_BASE = ''` in `dapp/tacit.js` disables every off-chain endpoint and the protocol still works for transfers, validation, and recovery (§8). Discovery and marketplace features (etch/mint attestation caches, per-UTXO openings, range disclosures, OTC listings, atomic intents) are explicit user-initiated publishes; an observer of the worker sees nothing about a send unless the user separately opted to publish for that asset.

What is **not** hidden:
- **Address graph.** Bitcoin-level addresses are visible.
- **Asset_id.** Visible in CXFER / T_MINT / T_BURN payloads.
- **Sender pubkey.** P2WPKH input signatures expose sender's pubkey at `vin[1].witness[1]` (recipient needs it for ECDH). Same exposure as any P2WPKH-funded transfer.
- **Public burn amounts.** T_BURN's `burned_amount` is in cleartext.
- **Output-count bucket, not exact recipient count.** §5.2 fixes `N ∈ {1,2,4,8}` at the wire level (and §5.4 additionally permits `N = 0` for burn-everything). A CXFER carrying K recipients + 1 change output picks the smallest bucket fitting K+1 and pads the remainder with zero-amount filler outputs, each using a fresh `tacit-change-v1` blinding + `tacit-amount-self-v1` keystream — same derivation paths as a real change output. Padding commitments are `0·H + r·G = r·G`, computationally indistinguishable from a real change commitment without the wallet privkey; the holder's recovery scan decrypts them to `0` and silently skips. Observers learn "N is in {1,2,4,8}" rather than "K = 3 recipients." K=1 and K∈{3,7} pay no padding cost (they exactly fill a bucket); K∈{2,4,5,6} carry 1–3 decoys. The reference dApp always bucket-pads on every CXFER it emits; a re-implementation is free to do the same or to ship a tight non-padded N at the cost of leaking the exact recipient count.

### 7.2 Soundness

- **No inflation downstream of etch.** Kernel sig + range proof ensure `Σ_out ≤ Σ_in + burnt − burnt = Σ_in` (or `Σ_in − burned` for BURN).
- **No negative-amount smuggling.** Range proof bounds every amount to `[0, 2⁶⁴)`, including change. A "negative" amount would be `N − k` modulo the scalar field; this is *not* in the 64-bit range and the proof rejects.
- **Mint authorization (CETCH+T_MINT).** T_MINT requires Schnorr sig under `mint_authority` from the CETCH ancestor. Non-mintable assets (`mint_authority = 0`) reject all T_MINT envelopes.
- **Permissionless mint cap (T_PETCH+T_PMINT).** T_PMINT carries no signature; the cap is enforced by the indexer summing canonically-ordered T_PMINT events at confirmation depth ≥ 3 (§5.9). Cumulative supply is publicly observable for these assets — the trade is supply-side confidentiality for permissionless issuance with on-chain auditable cap. Reorgs at depth < 3 may revoke a previously-credited T_PMINT under new canonical ordering; indexers MUST re-run the cap check on reorg and surface revocations to wallets. T_PMINT envelope replay is allowed but cost-symmetric with honest minting (the rewrapper pays full Bitcoin fees and consumes one cap slot for an extra UTXO at their own output script — no theft from the original miner).
- **Replay protection.** Kernel msg binds (asset_id, input outpoints, output commitments, burned_amount). Mint msg binds (asset_id, commit_anchor, commitment, amount_ct) — the anchor prevents envelope re-wrap into a different commit/reveal pair (§5.3). T_PMINT has no signature and no anchor: rewrap is allowed, and the cost-symmetric replay analysis above is what makes it harmless. No cross-tx or cross-asset replay across any opcode.
- **Batch range-proof soundness.** The 2⁻²⁵⁵ bound on batch-verify failure assumes the batching scalars α and β are independent uniform samples drawn *after* the prover commits to the proof. Both conditions hold: each call to `randomScalar()` reads `crypto.getRandomValues`, and the draws happen inside the verify loop (post proof-fixing), so a malicious prover cannot have engineered Eq1 = −Eq2 in advance.

#### Implementation hygiene

The bulletproof prover/verifier is hand-rolled in JavaScript (see `dapp/tacit.js` and `tests/bulletproofs.mjs`). Concrete defensive measures in the implementation:

- CSPRNG (`crypto.getRandomValues`) for every scalar sample
- Length-prefixed Fiat-Shamir transcript with explicit nonzero-challenge checks
- NUMS generator vectors with published test vectors enforced at boot (`runStartupKAT`)
- Differential parity tests between dapp / worker / composition mirror covering message-byte equality and ECDH symmetry
- Ancestry-validating indexer with batch-verify that fails closed on any sub-proof rejection

### 7.3 Issuer trust

The protocol does not enforce **honesty about the announced initial supply** at the cryptographic layer. Pedersen hides the supply; without the issuer's `(supply, blinding)` opening, no third party can verify the announcement.

The reference dApp resolves this by **publishing the opening by default**, via two redundant channels:

1. **IPFS metadata (primary, worker-independent).** When attestation is enabled, the dApp pins a metadata JSON containing `tacit_attest = { supply, blinding, commitment }` to IPFS, and uses that blob's CID as the on-chain envelope's `image_uri`. Verifiers fetch the blob via the gateway, decode `tacit_attest`, and check `pedersenCommit(supply, blinding) == on_chain_commitment`. **No worker is involved** in this path — the metadata is content-addressed, anyone can re-pin it, and the binding property of Pedersen makes a forged attestation infeasible (would require finding a different opening of the same commitment).
2. **Worker `/attest` cache (secondary, discovery convenience).** The dApp also POSTs the same opening to the worker's `/assets/:asset_id/attest` endpoint as a discovery-time cache so Discover renders ✓ immediately without an extra IPFS round-trip. The worker can suppress this cache (returning no attestation) but cannot forge one — the verifier re-runs the Pedersen check client-side either way.

T_MINT events use the same model via `/assets/:asset_id/mints/:mint_txid/attest`. The reference dApp auto-attests every mint by default (per-asset opt-out via `localStorage`).

**Defaults:** the etch UI's "Publish supply opening" checkbox is on by default and labeled (recommended). For any asset etched through the dApp without opting out, supply is **provably public from chain + IPFS alone**. Issuers explicitly opt out only when they want the centralized-stablecoin trust model (USDC/USDT-style: "trust me about the supply"), which the dApp surfaces as a deliberate choice.

For non-mintable assets attested at etch, the result is **provably and permanently public supply** — no more issuance can ever occur, and the one attestation is the complete supply forever.

For mintable assets, additional trust is on the mint_authority key not being abused (the holder can mint arbitrary amounts at any time). Auto-attestation of every mint event by default closes the "K mints, N unattested" supply-bound gap; with all mints attested, total supply at any moment = etch + Σ attested mints − Σ on-chain burns.

### 7.4 Mixer pool (§5.10–5.11)

**Privacy.** The withdrawer's anonymity set within a pool is the count of currently-unspent leaves at the moment the proof is broadcast. Groth16 zero-knowledge ensures a chain analyst learns no information beyond pool size from a withdrawal. **Anonymity does not require trusted setup** — Groth16 zero-knowledge is unconditional. Trusted setup is only load-bearing for *soundness* (no false withdrawals).

**Soundness.** Per §5.11.1: no pool inflation (kernel sig + denomination check on deposits), no double-withdraw (nullifier set), no recipient substitution (`bind_hash` squaring), no cross-pool/cross-root replay (`asset_id` + `denomination` + `merkle_root` committed in proof public inputs).

**Trusted-setup posture.** Each pool runs its own per-circuit Groth16 MPC ceremony at init time. Soundness rests on ≥ 1 honest contributor *for that specific pool*; pools with weaker ceremony don't undermine other pools. Pool initialization is permissionless (§5.10.1) — anyone can run a ceremony and post `POOL_INIT`. Pool consumers should verify ceremony contributor diversity before depositing; the IPFS-pinned ceremony transcripts in the on-chain envelope make this directly auditable.

**What's not hidden.**
- **Pool participation.** T_DEPOSIT and T_WITHDRAW envelopes are public — observers see *that* a particular address deposited or withdrew, just not which deposit corresponds to which withdrawal.
- **Pool size and denomination.** Public on chain; the same fact that grants anonymity sets is visible to observers.
- **Address-graph privacy.** Same as the rest of tacit (§7.1): Bitcoin sender/recipient addresses are visible. Mixer pools break the *amount-to-address-to-amount* link inside a pool but not the input or output address itself.

## 8. Worker (off-chain conveniences)

The worker (`worker/src/index.js`) is **not part of the trust-bearing protocol**. Setting `WORKER_BASE = ''` in `dapp/tacit.js` disables it entirely; the protocol still works for full validation and transfers.

Worker endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /pin` | Image upload to IPFS via Pinata |
| `POST /pin-json` | Metadata-blob pin |
| `POST /drip` | Signet faucet drip |
| `GET /balance` | Faucet wallet balance |
| `GET /assets` | List of indexed asset metadata + scan freshness |
| `GET /assets/:asset_id` | Single asset metadata |
| `POST /assets/:asset_id/attest` | Discovery cache for the etch attestation. Worker re-verifies `C == supply·H + r·G` before storing. The primary attestation channel is the IPFS metadata blob at the envelope's `image_uri` — see §7.3; this endpoint is a cache for fast Discover-first paint. |
| `POST /assets/:asset_id/mints/:mint_txid/attest` | Same shape, for T_MINT events. The reference dApp auto-attests by default (issuer opt-out per asset). |
| `GET /assets/:asset_id` (and list) — `burns[]` field | Public burn history: each entry has cleartext `burned_amount` + tx + height. No attestation needed because burns are public on-chain. |
| `POST /assets/:asset_id/disclosures` | Holder publishes a `balance ≥ K` range disclosure (§5.6); worker verifies the Schnorr sig + on-chain ownership + asset-id consistency before storing. The bulletproof itself is **not** verified by the worker (~600 LOC of verifier code per submission); consumers MUST re-verify it client-side per §5.6, requirement (4). |
| `GET /assets/:asset_id/disclosures` | List published range disclosures for an asset; consumers MUST re-verify (chain ownership and unspent-ness can change after publication). |
| `GET /assets/:asset_id/openings` | List per-UTXO `(amount, blinding)` openings the issuer/holder has voluntarily published for an asset (cache-only, optional). |
| `POST /utxos/:txid/:vout/opening` | Holder publishes a per-UTXO `(amount, blinding)` opening. Worker re-verifies the BIP-340 sig under `owner_pubkey` and `pedersenCommit(amount, blinding) == on_chain_commitment` before storing. |
| `GET /utxos/:txid/:vout/opening` | Single-UTXO opening lookup (cache-only). |
| `GET /assets/:asset_id/listings`, `POST /assets/:asset_id/listings/:txid/:vout/claim`, `DELETE /assets/:asset_id/listings/:txid/:vout` | OTC marketplace endpoints. **Settlement is OTC, not protocol-enforced** — the worker stores listing intent + an opening proof; actual delivery is bilateral. The marketplace surface lives entirely outside the on-chain protocol; an indexer that only cares about token validity can ignore it. |
| `POST /assets/:asset_id/listings-range`, `GET /assets/:asset_id/listings-range`, `POST /assets/:asset_id/listings-range/:owner_pubkey/claim`, `DELETE /assets/:asset_id/listings-range/:owner_pubkey` | Range-disclosure variant of the above (lists backed by a `balance ≥ K` proof rather than a single UTXO opening). `POST /…/claim` is a 5-minute taker reservation, symmetric to the per-UTXO `listings/:txid/:vout/claim` row. Same OTC caveat applies. |
| `POST /airdrops/:root/claims`, `GET /airdrops/:root/claims`, `DELETE /airdrops/:root/claims/:leaf_index` | Airdrop claim dropbox keyed by the issuer's merkle root. Recipients submit `(leaf_index, tacit_pubkey, eth_sig)` tuples; issuers pull batches and re-verify the merkle proof + ETH sig client-side against the off-chain snapshot before broadcasting CXFERs. Worker validates format only — it has no snapshot to check against. Lives entirely outside the on-chain protocol; canonical truth is the resulting CXFER set. |
| `POST /assets/hint` | `{ reveal_txid, reveal_vout? }` — targeted index of a freshly broadcast etch / mint / burn so it appears in `/assets` immediately without waiting for the next 5-min cron tick. Works pre-confirmation. |
| `GET /petch-assets` | Permissionless-mint asset registry (T_PETCH-rooted). Same envelope/payload shape as `/assets` plus per-asset `cap_amount`, `mint_limit`, `mint_start_height`, `mint_end_height`, `cumulative_minted` (depth ≥ 3), and a `mints_remaining` convenience field. T_PETCH-rooted assets are excluded from `/assets` so the two registries can be filtered cleanly in UI; consumers wanting "every asset" union both. |
| `GET /assets/:asset_id/pmints` | Confirmed T_PMINT events for a T_PETCH-rooted asset, in canonical (height, tx_index) order. Each entry: `{ txid, height, tx_index, recipient_script, depth, status: 'credited' \| 'pending' \| 'revoked' }`. Status is recomputed every cron tick against current depth and reorg state. Wallets MUST treat `pending` as non-spendable. |
| `POST /scan` | Manual cron trigger (debug) |
| `POST /rescan?from=<height>` | Rewind `meta:last_scanned` (debug) |

Cron (`*/5 * * * *`) scans recent signet AND mainnet blocks for CETCH, T_MINT, T_BURN, T_PETCH, and T_PMINT envelopes and indexes them. Worker decodes envelopes only structurally — the rangeproof and signature verification stay client-side. The cap counter for T_PETCH-rooted assets is maintained per-asset and re-derived from canonical chain order on every reorg-affected block. The `/assets/hint` endpoint exists so a freshly broadcast envelope appears in the registry without waiting for the next cron tick.

**Protocol validity vs. operational dependency.** "Not part of the trust-bearing protocol" means the worker cannot make an invalid envelope appear valid: every consumer is expected to re-verify rangeproofs, kernel sigs, mint sigs, and Pedersen openings client-side. It does **not** mean a malicious or faulty worker is harmless to user experience: such a worker could omit assets from `/assets`, return stale `last_scanned` heights, withhold or mis-serve `/openings` data needed for cold recovery, fail to index a freshly hinted reveal, lie about burn history, or refuse `/disclosures`. None of that produces unsound balances, but it can degrade discovery, slow recovery, and cause UI to lag chain reality. Any deployment that wants to harden against this should run its own indexer (the cron in `worker/src/index.js` is a few hundred lines and pluggable behind any mempool.space-compatible REST endpoint), or run client-side validation eagerly enough that worker output is treated as a hint rather than as canonical metadata. Likewise, the dApp's reliance on `mempool.space` REST APIs for raw-tx fetching is a UX dependency, not a trust dependency: a Bitcoin Core or Electrum backend would serve identically once the JSON shape is matched.

## 9. Out of scope (v1)

- **Multisig mint authority.** Requires FROST or MuSig2 plumbing on top of single-key Schnorr. The on-chain `mint_authority` field can hold any 32-byte x-only pubkey, so multisig is implementable later without changing the wire format.
- **Asset_id confidentiality.** Liquid CT uses surjection proofs to also hide which asset is moving. Not in tacit v1.
- **Address-graph privacy.** No CoinJoin, no shielded pool. Privacy scope is amount-only.
- **Bulletproofs+** (Chung et al. 2020) — ~17% smaller proofs at the cost of additional implementation complexity. Deferred to v1.5.
- **Lightning compatibility.** Tacit transfers are on-chain only; no LN-style payment channels.
- **Multi-asset transfers in one envelope.** Each CXFER carries a single `asset_id`.

## 10. Open issues / known limitations

- **Witness size.** ~10 KB witness per CXFER (m=2) at current bulletproof sizes — about 2,500–3,000 vBytes after the SegWit discount. At 10 sat/vB on mainnet, ~25–30k sats per transfer.
- **First-load scan time.** Cold scanHoldings on a wallet with deep ancestry takes seconds (mitigated by batched verification).
- **Lost mint key = permanent fixed supply.** No recovery mechanism. The dApp gates mintable etches behind an explicit key-export step before broadcast.
- **Lost mixer note = permanent inaccessibility of the deposit.** `T_WITHDRAW` (§5.11) requires the depositor's `(secret, ν)` pair, generated by CSPRNG at deposit time (§5.10) and not derivable from chain alone. A wallet that loses its note storage cannot reconstruct the deposit; the leaf is bound to a witness only that note's holder can produce. The reference dApp gates first deposit behind a note-export step and offers deposit-record export/import. Deterministic `(secret, ν)` derivation from privkey is a future UX improvement (parallel to §6's privkey-only recovery for non-mixer flows); v1 ships with the Tornado / Privacy Pools pattern of out-of-band note backup.
- **Local storage is the wallet.** Whichever path placed a privkey in the page (auto-generated, imported, or locally bound to an external wallet address), `localStorage` is what persists it. Mainnet UX gates every value-creating op behind a "have you exported the key?" acknowledgement (per §2). Hardware-wallet signing for the protocol's signing paths is the proper long-term mitigation but not in v1.
- **Network-scoped wallet keys.** v1 stores signet and mainnet identities under separate `localStorage` keys (`tacit-wallet-v1:signet`, `tacit-wallet-v1:mainnet`, plus `…:by:<extAddr>` variants when locally bound to an external wallet). Compromise of a signet/test key does NOT compromise mainnet — they're independent secrets generated on first use of each network. The trade-off is that switching from signet to mainnet (or vice versa) presents a fresh empty wallet by default; users who want to carry an identity across networks can manually `Import key` on the destination network. Older builds used a single un-namespaced `tacit-wallet-v1`; the dApp does not auto-migrate, so existing data under that key remains accessible only via manual import.
- **T_PMINT reorg sensitivity.** Cap correctness for T_PETCH-rooted assets requires complete, canonically-ordered T_PMINT history. Two T_PMINTs near tip can each look valid in isolation yet collectively violate the cap when canonically ordered. v1 mitigates by requiring confirmation depth ≥ 3 for cap-credit (§5.9 *Confirmation depth*); the deeper the threshold, the smaller the reorg-revocation surface but the slower mint UX. Wallets MUST surface "pending" T_PMINT UTXOs as non-spendable until the depth threshold crosses, and MUST handle revocation events when an indexer reverts a previously-credited T_PMINT under new canonical ordering. CETCH+T_MINT assets are unaffected — credit there depends only on the issuer's signature, not on aggregate chain state.
- **Reference-indexer KV.list cap.** The reference worker uses a single un-paginated `KV.list({ limit: 1000 })` call in three load-bearing places: (a) `loadCanonicalPmints` per asset, (b) the `/pools` aggregate endpoint's per-pool leaf + nullifier counts, and (c) the `/pools/:asset_id/:denom` detail endpoint's leaf list and nullifier list. An asset that accrues more than 1000 confirmed T_PMINTs will under-count `cumulative_minted`; a pool that accrues more than 1000 deposits or 1000 withdrawals will return a truncated state to clients that consume the worker view. v1 ships with this cap; deployments expecting > 1000 mints on a single asset OR planning to operate a pool past 1000 leaves/nullifiers should patch the relevant call sites to follow the `list_complete` cursor before relying on the worker's aggregate view. The cap is operational, not cryptographic — the dapp's local `scanPools` reconstructs from chain regardless, so a worker truncation degrades freshness/UX, not soundness.
- **T_DROP / T_DCLAIM (§5.12–§5.13) — spec drafted, implementation pending.** Wire format, validator pseudocode, soundness invariants, and the §8-airdrop interop story are specified. Implementation deliverables for v1: (a) dapp envelope encode/decode for both opcodes mirroring the existing T_PETCH/T_PMINT codec; (b) recursive-validator branches in `dapp/tacit.js` `validateOutpoint`; (c) indexer (worker cron) drop-metadata KV layout `drop:<network>:<drop_id>` parallel to `petch:<network>:<asset_id>`, plus `dclaim:<network>:<drop_id>:<height>:<tx_index>:<txid>` for cap accounting parallel to `pmint:…`; (d) dapp UI for issuer create-drop composer + recipient discovery/claim card; (e) `T_DROP_RECLAIM` flow; (f) test suite covering happy-path claims, cap-overflow ordering, expiry, merkle-gate eligibility, double-claim-via-leaf-index, replay across drop_ids, and reorg revocation. The opcodes are reserved in this version of the spec; v1 indexers without §5.12/§5.13 support MUST reject (return `false` from `validateOutpoint`) for opcodes `0x2B` and `0x2C` rather than silently accepting them under a default branch — soft-fork forward-compatibility is preserved because the unknown-opcode path is already `return false` per §5.5.
- **Mixer pool — production, Phase 2 ceremony finalized.** Wire format (§5.10–§5.11), worker indexing (`/pools` + canonical leaf order + nullifier set + reorg-safety depth gate per `MIXER_DEPOSIT_CONFIRMATION_DEPTH`), dApp UI (Mixer tab), Groth16 prove + verify pipeline (snarkjs vendored at `vendor/tacit-mixer.min.js`), `T_DEPOSIT` / `T_WITHDRAW` broadcast flows, and indexer-determinism gates (worker `bind_hash` recompute mirrors dapp's per §11) are all shipped and tested (108 tests across 7 mixer test files; see `tests/mixer*.test.mjs`). Verifier soundness is closed per §3.8 + §5.11.1.

  **Both ceremony prerequisites are resolved:**

  1. ~~**Phase 1 ptau provenance.**~~ Resolved: `dapp/circuits/build.sh` fetches the publicly-attested Polygon Hermez ceremony output (`powersOfTau28_hez_final_14.ptau`, 71 public contributors, 2020–2022, Bitcoin-block-hash beacon-finalized) and dual-checks both SHA256 and BLAKE2b-512 against the canonical hashes published in the snarkjs README before proceeding; refuses to use the file on any mismatch. Phase 2 contributions cannot rescue a backdoored Phase 1, so this verified provenance is load-bearing — but it is shipped.
  2. ~~**Phase 2 per-circuit ceremony.**~~ Resolved 2026-05-11: the coordinator ran the public Phase 2 ceremony for the canonical mixer circuit (`circuit_hash = 1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d`), accepted 2,227 community contributions over the contribution window, and beacon-finalized against Bitcoin block 948824 (10 MiMC iterations). Final contributor count is ~2× Tornado Cash's Phase 2 reference (1,114). The canonical bundle (final zkey, pre-beacon zkey, vk JSON, r1cs, ptau, attestations chain) is pinned to IPFS at `bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5ppry55tzxzlvltxy2u` and hardcoded in the dapp as `CANONICAL_CEREMONY_CID`; every pool init binds to the same trust anchor. Auditors can fetch the bundle, walk the attestation chain via `prev_cid` from beacon back to genesis, and verify each link content-addresses the previous zkey. The bundle is content-addressed so any future tamper produces a different CID and fails verification at withdrawal time.

  The protocol still supports the general pattern of one-Phase-2-ceremony-per-circuit (e.g., a future circuit upgrade would require a fresh ceremony); the section above documents how the live circuit's ceremony was run.

## 11. Indexer rejection-path determinism

This section is normative for every conforming indexer (worker, dapp client, third-party).

The protocol's most consensus-sensitive state is the **set of envelopes accepted as valid**. Two indexers seeing the same byte sequence MUST reach the same accept/reject decision, byte-for-byte. Determinism in the *rejection path* is as important as determinism in the *acceptance path*: a malformed envelope that one indexer accepts and another rejects produces a fork in derived state — most catastrophically in the per-pool spent-nullifier set (§5.11), where divergence means one indexer believes a nullifier is spent (and rejects future legitimate withdraws using that ν) while another doesn't.

### 11.1 Required determinism properties

Every envelope decoder, in every implementation, MUST:

1. **Produce identical accept/reject verdicts** for byte-equal inputs. No timing-dependent or stateful rejection paths in the structural decode layer.
2. **Reject on the FIRST failed invariant** in the validator algorithm's documented order (§5.5 / §5.10 / §5.11). Indexers that short-circuit out of order may diverge on envelopes that fail multiple invariants.
3. **Return null (not throw, not partial)** on any malformed input. Throwing surfaces as different failure modes in different runtimes; null is unambiguous.
4. **Validate semantic invariants in the decoder**, not in the consumer. Specifically:
   - `T_WITHDRAW`: `bind_hash` recompute MUST be in `decodeTWithdrawPayload` (not in a separate validator step). Otherwise a worker that uses the structural decoder without the validator step writes nullifiers for envelopes the dapp would reject — see §5.11.4 invariant 5.
   - `T_PETCH`: `cap_amount % mint_limit == 0` and `cap_amount > mint_limit` MUST be in `decodeCPetchPayload`.
   - `T_PMINT`: `0 < amount < 2^N_BITS` and `nullifier_hash != 0` MUST be in `decodeCPmintPayload`.
5. **Use byte-exact field encoding.** Little-endian for u64 / u32 / u16 fields (e.g., `denomination`, `mint_limit`, `proof_len`); big-endian for hash digests treated as field elements (e.g., `bind_hash` SHA256 output is a 32-byte BE field). Mixed encoding silently breaks indexer parity.

### 11.2 Cross-implementation enforcement

The dapp ↔ worker decoder agreement is enforced by `tests/mixer-envelope.test.mjs`, `tests/worker-decoder.test.mjs`, and `tests/dapp-parity.test.mjs`. Any new indexer (third-party, light client, alternative implementation) SHOULD run an analog test suite against this spec's decoder shapes before serving users.

Concretely: a third indexer implementation in Rust / Go / Python MUST produce byte-identical KV state given the same Bitcoin chain history. Disagreements are bugs and SHOULD be reported as protocol-level issues.

### 11.3 Audit checklist

For each envelope opcode, indexer implementers MUST verify:

- [ ] Wire-format byte layout exactly matches the §5 spec (no extra padding, no missing fields, byte order documented per field).
- [ ] All structural invariants (lengths, sentinel values, field ranges) are enforced in the decoder, not in callers.
- [ ] Recompute-and-compare invariants (e.g., `T_WITHDRAW.bind_hash`, `T_PMINT` Pedersen consistency at the recovery layer) are documented and tested.
- [ ] Rejection produces `null` (or the language's equivalent), never a throw or a partial parse.
- [ ] No envelope-level state is exposed via decoder return values that differs between accept-and-fail-later vs reject-now paths. The decoder's verdict is final at the structural layer.

## 12. Acknowledgements

- Pedersen commitments, Mimblewimble kernel signatures: Maxwell, Poelstra, Jedusor.
- Bulletproofs aggregated range proof: Bünz, Bootle, Boneh, Poelstra, Wuille, Maxwell (2017).
- BIP-340 Schnorr / BIP-341 Taproot: Wuille, Nick, Towns.
- Indexer-validated meta-protocol pattern: Runes / Ordinals.
- Tornado Cash mixer design (Pedersen commitments + Groth16 + nullifier set + per-pool merkle tree): Pertsev, Storm, Semenov; Tornado.cash team (2019). Tacit's `withdraw.circom` adapts theirs.
- All primitives sourced from [`@noble/secp256k1`](https://github.com/paulmillr/noble-secp256k1) and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes).
