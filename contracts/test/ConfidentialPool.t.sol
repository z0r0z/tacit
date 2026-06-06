// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract MockERC20 is ERC20 {
    function name() public pure override returns (string memory) { return "Mock"; }
    function symbol() public pure override returns (string memory) { return "MCK"; }
    function decimals() public pure override returns (uint8) { return 18; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// A stand-in SP1 verifier: accepts unless toggled. The crypto is exercised by
/// the real-proof suite (next milestone); this suite pins the on-chain state
/// machine — escrow, the Keccak commitment tree, nullifiers, deposits, payouts —
/// independent of the proof system.
contract MockSP1Verifier is ISP1Verifier {
    bool public reverts;
    function setReverts(bool b) external { reverts = b; }
    function verifyProof(bytes32, bytes calldata, bytes calldata) external view {
        require(!reverts, "mock: proof invalid");
    }
}

contract ConfidentialPoolTest is Test {
    ConfidentialPool pool;
    MockSP1Verifier verifier;
    MockERC20 token;
    bytes32 assetId;

    address constant USER = address(0xA11CE);
    address constant RECIP = address(0xB0B);
    address constant SETTLER = address(0x5E771E2);
    bytes32 constant VKEY = bytes32(uint256(0xABCD)); // placeholder program vkey

    function setUp() public {
        vm.chainId(1);
        verifier = new MockSP1Verifier();
        pool = new ConfidentialPool(address(verifier), VKEY);
        token = new MockERC20();
        assetId = pool.registerWrapped(address(token), 1, bytes32(0), "Conf Mock", "cMCK", 18);

        token.mint(USER, 1_000);
        vm.prank(USER);
        token.approve(address(pool), type(uint256).max);
    }

    // ──────────────────── helpers ────────────────────

    function _pv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = pool.PV_VERSION();
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        pv.spendRoot = bytes32(0);
    }

    function _settle(ConfidentialPool.PublicValues memory pv) internal {
        pool.settle(abi.encode(pv), "");
    }

    function _wrap(uint256 amount, bytes32 cx, bytes32 cy, bytes32 owner) internal returns (bytes32 depositId) {
        vm.prank(USER);
        pool.wrap(assetId, amount, cx, cy, owner);
        depositId = keccak256(abi.encode(assetId, amount, cx, cy, owner));
    }

    function _arr(bytes32 a) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](1); out[0] = a;
    }

    // ──────────────────── wrap ────────────────────

    function test_register_and_wrap() public {
        assertEq(pool.escrow(assetId), 0);
        bytes32 id = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        assertEq(pool.escrow(assetId), 100, "escrow");
        assertEq(token.balanceOf(address(pool)), 100, "held");
        assertEq(pool.depositStatus(id), 1, "pending");

        ConfidentialPool.Asset memory a = pool.getAsset(assetId);
        assertEq(a.name, "Conf Mock");
        assertEq(a.symbol, "cMCK");
        assertEq(a.decimals, 18);
    }

    function test_wrap_duplicate_reverts() public {
        _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        vm.prank(USER);
        vm.expectRevert(ConfidentialPool.DepositExists.selector);
        pool.wrap(assetId, 100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
    }

    function test_wrap_unaligned_reverts() public {
        bytes32 a2 = pool.registerWrapped(address(new MockERC20()), 10, bytes32(0), "X", "X", 18);
        vm.prank(USER);
        vm.expectRevert(ConfidentialPool.AmountNotAligned.selector);
        pool.wrap(a2, 5, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
    }

    function test_register_duplicate_reverts() public {
        vm.expectRevert(ConfidentialPool.AlreadyRegistered.selector);
        pool.registerWrapped(address(token), 1, bytes32(0), "Conf Mock", "cMCK", 18);
    }

    // ──────────────────── settle: deposit consumption ────────────────────

    function test_settle_consumes_deposit_and_inserts_leaf() public {
        bytes32 emptyRoot = pool.currentRoot();
        bytes32 id = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = _arr(keccak256("leaf-A"));
        pv.depositsConsumed = _arr(id);
        _settle(pv);

        assertEq(pool.depositStatus(id), 2, "consumed");
        assertEq(pool.nextLeafIndex(), 1, "one leaf");
        assertTrue(pool.currentRoot() != emptyRoot, "root advanced");
        assertTrue(pool.everKnownRoot(pool.currentRoot()), "root known");
    }

    function test_settle_unknown_deposit_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = _arr(keccak256("leaf-A"));
        pv.depositsConsumed = _arr(keccak256("nope"));
        vm.expectRevert(ConfidentialPool.DepositNotPending.selector);
        _settle(pv);
    }

    // ──────────────────── settle: transfer (nullifiers + membership root) ────────────────────

    function test_settle_transfer_spends_nullifier() public {
        // seed a leaf so a non-empty known root exists
        bytes32 id = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory seed = _pv();
        seed.leaves = _arr(keccak256("leaf-A"));
        seed.depositsConsumed = _arr(id);
        _settle(seed);
        bytes32 root = pool.currentRoot();

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = root;
        pv.nullifiers = _arr(keccak256("null-1"));
        pv.leaves = _arr(keccak256("out-1"));
        _settle(pv);

        assertTrue(pool.isNullifierSpent(keccak256("null-1")), "nullifier marked");
        assertEq(pool.nextLeafIndex(), 2, "two leaves");
    }

    function test_settle_nullifier_reuse_reverts() public {
        bytes32 id = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory seed = _pv();
        seed.leaves = _arr(keccak256("leaf-A"));
        seed.depositsConsumed = _arr(id);
        _settle(seed);

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = pool.currentRoot();
        pv.nullifiers = _arr(keccak256("null-1"));
        pv.leaves = _arr(keccak256("out-1"));
        _settle(pv);

        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.spendRoot = pool.currentRoot();
        pv2.nullifiers = _arr(keccak256("null-1"));
        pv2.leaves = _arr(keccak256("out-2"));
        vm.expectRevert(ConfidentialPool.NullifierAlreadySpent.selector);
        _settle(pv2);
    }

    function test_settle_unknown_root_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = bytes32(uint256(0xdead));
        pv.nullifiers = _arr(keccak256("null-1"));
        vm.expectRevert(ConfidentialPool.UnknownRoot.selector);
        _settle(pv);
    }

    // ──────────────────── settle: withdraw + fee ────────────────────

    function test_settle_withdraw_pays_recipient() public {
        _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, RECIP, 30);
        _settle(pv);
        assertEq(token.balanceOf(RECIP), 30, "recipient paid");
        assertEq(pool.escrow(assetId), 70, "escrow reduced");
    }

    function test_settle_fee_pays_settler() public {
        _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.fees = new ConfidentialPool.FeePayment[](1);
        pv.fees[0] = ConfidentialPool.FeePayment(assetId, 5);
        vm.prank(SETTLER);
        pool.settle(abi.encode(pv), "");
        assertEq(token.balanceOf(SETTLER), 5, "settler paid fee");
        assertEq(pool.escrow(assetId), 95, "escrow reduced by fee");
    }

    function test_settle_withdraw_over_escrow_reverts() public {
        _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, RECIP, 101);
        vm.expectRevert(ConfidentialPool.InsufficientEscrow.selector);
        _settle(pv);
    }

    // ──────────────────── settle: domain / proof gating ────────────────────

    function test_settle_bad_version_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.version = 2;
        vm.expectRevert(ConfidentialPool.BadVersion.selector);
        _settle(pv);
    }

    function test_settle_chain_mismatch_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.chainBinding = keccak256("wrong");
        vm.expectRevert(ConfidentialPool.ChainMismatch.selector);
        _settle(pv);
    }

    function test_settle_proof_rejected_reverts() public {
        verifier.setReverts(true);
        ConfidentialPool.PublicValues memory pv = _pv();
        vm.expectRevert(bytes("mock: proof invalid"));
        _settle(pv);
    }

    // ──────────────────── batched rollup path ────────────────────

    /// One proof carrying a mixed batch — 2 deposits consumed, a transfer
    /// (1 nullifier + 2 outputs), an unwrap (1 nullifier + 1 withdrawal), and a
    /// fee — exercises the Phase-2 shape: every effect applied in a single settle,
    /// escrow conserved as deposits − withdrawal − fee.
    function test_batched_multi_op_settle() public {
        bytes32 id1 = _wrap(100, bytes32(uint256(11)), bytes32(uint256(12)), bytes32(uint256(13)));
        bytes32 id2 = _wrap(50, bytes32(uint256(21)), bytes32(uint256(22)), bytes32(uint256(23)));
        assertEq(pool.escrow(assetId), 150);

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.depositsConsumed = new bytes32[](2);
        pv.depositsConsumed[0] = id1; pv.depositsConsumed[1] = id2;
        pv.leaves = new bytes32[](4); // 2 deposit leaves + 2 transfer outputs
        pv.leaves[0] = keccak256("dep1"); pv.leaves[1] = keccak256("dep2");
        pv.leaves[2] = keccak256("out0"); pv.leaves[3] = keccak256("out1");
        pv.nullifiers = new bytes32[](2); // transfer input + unwrap
        pv.nullifiers[0] = keccak256("nT"); pv.nullifiers[1] = keccak256("nU");
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, RECIP, 30);
        pv.fees = new ConfidentialPool.FeePayment[](1);
        pv.fees[0] = ConfidentialPool.FeePayment(assetId, 5);

        vm.prank(SETTLER);
        pool.settle(abi.encode(pv), "");

        assertEq(pool.depositStatus(id1), 2, "dep1 consumed");
        assertEq(pool.depositStatus(id2), 2, "dep2 consumed");
        assertEq(pool.nextLeafIndex(), 4, "4 leaves inserted");
        assertTrue(pool.isNullifierSpent(keccak256("nT")), "transfer nullifier");
        assertTrue(pool.isNullifierSpent(keccak256("nU")), "unwrap nullifier");
        assertEq(token.balanceOf(RECIP), 30, "unwrap paid");
        assertEq(token.balanceOf(SETTLER), 5, "settler fee paid");
        assertEq(pool.escrow(assetId), 115, "escrow = 150 - 30 - 5");
        assertTrue(pool.everKnownRoot(pool.currentRoot()), "root known");
    }

    /// A batch touching two assets keeps escrow per-asset independent.
    function test_multi_asset_independent_escrow() public {
        MockERC20 tokenB = new MockERC20();
        bytes32 assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "Conf B", "cB", 6);
        tokenB.mint(USER, 1_000);
        vm.prank(USER);
        tokenB.approve(address(pool), type(uint256).max);

        bytes32 idA = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        vm.prank(USER);
        pool.wrap(assetB, 200, bytes32(uint256(4)), bytes32(uint256(5)), bytes32(uint256(6)));
        bytes32 idB = keccak256(abi.encode(assetB, uint256(200), bytes32(uint256(4)), bytes32(uint256(5)), bytes32(uint256(6))));

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.depositsConsumed = new bytes32[](2);
        pv.depositsConsumed[0] = idA; pv.depositsConsumed[1] = idB;
        pv.leaves = new bytes32[](2);
        pv.leaves[0] = keccak256("lA"); pv.leaves[1] = keccak256("lB");
        pv.withdrawals = new ConfidentialPool.Withdrawal[](2);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, RECIP, 40);
        pv.withdrawals[1] = ConfidentialPool.Withdrawal(assetB, RECIP, 70);
        _settle(pv);

        assertEq(pool.escrow(assetId), 60, "asset A escrow");
        assertEq(pool.escrow(assetB), 130, "asset B escrow");
        assertEq(token.balanceOf(RECIP), 40, "A paid");
        assertEq(tokenB.balanceOf(RECIP), 70, "B paid");
    }

    // ──────────────────── on-chain defense-in-depth (intra-batch) ────────────────────

    function test_settle_intrabatch_duplicate_nullifier_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = keccak256("dup"); pv.nullifiers[1] = keccak256("dup");
        vm.expectRevert(ConfidentialPool.NullifierAlreadySpent.selector);
        _settle(pv);
    }

    function test_settle_intrabatch_duplicate_deposit_reverts() public {
        bytes32 id = _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.depositsConsumed = new bytes32[](2);
        pv.depositsConsumed[0] = id; pv.depositsConsumed[1] = id;
        vm.expectRevert(ConfidentialPool.DepositNotPending.selector);
        _settle(pv);
    }

    function test_settle_withdraw_zero_recipient_reverts() public {
        _wrap(100, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(assetId, address(0), 10);
        vm.expectRevert(ConfidentialPool.ZeroAddress.selector);
        _settle(pv);
    }

    function test_settle_withdraw_unregistered_asset_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(keccak256("ghost-asset"), RECIP, 10);
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        _settle(pv);
    }
}
