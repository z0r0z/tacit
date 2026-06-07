# PLAN — Confidential Cross-Chain (Phase 3: one balance, Bitcoin + Ethereum)

The endgame of the confidential token: a balance that is **one note** spendable
confidentially on Bitcoin *or* Ethereum, double-spend-safe across both, with the
amount hidden — and, in the strongest form, the origin chain indistinguishable.
No BN254-based system can build this; it requires the same curve on both chains,
which is what Tacit's secp256k1 notes give.

Foundation: [`PLAN-confidential-token-rollup.md`](./PLAN-confidential-token-rollup.md)
(Phase 1/2). Cross-chain transport substrate: the live tETH bridge
([`PLAN-teth-fresh-deployment.md`](./PLAN-teth-fresh-deployment.md),
[`PLAN-eth-native-privacy.md`](./PLAN-eth-native-privacy.md) Stage 2).

**Decision 2026-06-07: cross-chain folds into the first generation** (see §8).
The cross-chain ops and contract fields ship in gen-1 so there is never a
migration; the `ConfidentialPool` ABI is already cross-chain-final (`crossOuts`,
`bitcoinBurnsConsumed`/`bridgeMinted`, chain-independent ν). The gold model (§4)
is the live behaviour; platinum (§9) activates the same rails later. The heavier
half — `bridge_mint`'s in-guest Bitcoin-burn verification — still requires Phase 1
to be **live and real-proof-validated** before it is trusted on mainnet, and is
mainnet-gated until its finality/reorg checklist closes.

---

## 1. The one hard problem

Everything else is in place by Phase 2 — same notes, same wallet, same stealth,
same range proofs on both chains. The single hard thing Phase 3 adds is
**cross-chain double-spend safety**: a note can be consumed on Bitcoin *or*
Ethereum, exactly once ever. The Phase-1/2 tee-up makes the nullifier
**chain-independent** (`keccak(note_secret)`), so the *same* note yields the
*same* ν on both chains — the identifier that both surfaces must agree is spent.

Bitcoin and Ethereum share no consensus, so the two spend-surfaces need a way to
agree on "this ν is spent." How they agree is the whole protocol, and there are
two models with very different risk.

## 2. The asymmetry that makes it tractable

The two directions of "learn the other chain's spends" have very different cost,
and the easy split falls in our favor:

- **Ethereum learns Bitcoin spends — already solved by tETH.** The bridge's SP1
  stack verifies Bitcoin state (headers via the relay, pool/burn data) in-guest
  and lands it on Ethereum (`SP1PoolRootVerifier`). That is exactly the primitive
  needed to verify a Bitcoin burn on Ethereum. It runs in production today.
- **Bitcoin learns Ethereum spends — easy, because Bitcoin Tacit is off-chain-
  validated.** Validity is enforced by the indexer + clients, not Bitcoin
  consensus, so "read the Ethereum contract" is a validator-software change, not a
  consensus change. Ethereum is trivially queryable.

## 3. Two consistency models — and why we ship gold first

**Gold (first): per-chain sets + a bridge-claim.** Each chain keeps its *own*
nullifier set for native spends — Bitcoin's off-chain set, Ethereum's on-chain
set. Same-chain spends settle independently and fast, exactly as Phase 1/2;
**Bitcoin keeps its sovereignty** — a Bitcoin spend never waits on Ethereum. A
note crosses only via an explicit **bridge-claim**: burn it on its home chain,
mint an equivalent note on the destination. This is confidential bridging at the
note level, and it reduces to the **tETH bridge's exact safety model** (live and
audited) applied to a hidden-amount note. §4 specs it.

**Platinum (later): one unified, Ethereum-anchored set.** A single global
nullifier accumulator whose root lives on Ethereum, fed by both chains, with a
note natively a member on *both* surfaces — so it cannot be told at deposit which
chain it will spend on (indistinguishable origin). The stronger privacy form and
the truly uncopyable moat, but it couples Bitcoin's liveness to Ethereum
reflection and is the higher-risk build. §9 sketches it; it is the destination,
not the first step.

