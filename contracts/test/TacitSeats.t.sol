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
    uint256 constant SLOT = 10 minutes;
    address constant BOOT = address(0xB007);
    address constant A = address(0xA);
    address constant B = address(0xB);
    address constant C = address(0xC);

    function setUp() public {
        tac = new Token(18);
        seats = new TacitSeats(IERC20Seats(address(tac)), SEAT, SLOT, BOOT);
        vm.warp(1_000_000 * SLOT);
    }

    function join(address who) internal returns (uint256 seat) {
        tac.mint(who, SEAT);
        vm.startPrank(who);
        tac.approve(address(seats), SEAT);
        seat = seats.join();
        vm.stopPrank();
    }

    function test_theBootstrapLeadsWhileNoSeatIsHeld() public {
        assertEq(seats.leader(), BOOT);
        uint256 s = join(A);
        assertEq(seats.leader(), A);
        vm.prank(A);
        seats.leave(s);
        assertEq(seats.leader(), BOOT);
    }

    function test_aHolderOfTwoSeatsLeadsTwoTurnsInThree() public {
        join(A);
        join(B);
        join(A);
        assertEq(seats.seatsOf(A), 2);
        // turn 1,000,000 is seat 1,000,000 mod 3 = 1
        uint256 t = block.timestamp;
        assertEq(seats.leaderAt(t), B);
        assertEq(seats.leaderAt(t + SLOT), A);
        assertEq(seats.leaderAt(t + 2 * SLOT), A);
        assertEq(seats.leaderAt(t + 3 * SLOT), B);
    }

    function test_turnsCycleThroughTheSeats() public {
        join(A);
        join(B);
        join(C);
        // seat (t / SLOT) mod 3
        uint256 base = (block.timestamp / SLOT) * SLOT;
        address[3] memory order = [A, B, C];
        for (uint256 k; k < 6; ++k) {
            uint256 t = base + k * SLOT;
            assertEq(seats.leaderAt(t), order[((t / SLOT) % 3)]);
            assertEq(seats.leaderAt(t + SLOT - 1), order[((t / SLOT) % 3)], "a turn lasts SLOT");
        }
        assertEq(tac.balanceOf(address(seats)), 3 * SEAT);
    }

    function test_leavingMovesTheLastSeatIntoItsPlace() public {
        join(A);
        join(B);
        join(C);
        vm.expectEmit(address(seats));
        emit TacitSeats.Left(A, 0, C, block.timestamp + seats.EXIT_DELAY());
        vm.prank(A);
        seats.leave(0);
        assertEq(seats.seats(), 2);
        assertEq(seats.seatAt(0), C);
        assertEq(seats.seatAt(1), B);
        assertEq(seats.seatsOf(A), 0);
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
        new TacitSeats(IERC20Seats(address(tac)), SEAT, 1 minutes - 1, BOOT);
        vm.expectRevert(TacitSeats.BadTerms.selector);
        new TacitSeats(IERC20Seats(address(tac)), SEAT, 1 hours + 1, BOOT);
    }
}
