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
  Bitcoin-side backing (the two-sided-liquidity open decision, §10).

This is **platinum-flavored** — gold already does it as explicit burn→mint phases;
the *seamless* "swap on ETH, auto-finalize on BTC" UX is platinum polish. But the
gen-1 ABI (chain-independent ν, `crossOuts`, `bridgeMinted`) is exactly what
platinum activates against, so landing it is turning on rails, not migrating.

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

## 10. Open decisions

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
