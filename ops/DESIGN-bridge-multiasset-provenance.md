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

**Revised plan.** Split "multiasset" into two tracks: (A) the asset-scoped-kernel walk for OTC/bid
(confidential, fits the existing `verify_cxfer_conservation` shape — likely NO guest change if the op
emits a `tacit-kernel-v1`-shaped per-asset sig, since the walk already verifies that); (B) a separate
pool-reserve-provenance design for AMM-sourced notes (swap/LP), which proves a public-value receipt
descends from the pool's `C_0`-rooted reserve. Track A is the near-term win; track B is its own design.

## Per-op kernel mapping (the implementation specifics to nail down)

The one thing to pin per op: which on-chain kernel signs the **output** side the bridge needs (the
user-facing note the holder would later bridge), versus the input side. LP-add signs the inputs
(`Σ C_in_X − delta_X·H`); a swap/redeem/fill produces a user-facing `X` output, so the walk needs the
conservation tying that output to the consumed pool/counterparty `X` (the reserve-update / receipt
side). For each op, confirm the on-chain proof already binds the output side's conservation; where it
binds only one side, the other follows from the reserve/settlement accounting the op already proves —
surface whichever the walk can verify directly. This mapping is the bulk of the work; the walk
generalization (1) and the soundness argument are uniform across ops.
