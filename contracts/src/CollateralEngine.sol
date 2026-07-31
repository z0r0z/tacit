// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// @dev The immutable ConfidentialPool surface this engine reads/serves. The pool is the authority for
///      all proven Bitcoin/CDP state; the engine only sizes escrows, prices collateral, and routes
///      narrow recovery/backstop actions — it can NEVER mint a confidential asset, move backing, or break a
///      peg (all of which are proof-enforced in the pool).
interface IConfidentialPoolCollateral {
    /// The pool's immutable engine pointer — used by `setPool` for a reciprocal binding check, so an
    /// engine can never be wired to a pool that does not point back to it.
    function COLLATERAL_ENGINE() external view returns (address);
    /// Σ live self-custody cBTC.zk lock sats — the real-BTC backing behind cBTC (reflection-attested,
    /// oracle-free; the pool advances it each attestation). RESERVED integration point, NOT a v1 dependency:
    /// the cBTC peg is enforced by CONSERVATION in the proof (OP_CBTC_MINT mints exactly v_btc against a
    /// recorded lock; redeem burns exactly v_btc — backing == supply per-lock), and the v1 rug deterrent is
    /// the per-lock slashable native-ETH escrow + the reserve below. This aggregate is consumed only by the
    /// (standalone, governable) peg-shortfall buffer — a post-v1 additive;
    /// it is declared here as that buffer's integration point so wiring it later needs no interface churn.
    function cbtcBackingSats() external view returns (uint256);
    /// The authoritative reflection-proven sats locked at an outpoint — the value the margin-call path judges
    /// health against, so it never trusts a module-supplied figure.
    function cbtcLockVBtc(bytes32 outpoint) external view returns (uint64);
    /// True once the reflection surfaced this lock outpoint as SPENT (`cbtcLocksSpent`) — a bare spend (rug).
    function cbtcLockSpent(bytes32 outpoint) external view returns (bool);
    /// True once the reflection PROVED this lock honestly redeemed (`cbtcLocksRedeemed`): the single-tx
    /// atomic swap unlocked the lock AND burned exactly its sats of cBTC. The trustless escrow-release gate.
    function cbtcLockRedeemed(bytes32 outpoint) external view returns (bool);
    /// True once cBTC was minted against this lock (the escrow became live).
    function cbtcMinted(bytes32 outpoint) external view returns (bool);
    /// The canonical ERC20 the pool mints/escrows for an asset id (resolving a shared id to its local
    /// entry), or address(0) if none. The stranded-cBTC recovery resolves the cBTC token through this, so it
    /// can only ever move the exact cBTC.tac token the pool mints on public cBTC withdrawal.
    function canonicalTokenFor(bytes32 assetId) external view returns (address);
}

/// @notice Chainlink aggregator (answer in `decimals()` places). Used for ETH/BTC (escrow sizing) and
///         BTC/USD (cUSD collateral pricing). Decentralized quorum, freshness-checked, fail-closed.
interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// @notice An on-chain AMM-derived TWAP (the shielded-pool / canonical pool) used as the second source
///         that bounds the Chainlink feed (fail-closed on excess deviation). `price` is in `decimals` places.
interface IAmmTwap {
    function twap() external view returns (uint256 price, uint8 decimals);
}

