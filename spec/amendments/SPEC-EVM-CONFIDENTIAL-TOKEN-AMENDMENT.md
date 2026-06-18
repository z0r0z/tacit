# SPEC Amendment — EVM Confidential Token (Tacit on Ethereum L1)

> **STATUS: DRAFT** (2026-06-06). Defines a confidential-asset factory on
> Ethereum L1 that reuses Tacit's existing secp256k1 cryptography unchanged —
> the same Pedersen commitments, the same NUMS generator
> (`tacit-generator-H-v1`), the same Bulletproofs / Bulletproofs+ range
> tooling, the same range-attestation primitive, and the same blinded-pubkey
> stealth construction. **No new trusted setup** for the launch surface.
>
> **As-built reconciliation (2026-06-12).** The launch surface that actually
> shipped is the **public canonical ERC20 hub** (`CanonicalAssetFactory` +
> `CanonicalBridgedERC20` + `CanonicalMinters`, §3) plus the **SP1-batched
> confidential lane** in `ConfidentialPool` (the Tier-B / rollup direction, §4).
> The in-Solidity, note-based Tier-A construction this draft originally
> specified (`TacitConfidentialFactory` / `TacitConfidentialEtched` /
> `ConfidentialNoteCore` / `Secp256k1.sol`, OR-note transfers) was an experiment
> and was **removed** (commit `5505615`, superseded by
> [`PLAN-confidential-token-rollup.md`](../../ops/PLAN-confidential-token-rollup.md)).
> §3, §4, §8 and §9 are updated to match the tree; the original Tier-A text is
> kept only where marked **SUPERSEDED**, for provenance.
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

## 3. Canonical public ERC20 hub (the shipped launch surface)

The factory is a single CREATE2 deployer for **standard public ERC20s** — the
canonical, tradeable face of a Tacit-native, Bitcoin-bridged, or EVM-etched
asset. Balances are public here (this is the hub Uniswap and wallets see); the
*confidential* face is obtained by wrapping a canonical token into
`ConfidentialPool` (§4). The contracts, all in `contracts/src/`:

- **`CanonicalBridgedERC20`** — a deliberately dumb ERC20. Its constructor takes
  no arguments: it reads `(assetId, minter, symbol, decimals, cid)` back from its
  deployer (the factory's `deployParams()` callback — the Uniswap-V2-pair
  pattern), so the init code is **constant** and the CREATE2 address is a pure
  function of the salt. A single immutable `MINTER` is the sole mint/burn
  authority; `name()` is the constant brand `"Tacit Token"`; `contractURI()`
  reconstructs the metadata CID (below).
- **`CanonicalAssetFactory`** — the CREATE2 deployer. `etchCanonical` (EVM-native
  id, derived from metadata) and `deployCanonical` (externally-derived id — a
  Bitcoin etch or wrapped ERC20) both land a token at
  `predict(assetId, minter, symbol, decimals, cid)`. `deriveAssetId` /
  `verifyMetadata` let anyone recompute the id↔metadata binding on-chain.
- **`CanonicalMinter`** (base) + **`FixedSupplyMinter`** / **`CappedMintMinter`**
  — the supply-policy layer for EVM-native etches (§ "Supply operations" below).
  The policy lives in the minter; the token stays dumb.

### Asset identity
```
etched token:   asset_id = sha256("tacit-evm-etch-v1"  ‖ chainid_be8 ‖ factory ‖ salt ‖ etcher ‖ meta_hash)
wrapped/native: asset_id = sha256("tacit-evm-token-v1" ‖ chainid_be8 ‖ underlying_token)
meta_hash       = sha256( u8(len symbol) ‖ symbol ‖ u8(decimals) ‖ cid )
```
`cid` is a 32-byte IPFS metadata content hash (the CIDv1 **raw** sha2-256 digest of a
logo/description JSON; `0` = none) — for the raw codec the digest is simply
`sha256(metadata JSON bytes)`, so anyone can recompute the `cid` from the JSON with no IPFS
encoder. Bound into `meta_hash` so the id commits to it like `(symbol, decimals)`.
Domain-separated from the Bitcoin `sha256(reveal_txid ‖ vout)` namespace and
from the `ShieldedPool` asset-id rule by tag.

