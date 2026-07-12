# Production Trust Register

This register names every remaining privileged surface before mainnet and whether
that trust is justified. The target posture is: immutable proof/custody core,
permissionless user exits where possible, and policy only where the protocol
intentionally needs governance.

## Hard launch rules

- `CollateralEngine.owner()` on mainnet must be a contract multisig or timelock.
  Use `contracts/script/DeployCollateralEngine.s.sol`; mainnet defaults to and
  enforces the ops multisig `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`.
  Sepolia/test harness deploys default to bot admin
  `0x000000000e8CB9ed9DC2114d79d9215eacb9cB07`, or may override
  `ENGINE_ADMIN` with a canonical CREATE2-deployed timelocked multisig.
- `FarmController.lockUntil` is a deploy-time maximum lock. Farm governance may
  shorten or clear it, but cannot extend exits after users enter.
- `ConfidentialPool` has no owner. Its trust choices are immutable constructor
  pins: verifier, settle vkey, reflection vkey, factory, relay, genesis anchor,
  confirmation depth, and collateral engine.
- `BitcoinLightRelay.genesis` is a trusted one-shot checkpoint. Verify the exact
  epoch start, target, timestamp, anchor height/hash, and cumulative work against
  at least two independent Bitcoin sources before the deployer initializes it.
- User-facing launch assets must be pre-registered and allowlisted in the dapp
  config before gates flip. Protocol registration can stay permissionless; the UI
  list is the safety boundary for launch.

## Privileged Surfaces

| Surface | Privileged actor | Powers | Production requirement |
|---|---|---|---|
| `ConfidentialPool` | none | No owner/admin functions. Immutable verifier/vkey/factory/relay/engine pins decide proof trust and integrations. | Deploy only after `verify-vkey-pin.sh` and readiness gate pass; pin verifier/factory codehashes in deploy env. |
| `CollateralEngine` | owner | `setPool` once, set Chainlink/TWAP feeds, set deviation bound, set bounded risk params, draw ETH insurance reserve, recover seized public cBTC. | Owner is production multisig/timelock. Publish owner address, feeds, params, and reserve-draw policy before value launch. |
| cBTC escrow in `CollateralEngine` | none for normal exits | `claimEscrow` is funder-only and permissionless after proven redeem or before mint; `slash` is permissionless after proven rug. | No owner in release/slash path. Monitor terminal outpoints and reserve balance. |
| cUSD CDP controller | `ConfidentialPool` proof callbacks only | Mint/close/liquidate/topup hooks enforce policy; owner cannot mint cUSD directly. | Feeds fresh, sane, and monitored; TWAP deviation bound enabled once pool liquidity is deep enough. |
| `FarmController` | `gov` | Set reward rate/duration, recover leftover escrow after emission plus grace, shorten/clear lock. | `gov` should be the farm sponsor or DAO. Deploy with maximum intended lock; cannot extend later. |
| `BtcCallExecutor` | none | Permissionlessly fires a proven one-shot call to a contract target. | Every production hook target must require `msg.sender == executor` and authenticate `callerPubkey`/calldata for its own authority model. |
| `BitcoinLightRelay` | deployer for `genesis`; then none | Deployer seeds one checkpoint. After initialization, `advanceTip` and `retarget` are permissionless. | Treat genesis as a ceremony. Save source data and transaction hash in launch notes. |
| `CanonicalAssetFactory` / bridged ERC20s | none after construction | Factory deploys deterministic canonical tokens; token minter is immutable. | Pin factory codehash in deploy; launch UI allowlists expected canonical assets only. |
| `ConfidentialRouter` | none | Immutable periphery targets: pool, Permit2, optional zRouter. | Deploy only with code-backed targets. Router is replaceable periphery, not custody core. |

## CDP governance model (what the owner can and cannot do)

`ConfidentialPool` is ownerless: no key can mint canonical assets, release collateral, or move a note.
The CDP's economic policy, however, lives in `CollateralEngine`, which is owner-governed (production owner =
the ops multisig above). This is deliberate for V1 — the peg's oracle and risk params need to be tuned as the
market matures — so the CDP is **economically governed, not economically immutable**. The bounds below cap what
the owner can do; the residual power is a multisig trust assumption, stated here in full.

- **Risk params are bounded, not arbitrary.** `setParams` requires liquidation ratio ∈ [110%, mint ratio),
  mint/escrow ratio ≤ 1000%, staleness ≤ 1 day; `setStabilityFee` is 0 (dormant) or ≤ `MAX_FEE_PER_SECOND`.
  A governance fat-finger is fail-closed and bounded — the "raise fee/ratio to an extreme" scenario cannot set
  nonsensical values.
- **Owner draws are scoped to protocol capital, never user collateral.** `drawInsurance` only spends the
  `insuranceReserve` (reverts above it); `recoverSeizedCbtc` moves only the canonical cBTC ERC20 and cannot
  reach note backing/escrow (native ETH held for locks). No owner path transfers a user's live collateral.
