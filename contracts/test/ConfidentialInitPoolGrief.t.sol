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
        pool = new ConfidentialPool(address(new MockSP1VerifierG()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0), bytes32(0), 6, bytes32(0), bytes32(0), address(0));
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

    // GRIEF-1 (createPair model): createPair is a permissionless, EMPTY one-per-slot pool. A runaway fee
    // is rejected (FeeTooHigh); there are NO reserves to grief (the first OP_LP_ADD seeds them from
    // shielded notes), so a front-run can at worst occupy the empty slot at a sane fee — anyone then funds
    // it, and the pair is never bricked.
    function test_frontrun_cannot_brick_pair_with_bad_fee() public {
        // a 100% fee is rejected
        vm.prank(ATTACKER);
        vm.expectRevert(ConfidentialPool.FeeTooHigh.selector);
        pool.createPair(assetA, assetB, 10000);
        // a front-run with a SANE fee just creates an EMPTY, joinable slot (the pair is not lost; the first
        // liquidity provider — attacker or anyone — seeds it via a first-mint OP_LP_ADD).
        vm.prank(ATTACKER);
        bytes32 pid = pool.createPair(assetA, assetB, 30);
        (bool init, , , uint256 rA, uint256 rB, uint32 fee, uint256 sh) = pool.pools(pid);
        assertTrue(init && rA == 0 && rB == 0 && sh == 0 && fee == 30, "front-run yields an empty joinable slot, not a brick");
    }

    // GRIEF-1b: createPair CANONICALIZES the pair (sorts assetA/assetB), so the argument order is
    // irrelevant — both orderings resolve to the SAME poolId, and the second createPair reverts PoolExists
    // (an attacker cannot pre-lock "both orderings").
    function test_orderings_canonicalize_to_one_pool() public {
        vm.prank(ATTACKER);
        bytes32 pidAB = pool.createPair(assetA, assetB, 0);
        // reversed args, same fee → same slot → PoolExists
        vm.prank(ATTACKER);
        vm.expectRevert(ConfidentialPool.PoolExists.selector);
        pool.createPair(assetB, assetA, 0);
        assertEq(pidAB, keccak256(abi.encode(assetA, assetB, uint32(0))), "poolId is canonical (sorted) + fee");
        (bool iAB,,,,,,) = pool.pools(pidAB);
        assertTrue(iAB, "the one canonical pool is initialized");
    }
}
