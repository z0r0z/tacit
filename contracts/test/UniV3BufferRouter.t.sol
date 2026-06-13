// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {UniV3BufferRouter, ISwapRouter} from "../src/UniV3BufferRouter.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
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

/// Mock Uniswap V3 SwapRouter: exact-output single hop. amountIn = amountOut * rateNum/rateDen (tETH per
/// cBTC); reverts past amountInMaximum; pulls amountIn from the caller (the adapter), sends amountOut from
/// its cBTC inventory to the recipient.
contract MockSwapRouter is ISwapRouter {
    uint256 public rateNum;
    uint256 public rateDen;
    constructor(uint256 n, uint256 d) { rateNum = n; rateDen = d; }
    function exactOutputSingle(ExactOutputSingleParams calldata p) external returns (uint256 amountIn) {
        amountIn = p.amountOut * rateNum / rateDen;
        require(amountIn <= p.amountInMaximum, "maxIn");
        MockERC20(p.tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(p.tokenOut).transfer(p.recipient, p.amountOut);
    }
}

contract UniV3BufferRouterTest is Test {
    MockERC20 teth;
    MockERC20 cbtc;
    MockSwapRouter venue;
    UniV3BufferRouter router;
    address buffer = address(0xB0FF);

    function setUp() public {
        teth = new MockERC20();
        cbtc = new MockERC20();
        venue = new MockSwapRouter(15, 1); // 15 tETH wei per 1 cBTC unit
        router = new UniV3BufferRouter(address(venue));
        cbtc.mint(address(venue), 1_000_000); // venue inventory
    }

    /// The buffer flow: approve maxIn, the adapter buys EXACTLY amountOut, spends only what the venue
    /// needed, and refunds the rest to the buffer.
    function test_buyExactCbtc_exact_output_and_refund() public {
        uint256 amountOut = 100;
        uint256 fair = amountOut * 15; // 1500
        uint256 maxIn = fair * 105 / 100; // 1575 (5% slippage room)
        teth.mint(buffer, maxIn);

        vm.startPrank(buffer);
        teth.approve(address(router), maxIn);
        uint256 spent = router.buyExactCbtc(address(teth), address(cbtc), amountOut, maxIn, buffer, abi.encode(uint24(3000)));
        vm.stopPrank();

        assertEq(spent, fair, "spent == venue price");
        assertEq(cbtc.balanceOf(buffer), amountOut, "buffer got exactly amountOut cBTC");
        assertEq(teth.balanceOf(buffer), maxIn - fair, "unspent tETH refunded to the buffer");
        assertEq(teth.balanceOf(address(router)), 0, "adapter holds no residual tETH");
        assertEq(teth.allowance(address(router), address(venue)), 0, "allowance reset");
    }

    /// A venue price above maxIn reverts (the buffer's slippage bound holds end-to-end).
    function test_respects_maxIn() public {
        uint256 amountOut = 100;
        uint256 maxIn = 100; // far below 100*15
        teth.mint(buffer, maxIn);
        vm.startPrank(buffer);
        teth.approve(address(router), maxIn);
        vm.expectRevert(bytes("maxIn"));
        router.buyExactCbtc(address(teth), address(cbtc), amountOut, maxIn, buffer, abi.encode(uint24(3000)));
        vm.stopPrank();
    }

    /// Exact-fill (venue price == maxIn) leaves no refund and no residual.
    function test_exact_fill_no_refund() public {
        uint256 amountOut = 10;
        uint256 maxIn = amountOut * 15; // exactly fair
        teth.mint(buffer, maxIn);
        vm.startPrank(buffer);
        teth.approve(address(router), maxIn);
        uint256 spent = router.buyExactCbtc(address(teth), address(cbtc), amountOut, maxIn, buffer, abi.encode(uint24(500)));
        vm.stopPrank();
        assertEq(spent, maxIn, "spent all of maxIn");
        assertEq(teth.balanceOf(buffer), 0, "no refund");
        assertEq(cbtc.balanceOf(buffer), amountOut, "got amountOut");
    }
}
