// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {ConfidentialRouter, ExitEscrow} from "../src/ConfidentialRouter.sol";

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
}

contract ConfidentialRouterExitTest is Test {
    ConfidentialPool pool;
    ConfidentialRouter router;
    MockZRouterExit zr;
    MockToken usdc; // the exited (escrow-backed) asset
    MockToken tokenOut; // the route output
    bytes32 assetId;

    address constant FINAL = address(0xF1A1);
    address constant SEEDER = address(0x5EED);

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
            bytes32(0), // no tETH (ERC20-only exits)
            address(0) // collateral engine
        );

        usdc = new MockToken("USD Coin", "USDC");
        // unitScale 1 ⇒ value == amount; link 0 ⇒ escrow-backed (NOT pool-minted), so payouts come from escrow.
        assetId = pool.registerWrapped(address(usdc), 1, bytes32(0), "USD Coin", "USDC", 6);

        zr = new MockZRouterExit();
        // PERMIT2 must be a code-bearing address (ctor guard); the exit path never uses it, so any deployed
        // contract works. Reuse the pool address.
        router = new ConfidentialRouter(address(pool), address(zr), address(pool));
    }

    // ──────────────────── helpers ────────────────────

    /// Seed the pool's escrow for `assetId` by doing a direct public wrap (so a later withdrawal can pay out).
    function _seedEscrow(uint256 amount) internal {
        usdc.mint(SEEDER, amount);
        vm.startPrank(SEEDER);
        usdc.approve(address(pool), type(uint256).max);
        pool.wrap(assetId, amount, keccak256("seed-commit"));
        vm.stopPrank();
    }

    /// Build a settle proof that withdraws `value` of `assetId` to `recipient` (the recipe-bound escrow addr).
    function _exitPv(uint256 value, address recipient) internal view returns (bytes memory) {
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal({assetId: assetId, value: value, recipient: recipient});
        return abi.encode(pv);
    }

    function _recipe(address tOut, uint256 minOut, address finalRecipient, uint64 deadline, uint256 nonce, bytes memory z)
        internal
        view
        returns (ConfidentialRouter.ExitRecipe memory)
    {
        return ConfidentialRouter.ExitRecipe({
            exitedAsset: assetId,
            tokenOut: tOut,
            minOut: minOut,
            finalRecipient: finalRecipient,
            deadline: deadline,
            nonce: nonce,
            zCalldata: z
        });
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

    /// An ExitEscrow only lets its DEPLOYER sweep. A non-deployer poking sweep reverts "only deployer", so a
    /// griefer cannot drain a recipe-bound escrow out from under the router.
    function test_exitEscrow_sweepOnlyDeployer() public {
        // This test contract is the deployer here.
        ExitEscrow escrow = new ExitEscrow();
        MockToken t = new MockToken("X", "X");
        t.mint(address(escrow), 100);

        vm.prank(address(0xABCD));
        vm.expectRevert("exit-escrow: only deployer");
        escrow.sweep(address(t));

        // The deployer can sweep — funds go to the deployer (this contract).
        escrow.sweep(address(t));
        assertEq(t.balanceOf(address(this)), 100, "deployer swept to itself");
    }

    // ──────────────────── cross-check sample for the JS escrow-address derivation ────────────────────

    /// Logs `escrowAddressFor` for a FIXED sample recipe so the JS test (tests/exit-recipe-escrow.test.mjs)
    /// can assert byte-identical CREATE2 derivation. Run with -vv to read the address; it is also hardcoded in
    /// the JS test as SAMPLE_ROUTER / expected.
    function test_sampleEscrowAddress_forJsCrossCheck() public {
        ConfidentialRouter.ExitRecipe memory sample = ConfidentialRouter.ExitRecipe({
            exitedAsset: bytes32(uint256(0x1111)),
            tokenOut: address(0x2222),
            minOut: 12345,
            finalRecipient: address(0x3333),
            deadline: 1893456000,
            nonce: 42,
            zCalldata: hex"deadbeef"
        });
        // The live router's address is deployer-nonce dependent (non-deterministic across runs), so it is a
        // poor cross-check anchor. Instead derive the escrow for a FIXED router address using the SAME formula
        // the contract uses (escrowAddressFor) — the JS test pins this same router address + sample recipe.
        address fixedRouter = address(0x00000000000000000000000000000000C0FFEE01);
        bytes32 salt = keccak256(abi.encode(sample));
        bytes32 initcodeHash = keccak256(type(ExitEscrow).creationCode);
        address escrow = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), fixedRouter, salt, initcodeHash))))
        );

        // Sanity: the live router's own escrowAddressFor must equal the same formula applied to address(router).
        address liveEscrow = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(router), salt, initcodeHash))))
        );
        assertEq(router.escrowAddressFor(sample), liveEscrow, "escrowAddressFor matches the CREATE2 formula");

        emit log_named_bytes32("EXIT_ESCROW_INITCODE_HASH", initcodeHash);
        emit log_named_bytes32("salt(keccak(abi.encode(sample)))", salt);
        emit log_named_address("fixedRouter", fixedRouter);
        emit log_named_address("escrowAddressFor(fixedRouter, sample)", escrow);
    }
}
