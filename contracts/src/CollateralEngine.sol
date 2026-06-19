// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

/// @dev The immutable ConfidentialPool surface this engine reads/serves. The pool is the authority for
///      all proven Bitcoin/CDP state; the engine only sizes escrows, prices collateral, and routes
///      seizures — it can NEVER mint a confidential asset, move backing, or break a peg (all of which are
///      proof-enforced in the pool). See ops/DESIGN-confidential-defi-v1.md §§3,4,6.
interface IConfidentialPoolCollateral {
    /// Σ live self-custody cBTC.zk lock sats (reflection-attested, oracle-free).
    function cbtcBackingSats() external view returns (uint256);
    /// True once the reflection surfaced this lock outpoint as SPENT (`cbtcLocksSpent`).
    function cbtcLockSpent(bytes32 outpoint) external view returns (bool);
    /// True once cBTC was minted against this lock (the escrow became live).
    function cbtcMinted(bytes32 outpoint) external view returns (bool);
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
/// @notice The unified collateral / insurance core for Tacit confidential DeFi v1 — the conjoined
///         buffer + insurance + per-locker escrow + cUSD CDP controller (supersedes `CbtcBuffer` +
///         `InsuranceVault`). All POLICY lives here (mutable, Solady `Ownable` → DAO); the immutable
///         `ConfidentialPool` calls `onCdpMint/Close/Liquidate` and reads `escrowSufficient` but holds
///         the proofs. Two roles:
///
///         1. **cBTC escrow (native ETH, Chainlink ETH/BTC sized):** a self-custody locker posts a
///            refundable native-ETH escrow keyed by their Bitcoin lock outpoint, `≥ escrowRatio · v_btc`.
///            On an honest atomic redeem the escrow is released; on a proven rug (the reflection surfaces
///            the lock spent without a redemption) anyone may `slash` it. Chainlink sizes the escrow only,
///            never cBTC's peg (which is conservation, oracle-free) — an oracle failure mis-sizes the
///            deterrent, it cannot de-peg cBTC.
///
///         2. **cUSD CDP controller (Chainlink BTC/USD):** this contract IS the cUSD controller, so the
///            cUSD asset id = `keccak("tacit-cdp-debt-v1" ‖ address(this))` and it is the sole minter.
///            `onCdpMint` enforces `debt_usd ≤ collateral_btc · price_btc_usd / cdpRatio`; `onCdpLiquidate`
///            requires the position be below `liqRatio` (reverts if healthy). Unlike cBTC, cUSD is a CDP
///            stablecoin: BTC/USD IS load-bearing for its peg (the DAI model).
///
///         A shared native-ETH **insurance reserve** (funded by slashing surplus + liquidation penalties,
///         never by honest users) backstops the tail.
contract CollateralEngine is Ownable, ReentrancyGuard {
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

    // --- cBTC escrow accounting (native ETH per lock outpoint) ---
    mapping(bytes32 => uint256) public escrowOf; // outpoint → posted native ETH (wei)
    mapping(bytes32 => bool) public escrowReleased; // outpoint → released by a proven redeem (then non-slashable)
    mapping(bytes32 => bool) public escrowSlashed; // outpoint → already slashed (one-shot)

    // --- cUSD CDP accounting ---
    uint256 public outstandingCusd; // total cUSD debt minted across open positions (base units)

    // --- shared insurance reserve (native ETH) ---
    uint256 public insuranceReserve; // wei; funded by slash surplus + liquidation, backstops bad debt

    event FeedsSet(address ethBtcFeed, address btcUsdFeed);
    event ParamsSet(uint256 maxStaleness, uint256 escrowRatioBps, uint256 cdpRatioBps, uint256 liqRatioBps);
    event EscrowPosted(bytes32 indexed outpoint, address indexed from, uint256 amount);
    event EscrowReleased(bytes32 indexed outpoint, address indexed to, uint256 amount);
    event EscrowSlashed(bytes32 indexed outpoint, uint256 amount, uint256 toReserve);
    event CdpMinted(bytes32 indexed positionLeaf, uint256 debtValue, uint256 collateralUsd);
    event CdpClosed(bytes32 indexed positionNullifier, uint256 debtValue);
    event CdpLiquidated(bytes32 indexed positionNullifier, uint256 debtValue, uint256 collateralUsd);
    event InsuranceFunded(address indexed from, uint256 amount);

    error NotPool();
    error BadFeed();
    error StaleFeed();
    error FeedDeviation();
    error ZeroRecipient();
    error NotCbtcCollateral();
    error Undercollateralized();
    error PositionHealthy();
    error NothingToSlash();
    error EscrowLocked();

    modifier onlyPool() {
        if (msg.sender != address(POOL)) revert NotPool();
        _;
    }

    constructor(address pool, bytes32 cbtcAssetId, uint8 cbtcDec, uint8 cusdDec, address admin) {
        POOL = IConfidentialPoolCollateral(pool);
        CBTC_ASSET_ID = cbtcAssetId;
        CBTC_DEC = cbtcDec;
        CUSD_DEC = cusdDec;
        // cUSD = this controller's derived debt asset (mirrors cxfer-core::cdp_debt_asset_id): the pool
        // checks `debtAsset == keccak("tacit-cdp-debt-v1" ‖ controller)`, so this engine is its sole minter.
        CUSD_ASSET_ID = keccak256(abi.encodePacked("tacit-cdp-debt-v1", bytes20(uint160(address(this)))));
        _initializeOwner(admin);
    }

    error PoolAlreadySet();

    /// @notice Wire the pool once after deploy (the engine↔pool circular-dep break). Reverts if already set,
    ///         so it is fixed after the one call. No-op path for tests/deploys that pass the pool in the ctor.
    function setPool(address pool) external onlyOwner {
        if (address(POOL) != address(0)) revert PoolAlreadySet();
        POOL = IConfidentialPoolCollateral(pool);
    }

    // ─────────────────────── owner-governed knobs ───────────────────────

    function setFeeds(address ethBtc, address btcUsd, address ethBtcTwap_, address btcUsdTwap_) external onlyOwner {
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
        maxDeviationBps = bps;
    }

    function setParams(uint256 _maxStaleness, uint256 _escrowRatioBps, uint256 _cdpRatioBps, uint256 _liqRatioBps)
        external
        onlyOwner
    {
        // liquidation threshold must sit below the mint floor (else a fresh mint is instantly liquidatable).
        require(_liqRatioBps < _cdpRatioBps && _liqRatioBps >= 10000, "ratios");
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
        if (block.timestamp - updatedAt > maxStaleness) revert StaleFeed();
        if (answeredInRound < roundId) revert StaleFeed(); // a carried-over (incomplete) round
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
    ///         pool's cBTC mint reads before minting cBTC against the lock.
    function escrowSufficient(bytes32 outpoint, uint256 vBtc) external view returns (bool) {
        return escrowOf[outpoint] >= requiredEscrow(vBtc);
    }

    /// @notice Post (or top up) the refundable native-ETH escrow for a Bitcoin lock outpoint. Anyone may
    ///         fund; it is returned on an honest redeem (`releaseEscrow`) and slashable on a proven rug.
    function postEscrow(bytes32 outpoint) external payable {
        escrowOf[outpoint] += msg.value;
        emit EscrowPosted(outpoint, msg.sender, msg.value);
    }

    /// @notice Release a lock's escrow back to the locker on a PROVEN honest redemption (the cBTC was burned
    ///         and the BTC unlocked atomically). Owner/DAO (or a future authorized redemption module) marks
    ///         the redemption; the marked outpoint then becomes non-slashable. Bounded: returns posted ETH,
    ///         never mints cBTC or touches backing.
    function releaseEscrow(bytes32 outpoint, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroRecipient();
        uint256 amt = escrowOf[outpoint];
        escrowOf[outpoint] = 0;
        escrowReleased[outpoint] = true;
        (bool ok,) = payable(to).call{value: amt}("");
        require(ok, "send");
        emit EscrowReleased(outpoint, to, amt);
    }

    /// @notice Slash a rugged lock's escrow: permissionless, but only when the reflection has PROVEN the
    ///         lock spent (`cbtcLockSpent`), cBTC was actually minted against it, and it was never released
    ///         by a redemption. The slashed ETH backs the now-unbacked cBTC via the insurance reserve (which
    ///         funds the async cBTC buy-and-burn). The guest never decides rug-vs-redeem — this contract does,
    ///         from the proven spend flag + its own release ledger.
    function slash(bytes32 outpoint) external {
        if (escrowReleased[outpoint] || escrowSlashed[outpoint]) revert EscrowLocked();
        if (!POOL.cbtcMinted(outpoint) || !POOL.cbtcLockSpent(outpoint)) revert NothingToSlash();
        uint256 amt = escrowOf[outpoint];
        if (amt == 0) revert NothingToSlash();
        escrowOf[outpoint] = 0;
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
        uint256 collateralUsd = _basketUsd(legs);
        // debt_usd (== debtValue, both in CUSD_DEC) ≤ collateralUsd · 10000 / cdpRatioBps
        if (debtValue * cdpRatioBps > collateralUsd * 10_000) revert Undercollateralized();
        outstandingCusd += debtValue;
        emit CdpMinted(positionLeaf, debtValue, collateralUsd);
    }

    /// @notice Account a CDP close (the pool proved the exact debt burned + collateral released). No oracle,
    ///         no veto — repaying is unconditional; just decrement outstanding debt.
    function onCdpClose(uint256 debtValue, CdpLeg[] calldata, bytes32 positionNullifier) external onlyPool {
        outstandingCusd = outstandingCusd > debtValue ? outstandingCusd - debtValue : 0;
        emit CdpClosed(positionNullifier, debtValue);
    }

    /// @notice Authorize a liquidation: require the position be BELOW `liqRatio` at the validated mark
    ///         (reverts if healthy). The pool has withdrawn the seized basket to this engine (public); the
    ///         engine covers the cUSD debt from the seized collateral (async buy-and-burn) with the insurance
    ///         reserve as backstop. Permissionless — anyone may trigger when actually unhealthy.
    function onCdpLiquidate(CdpLeg[] calldata legs, uint256 debtValue, bytes32 positionNullifier) external onlyPool {
        uint256 collateralUsd = _basketUsd(legs);
        // healthy iff collateralUsd ≥ debt_usd · liqRatio/10000 → liquidatable only when strictly below.
        if (collateralUsd * 10_000 >= debtValue * liqRatioBps) revert PositionHealthy();
        outstandingCusd = outstandingCusd > debtValue ? outstandingCusd - debtValue : 0;
        emit CdpLiquidated(positionNullifier, debtValue, collateralUsd);
    }

    /// @dev Sum the USD value of a collateral basket; v1 requires every leg to be cBTC.
    function _basketUsd(CdpLeg[] calldata legs) internal view returns (uint256 usd) {
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].asset != CBTC_ASSET_ID) revert NotCbtcCollateral();
            usd += btcToUsd(legs[i].value);
        }
    }

    // ─────────────────────── shared insurance reserve ───────────────────────

    /// @notice Fund the shared native-ETH insurance reserve (backstops rug-recovery shortfall + CDP bad debt).
    function fundInsurance() external payable {
        insuranceReserve += msg.value;
        emit InsuranceFunded(msg.sender, msg.value);
    }

    /// @notice Owner/DAO draws from the reserve to settle a covered shortfall (e.g. fund an async cBTC
    ///         buy-and-burn or cover CDP bad debt). Bounded: only manages backstop capital.
    function drawInsurance(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroRecipient();
        insuranceReserve -= amount;
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "send");
    }

    receive() external payable {
        insuranceReserve += msg.value;
        emit InsuranceFunded(msg.sender, msg.value);
    }
}

/// @dev One collateral basket leg, mirroring ConfidentialPool.CdpLeg / the settle guest's CdpLeg.
struct CdpLeg {
    bytes32 asset;
    uint256 value;
}