**Canonical ERC20 metadata.** The public ERC20's `name` is the constant brand
`"Tacit Token"` — a Tacit asset carries no trustless on-chain name, so name is a constant
rather than a spoofable or off-chain-sourced field. The per-asset metadata is
`(symbol, decimals, cid)`, all **deterministic to the real asset** — the `cid` points to a
logo/description JSON on IPFS, surfaced via the ERC20's `contractURI()` (EIP-7572) for
wallets, marketplaces, and the dapp:

- **EVM-native etch:** the etched id commits to `(symbol, decimals, cid)` through `meta_hash`,
  so the metadata is canonical *by construction* — the deployer derives the id on-chain
  from the supplied metadata (`CanonicalAssetFactory.deriveAssetId` / `etchCanonical`)
  and anyone can recompute the binding (`verifyMetadata`). Exactly one official
  `(symbol, decimals, cid)` per id.
- **Bitcoin-native etch (e.g. TAC):** `(ticker, decimals, cid)` live on-chain in the reveal
  envelope, transitively bound to the id via the txid (`asset_id = sha256(reveal_txid ‖ 0)`,
  `reveal_txid = double_sha256(reveal_tx)`). The two etch shapes carry the `cid` differently,
  and the SP1 attest_meta proof resolves both to the SAME 32-byte raw-CIDv1 digest. **Neither etch
  carries the cid inline** — both reference their metadata blob (`{name, image, …}` JSON) by an
  **`image_uri`** (an `ipfs://` URI) at the TAIL of the reveal envelope; only the fields between
  `decimals` and that URI differ:
  - **CETCH** (confidential / fixed-supply etch, e.g. TAC) — `… ‖ commitment(33) ‖ amount_ct(8) ‖
    rp_len(2) ‖ rangeproof ‖ mint_authority(32) ‖ img_len(2) ‖ image_uri` (`cetch_image_cid`).
  - **T_PETCH** (permissionless fair-mint etch) — `… ‖ cap(8) ‖ limit(8) ‖ start_h(4) ‖ end_h(4) ‖
    img_len(2) ‖ image_uri` (`petch_image_cid`).

  The guest (`cxfer-core` `bitcoin.rs`) resolves the cid from that URI when it is a raw-codec CIDv1;
  a non-raw / CIDv0 / non-`ipfs://` / path-suffixed URI resolves to `cid = 0` (it could not
  round-trip the base16 form below).

  The bridge proves them once at first mint (the proof's `AssetMeta` carries the `cid`) and the
  canonical ERC20 carries them immutably; `contractURI()` reconstructs `ipfs://f01551220‖hex(cid)`
  (CIDv1 base16: `f` multibase ‖ `01` v1 ‖ `55` raw ‖ `12` sha2-256 ‖ `20` len-32 ‖ cid) and
  emits EIP-7572 `ContractURIUpdated` at deploy. The CID is optional — absent ⇒ `cid = 0` ⇒
  empty `contractURI`.
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

### Supply operations — EVM-native etch
An EVM-native asset is etched by deploying a minter (`CanonicalMinter` subclass),
which in one transaction derives a fresh `tacit-evm-etch-v1` id from the supplied
metadata, deploys (or adopts) its canonical ERC20 at `f(id)`, and becomes that
token's sole `MINTER`:
- **`FixedSupplyMinter`** (the `T_CETCH` analog) — mints the entire supply to a
  recipient in its constructor, then exposes no mint/burn/admin and is inert
  forever, so supply is immutably fixed. A deploy-and-die issuer with no further
  surface.
- **`CappedMintMinter`** (the `T_PETCH` analog) — `MINT_AUTHORITY` may `mint` up
  to a lifetime `CAP` (0 = uncapped) until `MINT_DEADLINE` (0 = open forever);
  any holder may `burn` its own balance (deflationary; `CAP` is a lifetime
  ceiling, burns never reopen room). No owner, no pause, no authority transfer —
  every term is immutable.

These helpers can only ever etch a **fresh EVM-native** id (namespaced by the EVM
etch tag + chainid + factory, disjoint from any Bitcoin asset id) and they set
themselves as `MINTER`, so they can never target — or become the authority for —
a bridged Bitcoin-native asset (whose ERC20 must have the pool/bridge as
`MINTER`). `CanonicalMinter`'s constructor adopts an already-deployed token at its
exact `(id, minter, meta)` slot instead of re-etching, so a permissionless
pre-deploy can't brick the etch.

### Supply operations — bridged & wrapped assets (via `ConfidentialPool`)
A Bitcoin-native or wrapped asset's canonical ERC20 is minted by the pool/bridge,
not a standalone minter — the pool is the backing authority:
- **`registerMintedAuto(factory, tacitAssetId, symbol, tacitDecimals)`** — lazily
  `deployCanonical`s a Tacit-native asset's ERC20 (address = `f(id)`, decimals
  18, pool as `MINTER`) and records the derived `unitScale`. First touch deploys
  + assigns; thereafter it is a remote `mint` against the same CREATE2 address.
