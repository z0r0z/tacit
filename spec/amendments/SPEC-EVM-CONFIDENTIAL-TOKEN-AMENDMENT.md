# SPEC Amendment — EVM Confidential Token (Tacit on Ethereum L1)

> **STATUS: DRAFT** (2026-06-06). Defines a confidential-asset factory on
> Ethereum L1 that reuses Tacit's existing secp256k1 cryptography unchanged —
> the same Pedersen commitments, the same NUMS generator
> (`tacit-generator-H-v1`), the same Bulletproofs / Bulletproofs+ range
> tooling, the same range-attestation primitive, and the same blinded-pubkey
> stealth construction. **No new trusted setup** for the launch surface.
>
> Companion to:
> - `SPEC-RANGE-PROOF-PRIMITIVE.md` — predicate proofs over Pedersen-committed
>   u64 amounts (`bpRangeAggProve` / `bpRangeAggVerify`); reused verbatim for
>   off-chain attestation here.
> - `SPEC-RANGE-ATTEST-AMENDMENT.md` (`T_RANGE_ATTEST` `0x3A`) — the
>   attestation anchor; the EVM surface mirrors its predicate set.
> - `SPEC-WRAPPER-AMENDMENT.md` (§4.2, merged) — the wrapping convention this
>   extends from Bitcoin-layer underlyings to ERC20 underlyings.
> - `SPEC-CXFER-BPP-AMENDMENT.md` (§5.21, `dapp/bulletproofs-plus.js`) — the
>   confidential-transfer construction this ports to L1.
> - `SPEC-BLINDED-PUBKEY-AMENDMENT.md` — the stealth-recipient construction,
>   here in its ERC-5564 form so one wallet seed scans both chains.
> - `ops/PLAN-eth-shielded-pool-factory.md` — the deployment plan; this
>   amendment is the normative construction for that plan's factory phase, and
>   composes with its native ETH `ShieldedPool` (unlinkability) as the
>   amount-privacy half of the stack.

---

## Motivation

Tacit's privacy stack already separates two capabilities: the mixer hides
**who** (unlinkability between deposit and spend), and confidential transfers
hide **how much** (Pedersen amounts + range proofs). The native ETH
`ShieldedPool` (companion plan) brings the first to Ethereum. This amendment
brings the second: a factory for ERC20 tokens whose **balances are blinded**,
whose **supply is provably fixed, mintable, or burnable**, and which can
**wrap any existing ERC20** into a confidential representation — with holders
able to **attest and prove balances, including ranges**, to any counterparty.

The design choice that makes this distinct from existing Ethereum confidential
tokens is not a feature, it is a curve. Every comparable system builds notes on
an Ethereum-native curve (BN254, Grumpkin), which permanently severs them from
Bitcoin. Tacit's notes are secp256k1 — Bitcoin's curve — and the EVM can verify
secp256k1 relations through the `ecrecover` precompile. So the **note is a
single cross-chain object**: the same 33-byte commitment, the same range
disclosure, the same stealth address, the same wallet seed are valid whether
the value is escrowed in a Bitcoin UTXO or an Ethereum contract. Only the
settlement rail differs.

---

## 1. Note model (secp256k1, shared with the Bitcoin layer)

A confidential balance is a set of **notes**. A note is:

```
note = (owner, C, memo)
  C     = a·H + r·G            secp256k1 Pedersen commitment
  a     ∈ [0, 2⁶⁴)             hidden amount (token base units, ≤ 8-dec scaled)
  r     ∈ [0, n_secp)          blinding scalar
  H     = NUMS("tacit-generator-H-v1")   (identical to SPEC.md §3.3)
  G     = secp256k1 base point
  owner = Ethereum address, or a stealth pubkey commit (§6)
  memo  = ECDH-keystream-encrypted (a, r) for the owner (SPEC.md §5.7.6 tag
          "tacit-amount-v1"), so the owner recovers the opening from chain alone
```

`C`, `H`, `a`, `r`, and the `memo` derivation are **byte-identical** to a
Bitcoin-layer Tacit UTXO commitment. A balance attestation produced on one
chain verifies on the other with no translation.

Notes are recorded on-chain as leaves in a per-asset append-only structure with
a spent-marker set (the "nullifier" of a note is `keccak256(C ‖ "spent")`,
unique because `C` is unique per note). The contract is the custody root: a
note is spendable only against the asset contract that minted or shielded it.

---

## 2. On-chain verification primitives (what the EVM can and cannot do natively)

The launch surface rests on two EVM capabilities and one bounded helper:

