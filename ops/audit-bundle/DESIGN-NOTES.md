# Design notes — intentional postures

These are deliberate design decisions. They are recorded here so a reviewer evaluates them for safety rather
than reporting them as accidental defects. Each is **deliberate — evaluate it for fund-safety and report it if
you judge it a risk.** The framing is context, not a boundary on what you may report. Verify each against the
code; a posture is not safe because it is listed here.

## 1. Open-bounty relay-fee model (settles are copyable / front-runnable by design)

`settle` carries a `FeePayment[] fees` array of in-system (scaled) value legs; the pool pays them to
`msg.sender` (`ConfidentialPool.sol`, the `fees` field is documented "settler fees … paid to msg.sender", and
the `_payout(... msg.sender ...)` legs). There is no privileged relayer set: anyone who can present a valid
proof + memos can settle and collect the bound fee, so a pending settle is copyable and front-runnable and
searchers race to land it. This is intended — the fee is an open bounty that makes settlement permissionless and
gasless for the user (the user need not hold ETH). The security claim is narrow: **copying a settle changes only
who earns the fee, never the value effects** — every destination, recipient, and amount is bound in the proof,
so a front-runner cannot redirect user value to itself, only win the settle race. `OP_SEND_AND_UNWRAP`'s
opening-sigma binds recipient+payout+fee+deadline specifically to stop a relay redirect; `fee == 0` means
self-settle. Evaluate whether any op leaks value to `msg.sender` beyond its declared fee, and whether the
copyability enables an ordering/griefing attack (this is the disclosed MEV surface).

## 2. One-live-funded-generation (operational, not on-chain-enforced)

Each asset lineage is expected to have exactly **one live funded pool generation** at a time: before a successor
pool is funded, the predecessor is drained. This stands in for an on-chain cross-generation replay control — it
is an **operational deployment invariant, not a contract check.** The relevant on-chain reasoning is the
cross-generation keying in `ConfidentialPool.sol` (the shared-id registry block): a bridged asset keys by its
**shared cross-chain id**, and the native-ETH (tETH) bitcoin link is fixed **only at construction**
(`TETH_BITCOIN_LINK`; `registerWrapped` rejects a native-ETH link), "consistent across generations, never a
permissionless first-writer choice." Soundness rests on the **escrow == supply** invariant, which is
fail-closed per generation (`InsufficientEscrow` reverts an unwrap on a shortfall). The residual — that a
retired generation still holding escrow could re-serve a proof — is defended operationally by draining the
predecessor, not by an on-chain generation counter. **Evaluate whether relying on the operational drain (rather
than an on-chain control) is acceptable for an immutable system, and report it as a disclosed risk if not.**

## 3. Native-nullifier invariants (leaf-based nullifier model)

A note's nullifier is a function of its **full authenticated membership leaf**, not its bare commitment
(`cxfer-core/src/lib.rs`):

- `nullifier(note_leaf) = keccak(note_leaf ‖ "spent")`.
- The leaf is domain-separated per home: `leaf(asset, Cx, Cy, owner)` for a native / Ethereum-homed note;
  `btc_note_leaf(asset, Cx, Cy, auth_key) = keccak(asset ‖ Cx ‖ Cy ‖ auth_key ‖ "tacit-btc-note-v1")` for a
  Bitcoin-homed note.

Invariants any future op/vkey must preserve:

1. **One nullifier per note.** Both lanes reconstruct the *identical* leaf for a Bitcoin note (asset + Cx,Cy +
   auth_key), so cross-lane `ν` matches and a note has exactly one nullifier.
2. **No cross-note collision.** Two notes differing in ANY authenticated field — asset, Bitcoin `auth_key`, or
   leaf domain — get DISTINCT nullifiers. The bare-commitment nullifier `keccak(Cx‖Cy)` is deliberately NOT the
   spend nullifier: it collides across notes sharing a commitment but differing in asset/key (constructible for
   any note whose opening is public, e.g. a swap receipt), which is why burns key by `burn_id`
   (see `DESIGN-unified-source-identity.md`) and `ν` is retained only for global cross-lane spentness.
3. **Reproducing a victim's leaf is not spend authority.** Even if an attacker reconstructs a Bitcoin note's
   exact leaf, spending it still requires the BIP-340 signature under its `auth_key` (see
   `DESIGN-btc-note-authority.md`). The `owner` label in a native leaf is likewise not spend authority — the
   bearer/kernel proof of blinding-knowledge is.

The KAT `nullifier_binds_full_authenticated_leaf` in `cxfer-core` pins invariants 1–2. **Evaluate any op that
constructs, spends, or reflects a note against these three invariants.**

## 4. DAO-governed `CollateralEngine` (trusted-but-privileged, not adminless)

`CollateralEngine` is Solady `Ownable`; its owner is a trusted role (expected timelock/multisig). The pool +
guests are immutable, but this contract is not. What the owner **can** do (all `onlyOwner`):

- `setPool(pool)` — **one-shot** and reciprocally bound (M-01): reverts unless the pool's immutable engine
  pointer already points back to this engine, so the owner cannot wire the engine to a different pool than the
  one that immutably committed to it.
- `setFeeds(ethBtc, btcUsd, ethBtcTwap, btcUsdTwap)`, `setDeviationBound(bps)`, `setParams(maxStaleness,
  escrowRatioBps, cdpRatioBps, liqRatioBps)`, `setEscrowHealthParams(maintenanceBps, graceWindow)`,
  `setEscrowEnforcementModule(module)`, `setStabilityFee(perSecondRay)` — the oracle wiring and CDP/escrow/TSR
  parameters.
- `drawInsurance` / `drawInsuranceFor(purpose, amount, to)` and `recoverSeizedCbtc(amount, to)` — draws from the
  insurance reserve / seized-cBTC balance.

Escrow enforcement is capped by an **immutable floor**: `enforceEscrowToReserve(outpoint)` is
`onlyEnforcementModule` and reverts unless `block.timestamp >= since + MIN_ESCROW_GRACE_WINDOW`, where
`MIN_ESCROW_GRACE_WINDOW = 3 days` is a constant. `setEscrowHealthParams` itself rejects a `graceWindow <
MIN_ESCROW_GRACE_WINDOW` (or `> 30 days`), so the owner cannot arm enforcement with, or execute it before, a
sub-3-day window. A locker therefore always has a public, non-instant window to redeem out after the unhealthy
flag, regardless of owner config. `address(0)` for the enforcement module disables enforcement entirely.

What the owner **cannot** do: change the pool it is bound to (one-shot + reciprocal), mint cUSD or move CDP
collateral outside the proof-gated ops, slash escrow without the grace window, or touch the immutable pool /
guests. **Evaluate the full owner surface as a trusted-role threat: what a malicious or compromised owner can
extract or freeze within these bounds, and whether the grace floor and reciprocal bind are sufficient.**
