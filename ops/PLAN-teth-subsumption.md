# PLAN — ConfidentialPool subsumes tETH (shielded ETH, one ledger)

> **Decision (2026-06-17):** the ConfidentialPool absorbs the tETH bridge. tETH stops being a separate
> Tornado-style mixer and becomes a **native pool asset: shielded ETH**, with its **canonical Bitcoin id
> unchanged**. Users migrate from the old mixer (pilot holds ~0.003 ETH — negligible, not a blocker).
> Supersedes the cross-contract `PLAN-teth-erc20-redeem.md`: with one custodian there is no fragmented
> ledger to unify, no separate ERC20-redeem primitive, no double-claim surface. Pursue elegance.

## The elegant model: tETH = shielded ETH, the pool is the sole custodian
- The ConfidentialPool **holds the ETH** that backs tETH (native-ETH escrow, `underlying == address(0)`),
  and is the **sole tETH issuer** — tETH supply is minted ONLY against an ETH deposit.
- **tETH carries its canonical Bitcoin id** as its `crossChainLink`, so it crosses to/from Bitcoin like any
  Tacit asset (fast lane in, `crossOut` out).
- **Wrap:** deposit ETH → a confidential tETH note (the shielded form). **Unwrap:** burn a tETH note →
  native ETH. That unwrap *is* the redeem — no `withdraw()` primitive, no wrapped-ERC20 hop.

## The one insight that makes it sound + elegant
> **`escrow[tETH] == Σ live tETH (across every chain/form) · UNIT_SCALE`** — the escrowed ETH is the single,
> persistent backing, and tETH notes are just claims that *move*:
> - **wrap** (ETH→tETH): `escrow += ETH`, mint the note.
> - **unwrap** (tETH→ETH): burn the note, `escrow -= ETH`. The only ETH release.
> - **crossOut** (tETH ETH→BTC): the note is consumed, a Bitcoin tETH note appears — **the ETH stays in the
>   pool** (it backs the Bitcoin-side note now). No release.
> - **fast-lane / bridge_mint** (BTC→ETH): re-materializes a tETH note against the **already-escrowed** ETH —
>   **no escrow add** (the ETH was deposited when tETH was first minted).
>
> So a given ETH is escrowed once, backs its tETH wherever it travels, and is released exactly once (an
> Ethereum unwrap). No cross-contract accounting, no second claim path, nothing to reconcile.

## The contract change (one, not two — the review narrowed it)
The current contract is built for bridged assets being *pool-minted* (a fresh ERC20, no escrow). tETH-as-
shielded-ETH needs exactly ONE relaxation:

1. **Allow native-ETH escrow to carry a cross-chain link.**  ✅ DONE + tested. `_register` now permits a link
   when `underlying == address(0)` (native ETH is the protocol's *own* escrow and provably backs bridged
   supply — the pool is the sole ETH-gated minter); external-ERC20 escrow + a link **stays barred**. Tested
   in `test_teth_native_eth_link_and_escrow_supply_invariant` (registration, the foreign-escrow bar holds,
   wrap/unwrap conserve, fail-closed `InsufficientEscrow`). Full pool suite green.

