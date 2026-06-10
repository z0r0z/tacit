// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract MockERC20 is ERC20 {
    function name() public pure override returns (string memory) { return "Mock"; }
    function symbol() public pure override returns (string memory) { return "MCK"; }
    function decimals() public pure override returns (uint8) { return 18; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

// A token exposing MINTER() — stands in for a canonical pool-minted ERC20 (M-4 guard).
contract MockMinterToken {
    address public MINTER;
    constructor(address m) { MINTER = m; }
}

// A contract that rejects plain ETH (no receive/fallback) — to prove forceSafeTransferETH on the
// native-ETH unwrap path cannot be bricked by a hostile recipient in a batch settle.
contract EthRejector {}

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

// A stand-in Bitcoin light relay for the reflection anchor: tip() = a settable canonical tip,
// blockParent for the ancestor walk. The attest tests anchor trivially (prev == tip == the seeded
// ANCHOR, which is also the relay tip), so the digest-chain mechanics are tested with the anchor ON.
contract MockRelay {
    bytes32 public tip;
    mapping(bytes32 => bytes32) public blockParent;
    constructor(bytes32 t) { tip = t; }
    function setTip(bytes32 t) external { tip = t; }
    function setParent(bytes32 child, bytes32 parent) external { blockParent[child] = parent; }
}

contract ConfidentialPoolTest is Test {
    ConfidentialPool pool;
    MockSP1Verifier verifier;
    MockERC20 token;
    bytes32 assetId;
    CanonicalAssetFactory factory;

    address constant USER = address(0xA11CE);
    address constant RECIP = address(0xB0B);
    address constant SETTLER = address(0x5E771E2);
    bytes32 constant VKEY = bytes32(uint256(0xABCD)); // placeholder program vkey
    bytes32 constant RELAY_VKEY = bytes32(uint256(0xBEEF)); // placeholder Bitcoin-relay vkey
    bytes32 constant ANCHOR = bytes32(uint256(0xB17C0)); // seeded reflection anchor == mock relay tip
    MockRelay relay;

    function setUp() public {
        vm.chainId(1);
        verifier = new MockSP1Verifier();
        factory = new CanonicalAssetFactory();
        relay = new MockRelay(ANCHOR);
        pool = new ConfidentialPool(address(verifier), VKEY, RELAY_VKEY, address(factory), address(relay), ANCHOR);
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
        // the contract binds the deposit to the in-system value = amount/unitScale.
        uint256 value = amount / pool.getAsset(assetId).unitScale;
        depositId = keccak256(abi.encode(assetId, value, cx, cy, owner));
    }

    function _arr(bytes32 a) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](1); out[0] = a;
    }

    /// Attest Bitcoin state via the relay-proven path (the only path — no oracle). The
    /// MockSP1Verifier no-ops verifyProof, so this exercises the contract's decode + gates.
    function _attestBtc(bytes32 poolRoot, bytes32 spentRoot, uint64 height) internal returns (bytes32 burnRoot) {
        burnRoot = keccak256(abi.encodePacked(spentRoot, "burn"));
        bytes32 prior = pool.knownReflectionDigest(); // continue the current attested state
        bytes32 next = keccak256(abi.encode(prior, poolRoot, spentRoot, burnRoot, height));
        ConfidentialPool.BitcoinRelayPublicValues memory r =
            ConfidentialPool.BitcoinRelayPublicValues(prior, poolRoot, spentRoot, burnRoot, height, next, ANCHOR, ANCHOR);
        pool.attestBitcoinStateProven(abi.encode(r), "");
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

    function test_wrap_value_over_u64_reverts() public {
        // unitScale == 1 for the setup asset, so value == amount. A value > u64 max would
        // bind a deposit id the guest (u64 value) can't reproduce → unconsumable escrow.
        uint256 huge = uint256(type(uint64).max) + 1;
        token.mint(USER, huge);
        vm.prank(USER);
        vm.expectRevert(ConfidentialPool.ValueOutOfRange.selector);
        pool.wrap(assetId, huge, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
    }

    function test_register_duplicate_reverts() public {
        vm.expectRevert(ConfidentialPool.AlreadyRegistered.selector);
        pool.registerWrapped(address(token), 1, bytes32(0), "Conf Mock", "cMCK", 18);
    }

    // Escrow registration of a not-yet-deployed address is rejected: a canonical token's
    // address is deterministic, so it must not be claimable as escrow before it exists.
    function test_register_wrapped_rejects_non_contract() public {
        vm.expectRevert(ConfidentialPool.NotAContract.selector);
        pool.registerWrapped(address(0xBEEF), 1, bytes32(0), "X", "X", 18);
    }

    // Escrow registration of a canonical token of this pool (MINTER() == pool) is rejected
    // — canonical assets register only via the guest-proven minted path.
    function test_register_wrapped_rejects_canonical_token() public {
        MockMinterToken canon = new MockMinterToken(address(pool));
        vm.expectRevert(ConfidentialPool.CanonicalAsset.selector);
        pool.registerWrapped(address(canon), 1, bytes32(0), "X", "X", 18);
    }

    // ──────────────────── native ETH (address(0)) ────────────────────

    function test_register_native_eth() public {
        bytes32 ethId = pool.registerWrapped(address(0), 1e10, bytes32(0), "Confidential ETH", "cETH", 18);
        ConfidentialPool.Asset memory a = pool.getAsset(ethId);
        assertTrue(a.registered && !a.poolMinted, "ETH is a registered escrow asset");
        assertEq(a.underlying, address(0), "native ETH sentinel");
        assertEq(a.unitScale, 1e10, "8-dec in-system granularity (10 gwei)");
    }

    function test_wrap_native_eth_escrows_msg_value() public {
        bytes32 ethId = pool.registerWrapped(address(0), 1e10, bytes32(0), "cETH", "cETH", 18);
        uint256 amt = 5e10; // 5 in-system units
        vm.deal(USER, amt);
        vm.prank(USER);
        pool.wrap{value: amt}(ethId, amt, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        assertEq(pool.escrow(ethId), amt, "ETH escrowed");
        assertEq(address(pool).balance, amt, "pool holds the wei");
    }

    function test_wrap_native_eth_value_mismatch_reverts() public {
        bytes32 ethId = pool.registerWrapped(address(0), 1e10, bytes32(0), "cETH", "cETH", 18);
        vm.deal(USER, 1e10);
        vm.prank(USER);
        vm.expectRevert(ConfidentialPool.EthValueMismatch.selector);
        pool.wrap{value: 1e10 - 1}(ethId, 1e10, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
    }

    function test_unwrap_native_eth_pays_recipient() public {
        bytes32 ethId = pool.registerWrapped(address(0), 1e10, bytes32(0), "cETH", "cETH", 18);
        vm.deal(USER, 7e10);
        vm.prank(USER);
        pool.wrap{value: 7e10}(ethId, 7e10, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(ethId, RECIP, 7); // value 7 → 7·1e10 wei
        uint256 before = RECIP.balance;
        _settle(pv);
        assertEq(RECIP.balance - before, 7e10, "recipient received ETH");
        assertEq(pool.escrow(ethId), 0, "escrow drained");
    }

    function test_unwrap_native_eth_to_non_payable_not_bricked() public {
        bytes32 ethId = pool.registerWrapped(address(0), 1e10, bytes32(0), "cETH", "cETH", 18);
        vm.deal(USER, 1e10);
        vm.prank(USER);
        pool.wrap{value: 1e10}(ethId, 1e10, bytes32(uint256(9)), bytes32(uint256(8)), bytes32(uint256(7)));
        address rejector = address(new EthRejector());
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(ethId, rejector, 1);
        _settle(pv); // must NOT revert — forceSafeTransferETH delivers despite no receiver
        assertEq(rejector.balance, 1e10, "force-sent ETH to a non-payable recipient");
    }

    function test_stray_eth_rejected() public {
        vm.deal(USER, 1 ether);
        vm.prank(USER);
        (bool ok, ) = address(pool).call{value: 1 ether}("");
        assertFalse(ok, "bare ETH send is rejected (only wrap/initPool accept ETH)");
    }

    function test_initPool_native_eth_reserve() public {
        bytes32 ethId = pool.registerWrapped(address(0), 1e10, bytes32(0), "cETH", "cETH", 18);
        token.mint(address(this), 200);
        token.approve(address(pool), type(uint256).max);
        uint256 ethWei = 100 * 1e10; // ethReserve 100 in-system → wei
        vm.deal(address(this), ethWei);
        bytes32 pid = pool.initPool{value: ethWei}(ethId, assetId, 100, 200, 30);
        (, , , uint256 rA, uint256 rB, , ) = pool.pools(pid);
        assertEq(rA, 100, "ETH reserve"); assertEq(rB, 200, "token reserve");
        assertEq(pool.escrow(ethId), ethWei, "ETH reserve escrowed from msg.value");
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

    /// Boundary effects speak the in-system note value `v`; the contract scales by the
    /// asset's trusted unitScale. With unitScale != 1 (the dust-on-Eth case): a wrap of
    /// `amount` binds the deposit to v = amount/unitScale (NOT the underlying amount), and
    /// an unwrap of `v` releases exactly v·unitScale — the guest, blind to unitScale,
    /// can never inflate the payout. (All other tests use unitScale = 1, where v == amount
    /// and the scaling is invisible.)
    function test_value_scaling_wrap_and_unwrap() public {
        uint256 scale = 1e10;
        MockERC20 t8 = new MockERC20();
        bytes32 a8 = pool.registerWrapped(address(t8), scale, bytes32(0), "Conf8", "c8", 18);
        t8.mint(USER, 3 * scale);
        vm.prank(USER);
        t8.approve(address(pool), type(uint256).max);

        bytes32 cx = bytes32(uint256(0x8c1));
        bytes32 cy = bytes32(uint256(0x8c2));
        bytes32 owner = bytes32(uint256(0x8c3));

        // wrap amount = 3·scale → in-system value 3; deposit is bound to the value.
        vm.prank(USER);
        pool.wrap(a8, 3 * scale, cx, cy, owner);
        bytes32 id = keccak256(abi.encode(a8, uint256(3), cx, cy, owner));
        assertEq(pool.depositStatus(id), 1, "deposit bound to value, not amount");
        // the amount-bound id (the pre-harmonization layout) must NOT exist.
        assertEq(pool.depositStatus(keccak256(abi.encode(a8, 3 * scale, cx, cy, owner))), 0, "not bound to amount");
        assertEq(pool.escrow(a8), 3 * scale, "escrow holds the underlying");

        // settle: consume the deposit (insert its leaf) and unwrap value 2 to RECIP.
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.leaves = _arr(keccak256("leaf8"));
        pv.depositsConsumed = _arr(id);
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(a8, RECIP, 2);
        _settle(pv);

        assertEq(t8.balanceOf(RECIP), 2 * scale, "payout scaled value*unitScale");
        assertEq(pool.escrow(a8), 1 * scale, "escrow reduced by value*unitScale");
        assertEq(pool.depositStatus(id), 2, "deposit consumed");
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
        bytes32 burnRoot = _attestBtc(keccak256("bm-pool-1"), keccak256("bm-spent-1"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 claimId = keccak256("btc-burn-1");
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = claimId;
        pv.bitcoinBurnRoot = burnRoot;
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
        bytes32 burnRoot = _attestBtc(keccak256("bm-pool-2"), keccak256("bm-spent-2"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 claimId = keccak256("btc-burn-2");
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = claimId;
        pv.bitcoinBurnRoot = burnRoot;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256("note");
        pool.settle(abi.encode(pv), "", new bytes[](1));

        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.bitcoinBurnsConsumed = new bytes32[](1);
        pv2.bitcoinBurnsConsumed[0] = claimId; // replay
        pv2.bitcoinBurnRoot = burnRoot;
        pv2.leaves = new bytes32[](1);
        pv2.leaves[0] = keccak256("note2");
        vm.expectRevert(ConfidentialPool.BurnAlreadyMinted.selector);
        pool.settle(abi.encode(pv2), "", new bytes[](1));
    }

    /// An intra-batch duplicate Bitcoin-burn claim is rejected too.
    function test_bridge_mint_intrabatch_duplicate_reverts() public {
        bytes32 burnRoot = _attestBtc(keccak256("bm-pool-3"), keccak256("bm-spent-3"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 claimId = keccak256("btc-burn-3");
        pv.bitcoinBurnsConsumed = new bytes32[](2);
        pv.bitcoinBurnsConsumed[0] = claimId; pv.bitcoinBurnsConsumed[1] = claimId;
        pv.bitcoinBurnRoot = burnRoot;
        vm.expectRevert(ConfidentialPool.BurnAlreadyMinted.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// H-1 guard: a bridge_mint MUST pin a burn root. A mint that omits it (burnRoot == 0)
    /// is rejected — otherwise a note spent on Bitcoin for ANY reason (an ordinary transfer,
    /// not a bridge burn) could be minted on Ethereum, duplicating value across chains. This
    /// is the contract backstop to the guest's bridge-burn-set membership.
    function test_bridge_mint_without_burn_root_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = keccak256("btc-burn-no-root");
        // pv.bitcoinBurnRoot left 0 — no burn authority pinned.
        vm.expectRevert(ConfidentialPool.StaleBitcoinBurnRoot.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// H-1 guard: a bridge_mint against a STALE burn root (not the current reflected one) is
    /// rejected — a mint must prove burn membership against the freshest Bitcoin burn set, so
    /// it can't replay an old root that omits a since-reflected burn or predates it.
    function test_bridge_mint_stale_burn_root_reverts() public {
        _attestBtc(keccak256("bm-pool-stale"), keccak256("bm-spent-stale"), 1); // sets knownBitcoinBurnRoot
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = keccak256("btc-burn-stale");
        pv.bitcoinBurnRoot = keccak256("a-different-old-burn-root"); // != knownBitcoinBurnRoot
        vm.expectRevert(ConfidentialPool.StaleBitcoinBurnRoot.selector);
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

    /// A bridge_burn whose spent input is BITCOIN-homed (membership proven against a
    /// knownBitcoinRoot) is rejected: the crossOut would mint a fresh equal-value note on
    /// Bitcoin while the original Bitcoin UTXO stays live + spendable there (the reflection
    /// prover never reflects an Ethereum nullification back to Bitcoin) — value duplication.
    /// A bridge_burn must originate from an Ethereum-homed note.
    function test_bridge_burn_btc_homed_input_reverts() public {
        bytes32 poolRoot = keccak256("btc-pool-for-burn");
        bytes32 spentRoot = keccak256("btc-spent-for-burn");
        _attestBtc(poolRoot, spentRoot, 1); // poolRoot becomes a knownBitcoinRoot

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = poolRoot;               // Bitcoin-homed spend
        pv.bitcoinSpentRoot = spentRoot;       // pin the current reflected spent root
        bytes32 nu = keccak256("btc-homed-burn-nu");
        bytes32 destC = keccak256("btc-dest-from-btc-homed");
        uint16 destChain = 1;
        bytes32 claimId = _claimId(destChain, destC, nu, assetId);
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = nu;
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(destChain, destC, nu, assetId, claimId);

        vm.expectRevert(ConfidentialPool.BridgeBurnNotEthHomed.selector);
        pool.settle(abi.encode(pv), "", new bytes[](0));
    }

    /// Control: the SAME crossOut from an ETHEREUM-homed note (spendRoot = an everKnownRoot)
    /// settles fine — the guard only bars the Bitcoin-homed lane.
    function test_bridge_burn_eth_homed_input_ok() public {
        // Seed an Ethereum root via a prior leaf insertion, then spend against it.
        ConfidentialPool.PublicValues memory seed = _pv();
        seed.leaves = new bytes32[](1);
        seed.leaves[0] = keccak256("eth-note-leaf");
        _settle(seed);
        bytes32 ethRoot = pool.currentRoot();
        assertTrue(pool.everKnownRoot(ethRoot), "eth root known");

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = ethRoot;                // Ethereum-homed spend
        bytes32 nu = keccak256("eth-homed-burn-nu");
        bytes32 destC = keccak256("btc-dest-from-eth-homed");
        uint16 destChain = 1;
        bytes32 claimId = _claimId(destChain, destC, nu, assetId);
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = nu;
        pv.crossOuts = new ConfidentialPool.CrossOut[](1);
        pv.crossOuts[0] = ConfidentialPool.CrossOut(destChain, destC, nu, assetId, claimId);

        pool.settle(abi.encode(pv), "", new bytes[](0));
        assertTrue(pool.isNullifierSpent(nu), "eth-homed burn note nullified");
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

    /// Bitcoin state is attested ONLY by an SP1 relay proof (no trusted oracle): the
    /// proven pool root becomes canonical and the spent-set root advances.
    function test_attest_bitcoin_state_proven() public {
        bytes32 poolRoot = keccak256("btc-pool-root");
        bytes32 spentRoot = keccak256("btc-spent-root");
        vm.expectEmit(true, false, false, false, address(pool));
        emit BitcoinRootAttested(poolRoot);
        _attestBtc(poolRoot, spentRoot, 100);
        assertTrue(pool.knownBitcoinRoot(poolRoot), "pool root attested by proof");
        assertEq(pool.knownBitcoinSpentRoot(), spentRoot, "spent root advanced");
        assertEq(pool.lastRelayHeight(), 100, "height recorded");
    }

    /// A stale relay proof (height not strictly advancing) is rejected — it can't roll
    /// the reflected spent set backward to omit a recent Bitcoin spend.
    function test_stale_relay_proof_rejected() public {
        _attestBtc(keccak256("r1"), keccak256("s1"), 200);
        // a height DECREASE (rollback) is rejected; equal heights are allowed (same-block
        // effects), and the digest chain bars replay of an already-attested state.
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior, keccak256("r2"), keccak256("s2"), keccak256("b2"), 199, keccak256("next2")
        , ANCHOR, ANCHOR);
        vm.expectRevert(ConfidentialPool.StaleRelayProof.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    /// A bridge_mint against an un-attested Bitcoin root is rejected — the gate
    /// that stops minting a note proven in a fabricated tree.
    function test_bridge_mint_requires_attested_root() public {
        // A current burn root is attested (so the burn-root pin passes); the bridge_mint
        // still fails because its POOL root is not relay-attested — the membership gate.
        bytes32 burnRoot = _attestBtc(keccak256("bm-pool-4"), keccak256("bm-spent-4"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 root = keccak256("unknown-btc-root");
        bytes32 claimId = keccak256("mint-claim");
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = claimId;
        pv.bitcoinBurnRoot = burnRoot;
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
        bytes32 burnRoot = _attestBtc(root, keccak256("imt-empty-sentinel"), 1); // non-zero spent root (empty-IMT sentinel)

        ConfidentialPool.PublicValues memory pv = _pv();
        bytes32 claimId = keccak256("mint-claim-2");
        pv.bitcoinBurnsConsumed = new bytes32[](1);
        pv.bitcoinBurnsConsumed[0] = claimId;
        pv.bitcoinBurnRoot = burnRoot;
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

    // ──────────────────── trustless first-mint metadata (OP_ATTEST_META) ────────────────────

    /// A settle carrying guest-proven asset metadata lazy-deploys + registers the canonical
    /// ERC20 with exactly that (symbol, decimals) — no trusted metadata, no manual step.
    function test_settle_auto_registers_from_attested_meta() public {
        CanonicalAssetFactory factory = new CanonicalAssetFactory();
        ConfidentialPool p = new ConfidentialPool(address(verifier), VKEY, RELAY_VKEY, address(factory), address(relay), ANCHOR);

        // The guest now confirms the asset is real + funded on Bitcoin: it proves a note
        // for this asset_id is a member of a relay-attested pool root and commits that root
        // in bitcoinRootsUsed (gated ∈ knownBitcoinRoot). Attest the root first.
        bytes32 attRoot = keccak256("attested-pool-root");
        bytes32 prior = p.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory rl = ConfidentialPool.BitcoinRelayPublicValues(
            prior, attRoot, keccak256("sentinel"), keccak256("sentinel-burn"), 1, keccak256("next")
        , ANCHOR, ANCHOR);
        p.attestBitcoinStateProven(abi.encode(rl), "");

        bytes32 tacId = keccak256("attested-TAC");
        ConfidentialPool.PublicValues memory pv;
        pv.version = p.PV_VERSION();
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(p)));
        pv.assetMetas = new ConfidentialPool.AssetMeta[](1);
        pv.assetMetas[0] = ConfidentialPool.AssetMeta(tacId, bytes16("TAC"), 3, 8, bytes32(0)); // ticker "TAC", 8 dec
        pv.bitcoinRootsUsed = new bytes32[](1);
        pv.bitcoinRootsUsed[0] = attRoot; // the confirmation root the guest proved membership against
        p.settle(abi.encode(pv), "", new bytes[](0));

        address token = factory.tokenOf(tacId, address(p), "TAC", 18);
        assertTrue(token != address(0), "lazy-deployed");
        assertEq(token, factory.predict(tacId, address(p), "TAC", 18), "at f(asset_id, pool, meta)");
        assertEq(CanonicalBridgedERC20(token).symbol(), "TAC", "proven ticker");
        assertEq(CanonicalBridgedERC20(token).decimals(), 18, "harmonized to 18");
        assertEq(CanonicalBridgedERC20(token).name(), "Tacit Token", "brand");
        assertEq(CanonicalBridgedERC20(token).MINTER(), address(p), "pool is minter");

        bytes32 internalId = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), token));
        ConfidentialPool.Asset memory a = p.getAsset(internalId);
        assertTrue(a.registered, "registered");
        assertEq(a.unitScale, 1e10, "unitScale = 10^(18-8)");
        assertEq(a.crossChainLink, tacId, "linked to the Bitcoin asset id");

        // idempotent: a second attest of the same asset doesn't revert or re-register
        p.settle(abi.encode(pv), "", new bytes[](0));
        assertEq(factory.tokenOf(tacId, address(p), "TAC", 18), token, "still the same canonical token");
    }

    /// Trustless metadata is CONFIRMATION-GATED: the guest proves the asset's note
    /// membership against a Bitcoin pool root and commits it in bitcoinRootsUsed, so a
    /// fabricated/unconfirmed etch (membership against a root the relay never attested)
    /// is rejected — no junk canonical ERC20 can be lazy-deployed from it.
    function test_settle_attest_meta_requires_attested_pool_root() public {
        CanonicalAssetFactory factory = new CanonicalAssetFactory();
        ConfidentialPool p = new ConfidentialPool(address(verifier), VKEY, RELAY_VKEY, address(factory), address(relay), ANCHOR);

        ConfidentialPool.PublicValues memory pv;
        pv.version = p.PV_VERSION();
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(p)));
        pv.assetMetas = new ConfidentialPool.AssetMeta[](1);
        pv.assetMetas[0] = ConfidentialPool.AssetMeta(keccak256("junk"), bytes16("JNK"), 3, 8, bytes32(0));
        pv.bitcoinRootsUsed = new bytes32[](1);
        pv.bitcoinRootsUsed[0] = keccak256("un-attested-root"); // never relay-attested
        vm.expectRevert(ConfidentialPool.UnknownBitcoinRoot.selector);
        p.settle(abi.encode(pv), "", new bytes[](0));
    }

    // ──────────────────── Tacit-recorded asset: pool is the canonical ERC20 minter ────────────────────

    /// A Tacit-recorded asset (TAC, a cBTC equivalent, …) whose canonical public
    /// ERC20 the POOL mints on exit and burns on entry — no escrow, the pool is the
    /// single supply authority. Round-trip: unwrap → mint ERC20 (public); wrap →
    /// burn ERC20 (confidential).
    function test_pool_minted_asset_exit_and_reenter() public {
        bytes32 canonId = keccak256("TAC");
        CanonicalBridgedERC20 tac = CanonicalBridgedERC20(
            factory.deployCanonical(canonId, address(pool), "TAC", 18) // MINTER = the pool
        );
        // A local pool-minted asset (unitScale derived = 1); no cross-chain link (that path is
        // attest_meta-only). The exit/re-enter below uses the local asset id `a`.
        bytes32 a = pool.registerMinted(address(tac), "Conf TAC", "TAC", 18);

        // EXIT: an unwrap pays out by MINTING the canonical ERC20 to the recipient.
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(a, USER, 1000);
        _settle(pv);
        assertEq(tac.balanceOf(USER), 1000, "exit minted the public ERC20");
        assertEq(tac.totalSupply(), 1000, "supply = exited amount");
        assertEq(pool.escrow(a), 0, "no escrow for a pool-minted asset");

        // RE-ENTER: a wrap BURNS the canonical ERC20 (back to confidential).
        vm.prank(USER);
        pool.wrap(a, 1000, bytes32(uint256(7)), bytes32(uint256(8)), bytes32(uint256(9)));
        assertEq(tac.balanceOf(USER), 0, "re-entry burned the public ERC20");
        assertEq(tac.totalSupply(), 0, "supply back to confidential");
        assertEq(pool.escrow(a), 0, "still no escrow");
    }

    // ──────────────────── cross-lane: cross-lane gate ────────────────────

    /// A note homed on Bitcoin can be spent on the Ethereum fast lane by proving
    /// membership against a relay-proven Bitcoin pool root — but ONLY while pinning the
    /// current, non-zero reflected spent-set root (so the guest's non-membership check
    /// is enforced; see test_btc_homed_spend_omitting_gate_reverts for the bypass).
    function test_spend_against_reflected_bitcoin_root() public {
        bytes32 btcRoot = keccak256("bitcoin-pool-root");
        bytes32 spent = keccak256("bitcoin-spent-set"); // non-zero reflected spent set
        _attestBtc(btcRoot, spent, 1);

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;       // membership proven against the proven Bitcoin root
        pv.bitcoinSpentRoot = spent;  // pins the current spent set (guest proved non-membership)
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = keccak256("btc-homed-note");
        _settle(pv); // no UnknownRoot revert — Bitcoin root accepted as a spend root
        assertTrue(pool.isNullifierSpent(keccak256("btc-homed-note")), "fast-spent on Ethereum");
    }

    /// The relay can never reflect a ZERO spent-set root: an empty Bitcoin spent set has
    /// a non-zero empty-IMT sentinel root, and a zero root would re-open the cross-lane
    /// bypass (the guest skips its non-membership check when bitcoin_spent_root == 0).
    function test_attest_zero_spent_root_rejected() public {
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior, keccak256("some-pool-root"), bytes32(0), keccak256("b"), 1, keccak256("n")
        , ANCHOR, ANCHOR);
        vm.expectRevert(ConfidentialPool.StaleBitcoinSpentRoot.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    /// Symmetric to the zero-spent-root rejection: a zero bridge-BURN root must also be
    /// rejected at attest. The guest keys bridge_mint's burn-set membership off
    /// `bitcoin_burn_root != 0`, so a relay reflecting an empty burn set as 0 would let a
    /// bridge_mint skip its membership check — the contract backstop (ConfidentialPool.sol
    /// StaleBitcoinBurnRoot at attest) keeps that honest. The reflection prover seeds the
    /// empty burn set to a non-zero sentinel, so a legitimate burn root is never 0.
    function test_attest_zero_burn_root_rejected() public {
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior, keccak256("some-pool-root"), keccak256("s"), bytes32(0), 1, keccak256("n")
        , ANCHOR, ANCHOR);
        vm.expectRevert(ConfidentialPool.StaleBitcoinBurnRoot.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    // The relay anchor (F1): a batch whose tip doesn't match the relay tip (nor a recent ancestor)
    // is rejected — so the proven header chain must be canonical Bitcoin, not a free witness.
    function test_reflection_anchor_rejects_wrong_tip() public {
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior, keccak256("pr"), keccak256("s"), keccak256("sb"), 1, keccak256("n"), ANCHOR, keccak256("not-the-relay-tip")
        );
        vm.expectRevert(ConfidentialPool.UnanchoredReflection.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    // And a batch whose prev doesn't continue the prior attested tip (nor a recent ancestor) is rejected.
    function test_reflection_anchor_rejects_wrong_prev() public {
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior, keccak256("pr"), keccak256("s"), keccak256("sb"), 1, keccak256("n"), keccak256("not-the-prior-tip"), ANCHOR
        );
        vm.expectRevert(ConfidentialPool.UnanchoredReflection.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    // The reflection digest chains: a proof must continue knownReflectionDigest, and each
    // accepted proof advances it — so the reflected roots are one append-only chain.
    function test_reflection_digest_chains() public {
        assertEq(pool.knownReflectionDigest(), pool.REFLECTION_GENESIS_DIGEST(), "seeded to genesis");
        _attestBtc(keccak256("r1"), keccak256("s1"), 10);
        bytes32 advanced = pool.knownReflectionDigest();
        assertTrue(advanced != pool.REFLECTION_GENESIS_DIGEST(), "digest advanced");

        // a proof that doesn't continue the current digest is rejected
        ConfidentialPool.BitcoinRelayPublicValues memory bad = ConfidentialPool.BitcoinRelayPublicValues(
            keccak256("wrong-prior"), keccak256("r2"), keccak256("s2"), keccak256("b2"), 11, keccak256("n2")
        , ANCHOR, ANCHOR);
        vm.expectRevert(ConfidentialPool.StaleReflectionDigest.selector);
        pool.attestBitcoinStateProven(abi.encode(bad), "");

        // a zero newDigest is never a valid reflected state
        ConfidentialPool.BitcoinRelayPublicValues memory z = ConfidentialPool.BitcoinRelayPublicValues(
            advanced, keccak256("r3"), keccak256("s3"), keccak256("b3"), 11, bytes32(0)
        , ANCHOR, ANCHOR);
        vm.expectRevert(ConfidentialPool.StaleReflectionDigest.selector);
        pool.attestBitcoinStateProven(abi.encode(z), "");
    }

    /// An unattested Bitcoin root is rejected as a spend root.
    function test_spend_against_unattested_root_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = keccak256("not-attested");
        vm.expectRevert(ConfidentialPool.UnknownRoot.selector);
        _settle(pv);
    }

    // ──────────────────── cross-lane: reflected spent-set root (IMT) ────────────────────

    /// A settle whose in-guest non-membership used a stale Bitcoin spent-set root is
    /// rejected — it could omit a recent Bitcoin spend. The fresh root is relay-proven.
    function test_stale_bitcoin_spent_root_rejected() public {
        _attestBtc(keccak256("pool"), keccak256("current-root"), 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.bitcoinSpentRoot = keccak256("stale-root");
        vm.expectRevert(ConfidentialPool.StaleBitcoinSpentRoot.selector);
        _settle(pv);
    }

    /// A settle against the current relay-proven root is accepted (the guest proved
    /// non-membership of each spent ν against exactly this root).
    function test_fresh_bitcoin_spent_root_accepted() public {
        bytes32 r = keccak256("the-root");
        _attestBtc(keccak256("pool"), r, 1);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.bitcoinSpentRoot = r;
        _settle(pv); // matches → no revert
        assertEq(pool.knownBitcoinSpentRoot(), r, "unchanged");
    }

    /// The cross-lane non-membership gate is MANDATORY for a Bitcoin-homed spend
    /// (membership against a relay-proven Bitcoin root). When a non-zero Bitcoin spent
    /// set exists, a spend that omits the gate (bitcoinSpentRoot = 0) is rejected —
    /// otherwise a note already spent on Bitcoin could be re-spent on the Ethereum fast
    /// lane by simply not proving non-membership. (Contrast the spentRoot=0 case in
    /// test_spend_against_reflected_bitcoin_root, which passes only because no Bitcoin
    /// spend exists yet, so 0 IS the current spent-set root.)
    function test_btc_homed_spend_omitting_gate_reverts() public {
        bytes32 btcRoot = keccak256("btc-pool");
        _attestBtc(btcRoot, keccak256("btc-spent-set"), 1); // a real spent set exists

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;            // Bitcoin-homed: membership vs a Bitcoin root
        pv.nullifiers = _arr(keccak256("nu-note"));
        // pv.bitcoinSpentRoot left 0 → skips the cross-lane non-membership check
        vm.expectRevert(ConfidentialPool.StaleBitcoinSpentRoot.selector);
        _settle(pv);
    }

    /// The same Bitcoin-homed spend that DOES pin the current spent-set root settles —
    /// the guest proved each ν absent from exactly this Bitcoin spent set.
    function test_btc_homed_spend_with_current_gate_succeeds() public {
        bytes32 btcRoot = keccak256("btc-pool");
        bytes32 spent = keccak256("btc-spent-set");
        _attestBtc(btcRoot, spent, 1);

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spent;       // pins the current root → gate satisfied
        pv.nullifiers = _arr(keccak256("nu-note"));
        _settle(pv);
        assertTrue(pool.isNullifierSpent(keccak256("nu-note")), "fast-spent with cross-lane proof");
    }

    /// Cross-lane single-spend: a Bitcoin-homed note fast-spent on Ethereum cannot then be
    /// burned on Bitcoin and bridge-minted for the same value. The guest emits the burned ν
    /// into `nullifiers` (not just `bitcoinBurnsConsumed`), so once the fast-lane spend has
    /// consumed ν the later bridge_mint hits the nullifier set — closing fastlane→burn→mint.
    function test_btc_homed_fastspend_then_bridge_mint_reverts() public {
        bytes32 btcRoot = keccak256("btc-pool");
        bytes32 spentEmpty = keccak256("imt-empty-sentinel"); // non-zero empty-IMT sentinel
        bytes32 nu = keccak256("nu-crosslane");
        _attestBtc(btcRoot, spentEmpty, 1);

        // 1) fast-lane spend on Ethereum: ν absent from the Bitcoin spent set (not yet burned).
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spentEmpty;
        pv.nullifiers = _arr(nu);
        _settle(pv);
        assertTrue(pool.isNullifierSpent(nu), "fast-spent");

        // 2) note later burned on Bitcoin (ν now in the reflected spent set); a bridge_mint
        //    of the SAME ν carries ν in `nullifiers` (post-fix guest) → must revert.
        bytes32 spentWithNu = keccak256("btc-spent-with-nu");
        bytes32 burnRoot2 = _attestBtc(btcRoot, spentWithNu, 2);
        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.bitcoinRootsUsed = _arr(btcRoot);
        pv2.bitcoinBurnsConsumed = _arr(nu);
        pv2.nullifiers = _arr(nu); // post-fix: burned ν consumed in the global nullifier set
        pv2.bitcoinSpentRoot = spentWithNu;
        pv2.bitcoinBurnRoot = burnRoot2;
        pv2.leaves = _arr(keccak256("minted-from-burn"));
        vm.expectRevert(ConfidentialPool.NullifierAlreadySpent.selector);
        pool.settle(abi.encode(pv2), "", new bytes[](1));
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

    /// A cross-chain deploy (non-zero relay vkey) must wire BOTH a header relay AND a non-zero
    /// genesis anchor — otherwise _anchorReflection is unsatisfiable and the first attest bricks
    /// (UnanchoredReflection) forever. Both are ctor-enforced.
    function test_ctor_reflection_requires_relay_and_anchor() public {
        vm.expectRevert(ConfidentialPool.ZeroAddress.selector); // missing header relay
        new ConfidentialPool(address(verifier), VKEY, RELAY_VKEY, address(factory), address(0), ANCHOR);
        vm.expectRevert(ConfidentialPool.ZeroAddress.selector); // missing genesis anchor
        new ConfidentialPool(address(verifier), VKEY, RELAY_VKEY, address(factory), address(relay), bytes32(0));
        // Both present → deploys, anchor seeded.
        ConfidentialPool ok = new ConfidentialPool(address(verifier), VKEY, RELAY_VKEY, address(factory), address(relay), ANCHOR);
        assertEq(ok.lastReflectionBlockHash(), ANCHOR, "genesis anchor seeded");
    }

    function test_settle_withdraw_unregistered_asset_reverts() public {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(keccak256("ghost-asset"), RECIP, 10);
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        _settle(pv);
    }

    // ──────────────────── H-2: cross-chain shared-id resolution ────────────────────

    /// Establish a cross-chain link the ONLY sanctioned way: a guest-proven attest_meta. Attest a
    /// Bitcoin pool root, then settle an AssetMeta carrying the proven (ticker, decimals) — which
    /// lazy-deploys the canonical ERC20 and links `assetId` → it with the DERIVED scale. The mock
    /// verifier stands in for the guest; the point is that decimals come from the proof path.
    function _linkViaAttest(bytes32 assetId, string memory symbol_, uint8 decimals_) internal returns (address token) {
        bytes32 attRoot = keccak256(abi.encode("att-root", assetId));
        bytes32 prior = pool.knownReflectionDigest();
        pool.attestBitcoinStateProven(
            abi.encode(ConfidentialPool.BitcoinRelayPublicValues(prior, attRoot, keccak256("s"), keccak256("sb"), 1, keccak256("n"), ANCHOR, ANCHOR)),
            ""
        );
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.assetMetas = new ConfidentialPool.AssetMeta[](1);
        pv.assetMetas[0] = ConfidentialPool.AssetMeta(
            assetId, bytes16(bytes(symbol_)), uint8(bytes(symbol_).length), decimals_, _metaCid(assetId)
        );
        pv.bitcoinRootsUsed = new bytes32[](1);
        pv.bitcoinRootsUsed[0] = attRoot;
        _settle(pv);
        token = factory.tokenOf(assetId, address(pool), symbol_, 18, _metaCid(assetId));
    }

    /// A deterministic stand-in for the etch's IPFS metadata content hash.
    function _metaCid(bytes32 assetId) internal pure returns (bytes32) {
        return keccak256(abi.encode("test-meta-cid", assetId));
    }

    /// The etch-proven metadata CID flows attest_meta → factory → token, and contractURI()
    /// reconstructs a base16 CIDv1 from it — trustless (bound into asset_id), not operator-set.
    function test_attest_meta_sets_trustless_contractURI() public {
        bytes32 shared = keccak256("uri-asset");
        address tok = _linkViaAttest(shared, "cBTC", 18);
        assertEq(CanonicalBridgedERC20(tok).METADATA_CID(), _metaCid(shared), "etch CID stored on the token");
        bytes memory uri = bytes(CanonicalBridgedERC20(tok).contractURI());
        assertEq(uri.length, 80, "ipfs://f01701220 + 64 hex"); // 16 + 64
        for (uint256 i; i < 16; ++i) assertEq(uri[i], bytes("ipfs://f01701220")[i], "CIDv1 base16 prefix");
    }

    /// A front-runner cannot poison the trustless contractURI: deploying the canonical token at
    /// its f(asset_id) slot ahead of the pool's attest_meta with a DIFFERENT cid must not be
    /// adopted by the pool. The etch binds exactly one cid into asset_id, so the registered token
    /// must carry the etch-proven cid regardless of any pre-deploy.
    function test_attest_meta_cid_not_poisonable_by_front_run() public {
        bytes32 shared = keccak256("frontrun-asset");
        bytes32 attackerCid = keccak256("attacker-metadata");
        bytes32 provenCid = _metaCid(shared);
        assertTrue(attackerCid != provenCid, "distinct cids");

        // Attacker pre-deploys a canonical ERC20 for (asset_id, pool, symbol, 18) with their OWN
        // cid. Because cid is bound into the CREATE2 salt, this lands at a different address than
        // the etch-proven one — it can never shadow it.
        address attackerTok =
            factory.deployCanonical(shared, address(pool), "cBTC", 18, attackerCid);
        assertEq(CanonicalBridgedERC20(attackerTok).METADATA_CID(), attackerCid, "attacker token has attacker cid");

        // The pool now runs the guest-proven attest_meta carrying the etch's REAL cid.
        address tok = _linkViaAttest(shared, "cBTC", 18);

        // The pool deploys/uses the token at the cid-bound slot — a DIFFERENT address from the
        // attacker's, carrying the etch-proven cid (trustless contractURI, un-poisonable).
        assertTrue(tok != attackerTok, "pool's canonical token is NOT the wrong-cid pre-deploy");
        assertEq(
            CanonicalBridgedERC20(tok).METADATA_CID(), provenCid, "registered token carries the etch-proven cid"
        );
        // The pool's local registry resolves the shared id to the correct-cid token.
        bytes32 localId = pool.localAssetOf(shared);
        assertEq(pool.getAsset(localId).underlying, tok, "linked to the etch-proven token");
    }

    /// A bridged note carries the SHARED (Bitcoin-side) asset id. The attest_meta path links the
    /// shared id to the lazy-deployed canonical token, so an unwrap whose withdrawal speaks the
    /// shared id resolves to it and mints. Without the link the bridged value would be locked (H-2).
    function test_bridged_note_unwraps_via_shared_id() public {
        bytes32 shared = keccak256("shared-btc-asset");
        address tok = _linkViaAttest(shared, "cBTC", 18); // proven 18 decimals → scale 1
        assertTrue(pool.localAssetOf(shared) != bytes32(0), "shared id linked via attest_meta");

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(shared, RECIP, 7); // note speaks the shared id
        _settle(pv);
        assertEq(CanonicalBridgedERC20(tok).balanceOf(RECIP), 7, "bridged note unwrapped via shared id");
    }

    /// An external/escrow asset can never claim a shared id — escrow can't back bridged
    /// supply, so a bridge_mint could not drain escrow it never funded.
    function test_escrow_cannot_claim_shared_id() public {
        MockERC20 ext = new MockERC20();
        vm.expectRevert(ConfidentialPool.CrossChainEscrow.selector);
        pool.registerWrapped(address(ext), 1, keccak256("some-shared-id"), "x", "x", 18);
    }

    /// F1: registerMinted registers a LOCAL asset only — it establishes NO cross-chain link, so a
    /// permissionless caller can never bind localAssetOf (and thus can't poison a bridged asset's
    /// scale or token). The only link path is the guest-proven attest_meta above.
    function test_registerMinted_is_local_only_no_link() public {
        address tok = factory.deployCanonical(keccak256("local-asset"), address(pool), "LOC", 18);
        bytes32 a = pool.registerMinted(tok, "Conf LOC", "LOC", 18);
        (, , , bytes32 link, , , , ) = pool.assets(a);
        assertEq(link, bytes32(0), "registerMinted establishes no cross-chain link");
        assertEq(pool.localAssetOf(keccak256("local-asset")), bytes32(0), "no localAssetOf entry");
    }

    /// F1: a BRIDGED asset's scale is bound to the GUEST-PROVEN decimals (attest_meta), not a
    /// caller's word — a bridged unwrap pays value · 10^(18 − provenDecimals), set by the proof, so
    /// a front-runner cannot register a too-large scale and over-mint the real canonical ERC20.
    function test_bridged_scale_bound_to_proven_decimals() public {
        bytes32 shared = keccak256("proven-8dec");
        address tok = _linkViaAttest(shared, "cBTC", 8); // proven 8 decimals → scale 10^10
        bytes32 localId = pool.localAssetOf(shared);
        (, , uint256 unitScale, , , , , ) = pool.assets(localId);
        assertEq(unitScale, 10 ** 10, "scale derived from PROVEN decimals (8), not caller-chosen");

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(shared, RECIP, 3);
        _settle(pv);
        assertEq(CanonicalBridgedERC20(tok).balanceOf(RECIP), 3 * 10 ** 10, "payout = value * proven-derived scale");
    }

    /// CID-1: a permissionless registerMinted SQUAT of the EXACT etch-proven canonical token (pre-
    /// registering its internalId with a deliberately-WRONG scale) must NOT permanently lock the
    /// bridged shared id. attest_meta heals the link AND adopts the GUEST-PROVEN scale (overwriting
    /// the squat's), so the bridged value exits at the correct rate instead of reverting NotRegistered.
    /// (Overwrite is drain-safe: the canonical ERC20 is pool-minted, so a squatter holds zero balance
    /// and could not have wrapped any note at the wrong scale.)
    function test_registerMinted_squat_does_not_lock_bridged_asset() public {
        bytes32 shared = keccak256("squat-asset");
        bytes32 provenCid = _metaCid(shared);

        // Attacker pre-deploys the EXACT etch-proven canonical token (proven symbol + cid, 18 dec) and
        // registerMinted's it with a WRONG scale: tacitDecimals 18 → scale 1 (proven is 8 dec → 10^10).
        address tok = factory.deployCanonical(shared, address(pool), "cBTC", 18, provenCid);
        bytes32 internalId = pool.registerMinted(tok, "squat", "cBTC", 18);
        assertEq(pool.localAssetOf(shared), bytes32(0), "squat establishes no cross-chain link");
        (, , uint256 scaleBefore, , , , , ) = pool.assets(internalId);
        assertEq(scaleBefore, 1, "squatter registered the wrong scale");

        // The pool runs the guest-proven attest_meta (proven 8 decimals → scale 10^10).
        address proven = _linkViaAttest(shared, "cBTC", 8);
        assertEq(proven, tok, "attest_meta resolves the same salt-bound token (not a fresh deploy)");
        assertEq(pool.localAssetOf(shared), internalId, "link HEALED despite the prior squat");
        (, , uint256 scaleAfter, bytes32 link, , , , ) = pool.assets(internalId);
        assertEq(scaleAfter, 10 ** 10, "scale OVERWRITTEN to the proven scale (squat's wrong scale discarded)");
        assertEq(link, shared, "crossChainLink healed to the shared id");

        // A bridged withdrawal now exits at the proven scale instead of reverting NotRegistered.
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(shared, RECIP, 4);
        _settle(pv);
        assertEq(CanonicalBridgedERC20(tok).balanceOf(RECIP), 4 * 10 ** 10, "bridged exit at proven scale, not locked");
    }
}