/// @title CollateralEngine
/// @notice The unified collateral / reserve core for Tacit confidential DeFi v1 — the conjoined
///         buffer + protocol reserve + per-locker escrow + cUSD CDP controller (supersedes `CbtcBuffer` +
///         `InsuranceVault`). All POLICY lives here (mutable, Solady `Ownable` → DAO); the immutable
///         `ConfidentialPool` calls `onCdpMint/Close/Liquidate/Topup` and reads `escrowSufficient` but holds
///         the proofs. Two roles:
///
///         1. **cBTC escrow (native ETH, Chainlink ETH/BTC sized):** a self-custody locker posts a
///            refundable native-ETH escrow keyed by their Bitcoin lock outpoint, `≥ escrowRatio · v_btc`.
///            On a reflection-PROVEN honest redeem each funder permissionlessly `claimEscrow`s its share (the reflection surfaces
///            a redeem vs. a rug); on a proven rug anyone may `slash` it to the reserve — no owner in the path. Chainlink sizes the escrow only,
///            never cBTC's peg (which is conservation, oracle-free) — an oracle failure mis-sizes the
///            deterrent, it cannot de-peg cBTC.
///
///         2. **cUSD CDP controller (Chainlink BTC/USD):** this contract IS the cUSD controller, so the
///            cUSD asset id = `keccak("tacit-cdp-debt-v1" ‖ address(this))` and it is the sole minter.
///            `onCdpMint` enforces `debt_usd ≤ collateral_btc · price_btc_usd / cdpRatio`; `onCdpLiquidate`
///            requires the position be below `liqRatio` (reverts if healthy). Unlike cBTC, cUSD is a CDP
///            stablecoin: BTC/USD IS load-bearing for its peg (the DAI model).
///
///         A shared native-ETH protocol reserve (funded by slashed escrows and explicit top-ups) backstops
///         rug-recovery shortfall and CDP bad debt. V1 keeps one reserve for simplicity; owner should be a
///         DAO/timelock or purpose-built policy contract for progressively more programmatic draws.
contract CollateralEngine is Ownable, ReentrancyGuard {
    bytes32 public constant CANONICAL_CBTC_ASSET_ID =
        0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8;
    uint8 public constant CANONICAL_CBTC_DECIMALS = 8;

    // The fixed-point base for the cUSD debt accumulator `rate` (Maker's RAY). `rate` starts at RAY (=1.0)
    // and only ever grows, so a position's accrued debt is `principal · rate / rateSnapshot` where
    // `rateSnapshot` is `rate` captured at mint. Per-second compounding factor `stabilityFeePerSecond` is
    // also RAY-scaled: RAY (or 0) == 0% == dormant. The cUSD savings rate (TSR — the Tacit Savings Rate) is
    // funded out of collected stability fees.
    uint256 internal constant RAY = 1e27;
    // Governance sanity ceiling on the per-second fee factor (~RAY + 1e20 ≈ a few-hundred-%/yr cap), so a
    // fat-finger can grow `rate` but never explode it. Policy lives below this; the cap only bounds blunder.
    uint256 internal constant MAX_FEE_PER_SECOND = RAY + 1e20;

    // The cUSD savings rate (TSR) reward-per-share precision. Pinned to 2**64 to equal the settle guest's
    // FARM_RPS_PRECISION (the savings vault reuses the farm receipt ops), so a position's entry stamp advances
    // consistently with this engine's accumulator. The bound `reward·PRECISION ≤ shares·(rps − entry)` is
    // PRECISION-independent (it cancels), so this only sets the sub-unit dust granularity.
    uint256 internal constant SAVINGS_PRECISION = 2 ** 64;
    /// Immutable floor on the escrow-enforcement grace window. Even the DAO owner cannot arm
    /// enforcement with a shorter delay, so a locker always has at least this long — after the on-chain
    /// `EscrowFlaggedUnhealthy` event — to redeem/exit and remove their escrow from the slashable set. This
    /// caps the owner's seizure power to "slow + publicly-observable", never instant/silent, regardless of the
    /// feed or enforcement module it configures.
    uint256 internal constant MIN_ESCROW_GRACE_WINDOW = 3 days;
    bytes32 internal constant SAVINGS_RECEIPT = bytes32(uint256(1)); // positionLeaf == 1 (guest farm sentinel)
    // positionLeaf == 2: a governance surplus draw. Governance realizes the accumulated fee surplus as a cUSD
    // re-mint, so all realized fee cUSD is always re-mintable. A distinct reserved sentinel (2) that a real
    // keccak position leaf can never equal (a preimage hashing to 0x0…02 is infeasible), disjoint from the
    // payout (0) and farm-receipt (1) sentinels.
    bytes32 internal constant SURPLUS_RECEIPT = bytes32(uint256(2));

    // The pool. Set once (owner) after deploy — NOT immutable — to break the engine↔pool circular dep:
    // the pool's COLLATERAL_ENGINE pointer is immutable, so the engine is deployed FIRST (pool unknown),
    // the pool is deployed with the engine's address, then setPool wires it back. After the one-time set
    // it is fixed (re-set reverts), so it is immutable in practice.
    IConfidentialPoolCollateral public POOL;
    bytes32 public immutable CBTC_ASSET_ID; // the one canonical real-BTC asset (collateral)
    bytes32 public immutable CUSD_ASSET_ID; // = cdp_debt_asset_id(address(this)); cUSD is this controller's asset
    uint8 public immutable CBTC_DEC; // cBTC base-unit decimals (sats scale, e.g. 8)
    uint8 public immutable CUSD_DEC; // cUSD base-unit decimals (e.g. 8)

    // --- owner-governed (owner → DAO); pricing/ratios are policy, never the peg ---
    IAggregatorV3 public ethBtcFeed; // answer = BTC per 1 ETH
    IAggregatorV3 public btcUsdFeed; // answer = USD per 1 BTC
    IAmmTwap public ethBtcTwap; // optional 2nd source bounding ethBtcFeed (0 = single-source)
    IAmmTwap public btcUsdTwap; // optional 2nd source bounding btcUsdFeed — the cUSD peg is BTC/USD-load-bearing
    uint256 public maxStaleness = 3600; // Chainlink freshness (seconds), fail-closed
    uint256 public maxDeviationBps; // |chainlink − amm| bound vs the TWAP (0 = skip; set once a pool deepens)
    uint256 public escrowRatioBps = 15000; // cBTC escrow over-collateralization (1.5×) vs the locked BTC value
    uint256 public cdpRatioBps = 15000; // cUSD mint collateralization floor (1.5×): debt_usd ≤ collateral_usd / ratio
    uint256 public liqRatioBps = 12500; // cUSD liquidation threshold (1.25×): below this, a position is seizable

    // --- cBTC escrow accounting (native ETH per lock outpoint, per funder) ---
    // Per-(outpoint, funder) so "anyone may fund" is preserved AND each funder reclaims exactly its own
    // share trustlessly once the reflection proves the redemption (no owner, no recipient choice).
    mapping(bytes32 => mapping(address => uint256)) public escrowOf; // outpoint → funder → posted wei
    mapping(bytes32 => uint256) public escrowTotal; // outpoint → Σ unclaimed escrow (the escrowSufficient gate)
    mapping(bytes32 => bool) public escrowSlashed; // outpoint → already slashed (one-shot; shares become unclaimable)

    // --- cBTC escrow health (governance-gated margin call) — DORMANT at launch ---
    // A forward-compatibility seam so an escrow margin-call can be ACTIVATED post-launch WITHOUT redeploying
    // the engine: the pool pins COLLATERAL_ENGINE immutably, so a later engine swap would force a full
    // generational migration of all escrow + cUSD state. Same dormant-then-governance-activate pattern as the
    // cUSD stability fee above — the storage, view, and module-gated entrypoints ship now but do NOTHING until
    // the owner sets BOTH a maintenance ratio AND an enforcement module. The peg is never involved: this only
    // sizes/acts on the rug insurance, never cBTC's conservation backing.
    uint256 public escrowMaintenanceBps; // 0 = dormant; else the health floor in [10000, escrowRatioBps) below
    // which a live lock's escrow is enforceable (a margin call), denominated like escrowRatioBps
    uint256 public escrowGraceWindow; // seconds an outpoint must stay flagged-unhealthy before it can be enforced
    address public escrowEnforcementModule; // 0 = no enforcement (dormant); else the owner-set, audited module
    // that judges health (sourcing the lock's vBtc) and calls flag/enforce
    mapping(bytes32 => uint256) public escrowUnhealthySince; // outpoint → first-flagged timestamp (0 = unflagged)

    // --- cUSD CDP accounting ---
    uint256 public outstandingCusd; // total cUSD PRINCIPAL minted across open positions (base units)
    // Aggregate normalized debt (RAY-scaled): Σ principal_i·RAY/snap_i over open positions, so aggregate
    // accrued debt is `normalizedDebtRay·rate/RAY`. Bumped on mint, retired on close/liquidate. It lets `drip`
    // credit the exact aggregate fee delta (`normalizedDebtRay·Δrate/RAY`) into the fee budget AS the fee
    // accrues — so the fee cUSD is injectable (saver harvest / surplus draw) BEFORE a borrower must burn it to
    // repay, which is what keeps the system solvent under wind-down. Dormant (rate frozen) ⇒ Δ is always 0.
    uint256 public normalizedDebtRay;

    // --- cUSD stability fee (DAI-style debt accumulator) ---
    // `rate` compounds at `stabilityFeePerSecond`; a position's current debt is `principal · rate / snap`.
    // Shipped DORMANT: `stabilityFeePerSecond` defaults to 0 (treated as RAY = 0%), so `rate` never moves and
    // every position owes exactly its principal — provably identical to the interest-free path. Governance
    // turns the fee on later via `setStabilityFee`. `feesAccruedCusd` is the cumulative fee (over-repayment)
    // collected from closes/liquidations; each fee is credited into this engine's TSR budget/RPS in the same
    // callback that accounts for the burn — so the savings cUSD is always fee-backed.
    uint256 public rate; // RAY-scaled debt accumulator (set to RAY in the ctor; monotonically non-decreasing)
    uint256 public stabilityFeePerSecond; // RAY-scaled per-second factor; 0 or RAY == dormant (0% APY)
    uint256 public lastDrip; // timestamp `rate` was last compounded
    // The collected-but-undistributed stability fee: each close/liquidation over-repays by the accrued
    // interest (which the borrower burned), crediting this budget. It is a re-mint AUTHORIZATION — the cUSD
    // was destroyed, so the engine-resident savings vault (the TSR) may later re-mint up to this much cUSD to
    // savers (decrementing it), keeping supply conserved. cUSD is pool-minted and the engine is its sole
    // authority, so the TSR must be engine-resident (a separate controller could not mint cUSD).
    uint256 public feeBudgetCusd;
    uint256 public feesAccruedCusd; // cumulative fee ever collected (monitoring; never decremented)
    // The surplus of realized fee cUSD not yet claimed by savers: the portion of `feeBudgetCusd` that no live
    // savings position's rps entitlement points at — accrual with no savers, accrual-distribution rounding
    // dust, and the un-harvested tails forfeited at unbond / partial harvest. Tracked so every unit of
    // `feeBudgetCusd` is backed by a claim (`feeBudgetCusd == saverUnclaimed + surplusFeeCusd`), leaving no
    // burned fee cUSD stranded unrepresented. Stays 0 while the fee is dormant.
    uint256 public surplusFeeCusd;

    // A one-shot governance authorization to realize part of `surplusFeeCusd` as a cUSD re-mint. The owner (DAO)
    // pre-binds BOTH the amount AND the exact destination note the surplus mints into; a keeper can then build
    // the settle proof that mints it but can neither inflate the amount nor redirect the funds. `amount == 0`
    // means no pending authorization. Set by `authorizeSurplusDraw`, consumed once by a surplus `onCdpMint`.
    struct SurplusDraw {
        uint256 amount;
        bytes32 destCommitment;
    }

    SurplusDraw public pendingSurplusDraw;

    // --- cUSD savings rate (TSR), engine-resident ---
    // Savers lock cUSD via the guest's farm bond/harvest/unbond ops (controller == this engine), which the pool
    // already routes through onCdpMint(positionLeaf == 1)/onCdpClose. Reward-per-share grows when a stability
    // fee is collected (`_accrueFee`), pro-rata to staked cUSD — a Synthetix accumulator funded by realized
    // fees rather than an emission rate. Harvested rewards are cUSD minted fresh (MINT mode), bounded BOTH by
    // the saver's rps entitlement AND by `feeBudgetCusd` (so saver cUSD is always fee-backed). Dormant fee ⇒
    // savingsRps never grows ⇒ savers earn nothing (and harvest, requiring reward > 0, simply can't be built).
    uint256 public savingsRps; // Σ fee·PRECISION/totalSavingsShares — cUSD reward per staked cUSD
    uint256 public totalSavingsShares; // total cUSD currently bonded into the TSR
    // Σ over live savings positions of `shares_i · savingsEntryRps_i` — the MasterChef reward debt. Bumped by
    // `shares·savingsRps` at bond, by `shares·(savingsRps − entry)` at each harvest, retired exactly at unbond.
    // `savingsRps·totalSavingsShares − totalSavingsRewardDebt` is the exact unclaimed saver entitlement.
    uint256 public totalSavingsRewardDebt;
    // Per-position savings checkpoint, keyed by the guest's receipt leaf and STAMPED AT EXECUTION — the live
    // `savingsRps` is unknowable when the bond proof is built, so a pre-committed entry always drifts. Mirrors
    // FarmController.entryRps; `savingsEntryStamped` is the liveness bit (a bond at savingsRps == 0 is real).
    mapping(bytes32 => uint256) public savingsEntryRps;
    mapping(bytes32 => bool) public savingsEntryStamped;

    // Q-01 backstop. The pool processes all cdpMints (TSR savings bonds) before any cdpClose/liquidation
    // within one settle (= one tx), so a bond stamped earlier in the tx must not capture a distribution made
    // later in it. That is now structurally impossible: `drip()` is the only thing that moves `savingsRps`,
    // every entrypoint drips as its FIRST action, and a drip accrues at most once per block — so the tx's
    // single distribution always precedes any bond in it. This flag remains as a fail-closed assertion of that
    // property; it should never fire. Cleared automatically at tx end (transient storage).
    uint256 private transient _tsrSavingsBondedThisTx;

    // --- shared protocol reserve (native ETH) ---
    uint256 public insuranceReserve; // wei; funded by slash proceeds + explicit top-ups, backstops bad debt

    event FeedsSet(address ethBtcFeed, address btcUsdFeed);
    event ParamsSet(uint256 maxStaleness, uint256 escrowRatioBps, uint256 cdpRatioBps, uint256 liqRatioBps);
    event EscrowPosted(bytes32 indexed outpoint, address indexed from, uint256 amount);
    event EscrowReleased(bytes32 indexed outpoint, address indexed to, uint256 amount);
    event EscrowSlashed(bytes32 indexed outpoint, uint256 amount, uint256 toReserve);
    event EscrowHealthParamsSet(uint256 maintenanceBps, uint256 graceWindow);
    event EscrowEnforcementModuleSet(address module);
    event EscrowFlaggedUnhealthy(bytes32 indexed outpoint, uint256 at);
    event EscrowFlagCleared(bytes32 indexed outpoint);
    event EscrowEnforced(bytes32 indexed outpoint, uint256 amount);
    event CdpMinted(bytes32 indexed positionLeaf, uint256 debtValue, uint256 collateralUsd);
    event CdpClosed(bytes32 indexed positionNullifier, uint256 debtValue);
    event CdpLiquidated(bytes32 indexed positionNullifier, uint256 debtValue, uint256 collateralUsd);
    event CdpToppedUp(
        bytes32 indexed oldPositionNullifier,
        bytes32 indexed newPositionLeaf,
        uint256 debtValue,
        uint256 oldCollateralUsd,
        uint256 newCollateralUsd
    );
    event StabilityFeeSet(uint256 perSecondRay);
    event Dripped(uint256 rate, uint256 at);
    event CdpFeeAccrued(bytes32 indexed positionNullifier, uint256 fee);
    event SavingsSharesChanged(uint256 totalSavingsShares);
    event SavingsHarvested(uint256 reward, uint256 feeBudgetRemaining);
    event SurplusDrawAuthorized(uint256 amount, bytes32 destCommitment);
    event SurplusDrawn(uint256 amount, bytes32 destCommitment, uint256 feeBudgetRemaining);
    event InsuranceFunded(address indexed from, uint256 amount);
    event InsuranceDrawn(address indexed to, uint256 amount);
    event InsuranceDrawnFor(bytes32 indexed purpose, address indexed to, uint256 amount);
    event SeizedCbtcRecovered(address indexed token, address indexed to, uint256 amount);

    // Ordered by identifier length, then alphabetically.
    error BadFeed();
    error BadPool();
    error NotPool();
    error BadAmount();
    error BadEscrow();
    error BadParams();
    error StaleFeed();
    error BadPurpose();
    error BadSnapshot();
    error BadRepayment();
    error EscrowLocked();
    error EscrowHealthy();
    error FeedDeviation();
    error ZeroRecipient();
    error NothingToSlash();
    error PoolAlreadySet();
    error BadPositionLeaf();
    error BadSavingsShape();
    error GraceNotElapsed();
    error PositionHealthy();
    error NothingToRelease();
    error SavingsOverClaim();
    error NotCbtcCollateral();
    error EnforcementDisabled();
    error InsufficientReserve();
    error SavingsNoLivePosition();
    error SavingsPositionExists();
    error Undercollateralized();
    error NotEnforcementModule();
    error DebtAccountingUnderflow();
    error SameSettleSavingsBondAndFee();
    error SurplusNoPending();
    error SurplusMismatch();

    modifier onlyPool() {
        _onlyPool();
        _;
    }

    function _onlyPool() internal view {
        if (msg.sender != address(POOL)) revert NotPool();
    }

    modifier onlyEnforcementModule() {
        if (escrowEnforcementModule == address(0) || msg.sender != escrowEnforcementModule) {
            revert NotEnforcementModule();
        }
        _;
    }

    constructor(address pool, bytes32 cbtcAssetId, uint8 cbtcDec, uint8 cusdDec, address admin) {
        if (
            admin == address(0) || cbtcAssetId != CANONICAL_CBTC_ASSET_ID || cbtcDec != CANONICAL_CBTC_DECIMALS
                || cusdDec != 8
        ) {
            revert BadParams();
        }
        if (pool != address(0) && pool.code.length == 0) revert BadPool();
        POOL = IConfidentialPoolCollateral(pool);
        CBTC_ASSET_ID = cbtcAssetId;
        CBTC_DEC = cbtcDec;
        CUSD_DEC = cusdDec;
        // cUSD = this controller's derived debt asset (mirrors cxfer-core::cdp_debt_asset_id): the pool
        // checks `debtAsset == keccak("tacit-cdp-debt-v1" ‖ controller)`, so this engine is its sole minter.
        CUSD_ASSET_ID = keccak256(abi.encodePacked("tacit-cdp-debt-v1", bytes20(uint160(address(this)))));
        // Debt accumulator starts at 1.0 and is dormant (0% APY) until governance turns the fee on.
        rate = RAY;
        lastDrip = block.timestamp;
        _initializeOwner(admin);
    }

    /// @notice Wire the pool once after deploy (the engine↔pool circular-dep break). Reverts if already set,
    ///         zero, or non-contract, so it is fixed after the one call. No-op path for tests/deploys that pass
    ///         the pool in the ctor.
    function setPool(address pool) external onlyOwner {
        if (address(POOL) != address(0)) revert PoolAlreadySet();
        if (pool == address(0) || pool.code.length == 0) revert BadPool();
        // Reciprocal binding: the pool must point back to THIS engine. Without this the owner could
        // wire the engine to a different pool than the one that immutably committed to it, so callbacks from
        // the real pool fail `onlyPool` and escrow sizing/release reads the wrong pool's cBTC state while cBTC
        // is outstanding here. The pool's COLLATERAL_ENGINE is immutable, so this bind is correct forever.
        if (IConfidentialPoolCollateral(pool).COLLATERAL_ENGINE() != address(this)) revert BadPool();
        POOL = IConfidentialPoolCollateral(pool);
    }

    // ─────────────────────── owner-governed knobs ───────────────────────

    function setFeeds(address ethBtc, address btcUsd, address ethBtcTwap_, address btcUsdTwap_) external onlyOwner {
        if (ethBtc == address(0) || btcUsd == address(0) || ethBtc.code.length == 0 || btcUsd.code.length == 0) {
            revert BadFeed();
        }
        if (
            (ethBtcTwap_ != address(0) && ethBtcTwap_.code.length == 0)
                || (btcUsdTwap_ != address(0) && btcUsdTwap_.code.length == 0)
        ) {
            revert BadFeed();
        }
        // Bound feed decimals at config time so the priced paths' `10 ** dec` can never overflow or
        // mis-scale; a real Chainlink BTC/USD feed is 8 dp, every sane feed is ≤ 18. This keeps the
        // failure at configuration (owner-visible) rather than later at user settlement.
        if (IAggregatorV3(ethBtc).decimals() > 18 || IAggregatorV3(btcUsd).decimals() > 18) revert BadFeed();
        ethBtcFeed = IAggregatorV3(ethBtc);
        btcUsdFeed = IAggregatorV3(btcUsd);
        ethBtcTwap = IAmmTwap(ethBtcTwap_);
        btcUsdTwap = IAmmTwap(btcUsdTwap_);
        emit FeedsSet(ethBtc, btcUsd);
    }

    /// @notice Set the Chainlink↔AMM-TWAP deviation bound (bps). 0 disables it (single-source Chainlink) —
    ///         the launch posture until the cUSD / cBTC pool deepens enough to be a trustworthy 2nd source;
    ///         the design wants it active for the BTC/USD (cUSD-peg) feed.
    function setDeviationBound(uint256 bps) external onlyOwner {
        if (bps > 10_000) revert BadParams();
        maxDeviationBps = bps;
    }

    function setParams(uint256 _maxStaleness, uint256 _escrowRatioBps, uint256 _cdpRatioBps, uint256 _liqRatioBps)
        external
        onlyOwner
    {
        // Liquidation threshold must sit below the mint floor (else a fresh mint is instantly liquidatable) and
        // at least 110%: a 100% floor lets governance configure liquidations at par (no liquidator margin →
        // structural bad debt on every seize); 110% keeps an incentive + solvency buffer above the debt.
        // Escrow below 100% of the locked BTC value weakens the cBTC rug deterrent; 0 staleness is a footgun.
        // Upper ceilings are sanity bounds (a governance fat-finger is fail-closed but bounded anyway): a
        // ratio over 10x is nonsensical for a CDP, and accepting prices older than a day defeats freshness.
        // When the escrow margin call is armed, the mint ratio must stay strictly above the maintenance ratio
        // (the same invariant setEscrowHealthParams enforces from the other side), so a ratio cut can't make a
        // fresh mint instantly enforceable.
        if (
            _maxStaleness == 0 || _maxStaleness > 1 days || _escrowRatioBps < 10_000 || _escrowRatioBps > 100_000
                || _liqRatioBps < 11_000 || _liqRatioBps >= _cdpRatioBps || _cdpRatioBps > 100_000
                || (escrowMaintenanceBps != 0 && _escrowRatioBps <= escrowMaintenanceBps)
        ) {
            revert BadParams();
        }
        maxStaleness = _maxStaleness;
        escrowRatioBps = _escrowRatioBps;
        cdpRatioBps = _cdpRatioBps;
        liqRatioBps = _liqRatioBps;
        emit ParamsSet(_maxStaleness, _escrowRatioBps, _cdpRatioBps, _liqRatioBps);
    }

    /// @notice Set the cBTC escrow margin-call params. `maintenanceBps` 0 disables it (the launch DORMANT
    ///         default); a non-zero value must sit in [100%, escrowRatioBps) — at/above full BTC coverage
    ///         (enforcing below 1× is pointless) and strictly below the mint ratio (else a fresh mint is
    ///         instantly enforceable). Enforcement ALSO requires an enforcement module; setting only this
    ///         still leaves the system inert. Recommended to enable only once the BTC/USD deviation guard
    ///         (`setDeviationBound`) is active. `graceWindow` capped at 30 days.
    function setEscrowHealthParams(uint256 maintenanceBps, uint256 graceWindow) external onlyOwner {
        if (
            maintenanceBps != 0
                && (
                    maintenanceBps < 10_000 || maintenanceBps >= escrowRatioBps
                        || graceWindow < MIN_ESCROW_GRACE_WINDOW || graceWindow > 30 days
                )
        ) {
            revert BadParams();
        }
        escrowMaintenanceBps = maintenanceBps;
        escrowGraceWindow = graceWindow;
        emit EscrowHealthParamsSet(maintenanceBps, graceWindow);
    }

    /// @notice Set (or clear with address(0)) the escrow-enforcement module — the ONLY caller of
    ///         `flagEscrowUnhealthy` / `enforceEscrowToReserve`. address(0) ⇒ enforcement fully disabled (the
    ///         DORMANT launch default). The module judges health off its own view of the lock's vBtc; the
    ///         engine bounds a buggy/compromised module's damage: enforcement only ever moves a live lock's
    ///         escrow to the protocol reserve (never to an external address), capped, one-shot, health
    ///         re-checked on-chain.
    function setEscrowEnforcementModule(address module) external onlyOwner {
        if (module != address(0) && module.code.length == 0) revert BadPool();
        escrowEnforcementModule = module;
        emit EscrowEnforcementModuleSet(module);
    }

    // ─────────────────────── cUSD stability fee (TSR) — governance-gated ───────────────────────

    /// @notice Set the per-second cUSD stability-fee factor (RAY-scaled). RAY (or 0) == 0% APY (dormant) —
    ///         the launch default. Drips first so the change applies only going forward (no retroactive
    ///         accrual). Bounded by `MAX_FEE_PER_SECOND` so a fat-finger can't explode `rate`. Turning this
    ///         above RAY activates the TSR: closes/liquidations then over-repay by the accrued interest,
    ///         which this engine credits into the TSR budget/RPS.
    /// @dev A positive fee accrues the aggregate interest at RAY granularity while a position is charged its
    ///      owed at base-unit ceil; at the single-base-unit boundary these disagree in ONE direction only: the
    ///      floored aggregate accrual is ≤ the per-position ceil, so on a full wind-down the last fee-bearing
    ///      position can owe one unit more than was authorized and be unable to close (its collateral locks).
    ///      This is fund-safe — no cUSD is created or stolen — but it means a positive fee under-collects rather
    ///      than over-mints in this generation. Retirement books only the burn above the accrued `owed`, so the
    ///      reconstruction gap can never surface as drawable surplus; drawable surplus is always ≤ the fee value
    ///      the burn actually collected. Exactly closing the wind-down under-collection needs per-position fee
    ///      accounting (a future-generation redesign; see ops/DESIGN-fee-per-position-redesign.md). The
    ///      zero-normalized-debt inflation path is closed separately at mint.
    function setStabilityFee(uint256 perSecondRay) external onlyOwner {
        if (perSecondRay != 0 && (perSecondRay < RAY || perSecondRay > MAX_FEE_PER_SECOND)) revert BadParams();
        drip();
        stabilityFeePerSecond = perSecondRay;
        emit StabilityFeeSet(perSecondRay);
    }

    /// @notice Authorize governance to realize part of the accumulated fee surplus as a cUSD re-mint. Binds BOTH
    ///         the `amount` and the exact destination note (`destCommitment`, the minted note leaf) the surplus
    ///         mints into: a keeper builds the settle proof but can neither inflate the draw nor redirect it.
    ///         One-shot — a fresh authorization overwrites any prior un-consumed one. `amount` is capped by the
    ///         current surplus (which only grows until drawn), so the draw can never exceed realized surplus.
    function authorizeSurplusDraw(uint256 amount, bytes32 destCommitment) external onlyOwner nonReentrant {
        if (amount == 0 || amount > surplusFeeCusd) revert BadAmount();
        if (destCommitment == bytes32(0)) revert BadParams();
        pendingSurplusDraw = SurplusDraw(amount, destCommitment);
        emit SurplusDrawAuthorized(amount, destCommitment);
    }

    /// @notice Compound `rate` forward to now at the current fee. Permissionless + idempotent within a block;
    ///         every CDP hook calls it first so accrual is always current. No-op while dormant.
    function drip() public {
        uint256 t = block.timestamp;
        uint256 last = lastDrip;
        if (t <= last) return;
        uint256 fee = stabilityFeePerSecond;
        if (fee <= RAY) {
            lastDrip = t;
            return; // dormant (0 or 1.0): rate is frozen, owed == principal
        }
        uint256 rateOld = rate;
        // rate *= (fee/RAY)^dt  — Solady rpow gives (fee)^dt scaled by RAY; fullMulDiv re-scales by `rate`.
        uint256 rateNew = FixedPointMathLib.fullMulDiv(FixedPointMathLib.rpow(fee, t - last, RAY), rateOld, RAY);
        rate = rateNew;
        lastDrip = t;
        emit Dripped(rateNew, t);
        // Accrue the interest that just compounded — the exact aggregate delta `normalizedDebtRay·Δrate/RAY` —
        // into the fee budget + savers NOW, so the fee cUSD is claimable/drawable before any borrower must burn
        // it to repay. This is the solvency-preserving move: the fee is minted-authorized as it accrues, not
        // only after a close realizes it.
        if (rateNew > rateOld && normalizedDebtRay != 0) {
            _accrueFee(FixedPointMathLib.fullMulDiv(normalizedDebtRay, rateNew - rateOld, RAY), bytes32(0));
        }
    }

    /// @dev Accrued debt of a position: `principal · rate / snap`, rounded UP (favor the protocol). `snap` is
    ///      `rate` captured at mint (∈ [RAY, rate]); when it equals `rate` (dormant, or freshly minted) the
    ///      debt is exactly `principal`. Reads `rate` — callers drip() first so it is current.
    function _owed(uint256 principal, uint256 snap) internal view returns (uint256) {
        if (snap < RAY || snap > rate) revert BadSnapshot();
        if (rate <= snap) return principal;
        return FixedPointMathLib.fullMulDivUp(principal, rate, snap);
    }

    /// @notice The current accrued debt for a position of `principal` opened at `snapshot`, at the latest mark
    ///         (drips a pending interval in memory). UI/keeper helper.
    function currentDebt(uint256 principal, uint256 snapshot) external view returns (uint256) {
        uint256 r = rate;
        uint256 fee = stabilityFeePerSecond;
        if (fee > RAY && block.timestamp > lastDrip) {
            r = FixedPointMathLib.fullMulDiv(FixedPointMathLib.rpow(fee, block.timestamp - lastDrip, RAY), r, RAY);
        }
        if (snapshot < RAY || snapshot > r) revert BadSnapshot();
        if (r <= snapshot) return principal;
        return FixedPointMathLib.fullMulDivUp(principal, r, snapshot);
    }

    // ─────────────────────── validated Chainlink prices (fail-closed) ───────────────────────

    function _price(IAggregatorV3 feed, IAmmTwap twap) internal view returns (uint256 price, uint8 dec) {
        if (address(feed) == address(0)) revert BadFeed();
        (uint80 roundId, int256 ans,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        if (ans <= 0) revert BadFeed();
        if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxStaleness) {
            revert StaleFeed();
        }
        if (answeredInRound < roundId) revert StaleFeed(); // a carried-over (incomplete) round
        // forge-lint: disable-next-line(unsafe-typecast)
        price = uint256(ans);
        dec = feed.decimals();
        // 2nd-source sanity bound: |chainlink − amm| / amm ≤ maxDeviationBps. Skipped when unset (launch
        // single-source) — fail-closed once wired, so a single bad/manipulated feed round can't set the mark.
        if (address(twap) != address(0) && maxDeviationBps != 0) {
            (uint256 amm, uint8 ammDec) = twap.twap();
            // Bound the TWAP decimals too (the Chainlink-only setFeeds bound left this gap): a miswired/hostile
            // TWAP returning extreme decimals would overflow `10 ** ammDec` and revert every priced path.
            if (ammDec > 18) revert BadFeed();
            uint256 cl18 = price * 1e18 / (10 ** uint256(dec));
            uint256 amm18 = amm * 1e18 / (10 ** uint256(ammDec));
            uint256 diff = cl18 > amm18 ? cl18 - amm18 : amm18 - cl18;
            if (amm18 == 0 || diff * 10_000 > maxDeviationBps * amm18) revert FeedDeviation();
        }
    }

    /// @notice Native-ETH (wei) equal in value to `vBtc` cBTC base units at the validated ETH/BTC mark.
    function ethWeiForBtc(uint256 vBtc) public view returns (uint256) {
        (uint256 price, uint8 dec) = _price(ethBtcFeed, ethBtcTwap); // BTC per ETH, `dec` places
        // wei = vBtc / 10^CBTC_DEC (BTC) ÷ (price/10^dec) (BTC/ETH) × 10^18
        return vBtc * (10 ** uint256(dec)) * 1e18 / (price * (10 ** uint256(CBTC_DEC)));
    }

    /// @notice USD value (in cUSD base units) of `vBtc` cBTC base units at the validated BTC/USD mark.
    function btcToUsd(uint256 vBtc) public view returns (uint256) {
        (uint256 price, uint8 dec) = _price(btcUsdFeed, btcUsdTwap); // USD per BTC, `dec` places
        // usd = vBtc / 10^CBTC_DEC (BTC) × price/10^dec (USD/BTC) × 10^CUSD_DEC
        return vBtc * price * (10 ** uint256(CUSD_DEC)) / ((10 ** uint256(dec)) * (10 ** uint256(CBTC_DEC)));
    }

    // ─────────────────────── cBTC escrow (native ETH) ───────────────────────

    /// @notice The native-ETH escrow required to back a cBTC lock of `vBtc` sats (`escrowRatio · ETH(vBtc)`).
    function requiredEscrow(uint256 vBtc) public view returns (uint256) {
        return ethWeiForBtc(vBtc) * escrowRatioBps / 10_000;
    }

    /// @notice True iff the lock outpoint holds at least `requiredEscrow(vBtc)` native ETH — the gate the
    ///         pool's cBTC mint reads before minting cBTC against the lock. A spent/redeemed/slashed outpoint is
    ///         terminal and can never become sufficient again. (Re-mint is independently barred by the pool.)
    function escrowSufficient(bytes32 outpoint, uint256 vBtc) external view returns (bool) {
        if (address(POOL) != address(0) && (POOL.cbtcLockSpent(outpoint) || POOL.cbtcLockRedeemed(outpoint))) {
            return false;
        }
        return !escrowSlashed[outpoint] && escrowTotal[outpoint] >= requiredEscrow(vBtc);
    }

    /// @notice Informational escrow-health read at the validated (deviation-bounded) ETH/BTC mark. `have` is the
    ///         outpoint's posted escrow; `want` is `escrowMaintenanceBps · ETH(vBtc)`; `healthy` is `have ≥
    ///         want` — and is always true while the maintenance ratio is dormant (0), so this never reports an
    ///         unhealthy lock before governance arms the margin call. The authoritative per-lock `vBtc` is read
    ///         from the pool (`cbtcLockVBtc`), not from the caller, so a flag/enforce module can't inflate it.
    ///         Reverts on a stale/deviating feed (fail-closed), like every priced path here.
    function checkEscrowHealth(bytes32 outpoint) public view returns (bool healthy, uint256 have, uint256 want) {
        have = escrowTotal[outpoint];
        uint256 bps = escrowMaintenanceBps;
        if (bps == 0) return (true, have, 0);
        if (address(POOL) == address(0)) revert BadPool();
        want = ethWeiForBtc(POOL.cbtcLockVBtc(outpoint)) * bps / 10_000;
        healthy = have >= want;
    }

    /// @notice Post (or top up) the refundable native-ETH escrow for a Bitcoin lock outpoint. Anyone may
    ///         fund (per-funder share); it is reclaimable via `claimEscrow` once the reflection proves the
    ///         redemption (or before any cBTC mint), and slashable on a proven rug. Zero-value posts and
    ///         terminal outpoints are rejected to avoid inert or unslashable escrows.
    function postEscrow(bytes32 outpoint) external payable {
        if (outpoint == bytes32(0) || msg.value == 0) revert BadEscrow();
        if (escrowSlashed[outpoint]) revert EscrowLocked();
        if (address(POOL) != address(0) && (POOL.cbtcLockSpent(outpoint) || POOL.cbtcLockRedeemed(outpoint))) {
            revert EscrowLocked();
        }
        escrowOf[outpoint][msg.sender] += msg.value;
        escrowTotal[outpoint] += msg.value;
        // Deliberately does NOT clear any margin-call flag: a top-up that fails to restore health must not
        // reset the grace clock, else a dust top-up could perpetually dodge enforcement. Enforcement re-checks
        // health on-chain, so a top-up that genuinely restores it already blocks enforcement; the module
        // resets the clock for a real cure via clearEscrowFlag.
        emit EscrowPosted(outpoint, msg.sender, msg.value);
    }

    /// @notice Trustlessly reclaim your escrow share — PERMISSIONLESS, no owner, no recipient choice (the
    ///         refund goes to the funder). Allowed when the reflection PROVED the lock honestly redeemed
    ///         (`cbtcLockRedeemed`: cBTC burned + lock unlocked atomically), OR no cBTC was ever minted against
    ///         it (`!cbtcMinted`: a still-pending escrow). A proven rug is instead slashed to the reserve.
    ///         Safe before a mint: the cBTC mint reads `escrowSufficient` atomically, so reclaiming first only
    ///         makes that mint see too little escrow and decline — no cBTC is ever minted against a reclaimed
    ///         escrow. Bounded: returns posted ETH, never mints cBTC or touches backing.
    function claimEscrow(bytes32 outpoint) external nonReentrant {
        if (outpoint == bytes32(0)) revert BadEscrow();
        if (address(POOL) == address(0)) revert BadPool();
        if (escrowSlashed[outpoint]) revert EscrowLocked();
        // Locked only while it backs OUTSTANDING cBTC (minted ∧ not-yet-redeemed); claimable iff redeemed OR
        // never minted.
        if (POOL.cbtcMinted(outpoint) && !POOL.cbtcLockRedeemed(outpoint)) revert EscrowLocked();
        uint256 amt = escrowOf[outpoint][msg.sender];
        if (amt == 0) revert NothingToRelease();
        escrowOf[outpoint][msg.sender] = 0;
        escrowTotal[outpoint] -= amt;
        // Force-send: the recorded funder is the only authorized recipient, so a funder that cannot receive a
        // plain ETH call would otherwise strand its own escrow permanently (balance already zeroed above).
        SafeTransferLib.forceSafeTransferETH(msg.sender, amt);
        emit EscrowReleased(outpoint, msg.sender, amt);
    }

    /// @notice Slash a rugged lock's WHOLE escrow to the reserve: permissionless, but only when the reflection
    ///         has PROVEN the lock spent (`cbtcLockSpent`) and cBTC was actually minted against it. The guest
    ///         surfaces a bare lock spend as `cbtcLockSpent` and an honest in-tx redeem as `cbtcLockRedeemed`
    ///         (mutually exclusive: a redeem retires the lock before the rug scan, so it never enters
    ///         `cbtcLockSpent`) — so spent ∧ minted ⇒ rug. One-shot; the per-funder shares are left in place
    ///         but become unclaimable (`claimEscrow` reverts on a slashed outpoint). The slashed ETH backs the
    ///         now-unbacked cBTC via the protocol reserve; DAO policy can spend that reserve on an async cBTC
    ///         rug buy-and-burn. Separate from cUSD CDP liquidation, which burns debt inside the pool proof.
    function slash(bytes32 outpoint) external {
        if (outpoint == bytes32(0)) revert BadEscrow();
        if (address(POOL) == address(0)) revert BadPool();
        if (escrowSlashed[outpoint]) revert EscrowLocked();
        if (!POOL.cbtcMinted(outpoint) || !POOL.cbtcLockSpent(outpoint)) revert NothingToSlash();
        _slashToReserve(outpoint);
    }

    /// @notice Shared escrow→reserve sweep used by both the rug `slash` and the (dormant) margin-call
    ///         `enforceEscrowToReserve`: zero the outpoint's escrow, mark it slashed (one-shot; shares become
    ///         unclaimable), and credit the protocol reserve. ETH never leaves to an external address.
    function _slashToReserve(bytes32 outpoint) internal returns (uint256 amt) {
        amt = escrowTotal[outpoint];
        if (amt == 0) revert NothingToSlash();
        escrowTotal[outpoint] = 0;
        escrowSlashed[outpoint] = true;
        insuranceReserve += amt;
        emit EscrowSlashed(outpoint, amt, amt);
    }

    /// @notice Flag a live lock's escrow as unhealthy, starting its grace clock — module-gated, DORMANT until a
    ///         module + maintenance ratio are set. Idempotent (keeps the earliest flag). A redeemed / spent /
    ///         never-minted / already-slashed outpoint has no live escrow to enforce. The locker cures by
    ///         topping up (`postEscrow`, permissionless), which clears the flag.
    function flagEscrowUnhealthy(bytes32 outpoint) external onlyEnforcementModule {
        if (escrowMaintenanceBps == 0) revert EnforcementDisabled();
        if (address(POOL) == address(0)) revert BadPool();
        if (
            escrowSlashed[outpoint] || !POOL.cbtcMinted(outpoint) || POOL.cbtcLockRedeemed(outpoint)
                || POOL.cbtcLockSpent(outpoint)
        ) revert EscrowLocked();
        (bool healthy,,) = checkEscrowHealth(outpoint);
        if (healthy) revert EscrowHealthy();
        if (escrowUnhealthySince[outpoint] == 0) {
            escrowUnhealthySince[outpoint] = block.timestamp;
            emit EscrowFlaggedUnhealthy(outpoint, block.timestamp);
        }
    }

    /// @notice Clear an outpoint's unhealthy flag — module-gated. Lets an honest module reset the grace clock
    ///         when it observes a genuine cure (a later dip then re-flags with fresh grace). Intentionally NOT
    ///         a top-up side effect (a dust top-up must not dodge enforcement). Adds no power a module lacks
    ///         anyway — it can simply decline to enforce. Inert until a module is set.
    function clearEscrowFlag(bytes32 outpoint) external onlyEnforcementModule {
        if (escrowUnhealthySince[outpoint] != 0) {
            escrowUnhealthySince[outpoint] = 0;
            emit EscrowFlagCleared(outpoint);
        }
    }

    /// @notice Permissionlessly clear an outpoint's unhealthy flag once it is GENUINELY cured (healthy at the
    ///         current on-chain mark). Anyone may call — the locker's own recourse to reset the grace clock
    ///         after a real top-up or price recovery, so a later independent unhealthy episode starts a FRESH
    ///         public grace window instead of inheriting the already-elapsed one. Conditioned on actual health,
    ///         so a dust top-up cannot use it to dodge enforcement: while the escrow is still unhealthy the flag
    ///         stands (reverts), and enforcement re-checks health anyway.
    function clearEscrowFlagIfHealthy(bytes32 outpoint) external {
        if (escrowUnhealthySince[outpoint] == 0) return; // nothing flagged
        (bool healthy,,) = checkEscrowHealth(outpoint);
        if (!healthy) revert EscrowHealthy(); // still unhealthy — the flag and its grace clock stand
        escrowUnhealthySince[outpoint] = 0;
        emit EscrowFlagCleared(outpoint);
    }

    /// @notice Margin-call remedy: slash a flagged, grace-elapsed, STILL-unhealthy live lock's escrow to the
    ///         reserve. Module-gated and DORMANT until armed. Bounded exactly like `slash` (reserve-only,
    ///         capped, one-shot) and re-checks health on-chain so a cured escrow can't be enforced on a stale
    ///         flag. The locker's recourse throughout the grace window is to top up.
    function enforceEscrowToReserve(bytes32 outpoint) external onlyEnforcementModule {
        if (escrowMaintenanceBps == 0) revert EnforcementDisabled();
        if (address(POOL) == address(0)) revert BadPool();
        if (
            escrowSlashed[outpoint] || !POOL.cbtcMinted(outpoint) || POOL.cbtcLockRedeemed(outpoint)
                || POOL.cbtcLockSpent(outpoint)
        ) revert EscrowLocked();
        (bool healthy,,) = checkEscrowHealth(outpoint);
        if (healthy) revert EscrowHealthy();
        uint256 since = escrowUnhealthySince[outpoint];
        // The configured grace AND the immutable floor must both have elapsed — so a locker always had at least
        // MIN_ESCROW_GRACE_WINDOW after the public unhealthy flag to redeem out, regardless of owner config.
        if (
            since == 0 || block.timestamp < since + escrowGraceWindow
                || block.timestamp < since + MIN_ESCROW_GRACE_WINDOW
        ) revert GraceNotElapsed();
        uint256 amt = _slashToReserve(outpoint);
        emit EscrowEnforced(outpoint, amt);
    }

    // ─────────────────────── cUSD CDP controller (called by the pool) ───────────────────────

    /// @notice Authorize a cUSD mint: enforce `debt_usd ≤ Σ collateral_usd / cdpRatio`. The pool has already
    ///         proven the collateral basket is locked + the debt note minted; this applies the price/ratio
    ///         policy and reverts to DENY. v1 accepts only cBTC collateral legs (multi-asset baskets are a
    ///         future controller, no re-prove).
    function onCdpMint(CdpLeg[] calldata legs, uint256 debtValue, bytes32 positionLeaf, uint256 rateSnapshot)
        external
        onlyPool
    {
        // Drip BEFORE anything reads or mutates savings shares / rps. A share change must never straddle a
        // pending accrual: interest that accrued before a bond existed belongs to the savers who were bonded
        // while it accrued, so compounding it first is what stops a just-in-time bond from capturing it.
        // Mirrors FarmController._accrue() at the head of its receipt callbacks. Idempotent within a block, so
        // the later CDP-mint path costs nothing extra, and every subsequent op in the same settle no-ops.
        drip();
        // TSR savings bond/harvest (the guest's farm receipt sentinel). debtValue == 0 ⇒ bond, > 0 ⇒ harvest.
        if (positionLeaf == SAVINGS_RECEIPT) {
            // `rateSnapshot` carries the guest's RECEIPT LEAF for a savings receipt — inert as a fee snapshot
            // there (a savings position accrues no cUSD debt), so it needs no widened controller tuple.
            _savingsReceipt(legs, debtValue, bytes32(rateSnapshot));
            return;
        }
        // Governance surplus draw: realize part of the accumulated fee surplus as a cUSD re-mint. `debtValue` is
        // the minted amount; `rateSnapshot` carries the destination commitment the guest minted to (the note
        // leaf), so the engine binds the destination the owner pre-authorized — a keeper can prove the mint but
        // cannot inflate the amount or redirect it.
        if (positionLeaf == SURPLUS_RECEIPT) {
            _surplusDraw(debtValue, bytes32(rateSnapshot));
            return;
        }
        if (uint256(positionLeaf) <= 2) revert BadPositionLeaf(); // positionLeaf 0/1/2 are reserved sentinels
        if (debtValue == 0) revert BadAmount();
        // The leaf's committed snapshot must be a real past-or-present mark, ∈ [RAY, rate]. Barring a FUTURE
        // rate stops a borrower pre-committing a high snapshot to dodge accrued fees; allowing a slightly
        // stale one (≤ rate) keeps mint live across the prove→settle gap (the borrower only eats a hair of
        // instant interest, never the protocol). Dormant: rate == RAY, so the only valid snapshot is RAY.
        if (rateSnapshot < RAY || rateSnapshot > rate) revert BadSnapshot();
        uint256 collateralUsd = _basketUsd(legs);
        // A below-current snapshot (the prove→settle band, or a borrower deliberately picking a stale one) makes
        // the position owe accrued interest THE MOMENT it exists: `owed = ceil(debtValue·rate/snap) ≥ debtValue`.
        // Gate collateral against that accrued debt, not the principal, so a stale snapshot cannot settle an
        // already-undercollateralized (immediately-liquidatable) position.
        uint256 owedNow = _owed(debtValue, rateSnapshot);
        if (owedNow * cdpRatioBps > collateralUsd * 10_000) revert Undercollateralized();
        outstandingCusd += debtValue;
        // Normalized debt of this position (retired with the SAME formula at close/liquidate, so it nets to 0):
        // `debtValue·RAY/snap`. Dormant (snap == RAY) ⇒ art == debtValue, and drip accrues 0, so this is inert.
        uint256 artAdded = FixedPointMathLib.fullMulDiv(debtValue, RAY, rateSnapshot);
        // Reject a position whose normalized debt floors to zero (reachable only with a stale snapshot above
        // RAY, i.e. `debtValue < snapshot/RAY`): it would mint real principal while adding nothing to
        // `normalizedDebtRay`, so at close `_retirePosition` would find `art == 0` and book the whole principal
        // as fee surplus — recyclable, unbacked cUSD. Requiring non-zero normalized debt keeps every minted
        // principal represented in the accumulator. Dormant/fresh (snap == RAY) ⇒ art == debtValue > 0, so this
        // never rejects a normal mint; the guest mirrors it so such a position can never be proven.
        if (artAdded == 0) revert BadAmount();
        normalizedDebtRay += artAdded;
        // The debt this position adds is `artAdded·rate/RAY`, which exceeds `debtValue` by the instant interest
        // of a stale snapshot. That interest predates the position, so no drip accrued it — credit it to the fee
        // budget now (the SAME quantity retired at close), keeping `M + feeBudgetCusd == aggregate debt` so the
        // stale-snapshot debt stays fully mint-authorized and the position remains closeable.
        uint256 debtAdded = FixedPointMathLib.fullMulDiv(artAdded, rate, RAY);
        // Booked as SURPLUS, not distributed to savers. This interest belongs to the prove→settle band that
        // predates the position and predates any drip, so no saver was bonded "while it accrued" — and routing
        // it here keeps `drip()` the ONLY thing that ever moves `savingsRps`. Since every entrypoint drips
        // first and a drip accrues at most once per block, no rps bump can follow a bond within one settle.
        if (debtAdded > debtValue) _bookSurplusFee(debtAdded - debtValue, positionLeaf);
        emit CdpMinted(positionLeaf, debtValue, collateralUsd);
    }

    /// @notice Account a CDP close (the pool proved the burn + collateral release). No oracle, no veto —
    ///         repaying is unconditional. The borrower burned `repaid` cUSD against a position of `principal`
    ///         opened at `rateSnapshot`. The accrued debt is `owed = principal · rate / snapshot`; `repaid`
    ///         must cover it, within a small over-repay band — the prover computes `owed` at prove time but
    ///         `rate` drips on to settle, so an exact match is unsatisfiable once the fee is on; the borrower
    ///         burns a hair more to cover the prove→settle drift. Decrements outstanding PRINCIPAL and routes
    ///         the whole `repaid − principal` (the interest plus any over-burn) into the TSR budget — the
    ///         burned cUSD is a re-mint authorization the savings vault later draws on. Dormant: rate ==
    ///         snapshot ⇒ owed == principal, so a borrower burns exactly the principal (fee 0).
    function onCdpClose(
        uint256 principal,
        uint256 repaid,
        uint256 rateSnapshot,
        CdpLeg[] calldata legs,
        bytes32 positionNullifier
    ) external onlyPool {
        // Drip BEFORE the savings branch can drop shares, so an exiting saver is paid the interest that
        // accrued while it was still bonded instead of forfeiting it to whoever remains. Same reason as the
        // mint side; idempotent within a block.
        drip();
        // TSR unbond: a farm-receipt close (no debt) releasing staked cUSD. The proof re-mints the cUSD
        // principal to the saver; this just drops the savings shares. (Harvest first to collect accrual.)
        if (principal == 0) {
            if (repaid != 0) revert BadSavingsShape();
            if (legs.length != 1 || legs[0].asset != CUSD_ASSET_ID || legs[0].value == 0) revert BadSavingsShape();
            // Retire exactly the STAMPED debt and delete the stamp: `totalSavingsRewardDebt` can't underflow,
            // an un-harvested tail is forfeited back to `feeBudgetCusd`'s unclaimed surplus, and the closed
            // position has nothing left to harvest or replay.
            bytes32 receipt = bytes32(rateSnapshot);
            if (!savingsEntryStamped[receipt]) revert SavingsNoLivePosition();
            // The un-harvested tail this position leaves behind is forfeited to the durable surplus, so its
            // fee cUSD stays represented by a claim after the shares drop. Book the forfeited entitlement as the
            // CHANGE in the aggregate outstandingSavingsReward (not a per-event floor), so it complements the
            // aggregate exactly and the fee-budget invariant holds on the nose.
            if (legs[0].value > totalSavingsShares) revert BadSavingsShape();
            uint256 owedBefore = outstandingSavingsReward();
            totalSavingsRewardDebt -= legs[0].value * savingsEntryRps[receipt];
            totalSavingsShares -= legs[0].value;
            surplusFeeCusd += owedBefore - outstandingSavingsReward();
            delete savingsEntryRps[receipt];
            delete savingsEntryStamped[receipt];
            emit SavingsSharesChanged(totalSavingsShares);
            return;
        }
        if (principal > outstandingCusd) revert DebtAccountingUnderflow();
        uint256 owed = _owed(principal, rateSnapshot);
        // Cover the accrued debt, plus up to a 1% over-repay band to absorb prove→settle drip drift (the drift
        // over any realistic settle delay at a sane fee is far under 1%; the ceiling bounds a fat-finger).
        if (repaid < owed || repaid > owed + owed / 100) revert BadRepayment();
        outstandingCusd -= principal;
        emit CdpClosed(positionNullifier, principal);
        // The position's fee was already accrued into the budget by drips; retire its normalized debt and book
        // ONLY the burn above the accrued debt (`repaid − owed`) as surplus, so drawable surplus reflects
        // genuinely-collected fee and never any principal↔normalized reconstruction gap. Do NOT re-accrue the
        // fee here (double count).
        _retirePosition(principal, rateSnapshot, owed, repaid, positionNullifier);
    }

    /// @notice Authorize a liquidation: require the position be BELOW `liqRatio` at the validated mark
    ///         (reverts if healthy). The pool proof has already burned debt notes summing exactly to
    ///         `debtValue` and pays the seized basket as public withdrawals in the same settlement, so this
    ///         callback only gates health and decrements open-position debt.
    function onCdpLiquidate(
        CdpLeg[] calldata legs,
        uint256 principal,
        uint256 repaid,
        uint256 rateSnapshot,
        bytes32 positionNullifier
    ) external onlyPool {
        if (principal == 0) revert BadAmount();
        if (principal > outstandingCusd) revert DebtAccountingUnderflow();
        drip();
        uint256 owed = _owed(principal, rateSnapshot);
        // Same over-repay band as close — the seized debt is the accrued `owed`, tolerant of prove→settle drift.
        if (repaid < owed || repaid > owed + owed / 100) revert BadRepayment();
        uint256 collateralUsd = _basketUsd(legs);
        // Health is measured against the ACCRUED debt `owed` (not the principal): a position becomes seizable
        // as the stability fee erodes it, even with flat collateral. healthy iff collateralUsd ≥ owed ·
        // liqRatio/10000 → liquidatable only when strictly below.
        if (collateralUsd * 10_000 >= owed * liqRatioBps) revert PositionHealthy();
        outstandingCusd -= principal;
        emit CdpLiquidated(positionNullifier, principal, collateralUsd);
        _retirePosition(principal, rateSnapshot, owed, repaid, positionNullifier);
    }

    /// @dev Capture a collected stability fee. Inert at fee 0 (dormant). The over-repaid cUSD was burned by the
    ///      proof, so crediting `feeBudgetCusd` re-authorizes that much future saver mint. The fee is also
    ///      distributed to current TSR savers pro-rata (the reward-per-share bump). If there are no savers it
    ///      stays in the budget with no rps entitlement pointing at it (effectively burned — never minted).
    /// @dev Book a collected fee whose whole authorization is surplus — no saver rps entitlement points at it.
    ///      Preserves `feeBudgetCusd == outstandingSavingsReward() + surplusFeeCusd` (both budget and surplus
    ///      rise by `fee`, the saver side is untouched). Used where distributing to savers would be unearned:
    ///      the stale-snapshot interest at mint, and the over-repay dust at retirement.
    function _bookSurplusFee(uint256 fee, bytes32 tag) internal {
        if (fee == 0) return;
        feeBudgetCusd += fee;
        feesAccruedCusd += fee;
        surplusFeeCusd += fee;
        emit CdpFeeAccrued(tag, fee);
    }

    function _accrueFee(uint256 fee, bytes32 positionNullifier) internal {
        if (fee == 0) return;
        if (_tsrSavingsBondedThisTx != 0) revert SameSettleSavingsBondAndFee();
        feeBudgetCusd += fee;
        feesAccruedCusd += fee;
        if (totalSavingsShares != 0) {
            // Distribute pro-rata to savers; the reward-per-share bump rounds down. The saver obligation is a
            // SINGLE aggregate floor (outstandingSavingsReward), so the surplus must be booked from the CHANGE
            // in that aggregate, not from a per-event floor: floor(sum) ≥ sum(floor), so per-event carries could
            // otherwise place one base unit in BOTH surplus and the aggregate entitlement. Booking the exact
            // aggregate delta keeps `feeBudgetCusd == outstandingSavingsReward() + surplusFeeCusd` on the nose.
            uint256 owedBefore = outstandingSavingsReward();
            uint256 rpsDelta = FixedPointMathLib.fullMulDiv(fee, SAVINGS_PRECISION, totalSavingsShares);
            savingsRps += rpsDelta;
            uint256 granted = outstandingSavingsReward() - owedBefore;
            surplusFeeCusd += fee - granted;
        } else {
            // No savers point at this fee, so its whole authorization is surplus (never granted to a saver).
            surplusFeeCusd += fee;
        }
        emit CdpFeeAccrued(positionNullifier, fee);
    }

    /// @dev Retire a closed/liquidated position's normalized debt and book ONLY the burn above the accrued debt
    ///      as surplus. The position's stability fee was already accrued into the budget by `drip` up to `owed`,
    ///      so the retirement books strictly what the borrower burned in EXCESS of `owed = ceil(principal·rate/
    ///      snap)` — never any part of the principal↔normalized-debt reconstruction gap. `art_i = principal·RAY/
    ///      snap` is the SAME value the mint added, so `normalizedDebtRay` nets to zero; `owed` is the accrued
    ///      debt the caller already validated `repaid` against, so `dust = repaid − owed ≥ 0`. Because the drip
    ///      accrual for this position is bounded by `owed − principal`, `drip-credited + dust ≤ repaid − principal`
    ///      always — the budget/surplus can never exceed the fee value the burn actually collected, so no
    ///      principal reconstruction dust can surface as drawable surplus. Any shortfall between the aggregate
    ///      (floored) drip accrual and the per-position ceil is retained as backing (a still-owed unit), never
    ///      minted. Crediting BOTH `feeBudgetCusd` and `surplusFeeCusd` by `dust` preserves
    ///      `feeBudgetCusd == outstandingSavingsReward() + surplusFeeCusd`. Dormant (snap == rate == RAY) ⇒
    ///      `owed == principal == repaid` ⇒ `dust == 0` ⇒ inert.
    function _retirePosition(uint256 principal, uint256 snap, uint256 owed, uint256 repaid, bytes32 positionNullifier)
        internal
    {
        uint256 artI = FixedPointMathLib.fullMulDiv(principal, RAY, snap);
        normalizedDebtRay -= artI;
        _bookSurplusFee(repaid - owed, positionNullifier);
    }

    /// @dev TSR receipt op (controller == this engine), routed by the pool's farm path. `legs = [shares
    ///      (cUSD)]`; `receipt` is the guest's stable position id. BOND (reward == 0): STAMP
    ///      `savingsEntryRps[receipt] = savingsRps` at execution and stake `shares` cUSD — the live rps is
    ///      unknowable at proof-build time, so stamping here is what lets a saver join at any moment.
    ///      HARVEST (reward > 0): bound the reward to the saver's own stamped entitlement AND to the
    ///      realized-fee budget, consume the budget (the pool mints the cUSD note MINT-mode against this
    ///      authorization), then RE-STAMP — which is what makes a replayed harvest claim 0. totalSavingsShares
    ///      is untouched on harvest: the principal stays staked. Mirrors FarmController's receipt accounting,
    ///      funded by realized fees rather than an emission.
    function _savingsReceipt(CdpLeg[] calldata legs, uint256 reward, bytes32 receipt) internal {
        if (legs.length != 1) revert BadSavingsShape();
        if (legs[0].asset != CUSD_ASSET_ID || legs[0].value == 0) revert BadSavingsShape();
        if (receipt == bytes32(0)) revert BadSavingsShape();
        uint256 shares = legs[0].value;
        if (reward == 0) {
            // A position id is bonded once: re-bonding a live one would overwrite its stamp, silently burning
            // its accrued entitlement and double-counting its shares. The saver uses a fresh nonce.
            if (savingsEntryStamped[receipt]) revert SavingsPositionExists();
            savingsEntryStamped[receipt] = true;
            savingsEntryRps[receipt] = savingsRps;
            totalSavingsShares += shares;
            totalSavingsRewardDebt += shares * savingsRps;
            _tsrSavingsBondedThisTx = 1; // Q-01: forbid a same-tx fee accrual (bonds settle before fees)
            emit SavingsSharesChanged(totalSavingsShares);
        } else {
            if (!savingsEntryStamped[receipt]) revert SavingsNoLivePosition();
            uint256 window = savingsRps - savingsEntryRps[receipt]; // a stamp is only ever a past live rps
            if (reward > FixedPointMathLib.fullMulDiv(shares, window, SAVINGS_PRECISION)) {
                revert SavingsOverClaim();
            }
            if (reward > feeBudgetCusd) revert SavingsOverClaim(); // saver cUSD is always fee-backed
            // The whole window is consumed by the re-stamp, so a replay bounds against 0 and reverts. If the
            // saver claims less than the full window, the forfeited remainder is captured as durable surplus so
            // its fee cUSD stays represented by a claim. The consumed entitlement is measured as the CHANGE in
            // the aggregate outstandingSavingsReward (not a per-event floor), so the surplus complements it
            // exactly and the fee-budget invariant holds on the nose.
            uint256 owedBefore = outstandingSavingsReward();
            totalSavingsRewardDebt += shares * window;
            uint256 consumed = owedBefore - outstandingSavingsReward();
            savingsEntryRps[receipt] = savingsRps;
            feeBudgetCusd -= reward;
            surplusFeeCusd += consumed - reward;
            emit SavingsHarvested(reward, feeBudgetCusd);
        }
    }

    /// @dev Realize a governance-authorized surplus draw. The pool proved a cUSD note of `amount` was minted to
    ///      `destCommitment` (the note leaf, carried in the CdpMint's rateSnapshot slot). Bind it to the pending
    ///      one-shot authorization the owner set: the minted amount AND the destination must match exactly, so
    ///      a keeper can neither inflate the draw nor redirect it. Decrement BOTH the surplus and the fee budget
    ///      by `amount` (the surplus fee cUSD is re-minted, so its re-mint authorization is spent) and clear the
    ///      pending draw. `surplusFeeCusd` only ever grows until drawn, so `amount ≤ surplusFeeCusd ≤
    ///      feeBudgetCusd` holds and neither underflows. The saver entitlement is untouched, so the invariant
    ///      `feeBudgetCusd == outstandingSavingsReward() + surplusFeeCusd` is preserved (both sides drop by
    ///      `amount`).
    function _surplusDraw(uint256 amount, bytes32 destCommitment) internal {
        SurplusDraw memory p = pendingSurplusDraw;
        if (p.amount == 0) revert SurplusNoPending();
        if (amount != p.amount || destCommitment != p.destCommitment) revert SurplusMismatch();
        // Cap the draw by the budget genuinely free of saver entitlement (`feeBudgetCusd −
        // outstandingSavingsReward()`), not by `surplusFeeCusd` alone — so a draw can never dip into saver-owed
        // budget even if the surplus figure were momentarily overstated.
        if (amount > surplusFeeCusd || amount + outstandingSavingsReward() > feeBudgetCusd) {
            revert DebtAccountingUnderflow();
        }
        surplusFeeCusd -= amount;
        feeBudgetCusd -= amount;
        delete pendingSurplusDraw; // one-shot: a replayed surplus mint finds no pending and reverts
        emit SurplusDrawn(amount, destCommitment, feeBudgetCusd);
    }

    /// @notice A saver's currently-harvestable cUSD for the position `receipt` holding `shares`. The checkpoint
    ///         is engine state (stamped at bond), so the dapp needs only its own receipt leaf. UI helper.
    function pendingSavingsReward(uint256 shares, bytes32 receipt) external view returns (uint256) {
        if (!savingsEntryStamped[receipt]) return 0;
        uint256 entry = savingsEntryRps[receipt];
        if (entry >= savingsRps) return 0;
        return FixedPointMathLib.fullMulDiv(shares, savingsRps - entry, SAVINGS_PRECISION);
    }

    /// @notice The EXACT unclaimed saver entitlement: `(savingsRps*totalSavingsShares - debt)/PRECISION`.
    ///         Monitoring/UI — savers are always additionally capped by `feeBudgetCusd`.
    function outstandingSavingsReward() public view returns (uint256) {
        return (savingsRps * totalSavingsShares - totalSavingsRewardDebt) / SAVINGS_PRECISION;
    }

    /// @notice Every unit of `feeBudgetCusd` is backed by a claim: the unclaimed saver entitlement plus the
    ///         durable surplus. Holds after every fee-touching op; 0 == 0 while the fee is dormant.
    function feeBudgetInvariantHolds() external view returns (bool) {
        return feeBudgetCusd == outstandingSavingsReward() + surplusFeeCusd;
    }

    /// @notice Authorize a CDP top-up: the pool proved an old position was consumed and a replacement position
    ///         with the same debt and a larger basket was appended. Outstanding cUSD is unchanged; this only
    ///         approves the replacement basket and requires it be back at the mint collateralization floor, so
    ///         dust top-ups cannot roll an unhealthy position just to avoid liquidation.
    function onCdpTopup(
        CdpLeg[] calldata oldLegs,
        CdpLeg[] calldata newLegs,
        uint256 debtValue,
        uint256 rateSnapshot,
        bytes32 oldPositionNullifier,
        bytes32 newPositionLeaf
    ) external onlyPool {
        // 0/1/2 are the reserved sentinels (payout / savings receipt / surplus draw), matching the mint gate —
        // a replacement position must never land on one.
        if (uint256(newPositionLeaf) <= 2) revert BadPositionLeaf();
        if (debtValue == 0) revert BadAmount();
        drip();
        // The replacement leaf carries the SAME principal and the SAME snapshot (membership of the old leaf
        // pins `rateSnapshot`), so accrual continues uninterrupted — a top-up adds collateral, it does not
        // settle interest. Health is checked against the ACCRUED debt, so a dust top-up cannot roll an
        // already-underwater position out of liquidation range.
        uint256 owed = _owed(debtValue, rateSnapshot);
        uint256 oldCollateralUsd = _basketUsd(oldLegs);
        uint256 newCollateralUsd = _basketUsd(newLegs);
        if (newCollateralUsd <= oldCollateralUsd) revert Undercollateralized();
        if (owed * cdpRatioBps > newCollateralUsd * 10_000) revert Undercollateralized();
        emit CdpToppedUp(oldPositionNullifier, newPositionLeaf, debtValue, oldCollateralUsd, newCollateralUsd);
    }

    /// @dev Sum the USD value of a collateral basket; v1 requires every leg to be cBTC.
    function _basketUsd(CdpLeg[] calldata legs) internal view returns (uint256 usd) {
        if (legs.length == 0) revert Undercollateralized();
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].asset != CBTC_ASSET_ID) revert NotCbtcCollateral();
            if (legs[i].value == 0) revert Undercollateralized();
            usd += btcToUsd(legs[i].value);
        }
    }

    // ─────────────────────── shared protocol reserve ───────────────────────

    /// @notice Explicitly fund the shared native-ETH protocol reserve (backstops rug-recovery shortfall +
    ///         CDP bad debt). Plain ETH sends to this contract are also accounted as reserve funding.
    function fundInsurance() external payable {
        if (msg.value == 0) revert BadAmount();
        insuranceReserve += msg.value;
        emit InsuranceFunded(msg.sender, msg.value);
    }

    /// @notice Owner/DAO draws from the reserve to settle a covered shortfall (e.g. fund an async cBTC rug
    ///         buy-and-burn or governance-recognized CDP bad debt). Normal cUSD liquidation is not async:
    ///         the pool proof burns exact cUSD debt before collateral can leave. Bounded: only manages
    ///         backstop capital.
    function drawInsurance(uint256 amount, address to) external onlyOwner nonReentrant {
        _drawInsurance(amount, to);
    }

    /// @notice Same reserve draw, but with a purpose tag for DAO / future policy-module auditability.
    ///         Examples: keccak256("CBTC_RUG_BUY_BURN"), keccak256("CDP_BAD_DEBT").
    function drawInsuranceFor(bytes32 purpose, uint256 amount, address to) external onlyOwner nonReentrant {
        if (purpose == bytes32(0)) revert BadPurpose();
        _drawInsurance(amount, to);
        emit InsuranceDrawnFor(purpose, to, amount);
    }

    function _drawInsurance(uint256 amount, address to) internal {
        if (amount == 0) revert BadAmount();
        if (to == address(0)) revert ZeroRecipient();
        if (amount > insuranceReserve) revert InsufficientReserve();
        insuranceReserve -= amount;
        SafeTransferLib.safeTransferETH(to, amount);
        emit InsuranceDrawn(to, amount);
    }

    /// @notice Owner/DAO recovers cBTC stranded in this engine (for example from an explicit controller-
    ///         recipient recovery path). Atomic cUSD liquidations burn debt in-proof and normally pay seized
    ///         collateral directly to the liquidator, but this narrow recovery keeps accidental/controller-held
    ///         cBTC from becoming permanently stuck.
    ///
    ///         Deliberately NARROW (not a general token sweep): the token is resolved from the pool as the
    ///         canonical cBTC ERC20, so this can only ever move the protocol's cBTC, never an arbitrary
    ///         balance, and it touches no backing/escrow/reserve (those are native ETH held in the pool or
    ///         this engine, unreachable by an ERC20 transfer). If cBTC reaches this engine through an
    ///         explicit engine-recipient route, it is protocol capital, not note escrow; this is the same DAO
    ///         trust as drawInsurance, scoped to exactly the one asset.
    function recoverSeizedCbtc(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroRecipient();
        if (amount == 0) revert BadAmount();
        // Resolve the cBTC token through the pool (CBTC_ASSET_ID may be a shared id), so recovery always
        // targets exactly the token a seize mints/transfers here. 0 ⇒ cBTC isn't pool-registered, so no seize
        // could have landed (the seize withdrawal would itself revert) — nothing to recover.
        address token = POOL.canonicalTokenFor(CBTC_ASSET_ID);
        if (token == address(0)) revert NotCbtcCollateral();
        SafeTransferLib.safeTransfer(token, to, amount);
        emit SeizedCbtcRecovered(token, to, amount);
    }

    receive() external payable {
        if (msg.value != 0) {
            insuranceReserve += msg.value;
            emit InsuranceFunded(msg.sender, msg.value);
        }
    }
}

/// @dev One collateral basket leg, mirroring ConfidentialPool.CdpLeg / the settle guest's CdpLeg.
struct CdpLeg {
    bytes32 asset;
    uint256 value;
}