1. **`ecrecover` as a secp256k1 equation-checker (~3k gas).** `ecrecover` can
   be coerced to test an equation of the form `s·P + e·Q == T` by comparing the
   recovered address to `address(T)`. This verifies a Schnorr signature, a
   proof-of-knowledge of a blinding, or one branch of a CDS OR-proof — each at
   roughly one precompile call. This is the cheap path and it carries every
   per-note authorization and supply proof.

2. **`sha256` / `keccak256` (native).** Fiat-Shamir challenges, memos, domain
   binding.

3. **Bounded secp256k1 point addition in Solidity (modexp-backed inversion).**
   There is no secp point-add precompile, so summing commitment points for a
   **conservation** check (`Σ C_in − Σ C_out = …`) is done with explicit EC
   additions in Solidity, a handful per transfer. This is the one non-trivial
   on-chain cost, and it applies **only to synchronous transfers (§4 Tier A)**;
   the batched tier (§4 Tier B) moves all summation and range checking into the
   prover and leaves the chain a single proof verification.

Domain separation: every signed or hashed structure on this surface is tagged
with `chainid` and the asset contract address, so a proof is valid only for the
asset and chain it was produced for, and never collides with a Bitcoin-layer
structure or with the `ShieldedPool` withdraw domain.

---

## 3. Factory and supply operations (public-amount — ship first, no range proof)

The factory is a single CREATE2 deployer. None of the operations in this
section requires a range proof, because the amount moved is public; only its
**distribution across notes** is hidden. These are the launch surface.

### Asset identity
```
etched token:   asset_id = sha256("tacit-evm-etch-v1"  ‖ chainid_be8 ‖ factory ‖ salt ‖ etcher ‖ meta_hash)
wrapped/native: asset_id = sha256("tacit-evm-token-v1" ‖ chainid_be8 ‖ underlying_token)
meta_hash       = sha256( u8(len symbol) ‖ symbol ‖ u8(decimals) )
```
Domain-separated from the Bitcoin `sha256(reveal_txid ‖ vout)` namespace and
from the `ShieldedPool` asset-id rule by tag.

**Canonical ERC20 metadata.** The public ERC20's `name` is the constant brand
`"Tacit Token"` — a Tacit asset carries no trustless on-chain name (the etch envelope
holds only `ticker` + `decimals`; the richer name is off-chain in IPFS), so name is a
constant rather than a spoofable or off-chain-sourced field. The only per-asset metadata
is `(symbol, decimals)`, which is **deterministic to the real asset**:

- **EVM-native etch:** the etched id commits to `(symbol, decimals)` through `meta_hash`,
  so the metadata is canonical *by construction* — the deployer derives the id on-chain
  from the supplied metadata (`CanonicalAssetFactory.deriveAssetId` / `etchCanonical`)
  and anyone can recompute the binding (`verifyMetadata`). Exactly one official
  `(symbol, decimals)` per id.
- **Bitcoin-native etch (e.g. TAC):** `(ticker, decimals)` live on-chain in the CETCH /
  T_PETCH reveal envelope, transitively bound to the id via the txid
  (`asset_id = sha256(reveal_txid ‖ 0)`, `reveal_txid = double_sha256(reveal_tx)`). The
  bridge proves them once at first mint (in the SP1 proof's public values, or an
  on-chain etch-envelope proof) and the canonical ERC20 carries them immutably.
- **Wrapped ERC20:** the id binds the underlying, whose `symbol`/`decimals` are read from
  that token directly.

The address is a pure function of the id (CREATE2 salt = `asset_id`, constant ERC20 init
code), so the bridge computes it before the token exists, deploys it on first mint, and
mints against the same address forever after. `meta_hash` is length-prefixed and
language-neutral (reproducible in Solidity, JS, and Rust).