The rest of this doc specs **gold**.

## 4. The bridge-claim protocol (gold)

A cross-chain send moves value from a note on the source chain to a fresh note on
the destination chain, owned by the recipient (an address or stealth pubkey on
the destination). It is two coupled half-ops.

- **Burn (source).** Nullify the note in the source chain's set (reveal ν). Prove
  in-zk that the burned value `v` equals the value committed by the destination
  note (no value created), and bind a `cross_out` record `(destChain,
  destCommitment, ν, claimId)`.
- **Mint (destination).** Insert the destination note, gated on a finalized,
  proven, **not-already-claimed** source burn.

**Bitcoin → Ethereum.**
- Burn: a Bitcoin Tacit burn envelope (the tETH burn shape), buried ≥ K confs.
- Mint: the gen-N SP1 guest verifies that burn against Bitcoin state — the tETH
  bridge guest's *exact* Bitcoin-burn check (finalized header chain via the relay,
  the burn's nullifier, the value) — marks `claimId` in an `acceptedBitcoinBurns`
  set (one mint per burn, the tETH pattern), and inserts the Ethereum note.
  Trustless, on-chain on Ethereum.

**Ethereum → Bitcoin.**
- Burn: an Ethereum `settle` op nullifies the note and emits `cross_out`
  `(bitcoin, destCommitment, ν, claimId)`.
- Mint: Bitcoin Tacit validators (off-chain) accept the Bitcoin cross-mint
  envelope iff the referenced Ethereum burn is confirmed past Ethereum finality
  and unclaimed — a validator rule, no Bitcoin consensus change.

### Ethereum data (gen-N additions)
- `acceptedBitcoinBurns[claimId] → bool` — Bitcoin burns already minted on
  Ethereum (one mint per burn).
- `crossOut[claimId]` event/record — Ethereum burns destined for Bitcoin, for
  Bitcoin validators to honor.
- Two new guest op types: **`bridge_mint`** (Bitcoin burn → Ethereum note; reuses
  the tETH Bitcoin-burn verification) and **`bridge_burn`** (Ethereum note →
  `cross_out`). `wrap`/`transfer`/`unwrap` are unchanged; the vkey changes →
  generation-N.

### Double-spend safety (by construction)
- **Each chain serializes its own consumption.** A native spend and a cross-chain
  burn are *both* nullifications of the same ν in that chain's set, so the set
  rejects the second — a note can't be both spent natively and bridged out.
- **One burn → one mint.** The destination mint is gated on the source burn being
  claimed-once (`acceptedBitcoinBurns` on Ethereum; the validator's claimed-set on
  Bitcoin). A replayed claim finds `claimId` already set.
- **No value creation.** The burn proves `v_burn == v_mint` over the secp note
  value, so the minted note carries exactly the burned value.
- **Custody, per asset, per chain.** Escrow on each chain ≥ that chain's unspent
  notes of the asset; a cross-chain move burns backing on the source while the
  destination mint draws on the destination's backing of that asset.

So cross-chain safety reduces to (a) the per-chain nullifier sets that *already*
serialize same-chain spends, plus (b) the bridge claim model that is *already
live* (tETH). No new shared-consensus assumption.

### Which assets can cross
Cross-chain movement needs the asset to **exist and be backed on both chains** —
tETH is the canonical case (ETH on Ethereum ⇄ tETH on Bitcoin), and the flagship.
A purely Ethereum-native confidential token has no Bitcoin backing, so "send to a
Bitcoin address" applies only to **two-sided (bridged) assets**; chain-native
assets stay confidential within their chain. Honest scope: the "Bitcoin *or*
Ethereum address" promise is per-asset, realized fully for bridged assets.

## 5. The finality gate

Cross-chain reflection waits for the source chain's finality so a reflected spend
cannot be undone:

