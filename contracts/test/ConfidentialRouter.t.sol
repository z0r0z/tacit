// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {ConfidentialRouter, IPermit2} from "../src/ConfidentialRouter.sol";

/// Minimal SP1 verifier stub — `wrap`/`registerWrapped` never call it, but the pool ctor needs a non-zero
/// verifier address with the right surface.
contract StubVerifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external view {}
}

/// EIP-2612 token (Solady ERC20 provides `permit` / `DOMAIN_SEPARATOR` / `nonces` from `name()`), shaped
/// like USDC (6 decimals).
contract MockUSDC is ERC20 {
    function name() public pure override returns (string memory) {
        return "USD Coin";
    }

    function symbol() public pure override returns (string memory) {
        return "USDC";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Faithful-enough Permit2 (AllowanceTransfer) mock: `permit` records the signed allowance owner→spender
/// for a token (the real singleton verifies an EIP-712 sig over the same struct — irrelevant to testing the
/// router's orchestration); `transferFrom` (caller == spender) consumes it and pulls via the token's own
/// allowance to Permit2 (the user's one-time `approve(PERMIT2, max)`).
contract MockPermit2 {
    mapping(address => mapping(address => mapping(address => uint160))) public allowed; // owner=>token=>spender=>amt
    uint256 public permitCalls;

    function permit(address owner, IPermit2.PermitSingle calldata p, bytes calldata) external {
        permitCalls++;
        allowed[owner][p.details.token][p.spender] = p.details.amount;
    }

    function permit(address owner, IPermit2.PermitBatch calldata p, bytes calldata) external {
        permitCalls++;
        for (uint256 i; i < p.details.length; i++) {
            allowed[owner][p.details[i].token][p.spender] = p.details[i].amount;
        }
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        uint160 a = allowed[from][token][msg.sender];
        require(a >= amount, "P2: insufficient permit allowance");
        allowed[from][token][msg.sender] = a - amount;
        SafeTransferLib.safeTransferFrom(token, from, to, amount);
    }
}

contract ConfidentialRouterTest is Test {
    ConfidentialPool pool;
    ConfidentialRouter router;
    MockUSDC usdc;
    MockPermit2 permit2;
    bytes32 assetId;

    uint256 constant USER_PK = 0xA11CE;
    address user;
    bytes32 constant COMMIT = keccak256("user-note-commitment");
    uint256 constant AMOUNT = 1000;
    bytes32 constant TETH_LINK = bytes32(uint256(0x7e74)); // non-zero ⇒ ctor registers native ETH (tETH)

    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    event LeavesInserted(uint256 indexed firstLeafIndex, bytes32[] leaves, bytes[] memos);

    function setUp() public {
        vm.chainId(1); // the router derives assetId = sha256(domain‖chainid‖token); must match registration
        user = vm.addr(USER_PK);

        pool = new ConfidentialPool(
            address(new StubVerifier()),
            bytes32(uint256(0xABCD)), // program vkey
            bytes32(0), // bitcoin relay vkey OFF (no relay/anchor needed)
            address(0), // factory off
            address(0), // relay off
            bytes32(0), // anchor
            0, // confirmations
            bytes32(0), // resume digest
            TETH_LINK, // tETH link → registers native ETH (tETH) as a pool asset
            address(0) // collateral engine
        );
        usdc = new MockUSDC();
        // unitScale 1 ⇒ value == amount (6-dec token, tacit precision 6); link 0 (escrow asset).
        assetId = pool.registerWrapped(address(usdc), 1, bytes32(0), "USD Coin", "USDC", 6);

        permit2 = new MockPermit2();
        router = new ConfidentialRouter(address(pool), address(0), address(permit2));

        usdc.mint(user, 10_000);
    }

    // ──────────────────── helpers ────────────────────

    function _expectedDepositId(uint256 amount, bytes32 commit) internal view returns (bytes32) {
        // depositId = keccak(assetId, value, commit), value = amount/unitScale (unitScale == 1 here).
        return keccak256(abi.encode(assetId, amount, commit));
    }

    function _sign2612(uint256 amount, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, user, address(router), amount, usdc.nonces(user), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(USER_PK, digest);
    }

    function _assertWrapped() internal view {
        assertEq(usdc.balanceOf(user), 10_000 - AMOUNT, "user debited exactly amount");
        assertEq(pool.escrow(assetId), AMOUNT, "pool escrow credited amount");
        assertEq(uint256(pool.depositStatus(_expectedDepositId(AMOUNT, COMMIT))), 1, "deposit pending under commit");
        // The router holds NO token balance between calls (the key safety property); it keeps a standing
        // (lazy infinite) pool allowance — the optimization — which is harmless since there's nothing to pull.
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no tokens after wrap");
        assertGe(usdc.allowance(address(router), address(pool)), AMOUNT, "standing pool allowance (lazy approve)");
    }

    // ──────────────────── EIP-2612 path (USDC) ────────────────────

    function test_wrapWithPermit_oneTransaction() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign2612(AMOUNT, deadline);

        vm.prank(user);
        router.wrapWithPermit(address(usdc), AMOUNT, COMMIT, deadline, v, r, s);

        _assertWrapped();
        // The permit actually set + consumed the allowance (one-tx, no prior approve).
        assertEq(usdc.allowance(user, address(router)), 0, "permit allowance fully consumed");
    }

    /// The note belongs to whoever is in `commit`, NOT to the router: the deposit id a router-wrap produces
    /// is byte-identical to the one a direct user `wrap(assetId, amount, commit)` would produce.
    function test_note_boundToCommit_notRouter() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign2612(AMOUNT, deadline);

        vm.prank(user);
        router.wrapWithPermit(address(usdc), AMOUNT, COMMIT, deadline, v, r, s);

        // Same id a direct wrap would mint — proving the router is a transparent payer, not the owner.
        assertEq(uint256(pool.depositStatus(_expectedDepositId(AMOUNT, COMMIT))), 1);
    }

    /// A front-runner replaying the permit (consuming the nonce) must not be able to grief the wrap: the
    /// try/catch swallows the now-failing permit and the wrap proceeds on the already-present allowance.
    function test_wrapWithPermit_frontrunResilient() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign2612(AMOUNT, deadline);

        // Attacker front-runs by submitting the user's permit directly (allowance now set, nonce consumed).
        usdc.permit(user, address(router), AMOUNT, deadline, v, r, s);

        // The same call now hits a permit that reverts (used nonce) — but the wrap still completes.
        vm.prank(user);
        router.wrapWithPermit(address(usdc), AMOUNT, COMMIT, deadline, v, r, s);

        _assertWrapped();
    }

    /// Fail-closed: a bad/empty permit AND no pre-existing allowance ⇒ the pull reverts ⇒ whole tx reverts,
    /// nothing escrowed.
    function test_wrapWithPermit_revertsWithoutAllowance() public {
        vm.prank(user);
        vm.expectRevert(); // safeTransferFrom reverts (no allowance), after the swallowed bad permit
        router.wrapWithPermit(address(usdc), AMOUNT, COMMIT, block.timestamp + 1 hours, 27, bytes32(0), bytes32(0));

        assertEq(pool.escrow(assetId), 0, "nothing escrowed on failure");
    }

    // ──────────────────── Permit2 path (any ERC20) ────────────────────

    function test_wrapWithPermit2_oneTransaction() public {
        // One-time Permit2 setup the user does once per token, ever.
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        IPermit2.PermitSingle memory ps = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({
                token: address(usdc),
                amount: uint160(AMOUNT),
                expiration: uint48(block.timestamp + 1 hours),
                nonce: 0
            }),
            spender: address(router),
            sigDeadline: block.timestamp + 1 hours
        });

        vm.prank(user);
        router.wrapWithPermit2(address(usdc), AMOUNT, COMMIT, ps, hex"");

        _assertWrapped();
        assertEq(permit2.permitCalls(), 1, "router invoked Permit2.permit");
        assertEq(permit2.allowed(user, address(usdc), address(router)), 0, "permit2 allowance consumed");
    }

    function test_wrapWithPermit2_revertsAmountTooLarge() public {
        IPermit2.PermitSingle memory ps; // contents irrelevant — guard trips first
        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.AmountTooLarge.selector);
        router.wrapWithPermit2(address(usdc), uint256(type(uint160).max) + 1, COMMIT, ps, hex"");
    }

    // ──────────────────── One-tx private payment (wrap + self-proved settle) ────────────────────

    /// Encode a minimal self-proved settle that consumes `depositId` and inserts the recipient's `leaf`
    /// (the value-binding lives in the real proof; the mock verifier accepts any, isolating router
    /// orchestration). Everything else (nullifiers, fees, withdrawals, ...) is empty.
    function _privatePaymentPv(bytes32 depositId, bytes32 leaf) internal view returns (bytes memory) {
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.depositsConsumed = new bytes32[](1);
        pv.depositsConsumed[0] = depositId;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = leaf;
        return abi.encode(pv);
    }

    /// The headline UX: Alice pays Bob in ONE tx — permit USDC, wrap to a Bob-owned commit, and settle a
    /// self-proved batch that inserts Bob's note leaf and emits Bob's ECDH memo (the channel Bob
    /// trial-decrypts on tacit.finance). Recipient hidden (commit), sender + amount public (public USDC).
    function test_wrapAndSettleWithPermit_privatePayment() public {
        bytes32 bobCommit = keccak256("bob-owned-note-commit"); // = keccak(Cx‖Cy‖bobOwner), built off-chain
        bytes32 bobLeaf = keccak256("bob-note-leaf");
        bytes32 depositId = keccak256(abi.encode(assetId, AMOUNT, bobCommit));

        bytes[] memory memos = new bytes[](1);
        memos[0] = abi.encodePacked(bytes32("ephemeralPub"), bytes32("ciphertext-sealed-to-bob")); // ECDH memo
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = bobLeaf;

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign2612(AMOUNT, deadline);

        // The recipient's discovery channel: the memo is emitted with the leaf, by the pool, in this one tx.
        vm.expectEmit(true, false, false, true, address(pool));
        emit LeavesInserted(0, leaves, memos);

        vm.prank(user);
        router.wrapAndSettleWithPermit(
            address(usdc), AMOUNT, bobCommit, deadline, v, r, s, _privatePaymentPv(depositId, bobLeaf), hex"", memos
        );

        assertEq(usdc.balanceOf(user), 10_000 - AMOUNT, "sender debited (public)");
        assertEq(pool.escrow(assetId), AMOUNT, "escrow credited");
        assertEq(uint256(pool.depositStatus(depositId)), 2, "deposit consumed by the settle");
        assertEq(pool.nextLeafIndex(), 1, "recipient note leaf inserted");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing after");
    }

    function test_wrapAndSettleWithPermit2_privatePayment() public {
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max); // one-time Permit2 setup

        bytes32 bobCommit = keccak256("bob-owned-note-commit-2");
        bytes32 bobLeaf = keccak256("bob-note-leaf-2");
        bytes32 depositId = keccak256(abi.encode(assetId, AMOUNT, bobCommit));

        bytes[] memory memos = new bytes[](1);
        memos[0] = abi.encodePacked(bytes32("ephemeralPub"), bytes32("ciphertext-sealed-to-bob"));

        IPermit2.PermitSingle memory ps = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({
                token: address(usdc),
                amount: uint160(AMOUNT),
                expiration: uint48(block.timestamp + 1 hours),
                nonce: 0
            }),
            spender: address(router),
            sigDeadline: block.timestamp + 1 hours
        });

        vm.prank(user);
        router.wrapAndSettleWithPermit2(
            address(usdc), AMOUNT, bobCommit, ps, hex"", _privatePaymentPv(depositId, bobLeaf), hex"", memos
        );

        assertEq(pool.escrow(assetId), AMOUNT, "escrow credited");
        assertEq(uint256(pool.depositStatus(depositId)), 2, "deposit consumed");
        assertEq(pool.nextLeafIndex(), 1, "recipient note leaf inserted");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing after");
    }

    /// The lazy infinite approve is set once per token and reused: a second wrap needs no fresh approval,
    /// the standing pool allowance persists, and the router still holds nothing.
    function test_lazyApprove_reusedAcrossWraps() public {
        uint256 d1 = block.timestamp + 1 hours;
        (uint8 v1, bytes32 r1, bytes32 s1) = _sign2612(AMOUNT, d1);
        vm.prank(user);
        router.wrapWithPermit(address(usdc), AMOUNT, keccak256("c1"), d1, v1, r1, s1);
        assertGe(usdc.allowance(address(router), address(pool)), AMOUNT, "standing allowance after first wrap");

        // second wrap (fresh permit nonce, new commit): reuses the standing allowance, no re-approve
        uint256 d2 = block.timestamp + 1 hours;
        (uint8 v2, bytes32 r2, bytes32 s2) = _sign2612(AMOUNT, d2);
        vm.prank(user);
        router.wrapWithPermit(address(usdc), AMOUNT, keccak256("c2"), d2, v2, r2, s2);

        assertEq(pool.escrow(assetId), AMOUNT * 2, "both wraps escrowed");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing");
        assertGe(usdc.allowance(address(router), address(pool)), AMOUNT, "standing allowance persists");
    }

    // ──────────────────── Native ETH ────────────────────

    /// tETH's asset id — mirrors ConfidentialPool._evmAssetId(address(0)) = sha256(domain‖chainid‖0).
    function _tethId() internal view returns (bytes32) {
        return sha256(
            abi.encodePacked(bytes18(0x74616369742d65766d2d746f6b656e2d7631), uint64(block.chainid), address(0))
        );
    }

    function test_wrapETH_oneTransaction() public {
        uint256 amountWei = 1e15; // 0.001 ETH; tETH unitScale 1e10 → value 1e5
        bytes32 tethId = _tethId();
        bytes32 commit = keccak256("eth-note");
        bytes32 depositId = keccak256(abi.encode(tethId, amountWei / 1e10, commit));
        vm.deal(user, 1 ether);

        vm.prank(user);
        router.wrapETH{value: amountWei}(commit);

        assertEq(pool.escrow(tethId), amountWei, "tETH escrow credited msg.value");
        assertEq(uint256(pool.depositStatus(depositId)), 1, "deposit pending under commit");
        assertEq(address(router).balance, 0, "router forwards all ETH, holds none");
    }

    function test_wrapAndSettleETH_privatePayment() public {
        uint256 amountWei = 1e15;
        bytes32 tethId = _tethId();
        bytes32 bobCommit = keccak256("eth-bob-commit");
        bytes32 bobLeaf = keccak256("eth-bob-leaf");
        bytes32 depositId = keccak256(abi.encode(tethId, amountWei / 1e10, bobCommit));
        bytes[] memory memos = new bytes[](1);
        memos[0] = abi.encodePacked(bytes32("eph"), bytes32("ct"));
        vm.deal(user, 1 ether);

        vm.prank(user);
        router.wrapAndSettleETH{value: amountWei}(bobCommit, _privatePaymentPv(depositId, bobLeaf), hex"", memos);

        assertEq(pool.escrow(tethId), amountWei, "escrow credited");
        assertEq(uint256(pool.depositStatus(depositId)), 2, "deposit consumed by the settle");
        assertEq(pool.nextLeafIndex(), 1, "recipient note leaf inserted");
        assertEq(address(router).balance, 0, "router holds no ETH after");
    }

    // ──────────────────── Public AMM swap (gasless approve) ────────────────────

    uint32 constant FEE_BPS = 30;

    /// Register a second token + seed a USDC/TOK public pool (this contract funds both legs), so the router
    /// has live reserves to swap against. Returns the output token + its asset id.
    function _seedPool() internal returns (MockUSDC tok, bytes32 tokId) {
        tok = new MockUSDC();
        tokId = pool.registerWrapped(address(tok), 1, bytes32(0), "Tok", "TOK", 6);
        uint256 seed = 1_000_000;
        usdc.mint(address(this), seed);
        tok.mint(address(this), seed);
        usdc.approve(address(pool), type(uint256).max);
        tok.approve(address(pool), type(uint256).max);
        pool.createPairAndAddLiquidityPublic(assetId, tokId, FEE_BPS, seed, seed, 0, 0, address(this));
    }

    function test_swapPublicWithPermit() public {
        (MockUSDC tok,) = _seedPool();
        uint256 amountIn = 1000;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign2612(amountIn, deadline);

        vm.prank(user);
        uint256 out = router.swapPublicWithPermit(
            address(usdc), address(tok), FEE_BPS, amountIn, 900, uint64(deadline), user, v, r, s
        );

        assertGe(out, 900, "output >= minOut (slippage honored)");
        assertEq(usdc.balanceOf(user), 10_000 - amountIn, "user paid exactly amountIn");
        assertEq(tok.balanceOf(user), out, "swap output sent straight to the user");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no input");
        assertEq(tok.balanceOf(address(router)), 0, "router holds no output");
    }

    function test_swapPublicWithPermit2() public {
        (MockUSDC tok,) = _seedPool();
        uint256 amountIn = 1000;
        uint64 deadline = uint64(block.timestamp + 1 hours);

        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max); // one-time Permit2 setup
        IPermit2.PermitSingle memory ps = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({
                token: address(usdc),
                amount: uint160(amountIn),
                expiration: uint48(deadline),
                nonce: 0
            }),
            spender: address(router),
            sigDeadline: deadline
        });

        vm.prank(user);
        uint256 out =
            router.swapPublicWithPermit2(address(usdc), address(tok), FEE_BPS, amountIn, 900, deadline, user, ps, hex"");

        assertGe(out, 900, "output >= minOut");
        assertEq(tok.balanceOf(user), out, "swap output sent to the user");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no input");
    }

    // ──────────────────── Public AMM liquidity (gasless approve) ────────────────────

    function _poolId(bytes32 a, bytes32 b, uint32 feeBps) internal pure returns (bytes32) {
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encodePacked(lo, hi, uint256(feeBps)));
    }

    function _permitBatch(address tA, uint256 aA, address tB, uint256 aB, uint64 deadline)
        internal
        view
        returns (IPermit2.PermitBatch memory pb)
    {
        IPermit2.PermitDetails[] memory dets = new IPermit2.PermitDetails[](2);
        dets[0] = IPermit2.PermitDetails({token: tA, amount: uint160(aA), expiration: uint48(deadline), nonce: 0});
        dets[1] = IPermit2.PermitDetails({token: tB, amount: uint160(aB), expiration: uint48(deadline), nonce: 0});
        pb = IPermit2.PermitBatch({details: dets, spender: address(router), sigDeadline: deadline});
    }

    function test_addLiquidityPublicWithPermit2_firstAdd_createsPool() public {
        MockUSDC tok = new MockUSDC();
        bytes32 tokId = pool.registerWrapped(address(tok), 1, bytes32(0), "Tok", "TOK", 6);
        uint256 amtA = 1000;
        uint256 amtB = 4000; // isqrt(1000*4000)=2000 ⇒ shares = 2000 - MINIMUM_LIQUIDITY(1000) = 1000
        tok.mint(user, amtB);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.startPrank(user);
        usdc.approve(address(permit2), type(uint256).max);
        tok.approve(address(permit2), type(uint256).max);
        vm.stopPrank();

        vm.prank(user);
        uint256 shares = router.addLiquidityPublicWithPermit2(
            address(usdc), address(tok), FEE_BPS, amtA, amtB, 0, deadline, user,
            _permitBatch(address(usdc), amtA, address(tok), amtB, deadline), hex""
        );

        assertEq(shares, 1000, "first-add shares = isqrt - MINIMUM_LIQUIDITY");
        assertEq(pool.lpShares(_poolId(assetId, tokId, FEE_BPS), user), shares, "shares credited to the user");
        assertEq(usdc.balanceOf(user), 10_000 - amtA, "user paid amtA");
        assertEq(tok.balanceOf(user), 0, "user paid amtB (first add consumes both legs fully)");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no tokenA");
        assertEq(tok.balanceOf(address(router)), 0, "router holds no tokenB");
    }

    function test_addLiquidityPublicWithPermit2_forwardsRefund() public {
        // seed a 1:1 pool from this contract so the user's add is a (proportional) later add
        MockUSDC tok = new MockUSDC();
        bytes32 tokId = pool.registerWrapped(address(tok), 1, bytes32(0), "Tok", "TOK", 6);
        uint256 seed = 1_000_000;
        usdc.mint(address(this), seed);
        tok.mint(address(this), seed);
        usdc.approve(address(pool), type(uint256).max);
        tok.approve(address(pool), type(uint256).max);
        pool.createPairAndAddLiquidityPublic(assetId, tokId, FEE_BPS, seed, seed, 0, 0, address(this));

        // user adds OFF-RATIO (2000 USDC + 1000 TOK into a 1:1 pool) → ~1000 USDC excess must be refunded
        uint256 amtA = 2000;
        uint256 amtB = 1000;
        tok.mint(user, amtB);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.startPrank(user);
        usdc.approve(address(permit2), type(uint256).max);
        tok.approve(address(permit2), type(uint256).max);
        vm.stopPrank();

        vm.prank(user);
        uint256 shares = router.addLiquidityPublicWithPermit2(
            address(usdc), address(tok), FEE_BPS, amtA, amtB, 0, deadline, user,
            _permitBatch(address(usdc), amtA, address(tok), amtB, deadline), hex""
        );

        assertGt(shares, 0, "shares minted");
        // TOK is the limiting leg (1000); the 1000 USDC excess is refunded by the pool and forwarded to the user
        assertEq(usdc.balanceOf(user), 10_000 - 1000, "off-ratio USDC excess refunded (net 1000 spent)");
        assertEq(tok.balanceOf(user), 0, "TOK fully used");
        assertEq(usdc.balanceOf(address(router)), 0, "router forwarded the refund, holds nothing");
        assertEq(tok.balanceOf(address(router)), 0, "router holds no TOK");
    }
}
