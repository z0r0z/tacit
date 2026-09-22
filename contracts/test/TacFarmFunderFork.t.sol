// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {WrappedTac} from "../src/WrappedTac.sol";
import {TacFarmFunder} from "../src/TacFarmFunder.sol";
import {FarmController} from "../src/FarmController.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";

interface ITacMint { function mint(address to, uint256 amount) external; }

/// MAINNET FORK ONLY (skipped elsewhere): one-transaction farm funding from public TAC against the live pool.
///   forge test --match-contract TacFarmFunderFork --fork-url $RPC -vv
contract TacFarmFunderFork is Test {
    address constant POOL = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    address gov = address(0x60A);
    WrappedTac w;
    TacFarmFunder helper;
    FarmController farm;
    bytes32 wId;

    function setUp() public {
        if (block.chainid != 1) vm.skip(true);
        w = new WrappedTac(TAC);
        wId = ConfidentialPool(payable(POOL)).registerWrappedAuto(address(w), bytes32(0));
        helper = new TacFarmFunder(address(w), POOL, wId);
        farm = new FarmController(POOL, keccak256("stake"), wId, true, true, gov, 0);
    }

    function _tac(address who, uint256 a) internal { vm.prank(POOL); ITacMint(TAC).mint(who, a); }

    function test_fundInOneTransactionWithPermit() public {
        (address funder, uint256 pk) = makeAddrAndKey("funder");
        uint256 amount = 25_000 ether;
        _tac(funder, amount);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            funder, address(helper), amount, ERC20(TAC).nonces(funder), deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", ERC20(TAC).DOMAIN_SEPARATOR(), structHash)));
        vm.prank(funder);
        helper.fundWithPermit(address(farm), amount, deadline, v, r, s); // the ONLY funder transaction
        assertEq(w.balanceOf(POOL), amount); // the pool escrows it
        assertEq(ERC20(TAC).balanceOf(funder), 0);
        assertEq(w.balanceOf(address(helper)), 0);
        assertEq(ERC20(TAC).balanceOf(address(helper)), 0);
        assertEq(ERC20(TAC).allowance(address(helper), address(w)), 0); // no allowance left behind
        assertEq(w.allowance(address(helper), POOL), 0);
        vm.prank(gov);
        farm.notifyRewardAmount(amount / 1e10, 90 days);
        assertGt(farm.rate(), 0);
    }

    function test_plainFundAfterApproval() public {
        address funder = address(0xF00D);
        _tac(funder, 10 ether);
        vm.startPrank(funder);
        ERC20(TAC).approve(address(helper), type(uint256).max);
        helper.fund(address(farm), 10 ether);
        vm.stopPrank();
        assertEq(w.balanceOf(POOL), 10 ether);
    }

    function test_misalignedAndZeroAmountsRevert() public {
        address funder = address(0xF00D);
        _tac(funder, 10 ether);
        vm.startPrank(funder);
        ERC20(TAC).approve(address(helper), type(uint256).max);
        vm.expectRevert(TacFarmFunder.Misaligned.selector);
        helper.fund(address(farm), 10 ether + 1);
        vm.expectRevert(TacFarmFunder.Misaligned.selector);
        helper.fund(address(farm), 0);
        vm.stopPrank();
    }

    function test_cannotFundAFarmWithADifferentRewardAsset() public {
        address funder = address(0xF00D);
        _tac(funder, 10 ether);
        FarmController other = new FarmController(POOL, keccak256("s2"), keccak256("some-other-asset"), true, true, gov, 0);
        vm.startPrank(funder);
        ERC20(TAC).approve(address(helper), type(uint256).max);
        vm.expectRevert();
        helper.fund(address(other), 10 ether);
        vm.stopPrank();
        assertEq(ERC20(TAC).balanceOf(funder), 10 ether); // the whole transaction reverted; nothing moved
    }

    function test_aFrontRunPermitDoesNotBlockFunding() public {
        (address funder, uint256 pk) = makeAddrAndKey("funder2");
        _tac(funder, 5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            funder, address(helper), 5 ether, ERC20(TAC).nonces(funder), deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", ERC20(TAC).DOMAIN_SEPARATOR(), structHash)));
        ERC20(TAC).permit(funder, address(helper), 5 ether, deadline, v, r, s); // someone else submitted the permit first
        vm.prank(funder);
        helper.fundWithPermit(address(farm), 5 ether, deadline, v, r, s); // the replay reverts inside try/catch; funding still works
        assertEq(w.balanceOf(POOL), 5 ether);
    }
}