- **The oracle is swappable, and the deviation guard is DORMANT at launch.** `setFeeds` validates only
  non-zero/has-code/decimals ≤ 18; the Chainlink↔AMM-TWAP deviation guard (`setDeviationBound`) is off at launch
  (single-source Chainlink, until the cUSD/cBTC pool is a trustworthy second source). So a compromised owner
  could point the mark at a manipulated feed and liquidate healthy positions at that mark. Mitigation posture:
  the owner is a multisig; enable the deviation guard as soon as pool depth allows; monitor feed changes.
- **Escrow enforcement is dormant + governance-activated, and applies to existing locks when armed.**
  `escrowMaintenanceBps`/`escrowEnforcementModule` are 0 at launch (inert). A fresh mint is never instantly
  enforceable (maintenance < mint ratio is enforced both ways), but arming enforcement can bring an already-
  unhealthy pre-existing lock into scope after its `graceWindow`. Activate only alongside the deviation guard.

Compromise of the owner multisig is therefore a fund-safety event for CDP collateral (via oracle manipulation),
not for confidential-pool notes. Publish the owner address, live feeds, params, deviation-bound status, and any
enforcement-module activation before value launch, and treat oracle/enforcement changes as monitored events.

## Guest build provenance (vkey ↔ ELF identity)

The three trusted SP1 vkeys the pool pins are bound to committed ELF bytes, which anyone can independently
check without rebuilding: derive each committed ELF's vkey with the SP1 SDK and compare to the pin +
`deployments/1.json`.

- `program_vkey 0x0093404c…` ← `elf/cxfer-guest` (settle guest, unchanged this cycle).
- `bitcoin_relay_vkey 0x000240e5…` ← `elf/reflection-prover` sha256 `c1e819ae…` (rebuilt this cycle for the
  forward-lane freshness change; derived on the prover box with cargo-prove sp1 6.2.3 / sp1-zkvm 6.2 via
  `reflect-exec` `vkey-derive`, and verified on-chain by `ConfidentialReflection[BurnDeposit]ProofReal`).
- `eth_reflection_vkey 0x00583f05…` ← the Mode-B eth-reflection guest (unchanged this cycle; Mode-B is not on
  the forward launch path).

`verify-vkey-pin.sh` asserts every committed Groth16 fixture binds to these pins. The one link not established
bit-for-bit is `source → ELF` reproducibility: the ELFs are built on a single prover box (not a pinned Docker
reproducible builder), so a third party cannot re-derive the exact ELF hash from source — they verify the
committed ELF ↔ vkey ↔ pin chain and review the ELF against source instead. A reproducible Docker rebuild
(`cargo prove build --docker`) is the follow-up that would close that last link for fully independent
verification; it is not required for the deployed guest to enforce the reviewed logic.

## CollateralEngine Deployment Placeholder

Mainnet sequence:

1. Deploy or choose the production multisig/timelock. Current ops multisig:
   `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2`.
2. Deploy the engine:

```bash
forge script contracts/script/DeployCollateralEngine.s.sol \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --verify
```

3. Deploy `ConfidentialPool` with `COLLATERAL_ENGINE=<engine>`.
4. Submit multisig transactions:

```text
CollateralEngine.setPool(<pool>)
CollateralEngine.setFeeds(<ethBtcFeed>, <btcUsdFeed>, <ethBtcTwapOrZero>, <btcUsdTwapOrZero>)
CollateralEngine.setParams(<maxStaleness>, <escrowRatioBps>, <cdpRatioBps>, <liqRatioBps>)
CollateralEngine.setDeviationBound(<bps>)
```

Use the deploy script's `ENGINE_POOL=<pool>` path only for tests or redeploys
where the pool already exists.

Sepolia/testing preference: use the bot-admin default for fast harness work, or
set `ENGINE_ADMIN=<create2-timelock-multisig>` when testing the timelocked
factory path. Mainnet remains pinned to the real ops multisig above.

## Launch Asset Register

Before flipping mainnet UI gates, record for each launch asset:

- symbol/name/decimals and whether it is native, wrapped escrow, canonical
  bridged, or pool-minted debt;
- expected `assetId`, underlying token address, `unitScale`, and cross-chain
  link, if any;
- registration transaction;
- UI allowlist location and commit;
- whether withdrawals are escrow-backed, mint-backed, or controller-minted.

Assets not in the allowlist may still exist at the protocol layer, but the UI
must not route launch users into them.

## Bitcoin Hook Target Checklist

For any contract that implements `IBitcoinHook.onBitcoinReflect`:

- require the canonical executor as `msg.sender`;
- bind the executor to the expected pool if the target depends on one pool only;
- authorize the action using `callerPubkey` and the Bitcoin-committed calldata;
- make repeated/retried calls idempotent at the target level where possible;
- never rely on ETH value, because Mode B calls are value-free.

## Relay Genesis Ceremony

Before calling `BitcoinLightRelay.genesis`:

- derive `epochStart`, `target`, `startTimestamp`, `tipHash`, `tipHeight`, and
  `tipWork` from a full node or deterministic script;
- cross-check the same fields against two independent explorers/APIs;
- confirm `target` equals the compact target decoded from the checkpoint's
  `nBits`;
- confirm `startTimestamp` is the timestamp of the epoch-start block, even when
  the anchor tip is mid-epoch;
- dry-run the first `advanceTip` batch from the checkpoint.
