// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IWrapPool {
    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable;
    function assets(bytes32 assetId)
        external
        view
        returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals);
}

interface IERC20Allowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

/// EIP-2612 permit (USDC and most modern ERC20s; DAI's non-standard permit is NOT this shape, and USDT has
/// no permit at all — both fall through this contract's waterfall to the allowance check / Permit2 instead).
interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// Uniswap Permit2 (AllowanceTransfer) — the same sub-interface ConfidentialRouter already builds its own
/// wrapWithPermit2/etc. on, so a signature built for one spender works unmodified against the other; only
/// `spender` in the signed PermitSingle changes. Canonical singleton at
/// 0x000000000022D473030F116dDEE9F6B43aC78BA3 on every chain.
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

/// @title WrapTokenTipForwarder — WrapTipForwarder's sibling for any ERC20-backed pool asset
/// @notice `ConfidentialPool.wrap` reverts EthValueMismatch on ANY nonzero msg.value against a token asset —
///         poolMinted (burn(msg.sender, amount)) or escrow-backed (transferFrom(msg.sender, pool, amount))
///         alike — so unlike the native-ETH forwarder there is no wrap value to skim a tip from. The tip is
///         plain ETH instead, sent as msg.value alongside the token pull and forwarded untouched — not a
///         same-token tip. Deliberately: the wrap tx is sent by the depositor's own wallet (no sponsored/
///         4337 path exists here), so anyone able to broadcast this call already holds ETH for gas, and an
///         ETH tip needs no price conversion to be useful (the relay's own costs — gas, PROVE — are ETH-
///         denominated). A same-token tip would only add a live pricing dependency for zero reachability
///         gained, and for a canonical asset like TAC would mean putting a price reference on-chain for a
///         number this project deliberately keeps out of public view. Revisit only if a sponsored-deposit
///         path (paymaster/bundler) ever means a caller can hold a token but no ETH at all.
///
///         Pulls the wrap amount via a waterfall, cheapest/most-compatible first:
///          1. If an EIP-2612 signature is supplied, try the token's own `permit()` — best-effort (try/catch),
///             identical reasoning to ConfidentialRouter's `_pull2612`: a stale or already-applied signature
///             must never block a wrap the resulting allowance already covers.
///          2. Check the caller's plain allowance to this contract. This one check is what makes a standing
///             manual `approve()` work with no signature at all, not a separate code path — and it's also
///             what makes step 1 useful, since a successful permit() just becomes an allowance the same check
///             picks up.
///          3. Otherwise, if a Permit2 signature is supplied, pull through Permit2 — the only path that works
///             for a token with no EIP-2612 support at all (e.g. USDT).
///
///         `owner`/`from` in every pull path is always this call's own `msg.sender`, never a parameter. A free
///         `owner` would let anyone submit a signature some OTHER account made and collect that deposit's
///         points for themselves (points-indexer.js credits tx.from) — hardcoding it keeps "whoever's tokens
///         funded the wrap" and "whoever earns points for it" the same address, the guarantee the native-ETH
///         sibling gets for free from requiring the caller's own msg.value.
///
///         One deployment for every ERC20-backed asset the pool has (present or future), not one per asset:
///         `assetId` is a call parameter, resolved live via `assets()` each call rather than pinned at
///         construction. The cost is one extra external view call per wrap — cheap next to verifying a
///         signature, and it means a newly-registered asset works here immediately with no redeploy.
contract WrapTokenTipForwarder {
    address public immutable POOL;
    IPermit2 public constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    error BadRecipient();
    error BadConfig();
    error BadAsset();
    error BadPermit2();
    error NoPullAuthorized();

    event WrappedWithTip(bytes32 indexed assetId, bytes32 indexed depositCommit, uint256 amount, uint256 tip, address indexed tipRecipient);

    /// v == 0 means "skip the permit() attempt, go straight to the allowance check" — a real secp256k1 `v` is
    /// always 27 or 28, so 0 is an unambiguous sentinel, not a value a genuine signature could produce.
    struct Permit2612 {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    constructor(address pool) {
        if (pool == address(0) || pool.code.length == 0) revert BadConfig();
        POOL = pool;
    }

    /// @param assetId  the pool's registered id for the ERC20 asset. Must not be native ETH — that's
    ///        WrapTipForwarder's job; this contract has nothing to pull for it.
    /// @param amount   underlying amount to wrap (must be a multiple of the asset's unitScale, per the pool).
    /// @param commit   the note commitment keccak(Cx‖Cy‖owner) — identical to a direct `wrap`; forwarded verbatim.
    /// @param tipRecipient required whenever msg.value != 0 (an accidental zero address would otherwise burn the tip).
    /// @param permit2612   EIP-2612 attempt; leave `v` as 0 to skip straight to the allowance check.
    /// @param permitSingle / permit2Signature  Permit2 fallback; leave `permit2Signature` empty to disable it.
    function wrapWithTip(
        bytes32 assetId,
        uint256 amount,
        bytes32 commit,
        address tipRecipient,
        Permit2612 calldata permit2612,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata permit2Signature
    ) external payable {
        (bool registered, address token,,,,) = IWrapPool(POOL).assets(assetId);
        if (!registered || token == address(0)) revert BadAsset(); // native ETH belongs to WrapTipForwarder

        _pull(token, amount, permit2612, permitSingle, permit2Signature);

        if (IERC20Allowance(token).allowance(address(this), POOL) < amount) {
            SafeTransferLib.safeApproveWithRetry(token, POOL, type(uint256).max);
        }
        IWrapPool(POOL).wrap(assetId, amount, commit);

        if (msg.value != 0) {
            if (tipRecipient == address(0)) revert BadRecipient();
            SafeTransferLib.safeTransferETH(tipRecipient, msg.value);
        }
        emit WrappedWithTip(assetId, commit, amount, msg.value, tipRecipient);
    }

    function _pull(
        address token,
        uint256 amount,
        Permit2612 calldata permit2612,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata permit2Signature
    ) internal {
        if (permit2612.v != 0) {
            try IERC2612(token).permit(msg.sender, address(this), amount, permit2612.deadline, permit2612.v, permit2612.r, permit2612.s)
            {} catch {}
        }
        if (IERC20Allowance(token).allowance(msg.sender, address(this)) >= amount) {
            SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount);
            return;
        }
        if (permit2Signature.length != 0) {
            if (amount > type(uint160).max) revert BadPermit2(); // Permit2 amounts are uint160
            if (
                permitSingle.details.token != token || permitSingle.spender != address(this)
                    || permitSingle.details.amount < amount || permitSingle.sigDeadline < block.timestamp
            ) revert BadPermit2();
            // Best-effort, same reasoning as the EIP-2612 attempt above: a stale/replayed Permit2 signature
            // fails on its own nonce, but transferFrom still succeeds if the allowance is already there.
            try PERMIT2.permit(msg.sender, permitSingle, permit2Signature) {} catch {}
            PERMIT2.transferFrom(msg.sender, address(this), uint160(amount), token);
            return;
        }
        revert NoPullAuthorized();
    }
}
