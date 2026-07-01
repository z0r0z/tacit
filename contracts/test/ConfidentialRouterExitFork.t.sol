// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";

/// Minimal subset of the verified zRouter (0x000000000000FB114709235f1ccBFfb925F600e4) this test ABI-encodes
/// calldata against. `swapV2` PULLS the input from the caller (the executor escrow, via the approval the
/// executor set) when zRouter holds no transient credit: `safeTransferFrom(tokenIn, msg.sender, pool, amountIn)`.
/// The V2 pool sends the output directly to `to`. This is the recipe call's `push == false` (APPROVE) mode.
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
}

/// Live Aave V3 Pool: supply(asset, amount, onBehalfOf, referralCode) pulls `amount` of `asset` (via the
/// caller's approval) and mints aTokens to `onBehalfOf`. This is a recipe call's `push == false` mode (Aave
/// pulls via transferFrom), with the supply landing aWETH directly on `finalRecipient`.
interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
}

interface IERC20Mini {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// Swap helper with a FIXED address (deployed once), so the recipe can name it without the calldata/escrow
/// fixed-point. The executor escrow PUSHES `amountIn` of `tokenIn` into this helper (recipe call push == true),
/// which approves zRouter and runs swapV2 with `to == address(this)` (the helper), then forwards the swap
/// output back to its caller (the escrow). This pins the swap output at the escrow without naming it.
contract SwapHelper {
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;

    function swapToCaller(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut) external {
        IERC20Mini(tokenIn).approve(ZROUTER, amountIn);
        (, uint256 amountOut) =
            IZRouter(ZROUTER).swapV2(address(this), false, tokenIn, tokenOut, amountIn, minOut, type(uint256).max);
        IERC20Mini(tokenOut).transfer(msg.sender, amountOut);
    }
}

/// Minimal pool implementing only what `exitAndExecute` touches:
///   • assets(bytes32) — returns (registered=true, …)
///   • settle(...) — NO-OP. The exit funds are simulated by deal-ing USDC straight to the recipe escrow, so the
///     executor finds them exactly as a real settle would have left them.
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

/// MAINNET-FORK test: drives `ConfidentialRouter.exitAndExecute` against REAL mainnet contracts in ONE recipe
/// batch — shielded exit USDC → (1) zRouter swapV2 USDC→WETH → (2) Aave V3 supply(WETH) on-behalf-of the final
/// recipient → finalRecipient receives aWETH. "Anything Railgun can do," on live state.
contract ConfidentialRouterExitForkTest is Test {
    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant AWETH = 0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8;

    address constant FINAL = address(0xF1A11Ec191E27);

    ConfidentialRouter router;
    MockExitPool pool;
    bool forked;

    function setUp() public {
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

        require(ZROUTER.code.length != 0, "zRouter not deployed on fork");
        require(AAVE_V3_POOL.code.length != 0, "Aave V3 Pool not deployed on fork");

        pool = new MockExitPool(USDC);
        router = new ConfidentialRouter(address(pool), ZROUTER, PERMIT2);
    }

    /// Shielded exit → swap → Aave deposit, one tx, on live state.
    function test_exitAndExecute_swap_then_aaveSupply_liveMainnet() public {
        if (!forked) {
            vm.skip(true);
            return;
        }

        uint256 amountIn = 5_000e6; // 5,000 USDC exited

        // Aave's supply() pulls a FIXED amount, so we supply a conservative floor (>= minOut) and sweep residual
        // WETH. wethSupply = the swap minOut floor; the swap yields more, the remainder is swept as WETH.
        uint256 wethMinOut = 0.5 ether; // floor on the USDC->WETH swap output
        uint256 wethSupply = wethMinOut;

        SwapHelper helper = new SwapHelper();

        // Step 1: PUSH USDC to the fixed-address helper, which swaps USDC->WETH on zRouter and forwards the WETH
        // back to its caller (the escrow). Naming the FIXED helper (not the escrow) avoids the calldata/escrow
        // fixed-point. (push == true ⇒ the executor transfers the USDC to the helper first.)
        ConfidentialRouter.ExitCall[] memory calls = new ConfidentialRouter.ExitCall[](2);
        calls[0] = ConfidentialRouter.ExitCall({
            target: address(helper),
            value: 0,
            token: USDC,
            amount: amountIn,
            push: true,
            data: abi.encodeCall(SwapHelper.swapToCaller, (USDC, WETH, amountIn, wethMinOut))
        });
        // Step 2: Aave V3 supply(WETH, wethSupply, FINAL, 0) — approve WETH to the Aave pool; aWETH minted to FINAL.
        calls[1] = ConfidentialRouter.ExitCall({
            target: AAVE_V3_POOL,
            value: 0,
            token: WETH,
            amount: wethSupply,
            push: false,
            data: abi.encodeCall(IAaveV3Pool.supply, (WETH, wethSupply, FINAL, 0))
        });

        // Sweep residual WETH (swap output beyond what was supplied) to FINAL. aWETH is already on FINAL.
        address[] memory sweeps = new address[](1);
        sweeps[0] = WETH;
        uint256[] memory mins = new uint256[](1);
        mins[0] = 0;

        ConfidentialRouter.ExitRecipe memory recipe = ConfidentialRouter.ExitRecipe({
            exitedAsset: bytes32(uint256(1)),
            feeAsset: address(0),
            finalRecipient: FINAL,
            deadline: uint64(block.timestamp + 1 hours),
            nonce: 1,
            calls: calls,
            sweepTokens: sweeps,
            minOuts: mins
        });

        address escrow = router.escrowAddressFor(recipe);

        // Simulate the exit: deal REAL USDC to the recipe-bound escrow.
        deal(USDC, escrow, amountIn);

        uint256 aWethBefore = IERC20Mini(AWETH).balanceOf(FINAL);

        router.exitAndExecute(hex"", hex"", new bytes[](0), recipe);

        uint256 aWethAfter = IERC20Mini(AWETH).balanceOf(FINAL);
        console2.log("aWETH received by finalRecipient:", aWethAfter - aWethBefore);
        console2.log("residual WETH swept to finalRecipient:", IERC20Mini(WETH).balanceOf(FINAL));

        assertGt(aWethAfter - aWethBefore, 0, "finalRecipient received aWETH from the Aave supply");
        // Nothing rests in the router or escrow.
        assertEq(IERC20Mini(USDC).balanceOf(address(router)), 0, "router holds USDC");
        assertEq(IERC20Mini(WETH).balanceOf(address(router)), 0, "router holds WETH");
        assertEq(IERC20Mini(USDC).balanceOf(escrow), 0, "escrow holds USDC");
        assertEq(IERC20Mini(WETH).balanceOf(escrow), 0, "escrow holds WETH");
    }
}
