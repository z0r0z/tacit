// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {ConfidentialZapRouter} from "../src/ConfidentialZapRouter.sol";
import {StubVerifier, MockUSDC} from "./ConfidentialWrapRouter.t.sol";

/// Stand-in for zRouter: takes ETH (msg.value == swapAmount) and mints `out = value*RATE/1e18` of TOK to
/// `to` — simulating sourcing the other LP leg from external liquidity, with the output forced to the caller.
contract MockZRouter {
    address public immutable TOK;
    uint256 public immutable RATE; // TOK out per wei in, scaled 1e18

    constructor(address tok, uint256 rate) {
        TOK = tok;
        RATE = rate;
    }

    function swapV2(address to, bool, address, address tokenOut, uint256 swapAmount, uint256 amountLimit, uint256)
        external
        payable
        returns (uint256, uint256)
    {
        require(tokenOut == TOK, "wrong out");
        require(msg.value == swapAmount, "value != swapAmount");
        uint256 out = (msg.value * RATE) / 1e18;
        require(out >= amountLimit, "slippage");
        MockUSDC(TOK).mint(to, out);
        return (msg.value, out);
    }
}

contract ConfidentialZapRouterTest is Test {
    ConfidentialPool pool;
    ConfidentialZapRouter zap;
    MockUSDC tokenB;
    MockZRouter zr;
    bytes32 tethId;
    bytes32 tokenBId;

    address constant user = address(0xA11CE);
    uint32 constant FEE_BPS = 30;
    bytes32 constant TETH_LINK = bytes32(uint256(0x7e74));

    function setUp() public {
        vm.chainId(1);
        pool = new ConfidentialPool(
            address(new StubVerifier()),
            bytes32(uint256(0xABCD)),
            bytes32(0),
            address(0),
            address(0),
            bytes32(0),
            0,
            bytes32(0),
            TETH_LINK, // registers native ETH (tETH)
            address(0)
        );
        tokenB = new MockUSDC();
        tokenBId = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Tok B", "TOKB", 6);
        tethId = _evmAssetId(address(0));
        zr = new MockZRouter(address(tokenB), 2e6); // 0.5 ETH (5e17 wei) -> 1e6 TOKB
        zap = new ConfidentialZapRouter(address(pool), address(zr));
    }

    /// The zRouter swap calldata the dapp would build (here MockZRouter.swapV2): swap `ethToSwap` of ETH to
    /// tokenB, output to `to`.
    function _zrSwapData(address to, uint256 ethToSwap, uint64 deadline) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            MockZRouter.swapV2.selector, to, false, address(0), address(tokenB), ethToSwap, uint256(0), uint256(deadline)
        );
    }

    function _evmAssetId(address u) internal view returns (bytes32) {
        return sha256(abi.encodePacked(bytes18(0x74616369742d65766d2d746f6b656e2d7631), uint64(block.chainid), u));
    }

    function _poolId(bytes32 a, bytes32 b, uint32 feeBps) internal pure returns (bytes32) {
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encodePacked(lo, hi, uint256(feeBps)));
    }

    function test_zapETHIntoLP_coldStartSeedsPool() public {
        vm.deal(user, 2 ether);
        uint256 ethToSwap = 0.5 ether;
        uint64 deadline = uint64(block.timestamp + 1 hours);

        vm.prank(user);
        uint256 shares = zap.zapETHIntoLP{value: 1 ether}(
            address(tokenB), FEE_BPS, ethToSwap, 0, deadline, user, _zrSwapData(address(zap), ethToSwap, deadline)
        );

        assertGt(shares, 0, "LP shares minted");
        assertEq(pool.lpShares(_poolId(tethId, tokenBId, FEE_BPS), user), shares, "shares credited to the user");
        // first add takes both legs fully: remaining ETH (0.5) escrowed as tETH; 1e6 TOKB sourced from zRouter
        assertEq(pool.escrow(tethId), 0.5 ether, "tETH leg escrowed (remaining ETH)");
        assertEq(pool.escrow(tokenBId), 1e6, "tokenB leg escrowed (zRouter-sourced)");
        // user spent exactly 1 ETH; the router holds nothing
        assertEq(user.balance, 1 ether, "user spent 1 ETH (started with 2)");
        assertEq(address(zap).balance, 0, "zap holds no ETH");
        assertEq(tokenB.balanceOf(address(zap)), 0, "zap holds no tokenB");
    }

    function test_zapETHIntoLP_revertsIfSwapExceedsValue() public {
        vm.deal(user, 1 ether);
        vm.prank(user);
        vm.expectRevert(); // ethToSwap > msg.value → underflow on remainingEth (before the zRouter call)
        zap.zapETHIntoLP{value: 1 ether}(address(tokenB), FEE_BPS, 2 ether, 0, uint64(block.timestamp + 1 hours), user, hex"");
    }

    function test_zapETHIntoLP_laterAdd_refundsOffRatioDust() public {
        // seed a pool first (this contract), so the user's zap is a proportional later add that can refund.
        // seed ratio tETH:TOKB = 0.5 ETH (value 5e7) : 1e6  → same ratio the cold-start above produced.
        vm.deal(address(this), 1 ether);
        tokenB.mint(address(this), 1e6);
        tokenB.approve(address(pool), type(uint256).max);
        pool.createPairAndAddLiquidityPublic{value: 0.5 ether}(tethId, tokenBId, FEE_BPS, 0.5 ether, 1e6, 0, 0, address(this));

        // user zaps 1 ETH, swapping 0.5 ETH → 1e6 TOKB. The remaining 0.5 ETH (value 5e7) + 1e6 TOKB match the
        // pool ratio exactly, so a balanced later add → no refund. (Off-ratio handling is exercised by the
        // wrap-router LP test; here we assert the later-add path itself works through the zap + sweeps clean.)
        vm.deal(user, 2 ether);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.prank(user);
        uint256 shares = zap.zapETHIntoLP{value: 1 ether}(
            address(tokenB), FEE_BPS, 0.5 ether, 0, deadline, user, _zrSwapData(address(zap), 0.5 ether, deadline)
        );

        assertGt(shares, 0, "shares minted on later add");
        assertEq(address(zap).balance, 0, "zap holds no ETH after");
        assertEq(tokenB.balanceOf(address(zap)), 0, "zap holds no tokenB after");
        // user spent ~1 ETH (balanced add → negligible/no refund)
        assertLe(user.balance, 1 ether, "user spent up to 1 ETH");
    }

    // ──────────────────── Confidential-output zaps ────────────────────

    function _lpShareId(bytes32 poolId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(poolId, bytes2(0x6c70))); // keccak(poolId ‖ "lp")
    }

    function _isqrt(uint256 x) internal pure returns (uint256 y) {
        unchecked {
            uint256 z = (x + 1) / 2;
            y = x;
            while (z < y) {
                y = z;
                z = (x / z + z) / 2;
            }
        }
    }

    /// Minimal self-proved settle that consumes the LP-share deposit + inserts the farm-receipt leaf — the
    /// orchestration the bond pv performs (the real OP_LP_BOND cdpMint is the dapp's; the mock verifier
    /// accepts any proof, so this isolates the zap→shield→settle composition).
    function _bondPv(bytes32 depositId, bytes32 leaf) internal view returns (bytes memory) {
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.depositsConsumed = new bytes32[](1);
        pv.depositsConsumed[0] = depositId;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = leaf;
        return abi.encode(pv);
    }

    function test_zapETHIntoShieldedLP_givesConfidentialNoteDeposit() public {
        vm.deal(user, 2 ether);
        uint256 ethLeg = 0.5 ether;
        uint256 tokenBLeg = 1e6;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 commit = keccak256("recipient-lp-note");

        vm.prank(user);
        (bytes32 depositId, uint256 shares) = zap.zapETHIntoShieldedLP{value: 1 ether}(
            address(tokenB), FEE_BPS, ethLeg, tokenBLeg, 0, deadline, commit, _zrSwapData(address(zap), 0.5 ether, deadline)
        );

        assertGt(shares, 0, "shares minted");
        bytes32 poolId = _poolId(tethId, tokenBId, FEE_BPS);
        // CONFIDENTIAL output: a pending LP-share-NOTE deposit bound to commit — NOT a public lpShares balance
        assertEq(uint256(pool.depositStatus(depositId)), 1, "pending LP-share-note deposit");
        assertEq(depositId, keccak256(abi.encode(_lpShareId(poolId), shares, commit)), "depositId binds lpShareId+shares+commit");
        assertEq(pool.lpShares(poolId, address(zap)), 0, "router shielded all its shares");
        assertEq(pool.lpShares(poolId, user), 0, "user got NO public shares (output is confidential)");
        assertEq(address(zap).balance, 0, "zap holds no ETH");
        assertEq(tokenB.balanceOf(address(zap)), 0, "zap holds no tokenB");
    }

    function test_zapETHIntoFarm_zapsShieldsThenBonds() public {
        vm.deal(user, 2 ether);
        uint256 ethLeg = 0.5 ether;
        uint256 tokenBLeg = 1e6;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 commit = keccak256("farmer-lp-note");

        // deterministic shares (exact legs) ⇒ the dapp pre-derives the LP-share-note deposit id for the bond pv
        uint256 shares = _isqrt((ethLeg / 1e10) * tokenBLeg) - 1000;
        bytes32 poolId = _poolId(tethId, tokenBId, FEE_BPS);
        bytes32 depositId = keccak256(abi.encode(_lpShareId(poolId), shares, commit));
        bytes[] memory memos = new bytes[](1);
        memos[0] = abi.encodePacked(bytes32("eph"), bytes32("ct"));

        vm.prank(user);
        uint256 minted = zap.zapETHIntoFarm{value: 1 ether}(
            address(tokenB), FEE_BPS, ethLeg, tokenBLeg, 0, deadline, commit,
            _zrSwapData(address(zap), 0.5 ether, deadline), _bondPv(depositId, keccak256("farm-receipt")), hex"", memos
        );

        assertEq(minted, shares, "deterministic shares matched the pre-derived bond pv");
        assertEq(uint256(pool.depositStatus(depositId)), 2, "LP-share deposit consumed by the bond settle");
        assertEq(pool.nextLeafIndex(), 1, "farm-receipt leaf inserted by the settle");
        assertEq(address(zap).balance, 0, "zap holds no ETH");
        assertEq(tokenB.balanceOf(address(zap)), 0, "zap holds no tokenB");
    }

    receive() external payable {}
}