- A Bitcoin burn is minted on Ethereum only after ≥ K Bitcoin confirmations, via
  an SP1 proof of Bitcoin state past that depth (the bridge's discipline).
- An Ethereum burn is honored on Bitcoin only after Ethereum finality.

The gate adds latency to **cross-chain** transitions only; same-chain spends are
unaffected, and the foundation's soft-finality (the recipient verifies the
sender's proof client-side) still gives instant assurance regardless of chain.

## 6. tETH's two roles

1. **Flagship asset.** Confidential **tETH** is private ETH fluid across both
   chains — hold it private on Bitcoin, spend it confidentially on Ethereum, one
   wallet. The demonstration that makes the offering legible.
2. **Substrate.** The gen-N guest is a sibling of the tETH guest (shared crates
   for Bitcoin-state verification, secp, accumulators), reusing the pinned
   immutable SP1 Groth16 verifier, the relay, and the deposit/reorg discipline.
   One prover deployment serves the bridge and the confidential system.

## 7. Ethereum execution, Bitcoin finalization (two-tier settlement)

A high-value mode the gold rails unlock directly: run expressive, fast, cheap
confidential operations — **swaps especially** — on Ethereum, and let **Bitcoin
be the finalization/custody anchor**. Ethereum is the programmable execution
venue; Bitcoin is the vault.

This leans on the *cheap* side of the §2 asymmetry: "Bitcoin finalizes what
Ethereum settled" is a Bitcoin **validator-software rule** (validators read
Ethereum's `CrossOutRecorded`), not a Bitcoin consensus change — far easier than
the reverse direction.

**Three finality tiers fall out:**
1. **Instant soft-final** — the counterparty verifies the BP+ proof client-side
   the moment they receive the result note. No chain yet; the fastest "pre-final."
2. **Ethereum settle = serialized** — the SP1 `settle` lands and Ethereum's
   nullifier set *linearizes* the spend. This is the ordering point that prevents
   double-spend: a note's ν is consumed on the first pre-execution, so it cannot
   pre-execute in a second swap.
3. **Bitcoin = final custody** — a `crossOut` instructs Bitcoin validators to
   honor the result once Ethereum is final; value comes to rest on the sovereign
   chain.

**Atomic cross-chain swap in one proof.** Because `settle` is batched, a single
proof can nullify the input notes, mint the swapped output as an Ethereum leaf for
the leg that stays, **and** emit a `crossOut` for the leg finalizing on Bitcoin —
a confidential swap whose two legs settle on different chains, atomically. A swap
is a multi-asset `transfer` (per-asset conservation is already in the guest), so
"swap-and-bridge" composes from ops that exist; the gen-1 public-values layout
(`nullifiers` + `leaves` + `crossOuts` together) already expresses it.

**Constraints that keep it sound:**
- *Pre-final is reversible-until-Bitcoin.* An Ethereum reorg before the §5
  finality gate clears can unwind the soft swap; a recipient needing *hard*
  finality waits for Bitcoin. Standard L2→L1 latency.
- *Single ordering point.* Ethereum is the authoritative serializer in this mode
  (Bitcoin defers/finalizes). Letting Bitcoin *also* independently order the same
  notes reopens cross-chain double-spend. ETH orders, BTC custodies — one
  linearization point.
- *Backing follows finalization.* The asset must be backed where it finalizes;
  tETH is the clean case, an ETH-native asset finalizing on Bitcoin needs
  Bitcoin-side backing (the two-sided-liquidity open decision, §11).

This is **platinum-flavored** — gold already does it as explicit burn→mint phases;
the *seamless* "swap on ETH, auto-finalize on BTC" UX is platinum polish. But the
gen-1 ABI (chain-independent ν, `crossOuts`, `bridgeMinted`) is exactly what
platinum activates against, so landing it is turning on rails, not migrating.

### Confidential cross-chain swap via the Bitcoin batch AMM (`T_SWAP_BATCH`)

Pooled-liquidity swaps don't need a new Ethereum DEX — they reuse the **existing,
ceremony-locked Bitcoin AMM**, confidentially. `T_SWAP_BATCH` (`0x2F`,
`amm_swap_batch.circom`, SPEC §5.16) is a *privacy-mode* batch swap: N ≤ 16 traders'
amounts are hidden (BabyJubJub Pedersen + in-circuit range proofs), a uniform
clearing price `P_clear` is derived in-circuit from the *private* aggregates and the
*public* net reserve delta, and each trader's fill is computed against `P_clear`. So
individual amounts are hidden among the batch (anonymity = batch size); only the
batch's net reserve movement is public, and everyone clears at one price.

It composes with the bridge through the **shared secp256k1 commitment layer**. A
confidential note is a secp Pedersen commitment; the AMM's **Sigma cross-curve
binding** proves a secp Pedersen and a BabyJubJub Pedersen carry the *same hidden
amount* (it already backs every AMM swap intent/receipt). So:

> confidential asset → `bridge_burn` to its Bitcoin form → its secp commitment is
> sigma-bound to a BJJ commitment → enters a `T_SWAP_BATCH` batch (hidden amount,
> uniform price) → `bridge_mint` the result back

That is pooled liquidity **and** a hidden swap amount on infrastructure that exists
today — not "shield → public swap → re-shield". Properties / honest limits:
- **Amount-private, batch-bounded.** You are hidden among ≤16 batch peers; the net
  batch delta is public. This is the realistic limit of any uniform-clearing batch
  AMM, not a defect.
- **No new circuit / ceremony.** The primitive (secp Pedersen + sigma binding +
  `amm_swap_batch`) is built; wiring a *bridged note's* UTXO/leaf format into an AMM
  swap intent is connective work. `T_TRADE_BATCH` (`0x39`, draft) already
  anticipates cross-surface atomic settlement reusing `amm_swap_batch`.
- **Two swap modes, complementary.** `T_SWAP_BATCH` = pooled, always-on, amount-
  private (needs a batch). The matched confidential swap (gen-1, §7 above) = OTC /
  peer, amount-private, no pool, needs a counterparty. Public-amount single swaps
  use `T_SWAP_VAR` (`0x32`, no Groth16). Offer all three; route by need.
- **Pilot-grade.** The AMM's existing soundness posture (single non-consensus
  worker, reorg/CAS deferred) carries over to cross-chain swaps routed through it.

