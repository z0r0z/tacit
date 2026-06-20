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
    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable;
}

interface IERC20Allowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

/// Permit2 (AllowanceTransfer) — for token-in zaps: the user signs an allowance (after a one-time
/// token.approve(PERMIT2, max)) and the router pulls the input token by signature.
interface IPermit2 {
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitSingle {
        PermitDetails details;
        address spender;
        uint256 sigDeadline;
    }

    function permit(address owner, PermitSingle calldata permitSingle, bytes calldata signature) external;
    function transferFrom(address from, address to, uint160 amount, address token) external;
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
    /// Permit2 singleton — the signed pull for token-in zaps.
    IPermit2 public immutable PERMIT2;

    error ZRouterCallFailed();
    error AmountTooLarge();

    /// Parameters for a token-in zap (bundled to keep the entrypoints under the stack limit).
    struct TokenZap {
        address tokenB; // the leg sourced from zRouter (paired with the input token A)
        uint32 feeBps;
        uint256 tokenAForSwap; // token A routed through zRouter for tokenB
        uint256 tokenAForLP; // token A for the LP leg
        uint256 tokenBLeg; // exact tokenB for the LP leg (the swap must source at least this)
        uint256 minShares;
        uint64 deadline;
        bytes32 commit; // recipient's LP-share note commitment
    }

