// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {ConfidentialRouter, ExitEscrowImpl} from "../src/ConfidentialRouter.sol";

/// Minimal SP1 verifier stub — the mock accepts any proof so the test isolates the router's exit-and-call
/// orchestration from proving.
contract StubVerifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external view {}
}

/// 6-decimal ERC20 used as the exited (escrow-backed) asset and the route output token.
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

/// zRouter stand-in: `swapExact` pulls `inAmount` of `tokenIn` from the caller (the router, via its standing
/// approval) and delivers `outAmount` of `tokenOut` to the caller. The router gates on its OWN balance delta,
/// so the test picks `outAmount` to model exact / short / over swaps; if `pullAll` is set it pulls the
/// router's whole tokenIn balance (so a "no unrouted dust" path can be exercised).
contract MockZRouterExit {
    function swapExact(address tokenIn, uint256 inAmount, address tokenOut, uint256 outAmount) external {
        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), inAmount);
        MockToken(tokenOut).mint(msg.sender, outAmount);
    }

    /// ETH-in route: keeps the forwarded ETH (modeling a swap that consumes the native input) and mints
    /// `outAmount` of `tokenOut` to the caller (the router).
    function swapETHForToken(address tokenOut, uint256 outAmount) external payable {
        MockToken(tokenOut).mint(msg.sender, outAmount);
    }

    /// ETH-out route: pulls `inAmount` of `tokenIn` via the router's standing approval and sends `outAmount`
    /// of native ETH to the caller (the router). Funded with ETH in setUp.
    function swapTokenForETH(address tokenIn, uint256 inAmount, uint256 outAmount) external {
        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), inAmount);
        SafeTransferLib.safeTransferETH(msg.sender, outAmount);
    }

    /// PUSH-mode (execute/snwap conduit): the router has already transferred `amountIn` of `tokenIn` to this
    /// mock, which routes from its OWN balance — it must NOT transferFrom the caller. Asserts the push landed,
    /// then mints `outAmount` of `tokenOut` to `to` (the router).
    function executeFromBalance(address tokenIn, uint256 amountIn, address tokenOut, uint256 outAmount, address to)
        external
    {
        require(SafeTransferLib.balanceOf(tokenIn, address(this)) >= amountIn, "push: input not received");
        MockToken(tokenOut).mint(to, outAmount);
    }

    receive() external payable {}
}