- **`registerWrappedAuto(underlying, crossChainLink)`** — symmetric path for
  wrapping an existing ERC20 (reads the underlying's `decimals`, derives
  `unitScale = 10^(decimals − tacitDecimals)`).
- **`_autoRegisterFromMeta`** — the trustless first-mint path: the SP1 guest's
  `OP_ATTEST_META` proves an asset's `(symbol, decimals, cid)` from a confirmed
  Bitcoin etch (B6, §7.1), and on `settle` the pool lazy-deploys + registers the
  canonical ERC20 with the **proven** metadata — no oracle, no manual step. The
  pool's `localAssetOf` first-write-wins keeps a shared id bound to the first
  (real) token, and `canonicalTokenFor(id)` is the authority's source of truth
  for "which ERC20 is canonical" (the factory deploys every variant, impostors
  included, so it deliberately is **not** that oracle).

### Balance attestation & range proofs (confidential lane only, off-chain)
A holder of a *confidential* balance (a note in `ConfidentialPool`, §4 — not a
public canonical-ERC20 balance) proves a predicate over hidden amounts —
`≥ X`, `≤ X`, `∈ [X, Y]`, `> b`, `= X`, and homomorphic sums across notes —
using `SPEC-RANGE-PROOF-PRIMITIVE.md` (`bpRangeAggProve` / `bpRangeAggVerify`)
**unchanged**, because the commitments share the Bitcoin-layer generators. This
is a counterparty-to-counterparty proof and needs no on-chain transaction.

---

## 4. Confidential transfers (the shipped SP1 lane + the superseded in-Solidity tiers)

**As-built:** the confidential face of a canonical asset is obtained by wrapping
it into **`ConfidentialPool`**, whose SP1 guest validates wrap / transfer /
unwrap / swap / LP / mint / burn as batched state transitions over secp256k1
notes (the Tier-B / rollup direction below). That is the lane that shipped and is
on-chain; its normative guest bindings are §7.1 (B1–B6) and its rollup design is
[`PLAN-confidential-token-rollup.md`](../../ops/PLAN-confidential-token-rollup.md).
The **in-Solidity Tier-A OR-note transfer** described next was an experiment and
was **removed** (commit `5505615`); the text is retained, marked **SUPERSEDED**,
for provenance only.

