# tacit protocol specification

> **Status:** v1. Wire format is envelope version `0x01`, opcodes 0x21–0x26 (0x26 = `T_AXFER`, atomic OTC settlement; §5.7). Runs on signet + mainnet — the dApp's in-page privkey (auto-generated, imported, or locally bound to an external wallet's address) is what signs every protocol op (see §2). This spec is the authoritative reference for indexer implementations and audit review.

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

## 2. Trust model

| Trusted for | Mitigation if compromised |
|---|---|
| **Bitcoin (host chain)** — tx ordering, witness integrity, no double-spends | None: this is the substrate |
| **Indexer code** (the dApp HTML or a re-implementation) — correct enforcement of the rules in this spec | Re-host, audit, pin by content hash. Two browsers running the same code reach the same verdict |
| **`@noble/secp256k1` and `@noble/hashes`** — crypto primitives | Vendored under `dapp/vendor/tacit-deps.min.js` and pinned by IPFS CID alongside `dapp/tacit.html`. Build pipeline at `build/`; runtime KAT in `runStartupKAT()` is independent defense |
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

Tagged by a v1 domain string + per-output `(anchor || vout_LE)`. Domain tags:

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

Anchor construction:
- **CXFER / BURN**: `anchor = first_asset_input_txid_BE || first_asset_input_vout_LE`. Per-tx entropy prevents cross-tx correlation (`(C₁ − C₂) = (a₁ − a₂) · H` leak).
- **CETCH / T_MINT**: `anchor = first_commit_input_txid_BE || first_commit_input_vout_LE`. Anchor predates the envelope (a pre-existing UTXO), breaking the envelope/commitment cycle. Scanners read it via `reveal_tx.vin[0]` → fetch commit tx → `commit_tx.vin[0]`.

**Uniqueness invariant.** Bitcoin consensus prevents any outpoint from being spent twice, so each anchor is unique across all valid txs that reference it as a first input. Combined with the per-output `vout_LE` suffix in every keystream/blinding domain, no two outputs across all valid envelopes can ever reuse the same `(domain, anchor, vout)` triple under a given keystream. This is what makes the deterministic recovery of openings from chain + privkey alone safe.

## 4. Asset identity

`asset_id = SHA256(reveal_txid_BE || reveal_vout_LE)` where `reveal_vout = 0` for CETCH (always vout 0).

This deterministically derives a 32-byte asset_id from the etch reveal transaction. T_MINT envelopes reference the same `asset_id` and include `etch_txid` so the validator can resolve the originating CETCH envelope.

The `ticker` field is **not** unique. Multiple etches with `ticker = "USDC"` are valid; they will have distinct `asset_id` values. Wallets must display `asset_id` alongside ticker for disambiguation (same as ERC-20 contract addresses).

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

Disclosure record (POST body):
```
{
  asset_id:     hex(32),
  utxos:        [{txid, vout}, …],
  threshold:    decimal string, 0 < K < 2⁶⁴,
  rangeproof:   hex,
  owner_pubkey: hex(33),
  sig:          hex(64)           # BIP-340 Schnorr over disclosure_msg, x-only key from owner_pubkey
}
```

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
| `0x02` | (empty) | u32 LE: `asset_input_count` | global map |
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
  intent_id            16 hex chars (sha256(commit_txid_BE || maker_pubkey)[:16])
  asset_id, maker_pubkey (33B compressed), maker_address (bech32),
  amount               u64 base units (cleartext — the listed amount)
  price_sats           u64
  expiry               unix-seconds (≤ 7 days from publish)
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
  intent_id, taker_pubkey (33B), sig, claimed_at, expires_at  // 30-min TTL
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

claim_msg     = SHA256("tacit-axintent-claim-v1"     || asset_id || intent_id || taker_pubkey)
fulfilment_msg = SHA256("tacit-axintent-fulfilment-v1" || asset_id || intent_id || taker_pubkey
                       || SHA256(partial_reveal_json))
