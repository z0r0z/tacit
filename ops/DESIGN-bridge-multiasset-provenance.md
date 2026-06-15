# Bridge provenance through multi-asset ops (swap / LP / OTC / bid)

Companion to ops/DESIGN-trustless-asset-onboarding.md. Closes a **completeness** gap (not a
soundness gap) in the BTC→ETH bridge: a Tacit asset note whose Bitcoin-side lineage passes through
a multi-asset op cannot yet bridge, even though it descends from real supply.

## The gap

The forward bridge proves a burned note is real supply by walking a per-bridge provenance DAG of
**conserving steps** back to a valid leaf (the etch `C_0`, or an issuer-authorized cmint). A step is
verified purely by Bitcoin inclusion + **single-asset conservation** + linkage — the
`ProvenanceWitness` carries no op-type; it just needs, for the asset `X`,
`Σ C_in_X = burned·H + Σ C_out_X`, proven by one BIP-340 kernel signature under the
`tacit-kernel-v1` domain (CXFER ⇒ `burned = 0`; CBURN ⇒ `burned > 0`, public).

A multi-asset op (AMM swap, LP add/remove, OTC, orderbook bid fill) touches two or more assets in one
transaction. Per asset it still **conserves** — a swap moves `X` between the pool and the user, an LP
add/remove moves `X` between the LP and the pool, an OTC/bid moves `X` between counterparties; nothing
creates or destroys `X` (only CMINT issues and CBURN destroys, both explicit). But the op's
conservation proof lives under a **different domain tag** than `tacit-kernel-v1`, so the walk does not
recognize the step, and a note received from such an op cannot be traced.

Result today: a note only ever **transferred** (CXFER) or **burned** (CBURN) from the supply bridges;
a note **received from a swap / LP redeem / OTC / bid fill** does not. The non-bridgeable note is
safely **rejected** (the walk fails closed) — never wrongly minted — so this is purely completeness.

## The unifying invariant

Every Tacit confidential op conserves each asset it touches. Issuance (CMINT) and destruction (CBURN)
are the only exceptions, and both are explicit and public. So the bridge does not need to understand
what an op *is* — only that, for the bridged asset, the op presents a verifiable
`Σ C_in_X = burned·H + Σ C_out_X` across the step, with linkage. This is already the shape of the
provenance step; the walk is op-agnostic by design.

## Audit findings (2026-06-15)

The Bitcoin-side ops are **BIP-340 Schnorr kernels + Bulletproofs+** — there is **no trusted-setup
circuit**, so no public (MPC) ceremony is involved in any of this. The per-asset conservation proofs
**already exist on-chain**, under per-op domains:

| op | opcode | conservation proof on-chain |
|----|--------|-----------------------------|
| CXFER | 0x22/0x23 | `tacit-kernel-v1`, single asset (the walk verifies this today) |
| CBURN | (cxfer w/ burn) | `tacit-kernel-v1` with public `burned` (the CBURN follow-up) |
| T_LP_ADD | 0x2D | `tacit-amm-lp-add-v1` — **one kernel sig per asset side**, `Σ C_in_X − delta_X·H = excess·G` |
| T_LP_REMOVE | 0x2E | `tacit-amm-lp-remove-v1` — share side; the underlying-out side per the reserve update |
| T_SWAP_VAR | 0x32 | Pedersen + BP+ (m=2) + kernel sig, `tacit-amm-swap-var-v1` |
| T_SWAP_ROUTE | — | already `tacit-kernel-v1` (per-hop) |
| T_PREAUTH_BID_VAR | 0x5C | `tacit-preauth-bid-var-*` context/kernel |

So the gap is narrow: the walk recognizes only the `tacit-kernel-v1` domain. The fix is to verify the
per-asset conservation kernel **under each op's domain**, reading proofs already in the transactions.

## Design — the asset-scoped conservation kernel

Treat per-asset conservation as one first-class primitive — an **asset-scoped kernel**: for a given
asset `X` and a Bitcoin tx, a BIP-340 signature over the message binding `X` and the **complete** set
of `X` input/output commitments in that tx, with verify key `(Σ C_in_X − burned·H − Σ C_out_X).x_only`
(i.e. the residue is a pure `G`-term ⇒ no `H` component ⇒ `X` value conserved across the step). CXFER
and CBURN already are exactly this. Every multi-asset op already emits the same shape per asset.

The provenance walk then composes **any** step that presents a valid asset-scoped kernel + linkage,
with CMINT/CBURN as the only leaf/destruction cases. It does not branch on op semantics
(constant-product, order matching, share math) — those are orthogonal to value conservation and
irrelevant to the bridge.

**Future-proofing.** A new op (a new AMM curve, a new orderbook format) is bridge-walkable the day it
ships, as long as it emits an asset-scoped conservation kernel for each asset it moves. The bridge
becomes a property — *if the op conserves the asset, the asset bridges through it* — not a per-op
integration.

