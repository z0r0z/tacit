// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CollateralEngine} from "../src/CollateralEngine.sol";
import {ConfidentialPool, CdpLeg} from "../src/ConfidentialPool.sol";
import {PoolStateReader} from "./PoolStateReader.sol";

using PoolStateReader for ConfidentialPool;
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

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// Minimal zRouter stand-in: simulates an aggregator swap by delivering the OUTPUT token to the caller (the
/// ConfidentialRouter). `swapETHForToken` keeps the forwarded ETH and mints `outAmount` of `tokenOut`;
/// `swapTokenForToken` pulls `inAmount` of `tokenIn` (via the router's standing approval) then mints
/// `outAmount` of `tokenOut`. The router gates on its OWN balance delta, so where the mock sends output is
/// what's checked — exactly the property under test. The test picks `outAmount` to model an exact, an
/// over-, or a short swap.
contract MockZRouter {
    function swapETHForToken(address tokenOut, uint256 outAmount) external payable {
        try IMintable(tokenOut).mint(msg.sender, outAmount) {}
        catch {
            SafeTransferLib.safeTransfer(tokenOut, msg.sender, outAmount);
        }
    }

    function swapTokenForToken(address tokenIn, uint256 inAmount, address tokenOut, uint256 outAmount) external {
        SafeTransferLib.safeTransferFrom(tokenIn, msg.sender, address(this), inAmount);
        try IMintable(tokenOut).mint(msg.sender, outAmount) {}
        catch {
            SafeTransferLib.safeTransfer(tokenOut, msg.sender, outAmount);
        }
    }
}

contract MockCdpController {
    uint256 public mintCalls;
    uint256 public lastDebtValue;
    bytes32 public lastPositionLeaf;
    bytes32 public lastLegAsset;
    uint256 public lastLegValue;

    function onCdpMint(CdpLeg[] calldata legs, uint256 debtValue, bytes32 positionLeaf, uint256) external {
        mintCalls++;
        lastDebtValue = debtValue;
        lastPositionLeaf = positionLeaf;
        if (legs.length != 0) {
            lastLegAsset = legs[0].asset;
            lastLegValue = legs[0].value;
        }
    }

    function onCdpClose(uint256, uint256, uint256, CdpLeg[] calldata, bytes32) external {}
    function onCdpLiquidate(CdpLeg[] calldata, uint256, uint256, uint256, bytes32) external {}
    function onCdpTopup(CdpLeg[] calldata, CdpLeg[] calldata, uint256, uint256, bytes32, bytes32) external {}
}