2. **The escrow-drain-defense narrowing is NOT needed — and we keep the strong defense.**  *(Review finding,
   the payoff of doing this carefully.)* The "Bitcoin TAC → ETH" flow does **not** require a btcHomed batch
   to draw escrow: it is **two settles** — (a) the btcHomed fast-spend produces a tETH **leaf** (an Ethereum
   note; a leaf draws no escrow), then (b) a **normal, non-btcHomed** unwrap of that tETH note → ETH (draws
   the tETH escrow legitimately — same asset, conserved — and the escrow-drain defense only fires on
   *btcHomed* batches, so it never blocks this). So the defense I shipped ("a btcHomed value-exit must be
   pool-minted/own-backed, never foreign escrow") **stays as-is — no defense-in-depth reduction.** A
   one-settle btcHomed→ETH would be the only thing needing the narrowing; it's pure UX sugar, deferred, and
   not worth widening the compromised-guest surface for.

Both are small, but both are **fund-critical** → REFLECT-1 rigor. The load-bearing invariant for both is the
same: **tETH is minted only against an ETH deposit, so `escrow == supply` holds at every transition.**

## Extraction — now trivial
Bob's fast-lane swap leaves him a confidential tETH note on Ethereum → **unwrap → native ETH**, one settle.
That's the whole "Bitcoin TAC → real ETH in one flow." No tETH ERC20 in the path, no bridge round-trip.

## Does a public tETH ERC20 still exist? — by default, no, and that's cleaner
Because tETH redeems to ETH 1:1, **its public form simply *is* ETH** (or WETH, the standard wrapper). There's
no reason to mint a distinct public "tETH ERC20" — that was an artifact of the pool-minted assumption we've
now dropped for tETH. Anyone wanting an ERC20 in DeFi-land holds WETH; anyone wanting privacy holds a tETH
note. (A pool-minted public tETH ERC20 could be added later *only* if there's real demand for tETH as a
tradeable token distinct from ETH — elegance says don't, until there is.)

## Migration
- The old mixer holds ~**0.003 ETH** (pilot). Stand up tETH in the ConfidentialPool, **keep the canonical
  Bitcoin id**, and offer a migrate path (redeem-from-old-mixer → re-deposit-into-pool, or a one-shot sweep
  given the trivial balance). Not a launch blocker; the old mixer can be wound down on its own clock.
- Same id means Bitcoin-side tETH notes and the etch are unaffected — only the Ethereum custodian changes.

## Generational continuity — Ethereum pools are iterable; Tacit is durable
> First-class write-up: **`PLAN-pool-generations.md`**. Summary here.

The deeper design this unlocks: **deploy new generations of the shielded pool on Ethereum freely** (to fix,
harden, rotate vkeys, add ops), **with asset continuity across generations carried by Tacit + reflection** —
never by an upgrade authority (the tETH lesson: no owner-upgradeable component on the value path).

- **Bitcoin/Tacit is the durable state layer; each Ethereum pool generation is a disposable execution
  layer.** A canonical Bitcoin asset id is generation-independent, and the reflection (Bitcoin
  confidential-pool state) is shared by all generations. A new gen just registers the SAME canonical assets
  and anchors to the SAME reflection — it's a client of one durable Bitcoin-anchored ledger, not a fork.
- **The cross-chain machinery already IS the cross-generation path.** Moving value gen-N → gen-N+1 is the
  same `crossOut` (gen-N → Bitcoin) → fast-lane / `bridge_mint` (Bitcoin → gen-N+1) that bridges
  Bitcoin↔Ethereum, with the canonical id making it the same asset. The Bitcoin hub is the continuity — no
  gen-to-gen contract coupling, no shared mutable state, nothing to re-point.
- **Two asset classes, two migration costs:**
  - *Pure-Tacit assets (TAC, …):* **trustless and frictionless** — no physical underlying; the new gen mints
    against the reflected Bitcoin state, value flows via the hub.
  - *Underlying-backed assets (tETH = ETH, external ERC20s):* the escrow is physical, so migration is
    **redeem-from-old-gen + deposit-into-new-gen** — user-initiated, trustless, and crucially with **NO
    shared vault and no authorized-spender handoff** (either would reintroduce an upgrade authority). The
    old gen stays self-custodially redeemable; users migrate at their own pace.
- **No shared mutable custody — ever.** Each generation is immutable and self-custodial for its own escrow.
  Continuity is the canonical id + reflection + user-paced migration, not a contract anyone can upgrade or
  re-authorize. This is the rollup framing (`PLAN-confidential-token-rollup`): Bitcoin = durable
  DA/continuity, Ethereum gens = disposable execution.

The pilot mixer→pool migration is simply the FIRST instance of this: mixer = gen-0, the ConfidentialPool =
gen-1, future hardening = gen-2 — each an immutable deploy, continuity via the canonical id + reflection.

## Soundness / review (REFLECT-1)
- **`escrow == supply` invariant** holds across wrap / unwrap / crossOut / bridge_mint (no path mints tETH
  without ETH, none releases ETH twice). This is THE proof to write.
- **crossOut retains the ETH** (doesn't release on exit-to-Bitcoin) — confirm the crossOut path for tETH
  leaves `escrow[tETH]` untouched.
- **bridge_mint re-materializes against existing escrow** — confirm a btcHomed/bridge_mint tETH note adds no
  escrow and can only ever claim ETH already deposited.
- **The two relaxations are tightly gated** (native-ETH-only link; same-asset-own-backing exit).
- The no-inflation reserve floor + the cross-lane gates compose unchanged (tETH is just another asset).

## What's new vs reused
- **New:** the two gated relaxations; the tETH registration as native-ETH-escrow-with-link; the migration
  path; (optional, deferred) a crossOut-retains-escrow check if not already implicit.
- **Reused:** native-ETH custody + `wrap`/`_payout` (already in the pool); the fast lane + freshness +
  crossOut + bridge_mint; the `escrow[assetId]` ledger; the canonical Bitcoin id + etch.

## Phasing
1. **Register tETH in the ConfidentialPool** as native-ETH-escrow + the canonical Bitcoin link (gated by
   refinement 1). Wrap/unwrap ETH↔tETH live.
2. **Refinements + proof:** ship the two relaxations with the `escrow == supply` invariant written out and
   forge-tested (wrap/unwrap/crossOut/bridge_mint conserve; no double-claim; native-ETH-only gating).
3. **Wire it into the fast lane:** a btcHomed tETH note unwraps to ETH (refinement 2) — the extraction flow.
4. **Migrate** the pilot mixer balance; wind the old mixer down.

This folds the "bridge-side redeem" entirely into the pool — no separate primitive, no second ledger. The
elegance is the point: tETH is just shielded ETH the pool custodies, and "redeem" is the unwrap that already
exists.
