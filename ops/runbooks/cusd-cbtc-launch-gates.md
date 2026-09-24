# Runbook: cUSD / cBTC config gates before opening the ramp

`CollateralEngine` is immutable, so every item here is an ops multisig call, not a code change. Do them
in this order; two have a one-way arming step with no undo.

## Before touching the oracle: wire both TWAP sources first

`setDeviationBound` only checks that the bound is in range — it does **not** check that a TWAP source
exists, and it cannot be disarmed once set. `_price` applies the deviation cross-check only when both a
TWAP source and a non-zero bound are present, so calling `setDeviationBound` first gets you a
chain-readable `maxDeviationBps` while `_price` is still silently trusting a single raw feed.

**Order:** wire both TWAP sources → confirm `_price` actually rejects a synthetic deviation between them
→ only then call `setDeviationBound`. Today `maxDeviationBps` is 0 and both TWAP slots are unset — this
is a single-source oracle. (Audit: G-2026-09-24 S-1.)

## Before arming the margin call: have a keeper ready to clear the flag

`enforceEscrowToReserve` accepts any `escrowUnhealthySince` timestamp once the grace window has elapsed
— it does not check the flag is fresh. `flagEscrowUnhealthy` sets it once; nothing requires
`clearEscrowFlag`/`clearEscrowFlagIfHealthy` to ever be called. A flag raised during a brief dip months
earlier still satisfies the grace check on a later, unrelated dip.

**Do not set `escrowEnforcementModule` or a non-zero `escrowMaintenanceBps` without a keeper running that
clears the flag as soon as escrow recovers.** If the enforcement module itself is replaceable, prefer one
that also refuses to act on a flag older than `escrowGraceWindow + MIN_ESCROW_GRACE_WINDOW`. Today
`escrowMaintenanceBps` is 0 and no module is set — the margin call is dormant. (Audit: G-2026-09-24 S-2.)

## The rest of the cUSD/cBTC ramp's unmet gates (config, not code)

- `insuranceReserve` is 0 against live cUSD debt.
- No debt ceiling exists and none can be added post-deploy — the only throttle is raising `cdpRatioBps`
  above its 1.5x default.
- No cUSD liquidity yet, so the liquidator set is a subset of the borrower set.

Full detail and root cause for all of the above: `ops/reviews/AUDIT-2026-09-24-pashov-solidity-auditor-v4.md`
§4 (S-1, S-2) and §7 (the rest of the gate list).
