// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";
import {TacitPublicAmm} from "../src/TacitPublicAmm.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";

/// Pins the hardcoded calldata offsets in `ConfidentialRouter._requireCdpMintIntent` (field index 22 =
/// `cdpMints`, head width `27 * 32`) to the real `ConfidentialPool.PublicValues` ABI layout. The router
/// reads the `cdpMints` array slot by raw calldata math rather than `abi.decode`, so any reorder/insert in
/// the PublicValues struct would silently make it validate the wrong field — this test breaks loudly if
/// that layout drifts.
contract Dummy {}

contract RouterHarness is ConfidentialRouter {
    constructor(address pool_, address permit2_)
        ConfidentialRouter(pool_, address(new TacitPublicAmm(msg.sender)), address(0), permit2_)
    {}

    function exposed(bytes calldata pv) external pure {
        _requireCdpMintIntent(pv);
    }

    // Mirror the exact offset arithmetic the router uses in _relaySettle (fees, field 7) and exitAndExecute
    // (withdrawals, field 6) so a PublicValues reorder that shifts EITHER field breaks loudly here — not
    // silently in the router's fee-isolation / withdrawal-recipient binding on-chain.
    function feesLen(bytes calldata pv) external pure returns (uint256 n) {
        assembly ("memory-safe") {
            let ts := calldataload(pv.offset)
            let off := calldataload(add(add(pv.offset, ts), mul(7, 32))) // field 7 = fees
            n := calldataload(add(add(pv.offset, ts), off))
        }
    }

    function withdrawalsLen(bytes calldata pv) external pure returns (uint256 n) {
        assembly ("memory-safe") {
            let ts := calldataload(pv.offset)
            let off := calldataload(add(add(pv.offset, ts), 192)) // field 6 = withdrawals (6*32)
            n := calldataload(add(add(pv.offset, ts), off))
        }
    }
}

contract RouterCdpIntentOffsetTest is Test {
    RouterHarness harness;

    function setUp() public {
        // Constructor only needs pool_ / permit2_ to carry code; this harness never calls into them.
        address dummy = address(new Dummy());
        harness = new RouterHarness(dummy, dummy);
    }

    function _empty() internal pure returns (ConfidentialPool.PublicValues memory pv) {
        // All-zero / empty-array PublicValues; only the field under test is varied per case.
        return pv;
    }

    function test_nonEmptyCdpMints_passes() public view {
        ConfidentialPool.PublicValues memory pv = _empty();
        pv.cdpMints = new ConfidentialPool.CdpMint[](1); // length 1, contents irrelevant to the guard
        harness.exposed(abi.encode(pv));
    }

    function test_emptyCdpMints_reverts() public {
        ConfidentialPool.PublicValues memory pv = _empty();
        vm.expectRevert(ConfidentialRouter.BadProofIntent.selector);
        harness.exposed(abi.encode(pv));
    }

    /// Sharper pin: a NEIGHBORING CDP array (cdpCloses, field 23) being non-empty while cdpMints is empty
    /// must STILL revert — proving the guard reads slot 22 specifically, not an adjacent field.
    function test_neighborCdpCloses_doesNotSatisfyGuard() public {
        ConfidentialPool.PublicValues memory pv = _empty();
        pv.cdpCloses = new ConfidentialPool.CdpClose[](1);
        vm.expectRevert(ConfidentialRouter.BadProofIntent.selector);
        harness.exposed(abi.encode(pv));
    }

    /// Pin field 6 = withdrawals: the router's exitAndExecute binds every unwrap recipient at this offset,
    /// so a reorder that moved `withdrawals` would break the payout→escrow binding silently.
    function test_withdrawals_at_field6() public view {
        ConfidentialPool.PublicValues memory pv = _empty();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](2);
        assertEq(harness.withdrawalsLen(abi.encode(pv)), 2, "field 6 must be withdrawals");
        // A neighboring non-empty field (fees, 7) must NOT be read as withdrawals.
        ConfidentialPool.PublicValues memory pv2 = _empty();
        pv2.fees = new ConfidentialPool.FeePayment[](1);
        assertEq(harness.withdrawalsLen(abi.encode(pv2)), 0, "field 6 read must not pick up fees");
    }

    /// Pin field 7 = fees: _relaySettle requires this empty (fee-free settle); a reorder would silently
    /// isolate the wrong field and could let a non-empty fee slip a relayed settle through.
    function test_fees_at_field7() public view {
        ConfidentialPool.PublicValues memory pv = _empty();
        pv.fees = new ConfidentialPool.FeePayment[](3);
        assertEq(harness.feesLen(abi.encode(pv)), 3, "field 7 must be fees");
        ConfidentialPool.PublicValues memory pv2 = _empty();
        pv2.withdrawals = new ConfidentialPool.Withdrawal[](1);
        assertEq(harness.feesLen(abi.encode(pv2)), 0, "field 7 read must not pick up withdrawals");
    }
}
