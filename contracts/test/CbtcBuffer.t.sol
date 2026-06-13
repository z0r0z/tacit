// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CbtcBuffer, IChainlinkFeed, IAmmTwap} from "../src/CbtcBuffer.sol";

contract MockERC20 {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        _move(f, to, a);
        return true;
    }
    function _move(address f, address to, uint256 a) internal { balanceOf[f] -= a; balanceOf[to] += a; }
}

contract MockPool {
    uint256 public cbtcBackingSats;
    function setBacking(uint256 v) external { cbtcBackingSats = v; }
}

contract MockChainlink is IChainlinkFeed {
    int256 public answer;
    uint256 public updatedAt;
    uint8 internal dec;
    constructor(int256 a, uint8 d, uint256 u) { answer = a; dec = d; updatedAt = u; }
    function set(int256 a, uint256 u) external { answer = a; updatedAt = u; }
    function decimals() external view returns (uint8) { return dec; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (0, answer, 0, updatedAt, 0);
    }
}

contract MockAmmTwap is IAmmTwap {
    uint256 internal price;
    uint8 internal dec;
    constructor(uint256 p, uint8 d) { price = p; dec = d; }
    function set(uint256 p, uint8 d) external { price = p; dec = d; }
    function ethBtcTwap() external view returns (uint256, uint8) { return (price, dec); }
}

contract CbtcBufferTest is Test {
    CbtcBuffer buf;
    MockPool pool;
    MockERC20 cbtc; // 8 dec
    MockERC20 teth; // 18 dec
    MockChainlink feed; // ETH/BTC, 8 dec, 0.05 BTC/ETH
    MockAmmTwap twap;

    address constant ADMIN = address(0xA11CE);
    address constant DAO = address(0xDA0);
    address constant ANYONE = address(0xBEEF);
    address constant HOLDER = address(0xC0FFEE);
    uint256 constant T0 = 1_000_000;

    function setUp() public {
        vm.warp(T0);
        pool = new MockPool();
        cbtc = new MockERC20();
        teth = new MockERC20();
        feed = new MockChainlink(5e6, 8, T0); // 0.05 BTC per ETH
        twap = new MockAmmTwap(5e6, 8); // matching

        buf = new CbtcBuffer(address(pool), address(cbtc), address(teth), 8, 18, ADMIN);

        vm.startPrank(ADMIN);
        buf.setFeeds(address(feed), address(twap));
        buf.setParams(3600, 500); // 1h staleness, 5% deviation
        vm.stopPrank();

        teth.mint(address(buf), 1000e18); // buffer capital: 1000 tETH = 50 BTC @ 0.05
    }

    function test_owner_to_dao_and_onlyOwner() public {
        assertEq(buf.owner(), ADMIN);
        vm.expectRevert();
        vm.prank(ANYONE);
        buf.setParams(1, 1);
        vm.prank(ADMIN);
        buf.transferOwnership(DAO);
        assertEq(buf.owner(), DAO);
    }

    function test_pegShortfall() public {
        pool.setBacking(1e8); // 1 BTC
        cbtc.mint(HOLDER, 12e7); // 1.2 cBTC circulating
        assertEq(buf.pegShortfall(), 2e7, "0.2 cBTC short");
        pool.setBacking(13e7); // over-backed
        assertEq(buf.pegShortfall(), 0);
    }

    function test_price_valid_and_conversion() public view {
        (uint256 p, uint8 d) = buf.ethBtcPrice();
        assertEq(p, 5e6);
        assertEq(d, 8);
        // 1 tETH = 0.05 cBTC -> cbtcToTeth(5e6 = 0.05 cBTC) = 1e18; cbtcToTeth(2e7 = 0.2 cBTC) = 4e18
        assertEq(buf.cbtcToTeth(5e6), 1e18, "0.05 cBTC = 1 tETH");
        assertEq(buf.cbtcToTeth(2e7), 4e18, "0.2 cBTC = 4 tETH");
        // inverse: 1 tETH = 0.05 cBTC = 5e6 base units; 4 tETH = 2e7
        assertEq(buf.tethToCbtc(1e18), 5e6, "1 tETH = 0.05 cBTC");
        assertEq(buf.tethToCbtc(4e18), 2e7, "4 tETH = 0.2 cBTC");
    }

    function test_price_stale_reverts() public {
        feed.set(5e6, T0 - 7200); // 2h old > 1h staleness
        vm.expectRevert(CbtcBuffer.StaleFeed.selector);
        buf.ethBtcPrice();
    }

    function test_price_bad_reverts() public {
        feed.set(0, T0);
        vm.expectRevert(CbtcBuffer.BadFeed.selector);
        buf.ethBtcPrice();
    }

    function test_price_amm_deviation_bound() public {
        twap.set(52e5, 8); // 0.052 -> ~4% off, within 5%
        buf.ethBtcPrice(); // ok
        twap.set(55e5, 8); // 0.055 -> ~10% off, exceeds 5%
        vm.expectRevert(CbtcBuffer.FeedDeviation.selector);
        buf.ethBtcPrice();
    }

    function test_bufferBtcValue() public view {
        // 1000 tETH @ 0.05 BTC/ETH = 50 BTC = 50e8 sats
        assertEq(buf.bufferBtcValueSats(), 50e8, "buffer worth 50 BTC");
    }

    function test_uncoveredShortfall_buffer_absorbs() public {
        pool.setBacking(1e8); // 1 BTC
        cbtc.mint(HOLDER, 12e7); // 1.2 cBTC circulating -> 0.2 cBTC real shortfall
        assertEq(buf.pegShortfall(), 2e7, "real shortfall");
        // the 50-BTC buffer fully absorbs a 0.2-BTC shortfall
        assertEq(buf.uncoveredShortfall(), 0, "buffer covers it");
    }

    function test_uncoveredShortfall_exceeds_buffer() public {
        pool.setBacking(0); // all backing rugged
        cbtc.mint(HOLDER, 100e8); // 100 cBTC circulating, 0 backing -> 100 BTC short
        assertEq(buf.pegShortfall(), 100e8, "100 BTC real shortfall");
        // buffer only covers 50 BTC -> 50 BTC uncovered (the true peg-solvency signal)
        assertEq(buf.uncoveredShortfall(), 50e8, "50 BTC uncovered after buffer");
    }

    function test_buffer_value_fails_closed_on_bad_feed() public {
        feed.set(0, T0);
        vm.expectRevert(CbtcBuffer.BadFeed.selector);
        buf.bufferBtcValueSats();
    }

    function test_addBuffer_and_withdraw_owner_only() public {
        teth.mint(ANYONE, 5e18);
        vm.prank(ANYONE);
        teth.approve(address(buf), 5e18);
        vm.prank(ANYONE);
        buf.addBuffer(5e18);
        assertEq(teth.balanceOf(address(buf)), 1005e18, "anyone can fund");

        vm.expectRevert();
        vm.prank(ANYONE);
        buf.withdrawBuffer(1, ANYONE);
        vm.prank(ADMIN);
        buf.withdrawBuffer(10e18, ADMIN);
        assertEq(teth.balanceOf(ADMIN), 10e18, "owner releases");
    }
}
