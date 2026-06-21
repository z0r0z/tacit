// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @dev The immutable ConfidentialPool surface this engine reads/serves. The pool is the authority for
///      all proven Bitcoin/CDP state; the engine only sizes escrows, prices collateral, and routes
///      narrow recovery/backstop actions — it can NEVER mint a confidential asset, move backing, or break a
///      peg (all of which are proof-enforced in the pool). See ops/DESIGN-confidential-defi-v1.md §§3,4,6.
interface IConfidentialPoolCollateral {
    /// Σ live self-custody cBTC.zk lock sats (reflection-attested, oracle-free).
    function cbtcBackingSats() external view returns (uint256);
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

    // --- cUSD CDP accounting ---
    uint256 public outstandingCusd; // total cUSD debt minted across open positions (base units)

    // --- shared protocol reserve (native ETH) ---
    uint256 public insuranceReserve; // wei; funded by slash proceeds + explicit top-ups, backstops bad debt

    event FeedsSet(address ethBtcFeed, address btcUsdFeed);
    event ParamsSet(uint256 maxStaleness, uint256 escrowRatioBps, uint256 cdpRatioBps, uint256 liqRatioBps);
    event EscrowPosted(bytes32 indexed outpoint, address indexed from, uint256 amount);
    event EscrowReleased(bytes32 indexed outpoint, address indexed to, uint256 amount);
    event EscrowSlashed(bytes32 indexed outpoint, uint256 amount, uint256 toReserve);
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
    event InsuranceFunded(address indexed from, uint256 amount);
    event InsuranceDrawn(address indexed to, uint256 amount);
    event InsuranceDrawnFor(bytes32 indexed purpose, address indexed to, uint256 amount);
    event SeizedCbtcRecovered(address indexed token, address indexed to, uint256 amount);

    error BadFeed();
    error BadPool();
    error NotPool();
    error BadAmount();
    error BadEscrow();
    error BadParams();
    error StaleFeed();
    error BadPurpose();
    error EscrowLocked();
    error FeedDeviation();
    error ZeroRecipient();
    error NothingToSlash();
    error PoolAlreadySet();
    error BadPositionLeaf();
    error PositionHealthy();
    error NothingToRelease();
    error NotCbtcCollateral();
    error InsufficientReserve();
    error Undercollateralized();
    error DebtAccountingUnderflow();

    modifier onlyPool() {
        _onlyPool();
        _;
    }

    function _onlyPool() internal view {
        if (msg.sender != address(POOL)) revert NotPool();
    }

