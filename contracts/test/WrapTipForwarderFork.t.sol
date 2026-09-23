// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {WrapTipForwarder} from "../src/WrapTipForwarder.sol";

interface IRealPool {
    event Wrap(bytes32 indexed depositId, bytes32 indexed assetId, uint256 amount);
}

/// Runs against the REAL, live ConfidentialPool on a mainnet fork — not a mock. Requires an RPC URL:
///   FORK_URL=https://ethereum-rpc.publicnode.com forge test --match-path test/WrapTipForwarderFork.t.sol
/// Skips (not fails) when FORK_URL is unset, so the regular suite never depends on network access.
contract WrapTipForwarderForkTest is Test {
    address constant POOL = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    bytes32 constant TETH_ASSET_ID = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;

    function test_realPoolAcceptsForwardedWrapAndTipLands() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) { emit log("FORK_URL unset - skipping live-pool fork test"); return; }
        vm.createSelectFork(url);

        WrapTipForwarder fwd = new WrapTipForwarder(POOL, TETH_ASSET_ID);
        address depositor = address(0xD00D);
        address relay = address(0xBEEF);
        vm.deal(depositor, 1 ether);

        uint256 amount = 0.001 ether;
        uint256 tip = 0.0001 ether;
        bytes32 commit = keccak256("wraptipforwarder-fork-test-commit");
        // Forked mainnet state: the pool, the relay address, and even this freshly-CREATE'd forwarder's
        // own address may already hold real mainnet balance, so assert on the DELTA everywhere, never an
        // absolute value.
        uint256 poolBefore = POOL.balance;
        uint256 relayBefore = relay.balance;
        uint256 fwdBefore = address(fwd).balance;

        vm.recordLogs();
        vm.prank(depositor);
        fwd.wrapWithTip{value: amount + tip}(commit, amount, relay);

        // The REAL pool emitted its own Wrap event for this deposit — confirms the forwarder's call
        // actually registered a pending deposit on live pool state, not just "didn't revert".
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawWrap;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == POOL && logs[i].topics[0] == IRealPool.Wrap.selector) {
                assertEq(logs[i].topics[2], TETH_ASSET_ID, "wrong asset id in real Wrap event");
                sawWrap = true;
            }
        }
        assertTrue(sawWrap, "real pool never emitted Wrap");

        assertEq(POOL.balance, poolBefore + amount, "pool didn't receive exactly the escrowed amount");
        assertEq(relay.balance, relayBefore + tip, "relay didn't receive exactly the tip");
        assertEq(address(fwd).balance, fwdBefore, "forwarder's balance changed - it should pass everything through");
    }
}
