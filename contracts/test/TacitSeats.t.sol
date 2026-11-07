// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitSeats, IERC20Seats} from "../src/TacitSeats.sol";
import {Token} from "./TacitBlocks.t.sol";

/// A token that keeps a cut of every transfer, which a seat must refuse (it would lock less than SEAT).
contract Skimming is Token {
    constructor() Token(18) {}

    function transferFrom(address from, address to, uint256 v) external override returns (bool) {
        allowance[from][msg.sender] -= v;
        balanceOf[from] -= v;
        balanceOf[to] += v - 1;
        return true;
    }
}

contract TacitSeatsTest is Test {
    Token tac;
    TacitSeats seats;
    uint256 constant SEAT = 1000e18;
    uint256 constant SLOT = 50;
    address constant BOOT = address(0xB007);
    address constant A = address(0xA);
    address constant B = address(0xB);
    address constant C = address(0xC);
    uint256 epochBlocks;

    function setUp() public {
        tac = new Token(18);
        seats = new TacitSeats(IERC20Seats(address(tac)), SEAT, SLOT, BOOT);
        epochBlocks = SLOT * seats.EPOCH_SLOTS();
        toEpoch(1000, 10);
    }

    /// Epoch `e`, its seed kept at its block 1 from beacon randomness made from `e`; then block `offset` of it (at least 1).
    function toEpoch(uint256 e, uint256 offset) internal {
        vm.roll(e * epochBlocks + 1);
        vm.prevrandao(keccak256(abi.encode("seed", e)));
        seats.turn();
        if (offset > 1) vm.roll(e * epochBlocks + offset);
    }

    function join(address who) internal returns (uint256 i) {
        tac.mint(who, SEAT);
        vm.startPrank(who);
        tac.approve(address(seats), SEAT);
        i = seats.join();
        vm.stopPrank();
    }

    /// Who leads each slot of the current epoch, as the seats stand.
    function turnsNow() internal view returns (address[] memory t) {
        uint256 start = seats.epoch() * epochBlocks;
        t = new address[](seats.EPOCH_SLOTS());
        for (uint256 j; j < t.length; ++j) {
            t[j] = seats.leaderAt(start + j * SLOT);
        }
    }

    function test_theBootstrapLeadsUntilASeatIsInTheDraw() public {
        assertEq(seats.leader(), BOOT);
        join(A);
        assertEq(seats.leader(), BOOT, "a seat taken now is in the draw from the next epoch");
        assertEq(seats.seats(), 0);
        toEpoch(1001, 0);
        assertEq(seats.seats(), 1);
        assertEq(seats.leader(), A);
    }

    function test_noHolderCanChangeTheTurnsOfTheEpochUnderWay() public {
        // A holds 2 of 8 seats
        join(A);
        join(A);
        for (uint256 i; i < 6; ++i) {
            join(address(uint160(0x100 + i)));
        }
        toEpoch(1001, 0);
        seats.turn();
        address[] memory before = turnsNow();
        // halfway through the epoch A takes three more seats and leaves two, as the attack in the review did
        vm.roll(block.number + 8 * SLOT);
        join(A);
        join(A);
        join(A);
        vm.startPrank(A);
        seats.leave(0);
        seats.leave(1);
        vm.stopPrank();
        address[] memory after_ = turnsNow();
        for (uint256 j; j < before.length; ++j) {
            assertEq(after_[j], before[j], "a turn of the epoch under way moved");
        }
        assertEq(seats.seats(), 8, "the draw holds the seats the epoch began with");
        toEpoch(1002, 0);
        assertEq(seats.seats(), 9, "8, three taken, two left");
        assertEq(seats.seatsOf(A), 3);
    }

    function test_aSeatLeftLeadsToTheEndOfItsEpochThenTheLastTakesItsPlace() public {
        join(A);
        join(B);
        join(C);
        toEpoch(1001, 0);
        vm.expectEmit(address(seats));
        emit TacitSeats.Left(A, 0, C, 1002, block.timestamp + seats.EXIT_DELAY());
        vm.prank(A);
        seats.leave(0);
        assertEq(seats.seatAt(0, false), A, "still A's in this epoch's draw");
        assertEq(seats.seatAt(0, true), C);
        assertEq(seats.seatAt(1, true), B);
        assertEq(seats.seatsOf(A), 0);
        toEpoch(1002, 0);
        assertEq(seats.seats(), 2);
        assertEq(seats.seatAt(0, false), C);
    }

    function test_eachSeatLeadsItsShareOfTurns() public {
        join(A);
        join(A);
        join(B);
        join(C);
        uint256 a;
        uint256 total;
        for (uint256 e = 1001; e < 1101; ++e) {
            toEpoch(e, 0);
            address[] memory t = turnsNow();
            for (uint256 j; j < t.length; ++j) {
                if (t[j] == A) ++a;
                ++total;
            }
        }
        // 2 seats of 4 over 1,600 turns: about half
        assertGt(a * 100, total * 45);
        assertLt(a * 100, total * 55);
    }

    function test_anEpochsSeedIsKeptByTurnOrItHasNoLeader() public {
        join(A);
        join(B);
        // not from the epoch's first block (its randomness is known to the block before, which can still take seats)
        vm.roll(1001 * epochBlocks);
        vm.prevrandao(keccak256("block 0"));
        assertEq(seats.turn(), address(0));
        assertEq(seats.seedOf(1001), bytes32(0));
        vm.roll(1001 * epochBlocks + 2);
        vm.prevrandao(keccak256("block 2"));
        address lead = seats.turn();
        assertTrue(lead == A || lead == B);
        assertEq(seats.seedOf(1001), keccak256(abi.encode(keccak256("block 2"), uint256(1001))));
        vm.roll(block.number + 300);
        assertEq(seats.leader() == address(0), false, "a kept seed lasts the epoch");
        // an epoch nobody kept the seed of in its blocks 1 to SEED_BLOCKS has no leader, so anyone may land in it
        vm.roll(1002 * epochBlocks + seats.SEED_BLOCKS() + 1);
        assertEq(seats.turn(), address(0));
        assertEq(seats.leader(), address(0));
    }

    function test_onlyItsHolderLeavesASeat() public {
        join(A);
        vm.prank(B);
        vm.expectRevert(TacitSeats.NotYours.selector);
        seats.leave(0);
        vm.prank(A);
        vm.expectRevert(TacitSeats.NotYours.selector);
        seats.leave(1);
    }

    function test_onlyHoldersAnnounce() public {
        vm.prank(A);
        vm.expectRevert(TacitSeats.NotYours.selector);
        seats.announce("https://a.example");
        join(A);
        vm.expectEmit(address(seats));
        emit TacitSeats.Endpoint(A, "https://a.example");
        vm.prank(A);
        seats.announce("https://a.example");
    }

    function test_aSeatsTacComesBackAfterTheExitDelay() public {
        uint256 s = join(A);
        vm.prank(A);
        vm.expectRevert(TacitSeats.Nothing.selector);
        seats.claim();
        vm.prank(A);
        seats.leave(s);
        vm.warp(block.timestamp + seats.EXIT_DELAY() - 1);
        vm.prank(A);
        vm.expectRevert(TacitSeats.TooSoon.selector);
        seats.claim();
        vm.warp(block.timestamp + 1);
        vm.prank(A);
        seats.claim();
        assertEq(tac.balanceOf(A), SEAT);
        vm.prank(A);
        vm.expectRevert(TacitSeats.Nothing.selector);
        seats.claim();
    }

    function test_leavingAnotherSeatRestartsTheWait() public {
        join(A);
        join(A);
        vm.prank(A);
        seats.leave(1);
        vm.warp(block.timestamp + 3 days);
        vm.prank(A);
        seats.leave(0);
        vm.warp(block.timestamp + seats.EXIT_DELAY() - 1);
        vm.prank(A);
        vm.expectRevert(TacitSeats.TooSoon.selector);
        seats.claim();
        vm.warp(block.timestamp + 1);
        vm.prank(A);
        seats.claim();
        assertEq(tac.balanceOf(A), 2 * SEAT);
    }

    function test_aSeatLocksAllOfSeat() public {
        vm.prank(A);
        vm.expectRevert(TacitSeats.TransferFailed.selector);
        seats.join();
        Skimming skim = new Skimming();
        TacitSeats s2 = new TacitSeats(IERC20Seats(address(skim)), SEAT, SLOT, BOOT);
        skim.mint(A, SEAT);
        vm.startPrank(A);
        skim.approve(address(s2), SEAT);
        vm.expectRevert(TacitSeats.TransferFailed.selector);
        s2.join();
        vm.stopPrank();
    }

    function test_terms() public {
        vm.expectRevert(TacitSeats.BadTerms.selector);
        new TacitSeats(IERC20Seats(address(0x1234)), SEAT, SLOT, BOOT);
        vm.expectRevert(TacitSeats.BadTerms.selector);
        new TacitSeats(IERC20Seats(address(tac)), 0, SLOT, BOOT);
        vm.expectRevert(TacitSeats.BadTerms.selector);
        new TacitSeats(IERC20Seats(address(tac)), SEAT, 4, BOOT);
        vm.expectRevert(TacitSeats.BadTerms.selector);
        new TacitSeats(IERC20Seats(address(tac)), SEAT, 301, BOOT);
    }
}
