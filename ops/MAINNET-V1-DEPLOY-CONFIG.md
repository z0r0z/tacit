# Mainnet V1 deploy config (DeployV1SuiteCreateX) — readiness checklist

The v1 CreateX vanity suite is immutable. Several constructor args set state ONCE and can never
be changed (vkeys, relay link, tETH↔cETH link, engine admin). This is the config that must be
correct on the mainnet broadcast. From the v0→v1 day-1 gap audit.

## ⚠️ Cross-scale fee-floor coherence (cETH at unitScale 1e10) — MAINNET BLOCKER
`RELAY_MIN_FEE` is expressed in **in-system value units**. The cETH floor `1e14` is calibrated for
`unitScale=1` (in-system == wei → 0.0001 ETH). At cETH's real scale (1e10: 18-dec ETH → 8-dec in-system),
`1e14` in-system = `1e24` wei ≈ **1,000,000 ETH** — every cETH relay/unwrap would demand an impossible fee,
so cETH is unusable at scale 1e10 (the mainnet config). The fix is NOT a one-liner: the floor must be
scale-adjusted PER ASSET (express the wei floor and divide by `unitScale`), and it is coupled to the display
paths and the test suite. Caught by the dapp/relay layer (owned there; a half-migration was reverted). MUST
land before cETH is live at 1e10. The Sepolia smoke test uses TAC at `unitScale=1`, so it is unaffected —
this is a mainnet-scale (and any 1e10-asset) coherence requirement, tracked here so it gates the launch.

**Concrete fix** (dapp-owned): the worker already derives the floor from gas correctly
(`worker/src/relay-quote.js:30 floorInFeeUnits`, `weiPerFeeUnit = unitScale`). The dapp
`quoteUnwrapFee` (confidential-pool-ux.js:667,679-685) should drop the hardcoded `RELAY_MIN_FEE` map and
either read the worker quote or compute `floorWei / unitScale` per asset (pull `unitScale` from asset meta,
as the wrap paths already do). Bundle the latent signet `cETH unitScale='1'` config (confidential-deployments.js:98)
into the same activation pass (the vanity-pool ctor enforces native-ETH `unitScale==1e10`).

**Cross-scale hunt — what is VERIFIED COHERENT (no fix needed):** the conversion path enforces
`amount % unitScale == 0` (`_amountToValue`/`_valueToAmount`, ConfidentialPool.sol:2130/2237 → AmountNotAligned)
so there is no dust truncation/theft; display/holdings divide ERC20 18-dec by `unitScale` (unified-holdings.js,
evm-lane-reader.js) so balances render in the underlying; CollateralEngine works entirely in 8-dec in-system
units (CUSD_DEC/CBTC_DEC ctor-pinned 8) so the 1e10 ERC20 scale never enters the cdpRatio/liqRatio gates —
min-collateral/liquidation thresholds are scale-independent. The ONLY scale footgun is the cETH relay fee floor.

**Immutable-ctor pins to VERIFY against live values before broadcast (unfixable after):** `TETH_BITCOIN_ID`
(guarded), and the engine's cBTC asset id + decimals — note the engine ctor REVERTS on a wrong cbtc id/decimals
(`cbtcAssetId != CANONICAL_CBTC_ASSET_ID || cusdDec != 8 → revert`, CollateralEngine.sol:260-265), so a wrong
cBTC pin fails CLOSED at deploy (the live Sepolia deploy succeeding already proves the cBTC pin is correct).

## Vanity addresses
- 7 mined salts (`SALT_FACTORY/ADAPTER/ENGINE/POOL/ROUTER/RELAYER/BTC_CALL_EXECUTOR`), **4 leading
  zero BYTES** (8 hex chars, `0x00000000…`). Cross-chain-identical via CREATE3 (initcode-independent,
  sender/chainid-free guard). Mainnet uses the same salts → the same addresses as the chosen canonical set.
- `REQUIRE_VANITY=1` (default on mainnet) — fails closed if any address lacks the 4-zero-byte prefix.

