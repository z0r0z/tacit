// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {TacitBlocks} from "../src/TacitBlocks.sol";
import {TacitBlocksFixture} from "./TacitBlocks.t.sol";

/// What the landing contract does about the ways leaders, squatters and the confidential pool could hold value back, and its own
/// floor on what a block can take out.
contract TacitBlocksFixesTest is TacitBlocksFixture {
    /// Leaders that land only MAX_FORCED entries a block, each just inside WINDOW, cannot hold the queue back: once an entry has
    /// waited FORCE_DELAY + WINDOW, anyone may land a block that reaches it.
    function test_aBacklogOpensLandingToAnyone() public {
        for (uint256 i; i < 32; ++i) {
            bytes32[12] memory w = nothing();
            w[5] = bytes32(i + 1);
            blocks.force(posting(w, false, 0));
        }
        uint256 victim = blocks.queued() - 1;
        TacitBlocks.Lists memory none;
        vm.warp(block.timestamp + FORCE_DELAY + WINDOW - 1);
        assertFalse(blocks.backlogged());
        bytes memory p16 = craftQ(none, blocks.queueDone() + 16);
        vm.prank(SEQ);
        blocks.land(p16, "", none);
        // the leader just landed: within WINDOW, but the oldest waiting entry is FORCE_DELAY + WINDOW old
        vm.warp(block.timestamp + 1);
        assertTrue(blocks.backlogged());
        bytes memory pv1 = craftQ(none, victim + 1);
        vm.prank(address(0xF00D));
        blocks.land(pv1, "", none);
        assertEq(blocks.queueDone(), victim + 1);
        assertFalse(blocks.backlogged());
        // and with the queue reached, the leader's window holds again
        bytes memory p2 = craft(none);
        vm.prank(address(0xF00D));
        vm.expectRevert(TacitBlocks.NotYourTurn.selector);
        blocks.land(p2, "", none);
    }

    /// Anyone may queue the spend that takes a swept deposit in; its giveBack then waits for the chain to reach that entry.
    function test_aSweptDepositCanBeForced() public {
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        bytes32 back = keccak256("back");
        tac.mint(blocks.inbox(v, cx, cy, body, back), v * UNIT);
        blocks.sweep(v, cx, cy, body, back);
        bytes memory posted = shieldPosting();
        vm.prank(address(0xF00D));
        blocks.force(posted);
        vm.prank(address(0xF00D));
        vm.expectRevert(TacitBlocks.DepositQueued.selector);
        blocks.force(posted);
        vm.warp(block.timestamp + blocks.RECLAIM_AFTER());
        vm.expectRevert(TacitBlocks.DepositQueued.selector);
        blocks.giveBack(v, cx, cy, body, back);
    }

    /// A plain deposit ahead of a sweep under the same key cannot hold the inbox: its TAC goes straight back into the pool.
    function test_aSquattedInboxGoesBack() public {
        (uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        bytes32 back = keccak256("back");
        address squatter = address(0xBAD);
        tac.mint(squatter, v * UNIT);
        vm.startPrank(squatter);
        tac.approve(address(blocks), v * UNIT);
        blocks.deposit(v, cx, cy, body);
        vm.stopPrank();
        address box = blocks.inbox(v, cx, cy, body, back);
        tac.mint(box, v * UNIT);
        blocks.sweep(v, cx, cy, body, back);
        assertEq(pool.lastCommit(), back);
        assertEq(pool.lastAmount(), v * UNIT);
        assertEq(tac.balanceOf(box), 0);
        (address from,,) = blocks.pending(keccak256(abi.encode(blocks.TAC_ASSET(), v, cx, cy, body)));
        assertEq(from, squatter, "the squatter's deposit stays, for the spend to take in");
    }

    /// A hop the pool refuses stays, to be sent again; in a batch the rest go on.
    function test_aRefusedHopStays() public {
        toTheHop();
        land(3);
        uint256 v = vm.parseJsonUint(fx, ".hop.value");
        bytes32 commit = vm.parseJsonBytes32(fx, ".hop.commit");
        pool.setRefuse(true);
        vm.expectRevert(TacitBlocks.HopNotTaken.selector);
        blocks.sendHop(v, commit);
        uint256[] memory vs = new uint256[](1);
        bytes32[] memory cs = new bytes32[](1);
        vs[0] = v;
        cs[0] = commit;
        blocks.sendHops(vs, cs);
        assertEq(blocks.hops(keccak256(abi.encode(v, commit))), 1, "kept");
        pool.setRefuse(false);
        blocks.sendHop(v, commit);
        assertEq(blocks.hops(keccak256(abi.encode(v, commit))), 0);
        assertEq(pool.lastCommit(), commit);
    }

    /// Whatever a proof says, a block cannot take out more than the deposits blocks have taken in.
    function test_aBlockCannotTakeOutMoreThanCameIn() public {
        TacitBlocks.Lists memory l;
        l.exits = abi.encodePacked(blocks.TAC_ASSET(), uint256(1), uint256(uint160(address(0xA11CE))));
        bytes memory p1 = craft(l);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.Insolvent.selector);
        blocks.land(p1, "", l);
        l.exits = "";
        l.hops = abi.encodePacked(blocks.TAC_ASSET(), uint256(1), keccak256("c"));
        bytes memory p2 = craft(l);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.Insolvent.selector);
        blocks.land(p2, "", l);
        // the fixture's chain balances: 500 in, 120 out, 300 hopped
        toTheHop();
        land(3);
        assertEq(blocks.inChain(), 80);
    }

    /// An exit credited to this contract, the token or an inbox would be lost on withdrawal: it is refused there.
    function test_withdrawRefusesDeadEnds() public {
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadAddress.selector, 0));
        blocks.withdraw(address(blocks));
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadAddress.selector, 0));
        blocks.withdraw(address(tac));
    }
}
