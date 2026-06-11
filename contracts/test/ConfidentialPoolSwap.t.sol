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
        pool = new ConfidentialPool(address(new MockSP1Verifier()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0), bytes32(0));
        tokenA = new MockERC20();
        tokenB = new MockERC20();
        assetA = pool.registerWrapped(address(tokenA), 1, bytes32(0), "Conf A", "cA", 18);
        assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Conf B", "cB", 18);
        // canonicalize so assetA < assetB (and tokenA tracks assetA): the pool keys by the sorted pair,
        // and these tests present reserves in canonical low→high order to line up with that storage.
        if (assetA > assetB) { (assetA, assetB) = (assetB, assetA); (tokenA, tokenB) = (tokenB, tokenA); }
        tokenA.mint(address(this), 1_000_000);
        tokenB.mint(address(this), 1_000_000);
        tokenA.approve(address(pool), type(uint256).max);
        tokenB.approve(address(pool), type(uint256).max);
        poolId = keccak256(abi.encode(assetA, assetB, uint32(30)));
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
    function _lp(bytes32 id, uint256 ap, uint256 bp, uint256 sp, uint256 apost, uint256 bpost, uint256 spost)
        internal pure returns (ConfidentialPool.LpSettlement memory)
    { return ConfidentialPool.LpSettlement(id, ap, bp, sp, apost, bpost, spost); }

    // ──────────────────── init ────────────────────

    function test_init_pool_funds_and_creates() public {
        bytes32 id = pool.initPool(assetA, assetB, 100, 200, 30);
        assertEq(id, poolId, "poolId = keccak(assetA, assetB, feeBps)");
        (bool init, bytes32 a, bytes32 b, uint256 rA, uint256 rB, uint32 fee, ) = pool.pools(id);
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

    // Multi-fee-tier: the SAME pair at a DIFFERENT fee is a DISTINCT pool (own poolId, own reserves),
    // so a 0.3% and a 1% pool over (A,B) coexist — and the duplicate guard is per (pair, fee), not per pair.
    function test_init_distinct_fee_tiers_coexist() public {
        bytes32 id30 = pool.initPool(assetA, assetB, 100, 200, 30);
        bytes32 id100 = pool.initPool(assetA, assetB, 300, 600, 100);
        assertTrue(id30 != id100, "different fee tier = different poolId");
        assertEq(id30, keccak256(abi.encode(assetA, assetB, uint32(30))));
        assertEq(id100, keccak256(abi.encode(assetA, assetB, uint32(100))));
        (bool i30, , , uint256 rA30, , uint32 f30, ) = pool.pools(id30);
        (bool i100, , , uint256 rA100, , uint32 f100, ) = pool.pools(id100);
        assertTrue(i30 && i100, "both tiers initialized");
        assertEq(f30, 30); assertEq(f100, 100);
        assertEq(rA30, 100, "0.3% tier reserves"); assertEq(rA100, 300, "1% tier reserves");
    }

    function test_init_fee_too_high_reverts() public {
        uint32 tooHigh = pool.MAX_POOL_FEE_BPS() + 1;
        vm.expectRevert(ConfidentialPool.FeeTooHigh.selector);
        pool.initPool(assetA, assetB, 100, 200, tooHigh);
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

        (, , , uint256 rA, uint256 rB, , ) = pool.pools(poolId);
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
        (, , , uint256 rA, uint256 rB, , ) = pool.pools(poolId);
        assertEq(rA, 120); assertEq(rB, 167);

        // a batch re-pinning the original (stale) reserves now fails
        ConfidentialPool.PublicValues memory pv3 = _pv();
        pv3.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv3.swaps[0] = _swap(poolId, 100, 200, 999, 999);
        vm.expectRevert(ConfidentialPool.PoolReserveMismatch.selector);
        _settle(pv3);
    }

    // ──────────────────── settle LP (OP_LP_ADD / OP_LP_REMOVE) ────────────────────
    // C-1: the on-chain LP state machine — reserves AND totalShares move together, pre-gated.
    // The in-ratio-add / proportional-remove + the shielded LP-share + asset notes are the guest's job.

    function test_init_pool_seeds_total_shares() public {
        pool.initPool(assetA, assetB, 100, 200, 30);
        (, , , , , , uint256 shares) = pool.pools(poolId);
        assertEq(shares, 100, "seed shares = reserveA");
    }

    function test_settle_lp_add_moves_reserves_and_shares() public {
        pool.initPool(assetA, assetB, 1000, 2000, 30); // shares seed 1000
        // an in-ratio add of 100 A + 200 B → +100 shares (proportional: 1000·100/1000)
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = _lp(poolId, 1000, 2000, 1000, 1100, 2200, 1100);
        vm.expectEmit(true, false, false, true, address(pool));
        emit ConfidentialPool.LiquidityChanged(poolId, 1100, 2200, 1100);
        _settle(pv);
        (, , , uint256 rA, uint256 rB, , uint256 shares) = pool.pools(poolId);
        assertEq(rA, 1100); assertEq(rB, 2200); assertEq(shares, 1100, "reserves + shares moved");
    }

    function test_settle_lp_remove_moves_reserves_and_shares() public {
        pool.initPool(assetA, assetB, 1000, 2000, 30);
        // remove 200 shares (1/5) → −200 A, −400 B, −200 shares
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = _lp(poolId, 1000, 2000, 1000, 800, 1600, 800);
        _settle(pv);
        (, , , uint256 rA, uint256 rB, , uint256 shares) = pool.pools(poolId);
        assertEq(rA, 800); assertEq(rB, 1600); assertEq(shares, 800, "remove moved reserves + shares");
    }

    function test_settle_lp_stale_pre_reverts() public {
        pool.initPool(assetA, assetB, 1000, 2000, 30);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = _lp(poolId, 1000, 2000, 999, 1100, 2200, 1099); // sharesPre != live
        vm.expectRevert(ConfidentialPool.PoolReserveMismatch.selector);
        _settle(pv);
    }

    function test_settle_lp_uninit_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = _lp(keccak256("ghost"), 0, 0, 0, 0, 0, 0);
        vm.expectRevert(ConfidentialPool.PoolNotInit.selector);
        _settle(pv);
    }

    // Swap then LP chain in one settle: settle applies swaps first, then liquidity, so the LP
    // settlement pins the reserves the swap left.
    function test_settle_swap_then_lp_chains() public {
        pool.initPool(assetA, assetB, 1000, 1000, 30); // shares 1000
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv.swaps[0] = _swap(poolId, 1000, 1000, 1100, 910); // swap first: 1000/1000 → 1100/910
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        // in-ratio add at the post-swap reserves: dA 110, dB 91 (110·910 == 91·1100) → +100 shares
        pv.liquidity[0] = _lp(poolId, 1100, 910, 1000, 1210, 1001, 1100);
        _settle(pv);
        (, , , uint256 rA, uint256 rB, , uint256 shares) = pool.pools(poolId);
        assertEq(rA, 1210); assertEq(rB, 1001); assertEq(shares, 1100, "LP chained after swap");
    }
}
