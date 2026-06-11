// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract MockERC20G is ERC20 {
    function name() public pure override returns (string memory) { return "Mock"; }
    function symbol() public pure override returns (string memory) { return "MCK"; }
    function decimals() public pure override returns (uint8) { return 18; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockSP1VerifierG is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract ConfidentialInitPoolGriefTest is Test {
    ConfidentialPool pool;
    MockERC20G tokenA;
    MockERC20G tokenB;
    bytes32 assetA;
    bytes32 assetB;

    address constant ATTACKER = address(0xBAD);
    address constant LP = address(0x111);

    function setUp() public {
        vm.chainId(1);
        pool = new ConfidentialPool(address(new MockSP1VerifierG()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0), bytes32(0));
        tokenA = new MockERC20G();
        tokenB = new MockERC20G();
        assetA = pool.registerWrapped(address(tokenA), 1, bytes32(0), "Conf A", "cA", 18);
        assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Conf B", "cB", 18);
        if (assetA > assetB) { (assetA, assetB) = (assetB, assetA); (tokenA, tokenB) = (tokenB, tokenA); }
        // fund both attacker and LP
        tokenA.mint(ATTACKER, 1_000_000); tokenB.mint(ATTACKER, 1_000_000);
        tokenA.mint(LP, 1_000_000);       tokenB.mint(LP, 1_000_000);
        vm.startPrank(ATTACKER);
        tokenA.approve(address(pool), type(uint256).max); tokenB.approve(address(pool), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(LP);
        tokenA.approve(address(pool), type(uint256).max); tokenB.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    // GRIEF-1 (fixed): initPool bounds what a permissionless front-run can seed into the one-per-slot
    // pool. A zero reserve (un-joinable — no in-ratio add can rescue a 0 leg) and a runaway fee
    // (unusable) are rejected, so the worst a front-run can do is create a USABLE pool (real reserves,
    // capped fee) — never a permanent dust/100%-fee brick of the pair.
    function test_frontrun_cannot_brick_pair_with_dust_or_bad_fee() public {
        // a 100% fee is rejected
        vm.prank(ATTACKER);
        vm.expectRevert(ConfidentialPool.FeeTooHigh.selector);
        pool.initPool(assetA, assetB, 1, 1, 10000);
        // a zero reserve (un-joinable) is rejected
        vm.prank(ATTACKER);
        vm.expectRevert(ConfidentialPool.ZeroReserve.selector);
        pool.initPool(assetA, assetB, 0, 1, 30);
        // a front-run with SANE params just yields a usable pool (the pair is not lost; only the slot's
        // params are first-come, and they must be sane).
        vm.prank(ATTACKER);
        bytes32 pid = pool.initPool(assetA, assetB, 100, 200, 30);
        (bool init, , , uint256 rA, uint256 rB, uint32 fee, ) = pool.pools(pid);
        assertTrue(init && rA == 100 && rB == 200 && fee == 30, "front-run yields a usable pool, not a brick");
    }

    // GRIEF-1b (fixed): initPool CANONICALIZES the pair (sorts assetA/assetB), so the argument order is
    // irrelevant — both orderings resolve to the SAME poolId. A client that derives poolId(assetB, assetA)
    // and one that derives poolId(assetA, assetB) point at one and the same pool, and an attacker cannot
    // pre-lock "both orderings": the second init reverts PoolExists.
    function test_orderings_canonicalize_to_one_pool() public {
        vm.prank(ATTACKER);
        bytes32 pidAB = pool.initPool(assetA, assetB, 1, 1, 0);
        // same fee tier, reversed args → same slot → PoolExists
        vm.prank(ATTACKER);
        vm.expectRevert(ConfidentialPool.PoolExists.selector);
        pool.initPool(assetB, assetA, 1, 1, 0);
        // and the canonical derivation matches what initPool stored
        assertEq(pidAB, keccak256(abi.encode(assetA, assetB, uint32(0))), "poolId is canonical (sorted) + fee");
        (bool iAB,,,,,,) = pool.pools(pidAB);
        assertTrue(iAB, "the one canonical pool is initialized");
    }
}