A divisible transfer splits notes into payment + change with **hidden** output
amounts, so it requires non-negativity (range) enforcement, and because the
contract holds escrow the **contract** must enforce it. Conservation is the
Mimblewimble-style kernel: `Σ C_in − Σ C_out − fee·H = excess·G` with a Schnorr
signature under `excess`.

### Tier A — denominated OR-notes (SUPERSEDED — removed in commit `5505615`)
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

### Tier B — SP1-batched secp256k1 notes (the shipped lane: `ConfidentialPool`)
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

**As-built:** wrapping is a path of the shipped SP1 lane, not a standalone
contract. `ConfidentialPool.registerWrappedAuto(underlying, crossChainLink)`
registers an existing ERC20 with a derived `unitScale` (it escrows on `wrap` and
releases on `unwrap`); the amount is public at the wrap boundary and blinded
thereafter, with non-negativity enforced in the guest (§4 / §7.1), not by an
in-Solidity OR-note ladder. The per-underlying `TacitConfidentialERC20` + fixed
`UNIT_SCALE` ladder described below is **SUPERSEDED** (removed in commit
`5505615`); retained for provenance.

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

> The Tier-A clauses below pertain to the superseded in-Solidity OR-note design
> (§4); the **live** soundness invariants for the shipped lane are §7.1 (B1–B6),
> enforced by the `ConfidentialPool` SP1 guest.

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

### 7.1 Guest validity bindings (NORMATIVE — the SP1 guest MUST enforce all)

"By construction" above holds only if the guest enforces these bindings; they are
the load-bearing checks (the contract sees only hashes/amounts and cannot backstop
the value/nullifier ones). Each is required before any proof is accepted:

- **B1 — wrap value↔escrow.** For every `wrap`, assert `value · unitScale == amount`
  (`value` = the note's committed u64; `amount` = the escrowed underlying, u256).
  `unitScale` is NOT a free witness: the deposit id binds the SCALED `value` —
  `deposit_id = keccak(asset ‖ value ‖ commit)`, `commit = keccak(Cx ‖ Cy ‖ owner)`
  (`value` as a 32-byte big-endian word) — which the contract re-derives as
  `value = amount / assets[assetId].unitScale` with the asset's trusted scale, so a matching
  id forces `value·unitScale == amount` (the guest never sees `unitScale`). Compute
  `value·unitScale` in ≥u128 (can exceed u64). The commit DIGEST — not the raw `(Cx, Cy, owner)`
  — is what `wrap` takes in calldata, so a deposit note's `ν = keccak(Cx ‖ Cy ‖ "spent")` is never
  publicly computable from on-chain data (deposit→spend stays unlinkable) and the static `owner`
  cannot cluster a wallet's deposits.
- **B2 — unwrap payout↔value.** For every `unwrap`/withdrawal the guest emits the proven
  in-system `value`; the contract pays `amount = value · assets[assetId].unitScale` with the
  asset's trusted stored scale (the withdrawal carries `value`, NOT `unitScale` — the guest
  never sees it). An escrow asset's payout is additionally escrow-bounded.
- **B3 — note-bound nullifier.** `ν = keccak256(Cx ‖ Cy ‖ "spent")` where `(Cx,Cy)` is
  the membership-proven commitment — unique per note, chain-independent (same secp `C`
  on both chains, so the cross-lane gate matches), and private (`C` is known only to the
  owner who decrypts the memo). The note secret is NOT the nullifier preimage.
  Reconciles dapp + guest + worker, which all derive `ν` this way.