contract ConfidentialRouterExitTest is Test {
    ConfidentialPool pool;
    ConfidentialRouter router;
    MockZRouterExit zr;
    MockToken usdc; // the exited (escrow-backed) asset
    MockToken tokenOut; // the route output
    bytes32 assetId;
    bytes32 tEthAssetId; // native-ETH (tETH) asset id

    address constant FINAL = address(0xF1A1);
    address constant SEEDER = address(0x5EED);
    address constant RELAYER = address(0xBEEF);

    // tETH uses unitScale 10^10 (18-dec ETH → Tacit 8): in-system value v ⇒ amount = v * 10^10 wei.
    uint256 constant TETH_SCALE = 10 ** 10;

    function setUp() public {
        vm.chainId(1); // assetId = sha256(domain‖chainid‖token); must match registration

        pool = new ConfidentialPool(
            address(new StubVerifier()),
            bytes32(uint256(0xABCD)), // program vkey
            bytes32(0), // bitcoin relay vkey OFF
            address(0), // factory off
            address(0), // relay off
            bytes32(0), // anchor
            0, // confirmations
            bytes32(0), // resume digest
            bytes32(uint256(0xE74)), // tETH bitcoin link ⇒ native ETH (tETH) registered this generation
            address(0) // collateral engine
        );

        usdc = new MockToken("USD Coin", "USDC");
        // unitScale 1 ⇒ value == amount; link 0 ⇒ escrow-backed (NOT pool-minted), so payouts come from escrow.
        assetId = pool.registerWrapped(address(usdc), 1, bytes32(0), "USD Coin", "USDC", 6);
        // tETH asset id == sha256("tacit-evm-token-v1" ‖ chainid_be8 ‖ address(0)) — the pool's _evmAssetId(0).
        tEthAssetId = _evmAssetId(address(0));

        zr = new MockZRouterExit();
        // PERMIT2 must be a code-bearing address (ctor guard); the exit path never uses it, so any deployed
        // contract works. Reuse the pool address.
        router = new ConfidentialRouter(address(pool), address(zr), address(pool));

        // Fund the mock with ETH so an ETH-out route can pay native ETH to the router.
        vm.deal(address(zr), 100 ether);
    }

    // ──────────────────── helpers ────────────────────

    function _evmAssetId(address underlying) internal view returns (bytes32) {
        return sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), underlying));
    }

    /// Seed the pool's escrow for `assetId` by doing a direct public wrap (so a later withdrawal can pay out).
    function _seedEscrow(uint256 amount) internal {
        usdc.mint(SEEDER, amount);
        vm.startPrank(SEEDER);
        usdc.approve(address(pool), type(uint256).max);
        pool.wrap(assetId, amount, keccak256("seed-commit"));
        vm.stopPrank();
    }

    /// Seed the pool's native-ETH (tETH) escrow with `amountWei` so a later tETH withdrawal can force-send it.
    function _seedEthEscrow(uint256 amountWei) internal {
        vm.deal(SEEDER, amountWei);
        vm.prank(SEEDER);
        pool.wrap{value: amountWei}(tEthAssetId, amountWei, keccak256("seed-eth-commit"));
    }

    /// Build a settle proof that withdraws `value` of `aid` to `recipient` (the recipe-bound escrow addr).
    function _exitPvAsset(bytes32 aid, uint256 value, address recipient) internal view returns (bytes memory) {
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal({assetId: aid, value: value, recipient: recipient});
        return abi.encode(pv);
    }

    /// Same exit, plus an in-proof fee leg: settle pays `feeValue` of `feeAssetId` to msg.sender (the router),
    /// which forwards it to the relayer. The fee asset must be escrow-funded (a prior wrap) for the payout.
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

    /// Full recipe constructor (9 fields) with an explicit exited asset + feeAsset. pushInput defaults to false
    /// (the APPROVE/pull funding mode used by every prior case).
    function _recipeFull(
        bytes32 exitedAsset,
        address tOut,
        uint256 minOut,
        address finalRecipient,
        uint64 deadline,
        uint256 nonce,
        address feeAsset,
        bytes memory z
    ) internal pure returns (ConfidentialRouter.ExitRecipe memory) {
        return ConfidentialRouter.ExitRecipe({
            exitedAsset: exitedAsset,
            tokenOut: tOut,
            minOut: minOut,
            finalRecipient: finalRecipient,
            deadline: deadline,
            nonce: nonce,
            feeAsset: feeAsset,
            pushInput: false,
            zCalldata: z
        });
    }

    /// Push-mode variant: same fields as `_recipeFull` but with pushInput = true.
    function _recipeFullPush(
        bytes32 exitedAsset,
        address tOut,
        uint256 minOut,
        address finalRecipient,
        uint64 deadline,
        uint256 nonce,
        address feeAsset,
        bytes memory z
    ) internal pure returns (ConfidentialRouter.ExitRecipe memory) {
        return ConfidentialRouter.ExitRecipe({
            exitedAsset: exitedAsset,
            tokenOut: tOut,
            minOut: minOut,
            finalRecipient: finalRecipient,
            deadline: deadline,
            nonce: nonce,
            feeAsset: feeAsset,
            pushInput: true,
            zCalldata: z
        });
    }

    /// USDC-exit recipe, feeAsset address(0) (no-relay shape: a fee-0 proof forwards nothing).
    function _recipe(address tOut, uint256 minOut, address finalRecipient, uint64 deadline, uint256 nonce, bytes memory z)
        internal
        view
        returns (ConfidentialRouter.ExitRecipe memory)
    {
        return _recipeFull(assetId, tOut, minOut, finalRecipient, deadline, nonce, address(0), z);
    }

    function _swapCalldata(uint256 inAmount, uint256 outAmount) internal view returns (bytes memory) {
        return abi.encodeCall(MockZRouterExit.swapExact, (address(usdc), inAmount, address(tokenOut), outAmount));
    }

    // ──────────────────── 1. Happy path ────────────────────

    function test_exitAndCall_happyPath() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        uint256 routedOut = 950;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitRecipe memory recipe = _recipe(
            address(tokenOut),
            900,
            FINAL,
            uint64(block.timestamp + 1 hours),
            1,
            _swapCalldata(exitValue, routedOut)
        );
        address escrow = router.escrowAddressFor(recipe);

        bytes[] memory memos = new bytes[](0);
        uint256 out = router.exitAndCall(_exitPv(exitValue, escrow), hex"", memos, recipe);

        assertEq(out, routedOut, "returns the routed output amount");
        assertEq(tokenOut.balanceOf(FINAL), routedOut, "finalRecipient received the route output");
        // No resting balance anywhere along the path.
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no tokenIn");
        assertEq(tokenOut.balanceOf(address(router)), 0, "router holds no tokenOut");
        assertEq(usdc.balanceOf(escrow), 0, "escrow drained");
        assertEq(tokenOut.balanceOf(escrow), 0, "escrow holds no tokenOut");
    }

    /// Any input not consumed by the route is forwarded to finalRecipient (no dust resting in the router).
    function test_exitAndCall_unroutedInputRefundedToRecipient() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        uint256 routedIn = 600; // the mock only pulls 600 of the 1000 exited
        uint256 routedOut = 550;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitRecipe memory recipe = _recipe(
            address(tokenOut),
            500,
            FINAL,
            uint64(block.timestamp + 1 hours),
            7,
            _swapCalldata(routedIn, routedOut)
        );
        address escrow = router.escrowAddressFor(recipe);

        router.exitAndCall(_exitPv(exitValue, escrow), hex"", new bytes[](0), recipe);

        assertEq(tokenOut.balanceOf(FINAL), routedOut, "route output delivered");
        assertEq(usdc.balanceOf(FINAL), exitValue - routedIn, "unrouted input swept to recipient");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no leftover input");
    }

    // ──────────────────── 2. Front-run binding (core security property) ────────────────────

    /// The proof pays the escrow bound to recipeA. A relayer/sniper who submits the SAME proof with a TAMPERED
    /// recipe (different finalRecipient) hits a DIFFERENT, empty escrow ⇒ ExitEmpty. The output cannot be
    /// redirected.
    function test_exitAndCall_frontrunTamperRecipient_reverts() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        _seedEscrow(exitValue);

        bytes memory z = _swapCalldata(exitValue, 950);
        ConfidentialRouter.ExitRecipe memory honest =
            _recipe(address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 1, z);
        address honestEscrow = router.escrowAddressFor(honest);

        // Proof commits funds to the HONEST escrow.
        bytes memory pv = _exitPv(exitValue, honestEscrow);

        // Attacker tampers: same proof, redirect the output to themselves.
        ConfidentialRouter.ExitRecipe memory tampered =
            _recipe(address(tokenOut), 900, address(0xBAD), uint64(block.timestamp + 1 hours), 1, z);
        assertTrue(router.escrowAddressFor(tampered) != honestEscrow, "tamper changes the escrow address");

        vm.expectRevert(ConfidentialRouter.ExitEmpty.selector);
        router.exitAndCall(pv, hex"", new bytes[](0), tampered);
    }

    /// Tampering the route (zCalldata) likewise lands on an empty escrow ⇒ ExitEmpty.
    function test_exitAndCall_frontrunTamperCalldata_reverts() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitRecipe memory honest = _recipe(
            address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 1, _swapCalldata(exitValue, 950)
        );
        bytes memory pv = _exitPv(exitValue, router.escrowAddressFor(honest));

        // Attacker swaps in a route that returns more output to a pool they control — different calldata ⇒
        // different recipe hash ⇒ different (empty) escrow.
        ConfidentialRouter.ExitRecipe memory tampered = _recipe(
            address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 1, _swapCalldata(exitValue, 999_999)
        );

        vm.expectRevert(ConfidentialRouter.ExitEmpty.selector);
        router.exitAndCall(pv, hex"", new bytes[](0), tampered);
    }

    // ──────────────────── 3. minOut ────────────────────

    function test_exitAndCall_belowMinOut_reverts() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        _seedEscrow(exitValue);

        // Route returns 800 but the recipe demands >= 900.
        ConfidentialRouter.ExitRecipe memory recipe = _recipe(
            address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 1, _swapCalldata(exitValue, 800)
        );
        bytes memory pv = _exitPv(exitValue, router.escrowAddressFor(recipe));

        vm.expectRevert(ConfidentialRouter.ExitMinOut.selector);
        router.exitAndCall(pv, hex"", new bytes[](0), recipe);
    }

    // ──────────────────── 4. deadline ────────────────────

    function test_exitAndCall_expired_reverts() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        _seedEscrow(exitValue);

        vm.warp(10_000);
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipe(address(tokenOut), 900, FINAL, uint64(block.timestamp - 1), 1, _swapCalldata(exitValue, 950));
        bytes memory pv = _exitPv(exitValue, router.escrowAddressFor(recipe));

        vm.expectRevert(ConfidentialRouter.ExitExpired.selector);
        router.exitAndCall(pv, hex"", new bytes[](0), recipe);
    }

    // ──────────────────── 5. escrow sweep auth ────────────────────

    /// A clone of ExitEscrowImpl only lets the ROUTER (== the impl's deployer) sweep, and only to the router.
    /// A non-router caller reverts "only router", so a griefer cannot drain a recipe-bound escrow.
    function test_exitEscrow_sweepOnlyRouter() public {
        // This test contract deploys the impl, so it IS the ROUTER (the impl's immutable). A PUSH0 clone of the
        // impl delegatecalls back into it, so the clone reads the same ROUTER and sweeps to this contract.
        ExitEscrowImpl impl = new ExitEscrowImpl();
        ExitEscrowImpl escrow = ExitEscrowImpl(LibClone.cloneDeterministic_PUSH0(address(impl), bytes32(uint256(1))));
        MockToken t = new MockToken("X", "X");
        t.mint(address(escrow), 100);

        vm.prank(address(0xABCD));
        vm.expectRevert("exit-escrow: only router");
        escrow.sweep(address(t));

        // The router (this contract) can sweep — funds go to the router.
        escrow.sweep(address(t));
        assertEq(t.balanceOf(address(this)), 100, "router swept to itself");
    }

    // ──────────────────── 6. Native-ETH exit → ERC20 out ────────────────────

    /// The pool force-sends native ETH (tETH) to the recipe-bound escrow; the router sweeps it via sweepETH(),
    /// forwards it as the zRouter call value, and delivers the ERC20 output to finalRecipient.
    function test_exitAndCall_ethIn_tokenOut() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 5; // 5 in-system units ⇒ 5 * 10^10 wei exited
        uint256 exitWei = exitValue * TETH_SCALE;
        uint256 routedOut = 950;
        _seedEthEscrow(exitWei);

        bytes memory z = abi.encodeCall(MockZRouterExit.swapETHForToken, (address(tokenOut), routedOut));
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipeFull(tEthAssetId, address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 1, address(0), z);
        address escrow = router.escrowAddressFor(recipe);

        uint256 out =
            router.exitAndCall(_exitPvAsset(tEthAssetId, exitValue, escrow), hex"", new bytes[](0), recipe);

        assertEq(out, routedOut, "returns routed ERC20 output");
        assertEq(tokenOut.balanceOf(FINAL), routedOut, "finalRecipient received the ERC20 output");
        assertEq(address(router).balance, 0, "router holds no ETH");
        assertEq(escrow.balance, 0, "escrow holds no ETH");
        assertEq(tokenOut.balanceOf(address(router)), 0, "router holds no tokenOut");
    }

    // ──────────────────── 7. ERC20 exit → native-ETH out ────────────────────

    /// tokenOut == address(0): the route returns native ETH; finalRecipient's ETH balance grows by the output.
    function test_exitAndCall_tokenIn_ethOut() public {
        uint256 exitValue = 1000;
        uint256 routedOut = 7 ether;
        _seedEscrow(exitValue);

        bytes memory z = abi.encodeCall(MockZRouterExit.swapTokenForETH, (address(usdc), exitValue, routedOut));
        ConfidentialRouter.ExitRecipe memory recipe =
            _recipeFull(assetId, address(0), 1 ether, FINAL, uint64(block.timestamp + 1 hours), 1, address(0), z);
        address escrow = router.escrowAddressFor(recipe);

        uint256 beforeEth = FINAL.balance;
        uint256 out = router.exitAndCall(_exitPv(exitValue, escrow), hex"", new bytes[](0), recipe);

        assertEq(out, routedOut, "returns routed ETH output");
        assertEq(FINAL.balance - beforeEth, routedOut, "finalRecipient ETH balance increased by the output");
        assertEq(address(router).balance, 0, "router holds no ETH");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no tokenIn");
    }

    // ──────────────────── 8. In-proof relay fee ────────────────────

    /// Relay happy path: the proof carries an in-proof fee leg (settle pays `feeValue` of `feeAsset` to
    /// msg.sender == the router). The router forwards that fee to the relayer (msg.sender of exitAndCall) and
    /// delivers the FULL route output (no skim) to finalRecipient. Fee is in the exited asset (USDC).
    function test_exitAndCall_inProofFee_paidToRelayer() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        uint256 routedOut = 950;
        uint256 feeValue = 50;
        // Escrow must cover BOTH the exit withdrawal and the fee leg (both come out of USDC escrow).
        _seedEscrow(exitValue + feeValue);

        ConfidentialRouter.ExitRecipe memory recipe = _recipeFull(
            assetId, address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 1, address(usdc), _swapCalldata(exitValue, routedOut)
        );
        address escrow = router.escrowAddressFor(recipe);

        bytes memory pv = _exitPvWithFee(assetId, exitValue, escrow, assetId, feeValue);
        vm.prank(RELAYER);
        uint256 out = router.exitAndCall(pv, hex"", new bytes[](0), recipe);

        assertEq(out, routedOut, "full route output (no skim)");
        assertEq(usdc.balanceOf(RELAYER), feeValue, "relayer received exactly the in-proof fee");
        assertEq(tokenOut.balanceOf(FINAL), routedOut, "finalRecipient received the FULL route output");
        // Nothing rests in the router (fee/tokenIn/tokenOut).
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no feeAsset/tokenIn");
        assertEq(tokenOut.balanceOf(address(router)), 0, "router holds no tokenOut");
    }

    /// Relay happy path with the fee in a DISTINCT asset (tETH) from the exited asset (USDC): the relayer earns
    /// the ETH fee leg; finalRecipient still nets the full ERC20 output.
    function test_exitAndCall_inProofFee_distinctAsset_paidToRelayer() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        uint256 routedOut = 950;
        uint256 feeValue = 3; // in-system tETH units ⇒ 3 * 10^10 wei
        uint256 feeWei = feeValue * TETH_SCALE;
        _seedEscrow(exitValue);
        _seedEthEscrow(feeWei); // fund the tETH escrow so the fee leg can pay out

        // feeAsset == address(0) ⇒ the fee is native ETH (tETH).
        ConfidentialRouter.ExitRecipe memory recipe = _recipeFull(
            assetId, address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 9, address(0), _swapCalldata(exitValue, routedOut)
        );
        address escrow = router.escrowAddressFor(recipe);

        bytes memory pv = _exitPvWithFee(assetId, exitValue, escrow, tEthAssetId, feeValue);
        uint256 beforeEth = RELAYER.balance;
        vm.prank(RELAYER);
        uint256 out = router.exitAndCall(pv, hex"", new bytes[](0), recipe);

        assertEq(out, routedOut, "full route output (no skim)");
        assertEq(RELAYER.balance - beforeEth, feeWei, "relayer received exactly the in-proof ETH fee");
        assertEq(tokenOut.balanceOf(FINAL), routedOut, "finalRecipient received the FULL route output");
        assertEq(address(router).balance, 0, "router holds no ETH");
        assertEq(tokenOut.balanceOf(address(router)), 0, "router holds no tokenOut");
    }

    /// Self-submit (no fee leg): a fee-0 proof forwards nothing; the caller earns 0 and finalRecipient gets the
    /// full output. (This is the same shape the non-relay happy-path cases use.)
    function test_exitAndCall_selfSubmit_noFeeLeg() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        uint256 routedOut = 950;
        _seedEscrow(exitValue);

        ConfidentialRouter.ExitRecipe memory recipe = _recipeFull(
            assetId, address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 1, address(usdc), _swapCalldata(exitValue, routedOut)
        );
        address escrow = router.escrowAddressFor(recipe);

        // No fees[] ⇒ settle pays the router nothing to forward.
        vm.prank(RELAYER);
        uint256 out = router.exitAndCall(_exitPv(exitValue, escrow), hex"", new bytes[](0), recipe);

        assertEq(out, routedOut, "full route output");
        assertEq(usdc.balanceOf(RELAYER), 0, "no fee leg means relayer earns nothing");
        assertEq(tokenOut.balanceOf(FINAL), routedOut, "finalRecipient received the full output");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no feeAsset/tokenIn");
        assertEq(tokenOut.balanceOf(address(router)), 0, "router holds no tokenOut");
    }

    /// Front-run binding incl. feeAsset: tampering feeAsset changes the recipe hash ⇒ a different (empty)
    /// escrow ⇒ ExitEmpty, so a relayer can't change which asset it collects.
    function test_exitAndCall_frontrunTamperFeeAsset_reverts() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        _seedEscrow(exitValue);

        bytes memory z = _swapCalldata(exitValue, 950);
        ConfidentialRouter.ExitRecipe memory honest =
            _recipeFull(assetId, address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 1, address(usdc), z);
        bytes memory pv = _exitPv(exitValue, router.escrowAddressFor(honest));

        // Attacker swaps the collected fee asset ⇒ different recipe hash ⇒ different (empty) escrow.
        ConfidentialRouter.ExitRecipe memory tampered =
            _recipeFull(assetId, address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 1, address(0), z);
        assertTrue(router.escrowAddressFor(tampered) != router.escrowAddressFor(honest), "tamper changes escrow");

        vm.prank(RELAYER);
        vm.expectRevert(ConfidentialRouter.ExitEmpty.selector);
        router.exitAndCall(pv, hex"", new bytes[](0), tampered);
    }

    // ──────────────────── 9. ethIn && ethOut is degenerate ────────────────────

    function test_exitAndCall_ethInEthOut_reverts() public {
        uint256 exitValue = 5;
        _seedEthEscrow(exitValue * TETH_SCALE);

        ConfidentialRouter.ExitRecipe memory recipe =
            _recipeFull(tEthAssetId, address(0), 1, FINAL, uint64(block.timestamp + 1 hours), 1, address(0), hex"");
        bytes memory pv = _exitPvAsset(tEthAssetId, exitValue, router.escrowAddressFor(recipe));

        vm.expectRevert(ConfidentialRouter.BadTarget.selector);
        router.exitAndCall(pv, hex"", new bytes[](0), recipe);
    }

    // ──────────────────── 10. PUSH-mode funding (execute/snwap conduit) ────────────────────

    /// pushInput = true: the router PUSHES the exited tokenIn to the zRouter (no approval/transferFrom), the
    /// conduit routes from its own balance, and the output comes back to the router → finalRecipient.
    function test_exitAndCall_pushInput_conduit() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        uint256 routedOut = 950;
        _seedEscrow(exitValue);

        bytes memory z =
            abi.encodeCall(MockZRouterExit.executeFromBalance, (address(usdc), exitValue, address(tokenOut), routedOut, address(router)));
        ConfidentialRouter.ExitRecipe memory recipe = _recipeFullPush(
            assetId, address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 1, address(0), z
        );
        address escrow = router.escrowAddressFor(recipe);

        uint256 out = router.exitAndCall(_exitPv(exitValue, escrow), hex"", new bytes[](0), recipe);

        assertEq(out, routedOut, "returns the routed output amount");
        assertEq(tokenOut.balanceOf(FINAL), routedOut, "finalRecipient received the route output");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no tokenIn");
        assertEq(usdc.balanceOf(address(zr)), exitValue, "pushed tokenIn fully consumed by the conduit");
        assertEq(tokenOut.balanceOf(address(router)), 0, "router holds no tokenOut");
        assertEq(usdc.balanceOf(escrow), 0, "escrow drained");
    }

    /// Mismatch sanity: pushInput = false against a balance-consuming conduit fn. No approval is pulled and the
    /// conduit's `transferFrom`-free path sees nothing pushed ⇒ its balance assert reverts.
    function test_exitAndCall_pushModeMismatch_reverts() public {
        tokenOut = new MockToken("Out", "OUT");
        uint256 exitValue = 1000;
        _seedEscrow(exitValue);

        bytes memory z =
            abi.encodeCall(MockZRouterExit.executeFromBalance, (address(usdc), exitValue, address(tokenOut), 950, address(router)));
        // pushInput = false ⇒ the router only APPROVES; the conduit gets no pushed balance and reverts.
        ConfidentialRouter.ExitRecipe memory recipe = _recipeFull(
            assetId, address(tokenOut), 900, FINAL, uint64(block.timestamp + 1 hours), 1, address(0), z
        );
        bytes memory pv = _exitPv(exitValue, router.escrowAddressFor(recipe));

        vm.expectRevert(bytes("push: input not received"));
        router.exitAndCall(pv, hex"", new bytes[](0), recipe);
    }

    // ──────────────────── cross-check sample for the JS escrow-address derivation ────────────────────

    /// Logs `escrowImpl` + `escrowAddressFor` for a FIXED sample recipe so the JS test
    /// (tests/exit-recipe-escrow.test.mjs) can assert byte-identical PUSH0-clone CREATE2 derivation. The clone
    /// initcode hash is keyed by `escrowImpl` (the spliced minimal-proxy template), so the JS computes
    /// exitRecipeEscrow(escrowImpl, sample, router). Run with -vv to read the values; they are hardcoded in the
    /// JS test. The escrow is recomputed against a FIXED router address using the SAME PUSH0 formula the
    /// contract uses, with the live `escrowImpl` spliced in.
    function test_sampleEscrowAddress_forJsCrossCheck() public {
        ConfidentialRouter.ExitRecipe memory sample = ConfidentialRouter.ExitRecipe({
            exitedAsset: bytes32(uint256(0x1111)),
            tokenOut: address(0x2222),
            minOut: 12345,
            finalRecipient: address(0x3333),
            deadline: 1893456000,
            nonce: 42,
            feeAsset: address(0x6789),
            pushInput: false,
            zCalldata: hex"deadbeef"
        });
        // The live router's address is deployer-nonce dependent (non-deterministic across runs), so it is a
        // poor cross-check anchor. Instead derive the escrow for a FIXED router address using the SAME PUSH0
        // clone formula the contract uses (escrowAddressFor) — the JS test pins this router address + impl +
        // sample recipe. `escrowImpl` IS the live impl (its address is part of the clone initcode hash), so the
        // JS test reads it from the router's getter.
        address fixedRouter = address(0x00000000000000000000000000000000C0FFEE01);
        address impl = router.escrowImpl();
        bytes32 salt = keccak256(abi.encode(sample));
        address escrow = LibClone.predictDeterministicAddress_PUSH0(impl, salt, fixedRouter);

        // Sanity: the live router's own escrowAddressFor must equal the same formula applied to address(router).
        address liveEscrow = LibClone.predictDeterministicAddress_PUSH0(impl, salt, address(router));
        assertEq(router.escrowAddressFor(sample), liveEscrow, "escrowAddressFor matches the PUSH0 clone formula");

        emit log_named_address("escrowImpl", impl);
        emit log_named_bytes32("salt(keccak(abi.encode(sample)))", salt);
        emit log_named_address("fixedRouter", fixedRouter);
        emit log_named_address("escrowAddressFor(fixedRouter, sample)", escrow);
    }
}
