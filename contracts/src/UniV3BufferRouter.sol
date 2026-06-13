// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IBufferRouter} from "./CbtcBuffer.sol";

/// @notice Uniswap V3 SwapRouter (exact-output single-hop) — the minimal surface this adapter needs.
interface ISwapRouter {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params) external returns (uint256 amountIn);
}

/// @title UniV3BufferRouter
/// @notice Concrete `IBufferRouter` for `CbtcBuffer`: routes the permissionless shortfall buyback
///         (tETH -> cBTC) through a Uniswap V3 pool as an EXACT-OUTPUT swap, so the buffer gets exactly
///         the `amountOut` cBTC it needs to cover the peg shortfall and spends no more than `maxIn` tETH
///         (the buffer already fair-prices + slippage-bounds `maxIn` from Chainlink). Thin + stateless:
///         the caller (the buffer) holds the funds, fair-prices, and sequesters the bought cBTC; this
///         only executes the venue swap and refunds the unspent tETH. The buffer's `router` is
///         owner-swappable, so this venue is not locked in — a different DEX/aggregator adapter that
///         implements `IBufferRouter` can replace it without touching the buffer.
contract UniV3BufferRouter is IBufferRouter {
    ISwapRouter public immutable SWAP_ROUTER;

    error NotImproved(); // got less cBTC than requested (venue underdelivered)

    constructor(address swapRouter) {
        SWAP_ROUTER = ISwapRouter(swapRouter);
    }

    /// @inheritdoc IBufferRouter
    /// @param route abi.encode(uint24 fee) — the Uniswap V3 fee tier of the tETH/cBTC pool.
    function buyExactCbtc(address teth, address cbtc, uint256 amountOut, uint256 maxIn, address to, bytes calldata route)
        external
        returns (uint256 spent)
    {
        uint24 fee = abi.decode(route, (uint24));

        // Pull the caller's tETH (the buffer approved `maxIn`), then approve the venue for it.
        SafeTransferLib.safeTransferFrom(teth, msg.sender, address(this), maxIn);
        SafeTransferLib.safeApproveWithRetry(teth, address(SWAP_ROUTER), maxIn);

        // Exact-output: the venue takes exactly `amountOut` cBTC out to `to`, pulling <= maxIn tETH in.
        spent = SWAP_ROUTER.exactOutputSingle(
            ISwapRouter.ExactOutputSingleParams({
                tokenIn: teth,
                tokenOut: cbtc,
                fee: fee,
                recipient: to,
                deadline: block.timestamp,
                amountOut: amountOut,
                amountInMaximum: maxIn,
                sqrtPriceLimitX96: 0
            })
        );

        // Drop the residual allowance and refund the unspent tETH to the buffer.
        SafeTransferLib.safeApprove(teth, address(SWAP_ROUTER), 0);
        if (spent < maxIn) SafeTransferLib.safeTransfer(teth, msg.sender, maxIn - spent);
    }
}