    constructor(address pool, bytes32 cbtcAssetId, uint8 cbtcDec, uint8 cusdDec, address admin) {
        if (
            admin == address(0) || cbtcAssetId != CANONICAL_CBTC_ASSET_ID || cbtcDec != CANONICAL_CBTC_DECIMALS
                || cusdDec > 18
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
        _initializeOwner(admin);
    }

    /// @notice Wire the pool once after deploy (the engine↔pool circular-dep break). Reverts if already set,
    ///         zero, or non-contract, so it is fixed after the one call. No-op path for tests/deploys that pass
    ///         the pool in the ctor.
    function setPool(address pool) external onlyOwner {
        if (address(POOL) != address(0)) revert PoolAlreadySet();
        if (pool == address(0) || pool.code.length == 0) revert BadPool();
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
        ethBtcFeed = IAggregatorV3(ethBtc);
        btcUsdFeed = IAggregatorV3(btcUsd);
        ethBtcTwap = IAmmTwap(ethBtcTwap_);
        btcUsdTwap = IAmmTwap(btcUsdTwap_);
        emit FeedsSet(ethBtc, btcUsd);
    }

    /// @notice Set the Chainlink↔AMM-TWAP deviation bound (bps). 0 disables it (single-source Chainlink) —
    ///         the launch posture until the cUSD / cBTC pool deepens enough to be a trustworthy 2nd source;
    ///         the design (DESIGN-confidential-defi-v1.md §6) wants it active for the BTC/USD (cUSD-peg) feed.
    function setDeviationBound(uint256 bps) external onlyOwner {
        if (bps > 10_000) revert BadParams();
        maxDeviationBps = bps;
    }

    function setParams(uint256 _maxStaleness, uint256 _escrowRatioBps, uint256 _cdpRatioBps, uint256 _liqRatioBps)
        external
        onlyOwner
    {
        // Liquidation threshold must sit below the mint floor (else a fresh mint is instantly liquidatable).
        // Escrow below 100% of the locked BTC value weakens the cBTC rug deterrent; 0 staleness is a footgun.
        // Upper ceilings are sanity bounds (a governance fat-finger is fail-closed but bounded anyway): a
        // ratio over 10x is nonsensical for a CDP, and accepting prices older than a day defeats freshness.
        if (
            _maxStaleness == 0 || _maxStaleness > 1 days || _escrowRatioBps < 10_000 || _escrowRatioBps > 100_000
                || _liqRatioBps < 10_000 || _liqRatioBps >= _cdpRatioBps || _cdpRatioBps > 100_000
        ) {
            revert BadParams();
        }
        maxStaleness = _maxStaleness;
        escrowRatioBps = _escrowRatioBps;
        cdpRatioBps = _cdpRatioBps;
        liqRatioBps = _liqRatioBps;
        emit ParamsSet(_maxStaleness, _escrowRatioBps, _cdpRatioBps, _liqRatioBps);
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
        SafeTransferLib.safeTransferETH(msg.sender, amt);
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
        uint256 amt = escrowTotal[outpoint];
        if (amt == 0) revert NothingToSlash();
        escrowTotal[outpoint] = 0;
        escrowSlashed[outpoint] = true;
        insuranceReserve += amt;
        emit EscrowSlashed(outpoint, amt, amt);
    }

    // ─────────────────────── cUSD CDP controller (called by the pool) ───────────────────────

    /// @notice Authorize a cUSD mint: enforce `debt_usd ≤ Σ collateral_usd / cdpRatio`. The pool has already
    ///         proven the collateral basket is locked + the debt note minted; this applies the price/ratio
    ///         policy and reverts to DENY. v1 accepts only cBTC collateral legs (multi-asset baskets are a
    ///         future controller, no re-prove).
    function onCdpMint(CdpLeg[] calldata legs, uint256 debtValue, bytes32 positionLeaf) external onlyPool {
        if (uint256(positionLeaf) <= 1) revert BadPositionLeaf();
        if (debtValue == 0) revert BadAmount();
        uint256 collateralUsd = _basketUsd(legs);
        // debt_usd (== debtValue, both in CUSD_DEC) ≤ collateralUsd · 10000 / cdpRatioBps
        if (debtValue * cdpRatioBps > collateralUsd * 10_000) revert Undercollateralized();
        outstandingCusd += debtValue;
        emit CdpMinted(positionLeaf, debtValue, collateralUsd);
    }

    /// @notice Account a CDP close (the pool proved the exact debt burned + collateral released). No oracle,
    ///         no veto — repaying is unconditional; just decrement outstanding debt.
    function onCdpClose(uint256 debtValue, CdpLeg[] calldata, bytes32 positionNullifier) external onlyPool {
        if (debtValue == 0) revert BadAmount();
        if (debtValue > outstandingCusd) revert DebtAccountingUnderflow();
        outstandingCusd -= debtValue;
        emit CdpClosed(positionNullifier, debtValue);
    }

    /// @notice Authorize a liquidation: require the position be BELOW `liqRatio` at the validated mark
    ///         (reverts if healthy). The pool proof has already burned debt notes summing exactly to
    ///         `debtValue` and pays the seized basket as public withdrawals in the same settlement, so this
    ///         callback only gates health and decrements open-position debt.
    function onCdpLiquidate(CdpLeg[] calldata legs, uint256 debtValue, bytes32 positionNullifier) external onlyPool {
        if (debtValue == 0) revert BadAmount();
        if (debtValue > outstandingCusd) revert DebtAccountingUnderflow();
        uint256 collateralUsd = _basketUsd(legs);
        // healthy iff collateralUsd ≥ debt_usd · liqRatio/10000 → liquidatable only when strictly below.
        if (collateralUsd * 10_000 >= debtValue * liqRatioBps) revert PositionHealthy();
        outstandingCusd -= debtValue;
        emit CdpLiquidated(positionNullifier, debtValue, collateralUsd);
    }

    /// @notice Authorize a CDP top-up: the pool proved an old position was consumed and a replacement position
    ///         with the same debt and a larger basket was appended. Outstanding cUSD is unchanged; this only
    ///         approves the replacement basket and requires it be back at the mint collateralization floor, so
    ///         dust top-ups cannot roll an unhealthy position just to avoid liquidation.
    function onCdpTopup(
        CdpLeg[] calldata oldLegs,
        CdpLeg[] calldata newLegs,
        uint256 debtValue,
        bytes32 oldPositionNullifier,
        bytes32 newPositionLeaf
    ) external onlyPool {
        if (uint256(newPositionLeaf) <= 1) revert BadPositionLeaf();
        if (debtValue == 0) revert BadAmount();
        uint256 oldCollateralUsd = _basketUsd(oldLegs);
        uint256 newCollateralUsd = _basketUsd(newLegs);
        if (newCollateralUsd <= oldCollateralUsd) revert Undercollateralized();
        if (debtValue * cdpRatioBps > newCollateralUsd * 10_000) revert Undercollateralized();
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