**Decimals harmonization.** Each chain presents an asset in its own convention: Bitcoin /
Tacit ≤ 8 decimals (Bitcoin's native limit), Ethereum 18 (`ConfidentialPool.ETH_DECIMALS`).
A Tacit-native asset's canonical ERC20 is presented at 18, and the per-asset
`unitScale = 10^(ETH_DECIMALS − tacitDecimals)` (e.g. 8-decimal TAC → 18-decimal ERC20,
scale `10^10`) is **derived on-chain** from the native precision —
`registerMintedAuto(factory, tacitAssetId, symbol, tacitDecimals)` lazily deploys the
ERC20 (address = `f(tacitAssetId)`) and records the scale, no operator-chosen value to get
wrong. Amounts scale by `unitScale` across the boundary: the in-system note value times
`unitScale` is the public ERC20 amount. Tacit→Ethereum is lossless (multiply);
Ethereum→Tacit only crosses whole multiples of `unitScale` (`wrap` rejects unaligned
amounts), so sub-precision dust stays as ERC20 on Ethereum — value-conserving, round-trip
exact.

### `etch` — confidential token, two mode-split entrypoints
Deploys a `TacitConfidentialEtched` (CREATE2) through one of two entrypoints (no
overloaded sentinel), each taking `Meta{ name, symbol, decimals, uri }`:
- `etchAuthority(mintAuthority, meta, salt)` — `mintAuthority` (nonzero) may
  `mint` any denomination, anytime, and may `renounceMint()` to fix supply.
- `etchFairLaunch(petch, meta, salt)` — no issuer (fair launch); see `petch`
  below.

`name` / `symbol` / `decimals` are carried **on-chain** by the token — queryable
in one `eth_call`, no indexer or off-chain fetch (the EVM gain a Bitcoin
inscription can't offer); `meta.uri` carries richer off-chain metadata (icon,
description) via the `Etched` event. The token is note-based, not an ERC20 (value
is in notes; no `balanceOf` / `transfer(address,uint256)`) — only the metadata
triple is exposed, so nothing misrepresents it as a standard fungible token.
Supply starts at zero and is issued by `mint`; there is no initial-supply-at-
deploy step. Supply is always public and exact; its allocation across notes is
blinded.

### `petch` — fair-launch (T_PETCH analogue)
`Petch{ denomIdx, cap, startBlock, endBlock }`: anyone calls `mint` for exactly
denomination `d_denomIdx`, inside `[startBlock, endBlock]`, until `supply` would
exceed `cap`. Gas is the natural rate limiter (the role Bitcoin fees play in
T_PMINT).

### `mint` / `burn` (public denomination + PoK)
Both move a single ladder denomination, public, with a PoK binding the note
commitment:
- `mint(denomIdx, C, pok)` — issue a note opening to `d_denomIdx` (PoK that
  `C − D_denomIdx = r·G`); public supply `+= d_denomIdx`. In authority mode only
  `mintAuthority` may call; in fair-launch mode anyone may, under the `petch`
  gate. Auditable: supply is exact and public, distribution hidden.
- `burn(denomIdx, C, pok)` — prove the note opens to `d_denomIdx`; destroy it;
  public supply `−= d_denomIdx`.

### Balance attestation & range proofs (reused verbatim, off-chain)
A holder proves a predicate over their notes' hidden amounts —
`≥ X`, `≤ X`, `∈ [X, Y]`, `> b`, `= X`, and homomorphic sums across notes —
using `SPEC-RANGE-PROOF-PRIMITIVE.md` (`bpRangeAggProve` / `bpRangeAggVerify`)
**unchanged**, because the commitments share the Bitcoin-layer generators. This
is a counterparty-to-counterparty proof and needs no on-chain transaction. For
an on-chain anchor (CDP gates, tiered-fee tiers, permissioned LP), the
`T_RANGE_ATTEST` envelope shape is mirrored as a factory event so an EVM
consumer contract can require a recorded attestation.

---

## 4. Confidential transfers (divisible hidden amounts — two tiers, same notes)

A divisible transfer splits notes into payment + change with **hidden** output
amounts, so it requires non-negativity (range) enforcement, and because the
contract holds escrow the **contract** must enforce it. Both tiers operate on
the §1 notes; an asset can support either or both. Conservation in both tiers
is the Mimblewimble-style kernel: `Σ C_in − Σ C_out − fee·H = excess·G` with a
Schnorr signature under `excess`.

### Tier A — denominated OR-notes (no setup, synchronous, instant)
Each note's amount is constrained to a fixed **denomination ladder**
`{d₁ … d_k}` by a CDS OR-proof that `C` opens to one of `{d_i·H + r·G}`
(witness-indistinguishable — *which* denomination is hidden). Given that every
amount is provably one of `k` positive denominations, **no separate range proof
is needed**: conservation plus DL-independence of `H, G` forces
`Σ d_in = Σ d_out`, and no negative amount can exist in the ladder. On-chain:
`k` `ecrecover` branch checks per note (§2.1) + the bounded EC-add conservation
sum (§2.3) + the kernel Schnorr. Only **new outputs** need the membership proof
— inputs were proven when they were created — so the per-transfer cost scales
with outputs, not inputs+outputs. No trusted setup, no proving latency; amounts
quantize to the ladder (cash-like notes). This is the recommended launch
transfer mode.

**Measured (probe, `contracts/test/Secp256k1Probe.t.sol`, vectors verified
against `@noble/secp256k1`):** `ecAdd` ≈ 3.1k gas, a `mulmuladd`/ecrecover
linear check ≈ 6k, a 1-of-8 OR-proof ≈ 65k per output, the 2-in-2-out
conservation kernel ≈ 13k. A full 2-in-2-out transfer ≈ **143k gas** of
compute (plus proof calldata; the `d_i·H` ladder points are baked-in contract
constants, not calldata). Uniswap-swap territory — comfortably affordable on L1.
The ladder is fixed protocol-wide at `k = 8` (`d_i = 10**i`), so notes stay
uniform across every confidential token.

### Tier B — SP1-batched Bulletproofs+ (exact amounts, batched finality)
Transfers post the **unchanged** secp256k1 Bulletproofs+ proof
(`dapp/bulletproofs-plus.js`, §5.21) as calldata. A batch prover — the existing
SP1 stack, the same canonical-ELF / vkey-pin discipline and SP1 verifier trust
root used by the tETH bridge — verifies the BP+ proofs and the conservation
kernels **inside the guest** and lands one batch proof. On-chain per batch: one
SP1 proof verification + nullifier marking; no in-Solidity EC-add. Exact
arbitrary amounts; a received note is spendable once its batch is proven
(bridge-style cadence). This reuses more existing cryptography than any
SNARK-circuit approach — the BP+ proofs are not re-proven, only verified and
amortized — and adds no ceremony.

Tier B generalizes to the full arbitrary-amount product — wrap / transfer /
unwrap / mint / burn as SP1-validated state transitions over secp256k1 notes,
with an on-chain ERC-20 boundary + one proof + a state root, permissionless
proving, and blob DA. Architecture, phasing, and open decisions:
[`PLAN-confidential-token-rollup.md`](../../ops/PLAN-confidential-token-rollup.md).

### Why not a new Groth16 transfer circuit
A Groth16 verifying key is bound to its exact statement, so the finalized mixer
and AMM ceremony keys cannot verify a transfer statement — a transfer circuit
would still need a fresh Phase 2. Tiers A and B reach divisible confidential
transfers with **zero** new ceremony. A bespoke transfer circuit (forking the
AMM `lp_remove` structure + `bjj_pedersen` + the `pot18` Phase 1) remains a
documented future option if synchronous exact amounts are later wanted, but it
is not on the launch path.

---

## 5. Wrapping existing ERC20s

A `TacitConfidentialERC20` is deployed per underlying with a `UNIT_SCALE` that
aligns the fixed ladder (`d_i = 10**i`) to the underlying's decimals, so one
ladder backs tokens of any precision. Its on-chain `decimals` mirrors the
underlying so unwrapped amounts read correctly; `name` / `symbol` describe the
confidential wrapper.
- `wrap(denomIdx, C, pok)` — `transferFrom(d_denomIdx · UNIT_SCALE)` into escrow
  (amount public at entry); create a note opening to `d_denomIdx` (PoK that
  `C − D_denomIdx = r·G`). The amount is visible at the wrap boundary and blinded
  for every transfer thereafter.
- `unwrap(denomIdx, C, to, pok)` — prove the note opens to `d_denomIdx`; release
  `d_denomIdx · UNIT_SCALE` of the ERC20 to `to`; destroy the note. Unwrap is a
  public-denomination op (cheap, no range proof); to move a non-ladder amount,
  split with a §4 transfer first.

Escrow invariant per asset: `escrowed ERC20 ≥ Σ unspent note denominations ·
UNIT_SCALE`, held structurally — wrap is the only mint path and every transfer
conserves. Issuer-administered stablecoins concentrate freezable balance at the
asset contract; the dapp curates which underlyings it surfaces (see plan).

---

## 6. Stealth recipients and cross-chain wallet (free composition)

Note `owner` may be a stealth pubkey derived by the blinded-pubkey commit
`P + b·G` (`SPEC-BLINDED-PUBKEY-AMENDMENT.md`) in its ERC-5564 form
(`stealth_address = address(P + b·G)`), with `b` from the same HMAC derivation
the Bitcoin layer uses. One Tacit wallet seed therefore scans confidential
receipts on **both** chains, and a sender pays a recipient's published meta-
address without an on-chain link between payments. No new derivation, no new
key material — the existing stealth stack, re-homed to EVM addresses.

---

## 7. Soundness (by construction)

- **No inflation.** Tier A: every note amount is a positive ladder denomination
  (OR-proof) and conservation balances the hidden sums, so outputs can neither
  exceed inputs nor be negative. Tier B: the BP+ proofs bound every output to
  `[0, 2⁶⁴)` and the kernel balances the sum, verified in-guest before the
  batch proof is accepted on-chain. Supply ops (§3) move public amounts proven
  to match their note commitments.
- **No double-spend.** Each note's spent-marker is set on use; a second spend
  finds it set.
- **No cross-domain replay.** Every proof binds `chainid` + asset contract +
  operation domain tag, distinct from Bitcoin-layer tags and from the
  `ShieldedPool` withdraw domain.
- **Custody is per-asset.** Escrow ≥ unspent note amounts holds per asset
  contract; wrap/etch are the only issuance paths and each conserves.

---

## 8. What ships first vs. follows

**Launch (no new trusted setup):**
- Factory: `etch` / `petch` / `mint` / `burn` / fixed-supply, wrap / unwrap.
- Blind balances; off-chain balance + range attestation via the existing
  primitive; on-chain attestation anchor event.
- Stealth recipients (§6).
- Tier A denominated confidential transfers.

**Follow-up:**
- Tier B SP1-batched exact-amount transfers (its own news beat; reuses the
  bridge prover discipline).
- Phase-3 cross-chain asset bridging (moving escrow Bitcoin ↔ Ethereum for a
  shared `asset_id`) — the §1 note identity makes it natural; trust surface and
  reverse path get their own plan doc.
- Optional bespoke Groth16 transfer circuit if synchronous exact amounts are
  wanted.

---

## 9. Reference-implementation map

Built (working tree):
- `contracts/src/lib/Secp256k1.sol` — `ecrecover` equation-checker (`mulmuladd`),
  bounded EC add, `verifyLinear` (the §2 primitives). Vectors verified against
  `@noble/secp256k1`.
- `contracts/src/lib/ConfidentialNoteCore.sol` — abstract base: denominated note
  store, spent-set, the Tier-A 2-in/2-out `transfer` (per-output 1-of-8 OR-proof
  + conservation kernel, §4), and the `_verifyOpen` Schnorr PoK. The denomination
  ladder is protocol-wide and fixed (`d_i = 10**i`, points `D_i = d_i·H` baked in
  as pure lookups — no per-token constants to supply or trust), and it carries
  on-chain `name` / `symbol` / `decimals`. Both token variants extend it.
- `contracts/src/TacitConfidentialERC20.sol` — confidential **wrapper** for an
  ERC20: `wrap` / `unwrap` (§3/§5), escrow == Σ active notes · `UNIT_SCALE`
  (constructor arg aligning the fixed ladder to the underlying's decimals).
  9 tests vs real noble proofs. Measured: wrap ~94k, **confidential transfer ~190k**, unwrap ~36k.
- `contracts/src/TacitConfidentialEtched.sol` — **etched** token: supply issued
  as notes, no backing. `mint` (authority or fair-launch / petch window+cap),
  `renounceMint` (fixed supply), `burn`; supply == Σ active notes. 8 tests.
- `contracts/src/TacitConfidentialFactory.sol` — CREATE2 deployer; mode-split
  entrypoints `etchAuthority` / `etchFairLaunch` (no overloaded sentinel),
  each carrying `Meta{ name, symbol, decimals, uri }`, with matching
  `predictAuthority` / `predictFairLaunch`; `tacit-evm-etch-v1` asset-id
  derivation; `Etched` event. 7 tests.

Hardening (done):
- OR-proof challenge binds `"tacit-evm-cnote-or-v1" ‖ chainid ‖ address(this)`,
  so a proof is contract-specific (on top of the kernel already binding the
  transfer as a whole).
- `attest(denomIdx, …)` — on-chain selective balance disclosure: proves the
  caller controls an active note opening to `d_i` (PoK bound to `msg.sender`)
  and emits `Attested(attester, noteId, denomIdx)` for a consumer contract to
  gate on. The off-chain hidden-amount range attestation still uses
  `SPEC-RANGE-PROOF-PRIMITIVE` unchanged.

Follow-up:
- `contracts/sp1/` — batch guest verifying BP+ + kernels for Tier B.
- Dapp: reuse `dapp/bulletproofs.js`, `dapp/bulletproofs-plus.js`,
  `dapp/amm-sigma.js`, the range-proof primitive, and the stealth stack; add
  the EVM note model, OR-note prover, and factory UI.
