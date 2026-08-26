// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IConfidentialPoolAmm {
    function pools(bytes32 poolId)
        external
        view
        returns (bool init, bytes32 assetA, bytes32 assetB, uint256 reserveA, uint256 reserveB, uint32 feeBps, uint256 totalShares);

    function assets(bytes32 assetId)
        external
        view
        returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals);

    function applyPublicSwap(
        bytes32 assetIn,
        bytes32 assetOut,
        uint32 feeBps,
        uint256 amountIn,
        uint256 vOut,
        address to
    ) external payable returns (uint256 amountOut);

    function applyPublicAddLiquidity(
        bytes32 assetLo,
        bytes32 assetHi,
        uint32 feeBps,
        uint256 amtLo,
        uint256 amtHi,
        uint256 minted,
        uint256 addLo,
        uint256 addHi,
        address to
    ) external payable returns (uint256 sharesMinted);

    function applyPublicRemoveLiquidity(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        uint256 shares,
        address owner,
        address to
    ) external returns (uint256 amountLo, uint256 amountHi);
}

/// @notice Plaintext public-AMM periphery for ConfidentialPool. This is the standard AMM UX (create/add,
///         remove, swap) against a pool's PUBLIC reserves — no proof, amounts revealed. It orchestrates the
///         public path (pool/pair derivation, quoting, slippage + deadline bounds, LP-operator delegation,
///         input pull) and forwards the state moves to the pool's narrow apply* applicators, which re-derive
///         the pool and enforce the conservation invariants (k non-decrease on swap, share↔reserve backing on
///         add/remove) so this contract can never move escrow beyond the AMM math. Users approve THIS contract
///         for `tokenIn`; it pulls the input, forwards the exact amount to the pool, and the pool pays the
///         output straight to the recipient. Immutable — the pool authorizes exactly this address forever.
contract TacitPublicAmm {
    /// The pool this periphery serves. Set ONCE by the deployer via `initialize` right after the pool is
    /// deployed with this periphery as its immutable PUBLIC_AMM — the two references are mutually dependent, so
    /// one of them is wired post-construction. Only the deployer may set it, and only while unset, so it is
    /// fixed atomically in the deploy sequence and can never be re-pointed at a different pool afterward.
    IConfidentialPoolAmm public POOL;
    address internal immutable DEPLOYER;

    /// Permanent noteless liquidity floor — MUST match ConfidentialPool.MINIMUM_LIQUIDITY.
    uint256 internal constant MINIMUM_LIQUIDITY = 1000;

    // owner => operator allowed to removeLiquidityPublicFrom(owner). All-or-nothing delegation (the
    // ERC-4626/setApprovalForAll model): the operator may remove ANY amount of the owner's public LP shares.
    mapping(address => address) public lpOperator;

    // Selectors mirror ConfidentialPool's so callers/tests observe identical reverts across the two paths.
    error Expired();
    error SameAsset();
    error PoolNotInit();
    error ZeroAddress();
    error NotRegistered();
    error ValueOutOfRange();
    error AmountNotAligned();
    error SlippageExceeded();
    error InsufficientLiquidity();
    error AlreadyInitialized();

    constructor() {
        DEPLOYER = msg.sender;
    }

    /// @notice One-shot wiring of the pool reference by the deployer, right after the pool is constructed with
    ///         this periphery as its immutable PUBLIC_AMM. Reverts once set or if called by anyone else.
    function initialize(address pool_) external {
        if (msg.sender != DEPLOYER || address(POOL) != address(0)) revert AlreadyInitialized();
        if (pool_ == address(0)) revert ZeroAddress();
        POOL = IConfidentialPoolAmm(pool_);
    }

    // ──────────────────── Public entrypoints ────────────────────

    /// @notice Atomic create-and-seed from PUBLIC funds (zAMM-style): lazy-create the pool, deposit
    ///         `amountA`/`amountB` (ERC20 and/or native ETH via msg.value — EITHER side may be tETH), set
    ///         reserves, and credit public LP shares to `to`. First add → totalShares = isqrt(vA·vB) with
    ///         MINIMUM_LIQUIDITY locked (noteless floor); later add → proportional (limiting-leg min rule),
    ///         with the off-ratio excess of the other leg refunded to the caller. One tx, no proof.
    function createPairAndAddLiquidityPublic(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        uint256 amountA,
        uint256 amountB,
        uint256 minSharesOut,
        uint64 deadline,
        address to
    ) external payable returns (uint256 sharesMinted) {
        _checkDeadline(deadline);
        _checkRecipient(to);
        if (assetA == assetB) revert SameAsset(); // parity with the swap path; the pool rejects a self-pair too
        // Canonical orientation: reserveA is the LOW asset's reserve. Map the caller's (asset,amount) pairs.
        (bytes32 assetLo, bytes32 assetHi, uint256 amtLo, uint256 amtHi) =
            assetA < assetB ? (assetA, assetB, amountA, amountB) : (assetB, assetA, amountB, amountA);
        bytes32 poolId = _poolId(assetLo, assetHi, feeBps);
        (bool init,,, uint256 reserveA, uint256 reserveB,, uint256 totalShares) = POOL.pools(poolId);
        uint256 vLo = _pullForPool(assetLo, amtLo);
        uint256 vHi = _pullForPool(assetHi, amtHi);
        uint256 minted;
        uint256 addLo;
        uint256 addHi;
        if (init && totalShares != 0) {
            uint256 sA = (vLo * totalShares) / reserveA;
            uint256 sB = (vHi * totalShares) / reserveB;
            minted = sA < sB ? sA : sB;
            if (minted == 0) revert InsufficientLiquidity();
            // CEIL reserve required for the minted shares (favors existing LPs); refunds the excess leg.
            addLo = _ceilDiv(minted * reserveA, totalShares);
            addHi = _ceilDiv(minted * reserveB, totalShares);
        } else {
            minted = _isqrt(vLo * vHi);
            if (minted <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            addLo = vLo; // founding add: all deposited backs the reserves
            addHi = vHi;
        }
        sharesMinted =
            POOL.applyPublicAddLiquidity{value: msg.value}(assetLo, assetHi, feeBps, amtLo, amtHi, minted, addLo, addHi, to);
        if (sharesMinted < minSharesOut) revert SlippageExceeded(); // shares slippage (price moved before inclusion)
    }

    /// @notice Approve `operator` to call `removeLiquidityPublicFrom(.., msg.sender, to)` on the caller's
    ///         behalf. All-or-nothing delegation — approve only a trusted router/contract; pass address(0) to
    ///         revoke.
    function approveLpOperator(address operator) external {
        lpOperator[msg.sender] = operator;
    }

    /// @notice Burn the caller's PUBLIC LP shares and withdraw the proportional reserves to `to`.
    function removeLiquidityPublic(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        uint256 shares,
        uint256 minAmountA,
        uint256 minAmountB,
        uint64 deadline,
        address to
    ) external returns (uint256 amountLo, uint256 amountHi) {
        return removeLiquidityPublicFrom(assetA, assetB, feeBps, shares, minAmountA, minAmountB, deadline, msg.sender, to);
    }

    /// @notice Burn PUBLIC LP shares of `owner` and withdraw the proportional reserves to `to`. If
    ///         `owner != msg.sender`, the caller must be an LP operator approved by `owner` via
    ///         `approveLpOperator(caller)`. Can never remove the locked MINIMUM_LIQUIDITY.
    function removeLiquidityPublicFrom(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        uint256 shares,
        uint256 minAmountA,
        uint256 minAmountB,
        uint64 deadline,
        address owner,
        address to
    ) public returns (uint256 amountLo, uint256 amountHi) {
        if (owner != msg.sender && lpOperator[owner] != msg.sender) revert InsufficientLiquidity();
        _checkDeadline(deadline);
        _checkRecipient(to); // parity with swap/create payout paths; the pool guards this too (belt + suspenders)
        (amountLo, amountHi) = POOL.applyPublicRemoveLiquidity(assetA, assetB, feeBps, shares, owner, to);
        // Output slippage in the caller's (assetA, assetB) orientation, mapped to canonical lo/hi.
        (uint256 minLo, uint256 minHi) = assetA < assetB ? (minAmountA, minAmountB) : (minAmountB, minAmountA);
        if (amountLo < minLo || amountHi < minHi) revert SlippageExceeded();
    }

    /// @notice PUBLIC swap against a pool's public reserves (no privacy — the amount is revealed; for a
    ///         hidden-amount swap use the confidential OP_SWAP). Constant-product with the pool fee; k can only
    ///         increase. `minAmountOut` is in the OUTPUT asset's underlying units; `deadline` is a unix-secs
    ///         expiry (0 = none).
    function swapPublic(
        bytes32 assetIn,
        bytes32 assetOut,
        uint32 feeBps,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to
    ) external payable returns (uint256 amountOut) {
        _checkDeadline(deadline);
        _checkRecipient(to);
        if (assetIn == assetOut) revert SameAsset();
        (bytes32 lo, bytes32 hi) = assetIn < assetOut ? (assetIn, assetOut) : (assetOut, assetIn);
        bytes32 poolId = _poolId(lo, hi, feeBps);
        (bool init,,, uint256 reserveA, uint256 reserveB, uint32 poolFee,) = POOL.pools(poolId);
        if (!init) revert PoolNotInit();
        uint256 vIn = _pullForPool(assetIn, amountIn);
        (uint256 reserveIn, uint256 reserveOut) = assetIn == lo ? (reserveA, reserveB) : (reserveB, reserveA);
        uint256 vOut = _ammOut(reserveIn, reserveOut, vIn, poolFee);
        amountOut = POOL.applyPublicSwap{value: msg.value}(assetIn, assetOut, feeBps, amountIn, vOut, to);
        if (amountOut < minAmountOut) revert SlippageExceeded();
    }

    // ──────────────────── Quoting (read) ────────────────────

    /// @notice Constant-product output for `amountIn` of `assetIn` against the (assetIn, assetOut, feeBps)
    ///         pool at its current reserves — the exact figure `swapPublic` clears at.
    function quoteSwap(bytes32 assetIn, bytes32 assetOut, uint32 feeBps, uint256 amountIn)
        external
        view
        returns (uint256 amountOut)
    {
        if (assetIn == assetOut) revert SameAsset();
        (bytes32 lo, bytes32 hi) = assetIn < assetOut ? (assetIn, assetOut) : (assetOut, assetIn);
        (bool init,,, uint256 reserveA, uint256 reserveB, uint32 poolFee,) = POOL.pools(_poolId(lo, hi, feeBps));
        if (!init) revert PoolNotInit();
        (,, uint256 unitScaleIn,,,) = POOL.assets(assetIn);
        (,, uint256 unitScaleOut,,,) = POOL.assets(assetOut);
        uint256 vIn = _toValue(amountIn, unitScaleIn);
        (uint256 reserveIn, uint256 reserveOut) = assetIn == lo ? (reserveA, reserveB) : (reserveB, reserveA);
        amountOut = _ammOut(reserveIn, reserveOut, vIn, poolFee) * unitScaleOut;
    }

    // ──────────────────── Internals ────────────────────

    /// @dev Pull `amount` of `assetId` from the caller so the pool's ingest can take it (burn/escrow/transfer),
    ///      and return the in-system value (amount / unitScale). Native ETH stays in msg.value and is forwarded
    ///      to the applicator; every other asset is pulled to this contract and approved to the pool (a
    ///      pool-minted asset is burned FROM this contract, so it only needs the balance). The value math
    ///      mirrors the pool's ingest so the quoted shares/output match what the applicator recomputes.
    function _pullForPool(bytes32 assetId, uint256 amount) internal returns (uint256 value) {
        (bool registered, address underlying, uint256 unitScale,,,) = POOL.assets(assetId);
        if (!registered) revert NotRegistered();
        value = _toValue(amount, unitScale);
        if (underlying != address(0)) {
            SafeTransferLib.safeTransferFrom(underlying, msg.sender, address(this), amount);
            SafeTransferLib.safeApproveWithRetry(underlying, address(POOL), amount);
        }
    }

    function _toValue(uint256 amount, uint256 unitScale) internal pure returns (uint256 value) {
        if (amount == 0 || unitScale == 0 || amount % unitScale != 0) revert AmountNotAligned();
        value = amount / unitScale;
        if (value > type(uint64).max) revert ValueOutOfRange();
    }

    function _poolId(bytes32 lo, bytes32 hi, uint32 feeBps) internal pure returns (bytes32) {
        return keccak256(abi.encode(lo, hi, feeBps));
    }

    /// @dev Constant-product output: out = floor(reserveOut·vIn·γ / (reserveIn·10000 + vIn·γ)), γ = 10000 −
    ///      feeBps. Reverts on a zero-or-full-drain output. Mirrors the shielded settle path's clearing math.
    function _ammOut(uint256 reserveIn, uint256 reserveOut, uint256 vIn, uint32 feeBps)
        internal
        pure
        returns (uint256 vOut)
    {
        unchecked {
            uint256 vInG = vIn * (10000 - uint256(feeBps));
            vOut = (reserveOut * vInG) / (reserveIn * 10000 + vInG);
        }
        if (vOut == 0 || vOut >= reserveOut) revert InsufficientLiquidity();
    }

    /// @dev Integer sqrt (Babylonian) for the first-mint share = isqrt(valueA·valueB). Called only with
    ///      u64·u64 ≤ 2^128, so x+1 and x/z+z never overflow.
    function _isqrt(uint256 x) internal pure returns (uint256 y) {
        unchecked {
            uint256 z = (x + 1) / 2;
            y = x;
            while (z < y) {
                y = z;
                z = (x / z + z) / 2;
            }
        }
    }

    /// @dev Ceil division for the in-ratio add: charging the CEIL reserve for the chosen shares keeps an add
    ///      from minting shares for slightly-less-than-pro-rata reserves, so the rounding favors existing LPs.
    function _ceilDiv(uint256 x, uint256 y) internal pure returns (uint256) {
        unchecked {
            return (x + y - 1) / y;
        }
    }

    function _checkDeadline(uint64 deadline) internal view {
        if (deadline != 0 && block.timestamp > deadline) revert Expired();
    }

    function _checkRecipient(address to) internal view {
        if (to == address(0) || to == address(POOL) || to == address(this)) revert ZeroAddress();
    }
}
