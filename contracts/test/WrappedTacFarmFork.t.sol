// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WrappedTac} from "../src/WrappedTac.sol";
import {FarmController} from "../src/FarmController.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";

interface IMintable { function mint(address to, uint256 amount) external; function approve(address, uint256) external returns (bool); }

/// MAINNET FORK ONLY (skipped elsewhere): a farm on the LIVE gen5 pool paying in wTAC.
///   forge test --match-contract WrappedTacFarmFork --fork-url $RPC -vv
/// Proves (1) the pool refuses the canonical pool-minted TAC as an escrow farm reward (the reason wTAC exists),
/// (2) wTAC registers as an ordinary external escrow asset, (3) a farm on it funds and starts emitting.
contract WrappedTacFarmFork is Test {
    address constant POOL = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    bytes32 constant TAC_ASSET_ID = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    address gov = address(0x60A);
    address funder = address(0xF00D);

    function setUp() public { if (block.chainid != 1) vm.skip(true); }

    function _tacFor(address who, uint256 amt) internal { vm.prank(POOL); IMintable(TAC).mint(who, amt); }

    function test_canonicalTacCannotFundAnEscrowFarm() public {
        FarmController farm = new FarmController(POOL, keccak256("stake"), TAC_ASSET_ID, true, true, gov, 0);
        _tacFor(funder, 1000 ether);
        vm.startPrank(funder);
        IMintable(TAC).approve(POOL, type(uint256).max);
        vm.expectRevert(); // NotRegistered: the first-fund check rejects a poolMinted reward asset
        ConfidentialPool(payable(POOL)).farmEscrow(address(farm), TAC_ASSET_ID, 1000 ether, address(0));
        vm.stopPrank();
    }

    function test_wTacFarmFundsAndEmits() public {
        WrappedTac w = new WrappedTac(TAC);
        _tacFor(funder, 250_000 ether);
        vm.startPrank(funder);
        IMintable(TAC).approve(address(w), type(uint256).max);
        w.deposit(250_000 ether, funder);
        vm.stopPrank();

        bytes32 wId = ConfidentialPool(payable(POOL)).registerWrappedAuto(address(w), bytes32(0));
        (bool registered, address underlying, uint256 unitScale,, bool poolMinted, uint8 dec) = ConfidentialPool(payable(POOL)).assets(wId);
        assertTrue(registered);
        assertEq(underlying, address(w));
        assertFalse(poolMinted);
        assertEq(dec, 18);
        assertEq(unitScale, 1e10); // 18 -> 8 Tacit decimals

        FarmController farm = new FarmController(POOL, keccak256("stake"), wId, true, true, gov, 0);
        uint256 tranche = 25_000 ether;
        vm.startPrank(funder);
        w.approve(POOL, type(uint256).max);
        ConfidentialPool(payable(POOL)).farmEscrow(address(farm), wId, tranche, address(0));
        vm.stopPrank();
        assertEq(w.balanceOf(POOL), tranche); // the pool now escrows the wTAC

        uint256 valueUnits = tranche / unitScale; // 8-decimal reward units, as the pool books them
        vm.prank(gov);
        farm.notifyRewardAmount(valueUnits, 90 days);
        assertEq(farm.periodFinish(), block.timestamp + 90 days);
        assertEq(farm.rate(), valueUnits / (90 days));
    }
}
