// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettleTipForwarder} from "../src/SettleTipForwarder.sol";

/// Stands in for ConfidentialPool.settle: records what it was called with, and can optionally pay
/// msg.sender (the forwarder) to simulate a self-settle proof that carries its own native-ETH FeePayment.
contract MockPool {
    bytes public lastPublicValues;
    bytes public lastProofBytes;
    uint256 public callCount;
    uint256 public payToCaller;
    bool public shouldRevert;

    function setPayToCaller(uint256 amount) external {
        payToCaller = amount;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata) external {
        if (shouldRevert) revert("mock: settle reverted");
        lastPublicValues = publicValues;
        lastProofBytes = proofBytes;
        callCount++;
        if (payToCaller != 0) {
            (bool ok,) = msg.sender.call{value: payToCaller}("");
            require(ok, "mock payout failed");
        }
    }

    receive() external payable {}
}

contract SettleTipForwarderTest is Test {
    MockPool pool;
    SettleTipForwarder fwd;
    address caller = address(0xCA11E4);
    address relay = address(0xBEEF);

    function setUp() public {
        pool = new MockPool();
        vm.deal(address(pool), 10 ether);
        fwd = new SettleTipForwarder(address(pool));
        vm.deal(caller, 10 ether);
    }

    function test_constructorRejectsZeroOrEoaPool() public {
        vm.expectRevert(SettleTipForwarder.BadConfig.selector);
        new SettleTipForwarder(address(0));

        vm.expectRevert(SettleTipForwarder.BadConfig.selector);
        new SettleTipForwarder(address(0xD00D)); // no code
    }

    function test_settlesAndForwardsTip() public {
        uint256 tip = 0.01 ether;
        uint256 relayBefore = relay.balance;
        uint256 callerBefore = caller.balance;

        vm.prank(caller);
        fwd.settleWithTip{value: tip}("pv-bytes", "proof-bytes", new bytes[](0), relay);

        assertEq(pool.callCount(), 1, "settle wasn't called");
        assertEq(pool.lastPublicValues(), bytes("pv-bytes"), "publicValues not passed through unchanged");
        assertEq(pool.lastProofBytes(), bytes("proof-bytes"), "proofBytes not passed through unchanged");
        assertEq(relay.balance, relayBefore + tip, "relay didn't receive exactly the tip");
        assertEq(caller.balance, callerBefore - tip, "caller paid more than the tip");
        assertEq(address(fwd).balance, 0, "forwarder should custody nothing between calls");
    }

    function test_zeroTipIsValidLossLeader() public {
        vm.prank(caller);
        fwd.settleWithTip("pv-bytes", "proof-bytes", new bytes[](0), relay);
        assertEq(pool.callCount(), 1);
        assertEq(address(fwd).balance, 0);
    }

    function test_zeroTipDoesNotRequireRecipient() public {
        vm.prank(caller);
        fwd.settleWithTip("pv-bytes", "proof-bytes", new bytes[](0), address(0));
        assertEq(pool.callCount(), 1);
    }

    function test_nonzeroTipRejectsZeroRecipient() public {
        vm.prank(caller);
        vm.expectRevert(SettleTipForwarder.BadRecipient.selector);
        fwd.settleWithTip{value: 0.01 ether}("pv-bytes", "proof-bytes", new bytes[](0), address(0));
    }

    /// A self-settle proof that (unusually) carries its own native-ETH FeePayment pays out to whoever
    /// calls settle — which under this forwarder is the forwarder itself, not the user. That payout must
    /// come back to the ORIGINAL caller, never get mixed into the relay's tip and never get stranded.
    function test_unexpectedFeePayoutIsRefundedToCallerNotMixedIntoTip() public {
        uint256 feePayout = 0.05 ether;
        pool.setPayToCaller(feePayout);

        uint256 tip = 0.01 ether;
        uint256 relayBefore = relay.balance;
        uint256 callerBefore = caller.balance;

        vm.prank(caller);
        fwd.settleWithTip{value: tip}("pv-bytes", "proof-bytes", new bytes[](0), relay);

        assertEq(relay.balance, relayBefore + tip, "relay should get exactly the tip, not the fee payout");
        assertEq(caller.balance, callerBefore - tip + feePayout, "caller should be refunded the unexpected fee payout");
        assertEq(address(fwd).balance, 0, "forwarder should custody nothing between calls");
    }

    function test_revertsIfPoolReverts() public {
        pool.setShouldRevert(true);
        vm.prank(caller);
        vm.expectRevert("mock: settle reverted");
        fwd.settleWithTip{value: 0.01 ether}("pv-bytes", "proof-bytes", new bytes[](0), relay);
    }
}