## 8. Folded into gen-1, not a separate generation (decision 2026-06-07)

Earlier framing treated cross-chain as a later generation-N deployed alongside
gen-1. **Superseded:** the cross-chain ops and contract fields fold into the first
generation, so there is never a migration. What this means concretely:

- **Contract ABI is cross-chain-final now.** `ConfidentialPool.PublicValues` carries
  `bitcoinBurnsConsumed` (Bitcoin burns minted here, gated one-per-`claimId` via
  `bridgeMinted`) and `crossOuts` (Ethereum burns destined for Bitcoin). `settle`
  marks each `claimId` once and re-derives the `crossOut` `claimId` on-chain so the
  emitted record is non-malleable. `claimId = keccak(destChain ‖ destCommitment ‖
  ν ‖ assetId)`. Shipped + tested (commit `98a8b20`).
- **`bridge_burn` (Ethereum → Bitcoin) is pure-EVM** and built in gen-1: it is a
  `transfer` whose outputs are off-chain destination commitments + an emitted
  `CrossOut`, reusing the existing `verify_range` + `verify_kernel` + membership.
- **`bridge_mint` (Bitcoin → Ethereum) is the heavier half**: it needs in-guest
  Bitcoin-burn verification, shared from the live tETH bridge guest's crates
  (header chain via the relay, the burn check). It is part of the gen-1 guest, so
  the final vkey includes it; it is mainnet-gated until its finality/reorg
  checklist closes (the standard pilot posture, as AMM and tETH).
- **Why this is clean, not reckless.** The version field still guards the layout;
  the chain-independent nullifier, versioned public values, and `crossChainLink`
  asset field were the gen-1 tee-ups that made the fold-in a small delta rather
  than a rebuild. One vkey, one contract, one anonymity set — and no future
  migration to reconcile two generations of notes.

