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

### Track B is NOT uniform across the AMM ops — the public-value binding is the line (2026-06-15)

Implementing the folds surfaced a sharp split *within* the AMM ops, decided by whether a withdrawn note's
value is **publicly bound** to the reserve change:

- **`T_SWAP_VAR` — soundly onboardable (DONE).** The receipt carries a CLEARTEXT `r_receipt`, so
  `verify_pedersen_opening(C_receipt, delta_out, r_receipt)` binds the onboarded note's value to the public
  `delta_out`. No inflation: the reflection onboards a note worth exactly the reserve decrease.
- **`T_LP_ADD` / POOL_INIT — soundly onboardable (DONE).** Per-asset secp kernel
  (`Σ C_in_X − delta_X·H = excess·G`) binds the LP's *contribution* to the public `delta_X`; reserves are
  credited from real inputs. (It onboards no withdrawal note — only advances reserve provenance.)
- **`T_LP_REMOVE` — soundly onboardable via a witnessed opening (DONE).** The withdrawn notes are
  `recv_X_C_secp(33) ‖ recv_X_C_BJJ(32) ‖ xcurve_sigma(169)`; `verifyXCurve` binds `secp ↔ BJJ` but takes no
  public delta, so the BJJ/XCURVE machinery alone does NOT tie `recv_X_C_secp`'s value to the public
  `delta_X`. The resolution does **not** need that machinery at all: `delta_X` is **already public** in the
  envelope, so `fold_lp_remove` binds the withdrawn note to it with a **reflection-witnessed blinding**
  `r_recv_X` — `verify_pedersen_opening(recv_X_C_secp, delta_X, r_recv_X)` proves the note's value is exactly
  the reserve decrease. `r_recv_X` is a private witness (never in PublicValues) and `delta_X` was already
  public, so this leaks nothing and preserves the note's forward-spend privacy. Soundness rests on three
  checks: the **share-burn kernel** (anti-theft — only a real shareholder withdraws), the **proportional**
  `delta_X = floor(R_X·share/S)` (keeps the reflection's reserves in lockstep with the worker, so an
  over-withdrawal that drains the pool is rejected), and the **opening** (value == reserve decrease).
  `total_shares` is now tracked in `PoolReserveState` (POOL_INIT seeds `isqrt(Δa·Δb)`, LP-add adds
  `lp_add_shares`). Shipped + KAT'd; bridges with the launch bundle.

### The generalization — one conservation kernel for every secp op (2026-06-16)

Implementing all four ops surfaced that they are the SAME statement. Per asset, every Tacit value-moving op
proves `Σ C_in − Σ C_out − net·H = excess·G` — the hidden commitments net to a PUBLIC quantity `net` with no
extra `H`-term, `excess` the signing key, the verify key the residue's x-only. They differ ONLY in the
message and in what `net` is:

| op | `in` | `out` | `net` |
|----|------|-------|-------|
| CXFER / CBURN | inputs | outputs | `burned` |
| `T_SWAP_VAR` | `[C_in]` | `[C_change]` | `delta_in + tip` |
| `T_LP_ADD` / POOL_INIT | LP inputs (per side) | `[]` | `delta_X` |
| `T_LP_REMOVE` | LP-share notes | `[]` | `share_amount` |

So there is ONE primitive — `asset_scoped_kernel_verify(msg, in, out, net, sig)` — and the per-op wrappers
(`swap_var_kernel_verify`, `lp_add_kernel_verify`, `lp_remove_kernel_verify`) just build their domain message
and delegate. The pool reserve is a public-value note in `PoolReserveSet`; a public-value output (the
`T_SWAP_VAR` receipt, an LP-remove withdrawal) is bound to its public `delta` by a Pedersen opening (cleartext
for the swap, reflection-witnessed for LP-remove). The reflection's whole conservation surface is now: this one
kernel + the public-reserve registry. A future conserving op is bridge-walkable the day it ships as long as it
emits this kernel — the bridge became a property, not a per-op integration.

### `T_SWAP_BATCH` (0x2F) — the one op the generalization only half-covers

The batch's AGGREGATE conservation IS this kernel: the worker's "aggregate Pedersen identity (per asset A and
B)" is exactly `Σ C_in − Σ C_out = net·H` on the batch's net deltas. What the generalized kernel does NOT give
is the per-receipt SPLIT: per-trader amounts are hidden (BabyJubJub Pedersen), and only the **BN254 Groth16**
clearing proof binds each receipt to its correct share. Without it, a trader could over-state their receipt
inside a still-aggregate-conserving batch → onboard more than their share → inflation if only they bridge. So
onboarding a batch receipt soundly needs, in the reflection guest: (1) the aggregate kernel (have it) + the
net-delta reserve update; (2) **BN254 Groth16 verification in-zkVM** (pairing-heavy; SP1 has BN254
precompiles) with the ceremony `vk` baked in, to validate the per-receipt split; (3) a per-receipt witnessed
opening (the LP-remove shape) to bind each onboarded note to its cleared amount.

