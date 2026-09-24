// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface ISettlePool {
    function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) external;
}

/// @title SettleTipForwarder — pays the relay for a self-settled proof without ever proving in advance
/// @notice The relay's fee gate skips its check entirely for prove-only jobs (self-settle: the client
///         proves and submits its own settle), because a proof-bound fee under self-settle would pay out
///         to `msg.sender` at settle time — the SELF-SETTLING USER, not the relay that produced the proof
///         (`ConfidentialPool`'s `FeePayment` carries no recipient; `_settle` pays every fee leg to
///         whoever calls `settle`). There is no way to bind a relay-bound fee inside a self-settle proof.
///
///         This sidesteps that the same way `WrapTipForwarder` sidesteps the wrap-tip griefing problem:
///         it never asks for payment before proving. Under self-settle the user is already signing and
///         broadcasting their own settle transaction — this forwarder rides that same transaction, calls
///         `pool.settle` unchanged, then forwards `msg.value` (the tip) to the caller-named recipient
///         immediately after. Nothing is proved in advance and nothing is escrowed; the relay is paid if
///         and only if the user broadcasts, which is exactly the transaction they were always going to
///         send — no extra signature, no extra transaction.
///
///         Permissionless and stateless: anyone can call this against any pool it's pointed at, for any
///         tip recipient. Scoped to native-ETH tips only, matching the relay's own fee-pricing convention
///         (a relayed settle's fee leg is priced in cETH). If a self-settle proof happens to carry its own
///         native-ETH `FeePayment` — unusual, since self-settle is chosen specifically to avoid a fee — it
///         lands on this contract as `settle`'s caller and is refunded back below, never mixed into the
///         tip. A `FeePayment` in any OTHER asset would still land here uncollected and unswept — and that
///         fee is the SETTLING USER'S OWN MONEY, not relay revenue foregone: self-settle's `fee` field, when
///         nonzero, is carved out of the user's own note/debt specifically so whoever calls `settle` gets
///         paid it back (e.g. a stored fee from an abandoned relay attempt, reused when the user later
///         settles it themselves). Routing that proof through this contract doesn't just skip a tip, it
///         permanently burns the user's own refund for any asset other than native ETH. Same scope boundary
///         `WrapTipForwarder` draws around ERC20 wraps; the fix is the same: don't route a fee-bearing proof
///         through this contract — check for a zero fee before choosing this over calling `settle` directly.
///
///         General lesson for the next contract put in this position: `msg.sender` stops meaning "the
///         user" the moment anything sits between the wallet and the pool. Any payout keyed to it —
///         `FeePayment` here, and whatever the next integration layers on `settle` — lands on the
///         intermediary instead, and an intermediary that can't accept or forward that asset reverts the
///         whole call rather than misdirecting it. `receive()` below exists for exactly that reason.
contract SettleTipForwarder {
    address public immutable POOL;

    error BadConfig();
    error BadRecipient();

    event SettledWithTip(address indexed caller, uint256 tip, address indexed tipRecipient);

    constructor(address pool) {
        if (pool == address(0) || pool.code.length == 0) revert BadConfig();
        POOL = pool;
    }

    /// Lets `settle` pay this contract back (the native-ETH FeePayment edge case above) — without this,
    /// that payout would revert the whole settle instead of landing here to be refunded below.
    receive() external payable {}

    /// Settles `publicValues`/`proofBytes` against POOL unchanged, then forwards `msg.value` (the tip) to
    /// `tipRecipient`. `tip == 0` is a valid loss-leader. A nonzero tip requires a nonzero recipient (an
    /// accidental zero address would otherwise burn it). Any ETH the settle call itself pays to this
    /// contract (see contract NatSpec) is refunded to the caller first, never mixed into the tip.
    function settleWithTip(
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes[] calldata memos,
        address tipRecipient
    ) external payable {
        uint256 tip = msg.value;
        ISettlePool(POOL).settle(publicValues, proofBytes, memos);
        uint256 refund = address(this).balance - tip;
        if (refund != 0) SafeTransferLib.safeTransferETH(msg.sender, refund);
        if (tip != 0) {
            if (tipRecipient == address(0)) revert BadRecipient();
            SafeTransferLib.safeTransferETH(tipRecipient, tip);
        }
        emit SettledWithTip(msg.sender, tip, tipRecipient);
    }
}
