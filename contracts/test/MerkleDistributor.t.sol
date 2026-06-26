// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {MerkleDistributor} from "../src/MerkleDistributor.sol";

contract MockTAC is ERC20 {
    function name() public pure override returns (string memory) {
        return "Tacit";
    }

    function symbol() public pure override returns (string memory) {
        return "TAC";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MerkleDistributorTest is Test {
    MockTAC tac;
    MerkleDistributor dist;

    address constant OWNER = address(0xA11CE);
    address constant SWEEP_TO = address(0xBEEF);

    // 4 claimants (power-of-two tree → unambiguous proofs matching Solady sorted-pair hashing).
    address constant A0 = address(0x1001);
    address constant A1 = address(0x1002);
    address constant A2 = address(0x1003);
    address constant A3 = address(0x1004);
    uint256 constant V0 = 100e8;
    uint256 constant V1 = 250e8;
    uint256 constant V2 = 5e8;
    uint256 constant V3 = 1000e8;
    uint256 constant TOTAL = V0 + V1 + V2 + V3;

    uint64 deadline;
    bytes32 root;
    bytes32 l0;
    bytes32 l1;
    bytes32 l2;
    bytes32 l3;
    bytes32 n01;
    bytes32 n23;

    function _leaf(uint256 i, address a, uint256 v) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(i, a, v));
    }

    function _hp(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function setUp() public {
        tac = new MockTAC();
        l0 = _leaf(0, A0, V0);
        l1 = _leaf(1, A1, V1);
        l2 = _leaf(2, A2, V2);
        l3 = _leaf(3, A3, V3);
        n01 = _hp(l0, l1);
        n23 = _hp(l2, l3);
        root = _hp(n01, n23);

        deadline = uint64(block.timestamp + 30 days);
        dist = new MerkleDistributor(address(tac), root, deadline, OWNER, TOTAL);
        tac.mint(address(dist), TOTAL);
    }

    function _proof0() internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = l1;
        p[1] = n23;
    }

    function _proof3() internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = l2;
        p[1] = n01;
    }

    function test_claim_happyPath() public {
        assertFalse(dist.isClaimed(0));
        dist.claim(0, A0, V0, _proof0());
        assertTrue(dist.isClaimed(0));
        assertEq(tac.balanceOf(A0), V0);
        assertEq(tac.balanceOf(address(dist)), TOTAL - V0);
    }

    function test_claim_thirdPartySubmit_paysCommittedAccount() public {
        // A stranger submits A0's proof; tokens still land on A0.
        vm.prank(address(0xDEAD));
        dist.claim(0, A0, V0, _proof0());
        assertEq(tac.balanceOf(A0), V0);
        assertEq(tac.balanceOf(address(0xDEAD)), 0);
    }

    function test_claim_doubleClaim_reverts() public {
        dist.claim(0, A0, V0, _proof0());
        vm.expectRevert(MerkleDistributor.AlreadyClaimed.selector);
        dist.claim(0, A0, V0, _proof0());
    }

    function test_claim_wrongAmount_reverts() public {
        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        dist.claim(0, A0, V0 + 1, _proof0());
    }

    function test_claim_wrongAccount_reverts() public {
        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        dist.claim(0, A1, V0, _proof0());
    }

    function test_claim_wrongIndex_reverts() public {
        // Right account+amount but a proof for a different index → leaf mismatch.
        vm.expectRevert(MerkleDistributor.InvalidProof.selector);
        dist.claim(1, A0, V0, _proof0());
    }

    function test_fullDistribution_accounting() public {
        dist.claim(0, A0, V0, _proof0());
        bytes32[] memory p1 = new bytes32[](2);
        p1[0] = l0;
        p1[1] = n23;
        dist.claim(1, A1, V1, p1);
        bytes32[] memory p2 = new bytes32[](2);
        p2[0] = l3;
        p2[1] = n01;
        dist.claim(2, A2, V2, p2);
        dist.claim(3, A3, V3, _proof3());

        assertEq(tac.balanceOf(A0), V0);
        assertEq(tac.balanceOf(A1), V1);
        assertEq(tac.balanceOf(A2), V2);
        assertEq(tac.balanceOf(A3), V3);
        assertEq(tac.balanceOf(address(dist)), 0);
    }

    function test_sweep_beforeDeadline_reverts() public {
        vm.prank(OWNER);
        vm.expectRevert(MerkleDistributor.DeadlineNotReached.selector);
        dist.sweep(SWEEP_TO);
    }

    function test_sweep_notOwner_reverts() public {
        vm.warp(deadline);
        vm.expectRevert(Ownable.Unauthorized.selector);
        dist.sweep(SWEEP_TO);
    }

    function test_sweep_afterDeadline_returnsRemainder() public {
        // One claimant redeems; the rest is swept after the deadline.
        dist.claim(0, A0, V0, _proof0());
        vm.warp(deadline);
        vm.prank(OWNER);
        dist.sweep(SWEEP_TO);
        assertEq(tac.balanceOf(SWEEP_TO), TOTAL - V0);
        assertEq(tac.balanceOf(address(dist)), 0);
    }

    function test_claim_stillWorks_afterDeadlineBeforeSweep() public {
        vm.warp(deadline + 1);
        dist.claim(0, A0, V0, _proof0());
        assertEq(tac.balanceOf(A0), V0);
    }

    function test_constructor_guards() public {
        vm.expectRevert(MerkleDistributor.BadConfig.selector);
        new MerkleDistributor(address(0), root, deadline, OWNER, TOTAL);
        vm.expectRevert(MerkleDistributor.BadConfig.selector);
        new MerkleDistributor(address(tac), bytes32(0), deadline, OWNER, TOTAL);
        vm.expectRevert(MerkleDistributor.BadConfig.selector);
        new MerkleDistributor(address(tac), root, uint64(block.timestamp), OWNER, TOTAL);
        vm.expectRevert(MerkleDistributor.BadConfig.selector);
        new MerkleDistributor(address(tac), root, deadline, address(0), TOTAL);
        vm.expectRevert(MerkleDistributor.BadConfig.selector);
        new MerkleDistributor(address(tac), root, deadline, OWNER, 0);
    }

    function test_underfunded_claimReverts_thenOpensWhenTopped() public {
        // A distributor allocated TOTAL but funded short: no one can claim until it's topped up, so an
        // over-allocation fails loudly for every claimant instead of stranding the last.
        MerkleDistributor d = new MerkleDistributor(address(tac), root, deadline, OWNER, TOTAL);
        tac.mint(address(d), TOTAL - 1);
        vm.expectRevert(MerkleDistributor.NotFunded.selector);
        d.claim(0, A0, V0, _proof0());
        assertFalse(d.opened());

        tac.mint(address(d), 1); // top up to exactly TOTAL
        d.claim(0, A0, V0, _proof0());
        assertTrue(d.opened());
        assertEq(tac.balanceOf(A0), V0);
    }

    function test_opened_latchesAndStaysOpenAsBalanceFalls() public {
        // Once opened, later claims succeed even though the balance is now below EXPECTED_TOTAL.
        assertFalse(dist.opened());
        dist.claim(3, A3, V3, _proof3());
        assertTrue(dist.opened());
        assertLt(tac.balanceOf(address(dist)), dist.EXPECTED_TOTAL());
        dist.claim(0, A0, V0, _proof0()); // still works
        assertEq(tac.balanceOf(A0), V0);
    }
}
