// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {InsuranceVault, IBtcValuer} from "../src/InsuranceVault.sol";

contract MockERC20 {
    string public name;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n) { name = n; }

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

/// Injected BTC valuer: BTC sats per token unit, fail-closed (reverts) on an unpriceable token.
contract MockBtcValuer is IBtcValuer {
    mapping(address => uint256) public rateNum;
    mapping(address => uint256) public rateDen;
    mapping(address => bool) public priceable;

    function setRate(address token, uint256 n, uint256 d) external {
        rateNum[token] = n;
        rateDen[token] = d;
        priceable[token] = true;
    }

    function unset(address token) external { priceable[token] = false; }

    function btcValueSats(address token, uint256 amount) external view returns (uint256) {
        require(priceable[token], "unpriceable");
        return amount * rateNum[token] / rateDen[token];
    }
}

contract InsuranceVaultTest is Test {
    InsuranceVault vault;
    MockPool pool;
    MockERC20 cbtc;
    MockERC20 tac;
    MockERC20 teth;
    MockBtcValuer valuer;

    address constant ADMIN = address(0xA11CE);
    address constant DAO = address(0xDA0);
    address constant ANYONE = address(0xBEEF);
    address constant HOLDER = address(0xC0FFEE);

    function setUp() public {
        pool = new MockPool();
        cbtc = new MockERC20("cBTC.tac");
        tac = new MockERC20("TAC");
        teth = new MockERC20("tETH");
        valuer = new MockBtcValuer();
        vault = new InsuranceVault(address(pool), address(cbtc), address(tac), address(teth), ADMIN);

        valuer.setRate(address(tac), 1, 1); // 1 sat / TAC unit
        valuer.setRate(address(teth), 2, 1); // 2 sats / tETH unit

        vm.prank(ADMIN);
        vault.setValuer(address(valuer));

        // backstop reserve: 1000 TAC (=1000 sats) + 2000 tETH (=4000 sats) -> 5000 sats BTC-equivalent
        tac.mint(address(vault), 1000);
        teth.mint(address(vault), 2000);
    }

    function test_owner_is_admin_then_transfers_to_dao() public {
        assertEq(vault.owner(), ADMIN);
        vm.prank(ADMIN);
        vault.transferOwnership(DAO);
        assertEq(vault.owner(), DAO);
    }

    function test_addCapital_permissionless_withdraw_owner_only() public {
        tac.mint(ANYONE, 500);
        vm.startPrank(ANYONE);
        tac.approve(address(vault), 500);
        vault.addCapital(address(tac), 500); // anyone funds
        vm.stopPrank();
        assertEq(tac.balanceOf(address(vault)), 1500);

        vm.expectRevert(); // not owner
        vm.prank(ANYONE);
        vault.withdrawCapital(address(tac), 1, ANYONE);

        vm.prank(ADMIN);
        vault.withdrawCapital(address(tac), 100, ADMIN); // owner only
        assertEq(tac.balanceOf(ADMIN), 100);
    }

    function test_pegShortfall() public {
        pool.setBacking(120);
        cbtc.mint(HOLDER, 100); // circulating 100 <= backing 120
        assertEq(vault.pegShortfall(), 0);
        pool.setBacking(80);
        assertEq(vault.pegShortfall(), 20, "circulating - backing");
    }

    function test_backstopBtcValue() public view {
        // 1000 TAC * 1 + 2000 tETH * 2 = 5000 sats
        assertEq(vault.backstopBtcValueSats(), 5000);
    }

    function test_uncoveredShortfall_backstop_absorbs() public {
        pool.setBacking(100);
        cbtc.mint(HOLDER, 120); // 20-sat real shortfall
        assertEq(vault.pegShortfall(), 20);
        // 5000-sat backstop fully absorbs it
        assertEq(vault.uncoveredShortfall(), 0);
    }

    function test_uncoveredShortfall_exceeds_backstop() public {
        pool.setBacking(0);
        cbtc.mint(HOLDER, 8000); // 8000-sat shortfall, backstop only 5000
        assertEq(vault.pegShortfall(), 8000);
        assertEq(vault.uncoveredShortfall(), 3000, "uncovered after the 5000 backstop");
    }

    function test_fail_closed_no_valuer() public {
        InsuranceVault bare = new InsuranceVault(address(pool), address(cbtc), address(tac), address(teth), ADMIN);
        vm.expectRevert(InsuranceVault.NoValuer.selector);
        bare.backstopBtcValueSats();
    }

    function test_fail_closed_valuer_cannot_price_a_leg() public {
        valuer.unset(address(teth)); // feed for the tETH leg goes bad
        vm.expectRevert(bytes("unpriceable"));
        vault.backstopBtcValueSats();
    }

    function test_setValuer_owner_only() public {
        vm.expectRevert();
        vm.prank(ANYONE);
        vault.setValuer(address(0xDEAD));
    }

    function test_bad_leg_rejected() public {
        MockERC20 rogue = new MockERC20("ROGUE");
        rogue.mint(ANYONE, 100);
        vm.startPrank(ANYONE);
        rogue.approve(address(vault), 100);
        vm.expectRevert(InsuranceVault.BadLeg.selector);
        vault.addCapital(address(rogue), 100);
        vm.stopPrank();
    }
}
