// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @dev Reflection-attested live locked sats behind cBTC (sum of live self-custody cBTC.zk outpoints),
///      surfaced by ConfidentialPool from BITCOIN_RELAY_VKEY-verified state. The PEG reads from this, not
///      from any oracle: cBTC = real locked BTC, 1:1.
interface IPoolBacking {
    function cbtcBackingSats() external view returns (uint256);
}

interface IERC20Min {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Chainlink ETH/BTC aggregator (answer = BTC per 1 ETH, `decimals()` places).
interface IChainlinkFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// @notice On-chain AMM-derived ETH/BTC TWAP (shielded-pool / canonical pool) for the deviation sanity bound.
interface IAmmTwap {
    function ethBtcTwap() external view returns (uint256 price, uint8 decimals);
}

/// @notice Owner-set venue that swaps tETH -> cBTC, delivered to `to`. Concrete adapter wired at deploy.
interface IBufferRouter {
    function buyExactCbtc(address teth, address cbtc, uint256 amountOut, uint256 maxIn, address to, bytes calldata route)
        external
        returns (uint256 spent);
}

/// @title CbtcBuffer
/// @notice The tETH over-collateralization buffer that insures cBTC's only residual risk — a self-custody
///         locker reclaiming their own BTC ("rug"). cBTC's PEG is oracle-free (1 cBTC = real locked BTC,
///         proven by the reflection). When a lock is spent without a matching cBTC burn, the
///         reflection-attested `cbtcBackingSats` drops below the circulating supply, and anyone can call
///         `coverShortfall` to spend the tETH buffer (Chainlink ETH/BTC-bounded) to buy + sequester cBTC,
///         restoring circulating <= backing.
/// @dev Chainlink prices ONLY the buffer's liquidation, NEVER the peg — an oracle failure mis-sizes the
///      insurance (and only matters if a rug also happens), it cannot de-peg the asset. The feed is a
///      decentralized quorum, freshness-checked, and bounded against an on-chain AMM-TWAP. Solady `Ownable`:
///      owner = deployer -> DAO; the owner sizes the buffer/feeds and manages tETH, but can never mint cBTC,
///      move the BTC backing, or break the peg. Evolves `InsuranceVault` (tETH + Chainlink, not (TAC,tETH)).
contract CbtcBuffer is Ownable {
    IPoolBacking public immutable POOL;
    address public immutable CBTC; // BTC-denominated, CBTC_DEC decimals
    address public immutable TETH; // ETH-denominated, TETH_DEC decimals
    uint8 public immutable CBTC_DEC;
    uint8 public immutable TETH_DEC;

    // --- owner-governed (owner -> DAO) ---
    IChainlinkFeed public ethBtcFeed; // ETH/BTC, answer = BTC per ETH
    IAmmTwap public ammTwap; // optional deviation reference
    IBufferRouter public router;
    uint256 public maxBuybackPerClaim; // cBTC cap per claim
    uint256 public maxStaleness; // Chainlink updatedAt freshness (seconds)
    uint256 public maxDeviationBps; // Chainlink vs AMM-TWAP bound (0 = skip)
    uint256 public slippageBps; // allowed buyback slippage over the Chainlink-fair tETH

    event FeedsSet(address ethBtcFeed, address ammTwap);
    event RouterSet(address router);
    event ParamsSet(uint256 maxBuybackPerClaim, uint256 maxStaleness, uint256 maxDeviationBps, uint256 slippageBps);
    event BufferAdded(uint256 amount, address indexed from);
    event BufferWithdrawn(uint256 amount, address indexed to);
    event ShortfallCovered(uint256 shortfall, uint256 bought, uint256 tethSpent);

    error NoRouter();
    error NoShortfall();
    error BadFeed();
    error StaleFeed();
    error FeedDeviation();
    error Overspend();

    constructor(
        address pool,
        address cbtc,
        address teth,
        uint8 cbtcDec,
        uint8 tethDec,
        address admin
    ) {
        POOL = IPoolBacking(pool);
        CBTC = cbtc;
        TETH = teth;
        CBTC_DEC = cbtcDec;
        TETH_DEC = tethDec;
        _initializeOwner(admin);
    }

    // ---------- buffer capital: anyone funds tETH; owner manages (never the peg) ----------

    function addBuffer(uint256 amount) external {
        SafeTransferLib.safeTransferFrom(TETH, msg.sender, address(this), amount);
        emit BufferAdded(amount, msg.sender);
    }

    function withdrawBuffer(uint256 amount, address to) external onlyOwner {
        SafeTransferLib.safeTransfer(TETH, to, amount);
        emit BufferWithdrawn(amount, to);
    }

    // ---------- owner-governed knobs ----------

    function setFeeds(address feed, address twap) external onlyOwner {
        ethBtcFeed = IChainlinkFeed(feed);
        ammTwap = IAmmTwap(twap);
        emit FeedsSet(feed, twap);
    }

    function setRouter(address r) external onlyOwner {
        router = IBufferRouter(r);
        emit RouterSet(r);
    }

    function setParams(uint256 _maxBuyback, uint256 _maxStaleness, uint256 _maxDeviationBps, uint256 _slippageBps)
        external
        onlyOwner
    {
        maxBuybackPerClaim = _maxBuyback;
        maxStaleness = _maxStaleness;
        maxDeviationBps = _maxDeviationBps;
        slippageBps = _slippageBps;
        emit ParamsSet(_maxBuyback, _maxStaleness, _maxDeviationBps, _slippageBps);
    }

    // ---------- the peg shortfall (proven, oracle-free) ----------

    /// @notice Circulating cBTC (totalSupply minus what this buffer has sequestered) over the
    ///         reflection-attested live backing. > 0 only after a self-custody rug removed locked sats.
    function pegShortfall() public view returns (uint256) {
        uint256 backing = POOL.cbtcBackingSats();
        uint256 held = IERC20Min(CBTC).balanceOf(address(this));
        uint256 supply = IERC20Min(CBTC).totalSupply();
        uint256 circulating = supply > held ? supply - held : 0;
        return circulating > backing ? circulating - backing : 0;
    }

    // ---------- the validated ETH/BTC price (buffer-only; never the peg) ----------

    /// @notice Chainlink ETH/BTC (BTC per ETH), freshness-checked + AMM-TWAP-bounded. Reverts on a bad,
    ///         stale, or deviating feed — fail-closed, so a broken feed pauses *liquidation*, never the peg.
    function ethBtcPrice() public view returns (uint256 price, uint8 dec) {
        (, int256 ans,, uint256 updatedAt,) = ethBtcFeed.latestRoundData();
        if (ans <= 0) revert BadFeed();
        if (block.timestamp - updatedAt > maxStaleness) revert StaleFeed();
        price = uint256(ans);
        dec = ethBtcFeed.decimals();
        if (address(ammTwap) != address(0) && maxDeviationBps != 0) {
            (uint256 amm, uint8 ammDec) = ammTwap.ethBtcTwap();
            // normalize both to 1e18 and bound |chainlink - amm| / amm <= maxDeviationBps
            uint256 cl18 = price * 1e18 / (10 ** uint256(dec));
            uint256 amm18 = amm * 1e18 / (10 ** uint256(ammDec));
            uint256 diff = cl18 > amm18 ? cl18 - amm18 : amm18 - cl18;
            if (amm18 == 0 || diff * 10_000 > maxDeviationBps * amm18) revert FeedDeviation();
        }
    }

    /// @notice tETH required to acquire `cbtcAmt` cBTC at the validated ETH/BTC price (no slippage).
    function cbtcToTeth(uint256 cbtcAmt) public view returns (uint256) {
        (uint256 price, uint8 dec) = ethBtcPrice();
        // teth = cbtcAmt * 10^(TETH_DEC + dec) / (price * 10^CBTC_DEC)
        return cbtcAmt * (10 ** (uint256(TETH_DEC) + uint256(dec))) / (price * (10 ** uint256(CBTC_DEC)));
    }

    // ---------- claim: permissionless, Chainlink-bounded buy-and-sequester ----------

    /// @notice Cover the proven shortfall by spending tETH buffer to buy cBTC off the AMM (owner-set router)
    ///         and sequestering it. The tETH spent is bounded by the Chainlink-fair amount + `slippageBps`,
    ///         so a manipulated AMM can't drain the buffer. Permissionless — the shortfall is proven, the
    ///         owner ceilings + the Chainlink bound contain the spend.
    function coverShortfall(bytes calldata route) external returns (uint256 bought, uint256 tethSpent) {
        if (address(router) == address(0)) revert NoRouter();
        uint256 shortfall = pegShortfall();
        if (shortfall == 0) revert NoShortfall();

        bought = shortfall < maxBuybackPerClaim ? shortfall : maxBuybackPerClaim;
        uint256 fairTeth = cbtcToTeth(bought);
        uint256 maxIn = fairTeth * (10_000 + slippageBps) / 10_000;

        SafeTransferLib.safeApprove(TETH, address(router), maxIn);
        tethSpent = router.buyExactCbtc(TETH, CBTC, bought, maxIn, address(this), route);
        SafeTransferLib.safeApprove(TETH, address(router), 0);
        if (tethSpent > maxIn) revert Overspend();

        emit ShortfallCovered(shortfall, bought, tethSpent);
    }
}
