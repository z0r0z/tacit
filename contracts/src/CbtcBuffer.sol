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

/// @title CbtcBuffer
/// @notice A PASSIVE tETH over-collateralization reserve insuring cBTC's only residual risk — a self-custody
///         locker reclaiming their own BTC ("rug"). cBTC's PEG is oracle-free (1 cBTC = real locked BTC,
///         proven by the reflection). The buffer does NOT trade: tETH and cBTC are Tacit-native and only
///         trade in the confidential (async, proof-settled) AMM, so there is no synchronous on-chain DEX to
///         buy back into. Instead the buffer is held tETH whose BTC-equivalent value (Chainlink ETH/BTC,
///         fail-closed) counts toward backing. When a rug drops `cbtcBackingSats` below the circulating
///         supply, the buffer's BTC value absorbs the shortfall (so `uncoveredShortfall` stays 0); the
///         actual tETH->BTC conversion only happens when a holder REDEEMS, which is the existing ASYNC
///         atomic cBTC<->BTC swap (orderbook/adaptor) — never an on-chain buyback here. tETH is released to
///         honor a redemption by the owner/DAO (or, later, an authorized redemption module).
/// @dev Chainlink prices ONLY the buffer's BTC-equivalent value, NEVER the peg — an oracle failure mis-sizes
///      the insurance (and only matters if a rug also happens), it cannot de-peg the asset. The feed is a
///      decentralized quorum, freshness-checked, and bounded against an on-chain AMM-TWAP. Solady `Ownable`:
///      owner = deployer -> DAO; the owner sizes the feeds and manages tETH, but can never mint cBTC, move
///      the BTC backing, or break the peg. Evolves `InsuranceVault` (tETH + Chainlink, not (TAC,tETH)).
contract CbtcBuffer is Ownable {
    IPoolBacking public immutable POOL;
    address public immutable CBTC; // BTC-denominated, CBTC_DEC decimals
    address public immutable TETH; // ETH-denominated, TETH_DEC decimals
    uint8 public immutable CBTC_DEC;
    uint8 public immutable TETH_DEC;

    // --- owner-governed (owner -> DAO) ---
    IChainlinkFeed public ethBtcFeed; // ETH/BTC, answer = BTC per ETH
    IAmmTwap public ammTwap; // optional deviation reference
    uint256 public maxStaleness; // Chainlink updatedAt freshness (seconds)
    uint256 public maxDeviationBps; // Chainlink vs AMM-TWAP bound (0 = skip)

    event FeedsSet(address ethBtcFeed, address ammTwap);
    event ParamsSet(uint256 maxStaleness, uint256 maxDeviationBps);
    event BufferAdded(uint256 amount, address indexed from);
    event BufferWithdrawn(uint256 amount, address indexed to);

    error BadFeed();
    error StaleFeed();
    error FeedDeviation();

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

    /// @notice Release tETH from the reserve — owner/DAO only. This is how the buffer funds a redemption
    ///         shortfall (the tETH->BTC conversion runs through the async redemption path, not here), and
    ///         how surplus reserve is recovered. Never mints cBTC or touches the BTC backing.
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

    function setParams(uint256 _maxStaleness, uint256 _maxDeviationBps) external onlyOwner {
        maxStaleness = _maxStaleness;
        maxDeviationBps = _maxDeviationBps;
        emit ParamsSet(_maxStaleness, _maxDeviationBps);
    }

    // ---------- the peg shortfall (proven, oracle-free) ----------

    /// @notice Circulating cBTC (totalSupply minus any cBTC sent to this reserve) over the
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
    ///         stale, or deviating feed — fail-closed, so a broken feed only blanks the buffer's BTC
    ///         valuation, never the peg (which is oracle-free).
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

    /// @notice tETH required to equal `cbtcAmt` cBTC at the validated ETH/BTC price (no slippage).
    function cbtcToTeth(uint256 cbtcAmt) public view returns (uint256) {
        (uint256 price, uint8 dec) = ethBtcPrice();
        // teth = cbtcAmt * 10^(TETH_DEC + dec) / (price * 10^CBTC_DEC)
        return cbtcAmt * (10 ** (uint256(TETH_DEC) + uint256(dec))) / (price * (10 ** uint256(CBTC_DEC)));
    }

    /// @notice BTC-equivalent (in cBTC base units / sats) of `tethAmt` tETH at the validated ETH/BTC price.
    function tethToCbtc(uint256 tethAmt) public view returns (uint256) {
        (uint256 price, uint8 dec) = ethBtcPrice();
        // cbtc = tethAmt * price * 10^CBTC_DEC / 10^(TETH_DEC + dec)
        return tethAmt * price * (10 ** uint256(CBTC_DEC)) / (10 ** (uint256(TETH_DEC) + uint256(dec)));
    }

    // ---------- passive solvency view (the buffer's contribution to backing) ----------

    /// @notice The reserve's tETH balance expressed as BTC-equivalent sats at the validated Chainlink mark.
    ///         This is what the buffer adds to cBTC's backing. Reverts (fail-closed) if the feed is unusable.
    function bufferBtcValueSats() public view returns (uint256) {
        return tethToCbtc(IERC20Min(TETH).balanceOf(address(this)));
    }

    /// @notice The residual under-collateralization after the buffer: real-BTC shortfall minus the buffer's
    ///         BTC value. 0 means circulating cBTC is fully covered by real locks + the tETH reserve. A
    ///         non-zero value is the true peg-solvency signal (a rug the buffer cannot fully absorb).
    function uncoveredShortfall() external view returns (uint256) {
        uint256 shortfall = pegShortfall();
        if (shortfall == 0) return 0;
        uint256 cover = bufferBtcValueSats();
        return shortfall > cover ? shortfall - cover : 0;
    }
}