- **B4 — mandatory cross-lane gate + source-consume invariant.** If ANY spent input's
  membership root is a relay-attested Bitcoin root (`knownBitcoinRoot`), the guest MUST use a
  non-zero, current `bitcoinSpentRoot` and prove non-membership of every input `ν` against it;
  the contract MUST enforce `bitcoinSpentRoot == knownBitcoinSpentRoot` for that lane
  (no skip-on-zero). Reflection is one-directional (Bitcoin→Ethereum), so this gate alone is not
  sufficient for a value-exit: a Bitcoin-homed note's `ν` marked only in the Ethereum set is never
  reflected back, leaving the Bitcoin UTXO live. Therefore a Bitcoin-homed batch MUST NOT move
  value onto Ethereum — the contract rejects any `withdrawal`/`fee`/`leaf`/`swap`/`liquidity` from a
  Bitcoin-homed spend (`BtcHomedValueExitMustBridge`); such a batch may only mark nullifiers.
  Bitcoin→Ethereum value movement goes through the source-consuming path — `bridge_burn` on Bitcoin
  (into the reflected burn set) → `bridge_mint` here (B5), which is not Bitcoin-homed. A direct
  single-tx fast lane requires a finality-gated shared nullifier set (the reverse path of §8) — until
  then, symmetric forward reflection would still permit a double-spend within the mutual reflection lag.
- **B5 — relay-anchored bridge_mint (bridge-burn-set membership).** A `bridge_mint` MUST prove
  the burned note was BURNED FOR THE BRIDGE on Bitcoin — `ν` is a MEMBER of the relay-attested
  Bitcoin bridge-BURN set, keyed `ν → destCommitment` (`imt_membership(ν, bitcoinBurnRoot)`, the
  burn-leaf value pinning THIS Ethereum destination), with the contract enforcing
  `bitcoinBurnRoot == knownBitcoinBurnRoot` (current, non-zero) for that op. The burn set is
  built ONLY from cross-chain burns, so an ordinary Bitcoin spend's `ν` is ABSENT and cannot mint
  — this is the H-1 fix; authorizing against the all-spends set instead would let any ordinary
  spend be re-minted on Ethereum (value duplication). The burned note's pool membership is proven
  against a `knownBitcoinRoot`. The block PoW is NOT validated against a self-supplied `nBits` — a
  fabricated min-difficulty header is forgeable, so block self-PoW is no gate. Conservation
  (`v_mint == v_burn`) requires knowledge of the burned note's blinding, so only the owner can
  mint; the contract gates one mint PER BURNED `ν` (`bridgeMinted[ν]`), so a burn mints to exactly
  one destination, once. The bridge-burn set is the cross-lane authority — DISTINCT from B4's
  spent set (an ordinary spend marks the spent set but NOT the burn set), which is exactly what
  keeps a non-bridge spend unmintable. See `PLAN-confidential-cross-chain.md` §4/§5/§8.
- **B6 — confirmation-gated metadata.** An `attest_meta` MUST prove the asset is real on
  the relay-attested Bitcoin pool, not just self-derive from a raw reveal tx: alongside
  `asset_id = sha256(reveal_txid ‖ 0)` and the envelope's `(ticker, decimals)`, the guest
  MUST verify a note keyed by THAT `asset_id` is a member of a Bitcoin pool root and commit
  the root in `bitcoinRootsUsed` (which the contract already gates `∈ knownBitcoinRoot`).
  A fabricated or unconfirmed etch has no member note, so it cannot lazy-register junk
  metadata / deploy a junk canonical ERC20 — reusing the bridge_mint root gate, so no
  contract change.

All guest-side bindings (B1–B6) batch into one guest version → one new vkey → one
re-prove + redeploy. The on-chain pieces (deposit-id/withdrawal `unitScale`, the
mandatory cross-lane enforcement) ship in the same `ConfidentialPool` redeploy.

---

## 8. What shipped vs. follows

**Shipped:**
- Canonical public ERC20 hub: `CanonicalAssetFactory` (`etchCanonical` /
  `deployCanonical` / `deriveAssetId` / `verifyMetadata` / `predict`),
  `CanonicalBridgedERC20` (constant `name`, `contractURI`), and the
  `CanonicalMinter` family (`FixedSupplyMinter` / `CappedMintMinter`). §3.
