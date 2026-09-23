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

/// @title WrapTipForwarder — pays the relay for an ETH wrap without ever proving in advance
/// @notice ConfidentialRouter's atomic wrap+settle+tip path (`wrapAndSettleETH`) requires a proof to exist
///         BEFORE anything is escrowed, since the settle rides the same transaction as the wrap — a
///         would-be tipper can request that proof and simply never broadcast, and the relay has already
///         paid for a network prove with nothing to show for it. That is a real, unbounded griefing
///         vector, worse than today's alternative of just eating the settle cost.
///
///         This sidesteps it entirely by never bundling a settle. It only ever wraps — cheap, instant, no
///         proof required — and splits a tip off the SAME transaction, paid immediately and
///         unconditionally, before any proving has to happen at all. The relay settles the pending
///         deposit afterward exactly as it does for a bare `pool.wrap()` call today: asynchronously, only
///         once the deposit is already irreversibly on-chain. The only thing that changes is it's now
///         paid for doing so, and that payment never depended on the settle happening, so there is
///         nothing here for anyone to grief.
///
///         Permissionless and stateless: anyone can call this for any pool/asset/tip recipient it's
///         pointed at, and it custodies nothing between calls. `msg.value` becomes the wrapped note plus
///         (optionally) a tip, atomically, in one transaction, or the whole call reverts.
///
///         Deliberately scoped to native ETH: `amount` must arrive as `msg.value` for the pool to accept
///         it (`ConfidentialPool.wrap` reverts on any mismatch), which is exactly the property this
///         contract's tip-splitting relies on. An ERC20 wrap already has its own no-settle, tip-free entry
///         point (`ConfidentialRouter.wrapWithPermit(2)`) — extending the same tip pattern there would be
///         a separate contract, not this one, since it changes the trust model (a third party could
///         genuinely submit on the depositor's behalf via a signature, which native ETH can never allow).
contract WrapTipForwarder {
    address public immutable POOL;
    bytes32 public immutable ASSET_ID;

    error InsufficientValue();
    error BadRecipient();
    error BadConfig();

    event WrappedWithTip(bytes32 indexed depositCommit, uint256 amount, uint256 tip, address indexed tipRecipient);

    constructor(address pool, bytes32 assetId) {
        if (pool == address(0) || assetId == bytes32(0)) revert BadConfig();
        if (pool.code.length == 0) revert BadConfig();
        // Must be the pool's registered NATIVE-ETH asset specifically: wrap{value: amount} always sends
        // ETH, and the pool reverts any msg.value at all against a non-ETH-underlying asset. Catching a
        // wrong assetId here (deploy time) instead of leaving it to revert on every future call is the
        // difference between a five-minute mistake and a permanently bricked, immutable deployment.
        (bool registered, address underlying,,,, ) = IWrapPool(pool).assets(assetId);
        if (!registered || underlying != address(0)) revert BadConfig();
        POOL = pool;
        ASSET_ID = assetId;
    }

    /// Wraps `amount` of native ETH into the pool at `commit`, then forwards the remainder of `msg.value`
    /// (the tip) to `tipRecipient`, caller-named exactly like the router's own `_skimFee` (permissionless:
    /// the dapp names its relay, a third party names theirs, a self-relayer names themselves). `tip == 0`
    /// is a valid loss-leader. Reverts if `msg.value < amount`; a nonzero tip additionally requires a
    /// nonzero recipient (an accidental zero address would otherwise burn the tip).
    function wrapWithTip(bytes32 commit, uint256 amount, address tipRecipient) external payable {
        if (msg.value < amount) revert InsufficientValue();
        IWrapPool(POOL).wrap{value: amount}(ASSET_ID, amount, commit);
        uint256 tip = msg.value - amount;
        if (tip != 0) {
            if (tipRecipient == address(0)) revert BadRecipient();
            SafeTransferLib.safeTransferETH(tipRecipient, tip);
        }
        emit WrappedWithTip(commit, amount, tip, tipRecipient);
    }
}
