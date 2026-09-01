// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChainlinkWstEthBtcAdapter} from "../src/ChainlinkWstEthBtcAdapter.sol";

contract MockFeed {
    uint8 public decimals;
    int256 answer;
    uint256 updatedAt;
    uint80 roundId;
    uint80 answeredInRound;

    constructor(uint8 d, int256 a) {
        decimals = d;
        answer = a;
        updatedAt = block.timestamp;
        roundId = 1;
        answeredInRound = 1;
    }

    function set(int256 a, uint256 u, uint80 r, uint80 ar) external {
        answer = a;
        updatedAt = u;
        roundId = r;
        answeredInRound = ar;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

contract ChainlinkWstEthBtcAdapterTest is Test {
    function _adapter(uint8 dw, int256 aw, uint8 db, int256 ab)
        internal
        returns (ChainlinkWstEthBtcAdapter a, MockFeed w, MockFeed b)
    {
        w = new MockFeed(dw, aw);
        b = new MockFeed(db, ab);
        a = new ChainlinkWstEthBtcAdapter(address(w), address(b));
    }

    function test_btc_per_wsteth_8dec() public {
        (ChainlinkWstEthBtcAdapter a,,) = _adapter(8, 3300e8, 8, 60000e8);
        assertEq(a.decimals(), 8);
        (, int256 px,,,) = a.latestRoundData();
        assertEq(px, 0.055e8, "3300/60000 = 0.055 BTC per wstETH");
    }

    function test_mixed_decimals() public {
        (ChainlinkWstEthBtcAdapter a,,) = _adapter(18, 3300e18, 8, 60000e8);
        (, int256 px,,,) = a.latestRoundData();
        assertEq(px, 0.055e8, "decimals normalized to 8");
    }

    function test_returns_oldest_updatedAt() public {
        vm.warp(10_000);
        (ChainlinkWstEthBtcAdapter a, MockFeed w, MockFeed b) = _adapter(8, 3300e8, 8, 60000e8);
        w.set(3300e8, 9000, 1, 1);
        b.set(60000e8, 8000, 1, 1); // older
        (,,, uint256 u,) = a.latestRoundData();
        assertEq(u, 8000, "staleness gated by the older feed");
    }

    function test_returns_min_round_as_synthetic_answered_round() public {
        (ChainlinkWstEthBtcAdapter a, MockFeed w, MockFeed b) = _adapter(8, 3300e8, 8, 60000e8);
        w.set(3300e8, block.timestamp, 9, 9);
        b.set(60000e8, block.timestamp, 7, 7);

        (uint80 roundId,,,, uint80 answeredInRound) = a.latestRoundData();

        assertEq(roundId, 7, "synthetic round id is the older source round");
        assertEq(answeredInRound, roundId, "engine carried-over check passes on synthetic round");
    }

    function test_nonpositive_reverts() public {
        (ChainlinkWstEthBtcAdapter a,, MockFeed b) = _adapter(8, 3300e8, 8, 60000e8);
        b.set(0, block.timestamp, 1, 1);
        vm.expectRevert(ChainlinkWstEthBtcAdapter.BadFeed.selector);
        a.latestRoundData();

        MockFeed w;
        (a, w,) = _adapter(8, 3300e8, 8, 60000e8);
        w.set(-1, block.timestamp, 1, 1);
        vm.expectRevert(ChainlinkWstEthBtcAdapter.BadFeed.selector);
        a.latestRoundData();
    }

    function test_carried_over_round_reverts() public {
        (ChainlinkWstEthBtcAdapter a,, MockFeed b) = _adapter(8, 3300e8, 8, 60000e8);
        b.set(60000e8, block.timestamp, 5, 4); // answeredInRound < roundId
        vm.expectRevert(ChainlinkWstEthBtcAdapter.StaleRound.selector);
        a.latestRoundData();
    }

    function test_zero_feed_ctor_reverts() public {
        MockFeed w = new MockFeed(8, 3300e8);
        vm.expectRevert(ChainlinkWstEthBtcAdapter.BadFeed.selector);
        new ChainlinkWstEthBtcAdapter(address(w), address(0));
    }

    function test_bad_decimals_ctor_reverts() public {
        MockFeed w0 = new MockFeed(0, 3300e8);
        MockFeed b8 = new MockFeed(8, 60000e8);
        vm.expectRevert(ChainlinkWstEthBtcAdapter.BadFeed.selector);
        new ChainlinkWstEthBtcAdapter(address(w0), address(b8));

        MockFeed w19 = new MockFeed(19, 3300e8);
        vm.expectRevert(ChainlinkWstEthBtcAdapter.BadFeed.selector);
        new ChainlinkWstEthBtcAdapter(address(w19), address(b8));
    }
}
