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
            blocks.force(posting(w, false, 0, 0));
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
        (uint256 s, uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        bytes32 back = keccak256("back");
        tac.mint(blocks.inbox(s, v, cx, cy, body, back), v * UNIT);
        blocks.sweep(s, v, cx, cy, body, back);
        bytes memory posted = shieldPosting();
        vm.prank(address(0xF00D));
        blocks.force(posted);
        vm.prank(address(0xF00D));
        vm.expectRevert(TacitBlocks.DepositQueued.selector);
        blocks.force(posted);
        vm.warp(block.timestamp + blocks.RECLAIM_AFTER());
        vm.expectRevert(TacitBlocks.DepositQueued.selector);
        blocks.giveBack(s, v, cx, cy, body, back);
    }

    /// A plain deposit ahead of a sweep under the same key cannot hold the inbox: its TAC goes straight back into the pool.
    function test_aSquattedInboxGoesBack() public {
        (uint256 s, uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        bytes32 back = keccak256("back");
        address squatter = address(0xBAD);
        tac.mint(squatter, v * UNIT);
        vm.startPrank(squatter);
        tac.approve(address(blocks), v * UNIT);
        blocks.deposit(s, v, cx, cy, body);
        vm.stopPrank();
        address box = blocks.inbox(s, v, cx, cy, body, back);
        tac.mint(box, v * UNIT);
        blocks.sweep(s, v, cx, cy, body, back);
        assertEq(pool.lastCommit(), back);
        assertEq(pool.lastAmount(), v * UNIT);
        assertEq(tac.balanceOf(box), 0);
        (address from,,) = blocks.pending(depKey(s, v, cx, cy, body));
        assertEq(from, squatter, "the squatter's deposit stays, for the spend to take in");
    }

    /// A squatted inbox funded by a permit: the deposit's TAC goes back into the pool for `back` and the sender still takes its fee.
    function test_aSquattedPermittedInboxGoesBack() public {
        (uint256 s, uint256 v, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        bytes32 back = keccak256("back");
        address squatter = address(0xBAD);
        tac.mint(squatter, v * UNIT);
        vm.startPrank(squatter);
        tac.approve(address(blocks), v * UNIT);
        blocks.deposit(s, v, cx, cy, body);
        vm.stopPrank();
        uint256 pk = 0xA11CE;
        address holder = vm.addr(pk);
        uint256 fee = 1e15;
        tac.mint(holder, v * UNIT + fee);
        address box = blocks.inbox(s, v, cx, cy, body, back);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                hex"1901", tac.DOMAIN_SEPARATOR(), keccak256(abi.encode(tac.PERMIT_TYPEHASH(), holder, box, v * UNIT + fee, tac.nonces(holder), deadline))
            )
        );
        (uint8 pv8, bytes32 r, bytes32 sig) = vm.sign(pk, digest);
        vm.prank(address(0xBEEF));
        blocks.sweepWithPermit(s, v, cx, cy, body, back, holder, fee, deadline, pv8, r, sig);
        assertEq(pool.lastCommit(), back);
        assertEq(pool.lastAmount(), v * UNIT);
        assertEq(tac.balanceOf(address(0xBEEF)), fee);
        assertEq(tac.balanceOf(address(blocks)), v * UNIT, "the squatter's deposit alone");
    }

    /// A hop the pool refuses stays, to be sent again; in a batch the rest go on.
    function test_aRefusedHopStays() public {
        toTheHop();
        land(3);
        uint256 v = amountOf("hop");
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
        // the fixture's chain balances: 500 in, 120 out (less its fee), 300 hopped (less its fee)
        toTheHop();
        land(3);
        (, uint256 a,,,) = dep();
        assertEq(blocks.inChain(), a - amountOf("exit") - amountOf("hop"));
        assertEq(blocks.pool(), blocks.inChain());
    }

    /// The pool the proof commits (word 18) must be the TAC the contract counts for the notes, whatever the proof says, and its top
    /// sixteen bytes zero; the shares beside it are the program's alone. The getters show what the last block left.
    function test_thePoolWordMustBeTheContractsCount() public {
        depositFixture();
        land(0);
        (, uint256 a,,,) = dep();
        assertEq(blocks.pool(), a);
        TacitBlocks.Lists memory none;
        bytes32[19] memory w = abi.decode(craft(none), (bytes32[19]));
        assertEq(uint256(w[18]) >> 64, a, "the helper's word is the contract's count");
        // a unit more or less than the TAC held for the notes
        w[18] = bytes32(uint256(w[18]) + (1 << 64));
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.Insolvent.selector);
        blocks.land(abi.encode(w), "", none);
        w[18] = bytes32(uint256(w[18]) - (2 << 64));
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.Insolvent.selector);
        blocks.land(abi.encode(w), "", none);
        // the count in the top bytes, which the two halves leave out
        w = abi.decode(craft(none), (bytes32[19]));
        w[18] = bytes32(uint256(w[18]) | (1 << 128));
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.Insolvent.selector);
        blocks.land(abi.encode(w), "", none);
        // the shares the proof says are kept as they are
        w = abi.decode(craft(none), (bytes32[19]));
        w[18] = bytes32((a << 64) | 12_345);
        vm.prank(SEQ);
        blocks.land(abi.encode(w), "", none);
        assertEq(blocks.pool(), a);
        assertEq(blocks.shares(), 12_345);
        assertEq(blocks.inChain(), a);
    }

    /// An exit credited to this contract, the token or an inbox would be lost on withdrawal: it is refused there.
    function test_withdrawRefusesDeadEnds() public {
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadAddress.selector, 0));
        blocks.withdraw(address(blocks));
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadAddress.selector, 0));
        blocks.withdraw(address(tac));
    }

    /// A spend that moves 200 of its note to a successor chain: the block publishes the move and the successor's total alone, the TAC
    /// goes to the successor as the block lands, and the hash of the moves is kept for the successor to make its notes from.
    function test_aMigrationPaysItsSuccessor() public {
        toTheBlobBlock();
        address successor = vm.parseJsonAddress(fx, ".migration.to");
        uint256 v = amountOf("migration");
        TacitBlocks.Lists memory l = lists(8);
        bytes32 note = vm.parseJsonBytes32(fx, ".migration.note");
        assertEq(
            l.migrations,
            abi.encodePacked(successor, sha256(abi.encodePacked("tacit-block-migrate-v1", successor, note, uint64(v)))),
            "the move: successor and an item binding note and the TAC it takes"
        );
        assertEq(l.migrationTotals, abi.encodePacked(bytes32(uint256(uint160(successor))), bytes32(v)));
        uint256 before = blocks.inChain();
        asBlobBlock(l);
        bytes memory p8 = pv(8);
        vm.prank(SEQ);
        blocks.land(p8, "", l);
        assertEq(tac.balanceOf(successor), v * UNIT, "the successor holds what moved to it");
        assertEq(blocks.inChain(), before - v, "the chain's notes are worth that much less");
        assertEq(blocks.pool(), blocks.inChain());
        assertEq(blocks.migrationsOf(9), words(8)[16], "the moves' hash, for the successor");
        assertEq(blocks.migrationsOf(8), bytes32(0));
        assertEq(blocks.migrated(9, successor), v, "the successor's total, for it to reconcile against");
    }

    /// The moves and totals must be the ones the proof committed, and no block can move more than the chain holds.
    function test_whatAMigrationCannotDo() public {
        TacitBlocks.Lists memory l;
        l.migrations = abi.encodePacked(address(0x5C), bytes32(uint256(7)));
        l.migrationTotals = abi.encodePacked(bytes32(uint256(uint160(address(0x5C)))), bytes32(uint256(1)));
        bytes memory p = craft(l);
        vm.prank(SEQ);
        vm.expectRevert(TacitBlocks.Insolvent.selector);
        blocks.land(p, "", l);
        l.migrations = abi.encodePacked(address(0x5C), bytes32(uint256(8)));
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadList.selector, 9));
        blocks.land(p, "", l);
        l.migrations = abi.encodePacked(address(0x5C), bytes32(uint256(7)));
        l.migrationTotals = abi.encodePacked(bytes32(uint256(uint160(address(0x5C)))), bytes32(uint256(2)));
        vm.prank(SEQ);
        vm.expectRevert(abi.encodeWithSelector(TacitBlocks.BadList.selector, 10));
        blocks.land(p, "", l);
    }

    /// A deposit whose amount no longer buys its shares at the rate the last block left can never be taken in (every later block prices
    /// at that rate or a higher one): it goes back at once, not after RECLAIM_AFTER.
    function test_aStaleDepositGoesBackAtOnce() public {
        (,, bytes32 cx, bytes32 cy, bytes32 body) = dep();
        // a deposit that pays twice what its shares cost at genesis lands: the pool then holds more than the shares, so a share is worth
        // more than a unit
        tac.mint(address(this), 1e30);
        tac.approve(address(blocks), type(uint256).max);
        blocks.deposit(1e9, 2e9, cx, cy, body);
        TacitBlocks.Lists memory l;
        l.deposits = abi.encodePacked(blocks.TAC_ASSET(), uint256(1e9), cx, cy, body, uint256(2e9));
        bytes memory p = craft(l);
        vm.prank(SEQ);
        blocks.land(p, "", l);
        assertEq(blocks.pool(), 2e9);
        assertEq(blocks.shares(), 1e9);
        // one priced at a unit a share no longer covers: back at once to its depositor
        blocks.deposit(5e8, 5e8, cx, cy, body);
        uint256 before = tac.balanceOf(address(this));
        blocks.reclaim(5e8, 5e8, cx, cy, body);
        assertEq(tac.balanceOf(address(this)) - before, 5e8 * UNIT);
        // one that still covers waits as before
        blocks.deposit(5e8, 2e9, cx, cy, body);
        vm.expectRevert(TacitBlocks.TooSoon.selector);
        blocks.reclaim(5e8, 2e9, cx, cy, body);
    }
}
