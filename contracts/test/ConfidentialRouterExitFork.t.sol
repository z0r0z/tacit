// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";

/// Minimal subset of zRouter (verified at 0x000000000000FB114709235f1ccBFfb925F600e4) that this test builds
/// REAL calldata against. Both methods are exercised on the live mainnet contract via low-level calls from the
/// router — these declarations are only used to ABI-encode the calldata.
///
/// FUNDING MODELS (read off the verified source):
///   • swapVZ / swapV2 (PULL): when zRouter holds no transient credit it does
///     `safeTransferFrom(tokenIn, msg.sender, pool, amountIn)` — i.e. it PULLS the input from the caller via
///     the caller's ERC20 allowance. The output token is sent by the V2 pool directly to `to`. This is the
///     router's `pushInput == false` (APPROVE) mode.
///   • snwap (PUSH/conduit): with `amountIn == 0` and a non-zero `tokenIn`, zRouter forwards its OWN balance
///     (`bal - 1`) of `tokenIn` to the `executor`, then sandbox-calls `executor`/`executorData`; the output is
///     measured as the `recipient`'s `tokenOut` balance delta. zRouter never transferFrom's the caller, so the
///     caller must have PUSHED the input to zRouter first. This is the router's `pushInput == true` mode.
interface IZRouter {
    function swapV2(
        address to,
        bool exactOut,
        address tokenIn,
        address tokenOut,
        uint256 swapAmount,
        uint256 amountLimit,
        uint256 deadline
    ) external payable returns (uint256 amountIn, uint256 amountOut);

    function snwap(
        address tokenIn,
        uint256 amountIn,
        address recipient,
        address tokenOut,
        uint256 amountOutMin,
        address executor,
        bytes calldata executorData
    ) external payable returns (uint256 amountOut);
}

interface IERC20Mini {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// Live Uniswap V2 router — the external venue the PUSH (snwap) conduit routes through. The snwap executor is a
/// throwaway contract that, when sandbox-called by zRouter, swaps the USDC zRouter pushed into it to WETH and
/// sends the WETH to `recipient` (the ConfidentialRouter). This proves the push funding end-to-end against the
/// real zRouter, without zRouter ever pulling from the caller.
interface IUniV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// The snwap executor. zRouter pushes USDC into this contract, then sandbox-calls `run(...)`, which swaps the
/// received USDC to WETH via the live Uniswap V2 router and forwards the WETH to `recipient`.
contract SnwapExecutor {
    address constant UNIV2 = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

    function run(address tokenIn, address tokenOut, address recipient) external {
        uint256 bal = IERC20Mini(tokenIn).balanceOf(address(this));
        IERC20Mini(tokenIn).approve(UNIV2, bal);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        IUniV2Router(UNIV2).swapExactTokensForTokens(bal, 0, path, recipient, block.timestamp + 1);
    }
}

/// Minimal pool implementing only the `IConfidentialPool` surface `ConfidentialRouter.exitAndCall` touches:
///   • `assets(bytes32)` — returns (registered=true, underlying=USDC, unitScale=1, link=0, poolMinted=false, 6)
///   • `settle(...)` — NO-OP. The exit funds are simulated by `deal`-ing USDC straight to the recipe escrow,
///     so the router's escrow sweep finds them exactly as a real settle would have left them.
contract MockExitPool {
    address public immutable USDC;

    constructor(address usdc) {
        USDC = usdc;
    }

    function assets(bytes32)
        external
        view
        returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals)
    {
        return (true, USDC, 1, bytes32(0), false, 6);
    }

    function settle(bytes calldata, bytes calldata, bytes[] calldata) external {}
}

