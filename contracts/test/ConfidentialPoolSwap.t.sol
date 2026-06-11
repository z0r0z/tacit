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
/// Reserves are seeded well above MINIMUM_LIQUIDITY (1000) — the V2-style seed lock — so the founder
/// gets a positive claimable LP-share position.
contract ConfidentialPoolSwapTest is Test {
    ConfidentialPool pool;
    MockERC20 tokenA;
    MockERC20 tokenB;
    bytes32 assetA;
    bytes32 assetB;
    bytes32 poolId;

    function setUp() public {
        vm.chainId(1);
        pool = new ConfidentialPool(address(new MockSP1Verifier()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0), bytes32(0), 6);
        tokenA = new MockERC20();
        tokenB = new MockERC20();
        assetA = pool.registerWrapped(address(tokenA), 1, bytes32(0), "Conf A", "cA", 18);
        assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Conf B", "cB", 18);
        // canonicalize so assetA < assetB (and tokenA tracks assetA): the pool keys by the sorted pair,
        // and these tests present reserves in canonical low→high order to line up with that storage.
        if (assetA > assetB) { (assetA, assetB) = (assetB, assetA); (tokenA, tokenB) = (tokenB, tokenA); }
        tokenA.mint(address(this), 100_000_000);
        tokenB.mint(address(this), 100_000_000);
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
    // initPool with dummy founder-share-note commitments (these tests pin the pool state machine, not
    // the founder's note claim; the share-note recovery itself is covered in ConfidentialPool.t.sol).
    function _init(bytes32 a, bytes32 b, uint256 ra, uint256 rb, uint32 fee) internal returns (bytes32) {
        return pool.initPool(a, b, ra, rb, fee, bytes32(uint256(0x5EED)), bytes32(uint256(0x5EE2)), bytes32(uint256(0x5EE3)));
    }
    function _swap(bytes32 id, uint256 ap, uint256 bp, uint256 apost, uint256 bpost)
        internal pure returns (ConfidentialPool.SwapSettlement memory)
    { return ConfidentialPool.SwapSettlement(id, ap, bp, apost, bpost); }
    function _lp(bytes32 id, uint256 ap, uint256 bp, uint256 sp, uint256 apost, uint256 bpost, uint256 spost)
        internal pure returns (ConfidentialPool.LpSettlement memory)
    { return ConfidentialPool.LpSettlement(id, ap, bp, sp, apost, bpost, spost); }

    // ──────────────────── init ────────────────────

    function test_init_pool_funds_and_creates() public {
        bytes32 id = _init(assetA, assetB, 10000, 20000, 30);
        assertEq(id, poolId, "poolId = keccak(assetA, assetB, feeBps)");
        (bool init, bytes32 a, bytes32 b, uint256 rA, uint256 rB, uint32 fee, ) = pool.pools(id);
        assertTrue(init, "init");
        assertEq(a, assetA); assertEq(b, assetB);
        assertEq(rA, 10000, "reserveA"); assertEq(rB, 20000, "reserveB"); assertEq(fee, 30, "feeBps");
        // reserves are escrowed (unitScale 1)
        assertEq(pool.escrow(assetA), 10000, "escrow A"); assertEq(pool.escrow(assetB), 20000, "escrow B");
        assertEq(tokenA.balanceOf(address(pool)), 10000, "held A");
    }

    function test_init_same_asset_reverts() public {
        vm.expectRevert(ConfidentialPool.SameAsset.selector);
        _init(assetA, assetA, 10000, 10000, 30);
    }

    function test_init_unregistered_reverts() public {
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        _init(assetA, keccak256("nope"), 10000, 10000, 30);
    }

    // A seed at or below MINIMUM_LIQUIDITY can't create a positive founder position — rejected, so no
    // dust pool (and no founder who donates their entire seed).
    function test_init_below_min_liquidity_reverts() public {
        vm.expectRevert(ConfidentialPool.InsufficientSeed.selector);
        _init(assetA, assetB, 1000, 20000, 30); // rLo == MINIMUM_LIQUIDITY
    }

    function test_init_duplicate_reverts() public {
        _init(assetA, assetB, 10000, 20000, 30);
        vm.expectRevert(ConfidentialPool.PoolExists.selector);
        _init(assetA, assetB, 5000, 5000, 30);
    }

    // Multi-fee-tier: the SAME pair at a DIFFERENT fee is a DISTINCT pool (own poolId, own reserves),
    // so a 0.3% and a 1% pool over (A,B) coexist — and the duplicate guard is per (pair, fee), not per pair.
    function test_init_distinct_fee_tiers_coexist() public {
        bytes32 id30 = _init(assetA, assetB, 10000, 20000, 30);
        bytes32 id100 = _init(assetA, assetB, 30000, 60000, 100);
        assertTrue(id30 != id100, "different fee tier = different poolId");
        assertEq(id30, keccak256(abi.encode(assetA, assetB, uint32(30))));
        assertEq(id100, keccak256(abi.encode(assetA, assetB, uint32(100))));
        (bool i30, , , uint256 rA30, , uint32 f30, ) = pool.pools(id30);
        (bool i100, , , uint256 rA100, , uint32 f100, ) = pool.pools(id100);
        assertTrue(i30 && i100, "both tiers initialized");
        assertEq(f30, 30); assertEq(f100, 100);
        assertEq(rA30, 10000, "0.3% tier reserves"); assertEq(rA100, 30000, "1% tier reserves");
    }

    function test_init_fee_too_high_reverts() public {
        uint32 tooHigh = pool.MAX_POOL_FEE_BPS() + 1;
        vm.expectRevert(ConfidentialPool.FeeTooHigh.selector);
        _init(assetA, assetB, 10000, 20000, tooHigh);
    }

    // ──────────────────── settle swap ────────────────────

    function test_settle_swap_moves_reserves() public {
        _init(assetA, assetB, 10000, 20000, 30);
        // a batch that nets the pool A:10000→15000, B:20000→13300 (a swap of A in for B out)
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv.swaps[0] = _swap(poolId, 10000, 20000, 15000, 13300);

        vm.expectEmit(true, false, false, true, address(pool));
        emit ConfidentialPool.SwapSettled(poolId, 15000, 13300);
        _settle(pv);

        (, , , uint256 rA, uint256 rB, , ) = pool.pools(poolId);
        assertEq(rA, 15000, "reserveA moved to post"); assertEq(rB, 13300, "reserveB moved to post");
    }

    function test_settle_swap_stale_pre_reverts() public {
        _init(assetA, assetB, 10000, 20000, 30);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv.swaps[0] = _swap(poolId, 9900, 20000, 15000, 13300); // pre != live reserves
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
        _init(assetA, assetB, 10000, 20000, 30);
        ConfidentialPool.PublicValues memory pv1 = _pv();
        pv1.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv1.swaps[0] = _swap(poolId, 10000, 20000, 15000, 13300);
        _settle(pv1);

        // a second batch pinning the NEW reserves (15000, 13300) → (12000, 16700)
        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv2.swaps[0] = _swap(poolId, 15000, 13300, 12000, 16700);
        _settle(pv2);
        (, , , uint256 rA, uint256 rB, , ) = pool.pools(poolId);
        assertEq(rA, 12000); assertEq(rB, 16700);

        // a batch re-pinning the original (stale) reserves now fails
        ConfidentialPool.PublicValues memory pv3 = _pv();
        pv3.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv3.swaps[0] = _swap(poolId, 10000, 20000, 99900, 99900);
        vm.expectRevert(ConfidentialPool.PoolReserveMismatch.selector);
        _settle(pv3);
    }

    // ──────────────────── settle LP (OP_LP_ADD / OP_LP_REMOVE) ────────────────────
    // C-1: the on-chain LP state machine — reserves AND totalShares move together, pre-gated.
    // The in-ratio-add / proportional-remove + the shielded LP-share + asset notes are the guest's job.

    function test_init_pool_seeds_total_shares() public {
        _init(assetA, assetB, 10000, 20000, 30);
        (, , , , , , uint256 shares) = pool.pools(poolId);
        assertEq(shares, 10000, "seed shares = reserveA basis");
        // and the founder's claimable position (rLo − MINIMUM_LIQUIDITY) is recorded as a pending deposit
        bytes32 lpAsset = keccak256(abi.encodePacked(poolId, "lp"));
        bytes32 depId = keccak256(abi.encode(lpAsset, uint256(10000 - 1000), bytes32(uint256(0x5EED)), bytes32(uint256(0x5EE2)), bytes32(uint256(0x5EE3))));
        assertEq(pool.depositStatus(depId), 1, "founder LP-share deposit recorded (rLo - MINIMUM_LIQUIDITY)");
    }

    function test_settle_lp_add_moves_reserves_and_shares() public {
        _init(assetA, assetB, 100000, 200000, 30); // shares seed 100000
        // an in-ratio add of 10000 A + 20000 B → +10000 shares (proportional: 100000·10000/100000)
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = _lp(poolId, 100000, 200000, 100000, 110000, 220000, 110000);
        vm.expectEmit(true, false, false, true, address(pool));
        emit ConfidentialPool.LiquidityChanged(poolId, 110000, 220000, 110000);
        _settle(pv);
        (, , , uint256 rA, uint256 rB, , uint256 shares) = pool.pools(poolId);
        assertEq(rA, 110000); assertEq(rB, 220000); assertEq(shares, 110000, "reserves + shares moved");
    }

    function test_settle_lp_remove_moves_reserves_and_shares() public {
        _init(assetA, assetB, 100000, 200000, 30);
        // remove 20000 shares (1/5) → −20000 A, −40000 B, −20000 shares
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = _lp(poolId, 100000, 200000, 100000, 80000, 160000, 80000);
        _settle(pv);
        (, , , uint256 rA, uint256 rB, , uint256 shares) = pool.pools(poolId);
        assertEq(rA, 80000); assertEq(rB, 160000); assertEq(shares, 80000, "remove moved reserves + shares");
    }

    function test_settle_lp_stale_pre_reverts() public {
        _init(assetA, assetB, 100000, 200000, 30);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = _lp(poolId, 100000, 200000, 99900, 110000, 220000, 109900); // sharesPre != live
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
        _init(assetA, assetB, 100000, 100000, 30); // shares 100000
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv.swaps[0] = _swap(poolId, 100000, 100000, 110000, 91000); // swap first: 100000/100000 → 110000/91000
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        // in-ratio add at the post-swap reserves: dA 11000, dB 9100 (11000·91000 == 9100·110000) → +10000 shares
        pv.liquidity[0] = _lp(poolId, 110000, 91000, 100000, 121000, 100100, 110000);
        _settle(pv);
        (, , , uint256 rA, uint256 rB, , uint256 shares) = pool.pools(poolId);
        assertEq(rA, 121000); assertEq(rB, 100100); assertEq(shares, 110000, "LP chained after swap");
    }
}