### `destChain` selectors

`crossOut.destChain` / the mint's destination are abstract `uint16` selectors,
not EVM chain ids: **1 = bitcoin, 2 = ethereum**. They are inputs to `claimId`
only; chain-binding to *this* deployment is the separate `chainBinding` field.

### `bridge_mint` is the mirror of `bridge_burn`

The key simplification: a Bitcoin confidential burn *destined for Ethereum* is a
`bridge_burn` with `destChain = ethereum` — it produces a `crossOut` whose
`destCommitment` **is the Ethereum leaf to mint** (`keccak(asset ‖ Cx ‖ Cy ‖
owner_eth)`), with `claimId = keccak(2 ‖ destCommitment ‖ ν ‖ asset)`. So the
claimId/commitment math is already built and locked three-way. `bridge_mint`'s
guest:

1. **Verify the Bitcoin burn is confirmed** — reuse `tETH`'s `bitcoin.rs`:
   `extract_merkle_root`/`bits_to_target` (header), header-chain linkage to a
   relayed anchor, `compute_merkle_root`(txids) == block root, `compute_txid`(tx)
   in the block, `extract_taproot_envelope` to read the burn payload. (The one
   box-gated piece; it is calling live, audited tETH code.)
2. **Verify the burned note was real** — its membership against the relayed
   Bitcoin confidential-pool root + its range/opening (the burn's in-envelope
   proof), so no unbacked value is minted.
3. **Carry the commitment verbatim** — insert `destCommitment` as the Ethereum
   leaf (`pv.leaves`), so `v_mint == v_burn` by construction (no re-commit).
4. **Gate one-mint-per-burn** — emit `claimId` in `pv.bitcoinBurnsConsumed`; the
   contract's `bridgeMinted` rejects a replay.

A memo sealed to the recipient's Ethereum scan key rides in the burn envelope and
is emitted in `LeavesInserted`, so the recipient recovers the minted note from
chain + seed with the *same* indexer used for native notes — the minted note is
byte-identical to a native one. Validated end-to-end in Node
(`tests/confidential-bridge-mint.mjs`): burn → mint → recover, conservation and
claimId consistency, recovery with a folding membership path. Only step 1's
in-guest wiring + the final `cargo prove` remain (box).

### Custody / backing — resolved

A two-sided (bridged) asset has its **canonical backing on one chain**; notes on
the other chain are *claims*. For an ETH-origin asset (tETH), the backing is the
ETH held on Ethereum; Bitcoin tETH notes are claims on it. Cross-chain moves
convert between *directly-backed* and *claim* notes **without changing total
backing**:

- `bridge_mint` (BTC→ETH) turns a Bitcoin *claim* into a directly-backed Ethereum
  note. No new backing is created — the ETH was already on Ethereum; the
  Bitcoin-burn proof (step 2) + `claimId`-once is what prevents minting an
  unbacked note.
- `bridge_burn` (ETH→BTC) turns a directly-backed Ethereum note into a Bitcoin
  claim; the backing stays on Ethereum.

Invariants: (a) Σ Ethereum directly-backed notes ≤ Ethereum escrow (the pool's
existing escrow checks); (b) Σ notes across both chains ≤ total backing (the
tETH mint-only-reserve discipline, the F-2 lesson). A BTC-origin asset mirrors
this with canonical backing on Bitcoin. So "send to a Bitcoin *or* Ethereum
address" is sound per-asset, and full for bridged assets — no double-backing, no
inflation, by construction.

## 9. Platinum (unified set) sketch + recovery

