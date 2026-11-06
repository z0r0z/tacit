// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitHeaders, IPoolView, IRelayView} from "../src/TacitHeaders.sol";

contract MockPool is IPoolView {
    bytes32 public currentRoot;
    uint256 public nextLeafIndex;
    bytes32 public attestedReflectionDigest;
    function set(bytes32 r, uint256 n, bytes32 d) external { currentRoot = r; nextLeafIndex = n; attestedReflectionDigest = d; }
}

contract MockRelay is IRelayView {
    bytes32 public tip;
    uint256 public tipHeight;
    function set(bytes32 t, uint256 h) external { tip = t; tipHeight = h; }
}

contract TacitHeadersTest is Test {
    MockPool pool;
    MockRelay relay;
    TacitHeaders headers;

    function setUp() public {
        pool = new MockPool();
        relay = new MockRelay();
        headers = new TacitHeaders(pool, relay);
        pool.set(bytes32(uint256(1)), 10, bytes32(uint256(2)));
        relay.set(bytes32(uint256(3)), 974721);
        vm.roll(100);
    }

    function test_appendChainsHeaders() public {
        bytes32 h0 = headers.append();
        assertEq(headers.head(), h0);
        assertEq(headers.height(), 1);
        assertEq(headers.headerAt(0), h0);
        assertEq(h0, keccak256(abi.encode(bytes32(0), uint256(0), uint256(100), blockhash(99), bytes32(uint256(1)), uint256(10), bytes32(uint256(2)), uint256(974721), bytes32(uint256(3)))));
        vm.roll(101);
        relay.set(bytes32(uint256(4)), 974722);
        bytes32 h1 = headers.append();
        assertEq(h1, keccak256(abi.encode(h0, uint256(1), uint256(101), blockhash(100), bytes32(uint256(1)), uint256(10), bytes32(uint256(2)), uint256(974722), bytes32(uint256(4)))));
        assertEq(headers.headerAt(1), h1);
        assertEq(headers.height(), 2);
    }

    function test_nothingNewIsRefused() public {
        headers.append();
        vm.roll(101);
        vm.expectRevert(TacitHeaders.Unchanged.selector);
        headers.append();
        pool.set(bytes32(uint256(9)), 12, bytes32(uint256(2)));
        headers.append();
        assertEq(headers.height(), 2);
    }

    function test_oneHeaderABlock() public {
        headers.append();
        pool.set(bytes32(uint256(9)), 12, bytes32(uint256(2)));
        vm.expectRevert(TacitHeaders.SameBlock.selector);
        headers.append();
    }

    function test_anyoneAppendsAndIsNamed() public {
        address who = address(0xBEEF);
        vm.expectEmit(true, false, true, false);
        emit TacitHeaders.Header(0, bytes32(0), bytes32(0), bytes32(0), 0, bytes32(0), 0, bytes32(0), who);
        vm.prank(who);
        headers.append();
    }
}