cancel_msg    = SHA256("tacit-axintent-cancel-v1"    || asset_id || intent_id)
```

`intent_id` is `SHA256(commit_txid_BE || maker_pubkey)[:16]` — stable per intent, derivable by anyone given the commit txid and maker pubkey, and unique because commit_txid is unique in Bitcoin.

##### Lifecycle (state machine)

```
[publish]   maker:   build & broadcast commit tx + post intent → intent stored
[browse]    anyone:  GET /atomic-intents → discover open intents
[claim]     taker:   POST /:intent_id/claim with taker_pubkey → 30-min lock
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
- **Maker liveness.** Fulfilment requires the maker to be online during the 30-min claim window. If they're offline, the claim expires and a fresh claim from anyone can replace it.
- **Abandoned commits.** If no one claims the intent before its expiry, the commit P2TR sits unspent on chain. The maker can reclaim by spending it via the script-path with the envelope as the leaf — the reclaim is exactly a take-by-self with the maker as both maker and taker.

##### Privacy of the listed amount

Atomic intents publish the listed UTXO's amount in cleartext — the taker needs to know what they're buying. The recipient blinding `r` is **not** published; it's encrypted to the claimant at fulfilment time (see above). The maker's *other* UTXOs of the same asset are unaffected — observers learn the amount of the listed UTXO from the cleartext `amount` field, but not its `r`, so the on-chain commitment remains computationally unrecoverable to anyone except the named claimant. Range-disclosed listings (§5.6 + listings layer) cover the symmetric case (no atomicity, but no listed amount either); the two primitives coexist for different use cases.

##### Recovery model exception

Because `r` is random rather than ECDH-derived, an atomic-intent recipient UTXO is **not recoverable from chain + privkey alone** in the sense of §6 paths 2–5. The taker's wallet records the opening locally on take (path 1), so recovery works from local cache as long as the wallet hasn't been wiped. If the wallet is wiped, the taker can re-fetch the encrypted fulfilment from the worker and decrypt — provided it's still within the worker's 24-hour fulfilment TTL. Beyond the TTL, the UTXO becomes a "ghost" entry: the BTC sats are spendable by privkey, but the asset amount is unrecoverable without the maker re-providing the encrypted blinding off-band.

This is the only recovery-model exception in tacit and is unique to the atomic-intent coordination layer; targeted §5.7.3 settlements use ECDH-derived blindings and recover normally via §6 path 2.

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

## 6. Recovery semantics

A wallet with only its **private key** can recover its full balance from chain data alone for every UTXO produced by the **on-chain protocol layer** (CETCH / CXFER / T_MINT / T_BURN, including targeted §5.7.3 T_AXFER settlements). Atomic-intent recipient UTXOs are the one exception — see §5.7.6 "Recovery model exception" — because their recipient blinding is a uniform-random scalar fixed at intent-publish time rather than ECDH-derived; recovery from chain + privkey alone is impossible by design, and recovery falls back to local opening cache or re-fetching the encrypted fulfilment from the worker.

For each UTXO the wallet owns:

1. **Local opening cache** (`localStorage`): `(amount, blinding)` if the wallet has previously seen this UTXO. **Required** for atomic-intent recipient UTXOs (or re-fetching from the worker's encrypted fulfilment record while it's within the 24h TTL).
2. **As recipient (CXFER, targeted T_AXFER §5.7.3)**: ECDH against sender's pubkey at `tx.vin[1].witness[1]`. Try `tacit-blind-v1` blinding + `tacit-amount-v1` keystream. Verify `pedersenCommit(decrypted_amount, blinding) == on_chain_commitment`.
3. **As own change (CXFER / BURN)**: Try `tacit-change-v1` blinding + `tacit-amount-self-v1` keystream against the change vout.
4. **As own etched supply (CETCH)**: Try `tacit-etch-v1` + `tacit-etch-amount-v1` against the etcher's commit-input anchor.
5. **As own minted supply (T_MINT)**: Try `tacit-mint-blind-v1` + `tacit-mint-amount-v1` against the mint commit-input anchor.

If none of the paths produce a valid `(amount, blinding)` opening, the UTXO is recorded as a **"ghost"** — the wallet sees that it owns the BTC sat output but cannot decrypt the asset amount. This indicates either a legacy/incompatible sender, a misuse, or an atomic-intent recipient whose local cache and remote encrypted fulfilment are both unavailable; it does not represent loss of value (the BTC sats are still spendable by the wallet privkey).

**`amount_ct` is a raw XOR keystream — authenticity is load-bearing on the commitment check.** Decryption produces a candidate amount; the wallet MUST verify `pedersenCommit(candidate, blinding) == on_chain_commitment` before accepting it. The Pedersen binding property is what rejects tampered ciphertexts: if anyone flips a bit in `amount_ct`, the decrypted candidate differs from the originally-committed value and the equality fails. Recovery paths 2–5 above all perform this check; skipping it would let an attacker forge spurious ghost-UTXO openings.