    constructor(address pool_, address zRouter_, address permit2_) {
        POOL = IConfidentialPool(pool_);
        ZROUTER = zRouter_;
        PERMIT2 = IPermit2(permit2_);
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

    // ──────────────────── Token-in zaps (ERC20 via Permit2, confidential output) ────────────────────

    /// @notice Token-in analog of `zapETHIntoShieldedLP`: pull token A (Permit2), route `tokenAForSwap` of it
    ///         through zRouter for `tokenB`, add EXACTLY (`tokenAForLP`, `tokenBLeg`) to the LP, and shield the
    ///         shares into an owner-blinded LP-share note bound to `z.commit`. Token A is the Permit2 permit's
    ///         token; both legs ERC20. Leftovers swept to the caller.
    function zapTokenIntoShieldedLP(
        TokenZap calldata z,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata zrSwapData
    ) external nonReentrant returns (bytes32 depositId, uint256 sharesMinted) {
        address tokenA = permitSingle.details.token;
        (depositId, sharesMinted) = _zapTokenToShieldedShares(tokenA, z, permitSingle, signature, zrSwapData);
        _refund(tokenA, msg.sender);
        _refund(z.tokenB, msg.sender);
    }

    /// @notice Token-in analog of `zapETHIntoFarm`: token A → shielded LP-share note → settle the caller's
    ///         self-proved bond (OP_LP_BOND). Same deterministic-shares + self-proved/fee-free settle model.
    function zapTokenIntoFarm(
        TokenZap calldata z,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata zrSwapData,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external nonReentrant returns (uint256 sharesMinted) {
        address tokenA = permitSingle.details.token;
        (, sharesMinted) = _zapTokenToShieldedShares(tokenA, z, permitSingle, signature, zrSwapData);
        POOL.settle(publicValues, proof, memos);
        _refund(tokenA, msg.sender);
        _refund(z.tokenB, msg.sender);
    }

    // ──────────────────── Swap-and-wrap (any asset -> a confidential NOTE) ────────────────────

    /// @notice Swap native ETH to `tokenOut` on zRouter, then WRAP exactly `wrapAmount` of it into the
    ///         confidential pool as a deposit bound to `commit` — pay in ETH but receive a confidential
    ///         `tokenOut` NOTE (single asset, not LP). `commit` is the recipient's note commitment, so this is
    ///         a private swap-and-shield (or the deposit leg of swap-and-pay; see zapETHToPayment). The swap
    ///         must source at least `wrapAmount` (which must be unitScale-aligned for `tokenOut`); leftovers
    ///         (excess tokenOut + unspent ETH) are swept to the caller.
    function zapETHToShieldedNote(address tokenOut, uint256 wrapAmount, bytes32 commit, bytes calldata zrSwapData)
        external
        payable
        nonReentrant
    {
        _swapAndWrap(tokenOut, wrapAmount, commit, zrSwapData);
        _refund(tokenOut, msg.sender);
        _refundETH(msg.sender);
    }

    /// @notice One-tx private payment funded by ETH in a different asset: swap ETH -> `tokenOut`, wrap exactly
    ///         `wrapAmount` to the recipient's `commit`, then settle the caller's self-proved batch consuming
    ///         the deposit into the recipient's note (+ memo). `wrapAmount` fixes the note value so the dapp
    ///         pre-derives the deposit id for the settle. Self-proved / fee-free settle (msg.sender == this
    ///         router), same constraint as the wrap router's wrapAndSettle.
    function zapETHToPayment(
        address tokenOut,
        uint256 wrapAmount,
        bytes32 commit,
        bytes calldata zrSwapData,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external payable nonReentrant {
        _swapAndWrap(tokenOut, wrapAmount, commit, zrSwapData);
        POOL.settle(publicValues, proof, memos);
        _refund(tokenOut, msg.sender);
        _refundETH(msg.sender);
    }

    // ──────────────────── Internals ────────────────────

    /// Swap msg.value of ETH to `tokenOut` on zRouter (caller's calldata, output to this), then wrap EXACTLY
    /// `wrapAmount` into the pool as a deposit for `commit`. The swap must source >= wrapAmount.
    function _swapAndWrap(address tokenOut, uint256 wrapAmount, bytes32 commit, bytes calldata zrSwapData) internal {
        uint256 beforeOut = SafeTransferLib.balanceOf(tokenOut, address(this));
        (bool ok, bytes memory ret) = ZROUTER.call{value: msg.value}(zrSwapData);
        if (!ok) {
            if (ret.length != 0) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert ZRouterCallFailed();
        }
        require(SafeTransferLib.balanceOf(tokenOut, address(this)) - beforeOut >= wrapAmount, "zap: short swap output");
        _lazyApprove(tokenOut, address(POOL), wrapAmount);
        POOL.wrap(_evmAssetId(tokenOut), wrapAmount, commit);
    }

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

    /// Token-in core: pull token A (Permit2), swap `tokenAForSwap` of it on zRouter for >= tokenBLeg, add
    /// EXACTLY (tokenAForLP, tokenBLeg) to the LP (deterministic shares), and shield the shares to `commit`.
    function _zapTokenToShieldedShares(
        address tokenA,
        TokenZap calldata z,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata zrSwapData
    ) internal returns (bytes32 depositId, uint256 sharesMinted) {
        uint256 total = z.tokenAForSwap + z.tokenAForLP;
        if (total > type(uint160).max) revert AmountTooLarge();
        try PERMIT2.permit(msg.sender, permitSingle, signature) {} catch {}
        PERMIT2.transferFrom(msg.sender, address(this), uint160(total), tokenA);
        _lazyApprove(tokenA, ZROUTER, z.tokenAForSwap); // let zRouter pull the swap input
        uint256 beforeB = SafeTransferLib.balanceOf(z.tokenB, address(this));
        (bool ok, bytes memory ret) = ZROUTER.call(zrSwapData);
        if (!ok) {
            if (ret.length != 0) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert ZRouterCallFailed();
        }
        require(SafeTransferLib.balanceOf(z.tokenB, address(this)) - beforeB >= z.tokenBLeg, "zap: short swap output");
        bytes32 tokenAId = _evmAssetId(tokenA);
        bytes32 tokenBId = _evmAssetId(z.tokenB);
        _lazyApprove(tokenA, address(POOL), z.tokenAForLP);
        _lazyApprove(z.tokenB, address(POOL), z.tokenBLeg);
        sharesMinted = POOL.createPairAndAddLiquidityPublic(
            tokenAId, tokenBId, z.feeBps, z.tokenAForLP, z.tokenBLeg, z.minShares, z.deadline, address(this)
        );
        depositId = POOL.shieldShares(_poolId(tokenAId, tokenBId, z.feeBps), sharesMinted, z.commit);
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
