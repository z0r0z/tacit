// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {InsuranceVault, IInsuranceRouter} from "../src/InsuranceVault.sol";

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

/// Models "buy cBTC.tac off the AMM": pulls `spent` capital from the caller (the vault) and delivers
/// existing cBTC.tac from its inventory — so totalSupply is UNCHANGED and the vault sequestering it
/// reduces circulating supply (= totalSupply - vaultHeld). rate = capital units per cBTC.tac.
contract MockRouter is IInsuranceRouter {
    MockERC20 public immutable CBTC;
    uint256 public rateNum = 1;
    uint256 public rateDen = 1;

    constructor(MockERC20 cbtc) { CBTC = cbtc; }
    function setRate(uint256 n, uint256 d) external { rateNum = n; rateDen = d; }

    function buyExactCbtc(address capital, address cbtcTac, uint256 amountOut, uint256 maxIn, address to, bytes calldata)
        external
        returns (uint256 spent)
    {
        spent = (amountOut * rateNum) / rateDen;
        require(spent <= maxIn, "maxIn");
        MockERC20(capital).transferFrom(msg.sender, address(this), spent); // capital in
        MockERC20(cbtcTac).transfer(to, amountOut); // cBTC.tac out (from inventory; supply unchanged)
    }
}

contract InsuranceVaultTest is Test {
    InsuranceVault vault;
    MockPool pool;
    MockERC20 cbtc;
    MockERC20 tac;
    MockERC20 teth;
    MockRouter router;

    address constant ADMIN = address(0xA11CE);
    address constant DAO = address(0xDA0);
    address constant ANYONE = address(0xBEEF);

    function setUp() public {
        pool = new MockPool();
        cbtc = new MockERC20("cBTC.tac");
        tac = new MockERC20("TAC");
        teth = new MockERC20("tETH");
        router = new MockRouter(cbtc);
        vault = new InsuranceVault(address(pool), address(cbtc), address(tac), address(teth), ADMIN);

        vm.startPrank(ADMIN);
        vault.setRouter(address(router));
        vault.setParams(1_000_000, 1_000_000); // generous ceilings by default
        vm.stopPrank();

        // backstop capital (the cBTC.tac the router can sell = the circulating supply, minted per-test)
        tac.mint(address(vault), 1_000_000);
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

        vm.expectRevert(); // not owner
        vm.prank(ANYONE);
        vault.withdrawCapital(address(tac), 1, ANYONE);

        vm.prank(ADMIN);
        vault.withdrawCapital(address(tac), 100, ADMIN); // owner only
        assertEq(tac.balanceOf(ADMIN), 100);
    }

    function test_no_shortfall_when_backed() public {
        pool.setBacking(120);
        cbtc.mint(address(router), 100); // circulating 100 <= backing 120
        assertEq(vault.pegShortfall(), 0);
        vm.expectRevert(InsuranceVault.NoShortfall.selector);
        vault.coverShortfall(address(tac), "");
    }

    function test_coverShortfall_buys_and_sequesters_until_backed() public {
        // backing 100, but 120 cBTC.tac circulate (a custody failure removed 20 sats of backing)
        pool.setBacking(100);
        cbtc.mint(address(router), 120);
        assertEq(vault.pegShortfall(), 20, "shortfall = circulating - backing");

        uint256 tacBefore = tac.balanceOf(address(vault));
        (uint256 bought, uint256 spent) = vault.coverShortfall(address(tac), ""); // permissionless

        assertEq(bought, 20, "bought the exact shortfall");
        assertEq(spent, 20, "rate 1:1");
        assertEq(cbtc.balanceOf(address(vault)), 20, "sequestered the bought cBTC.tac");
        assertEq(tac.balanceOf(address(vault)), tacBefore - 20, "spent capital");
        assertEq(vault.pegShortfall(), 0, "circulating restored to <= backing");
    }

    function test_per_claim_buyback_cap_bounds_the_buy() public {
        pool.setBacking(100);
        cbtc.mint(address(router), 200); // shortfall 100
        vm.prank(ADMIN);
        vault.setParams(30, 1_000_000); // cap the buy at 30 per claim

        (uint256 bought,) = vault.coverShortfall(address(tac), "");
        assertEq(bought, 30, "capped at maxBuybackPerClaim");
        assertEq(vault.pegShortfall(), 70, "shortfall partially covered, rest remains");
    }

    function test_capital_ceiling_reverts_on_overspend() public {
        pool.setBacking(100);
        cbtc.mint(address(router), 120); // shortfall 20
        router.setRate(10, 1); // 10 capital per cBTC.tac -> 20*10 = 200 needed
        vm.prank(ADMIN);
        vault.setParams(1_000_000, 50); // but only 50 capital allowed per claim

        vm.expectRevert(bytes("maxIn")); // router refuses to exceed maxIn
        vault.coverShortfall(address(tac), "");
    }

    function test_setRouter_and_setParams_owner_only() public {
        vm.expectRevert();
        vm.prank(ANYONE);
        vault.setParams(1, 1);

        vm.expectRevert();
        vm.prank(ANYONE);
        vault.setRouter(address(0xDEAD));
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
