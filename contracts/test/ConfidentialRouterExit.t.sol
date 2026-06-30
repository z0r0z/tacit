// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {ConfidentialRouter, ExitExecutor} from "../src/ConfidentialRouter.sol";

/// Minimal SP1 verifier stub — the mock accepts any proof so the test isolates the router's batch
/// orchestration from proving.
contract StubVerifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external view {}
}

/// 6-decimal ERC20 used as the exited (escrow-backed) asset and route tokens.
contract MockToken is ERC20 {
    string private _name;
    string private _symbol;

    constructor(string memory n, string memory s) {
        _name = n;
        _symbol = s;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// zRouter stand-in. `swapTokenForToken` PULLS `inAmount` of `tokenIn` from the caller (the escrow, via the
/// approval the executor set) and mints `outAmount` of `tokenOut` to the escrow. `executeFromBalance` is the
/// PUSH/conduit shape: it asserts the input was already pushed to it (no transferFrom) before minting the
/// output. `swapETHForToken` consumes the forwarded ETH and mints the output. `swapTokenForETH` pulls the
/// input and sends native ETH back.
contract MockZRouterExit {
    // Output goes to msg.sender (the escrow / caller), so the recipe calldata never names the escrow — avoiding
    // the fixed-point problem where the escrow address depends on a hash that includes the calldata.
    function swapTokenForToken(address tokenIn, uint256 inAmount, address tokenOut, uint256 outAmount) external {
        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), inAmount);
        MockToken(tokenOut).mint(msg.sender, outAmount);
    }

    function executeFromBalance(address tokenIn, uint256 amountIn, address tokenOut, uint256 outAmount) external {
        require(SafeTransferLib.balanceOf(tokenIn, address(this)) >= amountIn, "push: input not received");
        MockToken(tokenOut).mint(msg.sender, outAmount);
    }

    function swapETHForToken(address tokenOut, uint256 outAmount) external payable {
        MockToken(tokenOut).mint(msg.sender, outAmount);
    }

    function swapTokenForETH(address tokenIn, uint256 inAmount, uint256 outAmount) external {
        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), inAmount);
        SafeTransferLib.safeTransferETH(msg.sender, outAmount);
    }

    receive() external payable {}
}