## Soundness

The asset-scoped kernel preserves the same guarantees as the CXFER kernel:

- **No value created/destroyed.** A valid Schnorr sig over the residue proves it has no `H` component,
  so `Σ v_in_X = burned + Σ v_out_X` for the step (`burned` public, kernel-bound, so it cannot be
  understated — same argument as the CBURN follow-up).
- **Completeness of the asset subset.** The kernel must bind the **entire** set of `X` commitments in
  the tx, so a step cannot be presented with an `X` input omitted to fake conservation.
- **Asset binding.** The existing asset-preservation gate (a step's asset == the envelope's asset)
  carries over, so another asset cannot be relabeled as `X`.
- **Linkage + inclusion.** Unchanged — the step's commitments are the tx's real commitments
  (merkle-included against the relay-anchored header), and the produced output links to the next
  step's input by commitment hash.

The walk stays fail-closed: a step lacking a valid asset-scoped kernel folds nothing (skip-not-panic),
so the gap can only ever *under*-admit (a real note that can't yet bridge), never over-admit.

## Cost — guest change + re-prove, no ceremony

1. **cxfer-core / reflection guest** — generalize the provenance step from "single-asset CXFER/CBURN"
   to "asset-scoped conserving step": verify the per-asset conservation kernel under the op's domain
   (a small domain multiplexer), binding the complete `X` in/out subset. `verify_cxfers` already does
   inclusion + conservation + linkage op-agnostically.
2. **JS mirror** — extend `burn-deposit-provenance.js` with the per-op kernel verification, byte-equal
   to the guest (the `confidential-pool.js` kernel verify already generalizes via the `burned`/domain
   parameters).
3. **Generator + native-exec** — add a multi-asset-step fixture (a swap-output note bridging) and the
   positive/negative pair, validated in execute mode exactly as the CBURN follow-up was.
4. **Re-prove** — rotates `BITCOIN_RELAY_VKEY` (the mechanical box step). This is the only "ceremony"
   involved; there is no MPC / trusted setup, because the ops are Schnorr + BP+.

## Per-op reality — RESOLVED 2026-06-15 (the generalization is NOT uniform)

A code read of the actual Bitcoin op wire formats splits the ops into two classes, which the
"asset-scoped kernel" framing above only covers for ONE of them:

- **Confidential 2-party ops — OTC, bid (`T_PREAUTH_BID_VAR`).** Outputs are Pedersen commitments bound
  by opening sigmas; value + blinding stay hidden. The asset-scoped conservation kernel applies directly:
  the op-builder (who knows the per-asset excess) signs the X-subset conservation, the walk verifies it,
  the note bridges. **This is the implementable track.**
- **Public-reserve AMM ops — `T_SWAP_VAR`, `T_LP_ADD/REMOVE`.** The wire carries the reserves as PUBLIC
  u64 (`R_A_pre`, `R_B_pre`) and the swap output as a PUBLIC-value receipt (`delta_out` u64 + `r_receipt`
  in cleartext). A swap receipt is therefore a public-value note minted from the public pool reserve, and
  its realness to `C_0` is the pool's reserve lineage (LP-adds that descend from `C_0`, minus prior
  swaps/removes) — a **pool-level provenance**, NOT a per-asset Pedersen-kernel step. The asset-scoped
  kernel does NOT capture this; a swap/LP-sourced note needs a distinct treatment that proves the receipt
  is backed by the pool's `C_0`-descended reserve. Bigger, separate design — do not force it into the
  kernel walk.

**Correction (2026-06-15, after checking `T_SWAP_BATCH 0x2F`):** there is a THIRD class, and it breaks the
two-track framing. `T_SWAP_BATCH` is the **confidential** Bitcoin AMM swap — N intents at one uniform
clearing price, **per-trader amounts hidden**, only net `(Δa_net, Δb_net)` public, enforced by a
**BabyJubJub + BN254 Groth16 circuit (ceremony-gated)**. AMM.md states plainly that the **CXFER/asset-scoped
kernel does NOT fit** it: that kernel needs *public* in/out amounts to build the verify key, and
`T_SWAP_BATCH` hides them. (This also corrects an earlier audit claim that the AMM ops are ceremony-free
Schnorr+BP+ — `T_SWAP_VAR` is, but `T_SWAP_BATCH` is a trusted-setup Groth16 circuit.)

**Scope (do not conflate the lanes).** The forward bridge proves a **Bitcoin** note descends from `C_0`, so
the provenance walk only ever encounters **Bitcoin-side** ops. The EVM `OP_SWAP`/`OP_OTC`/`OP_BID` (the
ConfidentialPool settle ops, opening-sigma confidential) are **Ethereum-side** — they produce post-bridge
Ethereum notes and are NOT in the forward provenance. (An earlier draft's "asset-scoped kernel for OTC/bid"
mistakenly leaned on those EVM ops; the relevant ops are the Bitcoin ones below.)