**Platinum** replaces the bridge-claim with a single Ethereum-anchored nullifier
accumulator that both chains feed and read, and a unified deposit tree so a note
is natively a member on both surfaces (indistinguishable origin). The gen-N guest
would consume an Ethereum-side spend accumulator *and* a Bitcoin-side one
(committed in public values, checked at submission as deposit accumulators are
today) and expose mint-nullifiers so neither surface honors a spend the other has
consumed. Ethereum L1 is the linearization point; Bitcoin defers to its root. The
cost is the coupling (a purely-Bitcoin spend's *global* finality now waits on
Ethereum reflection) and a far larger audit surface — hence platinum follows gold.

**Recovery** is unchanged from the foundation in either model: seed-derived notes
plus a scan of both chains; a note carries the same identity on both, so a wallet
sees one balance.

## 10. Fast lane + sovereign lane (dual-lane settlement)

Rather than *choose* who orders (the §11 fork), Tacit offers **two lanes over one
note set**, and the user picks per trade:

- **Sovereign lane (Bitcoin-native, default).** Trades/transfers settle on Bitcoin
  Tacit directly; the Tacit indexer is the record until Bitcoin finality (the
  *existing* model). Bitcoin is the sole ordering + finality authority. Slower
  (Bitcoin blocks) but fully sovereign — **zero Ethereum dependency**, the option a
  user takes when willing to wait for Bitcoin blocks.
- **Fast lane (Ethereum-fast, Bitcoin-final, opt-in).** Trades settle on Ethereum in
  seconds (SP1-verified `settle`, ~12s blocks) and finalize when the Ethereum state
  is anchored to Bitcoin. Within the lane Ethereum serializes; globally it is
  *subordinate to Bitcoin* (see "Harmonizing the lanes" below).

The fast lane is platinum (§9) as a *continuous* layer (vs gold's discrete per-note
bridge-claims, §4): "Ethereum always-fast, periodically finalized to Bitcoin."

**It is viable, and it leans on the favorable asymmetry (§2).** Three finality
tiers fall out, the first two already real:
1. **Instant (client-side).** The counterparty verifies the note's proof the moment
   they receive it — no chain. Already true of the confidential foundation.
2. **Fast (Ethereum `settle`).** The SP1 proof lands on Ethereum and its nullifier
   set linearizes the spend — fast soft-finality, on-chain, ~12s. This is the
   "fast-mode Tacit layer."
3. **Final (Bitcoin-anchored).** A relay inscribes the Ethereum state root (commit
   tree + nullifier accumulator) on Bitcoin via a Tacit envelope; once Ethereum-
   final and Bitcoin-anchored, Tacit's off-chain validators treat it as canonical.

**The one mental-model correction:** Bitcoin cannot *verify* the SP1 proof (no
smart contracts / no SP1 verifier). So "proof recorded on Bitcoin" means the proof
(or a commitment to it + the Ethereum root) is **inscribed/ordered on Bitcoin and
validated off-chain by Tacit's indexer** — Bitcoin provides ordering, data
availability, and finality, *not* on-chain verification. This is exactly Tacit's
existing model (off-chain-validated, Bitcoin as the ordering/DA layer), so it fits
— it is a **sovereign-rollup** shape (Bitcoin = DA/ordering, validity-proven on
Ethereum + off-chain checked), not a smart-contract rollup.