## 7. Security properties

### 7.1 Privacy

- **Amount confidentiality** of every commitment. Perfect Pedersen hiding + bulletproof zero-knowledge. Observers see range bounds and structure but not the value.
- **Keystream uniqueness across transactions** (NOT forward secrecy): the keystream that XOR-encrypts each `amount_ct` is bound to a per-tx anchor (`vin[0]` outpoint) and per-output `vout` index. The same (sender, recipient, amount) tuple produces a different ciphertext every transaction because the anchor is unique. This prevents the OTP key-reuse attack (where two ciphertexts under the same keystream leak their XOR difference) but does **not** provide forward secrecy in the cryptographic sense — the keystream derives from `HMAC(SHA256(ECDH(maker_priv, taker_pub)), …)` (or `HMAC(wallet_priv, …)` for self-derived amounts), all of which are static long-term keys. **If either party's tacit privkey is compromised, every past `amount_ct` for transactions involving that key becomes decryptable from chain alone.** Real forward secrecy would require ephemeral key exchange per transaction, which the in-page key-custody model (a single static privkey reused for every op) does not support. Hiding therefore relies on long-term key secrecy plus Pedersen's perfect-hiding property at the commitment layer (the commitment itself reveals nothing without `r`, regardless of whether `amount_ct` is decrypted).

What is **not** hidden:
- **Address graph.** Bitcoin-level addresses are visible.
- **Asset_id.** Visible in CXFER / T_MINT / T_BURN payloads.
- **Sender pubkey.** P2WPKH input signatures expose sender's pubkey at `vin[1].witness[1]` (recipient needs it for ECDH). Same exposure as any P2WPKH-funded transfer.
- **Public burn amounts.** T_BURN's `burned_amount` is in cleartext.
- **Number of outputs.** N is in the envelope. Observable structure.

### 7.2 Soundness

- **No inflation downstream of etch.** Kernel sig + range proof ensure `Σ_out ≤ Σ_in + burnt − burnt = Σ_in` (or `Σ_in − burned` for BURN).
- **No negative-amount smuggling.** Range proof bounds every amount to `[0, 2⁶⁴)`, including change. A "negative" amount would be `N − k` modulo the scalar field; this is *not* in the 64-bit range and the proof rejects.
- **Mint authorization.** T_MINT requires Schnorr sig under `mint_authority` from the CETCH ancestor. Non-mintable assets (`mint_authority = 0`) reject all T_MINT envelopes.
- **Replay protection.** Kernel msg binds (asset_id, input outpoints, output commitments, burned_amount). Mint msg binds (asset_id, commit_anchor, commitment, amount_ct) — the anchor prevents envelope re-wrap into a different commit/reveal pair (§5.3). No cross-tx or cross-asset replay.
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

## 8. Worker (off-chain conveniences)

The worker (`worker/src/index.js`) is **not part of the trust-bearing protocol**. Setting `WORKER_BASE = ''` in `tacit.html` disables it entirely; the protocol still works for full validation and transfers.

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
| `GET /utxos/:txid/:vout/opening` | Single-UTXO opening lookup (cache-only). |
| `GET /assets/:asset_id/listings`, `POST /assets/:asset_id/listings/:txid/:vout/claim`, `DELETE /assets/:asset_id/listings/:txid/:vout` | OTC marketplace endpoints. **Settlement is OTC, not protocol-enforced** — the worker stores listing intent + an opening proof; actual delivery is bilateral. The marketplace surface lives entirely outside the on-chain protocol; an indexer that only cares about token validity can ignore it. |
| `GET /assets/:asset_id/listings-range`, `DELETE /assets/:asset_id/listings-range/:ownerPubkey` | Range-disclosure variant of the above (lists backed by a `balance ≥ K` proof rather than a single UTXO opening). Same OTC caveat applies. |
| `POST /assets/hint` | `{ reveal_txid, reveal_vout? }` — targeted index of a freshly broadcast etch / mint / burn so it appears in `/assets` immediately without waiting for the next 5-min cron tick. Works pre-confirmation. |
| `POST /scan` | Manual cron trigger (debug) |
| `POST /rescan?from=<height>` | Rewind `meta:last_scanned` (debug) |