contract ConfidentialRouterTest is Test {
    ConfidentialPool pool;
    ConfidentialRouter router;
    ConfidentialRouter zapRouter; // wired to a live MockZRouter (the bare `router` has zRouter off)
    MockZRouter zr;
    MockUSDC usdc;
    MockPermit2 permit2;
    bytes32 assetId;

    uint256 constant USER_PK = 0xA11CE;
    uint256 constant RAY = 1e27;
    address user;
    bytes32 constant COMMIT = keccak256("user-note-commitment");
    uint256 constant AMOUNT = 1000;
    // The tETH shared cross-chain id — the pool keys native ETH (tETH) under this shared id.
    bytes32 constant TETH_LINK = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant CBTC_ZK_ASSET_ID = 0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8;

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
        // A second router wired to a live MockZRouter, for the zap family (the bare `router` keeps zRouter off).
        zr = new MockZRouter();
        zapRouter = new ConfidentialRouter(address(pool), address(zr), address(permit2));

        usdc.mint(user, 10_000);
    }

    function test_constructor_rejects_bad_targets() public {
        vm.expectRevert(ConfidentialRouter.BadTarget.selector);
        new ConfidentialRouter(address(0), address(0), address(permit2));

        vm.expectRevert(ConfidentialRouter.BadTarget.selector);
        new ConfidentialRouter(address(pool), address(0xBEEF), address(permit2));

        vm.expectRevert(ConfidentialRouter.BadTarget.selector);
        new ConfidentialRouter(address(pool), address(0), address(0xBEEF));
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
                token: address(usdc), amount: uint160(AMOUNT), expiration: uint48(block.timestamp + 1 hours), nonce: 0
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
    // CP-04: the memoRoot the guest commits — keccak chain over keccak(memo_i) for each note then lock leaf.
    function _memoRoot(uint256 need, bytes[] memory memos) internal pure returns (bytes32 mr) {
        for (uint256 i; i < need; ++i) {
            mr = keccak256(abi.encodePacked(mr, keccak256(i < memos.length ? memos[i] : bytes(""))));
        }
    }

    function _privatePaymentPv(bytes32 depositId, bytes32 leaf, bytes[] memory memos) internal view returns (bytes memory) {
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.depositsConsumed = new bytes32[](1);
        pv.depositsConsumed[0] = depositId;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = leaf;
        pv.memoRoot = _memoRoot(pv.leaves.length + pv.lockLeaves.length, memos);
        return abi.encode(pv);
    }

    function _cdpMintPv(
        bytes32 depositId,
        bytes32 debtLeaf,
        MockCdpController controller,
        bytes32 collateralAsset,
        uint256 collateralValue,
        uint256 debtValue,
        bytes32 positionLeaf,
        bytes[] memory memos
    ) internal view returns (bytes memory) {
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.depositsConsumed = new bytes32[](1);
        pv.depositsConsumed[0] = depositId;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = debtLeaf;
        pv.cdpMints = new ConfidentialPool.CdpMint[](1);
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: collateralAsset, value: collateralValue});
        pv.cdpMints[0] = ConfidentialPool.CdpMint({
            controller: address(controller),
            debtAsset: keccak256(abi.encodePacked("tacit-cdp-debt-v1", address(controller))),
            debtValue: debtValue,
            positionLeaf: positionLeaf,
            rateSnapshot: RAY,
            legs: legs,
            owner: bytes32(0)
        });
        pv.memoRoot = _memoRoot(pv.leaves.length + pv.lockLeaves.length, memos);
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
            address(usdc), AMOUNT, bobCommit, deadline, v, r, s, _privatePaymentPv(depositId, bobLeaf, memos), hex"", memos, address(0)
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
                token: address(usdc), amount: uint160(AMOUNT), expiration: uint48(block.timestamp + 1 hours), nonce: 0
            }),
            spender: address(router),
            sigDeadline: block.timestamp + 1 hours
        });

        vm.prank(user);
        router.wrapAndSettleWithPermit2(
            address(usdc), AMOUNT, bobCommit, ps, hex"", _privatePaymentPv(depositId, bobLeaf, memos), hex"", memos, address(0)
        );

        assertEq(pool.escrow(assetId), AMOUNT, "escrow credited");
        assertEq(uint256(pool.depositStatus(depositId)), 2, "deposit consumed");
        assertEq(pool.nextLeafIndex(), 1, "recipient note leaf inserted");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing after");
    }

    function test_wrapAndSettle_rejectsNonEmptySettlerFee() public {
        // A router-relayed settle is fee-free by construction (the router is the settler). A batch carrying a
        // fees leg would pay the router and strand a non-input-asset fee, so it must fail closed.
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        bytes32 bobCommit = keccak256("bob-fee-commit");
        bytes32 depositId = keccak256(abi.encode(assetId, AMOUNT, bobCommit));

        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.depositsConsumed = new bytes32[](1);
        pv.depositsConsumed[0] = depositId;
        pv.fees = new ConfidentialPool.FeePayment[](1);
        pv.fees[0] = ConfidentialPool.FeePayment({assetId: assetId, value: 1});

        bytes[] memory memos = new bytes[](1);
        memos[0] = abi.encodePacked(bytes32("ephemeralPub"), bytes32("ct"));

        IPermit2.PermitSingle memory ps = IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({
                token: address(usdc), amount: uint160(AMOUNT), expiration: uint48(block.timestamp + 1 hours), nonce: 0
            }),
            spender: address(router),
            sigDeadline: block.timestamp + 1 hours
        });

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadProofIntent.selector);
        router.wrapAndSettleWithPermit2(address(usdc), AMOUNT, bobCommit, ps, hex"", abi.encode(pv), hex"", memos, address(0));
    }

    function test_wrapAndMintCusdWithPermit_cdpOpen() public {
        MockCdpController controller = new MockCdpController();
        bytes32 commit = keccak256("cdp-collateral-commit");
        bytes32 debtLeaf = keccak256("cdp-cusd-note");
        bytes32 positionLeaf = keccak256("cdp-position-leaf");
        bytes32 depositId = keccak256(abi.encode(assetId, AMOUNT, commit));
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign2612(AMOUNT, deadline);

        vm.prank(user);
        router.wrapAndMintCusdWithPermit(
            address(usdc),
            AMOUNT,
            commit,
            deadline,
            v,
            r,
            s,
            _cdpMintPv(depositId, debtLeaf, controller, assetId, AMOUNT, 500, positionLeaf, _memos()),
            hex"",
            _memos()
        );

        assertEq(uint256(pool.depositStatus(depositId)), 2, "collateral deposit consumed by CDP proof");
        assertEq(pool.nextLeafIndex(), 1, "cUSD debt note inserted");
        assertEq(controller.mintCalls(), 1, "controller policy hook called");
        assertEq(controller.lastDebtValue(), 500, "debt value passed to controller");
        assertEq(controller.lastPositionLeaf(), positionLeaf, "position leaf passed to controller");
        assertEq(controller.lastLegAsset(), assetId, "collateral asset passed to controller");
        assertEq(controller.lastLegValue(), AMOUNT, "collateral value passed to controller");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no collateral");
    }

    function test_wrapAndMintCusdWithPermit2_cdpOpen() public {
        MockCdpController controller = new MockCdpController();
        bytes32 commit = keccak256("cdp-p2-collateral");
        bytes32 depositId = keccak256(abi.encode(assetId, AMOUNT, commit));
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        vm.prank(user);
        router.wrapAndMintCusdWithPermit2(
            address(usdc),
            AMOUNT,
            commit,
            _permitSingle(address(usdc), AMOUNT, address(router)),
            hex"",
            _cdpMintPv(depositId, keccak256("cdp-p2-debt"), controller, assetId, AMOUNT, 500, keccak256("cdp-p2-pos"), _memos()),
            hex"",
            _memos()
        );

        assertEq(uint256(pool.depositStatus(depositId)), 2, "collateral deposit consumed");
        assertEq(controller.mintCalls(), 1, "controller called");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no collateral");
    }

    function test_wrapAndMintCusd_rejectsPlainPaymentProof() public {
        bytes32 commit = keccak256("not-cdp-collateral");
        bytes32 depositId = keccak256(abi.encode(assetId, AMOUNT, commit));
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadProofIntent.selector);
        router.wrapAndMintCusdWithPermit2(
            address(usdc),
            AMOUNT,
            commit,
            _permitSingle(address(usdc), AMOUNT, address(router)),
            hex"",
            _privatePaymentPv(depositId, keccak256("plain-payment-leaf"), _memos()),
            hex"",
            _memos()
        );

        assertEq(pool.escrow(assetId), 0, "guard trips before wrapping collateral");
        assertEq(usdc.balanceOf(user), 10_000, "user token balance unchanged");
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

    /// tETH's asset id — the pool keys native ETH (tETH) under its shared cross-chain link.
    function _tethId() internal pure returns (bytes32) {
        return TETH_LINK;
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
        router.wrapAndSettleETH{value: amountWei}(amountWei, bobCommit, _privatePaymentPv(depositId, bobLeaf, memos), hex"", memos, address(0));

        assertEq(pool.escrow(tethId), amountWei, "escrow credited");
        assertEq(uint256(pool.depositStatus(depositId)), 2, "deposit consumed by the settle");
        assertEq(pool.nextLeafIndex(), 1, "recipient note leaf inserted");
        assertEq(address(router).balance, 0, "router holds no ETH after");
    }

    function test_wrapAndSettleETH_skimsFeeOnTop() public {
        uint256 amountWei = 1e15;
        uint256 fee = 3e13; // ETH fee on top of the wrap amount
        bytes32 tethId = _tethId();
        bytes32 bobCommit = keccak256("eth-fee-commit");
        bytes32 bobLeaf = keccak256("eth-fee-leaf");
        bytes32 depositId = keccak256(abi.encode(tethId, amountWei / 1e10, bobCommit));
        bytes[] memory memos = new bytes[](1);
        memos[0] = abi.encodePacked(bytes32("eph"), bytes32("ct"));
        address feeRecipient = address(0xFEE);
        vm.deal(user, 1 ether);

        vm.prank(user);
        router.wrapAndSettleETH{value: amountWei + fee}(
            amountWei, bobCommit, _privatePaymentPv(depositId, bobLeaf, memos), hex"", memos, feeRecipient
        );

        assertEq(pool.escrow(tethId), amountWei, "only the wrap amount is escrowed (fee is on top)");
        assertEq(uint256(pool.depositStatus(depositId)), 2, "deposit consumed by the settle");
        assertEq(feeRecipient.balance, fee, "fee skimmed to the caller-named recipient");
        assertEq(address(router).balance, 0, "router holds no ETH after");
    }

    function test_wrapETHAndMintCusd_cdpOpen() public {
        MockCdpController controller = new MockCdpController();
        uint256 amountWei = 1e15;
        uint256 collateralValue = amountWei / 1e10;
        bytes32 tethId = _tethId();
        bytes32 commit = keccak256("eth-cdp-collateral");
        bytes32 depositId = keccak256(abi.encode(tethId, collateralValue, commit));
        vm.deal(user, 1 ether);

        vm.prank(user);
        router.wrapETHAndMintCusd{value: amountWei}(
            commit,
            _cdpMintPv(
                depositId,
                keccak256("eth-cdp-debt"),
                controller,
                tethId,
                collateralValue,
                50_000,
                keccak256("eth-cdp-position")
            , _memos()),
            hex"",
            _memos()
        );

        assertEq(uint256(pool.depositStatus(depositId)), 2, "tETH collateral deposit consumed");
        assertEq(controller.mintCalls(), 1, "controller called");
        assertEq(controller.lastLegAsset(), tethId, "tETH collateral passed to controller");
        assertEq(controller.lastLegValue(), collateralValue, "scaled tETH value passed to controller");
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
                token: address(usdc), amount: uint160(amountIn), expiration: uint48(deadline), nonce: 0
            }),
            spender: address(router),
            sigDeadline: deadline
        });

        vm.prank(user);
        uint256 out = router.swapPublicWithPermit2(
            address(usdc), address(tok), FEE_BPS, amountIn, 900, deadline, user, ps, hex""
        );

        assertGe(out, 900, "output >= minOut");
        assertEq(tok.balanceOf(user), out, "swap output sent to the user");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no input");
    }

    function test_swapPublicExactOutWithPermit2_pullsOnlyNeededInput() public {
        (MockUSDC tok,) = _seedPool();
        uint256 desiredOut = 900;
        uint256 maxAmountIn = 2000;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        vm.prank(user);
        (uint256 amountIn, uint256 amountOut) = router.swapPublicExactOutWithPermit2(
            address(tok),
            FEE_BPS,
            desiredOut,
            maxAmountIn,
            deadline,
            user,
            _permitSingle(address(usdc), maxAmountIn, address(router)),
            hex""
        );

        assertLe(amountIn, maxAmountIn, "input bounded by max");
        assertGe(amountOut, desiredOut, "desired output satisfied");
        assertEq(usdc.balanceOf(user), 10_000 - amountIn, "only needed input pulled");
        assertEq(tok.balanceOf(user), amountOut, "output sent to user");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no input");
        assertEq(tok.balanceOf(address(router)), 0, "router holds no output");
    }

    function test_swapPublicExactOutWithPermit2_revertsZeroOutAndMaxExceeded() public {
        (MockUSDC tok,) = _seedPool();
        uint64 deadline = uint64(block.timestamp + 1 hours);

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadPath.selector);
        router.swapPublicExactOutWithPermit2(
            address(tok), FEE_BPS, 0, 2000, deadline, user, _permitSingle(address(usdc), 2000, address(router)), hex""
        );

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.MaxAmountExceeded.selector);
        router.swapPublicExactOutWithPermit2(
            address(tok), FEE_BPS, 900, 1, deadline, user, _permitSingle(address(usdc), 1, address(router)), hex""
        );
    }

    function test_swapPublicETH() public {
        MockUSDC tok = new MockUSDC();
        bytes32 tokId = pool.registerWrapped(address(tok), 1, bytes32(0), "Tok", "TOK", 6);
        uint256 ethSeed = 2e15; // tETH value 200_000
        uint256 tokSeed = 200_000;
        tok.mint(address(this), tokSeed);
        tok.approve(address(pool), type(uint256).max);
        pool.createPairAndAddLiquidityPublic{value: ethSeed}(
            _tethId(), tokId, FEE_BPS, ethSeed, tokSeed, 0, 0, address(this)
        );

        vm.deal(user, 1 ether);
        vm.prank(user);
        uint256 out =
            router.swapPublicETH{value: 1e15}(address(tok), FEE_BPS, 1, uint64(block.timestamp + 1 hours), user);

        assertGt(out, 0, "ETH public swap returns output");
        assertEq(tok.balanceOf(user), out, "output sent directly to user");
        assertEq(address(router).balance, 0, "router holds no ETH");
        assertEq(tok.balanceOf(address(router)), 0, "router holds no output");
    }

    function test_swapPublicETHExactOut_refundsExcessValue() public {
        MockUSDC tok = new MockUSDC();
        bytes32 tokId = pool.registerWrapped(address(tok), 1, bytes32(0), "Tok", "TOK", 6);
        uint256 ethSeed = 2e15;
        uint256 tokSeed = 200_000;
        tok.mint(address(this), tokSeed);
        tok.approve(address(pool), type(uint256).max);
        pool.createPairAndAddLiquidityPublic{value: ethSeed}(
            _tethId(), tokId, FEE_BPS, ethSeed, tokSeed, 0, 0, address(this)
        );

        uint256 desiredOut = 50_000;
        vm.deal(user, 1 ether);
        vm.prank(user);
        (uint256 amountIn, uint256 amountOut) = router.swapPublicETHExactOut{value: 1e15}(
            address(tok), FEE_BPS, desiredOut, uint64(block.timestamp + 1 hours), user
        );

        assertLt(amountIn, 1e15, "did not spend whole msg.value");
        assertGe(amountOut, desiredOut, "desired output satisfied");
        assertEq(user.balance, 1 ether - amountIn, "excess ETH refunded");
        assertEq(tok.balanceOf(user), amountOut, "output sent to user");
        assertEq(address(router).balance, 0, "router holds no ETH");
    }

    function test_swapPublicPathWithPermit2_multihop() public {
        MockUSDC mid = new MockUSDC();
        MockUSDC out = new MockUSDC();
        bytes32 midId = pool.registerWrapped(address(mid), 1, bytes32(0), "Mid", "MID", 6);
        bytes32 outId = pool.registerWrapped(address(out), 1, bytes32(0), "Out", "OUT", 6);
        uint256 seed = 1_000_000;
        usdc.mint(address(this), seed);
        mid.mint(address(this), seed * 2);
        out.mint(address(this), seed);
        usdc.approve(address(pool), type(uint256).max);
        mid.approve(address(pool), type(uint256).max);
        out.approve(address(pool), type(uint256).max);
        pool.createPairAndAddLiquidityPublic(assetId, midId, FEE_BPS, seed, seed, 0, 0, address(this));
        pool.createPairAndAddLiquidityPublic(midId, outId, FEE_BPS, seed, seed, 0, 0, address(this));

        uint256 amountIn = 1000;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        address[] memory path = new address[](2);
        path[0] = address(mid);
        path[1] = address(out);
        uint32[] memory fees = new uint32[](2);
        fees[0] = FEE_BPS;
        fees[1] = FEE_BPS;
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        vm.prank(user);
        uint256 got = router.swapPublicPathWithPermit2(
            path, fees, amountIn, 1, deadline, user, _permitSingle(address(usdc), amountIn, address(router)), hex""
        );

        assertGt(got, 0, "multihop returns final output");
        assertEq(out.balanceOf(user), got, "final output sent to user");
        assertEq(usdc.balanceOf(user), 10_000 - amountIn, "user paid input");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no input");
        assertEq(mid.balanceOf(address(router)), 0, "router holds no intermediate");
        assertEq(out.balanceOf(address(router)), 0, "router holds no output");
    }

    function test_swapPublicPathWithPermit2_rejectsMalformedPath() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        IPermit2.PermitSingle memory ps = _permitSingle(address(usdc), 1000, address(router));

        address[] memory emptyPath = new address[](0);
        uint32[] memory emptyFees = new uint32[](0);
        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadPath.selector);
        router.swapPublicPathWithPermit2(emptyPath, emptyFees, 1000, 1, deadline, user, ps, hex"");

        address[] memory path = new address[](1);
        path[0] = address(usdc);
        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadPath.selector);
        router.swapPublicPathWithPermit2(path, emptyFees, 1000, 1, deadline, user, ps, hex"");

        uint32[] memory fees = new uint32[](1);
        fees[0] = FEE_BPS;
        path[0] = address(0);
        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadPath.selector);
        router.swapPublicPathWithPermit2(path, fees, 1000, 1, deadline, user, ps, hex"");

        path[0] = address(usdc);
        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadPath.selector);
        router.swapPublicPathWithPermit2(path, fees, 1000, 1, deadline, address(router), ps, hex"");
    }

    function test_swapPublicPathExactOutWithPermit2_multihopPullsOnlyNeededInput() public {
        MockUSDC mid = new MockUSDC();
        MockUSDC out = new MockUSDC();
        bytes32 midId = pool.registerWrapped(address(mid), 1, bytes32(0), "Mid", "MID", 6);
        bytes32 outId = pool.registerWrapped(address(out), 1, bytes32(0), "Out", "OUT", 6);
        uint256 seed = 1_000_000;
        usdc.mint(address(this), seed);
        mid.mint(address(this), seed * 2);
        out.mint(address(this), seed);
        usdc.approve(address(pool), type(uint256).max);
        mid.approve(address(pool), type(uint256).max);
        out.approve(address(pool), type(uint256).max);
        pool.createPairAndAddLiquidityPublic(assetId, midId, FEE_BPS, seed, seed, 0, 0, address(this));
        pool.createPairAndAddLiquidityPublic(midId, outId, FEE_BPS, seed, seed, 0, 0, address(this));

        address[] memory path = new address[](2);
        path[0] = address(mid);
        path[1] = address(out);
        uint32[] memory fees = new uint32[](2);
        fees[0] = FEE_BPS;
        fees[1] = FEE_BPS;
        uint256 desiredOut = 750;
        uint256 maxAmountIn = 2500;
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        vm.prank(user);
        (uint256 amountIn, uint256 amountOut) = router.swapPublicPathExactOutWithPermit2(
            path,
            fees,
            desiredOut,
            maxAmountIn,
            uint64(block.timestamp + 1 hours),
            user,
            _permitSingle(address(usdc), maxAmountIn, address(router)),
            hex""
        );

        assertLe(amountIn, maxAmountIn, "input bounded by max");
        assertGe(amountOut, desiredOut, "desired final output satisfied");
        assertEq(usdc.balanceOf(user), 10_000 - amountIn, "only needed input pulled");
        assertEq(out.balanceOf(user), amountOut, "final output sent to user");
        assertEq(mid.balanceOf(address(router)), 0, "router holds no intermediate");
    }

    function test_swapPublicETHPath_multihop() public {
        MockUSDC mid = new MockUSDC();
        MockUSDC out = new MockUSDC();
        bytes32 midId = pool.registerWrapped(address(mid), 1, bytes32(0), "Mid", "MID", 6);
        bytes32 outId = pool.registerWrapped(address(out), 1, bytes32(0), "Out", "OUT", 6);
        uint256 ethSeed = 2e15;
        uint256 seed = 200_000;
        mid.mint(address(this), seed * 2);
        out.mint(address(this), seed);
        mid.approve(address(pool), type(uint256).max);
        out.approve(address(pool), type(uint256).max);
        pool.createPairAndAddLiquidityPublic{value: ethSeed}(
            _tethId(), midId, FEE_BPS, ethSeed, seed, 0, 0, address(this)
        );
        pool.createPairAndAddLiquidityPublic(midId, outId, FEE_BPS, seed, seed, 0, 0, address(this));

        address[] memory path = new address[](2);
        path[0] = address(mid);
        path[1] = address(out);
        uint32[] memory fees = new uint32[](2);
        fees[0] = FEE_BPS;
        fees[1] = FEE_BPS;
        vm.deal(user, 1 ether);

        vm.prank(user);
        uint256 got = router.swapPublicETHPath{value: 1e15}(path, fees, 1, uint64(block.timestamp + 1 hours), user);

        assertGt(got, 0, "ETH multihop returns final output");
        assertEq(out.balanceOf(user), got, "final output sent to user");
        assertEq(address(router).balance, 0, "router holds no ETH");
        assertEq(mid.balanceOf(address(router)), 0, "router holds no intermediate");
        assertEq(out.balanceOf(address(router)), 0, "router holds no output");
    }

    function test_swapPublicETHPathExactOut_multihopRefundsExcessValue() public {
        MockUSDC mid = new MockUSDC();
        MockUSDC out = new MockUSDC();
        bytes32 midId = pool.registerWrapped(address(mid), 1, bytes32(0), "Mid", "MID", 6);
        bytes32 outId = pool.registerWrapped(address(out), 1, bytes32(0), "Out", "OUT", 6);
        uint256 ethSeed = 2e15;
        uint256 seed = 200_000;
        mid.mint(address(this), seed * 2);
        out.mint(address(this), seed);
        mid.approve(address(pool), type(uint256).max);
        out.approve(address(pool), type(uint256).max);
        pool.createPairAndAddLiquidityPublic{value: ethSeed}(
            _tethId(), midId, FEE_BPS, ethSeed, seed, 0, 0, address(this)
        );
        pool.createPairAndAddLiquidityPublic(midId, outId, FEE_BPS, seed, seed, 0, 0, address(this));

        address[] memory path = new address[](2);
        path[0] = address(mid);
        path[1] = address(out);
        uint32[] memory fees = new uint32[](2);
        fees[0] = FEE_BPS;
        fees[1] = FEE_BPS;
        uint256 desiredOut = 750;
        uint256 maxValue = 1e15;
        vm.deal(user, 1 ether);

        vm.prank(user);
        (uint256 amountIn, uint256 amountOut) = router.swapPublicETHPathExactOut{value: maxValue}(
            path, fees, desiredOut, uint64(block.timestamp + 1 hours), user
        );

        assertLt(amountIn, maxValue, "only needed ETH forwarded");
        assertGe(amountOut, desiredOut, "desired final output satisfied");
        assertEq(address(user).balance, 1 ether - amountIn, "excess ETH refunded");
        assertEq(out.balanceOf(user), amountOut, "final output sent to user");
        assertEq(address(router).balance, 0, "router holds no ETH");
        assertEq(mid.balanceOf(address(router)), 0, "router holds no intermediate");
        assertEq(out.balanceOf(address(router)), 0, "router holds no output");
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
            address(usdc),
            address(tok),
            FEE_BPS,
            amtA,
            amtB,
            0,
            deadline,
            user,
            _permitBatch(address(usdc), amtA, address(tok), amtB, deadline),
            hex""
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
            address(usdc),
            address(tok),
            FEE_BPS,
            amtA,
            amtB,
            0,
            deadline,
            user,
            _permitBatch(address(usdc), amtA, address(tok), amtB, deadline),
            hex""
        );

        assertGt(shares, 0, "shares minted");
        // TOK is the limiting leg (1000); the 1000 USDC excess is refunded by the pool and forwarded to the user
        assertEq(usdc.balanceOf(user), 10_000 - 1000, "off-ratio USDC excess refunded (net 1000 spent)");
        assertEq(tok.balanceOf(user), 0, "TOK fully used");
        assertEq(usdc.balanceOf(address(router)), 0, "router forwarded the refund, holds nothing");
        assertEq(tok.balanceOf(address(router)), 0, "router holds no TOK");
    }

    function test_addLiquidityPublicWithPermit2_revertsAmountTooLarge() public {
        IPermit2.PermitBatch memory pb;

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.AmountTooLarge.selector);
        router.addLiquidityPublicWithPermit2(
            address(usdc),
            address(usdc),
            FEE_BPS,
            uint256(type(uint160).max) + 1,
            1,
            0,
            uint64(block.timestamp + 1 hours),
            user,
            pb,
            hex""
        );
    }

    function test_addLiquidityPublicETHWithPermit2_addsEthTokenAndRefunds() public {
        MockUSDC tok = new MockUSDC();
        bytes32 tokId = pool.registerWrapped(address(tok), 1, bytes32(0), "Tok", "TOK", 6);
        uint256 tokenAmount = 4000;
        tok.mint(user, tokenAmount);
        vm.deal(user, 1 ether);
        vm.startPrank(user);
        tok.approve(address(permit2), type(uint256).max);
        vm.stopPrank();

        vm.prank(user);
        uint256 shares = router.addLiquidityPublicETHWithPermit2{value: 2e13}(
            address(tok),
            FEE_BPS,
            tokenAmount,
            0,
            uint64(block.timestamp + 1 hours),
            user,
            _permitSingle(address(tok), tokenAmount, address(router)),
            hex""
        );

        assertGt(shares, 0, "ETH/token shares minted");
        assertEq(pool.lpShares(_poolId(_tethId(), tokId, FEE_BPS), user), shares, "shares credited to user");
        assertEq(tok.balanceOf(user), 0, "token leg consumed");
        assertEq(tok.balanceOf(address(router)), 0, "router holds no token");
        assertEq(address(router).balance, 0, "router holds no ETH");
    }

    function test_removeLiquidityPublic_burnsApprovedUserShares() public {
        MockUSDC tok = new MockUSDC();
        bytes32 tokId = pool.registerWrapped(address(tok), 1, bytes32(0), "Tok", "TOK", 6);
        uint256 seed = 1_000_000;
        usdc.mint(user, seed);
        tok.mint(user, seed);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.startPrank(user);
        usdc.approve(address(permit2), type(uint256).max);
        tok.approve(address(permit2), type(uint256).max);
        uint256 shares = router.addLiquidityPublicWithPermit2(
            address(usdc),
            address(tok),
            FEE_BPS,
            seed,
            seed,
            0,
            deadline,
            user,
            _permitBatch(address(usdc), seed, address(tok), seed, deadline),
            hex""
        );
        vm.stopPrank();

        bytes32 poolId = _poolId(assetId, tokId, FEE_BPS);
        vm.prank(user);
        pool.approveLpOperator(address(router));
        uint256 usdcBefore = usdc.balanceOf(user);
        uint256 tokBefore = tok.balanceOf(user);

        vm.prank(user);
        (uint256 amountLo, uint256 amountHi) =
            router.removeLiquidityPublic(address(usdc), address(tok), FEE_BPS, shares, 0, 0, deadline, user);

        assertEq(pool.lpShares(poolId, user), 0, "user shares burned");
        assertGt(amountLo + amountHi, 0, "underlying returned");
        assertGt(usdc.balanceOf(user), usdcBefore, "USDC returned");
        assertGt(tok.balanceOf(user), tokBefore, "TOK returned");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC");
        assertEq(tok.balanceOf(address(router)), 0, "router holds no TOK");
    }

    function test_removeLiquidityPublic_revertsZeroRecipientAndMissingOperatorApproval() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadTarget.selector);
        router.removeLiquidityPublic(address(usdc), address(usdc), FEE_BPS, 1, 0, 0, deadline, address(0));

        MockUSDC tok = new MockUSDC();
        pool.registerWrapped(address(tok), 1, bytes32(0), "Tok", "TOK", 6);
        uint256 seed = 1_000_000;
        usdc.mint(user, seed);
        tok.mint(user, seed);
        vm.startPrank(user);
        usdc.approve(address(permit2), type(uint256).max);
        tok.approve(address(permit2), type(uint256).max);
        uint256 shares = router.addLiquidityPublicWithPermit2(
            address(usdc),
            address(tok),
            FEE_BPS,
            seed,
            seed,
            0,
            deadline,
            user,
            _permitBatch(address(usdc), seed, address(tok), seed, deadline),
            hex""
        );

        vm.expectRevert(ConfidentialPool.InsufficientLiquidity.selector);
        router.removeLiquidityPublic(address(usdc), address(tok), FEE_BPS, shares, 0, 0, deadline, user);
        vm.stopPrank();
    }

    // ──────────────────── Zaps (MockZRouter-backed) ────────────────────

    uint256 constant MINIMUM_LIQUIDITY = 1000; // mirrors the pool's locked floor (cold-add: isqrt(vA·vB) − MIN)

    /// Mirror of ConfidentialPool._lpShareId(poolId) = keccak(poolId ‖ "lp").
    function _lpShareId(bytes32 poolId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(poolId, bytes2(0x6c70)));
    }

    /// The deposit id shieldShares mints for an LP-share note: keccak(lpShareId ‖ shares ‖ commit).
    function _lpDepositId(bytes32 poolId, uint256 shares, bytes32 commit) internal pure returns (bytes32) {
        return keccak256(abi.encode(_lpShareId(poolId), shares, commit));
    }

    function _permitSingle(address token, uint256 amount, address spender)
        internal
        view
        returns (IPermit2.PermitSingle memory)
    {
        return IPermit2.PermitSingle({
            details: IPermit2.PermitDetails({
                token: token, amount: uint160(amount), expiration: uint48(block.timestamp + 1 hours), nonce: 0
            }),
            spender: spender,
            sigDeadline: block.timestamp + 1 hours
        });
    }

    function _registerTok(string memory sym) internal returns (MockUSDC tok, bytes32 tokId) {
        tok = new MockUSDC();
        tokId = pool.registerWrapped(address(tok), 1, bytes32(0), sym, sym, 6);
    }

    // ── plain zRouter swaps ──

    function test_swapETHViaZRouter_sendsOutputAndSweeps() public {
        (MockUSDC out,) = _registerTok("OUT");
        uint256 swapOut = 6000;
        vm.deal(user, 1 ether);
        bytes memory zrData = abi.encodeCall(MockZRouter.swapETHForToken, (address(out), swapOut));

        vm.prank(user);
        uint256 got = zapRouter.swapETHViaZRouter{value: 1e15}(address(out), 5000, user, zrData);

        assertEq(got, swapOut, "observed balance delta returned");
        assertEq(out.balanceOf(user), swapOut, "zRouter output delivered to user");
        assertEq(out.balanceOf(address(zapRouter)), 0, "router holds no OUT");
        assertEq(address(zapRouter).balance, 0, "router holds no ETH");
    }

    function test_swapTokenViaZRouterWithPermit2_sendsOutputAndSweeps() public {
        (MockUSDC out,) = _registerTok("OUT");
        uint256 amountIn = 2000;
        uint256 swapOut = 5000;
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);
        bytes memory zrData =
            abi.encodeCall(MockZRouter.swapTokenForToken, (address(usdc), amountIn, address(out), swapOut));

        vm.prank(user);
        uint256 got = zapRouter.swapTokenViaZRouterWithPermit2(
            address(out),
            amountIn,
            4000,
            user,
            _permitSingle(address(usdc), amountIn, address(zapRouter)),
            hex"",
            zrData
        );

        assertEq(got, swapOut, "observed balance delta returned");
        assertEq(usdc.balanceOf(user), 10_000 - amountIn, "user paid token input");
        assertEq(out.balanceOf(user), swapOut, "zRouter output delivered to user");
        assertEq(usdc.balanceOf(address(zapRouter)), 0, "router holds no input");
        assertEq(out.balanceOf(address(zapRouter)), 0, "router holds no output");
    }

    function test_zapETHToCdpMint_swapWrapSettle() public {
        (MockUSDC collateral, bytes32 collateralId) = _registerTok("COL");
        MockCdpController controller = new MockCdpController();
        uint256 wrapAmount = 1000;
        bytes32 commit = keccak256("eth-zap-cdp-collateral");
        bytes32 depositId = keccak256(abi.encode(collateralId, wrapAmount, commit));
        bytes memory zrData = abi.encodeCall(MockZRouter.swapETHForToken, (address(collateral), 1500));
        vm.deal(user, 1 ether);

        vm.prank(user);
        zapRouter.zapETHToCdpMint{value: 1e15}(
            address(collateral),
            wrapAmount,
            commit,
            zrData,
            _cdpMintPv(
                depositId,
                keccak256("zap-eth-cdp-debt"),
                controller,
                collateralId,
                wrapAmount,
                500,
                keccak256("zap-eth-cdp-pos")
            , _memos()),
            hex"",
            _memos()
        );

        assertEq(uint256(pool.depositStatus(depositId)), 2, "zapped collateral deposit consumed");
        assertEq(controller.mintCalls(), 1, "controller called");
        assertEq(controller.lastLegAsset(), collateralId, "collateral asset passed");
        assertEq(collateral.balanceOf(user), 500, "excess swap output refunded");
        assertEq(collateral.balanceOf(address(zapRouter)), 0, "router holds no collateral");
        assertEq(address(zapRouter).balance, 0, "router holds no ETH");
    }

    function test_zapTokenToCdpMintWithPermit2_swapWrapSettle() public {
        (MockUSDC collateral, bytes32 collateralId) = _registerTok("COL");
        MockCdpController controller = new MockCdpController();
        uint256 amountIn = 2000;
        uint256 wrapAmount = 1000;
        bytes32 commit = keccak256("token-zap-cdp-collateral");
        bytes32 depositId = keccak256(abi.encode(collateralId, wrapAmount, commit));
        bytes memory zrData =
            abi.encodeCall(MockZRouter.swapTokenForToken, (address(usdc), amountIn, address(collateral), 1500));
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        vm.prank(user);
        zapRouter.zapTokenToCdpMintWithPermit2(
            address(collateral),
            amountIn,
            wrapAmount,
            commit,
            _permitSingle(address(usdc), amountIn, address(zapRouter)),
            hex"",
            zrData,
            _cdpMintPv(
                depositId,
                keccak256("zap-token-cdp-debt"),
                controller,
                collateralId,
                wrapAmount,
                500,
                keccak256("zap-token-cdp-pos")
            , _memos()),
            hex"",
            _memos()
        );

        assertEq(uint256(pool.depositStatus(depositId)), 2, "zapped collateral deposit consumed");
        assertEq(controller.mintCalls(), 1, "controller called");
        assertEq(usdc.balanceOf(user), 10_000 - amountIn, "user paid zRouter input");
        assertEq(collateral.balanceOf(user), 500, "excess output refunded");
        assertEq(usdc.balanceOf(address(zapRouter)), 0, "router holds no input");
        assertEq(collateral.balanceOf(address(zapRouter)), 0, "router holds no collateral");
    }

    function test_swapViaZRouter_disabledTarget_reverts() public {
        (MockUSDC out,) = _registerTok("OUT");
        vm.deal(user, 1 ether);
        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadTarget.selector);
        router.swapETHViaZRouter{value: 1e15}(address(out), 0, user, hex"");
    }

    function test_swapViaZRouter_rejectsNativeOutputOrZeroRecipient() public {
        vm.deal(user, 1 ether);

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadTarget.selector);
        zapRouter.swapETHViaZRouter{value: 1e15}(address(0), 0, user, hex"");

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadTarget.selector);
        zapRouter.swapETHViaZRouter{value: 1e15}(address(usdc), 0, address(0), hex"");

        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadTarget.selector);
        zapRouter.swapTokenViaZRouterWithPermit2(
            address(0), 1, 0, user, _permitSingle(address(usdc), 1, address(zapRouter)), hex"", hex""
        );

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadTarget.selector);
        zapRouter.swapTokenViaZRouterWithPermit2(
            address(usdc), 1, 0, address(0), _permitSingle(address(usdc), 1, address(zapRouter)), hex"", hex""
        );
    }

    function _launchPool() internal returns (ConfidentialPool p, ConfidentialRouter r, bytes32 cusdId) {
        CanonicalAssetFactory factory = new CanonicalAssetFactory();
        CollateralEngine engine = new CollateralEngine(address(0), CBTC_ZK_ASSET_ID, 8, 8, address(this));
        p = new ConfidentialPool(
            address(new StubVerifier()),
            bytes32(uint256(0xBEEF)),
            bytes32(0),
            address(factory),
            address(0),
            bytes32(0),
            0,
            bytes32(0),
            TETH_LINK,
            address(engine)
        );
        r = new ConfidentialRouter(address(p), address(zr), address(permit2));
        cusdId = engine.CUSD_ASSET_ID();
    }

    function _mintCanonicalToZRouter(ConfidentialPool p, bytes32 canonAssetId, uint256 value) internal {
        ConfidentialPool.PublicValues memory pv;
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(p)));
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(canonAssetId, address(zr), value);
        p.settle(abi.encode(pv), hex"", new bytes[](0));
    }

    function test_zapETHToCanonicalNote_getsLaunchCbtc() public {
        (ConfidentialPool p, ConfidentialRouter r,) = _launchPool();
        bytes32 localCbtc = p.localAssetOf(CBTC_ZK_ASSET_ID);
        address cbtc = p.canonicalTokenFor(CBTC_ZK_ASSET_ID);
        assertTrue(localCbtc != bytes32(0), "shared cBTC id resolves to local pool asset");
        assertEq(p.canonicalTokenFor(localCbtc), cbtc, "local id resolves to same canonical token");

        uint256 wrapAmount = 1e10; // one sat-denominated cBTC value unit, scaled to the 18-dec canonical ERC20
        bytes32 commit = keccak256("launch-cbtc-note");
        _mintCanonicalToZRouter(p, CBTC_ZK_ASSET_ID, 1);
        assertEq(ERC20(cbtc).balanceOf(address(zr)), wrapAmount, "zRouter funded with canonical cBTC");

        vm.deal(user, 1 ether);
        bytes memory zrData = abi.encodeCall(MockZRouter.swapETHForToken, (cbtc, wrapAmount));

        vm.prank(user);
        r.zapETHToCanonicalNote{value: 1e15}(CBTC_ZK_ASSET_ID, wrapAmount, commit, zrData);

        assertEq(uint256(p.depositStatus(keccak256(abi.encode(localCbtc, 1, commit)))), 1, "local cBTC note pending");
        assertEq(ERC20(cbtc).balanceOf(address(zr)), 0, "zRouter paid output");
        assertEq(ERC20(cbtc).balanceOf(address(r)), 0, "router burned/wrapped cBTC");
        assertEq(ERC20(cbtc).totalSupply(), 0, "public cBTC supply re-entered confidential");
    }

    function test_zapTokenToCanonicalNoteWithPermit2_getsLaunchCusd() public {
        (ConfidentialPool p, ConfidentialRouter r, bytes32 cusdId) = _launchPool();
        bytes32 localCusd = p.localAssetOf(cusdId);
        address cusd = p.canonicalTokenFor(cusdId);
        assertTrue(localCusd != bytes32(0), "shared cUSD id resolves to local pool asset");
        assertEq(p.canonicalTokenFor(localCusd), cusd, "local id resolves to same canonical token");

        uint256 amountIn = 2000;
        uint256 wrapAmount = 1e10;
        bytes32 commit = keccak256("launch-cusd-note");
        _mintCanonicalToZRouter(p, cusdId, 1);
        bytes memory zrData = abi.encodeCall(MockZRouter.swapTokenForToken, (address(usdc), amountIn, cusd, wrapAmount));

        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        vm.prank(user);
        r.zapTokenToCanonicalNoteWithPermit2(
            cusdId, amountIn, wrapAmount, commit, _permitSingle(address(usdc), amountIn, address(r)), hex"", zrData
        );

        assertEq(uint256(p.depositStatus(keccak256(abi.encode(localCusd, 1, commit)))), 1, "local cUSD note pending");
        assertEq(usdc.balanceOf(user), 10_000 - amountIn, "user paid input token");
        assertEq(usdc.balanceOf(address(r)), 0, "router holds no input");
        assertEq(ERC20(cusd).balanceOf(address(r)), 0, "router burned/wrapped cUSD");
        assertEq(ERC20(cusd).totalSupply(), 0, "public cUSD supply re-entered confidential");
    }

    function _memos() internal pure returns (bytes[] memory memos) {
        memos = new bytes[](1);
        memos[0] = abi.encodePacked(bytes32("eph"), bytes32("ct"));
    }

    // ── swap-and-wrap into a confidential NOTE ──

    function test_zapETHToShieldedNote_swapsWrapsAndSweepsExcess() public {
        (MockUSDC out, bytes32 outId) = _registerTok("OUT");
        bytes32 commit = keccak256("out-note");
        uint256 wrapAmount = 5000;
        uint256 swapOut = 6000; // sources MORE than wrapAmount → the 1000 OUT excess returns to the caller
        vm.deal(user, 1 ether);
        bytes memory zrData = abi.encodeCall(MockZRouter.swapETHForToken, (address(out), swapOut));

        vm.prank(user);
        zapRouter.zapETHToShieldedNote{value: 1e15}(address(out), wrapAmount, commit, zrData);

        assertEq(
            uint256(pool.depositStatus(keccak256(abi.encode(outId, wrapAmount, commit)))), 1, "note deposit pending"
        );
        assertEq(pool.escrow(outId), wrapAmount, "exactly wrapAmount escrowed");
        assertEq(out.balanceOf(user), swapOut - wrapAmount, "OUT excess swept to the caller");
        assertEq(out.balanceOf(address(zapRouter)), 0, "router holds no OUT");
        assertEq(address(zapRouter).balance, 0, "router holds no ETH");
    }

    function test_zapETHToPayment_swapWrapSettle() public {
        (MockUSDC out, bytes32 outId) = _registerTok("OUT");
        bytes32 bobCommit = keccak256("bob-out");
        uint256 wrapAmount = 5000;
        bytes32 depositId = keccak256(abi.encode(outId, wrapAmount, bobCommit));
        vm.deal(user, 1 ether);
        bytes memory zrData = abi.encodeCall(MockZRouter.swapETHForToken, (address(out), wrapAmount));

        vm.prank(user);
        zapRouter.zapETHToPayment{value: 1e15}(
            address(out),
            wrapAmount,
            bobCommit,
            zrData,
            _privatePaymentPv(depositId, keccak256("bob-out-leaf"), _memos()),
            hex"",
            _memos()
        );

        assertEq(uint256(pool.depositStatus(depositId)), 2, "deposit consumed by the settle");
        assertEq(pool.nextLeafIndex(), 1, "recipient leaf inserted");
        assertEq(out.balanceOf(address(zapRouter)), 0, "router holds no OUT");
        assertEq(address(zapRouter).balance, 0, "router holds no ETH");
    }

    // ── ETH → public / shielded / farmed LP ──

    function test_zapETHIntoLP_coldStartPublicLp() public {
        (MockUSDC tokB, bytes32 tokBId) = _registerTok("TKB");
        uint256 gotB = 2e5; // value 2e5 (unitScale 1)
        vm.deal(user, 1 ether);
        bytes memory zrData = abi.encodeCall(MockZRouter.swapETHForToken, (address(tokB), gotB));
        uint64 deadline = uint64(block.timestamp + 1 hours);

        // msg.value 3e15: 1e15 → zRouter swap, 2e15 → tETH LP leg (value 2e5, aligned to unitScale 1e10)
        vm.prank(user);
        uint256 shares = zapRouter.zapETHIntoLP{value: 3e15}(address(tokB), FEE_BPS, 1e15, 0, deadline, user, zrData);

        assertEq(shares, 2e5 - MINIMUM_LIQUIDITY, "cold-start shares = isqrt(vA*vB) - MIN");
        assertEq(pool.lpShares(_poolId(_tethId(), tokBId, FEE_BPS), user), shares, "shares credited to `to`");
        assertEq(tokB.balanceOf(address(zapRouter)), 0, "router holds no TKB");
        assertEq(address(zapRouter).balance, 0, "router holds no ETH");
    }

    function test_zapETHIntoShieldedLP_shieldsPosition() public {
        (MockUSDC tokB, bytes32 tokBId) = _registerTok("TKB");
        bytes32 commit = keccak256("lp-note");
        uint256 tokBLeg = 2e5;
        vm.deal(user, 1 ether);
        bytes memory zrData = abi.encodeCall(MockZRouter.swapETHForToken, (address(tokB), tokBLeg));
        uint64 deadline = uint64(block.timestamp + 1 hours);

        vm.prank(user);
        (bytes32 depositId, uint256 shares) = zapRouter.zapETHIntoShieldedLP{value: 3e15}(
            address(tokB), FEE_BPS, 2e15, tokBLeg, 0, deadline, commit, zrData
        );

        bytes32 poolId = _poolId(_tethId(), tokBId, FEE_BPS);
        assertEq(shares, 2e5 - MINIMUM_LIQUIDITY, "deterministic shares (exact legs)");
        assertEq(depositId, _lpDepositId(poolId, shares, commit), "LP-share deposit id");
        assertEq(uint256(pool.depositStatus(depositId)), 1, "LP-share note deposit pending");
        assertEq(pool.lpShares(poolId, address(zapRouter)), 0, "router shielded all shares, holds none public");
        assertEq(tokB.balanceOf(address(zapRouter)), 0, "router holds no TKB");
        assertEq(address(zapRouter).balance, 0, "router holds no ETH");
    }

    function test_zapETHIntoFarm_shieldThenSettleBond() public {
        (MockUSDC tokB, bytes32 tokBId) = _registerTok("TKB");
        bytes32 commit = keccak256("farm-note");
        uint256 tokBLeg = 2e5;
        uint256 expectedShares = 2e5 - MINIMUM_LIQUIDITY;
        bytes32 lpDepositId = _lpDepositId(_poolId(_tethId(), tokBId, FEE_BPS), expectedShares, commit);
        vm.deal(user, 1 ether);
        bytes memory zrData = abi.encodeCall(MockZRouter.swapETHForToken, (address(tokB), tokBLeg));

        vm.prank(user);
        uint256 shares = zapRouter.zapETHIntoFarm{value: 3e15}(
            address(tokB),
            FEE_BPS,
            2e15,
            tokBLeg,
            0,
            uint64(block.timestamp + 1 hours),
            commit,
            zrData,
            _privatePaymentPv(lpDepositId, keccak256("farm-receipt"), _memos()),
            hex"",
            _memos()
        );

        assertEq(shares, expectedShares, "deterministic shares");
        assertEq(uint256(pool.depositStatus(lpDepositId)), 2, "LP-share deposit consumed (bonded) by the settle");
        assertEq(pool.nextLeafIndex(), 1, "farm-receipt leaf inserted");
        assertEq(tokB.balanceOf(address(zapRouter)), 0, "router holds no TKB");
        assertEq(address(zapRouter).balance, 0, "router holds no ETH");
    }

    // ── token-in → shielded / farmed LP ──

    function test_zapTokenIntoShieldedLP() public {
        (MockUSDC tokB, bytes32 tokBId) = _registerTok("TKB");
        bytes32 commit = keccak256("tok-lp-note");
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        ConfidentialRouter.TokenZap memory z = ConfidentialRouter.TokenZap({
            tokenB: address(tokB),
            feeBps: FEE_BPS,
            tokenAForSwap: 2000,
            tokenAForLP: 2000,
            tokenBLeg: 2000,
            minShares: 0,
            deadline: uint64(block.timestamp + 1 hours),
            commit: commit
        });
        bytes memory zrData = abi.encodeCall(MockZRouter.swapTokenForToken, (address(usdc), 2000, address(tokB), 2000));

        vm.prank(user);
        (bytes32 depositId, uint256 shares) =
            zapRouter.zapTokenIntoShieldedLP(z, _permitSingle(address(usdc), 4000, address(zapRouter)), hex"", zrData);

        assertEq(shares, 2000 - MINIMUM_LIQUIDITY, "deterministic shares");
        assertEq(depositId, _lpDepositId(_poolId(assetId, tokBId, FEE_BPS), shares, commit), "LP-share deposit id");
        assertEq(uint256(pool.depositStatus(depositId)), 1, "LP-share deposit pending");
        assertEq(usdc.balanceOf(user), 10_000 - 4000, "user paid swap + LP legs (no excess)");
        assertEq(usdc.balanceOf(address(zapRouter)), 0, "router holds no USDC");
        assertEq(tokB.balanceOf(address(zapRouter)), 0, "router holds no TKB");
    }

    function test_zapTokenIntoShieldedLP_rejectsMismatchedPermit2Spender() public {
        (MockUSDC tokB,) = _registerTok("TKB");
        ConfidentialRouter.TokenZap memory z = ConfidentialRouter.TokenZap({
            tokenB: address(tokB),
            feeBps: FEE_BPS,
            tokenAForSwap: 2000,
            tokenAForLP: 2000,
            tokenBLeg: 2000,
            minShares: 0,
            deadline: uint64(block.timestamp + 1 hours),
            commit: keccak256("bad-permit-lp")
        });
        bytes memory zrData = abi.encodeCall(MockZRouter.swapTokenForToken, (address(usdc), 2000, address(tokB), 2000));
        uint256 permitCallsBefore = permit2.permitCalls();

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.BadPermit2.selector);
        zapRouter.zapTokenIntoShieldedLP(z, _permitSingle(address(usdc), 4000, address(router)), hex"", zrData);

        assertEq(permit2.permitCalls(), permitCallsBefore, "permit not attempted for a mismatched spender");
        assertEq(usdc.balanceOf(user), 10_000, "user funds untouched");
    }

    function test_zapTokenIntoFarm() public {
        (MockUSDC tokB, bytes32 tokBId) = _registerTok("TKB");
        bytes32 commit = keccak256("tok-farm-note");
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);

        ConfidentialRouter.TokenZap memory z = ConfidentialRouter.TokenZap({
            tokenB: address(tokB),
            feeBps: FEE_BPS,
            tokenAForSwap: 2000,
            tokenAForLP: 2000,
            tokenBLeg: 2000,
            minShares: 0,
            deadline: uint64(block.timestamp + 1 hours),
            commit: commit
        });
        bytes memory zrData = abi.encodeCall(MockZRouter.swapTokenForToken, (address(usdc), 2000, address(tokB), 2000));
        bytes32 lpDepositId = _lpDepositId(_poolId(assetId, tokBId, FEE_BPS), 2000 - MINIMUM_LIQUIDITY, commit);

        vm.prank(user);
        uint256 shares = zapRouter.zapTokenIntoFarm(
            z,
            _permitSingle(address(usdc), 4000, address(zapRouter)),
            hex"",
            zrData,
            _privatePaymentPv(lpDepositId, keccak256("tok-farm-leaf"), _memos()),
            hex"",
            _memos()
        );

        assertEq(shares, 2000 - MINIMUM_LIQUIDITY, "deterministic shares");
        assertEq(uint256(pool.depositStatus(lpDepositId)), 2, "LP-share deposit consumed (bonded)");
        assertEq(pool.nextLeafIndex(), 1, "farm-receipt leaf inserted");
        assertEq(usdc.balanceOf(address(zapRouter)), 0, "router holds no USDC");
        assertEq(tokB.balanceOf(address(zapRouter)), 0, "router holds no TKB");
    }

    // ── fail-closed + leftover-forwarding invariants ──

    /// A swap that sources LESS than the wrap/LP leg requires trips the balance-delta gate → the whole tx
    /// unwinds (fail-closed), nothing escrowed, no ETH stranded.
    function test_zap_shortSwapOutput_reverts() public {
        (MockUSDC out, bytes32 outId) = _registerTok("OUT");
        vm.deal(user, 1 ether);
        bytes memory zrData = abi.encodeCall(MockZRouter.swapETHForToken, (address(out), 4000)); // < 5000 needed

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.ShortSwapOutput.selector);
        zapRouter.zapETHToShieldedNote{value: 1e15}(address(out), 5000, keccak256("c"), zrData);

        assertEq(pool.escrow(outId), 0, "nothing escrowed on the reverted zap");
        assertEq(address(zapRouter).balance, 0, "no ETH stranded");
    }

    /// A failing zRouter call bubbles up (here as ZRouterCallFailed for an empty revert) — the zap can't
    /// silently swallow a bad swap.
    function test_zap_zRouterCallFails_reverts() public {
        (MockUSDC out,) = _registerTok("OUT");
        vm.deal(user, 1 ether);
        bytes memory zrData = abi.encodeWithSignature("doesNotExist()"); // no such selector on the mock

        vm.prank(user);
        vm.expectRevert(ConfidentialRouter.ZRouterCallFailed.selector);
        zapRouter.zapETHToShieldedNote{value: 1e15}(address(out), 5000, keccak256("c"), zrData);
    }

    /// The pool's off-ratio LP refund (paid to msg.sender == router) is forwarded to the caller through a
    /// zap — proving the router keeps no balance even when the add is off-ratio.
    function test_zapToken_offRatioExcess_forwardedToCaller() public {
        (MockUSDC tokB, bytes32 tokBId) = _registerTok("TKB");
        // seed a 1:1 USDC/TKB pool from this contract so the user's zap is a (warm) proportional add
        uint256 seed = 1_000_000;
        usdc.mint(address(this), seed);
        tokB.mint(address(this), seed);
        usdc.approve(address(pool), type(uint256).max);
        tokB.approve(address(pool), type(uint256).max);
        pool.createPairAndAddLiquidityPublic(assetId, tokBId, FEE_BPS, seed, seed, 0, 0, address(this));

        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);
        ConfidentialRouter.TokenZap memory z = ConfidentialRouter.TokenZap({
            tokenB: address(tokB),
            feeBps: FEE_BPS,
            tokenAForSwap: 2000,
            tokenAForLP: 4000, // off-ratio: TKB (2000) is the limiting leg in the 1:1 pool → 2000 USDC refunded
            tokenBLeg: 2000,
            minShares: 0,
            deadline: uint64(block.timestamp + 1 hours),
            commit: keccak256("offratio-note")
        });
        bytes memory zrData = abi.encodeCall(MockZRouter.swapTokenForToken, (address(usdc), 2000, address(tokB), 2000));

        vm.prank(user);
        zapRouter.zapTokenIntoShieldedLP(z, _permitSingle(address(usdc), 6000, address(zapRouter)), hex"", zrData);

        // pulled 6000 USDC (2000 swap + 4000 LP); the pool consumes 2000 for the LP and refunds 2000 → caller
        assertEq(usdc.balanceOf(user), 10_000 - 4000, "net USDC = 2000 swap + 2000 LP (2000 off-ratio excess refunded)");
        assertEq(usdc.balanceOf(address(zapRouter)), 0, "router forwarded the refund, holds no USDC");
        assertEq(tokB.balanceOf(address(zapRouter)), 0, "router holds no TKB");
    }

    /// R-2 hardening: a settle relayed through wrapAndSettle now sweeps a fee/residue resting in the wrapped
    /// `token` back to the caller (was: stranded in the router). Modeled by a stray balance the settle leaves.
    function test_wrapAndSettle_refundsStrandedWrapToken() public {
        usdc.mint(address(router), 250); // stand-in for a settler fee paid to the router (msg.sender) in `token`
        bytes32 bobCommit = keccak256("bob-fee-c");
        bytes32 depositId = keccak256(abi.encode(assetId, AMOUNT, bobCommit));
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign2612(AMOUNT, deadline);
        uint256 userBefore = usdc.balanceOf(user);

        vm.prank(user);
        router.wrapAndSettleWithPermit(
            address(usdc),
            AMOUNT,
            bobCommit,
            deadline,
            v,
            r,
            s,
            _privatePaymentPv(depositId, keccak256("bob-fee-l"), _memos()),
            hex"",
            _memos(),
            address(0)
        );

        assertEq(usdc.balanceOf(address(router)), 0, "router swept the stranded token (no residue left)");
        assertEq(usdc.balanceOf(user), userBefore - AMOUNT + 250, "caller received the swept token (net of the wrap)");
    }
}
