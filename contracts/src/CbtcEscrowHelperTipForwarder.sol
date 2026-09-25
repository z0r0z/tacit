// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface ICbtcEscrowHelper {
    function postEscrowWithETHAndSettleFor(
        bytes32 outpoint,
        address depositor,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external payable;
}

/// @title CbtcEscrowHelperTipForwarder — pays the relay for a self-proved cBTC-mint-and-settle in one transaction
/// @notice CbtcEscrowHelper.postEscrowWithETHAndSettleFor bundles posting the wstETH escrow stake and settling
///         the caller's own already-proven batch into one call, with the ENTIRE `msg.value` staked (no
///         partial-stake concept at that layer — the helper's own NatSpec: "no partial stake and so no ETH
///         dust to refund"). That leaves no room in a bare call to also carry a tip. This forwarder splits
///         `msg.value` the same way `WrapTipForwarder` splits a wrap's: an explicit `stakeAmount` is what
///         actually reaches the helper as its own `msg.value`, and whatever remains is the tip, paid to
///         `tipRecipient` immediately after.
///
///         Calls the helper's `...For` entry point with `depositor = msg.sender` (this forwarder's own
///         caller), not the plain `postEscrowWithETHAndSettle`: the helper credits whichever address it
///         sees as its caller, which from the helper's side is this forwarder, not the person who actually
///         funded the stake — the `For` variant exists so that credit can be redirected to the real
///         depositor instead.
///
///         Inherits the helper's own documented scope exactly, one layer removed — this forwarder does not
///         widen or narrow it. The helper's escrow-and-settle entry points are self-prove-batches-only: a
///         fee in the batch pays whoever calls the HELPER, never the depositor, and it is the DEPOSITOR'S
///         OWN carved-out refund, not relay revenue (see `SettleTipForwarder`'s NatSpec for the general
///         shape of this hazard). Unlike that contract, this one can still check for it before it happens:
///         `PublicValues` field 7 (`fees`) is read directly off calldata and the whole call reverts if it's
///         non-empty, fail-closed, the same technique `ConfidentialRouter._relaySettle` already uses for
///         its own router-relayed settles — no need to decode the rest of the struct, just that one field's
///         length. A public withdrawal (any recipient other than the escrow this batch targets) is NOT
///         similarly checked here, matching the helper's own scope; the helper's native-ETH auto-sweep and
///         this forwarder's balance-diff refund below both still apply to it.
///
///         Permissionless and stateless: anyone can call this for any outpoint or tip recipient. `tip == 0`
///         is a valid loss-leader.
contract CbtcEscrowHelperTipForwarder {
    address public immutable HELPER;

    error BadConfig();
    error InsufficientValue();
    error BadRecipient();
    error FeeBearingProof();

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
        if (_hasFees(publicValues)) revert FeeBearingProof();
        ICbtcEscrowHelper(HELPER).postEscrowWithETHAndSettleFor{value: stakeAmount}(outpoint, msg.sender, publicValues, proof, memos);
        uint256 tip = msg.value - stakeAmount;
        uint256 refund = address(this).balance - tip;
        if (refund != 0) SafeTransferLib.safeTransferETH(msg.sender, refund);
        if (tip != 0) {
            if (tipRecipient == address(0)) revert BadRecipient();
            SafeTransferLib.safeTransferETH(tipRecipient, tip);
        }
        emit EscrowSettledWithTip(outpoint, stakeAmount, tip, tipRecipient);
    }

    /// `PublicValues` is ABI-encoded as one tuple argument (`abi.encode(pv)`), so word 0 is the tuple offset
    /// and field 7 is `fees` — same layout `ConfidentialRouter._relaySettle` reads. True iff that array is
    /// non-empty. A malformed/short `publicValues` reads as non-empty (fail-closed: the real pool would
    /// reject it anyway, so refusing here first costs nothing).
    function _hasFees(bytes calldata publicValues) internal pure returns (bool) {
        if (publicValues.length < 32) return true;
        uint256 tupleStart;
        assembly ("memory-safe") {
            tupleStart := calldataload(publicValues.offset)
        }
        if (tupleStart > publicValues.length || publicValues.length - tupleStart < 8 * 32) return true;
        uint256 feesOffset;
        assembly ("memory-safe") {
            feesOffset := calldataload(add(add(publicValues.offset, tupleStart), mul(7, 32)))
        }
        if (feesOffset > publicValues.length || tupleStart + feesOffset > publicValues.length - 32) return true;
        uint256 feesLen;
        assembly ("memory-safe") {
            feesLen := calldataload(add(add(publicValues.offset, tupleStart), feesOffset))
        }
        return feesLen != 0;
    }
}
