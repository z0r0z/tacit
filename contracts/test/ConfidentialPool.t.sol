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
    address constant ORACLE = address(0x0BAC1E); // Bitcoin-root oracle (bridge_mint)
    bytes32 constant VKEY = bytes32(uint256(0xABCD)); // placeholder program vkey

    function setUp() public {
        vm.chainId(1);
        verifier = new MockSP1Verifier();
        pool = new ConfidentialPool(address(verifier), VKEY, ORACLE);
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
        bytes[] memory memos = new bytes[](pv.leaves.length);
        pool.settle(abi.encode(pv), "", memos);
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
        _settle(pv);
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
        _settle(pv);

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

    // ──────────────────── recovery data availability (memos) ────────────────────

    event LeavesInserted(uint256 indexed firstLeafIndex, bytes32[] leaves, bytes[] memos);
    event NullifiersSpent(bytes32[] nullifiers);

    /// settle emits the leaves+memos+nullifiers an indexer needs to reconstruct a
    /// wallet's notes from chain alone — firstLeafIndex anchors them to tree slots.
    function test_settle_emits_recovery_data() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = new bytes32[](2);
        pv.leaves[0] = keccak256("L0"); pv.leaves[1] = keccak256("L1");
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = keccak256("nu");

        bytes[] memory memos = new bytes[](2);
        memos[0] = hex"deadbeef"; memos[1] = hex"cafe";

        vm.expectEmit(true, false, false, true, address(pool));
        emit NullifiersSpent(pv.nullifiers);
        vm.expectEmit(true, false, false, true, address(pool));
        emit LeavesInserted(0, pv.leaves, memos);
        pool.settle(abi.encode(pv), "", memos);

        assertEq(pool.nextLeafIndex(), 2, "two leaves landed");
    }

    /// A second settle's leaves are anchored at the running nextLeafIndex.
    function test_settle_recovery_index_advances() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = new bytes32[](2);
        pv.leaves[0] = keccak256("a"); pv.leaves[1] = keccak256("b");
        pool.settle(abi.encode(pv), "", new bytes[](2));

        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.leaves = new bytes32[](1);
        pv2.leaves[0] = keccak256("c");
        bytes[] memory memos2 = new bytes[](1);
        memos2[0] = hex"01";
        vm.expectEmit(true, false, false, true, address(pool));
        emit LeavesInserted(2, pv2.leaves, memos2);
        pool.settle(abi.encode(pv2), "", memos2);
    }

    function test_settle_memo_count_mismatch_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = new bytes32[](2);
        pv.leaves[0] = keccak256("x"); pv.leaves[1] = keccak256("y");
        vm.expectRevert(ConfidentialPool.MemoLeafMismatch.selector);
        pool.settle(abi.encode(pv), "", new bytes[](1)); // one memo, two leaves
    }

    // ──────────────────── cross-chain (Phase 3 in gen-1) ────────────────────

    event BridgeMinted(bytes32 indexed claimId);
    event CrossOutRecorded(bytes32 indexed claimId, uint16 destChain, bytes32 destCommitment, bytes32 nullifier, bytes32 assetId);

    function _claimId(uint16 destChain, bytes32 destCommitment, bytes32 nullifier, bytes32 asset) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(destChain, destCommitment, nullifier, asset));
    }

    /// A Bitcoin burn mints an Ethereum note (leaf) gated one-mint-per-burn on its
    /// claimId, and marks bridgeMinted — the tETH acceptedBitcoinBurns pattern.
    function test_bridge_mint_marks_claim_and_inserts_leaf() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 claimId = keccak256("btc-burn-1");
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = claimId;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256("minted-note");

        vm.expectEmit(true, false, false, true, address(pool));
        emit BridgeMinted(claimId);
        pool.settle(abi.encode(pv), "", new bytes[](1));

        assertTrue(pool.bridgeMinted(claimId), "claim marked minted");
        assertEq(pool.nextLeafIndex(), 1, "minted leaf inserted");
    }

    /// The same Bitcoin burn cannot be minted twice (one note, not two).
    function test_bridge_mint_double_claim_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 claimId = keccak256("btc-burn-2");
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = claimId;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256("note");
        pool.settle(abi.encode(pv), "", new bytes[](1));

        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.bitcoinBurnsConsumed = new bytes32[](1);
        pv2.bitcoinBurnsConsumed[0] = claimId; // replay
        pv2.leaves = new bytes32[](1);
        pv2.leaves[0] = keccak256("note2");
        vm.expectRevert(ConfidentialPool.BurnAlreadyMinted.selector);
        pool.settle(abi.encode(pv2), "", new bytes[](1));
    }

    /// An intra-batch duplicate Bitcoin-burn claim is rejected too.
    function test_bridge_mint_intrabatch_duplicate_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 claimId = keccak256("btc-burn-3");
        pv.bitcoinBurnsConsumed = new bytes32[](2);
        pv.bitcoinBurnsConsumed[0] = claimId; pv.bitcoinBurnsConsumed[1] = claimId;
        vm.expectRevert(ConfidentialPool.BurnAlreadyMinted.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// An Ethereum note burned for Bitcoin: the note is nullified and a
    /// non-malleable CrossOut record is emitted for Bitcoin validators to honor.
    function test_cross_out_emits_record_and_spends_note() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 nu = keccak256("eth-note-nu");
        bytes32 destC = keccak256("btc-dest-commitment");
        uint16 destChain = 1; // bitcoin
        bytes32 claimId = _claimId(destChain, destC, nu, assetId);

        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = nu;
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(destChain, destC, nu, assetId, claimId);

        vm.expectEmit(true, false, false, true, address(pool));
        emit CrossOutRecorded(claimId, destChain, destC, nu, assetId);
        pool.settle(abi.encode(pv), "", new bytes[](0));

        assertTrue(pool.isNullifierSpent(nu), "burned note nullified");
    }

    /// A crossOut whose claimId doesn't bind its own fields is rejected — the
    /// on-chain re-derivation blocks a malleable instruction to Bitcoin.
    function test_cross_out_claim_mismatch_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 nu = keccak256("nu2");
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = nu;
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(1, keccak256("dest"), nu, assetId, keccak256("wrong-claim"));
        vm.expectRevert(ConfidentialPool.CrossOutClaimMismatch.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// Atomic cross-chain swap: one settle carries both legs — Bob's X output
    /// lands as an Ethereum leaf, Alice's Y output is recorded as a Bitcoin
    /// crossOut, both input notes are nullified — all applied in one call.
    function test_atomic_cross_chain_swap() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 nuAliceX = keccak256("alice-X-in");
        bytes32 nuBobY = keccak256("bob-Y-in");
        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = nuAliceX; pv.nullifiers[1] = nuBobY;

        // ETH leg: Bob's new X note as a leaf.
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256("bob-X-out");

        // BTC leg: Alice's new Y note as a crossOut.
        bytes32 assetY = keccak256("asset-Y");
        bytes32 destC = keccak256("alice-Y-on-bitcoin");
        bytes32 cid = _claimId(1, destC, nuBobY, assetY);
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(1, destC, nuBobY, assetY, cid);

        vm.expectEmit(true, false, false, true, address(pool));
        emit CrossOutRecorded(cid, 1, destC, nuBobY, assetY);
        pool.settle(abi.encode(pv), "", new bytes[](1));

        assertTrue(pool.isNullifierSpent(nuAliceX), "Alice's X input spent");
        assertTrue(pool.isNullifierSpent(nuBobY), "Bob's Y input spent");
        assertEq(pool.nextLeafIndex(), 1, "Bob's X minted on Ethereum");
    }

    // ──────────────────── bridge_mint: Bitcoin pool-root attestation ────────────────────

    event BitcoinRootAttested(bytes32 indexed root);

    function test_attest_bitcoin_root_only_oracle() public {
        bytes32 root = keccak256("btc-pool-root");
        vm.expectRevert(ConfidentialPool.NotOracle.selector);
        pool.attestBitcoinRoot(root); // default sender, not the oracle

        vm.expectEmit(true, false, false, false, address(pool));
        emit BitcoinRootAttested(root);
        vm.prank(ORACLE);
        pool.attestBitcoinRoot(root);
        assertTrue(pool.knownBitcoinRoot(root), "root attested");
    }

    /// A bridge_mint against an un-attested Bitcoin root is rejected — the gate
    /// that stops minting a note proven in a fabricated tree.
    function test_bridge_mint_requires_attested_root() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 root = keccak256("unknown-btc-root");
        bytes32 claimId = keccak256("mint-claim");
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = claimId;
        pv.bitcoinRootsUsed = new bytes32[](1);
        pv.bitcoinRootsUsed[0] = root;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256("minted");
        vm.expectRevert(ConfidentialPool.UnknownBitcoinRoot.selector);
        pool.settle(abi.encode(pv), "", new bytes[](1));
    }

    /// A bridge_mint against an attested root mints the Ethereum note and marks
    /// the claim — the full BTC→ETH effect on the contract side.
    function test_bridge_mint_with_attested_root_succeeds() public {
        bytes32 root = keccak256("good-btc-root");
        vm.prank(ORACLE);
        pool.attestBitcoinRoot(root);

        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 claimId = keccak256("mint-claim-2");
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = claimId;
        pv.bitcoinRootsUsed = new bytes32[](1);
        pv.bitcoinRootsUsed[0] = root;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256("minted-note");

        vm.expectEmit(true, false, false, true, address(pool));
        emit BridgeMinted(claimId);
        pool.settle(abi.encode(pv), "", new bytes[](1));

        assertTrue(pool.bridgeMinted(claimId), "burn claimed");
        assertEq(pool.nextLeafIndex(), 1, "ETH note minted");
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
