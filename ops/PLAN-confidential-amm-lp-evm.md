# Confidential LP for the Ethereum AMM (`OP_LP_ADD` / `OP_LP_REMOVE`)

Bring the Ethereum confidential AMM to LP parity with the Bitcoin AMM (`T_LP_ADD` /
`T_LP_REMOVE`): **LP positions held as shielded notes**, so a provider's stake size and
identity are hidden, while the pool reserves and total share supply stay public (verifiable
pricing). The swap half (`OP_SWAP`) is done; this is its LP mirror, same machinery.

## Model

- A pool gains a public `totalShares`. Each LP holds a confidential **LP-share note** — a
  shielded-pool note of a pool-specific LP asset (`lpAssetId = keccak(poolId ‖ "lp")`), whose
  hidden amount is their share count.
- **Public:** `reserveA/reserveB`, `totalShares` (so fractions are computable + pricing is
  verifiable). **Hidden:** each LP's share amount + identity. Individual add/remove sizes are
  hidden by batching — only the net reserve+share delta of a batch is public.
- The LP-share is an INTERNAL shielded asset (notes only) in the first cut — no public ERC20
  unwrap for shares (you remove liquidity to get the underlying back, not an LP token).

## `OP_LP_ADD` (guest)

Reads the pool `(R_A, R_B, totalShares)` + the LP's contribution. Asserts:
- Spend the LP's A note (`dA`) + B note (`dB`): membership in `spendRoot` + note-bound ν +
  the secp Pedersen opening (binds `dA`/`dB` to the notes — the same primitive `OP_SWAP` uses).
- **In-ratio:** `dA · R_B == dB · R_A` (+ a small remainder tolerance) — adding in the pool
  ratio leaves the price unchanged.
- **Proportional shares:** `dShares = floor(totalShares · dA / R_A)`. First add
  (`totalShares == 0`): `dShares = dA` — the A contribution is the share basis (avoids an
  in-guest sqrt; shares are arbitrary units, the first LP defines them).
- Mint the LP-share note (`dShares`) + emit `LpSettlement(poolId, R_A→R_A+dA, R_B→R_B+dB,
  totalShares→totalShares+dShares)`.

## `OP_LP_REMOVE` (guest)

- Spend the LP-share note (`dShares`): membership + ν + opening.
- `dA = floor(R_A · dShares / totalShares)`, `dB = floor(R_B · dShares / totalShares)`
  (floor toward the pool — withdrawing slightly less, the dust stays for the remaining LPs).
- Mint the A note (`dA`) + B note (`dB`) to the LP.
- Emit `LpSettlement(R_A→R_A−dA, R_B→R_B−dB, totalShares→totalShares−dShares)`.

## Contract

- `Pool` gains `uint256 totalShares`. `PublicValues` gains `LpSettlement[] liquidity`. `settle`
  applies each like the swap loop: gate the proven `(reservePre, sharesPre)` `==` live, then move
  to `(reservePost, sharesPost)`. The LP-share + asset notes flow through the existing
  `nullifiers` / `leaves` arrays — no new note mechanism.
- **Seed LP (the one design fork):** today `initPool` seeds reserves publicly (one funder). Two
  options for shares:
  - **(A, recommended) all-confidential:** `initPool` creates an EMPTY pool; the first liquidity
    (and its share note) come from an `OP_LP_ADD` with `totalShares == 0`. Every LP — including the
    first — is a shielded note, with a clean remove path. Costs: the swap tests that seed via
    `initPool` move to a seed `OP_LP_ADD`.
  - **(B, interim) public seed:** keep `initPool` funding + set `totalShares = reserveA`; the seed
    LP's position is public/permanent, later LPs are confidential. Simpler, but the seed LP can't
    confidentially remove. Use only as a stepping stone.

## Privacy / soundness

- **Confidential:** per-LP share amount + identity (the LP-share note); add/remove sizes hidden
  in the batch net.
- **Public + verifiable:** reserves, `totalShares`, the batch net delta.
- **Sound:** the in-ratio + proportional-share checks are in-guest integer math (like the clearing);
  the secp openings bind `dA`/`dB`/`dShares` to real notes (no over-claim); an in-ratio add/remove
  leaves the price (`R_A/R_B`) unchanged, so it neither moves the market nor lets an LP extract value.
  Combined with `OP_SWAP`'s `k`-non-decrease, the pool is protected against both swap and LP abuse.

## Build sequence (mirrors `OP_SWAP`)

1. **Contract** — `Pool.totalShares` + `LpSettlement` + `settle` application + tests (mock
   verifier). [LP C-1 — this commit]
2. **Guest** — `OP_LP_ADD` + `OP_LP_REMOVE` (reuse `verify_pedersen_opening` + the note machinery)
   + `PublicValues.liquidity[]`; a node round-trip mirroring the guest asserts. [LP C-2]
3. **Re-prove** the guest (swap + LP op set) → next vkey → on-chain real-proof + redeploy. [LP C-3]

Reuses: the shielded-pool notes, `OP_SWAP`'s reserve-settlement pattern, the secp Pedersen opening,
the SP1 stack. No new curve crypto, no ceremony — the LP-share is "just another note."
