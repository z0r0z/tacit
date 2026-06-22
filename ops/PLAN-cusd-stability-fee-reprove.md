# cUSD stability fee + TSR — re-prove punch-list

The cUSD stability fee + Tacit Savings Rate (TSR) lands on branch `cusd-stability-fee-savings`. The contract,
guest, and JS changes are complete and tested off-box (forge 586/0, cxfer 136/0, `tests/confidential-cdp.mjs`,
guest `cargo check`). Because the settle guest changed (the CDP position leaf now commits a `rate_snapshot`
field and the CDP public-values structs gained `rateSnapshot`/`repaid`), the `PROGRAM_VKEY` rotates — so this
feature is live only after a coordinated re-prove. The fee ships **dormant** (`stabilityFeePerSecond == 0`), so
on-chain behavior is identical to the interest-free CDP until governance turns it on; the re-prove is purely to
pin the new guest.

## What changed in the proven surface

- `cxfer-core::cdp_position_leaf` — gained a `rate_snapshot` argument (committed between `debt_value` and
  `owner`). JS mirror (`dapp/confidential-cdp.js`) + KAT byte-parity already match.
- `main.rs` CDP ops (`OP_CDP_MINT/CLOSE/LIQUIDATE/TOPUP`) — read `rate_snapshot` (r32, after the nonce), thread
  it through the leaf, and surface it. Close/liquidate relaxed the burn assert to a `repaid >= principal` floor
  (the engine enforces the exact accrued debt). Topup carries the snapshot forward. Farm ops carry the inert 0.
- `PublicValues` (Solidity + guest `sol!`) — `CdpMint +rateSnapshot`; `CdpClose/CdpLiquidate +repaid
  +rateSnapshot`; `CdpTopup +rateSnapshot`.

All fee arithmetic lives in the mutable `CollateralEngine` (drip/accrual + the TSR vault); the guest carries the
values only, so the guest delta is minimal.

## Box steps

1. Build the settle guest ELF from this branch; derive the new `PROGRAM_VKEY` (the relay/reflection vkey is
   unchanged — no reflection-guest change here).
2. Regenerate the CDP execute fixtures: `node scripts/build-cdp-cbtc-exec-fixtures.mjs` (already carry
   `rateSnapshot`), then run the four `cdp_{mint,close,liquidate,topup}-execute` reflect-exec bins against the
   rebuilt ELF — expect clean `EXECUTE_OK` (validates the new io serialization + dispatch).
3. Regenerate the on-chain Groth16 fixtures for the CDP `*ProofReal` tests against the new ELF
   (`cdp_mint/close/liquidate/topup/cbtc_mint_groth16.json`), and update the **local `PublicValues`/CDP struct
   mirrors** in `ConfidentialCdpCbtcProofReal.t.sol` (and any sibling *ProofReal file that decodes CDP fixtures)
   to the new field layout — they were intentionally left at the old layout while the on-disk fixtures were
   stale.
4. Pin the new `PROGRAM_VKEY` (`elf-vkey-pin.json`, `DeployConfidentialPool` default) and run
   `verify-vkey-pin.sh` + the full forge suite.

## Post-deploy activation (governance, no re-prove)

- `CollateralEngine.setStabilityFee(perSecondRay)` turns the fee on (RAY = 0% dormant; bounded by
  `MAX_FEE_PER_SECOND`). The TSR vault is already live — savers can bond/unbond cUSD anytime; rewards only
  accrue once the fee is on and fees are collected.
- Activation prerequisites (not code): cUSD has peg/exit liquidity, and borrow utilization is high enough that
  the fee funds a saver APY worth advertising.

## Prove→settle drift (handled in code, not deferred)

Once the fee is non-zero, `rate` drips every second, so the prover cannot hit the settle-time accrued debt
exactly. `onCdpClose`/`onCdpLiquidate` therefore accept the accrued `owed` within a 1% over-repay band (the
borrower burns a hair more to cover the prove→settle gap; the excess funds savers). This lives in the engine
code and ships now — the engine is fixed-at-deploy (Ownable, not a proxy) and the pool's `COLLATERAL_ENGINE` is
immutable, so it could NOT have been a post-deploy add. Dormant is unaffected (`rate` frozen ⇒ `owed ==
principal`, and a rational borrower burns exactly the principal).