Cron (`*/5 * * * *`) scans recent signet AND mainnet blocks for CETCH, T_MINT, and T_BURN envelopes and indexes them. Worker decodes envelopes only structurally — the rangeproof and signature verification stay client-side. The `/assets/hint` endpoint exists so a freshly broadcast envelope appears in the registry without waiting for the next cron tick.

**Protocol validity vs. operational dependency.** "Not part of the trust-bearing protocol" means the worker cannot make an invalid envelope appear valid: every consumer is expected to re-verify rangeproofs, kernel sigs, mint sigs, and Pedersen openings client-side. It does **not** mean a malicious or faulty worker is harmless to user experience: such a worker could omit assets from `/assets`, return stale `last_scanned` heights, withhold or mis-serve `/openings` data needed for cold recovery, fail to index a freshly hinted reveal, lie about burn history, or refuse `/disclosures`. None of that produces unsound balances, but it can degrade discovery, slow recovery, and cause UI to lag chain reality. Any deployment that wants to harden against this should run its own indexer (the cron in `worker/src/index.js` is a few hundred lines and pluggable behind any mempool.space-compatible REST endpoint), or run client-side validation eagerly enough that worker output is treated as a hint rather than as canonical metadata. Likewise, the dApp's reliance on `mempool.space` REST APIs for raw-tx fetching is a UX dependency, not a trust dependency: a Bitcoin Core or Electrum backend would serve identically once the JSON shape is matched.

## 9. Out of scope (v1)

- **Multisig mint authority.** Requires FROST or MuSig2 plumbing on top of single-key Schnorr. The on-chain `mint_authority` field can hold any 32-byte x-only pubkey, so multisig is implementable later without changing the wire format.
- **Asset_id confidentiality.** Liquid CT uses surjection proofs to also hide which asset is moving. Not in tacit v1.
- **Address-graph privacy.** No CoinJoin, no shielded pool. Privacy scope is amount-only.
- **Bulletproofs+** (Chung et al. 2020) — ~17% smaller proofs at the cost of additional implementation complexity. Deferred to v1.5.
- **Lightning compatibility.** Tacit transfers are on-chain only; no LN-style payment channels.
- **Multi-asset transfers in one envelope.** Each CXFER carries a single `asset_id`.

## 10. Open issues / known limitations

- **Witness size.** ~10 KB per CXFER (m=2) at current bulletproof sizes. At mainnet 10 sat/vB, ~$1–3 per transfer.
- **First-load scan time.** Cold scanHoldings on a wallet with deep ancestry takes seconds (mitigated by batched verification).
- **Lost mint key = permanent fixed supply.** No recovery mechanism. The dApp gates mintable etches behind an explicit key-export step before broadcast.
- **Local storage is the wallet.** Whichever path placed a privkey in the page (auto-generated, imported, or locally bound to an external wallet address), `localStorage` is what persists it. Mainnet UX gates every value-creating op behind a "have you exported the key?" acknowledgement (per §2). Hardware-wallet signing for the protocol's signing paths is the proper long-term mitigation but not in v1.
- **Network-scoped wallet keys.** v1 stores signet and mainnet identities under separate `localStorage` keys (`tacit-wallet-v1:signet`, `tacit-wallet-v1:mainnet`, plus `…:by:<extAddr>` variants when locally bound to an external wallet). Compromise of a signet/test key does NOT compromise mainnet — they're independent secrets generated on first use of each network. The trade-off is that switching from signet to mainnet (or vice versa) presents a fresh empty wallet by default; users who want to carry an identity across networks can manually `Import key` on the destination network. Older builds used a single un-namespaced `tacit-wallet-v1`; the dApp does not auto-migrate, so existing data under that key remains accessible only via manual import.

## 11. Acknowledgements

- Pedersen commitments, Mimblewimble kernel signatures: Maxwell, Poelstra, Jedusor.
- Bulletproofs aggregated range proof: Bünz, Bootle, Boneh, Poelstra, Wuille, Maxwell (2017).
- BIP-340 Schnorr / BIP-341 Taproot: Wuille, Nick, Towns.
- Indexer-validated meta-protocol pattern: Runes / Ordinals.
- All primitives sourced from [`@noble/secp256k1`](https://github.com/paulmillr/noble-secp256k1) and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes).
