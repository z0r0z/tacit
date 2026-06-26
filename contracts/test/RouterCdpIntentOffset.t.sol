// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";

/// Pins the hardcoded calldata offsets in `ConfidentialRouter._requireCdpMintIntent` (field index 22 =
/// `cdpMints`, head width `27 * 32`) to the real `ConfidentialPool.PublicValues` ABI layout. The router
/// reads the `cdpMints` array slot by raw calldata math rather than `abi.decode`, so any reorder/insert in
/// the PublicValues struct would silently make it validate the wrong field — this test breaks loudly if
/// that layout drifts.
contract Dummy {}

contract RouterHarness is ConfidentialRouter {
    constructor(address pool_, address permit2_) ConfidentialRouter(pool_, address(0), permit2_) {}

    function exposed(bytes calldata pv) external pure {
        _requireCdpMintIntent(pv);
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
}
