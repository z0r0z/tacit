// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CbtcBuffer, IChainlinkFeed, IAmmTwap, IBufferRouter} from "../src/CbtcBuffer.sol";

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

/// Sells cBTC for tETH: pulls `spent` tETH from the caller, delivers cBTC from inventory (supply unchanged
/// → the buffer sequestering it reduces circulating). rate = tETH wei per cBTC unit.
contract MockBufferRouter is IBufferRouter {
    MockERC20 public immutable CBTC;
    uint256 public rateNum = 2e11; // 0.05 BTC/ETH @ (8-dec cBTC, 18-dec tETH): 1 cBTC unit = 2e11 tETH wei
    uint256 public rateDen = 1;
    constructor(MockERC20 c) { CBTC = c; }
    function setRate(uint256 n, uint256 d) external { rateNum = n; rateDen = d; }
    function buyExactCbtc(address teth, address cbtc, uint256 amountOut, uint256 maxIn, address to, bytes calldata)
        external
        returns (uint256 spent)
    {
        spent = amountOut * rateNum / rateDen;
        require(spent <= maxIn, "maxIn");
        MockERC20(teth).transferFrom(msg.sender, address(this), spent);
        MockERC20(cbtc).transfer(to, amountOut);
    }
}

contract CbtcBufferTest is Test {
    CbtcBuffer buf;
    MockPool pool;
    MockERC20 cbtc; // 8 dec
    MockERC20 teth; // 18 dec
    MockChainlink feed; // ETH/BTC, 8 dec, 0.05 BTC/ETH
    MockAmmTwap twap;
    MockBufferRouter router;

    address constant ADMIN = address(0xA11CE);
    address constant DAO = address(0xDA0);
    address constant ANYONE = address(0xBEEF);
    uint256 constant T0 = 1_000_000;

    function setUp() public {
        vm.warp(T0);
        pool = new MockPool();
        cbtc = new MockERC20();
        teth = new MockERC20();
        feed = new MockChainlink(5e6, 8, T0); // 0.05 BTC per ETH
        twap = new MockAmmTwap(5e6, 8); // matching
        router = new MockBufferRouter(cbtc);
        buf = new CbtcBuffer(address(pool), address(cbtc), address(teth), 8, 18, ADMIN);

        vm.startPrank(ADMIN);
        buf.setFeeds(address(feed), address(twap));
        buf.setRouter(address(router));
        buf.setParams(1e18, 3600, 500, 100); // cap 1e18 cBTC, 1h staleness, 5% deviation, 1% slippage
        vm.stopPrank();

        teth.mint(address(buf), 1000e18); // buffer capital
    }

    function test_owner_to_dao_and_onlyOwner() public {
        assertEq(buf.owner(), ADMIN);
        vm.expectRevert();
        vm.prank(ANYONE);
        buf.setParams(1, 1, 1, 1);
        vm.prank(ADMIN);
        buf.transferOwnership(DAO);
        assertEq(buf.owner(), DAO);
    }

    function test_pegShortfall() public {
        pool.setBacking(1e8); // 1 BTC
        cbtc.mint(address(router), 12e7); // 1.2 cBTC circulating
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

    function test_coverShortfall_chainlink_bounded() public {
        pool.setBacking(1e8);
        cbtc.mint(address(router), 12e7); // shortfall 2e7
        uint256 tethBefore = teth.balanceOf(address(buf));

        (uint256 bought, uint256 spent) = buf.coverShortfall(""); // permissionless

        assertEq(bought, 2e7, "bought the shortfall");
        assertEq(spent, 4e18, "tETH spent = Chainlink-fair (0.2 BTC = 4 ETH)");
        assertEq(cbtc.balanceOf(address(buf)), 2e7, "sequestered");
        assertEq(teth.balanceOf(address(buf)), tethBefore - 4e18, "buffer spent");
        assertEq(buf.pegShortfall(), 0, "restored");
    }

    function test_coverShortfall_rejects_overpriced_amm() public {
        pool.setBacking(1e8);
        cbtc.mint(address(router), 12e7); // shortfall 2e7
        router.setRate(3e11, 1); // router wants 6e18 tETH; Chainlink-fair is 4e18 + 1% = 4.04e18
        vm.expectRevert(bytes("maxIn")); // router can't exceed the Chainlink-bounded maxIn
        buf.coverShortfall("");
    }

    function test_per_claim_cap() public {
        pool.setBacking(1e8);
        cbtc.mint(address(router), 3e8); // shortfall 2e8
        vm.prank(ADMIN);
        buf.setParams(5e7, 3600, 500, 100); // cap 0.5 cBTC
        (uint256 bought,) = buf.coverShortfall("");
        assertEq(bought, 5e7, "capped");
        assertEq(buf.pegShortfall(), 15e7, "remainder");
    }

    function test_withdrawBuffer_owner_only() public {
        vm.expectRevert();
        vm.prank(ANYONE);
        buf.withdrawBuffer(1, ANYONE);
        vm.prank(ADMIN);
        buf.withdrawBuffer(10e18, ADMIN);
        assertEq(teth.balanceOf(ADMIN), 10e18);
    }
}
