# Mainnet V1 deploy config (DeployV1SuiteCreateX) — readiness checklist

The v1 CreateX vanity suite is immutable. Several constructor args set state ONCE and can never
be changed (vkeys, relay link, tETH↔cETH link, engine admin). This is the config that must be
correct on the mainnet broadcast. From the v0→v1 day-1 gap audit.

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
  (or add an on-chain assert). A launch preflight should check this equality.

## Asset-id continuity (v0→v1) — GOOD, no action
`_evmAssetId = sha256("tacit-evm-token-v1" ‖ chainid ‖ underlying)` is pool-independent, so cETH/cTAC/
cBTC/cUSD ids are identical across v0, v1, and any redeploy on the same chain — v0 holders' notes resolve
by asset id on v1 (note membership is per-pool state and does not auto-port; the id namespace is shared).
