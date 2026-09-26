// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IBuybackPool {
    function pools(bytes32 poolId)
        external
        view
        returns (bool init, bytes32 assetA, bytes32 assetB, uint256 reserveA, uint256 reserveB, uint32 feeBps, uint256 totalShares);

    function assets(bytes32 assetId)
        external
        view
        returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals);
}

interface IBuybackAmm {
    function POOL() external view returns (IBuybackPool);

    function swapPublic(
        bytes32 assetIn,
        bytes32 assetOut,
        uint32 feeBps,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to
    ) external payable returns (uint256 amountOut);
}

interface IBuybackToken {
    function balanceOf(address) external view returns (uint256);
}

interface IPrecisionPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function reserve0() external view returns (uint256);
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to)
        external
        payable
        returns (uint256 amountOut);
}

/// @title TacBuyback — turns ETH into TAC for the protocol reserve
/// @notice Holds ETH sent to it (a relay fee share, a treasury top-up, anything) and buys TAC with it on one of
///         two fixed venues: the Tacit pool's public TAC/ETH curve (VENUE_TACIT), or zfi's TAC/ETH Precision
///         pool (VENUE_PRECISION, optional). Either way the TAC is delivered straight to RESERVE, so this
///         contract never holds it. ETH leaves only two ways: as a buy into RESERVE, or as a flush to RESERVE.
///
///         Buys are made by KEEPER, which picks the size and the minimum output from its own quote. A buy is
///         additionally bounded here, whatever the keeper passes:
///           - at most MAX_PER_BUY wei per buy,
///           - at most one buy per COOLDOWN seconds,
///           - at most MAX_IMPACT_BPS of the chosen venue's current ETH reserve, which caps the price impact
///             of any single buy against a thin pool.
///         The cooldown is shared by both venues.
///         So a lost or misused keeper key can only make small, spaced buys into the reserve; it can never
///         move the ETH anywhere else. RESERVE (or KEEPER) can flush the ETH to RESERVE at any time, which
///         is the way out if the keeper is gone or the policy changes.
///
///         Immutable: no owner, no parameter changes. A different policy is a new deployment.
contract TacBuyback {
    uint8 public constant VENUE_TACIT = 0;
    uint8 public constant VENUE_PRECISION = 1;

    IBuybackAmm public immutable AMM;
    IPrecisionPool public immutable PRECISION;
    address public immutable RESERVE;
    address public immutable KEEPER;
    IBuybackToken public immutable TAC;
    bytes32 public immutable ETH_ASSET;
    bytes32 public immutable TAC_ASSET;
    uint32 public immutable FEE_BPS;
    bytes32 public immutable POOL_ID;
    uint256 public immutable UNIT;
    uint256 public immutable MAX_PER_BUY;
    uint256 public immutable COOLDOWN;
    uint256 public immutable MAX_IMPACT_BPS;

    uint256 public lastBuyAt;

    error BadConfig();
    error NotKeeper();
    error NotAllowed();
    error TooSoon();
    error BadAmount();
    error TooMuchImpact();
    error Expired();
    error NoVenue();

    event Bought(uint8 indexed venue, uint256 ethIn, uint256 tacOut);
    event Flushed(uint256 ethOut);

    /// `precision` may be address(0) for a Tacit-pool-only deployment.
    constructor(
        address amm,
        address precision,
        address reserve,
        address keeper,
        bytes32 ethAsset,
        bytes32 tacAsset,
        uint32 feeBps,
        uint256 maxPerBuy,
        uint256 cooldown,
        uint256 maxImpactBps
    ) {
        if (amm.code.length == 0 || reserve == address(0) || keeper == address(0)) revert BadConfig();
        if (maxPerBuy == 0 || maxImpactBps == 0 || maxImpactBps > 1000 || cooldown > 30 days) revert BadConfig();
        IBuybackPool pool = IBuybackAmm(amm).POOL();
        // The input must be the pool's native-ETH asset and the output a pool-minted asset, or every buy
        // would revert (or, worse, pay out something other than TAC). Checked once here, not on every buy.
        (bool ethReg, address ethUnderlying, uint256 unit,,,) = pool.assets(ethAsset);
        (bool tacReg, address tacToken,,, bool tacMinted,) = pool.assets(tacAsset);
        if (!ethReg || ethUnderlying != address(0) || unit == 0 || !tacReg || !tacMinted) revert BadConfig();
        (bytes32 lo, bytes32 hi) = ethAsset < tacAsset ? (ethAsset, tacAsset) : (tacAsset, ethAsset);
        bytes32 poolId = keccak256(abi.encode(lo, hi, feeBps));
        (bool init,,,,,,) = pool.pools(poolId);
        if (!init) revert BadConfig();
        // Both venues must trade the same TAC for the same native ETH.
        if (precision != address(0)) {
            if (IPrecisionPool(precision).token0() != address(0) || IPrecisionPool(precision).token1() != tacToken) {
                revert BadConfig();
            }
        }

        AMM = IBuybackAmm(amm);
        PRECISION = IPrecisionPool(precision);
        RESERVE = reserve;
        KEEPER = keeper;
        TAC = IBuybackToken(tacToken);
        ETH_ASSET = ethAsset;
        TAC_ASSET = tacAsset;
        FEE_BPS = feeBps;
        POOL_ID = poolId;
        UNIT = unit;
        MAX_PER_BUY = maxPerBuy;
        COOLDOWN = cooldown;
        MAX_IMPACT_BPS = maxImpactBps;
    }

    receive() external payable {}

    /// Buys TAC on `venue` with `amountIn` wei (rounded down to the Tacit pool's ETH unit on both venues) and
    /// sends it to RESERVE. `minTacOut` is in TAC wei and must be nonzero; `deadline` is a unix-seconds expiry
    /// (0 = none), enforced here since the Precision pool takes none.
    function buy(uint8 venue, uint256 amountIn, uint256 minTacOut, uint64 deadline) external returns (uint256 tacOut) {
        if (msg.sender != KEEPER) revert NotKeeper();
        if (deadline != 0 && block.timestamp > deadline) revert Expired();
        if (block.timestamp < lastBuyAt + COOLDOWN) revert TooSoon();
        amountIn -= amountIn % UNIT;
        if (amountIn == 0 || amountIn > MAX_PER_BUY || amountIn > address(this).balance || minTacOut == 0) {
            revert BadAmount();
        }
        lastBuyAt = block.timestamp;

        // What the reserve actually received is what counts, not what the venue reports.
        uint256 before = TAC.balanceOf(RESERVE);
        if (venue == VENUE_TACIT) {
            (, bytes32 assetA,, uint256 reserveA, uint256 reserveB,,) = AMM.POOL().pools(POOL_ID);
            uint256 ethReserveWei = (assetA == ETH_ASSET ? reserveA : reserveB) * UNIT;
            if (amountIn * 10_000 > ethReserveWei * MAX_IMPACT_BPS) revert TooMuchImpact();
            AMM.swapPublic{value: amountIn}(ETH_ASSET, TAC_ASSET, FEE_BPS, amountIn, minTacOut, deadline, RESERVE);
        } else if (venue == VENUE_PRECISION && address(PRECISION) != address(0)) {
            if (amountIn * 10_000 > PRECISION.reserve0() * MAX_IMPACT_BPS) revert TooMuchImpact();
            PRECISION.swapExactIn{value: amountIn}(address(0), amountIn, minTacOut, RESERVE);
        } else {
            revert NoVenue();
        }
        tacOut = TAC.balanceOf(RESERVE) - before;
        if (tacOut < minTacOut) revert BadAmount();
        emit Bought(venue, amountIn, tacOut);
    }

    /// Sends all ETH held here to RESERVE.
    function flush() external {
        if (msg.sender != RESERVE && msg.sender != KEEPER) revert NotAllowed();
        uint256 bal = address(this).balance;
        SafeTransferLib.safeTransferETH(RESERVE, bal);
        emit Flushed(bal);
    }
}