## Fail-closed-guarded (the script reverts on mainnet if wrong)
- `SP1_VERIFIER` — the immutable mainnet SP1VerifierGroth16 leaf (must be a contract).
- `EXPECTED_VERIFIER_CODEHASH` — required on mainnet; asserts the verifier codehash.
- `ENGINE_ADMIN` == `MAINNET_OPS_MULTISIG`.
- `PROGRAM_VKEY` / `BITCOIN_RELAY_VKEY` — must equal `elf-vkey-pin.json` (`0x00f36e4c` / `0x00a01b68`).
- `TETH_BITCOIN_ID` — nonzero (the canonical mainnet tETH Bitcoin id) unless `ALLOW_NO_TETH_LINK=1`.
  The pool ctor pins `localAssetOf[TETH_BITCOIN_ID]=cETH` ONCE; a zero here permanently kills the
  tETH↔cETH bridge. **Must equal** the dapp config `bitcoinLink` (confidential-deployments.js).
- Reflection ON — `BITCOIN_RELAY_VKEY` nonzero unless `ALLOW_NO_REFLECTION=1`; with a nonzero relay
  vkey the ctor also requires `HEADER_RELAY` and `GENESIS_REFLECTION_ANCHOR` (else it reverts).

## NOT guarded — verify manually before the immutable broadcast
1. `HEADER_RELAY` — the real mainnet BitcoinLightRelay (else reflection/cBTC/cross-chain are permanently dead).
2. `GENESIS_REFLECTION_ANCHOR` + `REFLECTION_CONFIRMATIONS` (default 6) + `REFLECTION_RESUME_DIGEST` —
   coherent with the mainnet relay tip; anchor matured (relay tip ≥ anchor + confirmations) before first attest.
3. `CANONICAL_FACTORY` — leave UNSET to deploy fresh; if reused it must be a deployed contract
   (the pool ctor reverts `NotAContract` on zero-code, but set it deliberately).
4. `ZROUTER` / `PERMIT2` — the canonical mainnet singletons (verify the defaults).
5. Chainlink feeds (hardcoded): ETH/USD + BTC/USD + staleness — verify still current for mainnet.
6. `TAC_UNDERLYING` — the REAL bridged TAC ERC20 (cTAC id = `_evmAssetId(TAC_ERC20)`, so the ERC20
   address determines the id; must match what holders use).

## Post-deploy (NOT in the deploy script — the day-1 seeding)
The CreateX suite deploys only the 7 core contracts. Day-1 product surface requires, against the new pool:
- `registerWrapped(TAC)` (+ any day-1 assets); cBTC/cUSD resolve from the engine (already deployed).
- 5 TAC-centric pools via `createPair`: TAC/cETH, TAC/cBTC, cUSD/cBTC, cUSD/cETH, cETH/cBTC.
- 5 `FarmController`s + funding (`farmEscrow` → `notifyRewardAmount`).
- LP/farm seed liquidity via box-proven settles (`tests/v1-day1-bootstrap-*.mjs`).
- Re-run `tools/sync-deployment-config.mjs <manifest>` to populate dapp `assetIds` + `farmControllers`
  (otherwise the dapp shows only cETH and no tradeable cTAC/cBTC/cUSD or Earn UI).

## Dapp reconcile
- `cross-chain-asset-resolver.js` merges tETH(BTC)+cETH(ETH) from the config-declared `bitcoinLink`, not
  an on-chain read of `localAssetOf` — so config `bitcoinLink` MUST equal the deployed `TETH_BITCOIN_ID`
  (or add an on-chain assert). Preflight `node ops/scripts/signet-preflight.mjs` checks the equality
  `localAssetOf(bitcoinLink) == assetId`.
- cBTC link asymmetry (no deploy footgun, dapp declaration TODO): unlike cETH's env-driven `TETH_BITCOIN_ID`,
  tacBTC's link is pinned from the CONSTANT `CBTC_ZK_ASSET_ID` (`0x62a20d98…`) at the ctor (ConfidentialPool.sol:797),
  so `localAssetOf[0x62a20d98] = tacBTC` is ALWAYS set (verified live: `0x1d52487121aa6b42…`). On-chain: nothing
  to pass. Dapp: declare `bitcoinLink = 0x62a20d98…` for the cBTC/tacBTC row so the resolver merges the
  cBTC.zk(BTC)+tacBTC(ETH) lanes (the preflight equality already passes for it).

## Asset-id continuity (v0→v1) — GOOD, no action
`_evmAssetId = sha256("tacit-evm-token-v1" ‖ chainid ‖ underlying)` is pool-independent, so cETH/cTAC/
cBTC/cUSD ids are identical across v0, v1, and any redeploy on the same chain — v0 holders' notes resolve
by asset id on v1 (note membership is per-pool state and does not auto-port; the id namespace is shared).