contract ConfidentialRouterExitTest is Test {
    ConfidentialPool pool;
    ConfidentialRouter router;
    MockZRouterExit zr;
    MockZRouterExit zr2; // second mock for a multi-step batch
    MockToken usdc; // the exited (escrow-backed) asset
    MockToken mid; // an intermediate token in a multi-step batch
    MockToken tokenOut; // the route output
    bytes32 assetId;
    bytes32 tEthAssetId;

    address constant FINAL = address(0xF1A1);
    address constant SEEDER = address(0x5EED);
    address constant RELAYER = address(0xBEEF);

    uint256 constant TETH_SCALE = 10 ** 10;

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
            bytes32(uint256(0xE74)),
            address(0)
        );

        usdc = new MockToken("USD Coin", "USDC");
        assetId = pool.registerWrapped(address(usdc), 1, bytes32(0), "USD Coin", "USDC", 6);
        tEthAssetId = _evmAssetId(address(0));

        zr = new MockZRouterExit();
        zr2 = new MockZRouterExit();
        router = new ConfidentialRouter(address(pool), address(zr), address(pool));

        mid = new MockToken("Mid", "MID");
        tokenOut = new MockToken("Out", "OUT");

        vm.deal(address(zr), 100 ether);
    }

    // ──────────────────── helpers ────────────────────

    function _evmAssetId(address underlying) internal view returns (bytes32) {
        return sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), underlying));
    }

    function _seedEscrow(uint256 amount) internal {
        usdc.mint(SEEDER, amount);
        vm.startPrank(SEEDER);
        usdc.approve(address(pool), type(uint256).max);
        pool.wrap(assetId, amount, keccak256("seed-commit"));
        vm.stopPrank();
    }

    function _seedEthEscrow(uint256 amountWei) internal {
        vm.deal(SEEDER, amountWei);
        vm.prank(SEEDER);
        pool.wrap{value: amountWei}(tEthAssetId, amountWei, keccak256("seed-eth-commit"));
    }

    function _exitPvAsset(bytes32 aid, uint256 value, address recipient) internal view returns (bytes memory) {
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal({assetId: aid, value: value, recipient: recipient});
        return abi.encode(pv);
    }

    function _exitPvWithFee(bytes32 aid, uint256 value, address recipient, bytes32 feeAssetId, uint256 feeValue)
        internal
        view
        returns (bytes memory)
    {
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal({assetId: aid, value: value, recipient: recipient});
        pv.fees = new ConfidentialPool.FeePayment[](1);
        pv.fees[0] = ConfidentialPool.FeePayment({assetId: feeAssetId, value: feeValue});
        return abi.encode(pv);
    }

    function _exitPv(uint256 value, address recipient) internal view returns (bytes memory) {
        return _exitPvAsset(assetId, value, recipient);
    }

    function _recipe(
        bytes32 exitedAsset,
        address feeAsset,
        address finalRecipient,
        uint64 deadline,
        uint256 nonce,
        ConfidentialRouter.ExitCall[] memory calls,
        address[] memory sweepTokens,
        uint256[] memory minOuts
    ) internal pure returns (ConfidentialRouter.ExitRecipe memory) {
        return ConfidentialRouter.ExitRecipe({
            exitedAsset: exitedAsset,
            feeAsset: feeAsset,
            finalRecipient: finalRecipient,
            deadline: deadline,
            nonce: nonce,
            calls: calls,
            sweepTokens: sweepTokens,
            minOuts: minOuts
        });
    }

    function _one(ConfidentialRouter.ExitCall memory c) internal pure returns (ConfidentialRouter.ExitCall[] memory a) {
        a = new ConfidentialRouter.ExitCall[](1);
        a[0] = c;
    }

    function _addrs(address a) internal pure returns (address[] memory x) {
        x = new address[](1);
        x[0] = a;
    }

    function _uints(uint256 a) internal pure returns (uint256[] memory x) {
        x = new uint256[](1);
        x[0] = a;
    }

    function _fut() internal view returns (uint64) {
        return uint64(block.timestamp + 1 hours);
    }

    // ──────────────────── 1. Single-call swap (pull → swapTokenForToken) ────────────────────

    function test_singleCall_swap_pull() public {
        uint256 exitValue = 1000;
        uint256 routedOut = 950;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: address(zr),
            value: 0,
            token: address(usdc),
            amount: exitValue,
            push: false,
            data: abi.encodeCall(MockZRouterExit.swapTokenForToken, (address(usdc), exitValue, address(tokenOut), routedOut))
        });
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipe(assetId, address(0), FINAL, _fut(), 1, _one(c), _addrs(address(tokenOut)), _uints(900));
        address escrow = router.escrowAddressFor(recipe);

        router.exitAndExecute(_exitPv(exitValue, escrow), hex"", new bytes[](0), recipe);

        assertEq(tokenOut.balanceOf(FINAL), routedOut, "finalRecipient received the route output");
        assertEq(tokenOut.balanceOf(escrow), 0, "escrow swept");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing");
    }

    // ──────────────────── 2. Single-call conduit (push → executeFromBalance) ────────────────────

    function test_singleCall_conduit_push() public {
        uint256 exitValue = 1000;
        uint256 routedOut = 950;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: address(zr),
            value: 0,
            token: address(usdc),
            amount: exitValue,
            push: true,
            data: abi.encodeCall(MockZRouterExit.executeFromBalance, (address(usdc), exitValue, address(tokenOut), routedOut))
        });
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipe(assetId, address(0), FINAL, _fut(), 1, _one(c), _addrs(address(tokenOut)), _uints(900));
        address escrow = router.escrowAddressFor(recipe);

        router.exitAndExecute(_exitPv(exitValue, escrow), hex"", new bytes[](0), recipe);

        assertEq(tokenOut.balanceOf(FINAL), routedOut, "output delivered");
        assertEq(usdc.balanceOf(address(zr)), exitValue, "input pushed and consumed by conduit");
    }

    // ──────────────────── 3. Multi-step batch (A: usdc→mid, B: mid→out on a 2nd mock) ────────────────────

    function test_multiStep_batchChains() public {
        uint256 exitValue = 1000;
        uint256 midOut = 800;
        uint256 finalOut = 700;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitCall[] memory calls = new ConfidentialRouter.ExitCall[](2);
        calls[0] = ConfidentialRouter.ExitCall({
            target: address(zr),
            value: 0,
            token: address(usdc),
            amount: exitValue,
            push: false,
            data: abi.encodeCall(MockZRouterExit.swapTokenForToken, (address(usdc), exitValue, address(mid), midOut))
        });
        calls[1] = ConfidentialRouter.ExitCall({
            target: address(zr2),
            value: 0,
            token: address(mid),
            amount: midOut,
            push: false,
            data: abi.encodeCall(MockZRouterExit.swapTokenForToken, (address(mid), midOut, address(tokenOut), finalOut))
        });
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipe(assetId, address(0), FINAL, _fut(), 1, calls, _addrs(address(tokenOut)), _uints(600));
        address escrow = router.escrowAddressFor(recipe);

        router.exitAndExecute(_exitPv(exitValue, escrow), hex"", new bytes[](0), recipe);

        assertEq(tokenOut.balanceOf(FINAL), finalOut, "final output delivered after chaining A then B");
        assertEq(mid.balanceOf(escrow), 0, "intermediate fully consumed");
        assertEq(usdc.balanceOf(address(zr)), exitValue, "step A pulled the input");
    }

    // ──────────────────── 4. Multi-output: two sweepTokens both delivered ────────────────────

    function test_multiOutput_twoSweeps() public {
        uint256 exitValue = 1000;
        _seedEscrow(exitValue);

        // One call mints OUT; we also leave half the usdc unrouted so it is a second swept output.
        uint256 routedIn = 600;
        uint256 routedOut = 550;

        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: address(zr),
            value: 0,
            token: address(usdc),
            amount: routedIn,
            push: false,
            data: abi.encodeCall(MockZRouterExit.swapTokenForToken, (address(usdc), routedIn, address(tokenOut), routedOut))
        });
        address[] memory sweeps = new address[](2);
        sweeps[0] = address(tokenOut);
        sweeps[1] = address(usdc);
        uint256[] memory mins = new uint256[](2);
        mins[0] = 500;
        mins[1] = exitValue - routedIn;

        ConfidentialRouter.ExitRecipe memory recipe = _recipe(assetId, address(0), FINAL, _fut(), 1, _one(c), sweeps, mins);
        address escrow = router.escrowAddressFor(recipe);

        router.exitAndExecute(_exitPv(exitValue, escrow), hex"", new bytes[](0), recipe);

        assertEq(tokenOut.balanceOf(FINAL), routedOut, "swept output 1");
        assertEq(usdc.balanceOf(FINAL), exitValue - routedIn, "swept output 2 (unrouted input)");
    }

    // ──────────────────── 5. Native ETH: ETH funds a call (value) + ETH output sweep ────────────────────

    function test_ethExit_valueCall_ethSweep() public {
        uint256 exitValue = 5; // in-system units
        uint256 exitWei = exitValue * TETH_SCALE;
        uint256 routedOut = 950;
        _seedEthEscrow(exitWei);

        // Forward the exited ETH as the call value to swapETHForToken, output minted to the escrow.
        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: address(zr),
            value: exitWei,
            token: address(0),
            amount: 0,
            push: false,
            data: abi.encodeCall(MockZRouterExit.swapETHForToken, (address(tokenOut), routedOut))
        });
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipe(tEthAssetId, address(0), FINAL, _fut(), 1, _one(c), _addrs(address(tokenOut)), _uints(900));
        address escrow = router.escrowAddressFor(recipe);

        router.exitAndExecute(_exitPvAsset(tEthAssetId, exitValue, escrow), hex"", new bytes[](0), recipe);

        assertEq(tokenOut.balanceOf(FINAL), routedOut, "ERC20 output delivered from an ETH-funded call");
        assertEq(escrow.balance, 0, "escrow holds no ETH");
    }

    function test_tokenExit_ethSweep() public {
        uint256 exitValue = 1000;
        uint256 routedOut = 7 ether;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: address(zr),
            value: 0,
            token: address(usdc),
            amount: exitValue,
            push: false,
            data: abi.encodeCall(MockZRouterExit.swapTokenForETH, (address(usdc), exitValue, routedOut))
        });
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipe(assetId, address(0), FINAL, _fut(), 1, _one(c), _addrs(address(0)), _uints(1 ether));
        address escrow = router.escrowAddressFor(recipe);

        uint256 before = FINAL.balance;
        router.exitAndExecute(_exitPv(exitValue, escrow), hex"", new bytes[](0), recipe);
        assertEq(FINAL.balance - before, routedOut, "native ETH output swept to finalRecipient");
    }

    // ──────────────────── 6. Front-run binding ────────────────────

    function test_frontrun_tamperRecipient_reverts() public {
        uint256 exitValue = 1000;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: address(zr),
            value: 0,
            token: address(usdc),
            amount: exitValue,
            push: false,
            data: abi.encodeCall(MockZRouterExit.swapTokenForToken, (address(usdc), exitValue, address(tokenOut), 950))
        });
        ConfidentialRouter.ExitRecipe memory honest =
            _recipe(assetId, address(0), FINAL, _fut(), 1, _one(c), _addrs(address(tokenOut)), _uints(900));
        bytes memory pv = _exitPv(exitValue, router.escrowAddressFor(honest));

        ConfidentialRouter.ExitRecipe memory tampered =
            _recipe(assetId, address(0), address(0xBAD), _fut(), 1, _one(c), _addrs(address(tokenOut)), _uints(900));
        assertTrue(router.escrowAddressFor(tampered) != router.escrowAddressFor(honest), "tamper changes escrow");

        // The proof funded the HONEST escrow; the tampered recipe's escrow is empty, so the call's transferFrom
        // pull (exitValue from an empty escrow) reverts. The output cannot be redirected.
        vm.expectRevert();
        router.exitAndExecute(pv, hex"", new bytes[](0), tampered);
    }

    function test_frontrun_tamperMinOut_reverts() public {
        uint256 exitValue = 1000;
        uint256 routedOut = 950;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: address(zr),
            value: 0,
            token: address(usdc),
            amount: exitValue,
            push: false,
            data: abi.encodeCall(MockZRouterExit.swapTokenForToken, (address(usdc), exitValue, address(tokenOut), routedOut))
        });
        ConfidentialRouter.ExitRecipe memory honest =
            _recipe(assetId, address(0), FINAL, _fut(), 1, _one(c), _addrs(address(tokenOut)), _uints(900));
        address honestEscrow = router.escrowAddressFor(honest);
        bytes memory pv = _exitPv(exitValue, honestEscrow);

        // Tamper the minOut → different recipe hash → different (empty) escrow → the call's transferFrom reverts.
        ConfidentialRouter.ExitRecipe memory tampered = honest;
        tampered.minOuts = _uints(9_999_999);
        assertTrue(router.escrowAddressFor(tampered) != honestEscrow, "tamper changes escrow");

        vm.expectRevert();
        router.exitAndExecute(pv, hex"", new bytes[](0), tampered);
    }

    // ──────────────────── 7. run() only-ROUTER ────────────────────

    function test_run_onlyRouter() public {
        // Deploy a fresh impl (this contract is its ROUTER), clone it, and call run from a non-router caller.
        ExitExecutor impl = new ExitExecutor(address(pool));
        ExitExecutor escrow = ExitExecutor(payable(LibClone.cloneDeterministic_PUSH0(address(impl), bytes32(uint256(1)))));

        ConfidentialRouter.ExitRecipe memory r = _recipe(
            assetId,
            address(0),
            FINAL,
            _fut(),
            1,
            new ConfidentialRouter.ExitCall[](0),
            new address[](0),
            new uint256[](0)
        );
        vm.prank(address(0xABCD));
        vm.expectRevert(ExitExecutor.NotRouter.selector);
        escrow.run(r);
    }

    // ──────────────────── 8. disallowed targets (pool / router / self) ────────────────────

    function test_disallowedTarget_pool_reverts() public {
        _disallowedTarget(address(pool));
    }

    function test_disallowedTarget_router_reverts() public {
        _disallowedTarget(address(router));
    }

    function _disallowedTarget(address badTarget) internal {
        uint256 exitValue = 1000;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: badTarget,
            value: 0,
            token: address(0),
            amount: 0,
            push: false,
            data: hex""
        });
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipe(assetId, address(0), FINAL, _fut(), 1, _one(c), new address[](0), new uint256[](0));
        bytes memory pv = _exitPv(exitValue, router.escrowAddressFor(recipe));

        vm.expectRevert(ExitExecutor.BadTarget.selector);
        router.exitAndExecute(pv, hex"", new bytes[](0), recipe);
    }

    function test_disallowedTarget_self_reverts() public {
        // target == the escrow itself. The escrow address depends on the recipe (which holds the target), so we
        // can't name it inside the recipe in exitAndExecute. Instead deploy a standalone clone (this contract is
        // its ROUTER), point a call at the clone, and call run directly.
        ExitExecutor impl = new ExitExecutor(address(pool));
        ExitExecutor escrow = ExitExecutor(payable(LibClone.cloneDeterministic_PUSH0(address(impl), bytes32(uint256(2)))));

        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: address(escrow),
            value: 0,
            token: address(0),
            amount: 0,
            push: false,
            data: hex""
        });
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipe(assetId, address(0), FINAL, _fut(), 1, _one(c), new address[](0), new uint256[](0));

        // This contract is the impl's ROUTER (it deployed `impl`), so it may call run; the bad-target check fires.
        vm.expectRevert(ExitExecutor.BadTarget.selector);
        escrow.run(recipe);
    }

    // ──────────────────── 9. In-proof relay fee forwarded to msg.sender ────────────────────

    function test_inProofFee_paidToRelayer() public {
        uint256 exitValue = 1000;
        uint256 routedOut = 950;
        uint256 feeValue = 50;
        _seedEscrow(exitValue + feeValue);

        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: address(zr),
            value: 0,
            token: address(usdc),
            amount: exitValue,
            push: false,
            data: abi.encodeCall(MockZRouterExit.swapTokenForToken, (address(usdc), exitValue, address(tokenOut), routedOut))
        });
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipe(assetId, address(usdc), FINAL, _fut(), 1, _one(c), _addrs(address(tokenOut)), _uints(900));
        address escrow = router.escrowAddressFor(recipe);

        bytes memory pv = _exitPvWithFee(assetId, exitValue, escrow, assetId, feeValue);
        vm.prank(RELAYER);
        router.exitAndExecute(pv, hex"", new bytes[](0), recipe);

        assertEq(usdc.balanceOf(RELAYER), feeValue, "relayer received exactly the in-proof fee");
        assertEq(tokenOut.balanceOf(FINAL), routedOut, "finalRecipient received the FULL output (no skim)");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing");
    }

    // ──────────────────── 10. deadline + sweep length mismatch ────────────────────

    function test_expired_reverts() public {
        uint256 exitValue = 1000;
        _seedEscrow(exitValue);
        vm.warp(10_000);

        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: address(zr),
            value: 0,
            token: address(usdc),
            amount: exitValue,
            push: false,
            data: hex""
        });
        ConfidentialRouter.ExitRecipe memory recipe = _recipe(
            assetId, address(0), FINAL, uint64(block.timestamp - 1), 1, _one(c), _addrs(address(tokenOut)), _uints(900)
        );
        bytes memory pv = _exitPv(exitValue, router.escrowAddressFor(recipe));

        vm.expectRevert(ConfidentialRouter.ExitExpired.selector);
        router.exitAndExecute(pv, hex"", new bytes[](0), recipe);
    }

    function test_sweepLengthMismatch_reverts() public {
        uint256 exitValue = 1000;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitCall memory c = ConfidentialRouter.ExitCall({
            target: address(zr),
            value: 0,
            token: address(usdc),
            amount: exitValue,
            push: false,
            data: hex""
        });
        // sweepTokens length 1 but minOuts length 2.
        uint256[] memory mins = new uint256[](2);
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipe(assetId, address(0), FINAL, _fut(), 1, _one(c), _addrs(address(tokenOut)), mins);
        bytes memory pv = _exitPv(exitValue, router.escrowAddressFor(recipe));

        vm.expectRevert(ConfidentialRouter.BadTarget.selector);
        router.exitAndExecute(pv, hex"", new bytes[](0), recipe);
    }

    // ──────────────────── cross-check sample for the JS escrow-address derivation ────────────────────

    function test_sampleEscrowAddress_forJsCrossCheck() public {
        ConfidentialRouter.ExitCall[] memory calls = new ConfidentialRouter.ExitCall[](2);
        calls[0] = ConfidentialRouter.ExitCall({
            target: address(0x1234),
            value: 7,
            token: address(0x5678),
            amount: 1000,
            push: false,
            data: hex"deadbeef"
        });
        calls[1] = ConfidentialRouter.ExitCall({
            target: address(0x9abc),
            value: 0,
            token: address(0),
            amount: 0,
            push: true,
            data: hex"cafe"
        });
        address[] memory sweeps = new address[](2);
        sweeps[0] = address(0xAAAA);
        sweeps[1] = address(0);
        uint256[] memory mins = new uint256[](2);
        mins[0] = 11;
        mins[1] = 22;

        ConfidentialRouter.ExitRecipe memory sample = ConfidentialRouter.ExitRecipe({
            exitedAsset: bytes32(uint256(0x1111)),
            feeAsset: address(0x6789),
            finalRecipient: address(0x3333),
            deadline: 1893456000,
            nonce: 42,
            calls: calls,
            sweepTokens: sweeps,
            minOuts: mins
        });

        address fixedRouter = address(0x00000000000000000000000000000000C0FFEE01);
        address impl = router.executorImpl();
        bytes32 salt = keccak256(abi.encode(sample));
        address escrow = LibClone.predictDeterministicAddress_PUSH0(impl, salt, fixedRouter);

        address liveEscrow = LibClone.predictDeterministicAddress_PUSH0(impl, salt, address(router));
        assertEq(router.escrowAddressFor(sample), liveEscrow, "escrowAddressFor matches the PUSH0 clone formula");

        emit log_named_address("executorImpl", impl);
        emit log_named_bytes32("salt(keccak(abi.encode(sample)))", salt);
        emit log_named_address("fixedRouter", fixedRouter);
        emit log_named_address("escrowAddressFor(fixedRouter, sample)", escrow);
    }
}
