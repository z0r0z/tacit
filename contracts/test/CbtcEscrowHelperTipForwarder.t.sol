// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CbtcEscrowHelperTipForwarder} from "../src/CbtcEscrowHelperTipForwarder.sol";

/// Stands in for CbtcEscrowHelper.postEscrowWithETHAndSettle: stakes the ENTIRE value it receives (mirroring
/// the real helper's own "no partial stake" invariant), and can optionally pay msg.sender (the forwarder)
/// to simulate a batch whose settle carries a native-ETH payout the real helper would auto-sweep back.
contract MockCbtcEscrowHelper {
    bytes32 public lastOutpoint;
    uint256 public lastValue;
    uint256 public callCount;
    uint256 public payToCaller;
    bool public shouldRevert;

    function setPayToCaller(uint256 amount) external {
        payToCaller = amount;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function postEscrowWithETHAndSettle(bytes32 outpoint, bytes calldata, bytes calldata, bytes[] calldata) external payable {
        if (shouldRevert) revert("mock: escrow settle reverted");
        lastOutpoint = outpoint;
        lastValue = msg.value;
        callCount++;
        if (payToCaller != 0) {
            (bool ok,) = msg.sender.call{value: payToCaller}("");
            require(ok, "mock payout failed");
        }
    }

    receive() external payable {}
}

contract CbtcEscrowHelperTipForwarderTest is Test {
    MockCbtcEscrowHelper helper;
    CbtcEscrowHelperTipForwarder fwd;
    address caller = address(0xCA11E4);
    address relay = address(0xBEEF);
    bytes32 outpoint = keccak256("test-outpoint");

    function setUp() public {
        helper = new MockCbtcEscrowHelper();
        vm.deal(address(helper), 10 ether);
        fwd = new CbtcEscrowHelperTipForwarder(address(helper));
        vm.deal(caller, 10 ether);
    }

    function test_constructorRejectsZeroOrEoaHelper() public {
        vm.expectRevert(CbtcEscrowHelperTipForwarder.BadConfig.selector);
        new CbtcEscrowHelperTipForwarder(address(0));

        vm.expectRevert(CbtcEscrowHelperTipForwarder.BadConfig.selector);
        new CbtcEscrowHelperTipForwarder(address(0xD00D)); // no code
    }

    function test_postsExactStakeAndForwardsTip() public {
        uint256 stakeAmount = 1 ether;
        uint256 tip = 0.01 ether;
        uint256 relayBefore = relay.balance;
        uint256 callerBefore = caller.balance;

        vm.prank(caller);
        fwd.postEscrowWithETHAndSettleWithTip{value: stakeAmount + tip}(outpoint, stakeAmount, "pv", "proof", new bytes[](0), relay);

        assertEq(helper.callCount(), 1, "helper wasn't called");
        assertEq(helper.lastOutpoint(), outpoint, "wrong outpoint forwarded");
        assertEq(helper.lastValue(), stakeAmount, "helper should receive EXACTLY stakeAmount, not the tip too");
        assertEq(relay.balance, relayBefore + tip, "relay didn't receive exactly the tip");
        assertEq(caller.balance, callerBefore - stakeAmount - tip, "caller paid more than stake + tip");
        assertEq(address(fwd).balance, 0, "forwarder should custody nothing between calls");
    }

    function test_zeroTipIsValidLossLeader() public {
        uint256 stakeAmount = 1 ether;
        vm.prank(caller);
        fwd.postEscrowWithETHAndSettleWithTip{value: stakeAmount}(outpoint, stakeAmount, "pv", "proof", new bytes[](0), relay);
        assertEq(helper.lastValue(), stakeAmount);
        assertEq(address(fwd).balance, 0);
    }

    function test_zeroTipDoesNotRequireRecipient() public {
        uint256 stakeAmount = 1 ether;
        vm.prank(caller);
        fwd.postEscrowWithETHAndSettleWithTip{value: stakeAmount}(outpoint, stakeAmount, "pv", "proof", new bytes[](0), address(0));
        assertEq(helper.lastValue(), stakeAmount);
    }

    function test_nonzeroTipRejectsZeroRecipient() public {
        uint256 stakeAmount = 1 ether;
        uint256 tip = 0.01 ether;
        vm.prank(caller);
        vm.expectRevert(CbtcEscrowHelperTipForwarder.BadRecipient.selector);
        fwd.postEscrowWithETHAndSettleWithTip{value: stakeAmount + tip}(outpoint, stakeAmount, "pv", "proof", new bytes[](0), address(0));
    }

    function test_insufficientValueReverts() public {
        uint256 stakeAmount = 1 ether;
        vm.prank(caller);
        vm.expectRevert(CbtcEscrowHelperTipForwarder.InsufficientValue.selector);
        fwd.postEscrowWithETHAndSettleWithTip{value: 0.5 ether}(outpoint, stakeAmount, "pv", "proof", new bytes[](0), relay);
    }

    /// The helper's own documented safety net (a native-ETH payout from an unusual batch swept back to
    /// its caller) must land on the ORIGINAL caller here, never get mixed into the relay's tip.
    function test_unexpectedHelperPayoutIsRefundedToCallerNotMixedIntoTip() public {
        uint256 helperPayout = 0.05 ether;
        helper.setPayToCaller(helperPayout);

        uint256 stakeAmount = 1 ether;
        uint256 tip = 0.01 ether;
        uint256 relayBefore = relay.balance;
        uint256 callerBefore = caller.balance;

        vm.prank(caller);
        fwd.postEscrowWithETHAndSettleWithTip{value: stakeAmount + tip}(outpoint, stakeAmount, "pv", "proof", new bytes[](0), relay);

        assertEq(relay.balance, relayBefore + tip, "relay should get exactly the tip, not the helper payout");
        assertEq(
            caller.balance,
            callerBefore - stakeAmount - tip + helperPayout,
            "caller should be refunded the unexpected helper payout"
        );
        assertEq(address(fwd).balance, 0, "forwarder should custody nothing between calls");
    }

    function test_revertsIfHelperReverts() public {
        helper.setShouldRevert(true);
        uint256 stakeAmount = 1 ether;
        vm.prank(caller);
        vm.expectRevert("mock: escrow settle reverted");
        fwd.postEscrowWithETHAndSettleWithTip{value: stakeAmount}(outpoint, stakeAmount, "pv", "proof", new bytes[](0), relay);
    }
}