- Trustless metadata: id↔`(symbol, decimals, cid)` binding (EVM-etch by
  construction; Bitcoin-etch SP1-proven at first mint, B6), `contractURI`
  (EIP-7572, raw-codec CIDv1), decimals harmonization (`unitScale`).
- Confidential lane in `ConfidentialPool`: SP1-validated wrap / transfer /
  unwrap / swap / LP / mint / burn over secp256k1 notes, with the §7.1 (B1–B6)
  guest bindings and the cross-lane / bridge-mint gates.
- Stealth recipients (§6).

**Follow-up:**
- Phase-3 cross-chain asset bridging (moving escrow Bitcoin ↔ Ethereum for a
  shared `asset_id`) — the §1 note identity makes it natural; trust surface and
  reverse path get their own plan doc.
- Optional bespoke Groth16 transfer circuit if synchronous exact amounts are
  later wanted.

**Superseded / removed (commit `5505615`):**
- The in-Solidity Tier-A OR-note token (`TacitConfidentialFactory` /
  `TacitConfidentialEtched` / `ConfidentialNoteCore` / `Secp256k1.sol`), in
  favor of the SP1 lane above.

---

## 9. Reference-implementation map (as-built)

Public canonical ERC20 hub (`contracts/src/`):
- `CanonicalBridgedERC20.sol` — the dumb ERC20: arg-less constructor reads
  `(assetId, minter, symbol, decimals, cid)` from the factory callback (constant
  init code ⇒ CREATE2 address = `f(salt)`); single immutable `MINTER`; constant
  `name() = "Tacit Token"`; `contractURI()` reconstructs
  `ipfs://f01551220‖hex(cid)` (EIP-7572, CIDv1 **raw** codec; empty when cid = 0).
- `CanonicalAssetFactory.sol` — CREATE2 deployer. `etchCanonical` (EVM-native id
  derived from metadata) / `deployCanonical` (externally-derived id);
  `metaHash = sha256(u8(len symbol)‖symbol‖u8(decimals)‖cid)`;
  `deriveAssetId = sha256("tacit-evm-etch-v1"‖chainid_be8‖factory‖salt‖etcher‖meta_hash)`;
  `verifyMetadata` / `predict` / `tokenOf` (the salt binds the full metadata
  incl. `cid`; no-metadata overloads for cid = 0).
- `CanonicalMinters.sol` — `CanonicalMinter` base (etch-or-adopt, sets itself as
  `MINTER`) + `FixedSupplyMinter` (T_CETCH analog) + `CappedMintMinter` (T_PETCH
  analog).

Confidential lane:
- `contracts/src/ConfidentialPool.sol` — wraps a canonical token into a
  note-based confidential balance; SP1-validated `settle`; `registerMintedAuto` /
  `registerWrappedAuto` / `_autoRegisterFromMeta` (trustless first-mint via the
  guest's `OP_ATTEST_META`); `unitScale` decimals harmonization;
  `canonicalTokenFor` resolution. Guest in `contracts/sp1/confidential/`
  (`cxfer-core`); normative bindings §7.1 (B1–B6).

Cross-language metadata KATs:
- `tests/confidential-canonical-asset-id.mjs` — `metaHash` / `deriveAssetId` /
  `contractURI` / `metadataCid` mirror of the Solidity, with pinned KATs
  (contractURI raw-codec CIDv1; `metadataCid = sha256(json)` verified against
  kubo `ipfs add --cid-version=1`).
- `scripts/pin-asset-metadata.mjs` — canonical metadata JSON → raw-codec `cid`
  pipeline (rejects a non-raw pin).

Removed (commit `5505615`, superseded by the SP1 lane — see
[`PLAN-confidential-token-rollup.md`](../../ops/PLAN-confidential-token-rollup.md)):
`Secp256k1.sol`, `ConfidentialNoteCore.sol`, `TacitConfidentialERC20.sol`,
`TacitConfidentialEtched.sol`, `TacitConfidentialFactory.sol`.
