// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IConfidentialPool {
    function createPairAndAddLiquidityPublic(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        uint256 amountA,
        uint256 amountB,
        uint256 minSharesOut,
        uint64 deadline,
        address to
    ) external payable returns (uint256 sharesMinted);
    function shieldShares(bytes32 poolId, uint256 shares, bytes32 commit) external returns (bytes32 depositId);
    function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) external;
}

interface IERC20Allowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title ConfidentialZapRouter
/// @notice Cold-start zap into a Tacit confidential-pool public LP: a user supplies a SINGLE asset (native
///         ETH here), the router sources the other leg from the pinned external aggregator (zRouter), and
///         adds both into the confidential pool's public AMM in one tx — so a brand-new (illiquid) Tacit pool
///         can be seeded against deep external liquidity. Deliberately SEPARATE from the wrap/payment router:
///         zaps touch an external contract + multi-step custody, a riskier surface that shouldn't share the
///         lean wrap path.
///
///  zRouter is the pinned aggregator (0x000000000000FB114709235f1ccBFfb925F600e4) — it routes a swap across
///  V2/V3/V4/Curve/zAMM internally, so ONE pinned target reaches every venue. The caller passes the exact
///  swap call (`zrSwapData`) for whichever venue has depth for the pair; the router only ever calls THIS
///  immutable target — the target is never arbitrary, only the swap selection within zRouter is the caller's.
///
///  Safety: the external target is PINNED (immutable). The router holds NO standing token approval to zRouter,
///  so a hostile `zrSwapData` can at most waste the ETH it forwards. The realized output is measured by
///  balance delta and slippage-checked downstream by the pool's `minShares`; the router sweeps every leftover
///  (the pool's off-ratio refund + any dust, ETH or token) back to the caller, holding nothing across calls.
///  A malformed/hostile swap yields too little output, the LP add reverts on slippage, and the whole tx
///  unwinds — fail-closed, no fund risk. nonReentrant throughout.
contract ConfidentialZapRouter is ReentrancyGuardTransient {
    IConfidentialPool public immutable POOL;
    /// zRouter — the pinned external AMM aggregator. Low-level-called with caller-built swap calldata so any
    /// zRouter venue (V2/V3/V4/Curve/zAMM) works without this router hardcoding one; the address is immutable.
    address public immutable ZROUTER;

    error ZRouterCallFailed();

    constructor(address pool_, address zRouter_) {
        POOL = IConfidentialPool(pool_);
        ZROUTER = zRouter_;
    }

    /// @notice Cold-start zap from native ETH: route `ethToSwap` of `msg.value` through zRouter for `tokenB`
    ///         (via the caller's `zrSwapData`, which MUST send the output to this router), then add the
    ///         remaining ETH + the received `tokenB` into the confidential pool's public LP (tETH/tokenB at
    ///         `feeBps`), crediting shares to `to`. The pool is lazily created on the first add (cold start),
    ///         so the (remaining ETH : received tokenB) ratio sets the initial price — the caller chooses
    ///         `ethToSwap` (and the swap's amounts) to land the price they want. Leftovers go back to the caller.
    /// @param tokenB     the ERC20 other leg (registered in the pool); paired with native ETH (tETH).
    /// @param feeBps     the confidential pool's fee tier for the pair.
    /// @param ethToSwap  how much of msg.value to forward to zRouter for the swap (the rest is the ETH leg).
    /// @param minShares  slippage floor on the LP shares minted (the downstream backstop; set the swap's own
    ///                   amountLimit inside `zrSwapData` too).
    /// @param deadline   expiry for the LP add (the swap's own deadline lives in `zrSwapData`).
    /// @param to         recipient of the LP shares.
    /// @param zrSwapData ABI-encoded zRouter swap call (e.g. swapV2/swapV3/swapV4/swapVZ/swapCurve) for the
    ///                   venue with depth, swapping ETH->tokenB with the output recipient set to THIS router.
    function zapETHIntoLP(
        address tokenB,
        uint32 feeBps,
        uint256 ethToSwap,
        uint256 minShares,
        uint64 deadline,
        address to,
        bytes calldata zrSwapData
    ) external payable nonReentrant returns (uint256 sharesMinted) {
        uint256 remainingEth = msg.value - ethToSwap; // reverts (underflow) if ethToSwap > msg.value

        // 1. Source tokenB from the pinned aggregator with the caller's swap calldata; measure what actually
        //    arrived by balance delta (the LP leg then reflects exactly the realized output).
        uint256 beforeB = SafeTransferLib.balanceOf(tokenB, address(this));
        (bool ok, bytes memory ret) = ZROUTER.call{value: ethToSwap}(zrSwapData);
        if (!ok) {
            if (ret.length != 0) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert ZRouterCallFailed();
        }
        uint256 gotB = SafeTransferLib.balanceOf(tokenB, address(this)) - beforeB;

        // 2. Add (remaining ETH, tokenB) to the public LP. tETH is the native leg (covered by msg.value here).
        _lazyApprove(tokenB, address(POOL), gotB);
        sharesMinted = POOL.createPairAndAddLiquidityPublic{value: remainingEth}(
            _evmAssetId(address(0)), _evmAssetId(tokenB), feeBps, remainingEth, gotB, minShares, deadline, to
        );

        // 3. Sweep every leftover back to the caller (the pool's off-ratio refund + any swap dust).
        _refund(tokenB, msg.sender);
        _refundETH(msg.sender);
    }

    // ──────────────────── Confidential-output zaps (public entry, shielded position) ────────────────────

    /// @notice Same public entry (ETH → zRouter → LP) as `zapETHIntoLP`, but the LP position is delivered
    ///         CONFIDENTIALLY: the minted shares are shielded into an owner-blinded LP-share NOTE bound to
    ///         `commit` (the recipient's note commitment), so the holder can send it privately or bond it
    ///         into a farm — vs `zapETHIntoLP`, which leaves a PUBLIC (transparent) lpShares balance. The swap
    ///         + add are still public (amounts/sender visible); only the OUTPUT position is shielded. Uses
    ///         EXACT legs (`ethLeg`, `tokenBLeg`) so the minted share count is deterministic (the dapp can
    ///         pre-derive it for the note/bond). Returns the LP-share-note deposit id (consume it with a
    ///         settle to mint the note).
    function zapETHIntoShieldedLP(
        address tokenB,
        uint32 feeBps,
        uint256 ethLeg,
        uint256 tokenBLeg,
        uint256 minShares,
        uint64 deadline,
        bytes32 commit,
        bytes calldata zrSwapData
    ) external payable nonReentrant returns (bytes32 depositId, uint256 sharesMinted) {
        (depositId, sharesMinted) =
            _zapToShieldedShares(tokenB, feeBps, ethLeg, tokenBLeg, minShares, deadline, commit, zrSwapData);
        _refund(tokenB, msg.sender);
        _refundETH(msg.sender);
    }

    /// @notice One-tx ETH → CONFIDENTIAL farm position: zap into the LP, shield the shares to `commit`, then
    ///         settle the caller's self-proved batch that consumes the LP-share deposit and bonds it
    ///         (OP_LP_BOND → owner-blinded farm-receipt note earning TAC rewards). Deterministic shares (exact
    ///         legs) let the dapp pre-build the bond proof for the exact share count. Self-proved / fee-free
    ///         settle (runs with msg.sender == this router), same constraint as the wrap router's wrapAndSettle.
    function zapETHIntoFarm(
        address tokenB,
        uint32 feeBps,
        uint256 ethLeg,
        uint256 tokenBLeg,
        uint256 minShares,
        uint64 deadline,
        bytes32 commit,
        bytes calldata zrSwapData,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external payable nonReentrant returns (uint256 sharesMinted) {
        (, sharesMinted) =
            _zapToShieldedShares(tokenB, feeBps, ethLeg, tokenBLeg, minShares, deadline, commit, zrSwapData);
        POOL.settle(publicValues, proof, memos);
        _refund(tokenB, msg.sender);
        _refundETH(msg.sender);
    }

    // ──────────────────── Internals ────────────────────

    /// Exact-leg zap → shield the LP shares into a note deposit. Swaps for AT LEAST `tokenBLeg` on zRouter
    /// (caller's exact-out calldata), adds EXACTLY (ethLeg, tokenBLeg) to the LP (so the minted share count is
    /// deterministic), and shields the minted shares to `commit`. Leftovers are swept by the public caller.
    function _zapToShieldedShares(
        address tokenB,
        uint32 feeBps,
        uint256 ethLeg,
        uint256 tokenBLeg,
        uint256 minShares,
        uint64 deadline,
        bytes32 commit,
        bytes calldata zrSwapData
    ) internal returns (bytes32 depositId, uint256 sharesMinted) {
        uint256 ethForSwap = msg.value - ethLeg; // reverts (underflow) if ethLeg > msg.value
        uint256 beforeB = SafeTransferLib.balanceOf(tokenB, address(this));
        (bool ok, bytes memory ret) = ZROUTER.call{value: ethForSwap}(zrSwapData);
        if (!ok) {
            if (ret.length != 0) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert ZRouterCallFailed();
        }
        require(SafeTransferLib.balanceOf(tokenB, address(this)) - beforeB >= tokenBLeg, "zap: short swap output");
        bytes32 tethId = _evmAssetId(address(0));
        bytes32 tokenBId = _evmAssetId(tokenB);
        _lazyApprove(tokenB, address(POOL), tokenBLeg);
        // EXACT legs ⇒ deterministic shares; `to == this` so the router holds them to shield.
        sharesMinted = POOL.createPairAndAddLiquidityPublic{value: ethLeg}(
            tethId, tokenBId, feeBps, ethLeg, tokenBLeg, minShares, deadline, address(this)
        );
        depositId = POOL.shieldShares(_poolId(tethId, tokenBId, feeBps), sharesMinted, commit);
    }

    /// Canonical poolId — mirrors ConfidentialPool._poolId (keccak(lo ‖ hi ‖ feeBps)).
    function _poolId(bytes32 a, bytes32 b, uint32 feeBps) internal pure returns (bytes32) {
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encodePacked(lo, hi, uint256(feeBps)));
    }

    /// Lazily grant `spender` (the pool, or zRouter on a future token-in path) an infinite allowance — once
    /// per (token, spender) — vs a fresh approve every call. Safe: the router holds no token balance between
    /// calls, and spenders are the pinned pool / pinned zRouter.
    function _lazyApprove(address token, address spender, uint256 amount) internal {
        if (IERC20Allowance(token).allowance(address(this), spender) < amount) {
            SafeTransferLib.safeApproveWithRetry(token, spender, type(uint256).max);
        }
    }

    function _refund(address token, address to) internal {
        uint256 bal = SafeTransferLib.balanceOf(token, address(this));
        if (bal != 0) SafeTransferLib.safeTransfer(token, to, bal);
    }

    function _refundETH(address to) internal {
        uint256 bal = address(this).balance;
        if (bal != 0) SafeTransferLib.forceSafeTransferETH(to, bal);
    }

    /// MUST mirror ConfidentialPool._evmAssetId: sha256("tacit-evm-token-v1" ‖ chainid ‖ underlying). For
    /// native ETH pass address(0) (== the id the pool registered tETH under).
    function _evmAssetId(address underlying) internal view returns (bytes32 assetId) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, shl(112, 0x74616369742d65766d2d746f6b656e2d7631)) // "tacit-evm-token-v1"
            mstore(add(m, 18), shl(192, chainid()))
            mstore(add(m, 26), shl(96, underlying))
            if iszero(staticcall(gas(), 2, m, 46, m, 32)) { revert(0, 0) }
            assetId := mload(m)
        }
    }

    /// Accept the pool's native-ETH off-ratio refund (forceSafeTransferETH) so it lands cleanly to be swept.
    receive() external payable {}
}