**Why this is the destination, not the first step** (the hard parts, all platinum's):
- *Cross-chain nullifier consistency.* A note must not spend on Ethereum's fast lane
  *and* natively on Bitcoin before the anchor reconciles them. Solvable via the
  chain-independent ν: Ethereum serializes its fast-spends; Bitcoin validators
  (off-chain, the easy direction) honor Ethereum spends once Ethereum-final. But it
  couples Bitcoin's *global* view to Ethereum reflection.
- *The finality gate is the whole risk surface.* Fast = provisional. An Ethereum
  reorg before the Bitcoin anchor unwinds a "confirmed" trade; a consumer needing
  hard finality waits for the anchor. The gate (§5) is what bounds it.
- *The anchor relay* (who inscribes the Ethereum root on Bitcoin, on what cadence)
  is new operational infra — a sibling of the bridge relay (§4 ops) and the
  Bitcoin-root relay (`PLAN-confidential-btc-relay.md`).
- *Audit surface* is far larger than gold's.

**Relation to the bridge.** The fast lane *is* bridging generalized: the gen-1
primitives — chain-independent ν, `crossOut`/`bridgeMinted`, the relays — are the
building blocks; the fast lane composes them into a settlement layer instead of
invoking them per cross. So building gold first (discrete, shipped) is also building
toward the fast lane (continuous, the endgame). The AMM batch-swap composition
(§7) slots in directly: fast confidential trades execute on the Ethereum fast lane
*or* route to the Bitcoin batch AMM, and finalize to Bitcoin either way.

### Harmonizing the lanes — Bitcoin arbitrates, the fast lane yields

The two lanes share **one nullifier set** (the union over both surfaces; the
chain-independent ν makes a note's spend the same identifier in either lane), so a
note is spent once, period. They differ only in *speed* and *who serializes*, not
in double-spend protection. The reconciliation rule that keeps them sound:

- **Bitcoin is the global arbiter.** When a fast-lane spend (Ethereum-ordered) and a
  sovereign-lane spend of the *same* note both reach Bitcoin, Bitcoin's anchored
  order decides and the loser is rejected. The sovereign lane, being directly on
  Bitcoin, **wins ties** — it can never be overridden by an un-anchored fast-lane
  confirm.
- **The fast lane is an accelerator that defers to Bitcoin.** A fast-lane confirm is
  *provisional* until Bitcoin-anchored; it yields to any conflicting Bitcoin-native
  spend (and to an Ethereum reorg before the anchor). The worst case is a fast-lane
  soft-confirm being *reverted* — never a final double-spend.
- **The sovereign lane stays sovereign.** It never waits on Ethereum; its liveness
  and ordering are pure Bitcoin. It only needs to *see* fast-lane spends already
  Bitcoin-anchored (so it doesn't re-spend a finalized note) — the easy direction
  (§2). This removes platinum's coupling concern *for sovereign-lane users*: their
  Bitcoin liveness never depends on Ethereum reflection.

This resolves the §11 ordering fork by **not globally choosing one**: *within* the
fast lane Ethereum orders (option A, for UX), while *overall* Bitcoin is sovereign
(option B's guarantee). A user wanting Ethereum speed opts into the fast lane and
accepts provisional-until-anchored; a user wanting pure Bitcoin sovereignty stays in
the sovereign lane and waits for Bitcoin. Same notes, same assets, same AMM /
orderbook / transfers — two settlement speeds, one source of truth.

### What the fast lane reuses vs. adds

The slow, costly, audit-heavy parts never move:

| Layer | V1 (lane + bridge) | V2 (one note, both surfaces) |
|---|---|---|
| SP1 guest / vkey / ceremony / prover | **reuse unchanged** | **reuse unchanged** |
| `ConfidentialPool` contract | **reuse as deployed** | + `knownBitcoinSpent` gate → fresh multigen deploy |
| New work | off-chain anchor relay + Bitcoin validator rule | + the on-chain cross-lane gate |

The fast lane adds **no op** — fast-lane trades are the existing `transfer`/`swap`/
`bridge_*` ops settling on Ethereum, and `settle` *is already* a ~12s confirm. So
the guest, vkey, ceremony, and prover are fixed forever; you iterate the off-chain
layer (and, only for V2, one contract field via multigen — still no circuit change).

### The best-compromise realization — home-chain notes + optimistic relayers

The cheapest *sound* dual lane avoids V2's cross-lane gate entirely:

1. **Notes are homed on one surface; moving between surfaces is the gold bridge**
   (§4), which already serializes one-spend (`claimId`-once + the home nullifier
   set). So there is **no cross-lane native double-spend → no platinum gate → no
   contract change** — this is V1, on the deployed code.
2. **Sovereign lane** = trade on the note's home (Bitcoin for BTC-homed assets),
   wait for Bitcoin, indexer-of-record. **Zero Ethereum dependency.**
3. **Fast lane** = trade on Ethereum (~12s) + anchor roots to Bitcoin for finality.
4. **Seamless cross-lane movement via optimistic relayers** (intent / fast-bridge):
   a relayer fronts the destination note *instantly* from its own pre-bridged
   liquidity and reclaims via the existing `bridge_mint`/`crossOut` (`claimId`-once
   makes the reclaim exactly-once); the trustless-but-slow path is the plain bridge.
   This reuses Tacit's **existing settler/intent economics** (preauth-bid intents,
   AMM settlers, the `T_TRADE_BATCH` `0x39` cross-surface atomic draft) — no protocol
   change, just a liquidity layer. The relayer prices the finality-gate reorg risk.
   - *Confidentiality wrinkle (honest):* a relayer must know the amount to provision
     liquidity, so a confidential fast-relay needs the user to disclose the amount
     **1:1, privately, to that relayer** (not public) — or use denominations
     (k-anonymity), or, for **swaps**, the cross-surface atomic batch which needs no
     fronting because it settles atomically.
5. **Bitcoin stays the arbiter/sink** — the sovereign lane is pure Bitcoin; the fast
   lane finalizes to Bitcoin via the anchor.

The only thing this compromise gives up vs. full platinum is **indistinguishable
origin** (a note's history can show it crossed). That is a *later* multigen upgrade
(V2 + the unified deposit tree), not a prerequisite. So: **gold + Bitcoin-anchoring
+ optimistic relayers = the dual lane with seamless UX, Bitcoin-sovereign, on the
unchanged guest/prover/ceremony (and unchanged contracts for the home-chain model).**

## 11. Open decisions

- **`claimId` binding** — what exactly the burn commits to (destChain ‖
  destCommitment ‖ ν ‖ asset), so a claim is uniquely mintable on exactly one
  destination and not malleable.
- **Confirmation depths** per direction for the finality gate, and the residual
  deep-reorg handling (accept-and-document, as tETH, vs an explicit unwind).
- **Cross-chain asset binding** — derive the EVM `asset_id` from the Bitcoin one
  for bridged assets vs an explicit registry link (the `crossChainLink` field
  teed up in Phase 1).
- **Two-sided liquidity / backing model** per bridged asset (who holds the
  destination backing; mint-only reserve discipline, as the tETH F-2 fix).
- **Relayer/settler economics** for cross-chain transitions (fee in-asset, as in
  the foundation).
- **Gold → platinum migration** — whether the unified set is a later generation
  on top of gold or a parallel mode.
- **Fast-lane ordering authority (the A/B fork, §10).** Resolved in principle by the
  dual-lane model (fast lane orders internally on Ethereum = A; Bitcoin is the global
  arbiter = B's guarantee). The remaining sub-decisions:
  - *Lane reconciliation cadence* — how synchronously the fast lane learns of
    sovereign (Bitcoin-native) spends to avoid surfacing a soft-confirm that will
    lose: a synchronous indexer-gate on the Ethereum `settle` (adds an indexer
    liveness dependency) vs optimistic-accept + reconcile-at-anchor (simpler, more
    revertible soft-confirms).
  - *Anchor cadence & who anchors* — the relay that inscribes the Ethereum root on
    Bitcoin, its frequency, and its economics (a sibling of the bridge + Bitcoin-root
    relays). Sets the fast-lane "time-to-final".
  - *Per-asset / per-trade lane policy* — default lane, whether an asset may be
    fast-lane-only or sovereign-only, and how the UX signals the active tier
    (provisional vs Bitcoin-final) so consumers know the finality they're acting on.
  - *V2 cross-lane gate placement* (only if pursuing one-note-both-surfaces beyond
    the home-chain compromise): an **on-chain** `knownBitcoinSpent` mapping fed by the
    relay + checked in `settle` (no guest/vkey/ceremony change; a fresh multigen pool
    deploy) vs an **in-guest** Bitcoin spend-accumulator (vkey change, heavier). Prefer
    on-chain — it keeps the circuit + ceremony fixed.
