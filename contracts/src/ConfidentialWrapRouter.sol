// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IConfidentialPool {
    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable;
    function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) external;
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

/// EIP-2612 permit (USDC and most modern ERC20s; DAI's non-standard permit is NOT this shape — those go
/// through Permit2 instead).
interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// Uniswap Permit2 (AllowanceTransfer) — the canonical singleton at
/// 0x000000000022D473030F116dDEE9F6B43aC78BA3 on every chain. After a ONE-TIME `token.approve(PERMIT2, max)`,
/// every later approval is a signature, for ANY ERC20 (permit-native or not).
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

interface IERC20Allowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title ConfidentialWrapRouter
/// @notice Periphery for ConfidentialPool: collapse "approve + wrap" (and optionally the settle that inserts
///         the note + emits its encrypted memo) into ONE transaction using a signature-based approval
///         (EIP-2612 or Permit2). Two UX flows:
///           1. wrapWithPermit / wrapWithPermit2 — one-tx public→confidential ON-RAMP (records a pending
///              deposit for `commit`); a later settle inserts the leaf + memo.
///           2. wrapAndSettleWithPermit / wrapAndSettleWithPermit2 — one-tx PRIVATE PAYMENT: wrap to a
///              recipient-owned `commit`, then immediately settle a self-proved batch that consumes the
///              deposit, inserts the recipient's leaf, and emits the recipient's ECDH memo (the discovery
///              channel a receiver trial-decrypts on tacit.finance). Sender + amount are public (the source
///              token is public); only the RECIPIENT is hidden — `commit` binds the note's owner, not msg.sender.
///
///  Trust model: the router takes the user's tokens only TRANSIENTLY within the call — it pulls them via the
///  signed approval and hands them straight to `wrap`, holding no token balance across transactions. It keeps
///  a standing (lazy, infinite) allowance to the POOL only — harmless here, since the router never holds
///  tokens between calls for the pool to pull, and the pool is the immutable, pinned target. The note stays
///  the user's: `commit` is forwarded verbatim, the router never sees the note secrets, and a malicious/buggy
///  router can at worst make the (atomic) call revert — it cannot redirect or retain funds.
///
///  Why periphery, not the pool: ConfidentialPool is immutable + codesize-bound, and permit standards vary
///  (EIP-2612 / DAI-style / Permit2). Keeping this here lets it support every flavor and be replaced as
///  standards evolve, without bloating the value-custody core. The pool needs no change — `wrap` already
///  pulls from `msg.sender` and binds the note via `commit`, and `settle` is permissionless.
contract ConfidentialWrapRouter is ReentrancyGuardTransient {
    IConfidentialPool public immutable POOL;
    IPermit2 public immutable PERMIT2;

    error AmountTooLarge();

    constructor(address pool_, address permit2_) {
        POOL = IConfidentialPool(pool_);
        PERMIT2 = IPermit2(permit2_);
    }

    // ──────────────────── One-tx on-ramp (wrap only) ────────────────────

    /// @notice One-tx wrap of an EIP-2612 token (e.g. USDC): the user signs an allowance to THIS router and
    ///         the router pulls `amount` and wraps it to `commit`. `permit` is best-effort (try/catch) so a
    ///         front-runner replaying the same permit can't grief the wrap by pre-consuming the nonce — the
    ///         `safeTransferFrom` below still enforces the allowance.
    /// @param token  the underlying ERC20 (already registered in the pool via registerWrapped/Auto).
    /// @param amount underlying amount to escrow (must be a multiple of the asset's unitScale, per the pool).
    /// @param commit the note commitment keccak(Cx‖Cy‖owner) — identical to a direct `wrap`; binds the note
    ///        (and, for a payment, the recipient). The caller computes it; the router only forwards it.
    function wrapWithPermit(
        address token,
        uint256 amount,
        bytes32 commit,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _wrap2612(token, amount, commit, deadline, v, r, s);
    }

    /// @notice One-tx wrap via Permit2 (works for ANY ERC20 after a one-time `token.approve(PERMIT2, max)`).
    function wrapWithPermit2(
        address token,
        uint256 amount,
        bytes32 commit,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external nonReentrant {
        _wrapPermit2(token, amount, commit, permitSingle, signature);
    }

    // ──────────────────── One-tx private payment (wrap + self-proved settle) ────────────────────

    /// @notice One-tx private payment with an EIP-2612 token: wrap `amount` to a recipient-owned `commit`,
    ///         then settle a SELF-PROVED batch that consumes the deposit, inserts the recipient's note leaf,
    ///         and emits the recipient's encrypted memo (via the pool's LeavesInserted). The caller builds
    ///         `publicValues`/`proof`/`memos` off-chain (the proof binds the deposit's value to the leaf).
    /// @dev    The settle runs with msg.sender == this router, so it MUST be a self-proved batch with NO
    ///         settler fees (`pv.fees` empty) — any fee would be paid to the router and stranded. The private
    ///         payment flow is self-proved by construction (the sender proves their own deposit), so this is
    ///         the intended, fee-free use.
    function wrapAndSettleWithPermit(
        address token,
        uint256 amount,
        bytes32 commit,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external nonReentrant {
        _wrap2612(token, amount, commit, deadline, v, r, s);
        POOL.settle(publicValues, proof, memos);
    }

    /// @notice One-tx private payment via Permit2 (any ERC20). See `wrapAndSettleWithPermit` for the
    ///         self-proved / fee-free settle constraint.
    function wrapAndSettleWithPermit2(
        address token,
        uint256 amount,
        bytes32 commit,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external nonReentrant {
        _wrapPermit2(token, amount, commit, permitSingle, signature);
        POOL.settle(publicValues, proof, memos);
    }

    // ──────────────────── Native ETH (no permit — msg.value IS the approval) ────────────────────

    /// @notice One-tx on-ramp of native ETH into a confidential deposit: send `msg.value` and the router
    ///         wraps it to `commit` as the pinned native-ETH (tETH) asset. No permit/approval needed — ETH
    ///         is carried by the call. A later settle inserts the leaf + memo. (Reverts if this generation
    ///         didn't register native ETH, i.e. tETH isn't a pool asset.)
    function wrapETH(bytes32 commit) external payable nonReentrant {
        _wrapETH(msg.value, commit);
    }

    /// @notice One-tx native-ETH private payment — the ETH analog of `wrapAndSettleWithPermit`: wrap
    ///         `msg.value` to a recipient-owned `commit`, then settle the self-proved batch that consumes the
    ///         deposit, inserts the recipient's leaf, and emits the recipient's memo. Same self-proved /
    ///         fee-free settle constraint (the settle runs with msg.sender == this router).
    function wrapAndSettleETH(
        bytes32 commit,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external payable nonReentrant {
        _wrapETH(msg.value, commit);
        POOL.settle(publicValues, proof, memos);
    }

    // ──────────────────── Public AMM swap (gasless approve) ────────────────────

    /// @notice One-tx PUBLIC swap with a gasless approval (EIP-2612): pull `amountIn` of `tokenIn`, swap it
    ///         against the pool's public reserves, and send the output straight to `to`. The amount is public
    ///         (this is the transparent lane; for a hidden-amount swap use the confidential OP_SWAP). The pool
    ///         enforces slippage (`minAmountOut`, in the output's underlying) + `deadline`; `deadline` doubles
    ///         as the permit-signature expiry. Caller passes token ADDRESSES; the router derives the asset ids.
    function swapPublicWithPermit(
        address tokenIn,
        address tokenOut,
        uint32 feeBps,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 amountOut) {
        _pull2612(tokenIn, amountIn, deadline, v, r, s);
        amountOut =
            POOL.swapPublic(_evmAssetId(tokenIn), _evmAssetId(tokenOut), feeBps, amountIn, minAmountOut, deadline, to);
    }

    /// @notice One-tx PUBLIC swap via Permit2 (any ERC20 after a one-time `token.approve(PERMIT2, max)`).
    function swapPublicWithPermit2(
        address tokenIn,
        address tokenOut,
        uint32 feeBps,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external nonReentrant returns (uint256 amountOut) {
        _pullPermit2(tokenIn, amountIn, permitSingle, signature);
        amountOut =
            POOL.swapPublic(_evmAssetId(tokenIn), _evmAssetId(tokenOut), feeBps, amountIn, minAmountOut, deadline, to);
    }

    // ──────────────────── Internals ────────────────────

    /// Pull `amount` of an EIP-2612 token from the caller (its signed allowance) into the router, then lazily
    /// approve the pool. Shared by wrap + swap. `permit` is best-effort (try/catch) so a replayed permit can't
    /// grief the call — the `safeTransferFrom` still enforces the allowance.
    function _pull2612(address token, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) internal {
        try IERC2612(token).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount);
        _lazyApprove(token, amount);
    }

    /// Permit2 analog of `_pull2612` (any ERC20 after a one-time `token.approve(PERMIT2, max)`).
    function _pullPermit2(
        address token,
        uint256 amount,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) internal {
        if (amount > type(uint160).max) revert AmountTooLarge(); // Permit2 amounts are uint160
        try PERMIT2.permit(msg.sender, permitSingle, signature) {} catch {}
        PERMIT2.transferFrom(msg.sender, address(this), uint160(amount), token);
        _lazyApprove(token, amount);
    }

    function _wrap2612(
        address token,
        uint256 amount,
        bytes32 commit,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        _pull2612(token, amount, deadline, v, r, s);
        POOL.wrap(_evmAssetId(token), amount, commit);
    }

    function _wrapPermit2(
        address token,
        uint256 amount,
        bytes32 commit,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) internal {
        _pullPermit2(token, amount, permitSingle, signature);
        POOL.wrap(_evmAssetId(token), amount, commit);
    }

    /// Forward `amount` of native ETH to the pool's wrap (no approval — the pool checks msg.value == amount
    /// for the native-ETH asset). The router forwards exactly what it received, holding no ETH after. The
    /// native-ETH asset id is `_evmAssetId(address(0))` — the same id the pool registered tETH under.
    function _wrapETH(uint256 amount, bytes32 commit) internal {
        POOL.wrap{value: amount}(_evmAssetId(address(0)), amount, commit);
    }

    /// Lazily grant the pool an infinite allowance (once per token). Approving only when the standing
    /// allowance is short — vs a fresh approve every call — saves the ~20k SSTORE on every repeat wrap/swap,
    /// the standard router pattern. Safe: the router holds no token balance between calls (nothing for the
    /// pool to pull) and the pool is the immutable, pinned target. `safeApproveWithRetry` resets-then-sets for
    /// tokens (USDT-style) that require a 0 allowance before a new non-zero one; a token that decrements an
    /// infinite allowance just trips the `< amount` check again later and is re-approved.
    function _lazyApprove(address token, uint256 amount) internal {
        if (IERC20Allowance(token).allowance(address(this), address(POOL)) < amount) {
            SafeTransferLib.safeApproveWithRetry(token, address(POOL), type(uint256).max);
        }
    }

    /// The pool's internal asset id for an underlying ERC20 — MUST mirror ConfidentialPool._evmAssetId:
    /// sha256("tacit-evm-token-v1" ‖ chainid ‖ underlying). Every registerWrapped/_register keys the asset
    /// under exactly this id, so deriving it here lets the caller pass only the token address. A token whose
    /// derived id isn't the registered one simply makes the pool's `wrap` revert (fail-closed, no fund risk).
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
}