**Bitcoin-side multi-asset ops — three classes, each a distinct provenance treatment:**
- **(A) Public-amount, per-asset Schnorr kernel — `T_CXFER`, `T_CBURN`.** The asset-scoped kernel (= the
  existing `verify_cxfer_conservation` shape) applies; **done**. No *other* Bitcoin multi-asset op qualifies —
  they all either expose public reserves (B) or hide amounts in a circuit (C), so there is **no quick
  asset-scoped-kernel win beyond CXFER/CBURN**.
- **(B) Public-reserve AMM — `T_SWAP_VAR`, `T_LP_ADD/REMOVE`.** Public-value receipts; provenance is the
  pool's `C_0`-rooted reserve lineage. Its own design.
- **(C) Confidential circuit ops — `T_SWAP_BATCH` (`0x2F`, BabyJubJub+BN254 Groth16) and the Bitcoin
  orderbook `T_PREAUTH_BID_VAR` (BJJ cross-curve sigmas).** Per-asset conservation is enforced *inside the
  circuit*, not by a public-amount Schnorr kernel (AMM.md: the CXFER mechanism doesn't fit). The natural walk
  is to **recursively verify the op's proof** inside the reflection guest (the `verify_sp1_proof` machinery
  Mode-B already uses) so the output note inherits the proven conservation — OR rely on the public net-deltas
  + the on-chain curve-floor identity the indexer checks. Its own design.

Net: there is **no single asset-scoped-kernel generalization** across the multi-asset ops, and the only class
that drops into the existing kernel walk (A) is already done. B needs reserve-lineage provenance; C needs
batch-proof recursion. The uniform implementation was correctly not attempted — it would have been unsound.

## Track B design (2026-06-15) — public-value reserve lineage (TRACTABLE, no new crypto)

Scoping the reflection guest (`ScanReflection` + `burn_deposit::verify_provenance_leaves`) shows Track B is
simpler than "a separate Pedersen-kernel design": the AMM ops' values are **public**, so per-asset
conservation is **arithmetic**, not a Schnorr kernel.

A `T_SWAP_VAR` of `Y_in` for `X_out` against pool `(R_X, R_Y)` is, per asset:
- asset X: pool note `R_X_pre` → pool note `R_X_post` + user note `X_out`, with `R_X_pre = R_X_post + X_out`;
- asset Y: user note `Y_in` + pool note `R_Y_pre` → pool note `R_Y_post`, with `Y_in + R_Y_pre = R_Y_post`.

All four reserve quantities and `X_out` are **public u64** on the wire (the receipt's `r_receipt` is cleartext,
so the user note opens publicly). So the user's `X_out` note descends from the pool's pre-swap `R_X_pre` note
by a step the walk verifies with **public arithmetic** — no kernel, no sigma. `R_X_pre` traces back through
prior swaps / `T_LP_ADD`s to `POOL_INIT`, whose seed reserves came from the founder's deposit, which the
existing provenance walk already roots at `C_0`.

**Impl shape (reflection guest, rotates `BITCOIN_RELAY_VKEY`):** maintain a per-pool reserve-provenance
component in `ScanReflection` — the current `(R_A, R_B)` and a `c0_backed` flag, handed/resumed like the live
set. A pool becomes `c0_backed` when every `T_LP_ADD` input note is provenance-verified to `C_0` (reusing
`verify_provenance_leaves`). Folding a `T_SWAP_VAR` / `T_LP_REMOVE` against a `c0_backed` pool: check the
public conservation identity, advance the reserves, and **onboard the user's output note as real** (the
`fold_note_append` path the burn-deposit onboarding already uses) so a later `OP_BRIDGE_MINT` binds
`v_mint == v_burn`. Fail-closed: a pool not yet `c0_backed`, or a swap whose public arithmetic doesn't
balance, onboards nothing (skip-not-panic) — completeness only, never over-mint. JS mirror in
`burn-deposit-provenance.js` + a swap-output-bridges fixture, exactly as CXFER/CBURN were validated.

This is the common-case AMM path and needs no new cryptographic primitive — only the per-pool public-reserve
lineage state + the arithmetic conservation gate. It rides the launch re-prove with the adaptor ops + Track C.

## Per-op kernel mapping (the implementation specifics to nail down)

The one thing to pin per op: which on-chain kernel signs the **output** side the bridge needs (the
user-facing note the holder would later bridge), versus the input side. LP-add signs the inputs
(`Σ C_in_X − delta_X·H`); a swap/redeem/fill produces a user-facing `X` output, so the walk needs the
conservation tying that output to the consumed pool/counterparty `X` (the reserve-update / receipt
side). For each op, confirm the on-chain proof already binds the output side's conservation; where it
binds only one side, the other follows from the reserve/settlement accounting the op already proves —
surface whichever the walk can verify directly. This mapping is the bulk of the work; the walk
generalization (1) and the soundness argument are uniform across ops.
