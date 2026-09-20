// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {WrappedTac} from "../src/WrappedTac.sol";

contract MockTac is ERC20 {
    function name() public pure override returns (string memory) { return "Tacit Token"; }
    function symbol() public pure override returns (string memory) { return "TAC"; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// A token that delivers 1 wei less than asked (a fee-on-transfer token) — the wrapper must refuse it.
contract FeeToken is ERC20 {
    function name() public pure override returns (string memory) { return "Fee"; }
    function symbol() public pure override returns (string memory) { return "FEE"; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function _afterTokenTransfer(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && amount > 0) _burn(to, 1);
    }
}

contract WrappedTacTest is Test {
    MockTac tac;
    WrappedTac w;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        tac = new MockTac();
        w = new WrappedTac(address(tac));
        tac.mint(alice, 1_000_000 ether);
        vm.prank(alice);
        tac.approve(address(w), type(uint256).max);
    }

    function test_metadata() public view {
        assertEq(w.name(), "Wrapped TAC");
        assertEq(w.symbol(), "wTAC");
        assertEq(w.decimals(), 18);
        assertEq(w.TAC(), address(tac));
    }

    function test_roundTripIsExactlyOneToOne() public {
        vm.prank(alice);
        w.deposit(250_000 ether, alice);
        assertEq(w.balanceOf(alice), 250_000 ether);
        assertEq(tac.balanceOf(address(w)), 250_000 ether);
        assertEq(w.totalSupply(), 250_000 ether);
        vm.prank(alice);
        w.withdraw(250_000 ether, bob);
        assertEq(tac.balanceOf(bob), 250_000 ether);
        assertEq(w.totalSupply(), 0);
        assertEq(tac.balanceOf(address(w)), 0);
    }

    function test_depositToAnotherAddress() public {
        vm.prank(alice);
        w.deposit(10 ether, bob);
        assertEq(w.balanceOf(bob), 10 ether);
        assertEq(w.balanceOf(alice), 0);
    }

    function test_zeroAmountAndZeroAddressRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(WrappedTac.ZeroAmount.selector);
        w.deposit(0, alice);
        vm.expectRevert(WrappedTac.ZeroAddress.selector);
        w.deposit(1 ether, address(0));
        w.deposit(1 ether, alice);
        vm.expectRevert(WrappedTac.ZeroAmount.selector);
        w.withdraw(0, alice);
        vm.expectRevert(WrappedTac.ZeroAddress.selector);
        w.withdraw(1 ether, address(0));
        vm.stopPrank();
    }

    function test_cannotWithdrawMoreThanOwned() public {
        vm.prank(alice);
        w.deposit(5 ether, alice);
        vm.prank(bob);
        vm.expectRevert(ERC20.InsufficientBalance.selector);
        w.withdraw(1 ether, bob);
        vm.prank(alice);
        vm.expectRevert(ERC20.InsufficientBalance.selector);
        w.withdraw(5 ether + 1, alice);
    }

    function test_directDonationCannotBeRedeemedOrBreakBacking() public {
        vm.prank(alice);
        w.deposit(100 ether, alice);
        tac.mint(address(w), 7 ether); // a stray transfer
        assertEq(tac.balanceOf(address(w)), 107 ether);
        assertEq(w.totalSupply(), 100 ether);
        vm.prank(alice);
        w.withdraw(100 ether, alice);
        assertEq(tac.balanceOf(address(w)), 7 ether); // the donation stays, nobody can take it
        assertEq(w.totalSupply(), 0);
    }

    function test_feeOnTransferTokenIsRefused() public {
        FeeToken fee = new FeeToken();
        WrappedTac fw = new WrappedTac(address(fee));
        fee.mint(alice, 100 ether);
        vm.startPrank(alice);
        fee.approve(address(fw), type(uint256).max);
        vm.expectRevert(WrappedTac.ShortDelivery.selector);
        fw.deposit(10 ether, alice);
        vm.stopPrank();
        assertEq(fw.totalSupply(), 0);
    }

    function test_permitWorks() public {
        (address owner, uint256 pk) = makeAddrAndKey("permitter");
        tac.mint(owner, 3 ether);
        vm.startPrank(owner);
        tac.approve(address(w), type(uint256).max);
        w.deposit(3 ether, owner);
        vm.stopPrank();
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), owner, bob, 2 ether, w.nonces(owner), deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", w.DOMAIN_SEPARATOR(), structHash)));
        w.permit(owner, bob, 2 ether, deadline, v, r, s);
        assertEq(w.allowance(owner, bob), 2 ether);
    }

    /// The backing never falls below the supply, whatever sequence of deposits and withdrawals runs.
    function testFuzz_backingCoversSupply(uint96 a, uint96 b, uint96 c) public {
        uint256 d1 = bound(a, 1, 500_000 ether);
        uint256 d2 = bound(b, 1, 400_000 ether);
        vm.startPrank(alice);
        w.deposit(d1, alice);
        w.deposit(d2, bob);
        assertGe(tac.balanceOf(address(w)), w.totalSupply());
        uint256 out = bound(c, 1, d1);
        w.withdraw(out, alice);
        assertGe(tac.balanceOf(address(w)), w.totalSupply());
        assertEq(tac.balanceOf(address(w)), d1 + d2 - out);
        vm.stopPrank();
    }
}
