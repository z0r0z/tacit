// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChainlinkEthBtcAdapter} from "../src/ChainlinkEthBtcAdapter.sol";

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

contract ChainlinkEthBtcAdapterTest is Test {
    function _adapter(uint8 de, int256 ae, uint8 db, int256 ab)
        internal
        returns (ChainlinkEthBtcAdapter a, MockFeed e, MockFeed b)
    {
        e = new MockFeed(de, ae);
        b = new MockFeed(db, ab);
        a = new ChainlinkEthBtcAdapter(address(e), address(b));
    }

    function test_btc_per_eth_8dec() public {
        (ChainlinkEthBtcAdapter a,,) = _adapter(8, 3000e8, 8, 60000e8);
        assertEq(a.decimals(), 8);
        (, int256 px,,,) = a.latestRoundData();
        assertEq(px, 0.05e8, "3000/60000 = 0.05 BTC per ETH");
    }

    function test_mixed_decimals() public {
        (ChainlinkEthBtcAdapter a,,) = _adapter(18, 3000e18, 8, 60000e8);
        (, int256 px,,,) = a.latestRoundData();
        assertEq(px, 0.05e8, "decimals normalized to 8");
    }

    function test_returns_oldest_updatedAt() public {
        vm.warp(10_000);
        (ChainlinkEthBtcAdapter a, MockFeed e, MockFeed b) = _adapter(8, 3000e8, 8, 60000e8);
        e.set(3000e8, 9000, 1, 1);
        b.set(60000e8, 8000, 1, 1); // older
        (,,, uint256 u,) = a.latestRoundData();
        assertEq(u, 8000, "staleness gated by the older feed");
    }

    function test_nonpositive_reverts() public {
        (ChainlinkEthBtcAdapter a,, MockFeed b) = _adapter(8, 3000e8, 8, 60000e8);
        b.set(0, block.timestamp, 1, 1);
        vm.expectRevert(ChainlinkEthBtcAdapter.BadFeed.selector);
        a.latestRoundData();
    }

    function test_carried_over_round_reverts() public {
        (ChainlinkEthBtcAdapter a,, MockFeed b) = _adapter(8, 3000e8, 8, 60000e8);
        b.set(60000e8, block.timestamp, 5, 4); // answeredInRound < roundId
        vm.expectRevert(ChainlinkEthBtcAdapter.StaleRound.selector);
        a.latestRoundData();
    }

    function test_zero_feed_ctor_reverts() public {
        MockFeed e = new MockFeed(8, 3000e8);
        vm.expectRevert(ChainlinkEthBtcAdapter.BadFeed.selector);
        new ChainlinkEthBtcAdapter(address(e), address(0));
    }
}
