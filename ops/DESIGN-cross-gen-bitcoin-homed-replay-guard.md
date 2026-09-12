# Cross-generation Bitcoin-homed replay guard

## The problem, precisely

`ConfidentialPool.sol:1897` — inside `_settle`, for every Bitcoin-homed nullifier in a batch:

```solidity
bitcoinConsumed[nu] = _hash(pv.spendRoot, pv.bitcoinConsumedSources[i]);
```

This is the ONE chokepoint every Bitcoin-homed spend passes through, regardless of what the spend is
for: `crossOut` (ETH→BTC burn), minting a confidential leaf that a later unwrap converts to real
escrow (tETH-style bridged assets), a swap, a withdrawal to a pool-minted asset — all of them write
here. `bitcoinConsumed` is per-pool storage. Two independent `ConfidentialPool` deployments that both
near-tip-anchor to the same shared Bitcoin reflection each keep their own copy, so the same real
Bitcoin-homed note (same ν, since ν is deliberately pool-independent) can pass this check once per
pool, independently.

**Where this is actually dangerous vs. not**, verified in code, not assumed:
- Bitcoin's own ledger is safe regardless: `T_CROSSOUT_MINT`'s `claim_id` is folded into the
  reflection guest's own consumed-set (`reflect.rs`), which is part of the single shared digest every
  pool attests to — a real BTC-side double-mint is cryptographically impossible.
- `cbtcMint` is self-limiting: gated on `CollateralEngine.escrowSufficient`, which requires
  *actively, currently funded* per-outpoint escrow (`CollateralEngine.sol:607-611`) — a dead pool can
  never satisfy this for a lock created after it's abandoned.
- Pure-Tacit assets (TAC): a Bitcoin-homed batch can only mint a pool-minted asset on exit, never pay
  real escrow directly (`ConfidentialPool.sol:1863-1868`) — a duplicate mint on an abandoned pool
  produces a token with a forked address nobody lists or provides liquidity for. Bounded by market
  choice, not cryptography, but the team controls that choice completely.
- **Escrow-backed bridged assets are the real, unresolved gap.** These exit as a confidential leaf
  first, and a *later, separate* unwrap draws real escrow using the pool's ordinary nullifier check —
  which never re-verifies the original Bitcoin-side source is still unconsumed elsewhere. Two pools
  can each mint their own copy of the leaf and each independently back an unwrap from their own real
  escrow. This is the path the guard below actually needs to close.

## The fix

A same-chain Merkle-Patricia storage proof, verified against a recent `blockhash()`, proving that
`bitcoinConsumed[nu]` is still unset on every listed predecessor pool, required before `_settle`
writes to `bitcoinConsumed[nu]` on THIS pool. No new trusted party, no light client, no SP1 guest
change, no re-prove — this is pure, standard Solidity, the same class of technique L2 bridges already
use for "prove what another contract's storage holds, trustlessly, same-chain."

### Why this, and not the alternatives already rejected in conversation
- Not a shared registry contract with admin-gated registration: that either reintroduces a
  discretionary gatekeeper (a real, if narrow, centralization dependency) or, if made permissionless,
  is trivially griefable (anyone can pre-consume an observed ν with no ownership proof at all).
- Not a cross-chain light-client proof (Mode-B style): that's solving a same-chain bookkeeping
  question with cross-chain-grade machinery, and it doesn't generalize past one specific pool pair.
- Not "wait for reverse reflection": reverse reflection requires a real Bitcoin confirmation (a
  physical, ~10-minute-plus floor, and in practice a manual multi-tool process today) — the fast lane
  and confidential leaf minting both exist specifically to be instant, so gating them on Bitcoin's own
  pace deletes the feature it's trying to protect.

### Honest properties, not oversold
- **This is not a zero-risk-window guarantee.** `blockhash()` only resolves for the last 256 blocks,
  so the proof establishes "unspent as of a recent block," not "unspent at the instant of inclusion."
  The minimum achievable window, using the immediately preceding block as the reference, is about one
  Ethereum block (~12 seconds) — the time between witness construction and transaction landing. This
  is a dramatic reduction from today's unbounded exposure (reverse reflection essentially never runs),
  not an elimination of risk. Say this plainly to anyone reviewing it.
- **Batching cost is real and needs a number before this ships.** An MPT exclusion proof per
  nullifier, times N nullifiers in a batch, is not free — needs a concrete gas measurement against a
  real predecessor pool's trie depth before deciding whether per-nullifier proofs are affordable at
  realistic batch sizes, or whether the check should be restricted to nullifiers above some value
  threshold (a real optimization, but one that reintroduces a "how do we know the value without
  revealing it" wrinkle worth thinking through separately — do not assume it away).
- **Only protects generations that build it in.** This has to be in gen1's constructor-time bytecode;
  it cannot be added later, and it does nothing for the abandoned test-alpha pools that came before —
  their exposure stays exactly what's already been verified: negligible today, and structurally unable
  to grow since nobody will ever fund them again.

## What's still an open decision, not yet resolved

1. **Which predecessor pool addresses does gen1 check against?** An immutable array set at
   construction — needs the actual list of every prior deployment (including the alpha/test ones) that
   could plausibly hold a note reflected into the same shared Bitcoin pool root. This list needs to be
   assembled and verified complete, not guessed.
2. **MPT verifier library choice.** Use an existing, audited implementation (e.g., the pattern used by
   established L2 storage-proof bridges) — do not hand-roll trie verification for something this
   security-critical.
3. **Unconditional per-nullifier check, or value-gated?** Depends on the gas measurement above.
   Recommend starting unconditional (simplest to reason about and audit) and only optimizing if the
   gas cost is actually prohibitive at realistic batch sizes — premature optimization here trades
   audit-simplicity for savings that may not be needed.
4. **Does this also need to gate the cBTC-mint path for defense-in-depth**, even though it's not
   load-bearing there? Cheap to include once the mechanism exists; not required for safety.

## Recommendation

Do not deploy gen1 without this wired in — it's the one path (escrow-backed bridged assets) that
isn't already closed by an existing, verified property of the system, and it can never be retrofitted
once the contract is immutable. Resolve the four open decisions above, get a real gas measurement,
write the attack-scenario test (two pools, same note, same escrow-backed asset, second unwrap must
revert), then build.
