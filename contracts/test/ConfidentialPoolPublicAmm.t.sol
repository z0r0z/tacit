// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {PoolStateReader} from "./PoolStateReader.sol";

using PoolStateReader for ConfidentialPool;
import {ERC20} from "solady/tokens/ERC20.sol";

contract MockERC20 is ERC20 {
    function name() public pure override returns (string memory) {
        return "Mock";
    }

    function symbol() public pure override returns (string memory) {
        return "MCK";
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
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
        pool = new ConfidentialPool(
            address(new MockSP1Verifier()),
            bytes32(uint256(0xABCD)),
            bytes32(0),
            address(0),
            address(0),
            bytes32(0),
            6,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        tokenA = new MockERC20();
        tokenB = new MockERC20();
        assetA = pool.registerWrapped(address(tokenA), 1, bytes32(0), "Conf A", "cA", 8); // unitScale 1: value == amount
        assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Conf B", "cB", 8);
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
        uint256 sh = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 4_000_000, 0, 0, address(this));
        bytes32 id = _pid(assetA, assetB, 30);
        (bool init,,, uint256 rA, uint256 rB,, uint256 ts) = pool.pools(id);
        // canonical: reserveA is the LOW asset's reserve
        (uint256 expA, uint256 expB) =
            assetA < assetB ? (uint256(1_000_000), uint256(4_000_000)) : (uint256(4_000_000), uint256(1_000_000));
        assertTrue(init, "pool created");
        assertEq(rA, expA, "reserveA");
        assertEq(rB, expB, "reserveB");
        assertEq(ts, 2_000_000, "totalShares = isqrt(1e6*4e6) = 2e6");
        assertEq(sh, 2_000_000 - 1000, "founder shares = isqrt - MIN_LIQUIDITY");
        assertEq(pool.lpShares(id, address(this)), sh, "public ledger credited");
        assertEq(pool.escrow(assetA), 1_000_000, "escrow A backs reserve");
        assertEq(pool.escrow(assetB), 4_000_000, "escrow B backs reserve");

        // ── public swap A->B (k must not decrease) ──
        uint256 kPre = rA * rB;
        uint256 bBefore = tokenB.balanceOf(address(this));
        // quoteSwap must exactly predict the swap output at the current reserves + expose the poolId.
        assertEq(pool.poolIdFor(assetA, assetB, 30), id, "poolIdFor == pool id");
        uint256 quoted = pool.quoteSwap(assetA, assetB, 30, 100_000);
        uint256 out = pool.swapPublic(assetA, assetB, 30, 100_000, 0, 0, address(this));
        assertEq(quoted, out, "quoteSwap == actual swap output");
        assertGt(out, 0, "got output");
        assertEq(tokenB.balanceOf(address(this)) - bBefore, out, "B paid out to recipient");
        (,,, uint256 rA2, uint256 rB2,,) = pool.pools(id);
        assertGe(rA2 * rB2, kPre, "constant product non-decrease");

        // ── remove all founder shares → totalShares falls to the MIN_LIQUIDITY floor ──
        uint256 aBefore = tokenA.balanceOf(address(this));
        (uint256 la, uint256 lb) =
            pool.removeLiquidityPublicFrom(assetA, assetB, 30, sh, 0, 0, 0, address(this), address(this));
        assertEq(pool.lpShares(id, address(this)), 0, "shares burned");
        (,,,,,, uint256 ts2) = pool.pools(id);
        assertEq(ts2, 1000, "totalShares == MINIMUM_LIQUIDITY floor (noteless)");
        assertGt(la + lb, 0, "withdrew reserves");
        assertGe(tokenA.balanceOf(address(this)) - aBefore, la, "A returned");
    }

    function test_remove_cannot_breach_min_liquidity() public {
        uint256 sh = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, 0, 0, address(this));
        // attempting to remove MORE than (totalShares - MIN) reverts
        vm.expectRevert(ConfidentialPool.InsufficientLiquidity.selector);
        pool.removeLiquidityPublicFrom(assetA, assetB, 30, sh + 1, 0, 0, 0, address(this), address(this));
    }

    function test_remove_liquidity_requires_owner_or_operator() public {
        uint256 sh = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, 0, 0, address(this));
        address operator = address(0x0A11CE);
        address recipient = address(0xB0B);

        vm.prank(operator);
        vm.expectRevert(ConfidentialPool.InsufficientLiquidity.selector);
        pool.removeLiquidityPublicFrom(assetA, assetB, 30, sh / 4, 0, 0, 0, address(this), recipient);

        pool.approveLpOperator(operator);
        uint256 before = tokenA.balanceOf(recipient) + tokenB.balanceOf(recipient);
        vm.prank(operator);
        pool.removeLiquidityPublicFrom(assetA, assetB, 30, sh / 4, 0, 0, 0, address(this), recipient);
        assertEq(pool.lpShares(_pid(assetA, assetB, 30), address(this)), sh - sh / 4, "owner shares debited");
        assertGt(tokenA.balanceOf(recipient) + tokenB.balanceOf(recipient), before, "operator paid recipient");
    }

    function test_proportional_add_to_existing() public {
        pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, 0, 0, address(this));
        bytes32 id = _pid(assetA, assetB, 30);
        (,,,,,, uint256 ts0) = pool.pools(id);
        uint256 sh2 = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 500_000, 500_000, 0, 0, address(this));
        (,,, uint256 rA, uint256 rB,, uint256 ts1) = pool.pools(id);
        assertEq(sh2, ts0 / 2, "in-ratio add mints proportional shares");
        assertEq(rA, 1_500_000);
        assertEq(rB, 1_500_000);
        assertEq(ts1, ts0 + sh2, "totalShares grew by minted");
    }

    /// Router-standard guards on the public periphery: a unix-secs `deadline` (0 = none) and per-action
    /// slippage bounds (minSharesOut on add, minAmountA/B on remove, minAmountOut on swap).
    function test_public_amm_deadline_and_slippage_guards() public {
        pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, 0, 0, address(this));
        bytes32 id = _pid(assetA, assetB, 30);
        vm.warp(1000);

        // deadline: a past expiry reverts on all three public actions (checked first, before any effect)
        vm.expectRevert(ConfidentialPool.Expired.selector);
        pool.swapPublic(assetA, assetB, 30, 1000, 0, 999, address(this));
        vm.expectRevert(ConfidentialPool.Expired.selector);
        pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1000, 1000, 0, 999, address(this));
        vm.expectRevert(ConfidentialPool.Expired.selector);
        pool.removeLiquidityPublicFrom(assetA, assetB, 30, 1000, 0, 0, 999, address(this), address(this));

        // minSharesOut: requiring more LP shares than the add yields reverts (a subsequent add)
        vm.expectRevert(ConfidentialPool.SlippageExceeded.selector);
        pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 500_000, 500_000, type(uint256).max, 0, address(this));

        // minAmount on remove: requiring more underlying than the proportional withdrawal yields reverts
        uint256 sh = pool.lpShares(id, address(this));
        vm.expectRevert(ConfidentialPool.SlippageExceeded.selector);
        pool.removeLiquidityPublicFrom(
            assetA, assetB, 30, sh / 2, type(uint256).max, 0, 0, address(this), address(this)
        );

        // minAmountOut on swap: requiring more output than possible reverts
        vm.expectRevert(ConfidentialPool.SlippageExceeded.selector);
        pool.swapPublic(assetA, assetB, 30, 1000, type(uint256).max, 0, address(this));

        // sanity: the same actions succeed with satisfiable bounds + a future deadline
        uint256 outOk = pool.swapPublic(assetA, assetB, 30, 1000, 1, uint64(block.timestamp + 1), address(this));
        assertGt(outOk, 0, "swap succeeds within deadline + slippage");
    }

    function test_public_amm_native_eth_value_accounting() public {
        bytes32 ethAsset = pool.registerWrapped(address(0), 10 ** 10, bytes32(0), "Conf ETH", "cETH", 18);
        vm.deal(address(this), 10 ether);

        vm.expectRevert(ConfidentialPool.EthValueMismatch.selector);
        pool.createPairAndAddLiquidityPublic{value: 1 ether - 1}(
            ethAsset, assetA, 30, 1 ether, 1_000_000, 0, 0, address(this)
        );

        uint256 sh = pool.createPairAndAddLiquidityPublic{value: 1 ether}(
            ethAsset, assetA, 30, 1 ether, 1_000_000, 0, 0, address(this)
        );
        assertGt(sh, 0, "native pair seeded");
        assertEq(pool.escrow(ethAsset), 1 ether, "ETH leg escrowed");

        vm.expectRevert(ConfidentialPool.EthValueMismatch.selector);
        pool.swapPublic{value: 1 ether}(assetA, ethAsset, 30, 1000, 0, 0, address(this));

        uint256 ethBefore = address(this).balance;
        uint256 outEth = pool.swapPublic(assetA, ethAsset, 30, 1000, 0, 0, address(this));
        assertEq(address(this).balance - ethBefore, outEth, "token->ETH swap pays native output");

        uint256 ethIn = 0.01 ether;
        uint256 tokenBefore = tokenA.balanceOf(address(this));
        uint256 outToken = pool.swapPublic{value: ethIn}(ethAsset, assetA, 30, ethIn, 0, 0, address(this));
        assertEq(tokenA.balanceOf(address(this)) - tokenBefore, outToken, "ETH->token swap pays token output");
    }

    function test_public_amm_zero_recipient_reverts() public {
        pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, 0, 0, address(this));
        vm.expectRevert(ConfidentialPool.ZeroAddress.selector);
        pool.swapPublic(assetA, assetB, 30, 1000, 0, 0, address(0));

        vm.expectRevert(ConfidentialPool.ZeroAddress.selector);
        pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1000, 1000, 0, 0, address(0));

        uint256 sh = pool.lpShares(_pid(assetA, assetB, 30), address(this));
        vm.expectRevert(ConfidentialPool.ZeroAddress.selector);
        pool.removeLiquidityPublicFrom(assetA, assetB, 30, sh / 4, 0, 0, 0, address(this), address(0));
    }

    function test_shield_shares_records_pending_deposit() public {
        uint256 sh = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, 0, 0, address(this));
        bytes32 id = _pid(assetA, assetB, 30);
        (,,,,,, uint256 tsBefore) = pool.pools(id);
        bytes32 commit = keccak256("note-commit");
        uint256 n = sh / 2;
        bytes32 depositId = pool.shieldShares(id, n, commit);
        assertEq(pool.lpShares(id, address(this)), sh - n, "public shares burned");
        assertEq(pool.depositStatus(depositId), 1, "pending shielded deposit recorded");
        bytes32 shareAssetId = keccak256(abi.encodePacked(id, "lp"));
        assertEq(
            depositId, keccak256(abi.encode(shareAssetId, n, commit)), "depositId binds (lpShareId, shares, commit)"
        );
        (,,,,,, uint256 tsAfter) = pool.pools(id);
        assertEq(tsAfter, tsBefore, "totalShares unchanged (position only changes form)");
    }

    function test_shield_more_than_balance_reverts() public {
        uint256 sh = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, 0, 0, address(this));
        bytes32 id = _pid(assetA, assetB, 30);
        vm.expectRevert(ConfidentialPool.InsufficientLiquidity.selector);
        pool.shieldShares(id, sh + 1, keccak256("x"));
    }

    // Hardening regression: removeLiquidityPublic must REVERT cleanly (never underflow) if a confidential LP
    // settle ever drives totalShares below the still-recorded public-share balance. The unchecked floor guard
    // is `shares + MINIMUM_LIQUIDITY > totalShares` (an addition) rather than `totalShares - shares < MIN`,
    // so it can't underflow past the guard into the reserve subtraction. Honest settles keep totalShares ≥
    // Σ public shares + MIN_LIQUIDITY, so this state is only reachable under a compromised/buggy guest.
    function test_remove_liquidity_reverts_when_total_shares_mis_set_below_balance() public {
        uint256 sh = pool.createPairAndAddLiquidityPublic(assetA, assetB, 30, 1_000_000, 1_000_000, 0, 0, address(this));
        bytes32 id = _pid(assetA, assetB, 30);
        assertEq(pool.lpShares(id, address(this)), sh, "public balance recorded");

        // A settle that drops totalShares to the MIN_LIQUIDITY floor (well below the public balance). pre
        // matches the live (1e6, 1e6, 1e6) state; equal reserves sidestep canonical-orientation concerns.
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = ConfidentialPool.LpSettlement(id, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1000);
        pool.settle(abi.encode(pv), "", new bytes[](0));
        (,,,,,, uint256 ts) = pool.pools(id);
        assertEq(ts, 1000, "totalShares now below the public balance");

        // Removing the full public balance: totalShares - shares would underflow; the addition-form guard
        // reverts at the floor check instead — no reserve subtraction, no payout, no drain.
        vm.expectRevert(ConfidentialPool.InsufficientLiquidity.selector);
        pool.removeLiquidityPublicFrom(assetA, assetB, 30, sh, 0, 0, 0, address(this), address(this));
    }
}
