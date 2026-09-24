// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface ICbtcEscrowHelper {
    function postEscrowWithETHAndSettle(bytes32 outpoint, bytes calldata publicValues, bytes calldata proof, bytes[] calldata memos)
        external
        payable;
}

/// @title CbtcEscrowHelperTipForwarder — pays the relay for a self-proved cBTC-mint-and-settle in one transaction
/// @notice CbtcEscrowHelper.postEscrowWithETHAndSettle bundles posting the wstETH escrow stake and settling
///         the caller's own already-proven batch into one call, with the ENTIRE `msg.value` staked (no
///         partial-stake concept at that layer — the helper's own NatSpec: "no partial stake and so no ETH
///         dust to refund"). That leaves no room in a bare call to also carry a tip. This forwarder splits
///         `msg.value` the same way `WrapTipForwarder` splits a wrap's: an explicit `stakeAmount` is what
///         actually reaches the helper as its own `msg.value`, and whatever remains is the tip, paid to
///         `tipRecipient` immediately after.
///
///         Inherits the helper's own documented scope exactly, one layer removed — this forwarder does not
///         widen or narrow it. `postEscrowWithETHAndSettle` is self-prove-batches-only: a fee or public
///         withdrawal in the batch pays whoever calls the HELPER, never the depositor, and the helper only
///         auto-sweeps a NATIVE-ETH payout back to its own caller; anything else is stranded there, a
///         pre-existing constraint of that contract this forwarder does not change. When routed through
///         here, "the helper's caller" is this forwarder, so any native-ETH the helper refunds lands here
///         and is captured by the same balance-diff refund below that `SettleTipForwarder` already uses, on
///         top of (never mixed into) the tip. Same caller-side rule as that contract: don't route a batch
///         carrying a fee or public withdrawal through this forwarder.
///
///         Permissionless and stateless: anyone can call this for any outpoint or tip recipient. `tip == 0`
///         is a valid loss-leader.
contract CbtcEscrowHelperTipForwarder {
    address public immutable HELPER;

    error BadConfig();
    error InsufficientValue();
    error BadRecipient();

    event EscrowSettledWithTip(bytes32 indexed outpoint, uint256 stakeAmount, uint256 tip, address indexed tipRecipient);

    constructor(address helper) {
        if (helper == address(0) || helper.code.length == 0) revert BadConfig();
        HELPER = helper;
    }

    /// Lets the helper's own native-ETH safety-net refund (see contract NatSpec) land here to be forwarded
    /// on, rather than reverting the whole call.
    receive() external payable {}

    /// Posts `stakeAmount` of `msg.value` as escrow for `outpoint` and settles the batch via HELPER
    /// unchanged, then forwards the remainder of `msg.value` (the tip) to `tipRecipient`. `tip == 0` is a
    /// valid loss-leader. A nonzero tip requires a nonzero recipient. Any ETH the helper call itself pays
    /// back to this contract (see contract NatSpec) is refunded to the caller first, never mixed into the tip.
    function postEscrowWithETHAndSettleWithTip(
        bytes32 outpoint,
        uint256 stakeAmount,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos,
        address tipRecipient
    ) external payable {
        if (msg.value < stakeAmount) revert InsufficientValue();
        ICbtcEscrowHelper(HELPER).postEscrowWithETHAndSettle{value: stakeAmount}(outpoint, publicValues, proof, memos);
        uint256 tip = msg.value - stakeAmount;
        uint256 refund = address(this).balance - tip;
        if (refund != 0) SafeTransferLib.safeTransferETH(msg.sender, refund);
        if (tip != 0) {
            if (tipRecipient == address(0)) revert BadRecipient();
            SafeTransferLib.safeTransferETH(tipRecipient, tip);
        }
        emit EscrowSettledWithTip(outpoint, stakeAmount, tip, tipRecipient);
    }
}
