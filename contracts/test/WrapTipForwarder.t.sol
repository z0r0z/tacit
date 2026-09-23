// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WrapTipForwarder} from "../src/WrapTipForwarder.sol";

/// Mirrors ConfidentialPool.wrap's real contract: payable, reverts on any msg.value/amount mismatch,
/// records the last call for assertions. Not a full pool — just enough surface for this forwarder.
contract MockWrapPool {
    bytes32 public lastAssetId;
    uint256 public lastAmount;
    bytes32 public lastCommit;
    uint256 public callCount;
    bool public failNext;
    bool public registeredOverride = true;
    address public underlyingOverride = address(0);

    error EthValueMismatch();

    function setFailNext(bool v) external { failNext = v; }
    function setAssetConfig(bool registered, address underlying) external { registeredOverride = registered; underlyingOverride = underlying; }

    function assets(bytes32) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        return (registeredOverride, underlyingOverride, 1, bytes32(0), false, 18);
    }

    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable {
        if (failNext) revert("pool down");
        if (msg.value != amount) revert EthValueMismatch();
        lastAssetId = assetId;
        lastAmount = amount;
        lastCommit = commit;
        callCount++;
    }
}

contract WrapTipForwarderTest is Test {
    MockWrapPool pool;
    WrapTipForwarder fwd;
    bytes32 constant ASSET = keccak256("teth-asset");
    address depositor = address(0xD0);
    address relay = address(0xBEEF);

    event WrappedWithTip(bytes32 indexed depositCommit, uint256 amount, uint256 tip, address indexed tipRecipient);

    function setUp() public {
        pool = new MockWrapPool();
        fwd = new WrapTipForwarder(address(pool), ASSET);
        vm.deal(depositor, 10 ether);
    }

    // ── construction ──

    function test_constructorSetsImmutables() public view {
        assertEq(fwd.POOL(), address(pool));
        assertEq(fwd.ASSET_ID(), ASSET);
    }

    function test_constructorRejectsBadConfig() public {
        vm.expectRevert(WrapTipForwarder.BadConfig.selector);
        new WrapTipForwarder(address(0), ASSET);
        vm.expectRevert(WrapTipForwarder.BadConfig.selector);
        new WrapTipForwarder(address(pool), bytes32(0));
    }

    function test_constructorRejectsCodelessPool() public {
        address eoaLike = address(0xDEAD); // no code deployed at this address in a fresh test EVM
        vm.expectRevert(WrapTipForwarder.BadConfig.selector);
        new WrapTipForwarder(eoaLike, ASSET);
    }

    function test_constructorRejectsUnregisteredAsset() public {
        pool.setAssetConfig(false, address(0));
        vm.expectRevert(WrapTipForwarder.BadConfig.selector);
        new WrapTipForwarder(address(pool), ASSET);
    }

    function test_constructorRejectsNonEthUnderlying() public {
        // Registered, but backed by an ERC20 (e.g. USDC) rather than native ETH — wrap{value: amount} would
        // revert on every single call since the pool forbids msg.value for a non-ETH asset.
        pool.setAssetConfig(true, address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48));
        vm.expectRevert(WrapTipForwarder.BadConfig.selector);
        new WrapTipForwarder(address(pool), ASSET);
    }

    // ── happy path ──

    function test_wrapWithTipSplitsCorrectly() public {
        bytes32 commit = keccak256("commit-1");
        uint256 amount = 1 ether;
        uint256 tip = 0.01 ether;
        uint256 relayBefore = relay.balance;

        vm.prank(depositor);
        vm.expectEmit(true, true, true, true);
        emit WrappedWithTip(commit, amount, tip, relay);
        fwd.wrapWithTip{value: amount + tip}(commit, amount, relay);

        assertEq(pool.lastAssetId(), ASSET);
        assertEq(pool.lastAmount(), amount);
        assertEq(pool.lastCommit(), commit);
        assertEq(pool.callCount(), 1);
        assertEq(address(pool).balance, amount);
        assertEq(relay.balance, relayBefore + tip);
        assertEq(address(fwd).balance, 0); // nothing left stuck in the forwarder
    }

    function test_zeroTipIsValidLossLeader() public {
        bytes32 commit = keccak256("commit-2");
        uint256 amount = 0.5 ether;

        vm.prank(depositor);
        vm.expectEmit(true, true, true, true);
        emit WrappedWithTip(commit, amount, 0, relay);
        fwd.wrapWithTip{value: amount}(commit, amount, relay); // exact match, no tip

        assertEq(pool.lastAmount(), amount);
        assertEq(relay.balance, 0);
        assertEq(address(fwd).balance, 0);
    }

    function test_zeroTipAllowsZeroRecipient() public {
        // tipRecipient == address(0) is only rejected when there's actually a tip to send.
        bytes32 commit = keccak256("commit-3");
        uint256 amount = 0.3 ether;
        vm.prank(depositor);
        fwd.wrapWithTip{value: amount}(commit, amount, address(0));
        assertEq(pool.lastAmount(), amount);
    }

    // ── rejections ──

    function test_revertsOnInsufficientValue() public {
        vm.prank(depositor);
        vm.expectRevert(WrapTipForwarder.InsufficientValue.selector);
        fwd.wrapWithTip{value: 0.5 ether}(keccak256("c"), 1 ether, relay);
    }

    function test_revertsOnNonzeroTipToZeroRecipient() public {
        vm.prank(depositor);
        vm.expectRevert(WrapTipForwarder.BadRecipient.selector);
        fwd.wrapWithTip{value: 1.01 ether}(keccak256("c"), 1 ether, address(0));
    }

    function test_poolRevertRollsBackEverythingIncludingTip() public {
        pool.setFailNext(true);
        uint256 relayBefore = relay.balance;
        vm.prank(depositor);
        vm.expectRevert("pool down");
        fwd.wrapWithTip{value: 1.01 ether}(keccak256("c"), 1 ether, relay);
        // Atomic: a failed wrap never pays a tip, and the forwarder is never left holding ETH.
        assertEq(relay.balance, relayBefore);
        assertEq(address(fwd).balance, 0);
    }

    // ── fuzz ──

    function testFuzz_wrapWithTipNeverStrandsEth(uint96 amountRaw, uint96 tipRaw) public {
        uint256 amount = bound(amountRaw, 1, 5 ether);
        uint256 tip = bound(tipRaw, 0, 5 ether);
        vm.deal(depositor, amount + tip);

        vm.prank(depositor);
        fwd.wrapWithTip{value: amount + tip}(keccak256(abi.encode(amount, tip)), amount, relay);

        assertEq(address(pool).balance, amount);
        assertEq(address(fwd).balance, 0);
    }
}