/// MAINNET-FORK test: drives `ConfidentialRouter.exitAndCall` against the REAL zRouter, proving BOTH funding
/// paths work on live mainnet state — (a) PULL via `swapV2` (zRouter transferFrom's the router) and (b) PUSH
/// via `snwap` (router pushes USDC to zRouter, which routes it from its own balance through an executor).
contract ConfidentialRouterExitForkTest is Test {
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    address constant FINAL = address(0xF1A11Ec191E27);

    ConfidentialRouter router;
    MockExitPool pool;
    bool forked;

    function setUp() public {
        // Keyless public RPCs, in order. Pin a recent block for cache/determinism; fall through on failure.
        // Fork at HEAD: the free public endpoints serve only recent state (archive reads at an old pinned
        // block 403), so we take the latest block each runs. The test is balance-delta based, so head is fine.
        string[5] memory rpcs = [
            "https://eth.drpc.org",
            "https://rpc.ankr.com/eth",
            "https://cloudflare-eth.com",
            "https://ethereum-rpc.publicnode.com",
            "https://eth.llamarpc.com"
        ];
        for (uint256 i; i < rpcs.length; ++i) {
            try vm.createSelectFork(rpcs[i]) {
                forked = true;
                console2.log("forked (head) via:", rpcs[i]);
                break;
            } catch {
                console2.log("rpc failed:", rpcs[i]);
            }
        }
        if (!forked) {
            console2.log("ALL public RPCs failed/ratelimited - skipping fork test");
            return;
        }

        // Sanity: the zRouter must actually be present on the forked chain.
        require(ZROUTER.code.length != 0, "zRouter not deployed on fork");

        pool = new MockExitPool(USDC);
        // ConfidentialRouter(pool, zRouter, permit2)
        router = new ConfidentialRouter(address(pool), ZROUTER, PERMIT2);
    }

    function _recipe(uint256 minOut, uint256 nonce, bool pushInput, bytes memory z)
        internal
        view
        returns (ConfidentialRouter.ExitRecipe memory)
    {
        return ConfidentialRouter.ExitRecipe({
            exitedAsset: bytes32(uint256(1)), // any id; the mock pool maps every id to USDC
            tokenOut: WETH,
            minOut: minOut,
            finalRecipient: FINAL,
            deadline: uint64(block.timestamp + 1 hours),
            nonce: nonce,
            feeAsset: address(0), // no relay fee leg (self-submit); the no-op settle forwards nothing
            pushInput: pushInput,
            zCalldata: z
        });
    }

    // ──────────────────── (a) PULL / swap case: zRouter swapV2 transferFrom's the router ────────────────────

    function test_exitAndCall_pull_swapV2_liveZRouter() public {
        if (!forked) {
            vm.skip(true);
            return;
        }

        uint256 amountIn = 5_000e6; // 5,000 USDC exited

        // PULL calldata: zRouter pulls `amountIn` USDC from the router (its standing approval) and routes
        // USDC->WETH on Uniswap V2, sending the WETH straight to the router (`to = router`).
        bytes memory z = abi.encodeCall(
            IZRouter.swapV2,
            (address(router), false, USDC, WETH, amountIn, 0, type(uint256).max)
        );

        ConfidentialRouter.ExitRecipe memory recipe = _recipe(0.5 ether, 1, false, z);

        // Simulate the exit: the real settle would have unwrapped USDC to the recipe-bound escrow. We deal the
        // REAL USDC straight there.
        address escrow = router.escrowAddressFor(recipe);
        deal(USDC, escrow, amountIn);

        uint256 finalWethBefore = IERC20Mini(WETH).balanceOf(FINAL);

        uint256 out = router.exitAndCall(hex"", hex"", new bytes[](0), recipe);

        uint256 finalWethAfter = IERC20Mini(WETH).balanceOf(FINAL);
        console2.log("[PULL] WETH delivered to finalRecipient:", finalWethAfter - finalWethBefore);

        assertGe(out, recipe.minOut, "pull: output below minOut");
        assertEq(finalWethAfter - finalWethBefore, out, "pull: finalRecipient WETH != routed out");
        assertGe(finalWethAfter - finalWethBefore, recipe.minOut, "pull: delivered < minOut");

        // Nothing rests in the router.
        assertEq(IERC20Mini(USDC).balanceOf(address(router)), 0, "pull: router holds USDC");
        assertEq(IERC20Mini(WETH).balanceOf(address(router)), 0, "pull: router holds WETH");
    }

    // ──────────────────── (b) PUSH / conduit case: zRouter snwap routes from its own balance ────────────────

    function test_exitAndCall_push_snwap_liveZRouter() public {
        if (!forked) {
            vm.skip(true);
            return;
        }

        uint256 amountIn = 5_000e6; // 5,000 USDC exited

        SnwapExecutor executor = new SnwapExecutor();

        // PUSH calldata: snwap with amountIn == 0 ⇒ zRouter forwards its OWN USDC balance (the amount the
        // router pushed in) to `executor`, sandbox-calls executor.run(...), and measures the WETH delta at
        // `recipient` (the router). zRouter never transferFrom's the caller — this is the push funding model.
        bytes memory executorData =
            abi.encodeCall(SnwapExecutor.run, (USDC, WETH, address(router)));
        bytes memory z = abi.encodeCall(
            IZRouter.snwap,
            (USDC, uint256(0), address(router), WETH, uint256(0), address(executor), executorData)
        );

        ConfidentialRouter.ExitRecipe memory recipe = _recipe(0.5 ether, 2, true, z);

        address escrow = router.escrowAddressFor(recipe);
        deal(USDC, escrow, amountIn);

        uint256 finalWethBefore = IERC20Mini(WETH).balanceOf(FINAL);

        uint256 out = router.exitAndCall(hex"", hex"", new bytes[](0), recipe);

        uint256 finalWethAfter = IERC20Mini(WETH).balanceOf(FINAL);
        console2.log("[PUSH] WETH delivered to finalRecipient:", finalWethAfter - finalWethBefore);

        assertGe(out, recipe.minOut, "push: output below minOut");
        assertEq(finalWethAfter - finalWethBefore, out, "push: finalRecipient WETH != routed out");
        assertGe(finalWethAfter - finalWethBefore, recipe.minOut, "push: delivered < minOut");

        assertEq(IERC20Mini(USDC).balanceOf(address(router)), 0, "push: router holds USDC");
        assertEq(IERC20Mini(WETH).balanceOf(address(router)), 0, "push: router holds WETH");
    }
}
