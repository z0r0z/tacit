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

/// @title WrapTokenTipForwarder — WrapTipForwarder's sibling for a TOKEN-backed asset
/// @notice `ConfidentialPool.wrap` reverts EthValueMismatch on ANY nonzero msg.value against a token asset —
///         poolMinted (burn(msg.sender, amount)) or escrow-backed (transferFrom(msg.sender, pool, amount))
///         alike — so unlike the native-ETH forwarder there is no wrap value to skim a tip from. Splitting
///         the concerns instead: Permit2 pulls the wrap amount in TOKEN, wrap() runs with value:0, and
///         msg.value — plain ETH, untouched by the wrap call — is the tip.
///
///         One contract for both poolMinted and escrow-backed assets, not two: ConfidentialRouter's own
///         `_wrapPermit2` already approves the pool unconditionally for both cases (see its `_lazyApprove`
///         call) and lets `wrap()`'s own internal branch decide whether that allowance is actually consulted
///         (escrow-backed) or simply unused (poolMinted burns directly from whoever called wrap — this
///         forwarder, once it holds the pulled tokens). Mirroring that exactly here means no extra branch,
///         and no extra deploy-time flag to get wrong.
///
///         `owner` passed to Permit2 is always this call's own `msg.sender` — never a parameter, exactly
///         like ConfidentialRouter's `_pullPermit2`. A free `owner` parameter would let anyone submit a
///         signature some OTHER account made and collect that deposit's points for themselves (points key
///         off tx.from, per points-indexer.js) — hardcoding it is what keeps "whoever's tokens funded the
///         wrap" and "whoever earns points for it" the same address, the guarantee the native-ETH sibling
///         gets for free from requiring the caller's own msg.value.
///
///         Permissionless and stateless otherwise, same as the ETH sibling: anyone can call this for any
///         pool/asset/tip recipient it's pointed at, and it holds a pulled token only transiently within one
///         call — an infinite pool approval is its only standing state, safe because the pool is immutable
///         and trusted (identical reasoning to ConfidentialRouter's own lazy-approve).
contract WrapTokenTipForwarder {
    address public immutable POOL;
    bytes32 public immutable ASSET_ID;
    address public immutable TOKEN;

    IPermit2 public constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    error BadRecipient();
    error BadConfig();
    error BadPermit2();

    event WrappedWithTip(bytes32 indexed depositCommit, uint256 amount, uint256 tip, address indexed tipRecipient);

    constructor(address pool, bytes32 assetId) {
        if (pool == address(0) || assetId == bytes32(0)) revert BadConfig();
        if (pool.code.length == 0) revert BadConfig();
        // Native ETH (underlying == 0) is WrapTipForwarder's job, not this contract's — there is nothing
        // here for Permit2 to pull for it.
        (bool registered, address underlying,,,,) = IWrapPool(pool).assets(assetId);
        if (!registered || underlying == address(0)) revert BadConfig();
        POOL = pool;
        ASSET_ID = assetId;
        TOKEN = underlying;
    }

    /// Pulls `amount` of TOKEN from the caller via Permit2 (one signature; the only other prerequisite is
    /// the standard one-time `token.approve(PERMIT2, max)` every Permit2 integration already needs), wraps
    /// it into the pool at `commit` with value:0, then forwards `msg.value` — a plain, separate ETH payment
    /// the wrap itself never touches — to `tipRecipient` as the tip. `permitSingle.spender` must be this
    /// contract: that binding is what proves the signature was made for this call, not replayed from
    /// elsewhere (ConfidentialRouter enforces the identical check in `_pullPermit2`).
    function wrapWithTip(
        bytes32 commit,
        uint256 amount,
        address tipRecipient,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external payable {
        if (amount > type(uint160).max) revert BadPermit2(); // Permit2 amounts are uint160
        if (
            permitSingle.details.token != TOKEN || permitSingle.spender != address(this)
                || permitSingle.details.amount < amount || permitSingle.sigDeadline < block.timestamp
        ) revert BadPermit2();
        // Best-effort: a signature already applied (e.g. a front-run replay of the same permit, or a prior
        // call that left a sufficient allowance) makes this permit() revert on its now-stale nonce, but the
        // transferFrom below still succeeds against the allowance already in place. Never let that block the
        // pull — identical reasoning to ConfidentialRouter's own _pull2612/_pullPermit2.
        try PERMIT2.permit(msg.sender, permitSingle, signature) {} catch {}
        PERMIT2.transferFrom(msg.sender, address(this), uint160(amount), TOKEN);

        if (IERC20Allowance(TOKEN).allowance(address(this), POOL) < amount) {
            SafeTransferLib.safeApproveWithRetry(TOKEN, POOL, type(uint256).max);
        }
        IWrapPool(POOL).wrap(ASSET_ID, amount, commit);

        if (msg.value != 0) {
            if (tipRecipient == address(0)) revert BadRecipient();
            SafeTransferLib.safeTransferETH(tipRecipient, msg.value);
        }
        emit WrappedWithTip(commit, amount, msg.value, tipRecipient);
    }
}