**Decision (2026-06-16): implement it for feature completion** — TAC must be bridgeable day-one no matter how
it was received, including the confidential AMM. The BN254-Groth16-in-zkVM is the single hard dependency (the
aggregate + the per-receipt openings reuse the generalized machinery). It is gated by the Phase-2 ceremony
`vk` (no live batch txs exist until then), so it can land in the same coordinated re-prove without blocking
the other ops, which are already sound. Scope: ops/DESIGN-in-guest-groth16-verifier.md — the general BN254
snarkjs-Groth16 verifier is buildable now; only the circuit-specific public-input layout + the baked vk wait
on the ceremony.

## Stuck notes, healing, and the fungibility relief valve (2026-06-16)

Why does the *lineage op* matter for bridging a *fungible* asset? Because the bridge is **note-based, not
balance-based**: it mints on Ethereum exactly the value of a SPECIFIC Bitcoin note, proven real (descends
from C₀). Fungibility means the *holder* is indifferent to which note they hold; the *bridge* is not — it
must verify the specific note, or a phantom mints unbacked value. So realness is per-note, and a note whose
lineage runs through an op the reflection can't verify is **fail-closed: non-bridgeable** (but still a valid,
spendable Bitcoin note — the validator/worker track it; only the bridge won't onboard it).

Healing a stuck note — three routes, and one subtlety:
1. **Support the op (the permanent fix).** Conservation-gating makes this cheap: a one-line opcode-allowlist
   + a mechanical re-prove un-sticks ALL such notes at once (the conservation gate is the safety, so the new
   op needs no bespoke audit).
2. **The fungibility relief valve — via a NON-Tacit intermediary (sats), NOT a direct Tacit trade.** Subtle:
   a direct Tacit-asset trade (OTC/swap of the stuck note for a fresh one) does NOT heal — the stuck note is
   an INPUT to that conserving op, and the reflection can't verify its value (unsupported lineage), so the op
   fails-closed and the fresh output isn't onboarded either (the stuck input *poisons* any conserving op it
   feeds). The heal must break the conservation chain: sell the stuck note for **sats** (native BTC — outside
   the Tacit note graph), then buy a FRESH note (clean lineage — e.g. from an ETH→BTC crossout or a clean
   holder). The holder ends with a bridgeable note; the stuck note circulates among Bitcoin-native (non-
   bridging) holders. Works wherever the asset is liquid (TAC); thin for illiquid assets → route 1 is the
   robust fix.
3. **Self-describing conservation envelope (the asymptote).** With a uniform `tacit-conserve-v1` wrapper, the
   reflection bridges ANY conserving op with no per-op parser / no re-prove — so "unsupported" collapses to
   "non-conserving," which is correctly non-bridgeable anyway.

Is the opcode universe large? No — it's SPEC-curated (~40 ops, additions are deliberate amendments), and
conservation-gating makes each new conserving op a one-line + mechanical-re-prove add. With the coverage now
built (transfer/atomic/OTC/bid/swap/LP/farm-reward), there are **no stuck notes for any live flow**; the
"unsupported op" risk is a tail concern, covered by routes 1–3.

## Complete coverage map + future-proofing (2026-06-16)

Every way a holding can arrive, and its bridge treatment. The principle: **bridge-onboarding is a
CONSERVATION property** — `asset_scoped_kernel_verify` (or the public-reserve arithmetic) gates realness;
the opcode only selects the wire layout. So the question per op is just "which layout + is it conserving."

| Source | opcodes | treatment | status |
|--------|---------|-----------|--------|
| Transfer / atomic settlement / OTC | CXFER 0x22/0x23, AXFER 0x26/0x37, **BP+ 0x3C/0x3D** | A — cxfer fold | ✅ |
| Orderbook bid (walk-away, exact + partial) | 0x5B / 0x5C | A — cxfer fold (bid branch) | ✅ |
| AMM swap | T_SWAP_VAR 0x32 | B — `fold_swap_var` | ✅ |
| AMM LP add / remove | 0x2D / 0x2E | B — `fold_lp_add` / `fold_lp_remove` | ✅ |
| AMM LP-share onboarding | minted at 0x2D | B — `fold_lp_share_mint` | ✅ |
| AMM multihop route | T_SWAP_ROUTE 0x33 | B — `fold_swap_route` (value-chained across hops) | ✅ |
| Farm init / rewards | T_FARM_INIT 0x34 / T_LP_HARVEST 0x3B | B — `fold_farm_init` / `fold_harvest` (treasury reserve) | ✅ |
| Farm refund (launcher reclaim) | T_FARM_REFUND 0x3E | B — treasury draw-down (sibling of harvest) | ⛳ gap |
| AMM protocol-fee claim | T_PROTOCOL_FEE_CLAIM 0x31 | B — mints an LP-share note, bound to public `protocol_fee_accrued` | ⛳ gap (needs the accrued accumulator in the registry) |
| Confidential batch swap | T_SWAP_BATCH 0x2F | C — Groth16 ✅ + parser ✅ + BabyJubJub xcurve ✅ + aggregate Pedersen identity ✅ + `fold_swap_batch` (123-signal re-derivation + onboarding, type-checked vs the real crates) | 🔨 end-to-end validation (full envelope+proof vector / box-prove) remains |
| Issuance (mint / drop claim) | T_MINT/PMINT/DCLAIM | cmint-deposit path (issuer-authorized) | ✅ |
| cBTC.zk lock / slots | 0x66, T_SLOT_* | cBTC-specific folds | partial |

