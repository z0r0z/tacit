// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract MockERC20 is ERC20 {
    function name() public pure override returns (string memory) { return "Mock"; }
    function symbol() public pure override returns (string memory) { return "MCK"; }
    function decimals() public pure override returns (uint8) { return 18; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockSP1Verifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// C-1: the confidential AMM pool reserve state + the OP_SWAP SwapSettlement applied in settle.
/// The proof crypto (membership/nullifier/sigma/clearing/conservation) is the guest's job + the
/// real-proof suite; this pins the on-chain pool state machine (init + reserve pre-gate + post move).
contract ConfidentialPoolSwapTest is Test {
    ConfidentialPool pool;
    MockERC20 tokenA;
    MockERC20 tokenB;
    bytes32 assetA;
    bytes32 assetB;
    bytes32 poolId;

    function setUp() public {
        vm.chainId(1);
        pool = new ConfidentialPool(address(new MockSP1Verifier()), bytes32(uint256(0xABCD)), bytes32(0), address(0));
        tokenA = new MockERC20();
        tokenB = new MockERC20();
        assetA = pool.registerWrapped(address(tokenA), 1, bytes32(0), "Conf A", "cA", 18);
        assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Conf B", "cB", 18);
        tokenA.mint(address(this), 1_000_000);
        tokenB.mint(address(this), 1_000_000);
        tokenA.approve(address(pool), type(uint256).max);
        tokenB.approve(address(pool), type(uint256).max);
        poolId = keccak256(abi.encode(assetA, assetB));
    }

    function _pv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = pool.PV_VERSION();
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
    }
    function _settle(ConfidentialPool.PublicValues memory pv) internal {
        pool.settle(abi.encode(pv), "", new bytes[](pv.leaves.length));
    }
    function _swap(bytes32 id, uint256 ap, uint256 bp, uint256 apost, uint256 bpost)
        internal pure returns (ConfidentialPool.SwapSettlement memory)
    { return ConfidentialPool.SwapSettlement(id, ap, bp, apost, bpost); }

    // ──────────────────── init ────────────────────

    function test_init_pool_funds_and_creates() public {
        bytes32 id = pool.initPool(assetA, assetB, 100, 200, 30);
        assertEq(id, poolId, "poolId = keccak(assetA, assetB)");
        (bool init, bytes32 a, bytes32 b, uint256 rA, uint256 rB, uint32 fee) = pool.pools(id);
        assertTrue(init, "init");
        assertEq(a, assetA); assertEq(b, assetB);
        assertEq(rA, 100, "reserveA"); assertEq(rB, 200, "reserveB"); assertEq(fee, 30, "feeBps");
        // reserves are escrowed (unitScale 1)
        assertEq(pool.escrow(assetA), 100, "escrow A"); assertEq(pool.escrow(assetB), 200, "escrow B");
        assertEq(tokenA.balanceOf(address(pool)), 100, "held A");
    }

    function test_init_same_asset_reverts() public {
        vm.expectRevert(ConfidentialPool.SameAsset.selector);
        pool.initPool(assetA, assetA, 1, 1, 30);
    }

    function test_init_unregistered_reverts() public {
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        pool.initPool(assetA, keccak256("nope"), 1, 1, 30);
    }

    function test_init_duplicate_reverts() public {
        pool.initPool(assetA, assetB, 100, 200, 30);
        vm.expectRevert(ConfidentialPool.PoolExists.selector);
        pool.initPool(assetA, assetB, 50, 50, 30);
    }

    // ──────────────────── settle swap ────────────────────

    function test_settle_swap_moves_reserves() public {
        pool.initPool(assetA, assetB, 100, 200, 30);
        // a batch that nets the pool A:100→150, B:200→133 (a swap of A in for B out)
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv.swaps[0] = _swap(poolId, 100, 200, 150, 133);

        vm.expectEmit(true, false, false, true, address(pool));
        emit ConfidentialPool.SwapSettled(poolId, 150, 133);
        _settle(pv);

        (, , , uint256 rA, uint256 rB, ) = pool.pools(poolId);
        assertEq(rA, 150, "reserveA moved to post"); assertEq(rB, 133, "reserveB moved to post");
    }

    function test_settle_swap_stale_pre_reverts() public {
        pool.initPool(assetA, assetB, 100, 200, 30);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv.swaps[0] = _swap(poolId, 99, 200, 150, 133); // pre != live reserves
        vm.expectRevert(ConfidentialPool.PoolReserveMismatch.selector);
        _settle(pv);
    }

    function test_settle_swap_uninit_pool_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv.swaps[0] = _swap(keccak256("ghost"), 0, 0, 0, 0);
        vm.expectRevert(ConfidentialPool.PoolNotInit.selector);
        _settle(pv);
    }

    // Two batches chain: each must pin the live reserves left by the previous one.
    function test_settle_swap_chains() public {
        pool.initPool(assetA, assetB, 100, 200, 30);
        ConfidentialPool.PublicValues memory pv1 = _pv();
        pv1.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv1.swaps[0] = _swap(poolId, 100, 200, 150, 133);
        _settle(pv1);

        // a second batch pinning the NEW reserves (150, 133) → (120, 167)
        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv2.swaps[0] = _swap(poolId, 150, 133, 120, 167);
        _settle(pv2);
        (, , , uint256 rA, uint256 rB, ) = pool.pools(poolId);
        assertEq(rA, 120); assertEq(rB, 167);

        // a batch re-pinning the original (stale) reserves now fails
        ConfidentialPool.PublicValues memory pv3 = _pv();
        pv3.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv3.swaps[0] = _swap(poolId, 100, 200, 999, 999);
        vm.expectRevert(ConfidentialPool.PoolReserveMismatch.selector);
        _settle(pv3);
    }
}
