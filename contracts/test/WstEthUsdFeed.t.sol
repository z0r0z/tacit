// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WstEthUsdFeed} from "../src/WstEthUsdFeed.sol";

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

contract MockWstEth {
    uint256 public stEthPerToken;

    constructor(uint256 r) {
        stEthPerToken = r;
    }

    function set(uint256 r) external {
        stEthPerToken = r;
    }
}

contract WstEthUsdFeedTest is Test {
    function _feed(uint8 de, int256 ae, uint8 db, int256 ab, uint256 rate)
        internal
        returns (WstEthUsdFeed f, MockFeed e, MockFeed b, MockWstEth w)
    {
        e = new MockFeed(de, ae);
        b = new MockFeed(db, ab);
        w = new MockWstEth(rate);
        f = new WstEthUsdFeed(address(w), address(e), address(b));
    }

    function test_btc_per_wsteth_8dec() public {
        // ETH/USD=3300, BTC/USD=60000 => BTC/ETH=0.055; ethPerWsteth=1.20 => BTC/wstETH=0.066
        (WstEthUsdFeed f,,,) = _feed(8, 3300e8, 8, 60000e8, 1.2e18);
        assertEq(f.decimals(), 8);
        (, int256 px,,,) = f.latestRoundData();
        assertEq(px, 0.066e8, "0.055 BTC/ETH * 1.20 ETH/wstETH = 0.066 BTC/wstETH");
    }

    function test_mixed_decimals() public {
        (WstEthUsdFeed f,,,) = _feed(18, 3300e18, 8, 60000e8, 1.2e18);
        (, int256 px,,,) = f.latestRoundData();
        assertEq(px, 0.066e8, "decimals normalized to 8 regardless of source feed precision");
    }

    function test_returns_oldest_updatedAt() public {
        vm.warp(10_000);
        (WstEthUsdFeed f, MockFeed e, MockFeed b,) = _feed(8, 3300e8, 8, 60000e8, 1.2e18);
        e.set(3300e8, 9000, 1, 1);
        b.set(60000e8, 8000, 1, 1); // older
        (,,, uint256 u,) = f.latestRoundData();
        assertEq(u, 8000, "staleness gated by the older feed");
    }

    function test_returns_min_round_as_synthetic_answered_round() public {
        (WstEthUsdFeed f, MockFeed e, MockFeed b,) = _feed(8, 3300e8, 8, 60000e8, 1.2e18);
        e.set(3300e8, block.timestamp, 9, 9);
        b.set(60000e8, block.timestamp, 7, 7);
        (uint80 roundId,,,, uint80 answeredInRound) = f.latestRoundData();
        assertEq(roundId, 7, "synthetic round id is the older source round");
        assertEq(answeredInRound, roundId, "engine carried-over check passes on synthetic round");
    }

    function test_nonpositive_reverts() public {
        (WstEthUsdFeed f,, MockFeed b,) = _feed(8, 3300e8, 8, 60000e8, 1.2e18);
        b.set(0, block.timestamp, 1, 1);
        vm.expectRevert(WstEthUsdFeed.BadFeed.selector);
        f.latestRoundData();

        MockFeed e;
        (f, e,,) = _feed(8, 3300e8, 8, 60000e8, 1.2e18);
        e.set(-1, block.timestamp, 1, 1);
        vm.expectRevert(WstEthUsdFeed.BadFeed.selector);
        f.latestRoundData();
    }

    function test_carried_over_round_reverts() public {
        (WstEthUsdFeed f,, MockFeed b,) = _feed(8, 3300e8, 8, 60000e8, 1.2e18);
        b.set(60000e8, block.timestamp, 5, 4); // answeredInRound < roundId
        vm.expectRevert(WstEthUsdFeed.StaleRound.selector);
        f.latestRoundData();
    }

    function test_zero_rate_reverts_at_call_time() public {
        (WstEthUsdFeed f,,, MockWstEth w) = _feed(8, 3300e8, 8, 60000e8, 1.2e18);
        w.set(0);
        vm.expectRevert(WstEthUsdFeed.BadFeed.selector);
        f.latestRoundData();
    }

    function test_zero_ctor_args_revert() public {
        MockFeed e = new MockFeed(8, 3300e8);
        MockFeed b = new MockFeed(8, 60000e8);
        MockWstEth w = new MockWstEth(1.2e18);
        vm.expectRevert(WstEthUsdFeed.BadFeed.selector);
        new WstEthUsdFeed(address(0), address(e), address(b));
        vm.expectRevert(WstEthUsdFeed.BadFeed.selector);
        new WstEthUsdFeed(address(w), address(0), address(b));
        vm.expectRevert(WstEthUsdFeed.BadFeed.selector);
        new WstEthUsdFeed(address(w), address(e), address(0));
    }

    function test_zero_rate_at_ctor_reverts() public {
        MockFeed e = new MockFeed(8, 3300e8);
        MockFeed b = new MockFeed(8, 60000e8);
        MockWstEth w = new MockWstEth(0);
        vm.expectRevert(WstEthUsdFeed.BadFeed.selector);
        new WstEthUsdFeed(address(w), address(e), address(b));
    }

    function test_bad_decimals_ctor_reverts() public {
        MockFeed e0 = new MockFeed(0, 3300e8);
        MockFeed b8 = new MockFeed(8, 60000e8);
        MockWstEth w = new MockWstEth(1.2e18);
        vm.expectRevert(WstEthUsdFeed.BadFeed.selector);
        new WstEthUsdFeed(address(w), address(e0), address(b8));

        MockFeed e19 = new MockFeed(19, 3300e18);
        vm.expectRevert(WstEthUsdFeed.BadFeed.selector);
        new WstEthUsdFeed(address(w), address(e19), address(b8));
    }
}

/// @notice Real-mainnet-fork checks: confirm the chosen sources are genuinely open to a real contract call
///         (not just a bare `cast call`, which is how the gated stETH feeds were misread as usable earlier),
///         and that the composed price is plausible.
contract WstEthUsdFeedForkTest is Test {
    address constant ETH_USD = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;
    address constant BTC_USD = 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c;
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC", string("https://ethereum-rpc.publicnode.com"));
        vm.createSelectFork(rpc);
    }

    function test_real_feed_produces_plausible_price() public {
        WstEthUsdFeed f = new WstEthUsdFeed(WSTETH, ETH_USD, BTC_USD);
        (, int256 px,, uint256 updatedAt,) = f.latestRoundData();
        // wstETH trades at a premium to raw ETH; a sane BTC-per-wstETH band catches a decimals/scaling
        // mistake without hardcoding a brittle exact price.
        assertGt(px, 0.001e8, "BTC per wstETH implausibly low - check decimals/scaling");
        assertLt(px, 1e8, "BTC per wstETH implausibly high - check decimals/scaling");
        assertGt(updatedAt, block.timestamp - 7 days, "underlying round looks stale");
    }
}