NB: there is no `T_FARM_BOND`/`T_FARM_UNBOND` opcode (the worker op table has only init 0x34 / harvest 0x3B / refund 0x3E) — staking an LP-share into a farm moves an already-onboarded, already-bridgeable LP-share note, so it needs no fold of its own.

**Farm rewards + multihop route — DONE (2026-06-16).** `T_LP_HARVEST` mints a reward note at vout[1] with a
PUBLIC `reward_amount` + cleartext `reward_r`, drawn from `farm.treasury_remaining` — a treasury funded at
`T_FARM_INIT` by the launcher's real reward-asset inputs (same shape as an AMM pool reserve). Shipped as the
farm-treasury registry + `fold_farm_init` (launcher's live inputs ⇒ c0_backed treasury) + `fold_harvest`
(reward note opens to the public `reward_amount` ≤ treasury, onboard, draw down). Multihop `T_SWAP_ROUTE` is N
chained swaps; `fold_swap_route` threads a VALUE CHAIN — hop 0's input is kernel-bound to the trader's real
spent note, each later hop's `(input asset, amount)` must equal the prior hop's output (no value conjured
between pools), every pool pays out ≤ its reserve, and the single final receipt opens to the last hop's output
under a public `r_receipt` — all-or-nothing, no circuit (parser + fold + KATs green). The remaining bucket-B
siblings: `T_FARM_REFUND` (launcher reclaim) is a treasury draw-down like `fold_harvest`; `T_PROTOCOL_FEE_CLAIM`
accrues as LP shares (a virtual `protocol_fee_accrued` accumulator), so a claim mints an LP-share note
(bridgeable, then LP-removable) — but it needs that accumulator tracked in the registry + accrued in the swap
folds before the claim can be soundly bounded.

**Should we support the BP+ variants even if not dapp-ready?** Already done for the cxfer-LAYOUT family
(`T_CXFER_BPP` 0x22, `T_AXFER_BPP` 0x3C, `T_AXFER_VAR_BPP` 0x3D) — they share one parser, and the
conservation gate fails-closed on anything that doesn't actually conserve. The swap/LP ops embed BP+ already
(no separate opcode). So yes, the BP+ surface is future-proofed.

**Is there an even more general abstraction?** Yes, two layers:
1. **Already realized — conservation as the gate.** The reflection never trusts an op's *semantics*; it
   trusts that, for the bridged asset, value conserves against real inputs (the kernel) or a C₀-backed
   reserve (the registry). A mint/multi-asset/non-conserving op can't masquerade — it fails the gate
   (fail-closed). So adding any future single-asset conserving variant is a one-line opcode-allowlist + a
   mechanical re-prove, NOT a new soundness design. The bridge is a *property*, not a per-op integration.
2. **The ideal (a SPEC direction) — a self-describing conservation envelope.** If conserving ops carried a
   uniform TLV header `(asset, kernel_sig, outputs, range_proof)` regardless of op, ONE reflection parser +
   the conservation gate would bridge ANY conserving op the day it ships, with NO per-op parser and NO
   re-prove. Today's ops have bespoke layouts, so we curate a per-layout allowlist; a future "tacit-conserve-
   v1" envelope wrapper would collapse that to a single self-describing path. Worth proposing for the next
   amendment; not required for launch (the curated allowlist + conservation gate already covers every live op).

### The extension contract — adding a bridgeable op is mechanical (2026-06-16)

The pattern is closed: to make a new value-moving opcode bridgeable, classify it into ONE bucket, do that
bucket's fixed work, re-prove, deploy. No per-op soundness design.

- **Bucket A — conserving secp op** (transfer / OTC / orderbook bid; any new single-asset op whose outputs
  conserve against real inputs under a BIP-340 kernel). Work: if it's byte-identical to the cxfer family, add
  the opcode to `parse_cxfer_envelope_full`'s allowlist (**one line**); otherwise add a thin parser yielding
  `(asset, kernel_sig, output_commitments, range_proof)`. The fold is the existing `fold_cxfer` conservation
  gate. **No new fold, no new crypto.**
- **Bucket B — public-reserve op** (AMM swap / route / LP / farm / protocol-fee; outputs drawn from a public,
  C₀-backed reserve or accumulator the registry tracks). Work: a parser + a fold mirroring
  `fold_swap_var` / `fold_swap_route` / `fold_lp_remove` — verify the receipt opens to its public amount,
  enforce the reserve floor, advance the registry. If the op reads a *new* public accumulator (e.g.
  `protocol_fee_accrued`), add it to `PoolReserveState` and accrue it in the relevant folds. **No Groth16, no
  BabyJubJub.**
- **Bucket C — circuit-attested op** (only `T_SWAP_BATCH` today; per-receipt amounts hidden, bound solely by a
  circuit proof). Work: re-derive the public signals from the envelope, verify the proof
  (`groth16_bn254_verify`, validated), and onboard each receipt via the BabyJubJub cross-curve sigma
  (`src/babyjubjub.rs::verify_xcurve`, built + validated against real dapp vectors — the secp note inherits
  the BJJ-proven value; secp half + FS challenge in cxfer-core, BJJ half over `bn::Fr`). The heavy bucket;
  reserved for genuinely hidden-per-output ops.

Then: a box re-prove (rotates `BITCOIN_RELAY_VKEY`) + a `ConfidentialPool` deploy on the new vkey. The
classification IS the design. An op that fits NO bucket (a truly new value primitive) is the only case needing
fresh analysis — and even then a holder isn't stuck: the fungibility relief valve (§"Stuck notes") lets a
note from an unsupported lineage be sold for sats and a clean note rebought, so a missing fold never strands
value, it only defers direct bridging.

### Orderbook (`T_PREAUTH_BID`/`_VAR`) + OTC (`T_AXFER`) — Track A, the EASIEST class (2026-06-16)

These are **2-party conserving swaps with no pool** — and the generalization covers them most directly of
all. A bid fill or an OTC settles `maker gives X / taker gives Y` (the offline-buyer bid is the same with a
pre-funded, pre-signed buyer + a refund leg). Per asset it CONSERVES against REAL counterparty inputs:
asset X — maker/seller input → taker/buyer receipt; asset Y — taker/buyer input → maker/seller receipt (+
the bid's refund). That is exactly the CXFER shape, so `asset_scoped_kernel_verify` (under each op's domain)
handles it with NO pool registry and NO Groth16 — the received notes descend from the counterparties' real
(live-reflected) inputs by the per-asset conservation kernel. The fill amounts are PUBLIC (the orderbook
reads `fill_amount` + `price_per_unit` inline from the envelope), which makes the per-asset conservation
directly checkable and lets each received note bind to its public amount (cleartext or the witnessed-blinding
shape) exactly like `T_SWAP_VAR`/LP-remove.

So orderbook + OTC need NO new cryptographic machinery — only per-op folds (`fold_bid`, `fold_otc`/`fold_axfer`)
that gather the op's per-asset inputs (detected live spends) + outputs and verify the asset-scoped kernel under
the op's domain (`tacit-preauth-bid-var-*`, the AXFER kernel), then onboard the receipts. They are the same
pattern as the CXFER fold, generalized. **Caveat to confirm during build:** `T_PREAUTH_BID_VAR` carries a BJJ
binding alongside its secp kernel-against-UTXOs; confirm the CONSERVATION rides the secp kernel (it should —
the kernel signs against the on-chain input UTXOs, and the fill amount is public), in which case the BJJ is
only the offline-presig/cross-curve receipt detail and the fold stays pure-secp Track A. The
hidden-amount variants (`T_AXFER_VAR`) sit with `T_SWAP_BATCH` if their per-fill amount isn't recoverable —
otherwise a witnessed-amount opening brings them into Track A too.

## Per-op kernel mapping (the implementation specifics to nail down)

The one thing to pin per op: which on-chain kernel signs the **output** side the bridge needs (the
user-facing note the holder would later bridge), versus the input side. LP-add signs the inputs
(`Σ C_in_X − delta_X·H`); a swap/redeem/fill produces a user-facing `X` output, so the walk needs the
conservation tying that output to the consumed pool/counterparty `X` (the reserve-update / receipt
side). For each op, confirm the on-chain proof already binds the output side's conservation; where it
binds only one side, the other follows from the reserve/settlement accounting the op already proves —
surface whichever the walk can verify directly. This mapping is the bulk of the work; the walk
generalization (1) and the soundness argument are uniform across ops.
