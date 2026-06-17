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

/// Public (non-shielded) AMM periphery: createPairAndAddLiquidityPublic / swapPublic /
/// removeLiquidityPublic. No proof — exercises the on-chain public AMM math + escrow directly.
contract ConfidentialPoolPublicAmmTest is Test {
    ConfidentialPool pool;
    MockERC20 tokenA;
    MockERC20 tokenB;
    bytes32 assetA;
    bytes32 assetB;

    function setUp() public {
        pool = new ConfidentialPool(address(new MockSP1Verifier()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0), bytes32(0), 6, bytes32(0));
        tokenA = new MockERC20();
        tokenB = new MockERC20();
        assetA = pool.registerWrapped(address(tokenA), 1, bytes32(0), "Conf A", "cA", 18); // unitScale 1: value == amount
        assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Conf B", "cB", 18);
        tokenA.mint(address(this), 1_000_000_000);
        tokenB.mint(address(this), 1_000_000_000);
        tokenA.approve(address(pool), type(uint256).max);
        tokenB.approve(address(pool), type(uint256).max);
    }

    function _pid(bytes32 a, bytes32 b, uint32 fee) internal pure returns (bytes32) {
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(lo, hi, fee));
    }

    function test_public_amm_lifecycle() public {
        // ── create + seed (founding) ──
        uint256 sh = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 4_000_000, address(this));
        bytes32 id = _pid(assetA, assetB, 30);
        (bool init,,, uint256 rA, uint256 rB,, uint256 ts) = pool.pools(id);
        // canonical: reserveA is the LOW asset's reserve
        (uint256 expA, uint256 expB) = assetA < assetB ? (uint256(1_000_000), uint256(4_000_000)) : (uint256(4_000_000), uint256(1_000_000));
        assertTrue(init, "pool created");
        assertEq(rA, expA, "reserveA"); assertEq(rB, expB, "reserveB");
        assertEq(ts, 2_000_000, "totalShares = isqrt(1e6*4e6) = 2e6");
        assertEq(sh, 2_000_000 - 1000, "founder shares = isqrt - MIN_LIQUIDITY");
        assertEq(pool.lpShares(id, address(this)), sh, "public ledger credited");
        assertEq(pool.escrow(assetA), 1_000_000, "escrow A backs reserve");
        assertEq(pool.escrow(assetB), 4_000_000, "escrow B backs reserve");

        // ── public swap A->B (k must not decrease) ──
        uint256 kPre = rA * rB;
        uint256 bBefore = tokenB.balanceOf(address(this));
        uint256 out = pool.swapPublic(assetA, assetB, 30, 100_000, 0, address(this));
        assertGt(out, 0, "got output");
        assertEq(tokenB.balanceOf(address(this)) - bBefore, out, "B paid out to recipient");
        (,,, uint256 rA2, uint256 rB2,,) = pool.pools(id);
        assertGe(rA2 * rB2, kPre, "constant product non-decrease");

        // ── remove all founder shares → totalShares falls to the MIN_LIQUIDITY floor ──
        uint256 aBefore = tokenA.balanceOf(address(this));
        (uint256 la, uint256 lb) = pool.removeLiquidityPublic(assetA, assetB, 30, sh, address(this));
        assertEq(pool.lpShares(id, address(this)), 0, "shares burned");
        (,,,,,, uint256 ts2) = pool.pools(id);
        assertEq(ts2, 1000, "totalShares == MINIMUM_LIQUIDITY floor (noteless)");
        assertGt(la + lb, 0, "withdrew reserves");
        assertGe(tokenA.balanceOf(address(this)) - aBefore, la, "A returned");
    }

    function test_remove_cannot_breach_min_liquidity() public {
        uint256 sh = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, address(this));
        // attempting to remove MORE than (totalShares - MIN) reverts
        vm.expectRevert(ConfidentialPool.InsufficientLiquidity.selector);
        pool.removeLiquidityPublic(assetA, assetB, 30, sh + 1, address(this));
    }

    function test_proportional_add_to_existing() public {
        pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, address(this));
        bytes32 id = _pid(assetA, assetB, 30);
        (,,,,,, uint256 ts0) = pool.pools(id);
        uint256 sh2 = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 500_000, 500_000, address(this));
        (,,, uint256 rA, uint256 rB,, uint256 ts1) = pool.pools(id);
        assertEq(sh2, ts0 / 2, "in-ratio add mints proportional shares");
        assertEq(rA, 1_500_000); assertEq(rB, 1_500_000);
        assertEq(ts1, ts0 + sh2, "totalShares grew by minted");
    }

    function test_shield_shares_records_pending_deposit() public {
        uint256 sh = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, address(this));
        bytes32 id = _pid(assetA, assetB, 30);
        (,,,,,, uint256 tsBefore) = pool.pools(id);
        bytes32 commit = keccak256("note-commit");
        uint256 n = sh / 2;
        bytes32 depositId = pool.shieldShares(id, n, commit);
        assertEq(pool.lpShares(id, address(this)), sh - n, "public shares burned");
        assertEq(pool.depositStatus(depositId), 1, "pending shielded deposit recorded");
        bytes32 shareAssetId = keccak256(abi.encodePacked(id, "lp"));
        assertEq(depositId, keccak256(abi.encode(shareAssetId, n, commit)), "depositId binds (lpShareId, shares, commit)");
        (,,,,,, uint256 tsAfter) = pool.pools(id);
        assertEq(tsAfter, tsBefore, "totalShares unchanged (position only changes form)");
    }

    function test_shield_more_than_balance_reverts() public {
        uint256 sh = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, address(this));
        bytes32 id = _pid(assetA, assetB, 30);
        vm.expectRevert(ConfidentialPool.InsufficientLiquidity.selector);
        pool.shieldShares(id, sh + 1, keccak256("x"));
    }
}
