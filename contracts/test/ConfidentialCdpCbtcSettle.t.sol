// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier, ICdpController, ICollateralEngine, CdpLeg} from "../src/ConfidentialPool.sol";
import {PoolStateReader} from "./PoolStateReader.sol";
using PoolStateReader for ConfidentialPool;
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";

// Mock verifier: accept any proof (the guest crypto is the real-proof suite's job; this pins the on-chain
// cBTC-lock-registry + CDP state machine + the controller/escrow gates).
contract MockSP1Verifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract MockRelayCbtc {
    bytes32 public tip;
    mapping(bytes32 => bytes32) public blockParent;

    constructor(bytes32 t) {
        tip = t;
    }

    function setTip(bytes32 t) external {
        tip = t;
    }

    function setParent(bytes32 child, bytes32 parent) external {
        blockParent[child] = parent;
    }
}

// Mock CollateralEngine: the cBTC escrow gate. Toggle `ok` to exercise the escrow-insufficient path.
contract MockEngine is ICollateralEngine {
    bool public ok = true;

    function setOk(bool v) external {
        ok = v;
    }

    function escrowSufficient(bytes32, uint256) external view returns (bool) {
        return ok;
    }
}

// Mock CDP controller: records the callbacks the pool makes; can be set to revert (deny).
contract MockController is ICdpController {
    uint256 public mints;
    uint256 public closes;
    uint256 public liquidations;
    uint256 public topups;
    bool public revertMint;
    bool public revertLiquidate;
    bool public revertTopup;

    function setRevert(bool m, bool l) external {
        revertMint = m;
        revertLiquidate = l;
    }

    function setRevertTopup(bool t) external {
        revertTopup = t;
    }

    function onCdpMint(CdpLeg[] calldata, uint256, bytes32, uint256) external {
        require(!revertMint, "deny");
        mints++;
    }

    function onCdpClose(uint256, uint256, uint256, CdpLeg[] calldata, bytes32) external {
        closes++;
    }

    function onCdpLiquidate(CdpLeg[] calldata, uint256, uint256, uint256, bytes32) external {
        require(!revertLiquidate, "healthy");
        liquidations++;
    }

    function onCdpTopup(CdpLeg[] calldata, CdpLeg[] calldata, uint256, uint256, bytes32, bytes32) external {
        require(!revertTopup, "topup-deny");
        topups++;
    }
}

/// Integration coverage for the IMMUTABLE cBTC + CDP contract paths (audit C-2): the cBTC lock registry
/// recorded in attest, the escrow/commitment/one-shot-gated cBTC mint, the CDP derive-authority check,
/// the controller callback, and the position spend-once dedup. The guest crypto is the real-proof suite's
/// job; here the mock verifier lets us drive the contract state machine with constructed public values.
contract ConfidentialCdpCbtcSettleTest is Test {
    ConfidentialPool pool;
    MockEngine engine;
    MockController controller;
    CanonicalAssetFactory factory;

    bytes32 constant CBTC = 0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8; // CBTC_ZK_ASSET_ID
    uint256 constant RAY = 1e27;
    bytes32 lockOutpoint = keccak256("lock-outpoint-1");
    uint64 constant V_BTC = 100_000;
    bytes32 cbtcCx = bytes32(uint256(0xC0));
    bytes32 cbtcCy = bytes32(uint256(0xC1));
    bytes32 constant RELAY_VKEY = bytes32(uint256(0xBEEF));
    bytes32 constant ANCHOR = bytes32(uint256(0xB17C0)); // genesis anchor == matured relay tip
    MockRelayCbtc relay;

    function setUp() public {
        vm.chainId(1);
        engine = new MockEngine();
        factory = new CanonicalAssetFactory();
        // Reflection-enabled: the mock verifier no-ops verifyProof so we drive the decoded public values
        // directly, and the relay is seeded so a batch whose tip == ANCHOR anchors as matured.
        relay = new MockRelayCbtc(ANCHOR);
        pool = new ConfidentialPool(
            address(new MockSP1Verifier()),
            bytes32(uint256(0xABCD)),
            RELAY_VKEY,
            address(factory),
            address(relay),
            ANCHOR,
            6,
            bytes32(0),
            bytes32(0),
            address(engine)
        );
        bytes32 t = ANCHOR;
        for (uint256 i; i < 6; ++i) {
            bytes32 child = keccak256(abi.encodePacked("matured-relay", ANCHOR, i));
            relay.setParent(child, t);
            t = child;
        }
        relay.setTip(t);
        controller = new MockController();
    }

    // ---- helpers ----
    function _attestRoot(bytes32 poolRoot, bytes32 spentRoot, uint64 height) internal {
        ConfidentialPool.BitcoinRelayPublicValues memory r;
        r.priorDigest = pool.knownReflectionDigest();
        r.bitcoinPoolRoot = poolRoot;
        r.bitcoinSpentRoot = spentRoot;
        r.bitcoinBurnRoot = keccak256(abi.encode("burn", poolRoot, spentRoot, height));
        r.bitcoinHeight = height;
        r.newDigest = keccak256(abi.encode("root", poolRoot, spentRoot, height));
        r.bitcoinPrevHash = ANCHOR;
        r.bitcoinTipHash = ANCHOR;
        r.ethPoolReflected = bytes32(0);
        r.consumedCount = uint64(pool.bitcoinConsumedCount());
        vm.roll(block.number + 1);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    function _lockAttestPv(bytes32 prior, bytes32 outpoint, uint256 vBtc, bytes32 commitment, bytes32[] memory spent)
        internal
        view
        returns (ConfidentialPool.BitcoinRelayPublicValues memory r)
    {
        r = _lockAttestPvWithRedeemed(prior, outpoint, vBtc, commitment, spent, new bytes32[](0));
    }

    function _lockAttestPvWithRedeemed(
        bytes32 prior,
        bytes32 outpoint,
        uint256 vBtc,
        bytes32 commitment,
        bytes32[] memory spent,
        bytes32[] memory redeemed
    ) internal view returns (ConfidentialPool.BitcoinRelayPublicValues memory r) {
        r.priorDigest = prior;
        r.bitcoinPoolRoot = keccak256(abi.encode("pool", block.number, outpoint));
        r.bitcoinSpentRoot = keccak256("spent-sentinel");
        r.bitcoinBurnRoot = keccak256("burn-sentinel");
        r.bitcoinHeight = uint64(block.number + 1);
        r.newDigest = keccak256(abi.encode("new", outpoint, vBtc));
        r.bitcoinPrevHash = ANCHOR;
        r.bitcoinTipHash = ANCHOR;
        r.ethPoolReflected = bytes32(0);
        r.cbtcBackingSats = vBtc;
        r.cbtcLocksFolded = new ConfidentialPool.CbtcLockFolded[](outpoint == bytes32(0) ? 0 : 1);
        if (outpoint != bytes32(0)) {
            r.cbtcLocksFolded[0] =
                ConfidentialPool.CbtcLockFolded({outpoint: outpoint, vBtc: vBtc, commitment: commitment});
        }
        r.cbtcLocksSpent = spent;
        r.cbtcLocksRedeemed = redeemed;
        r.consumedCount = 0;
    }

    function _attestLock(bytes32 outpoint, uint256 vBtc, bytes32 commitment, bytes32[] memory spent) internal {
        ConfidentialPool.BitcoinRelayPublicValues memory r;
        r = _lockAttestPv(pool.knownReflectionDigest(), outpoint, vBtc, commitment, spent);
        vm.roll(block.number + 1);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    function _pv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
    }

    function _settle(ConfidentialPool.PublicValues memory pv) internal {
        pool.settle(abi.encode(pv), "", new bytes[](pv.leaves.length));
    }

    function _arr(bytes32 a) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](1);
        out[0] = a;
    }

    function _cbtcCommit() internal view returns (bytes32) {
        return keccak256(abi.encodePacked(cbtcCx, cbtcCy));
    }

    function _cbtcLeaf() internal view returns (bytes32) {
        return keccak256(abi.encodePacked(CBTC, cbtcCx, cbtcCy, bytes32(0)));
    }

    // ---- cBTC lock registry recorded by attest ----
    function test_attest_records_cbtc_lock() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        assertFalse(pool.cbtcLockSpent(lockOutpoint));
        assertEq(pool.cbtcBackingSats(), V_BTC);
    }

    function test_attest_rejects_invalid_cbtc_lock_value() public {
        bytes32 prior = pool.knownReflectionDigest();
        ConfidentialPool.BitcoinRelayPublicValues memory zero =
            _lockAttestPv(prior, lockOutpoint, 0, _cbtcCommit(), new bytes32[](0));
        vm.roll(block.number + 1);
        vm.expectRevert(ConfidentialPool.ValueOutOfRange.selector);
        pool.attestBitcoinStateProven(abi.encode(zero), "");

        ConfidentialPool.BitcoinRelayPublicValues memory tooLarge =
            _lockAttestPv(prior, lockOutpoint, uint256(type(uint64).max) + 1, _cbtcCommit(), new bytes32[](0));
        vm.roll(block.number + 1);
        vm.expectRevert(ConfidentialPool.ValueOutOfRange.selector);
        pool.attestBitcoinStateProven(abi.encode(tooLarge), "");
    }

    function test_attest_records_spent_lock() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        bytes32[] memory spent = new bytes32[](1);
        spent[0] = lockOutpoint;
        _attestLock(bytes32(0), V_BTC, bytes32(0), spent); // a later batch flags the spend
        assertTrue(pool.cbtcLockSpent(lockOutpoint));
    }

    function test_attest_records_same_batch_folded_and_spent_lock_as_terminal() public {
        ConfidentialPool.BitcoinRelayPublicValues memory r =
            _lockAttestPv(pool.knownReflectionDigest(), lockOutpoint, V_BTC, _cbtcCommit(), _arr(lockOutpoint));

        vm.roll(block.number + 1);
        pool.attestBitcoinStateProven(abi.encode(r), "");
        assertTrue(pool.cbtcLockSpent(lockOutpoint));

        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        _settle(_cbtcMintPv());
    }

    function test_attest_records_redeemed_lock() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        ConfidentialPool.BitcoinRelayPublicValues memory r = _lockAttestPvWithRedeemed(
            pool.knownReflectionDigest(), bytes32(0), V_BTC, bytes32(0), new bytes32[](0), _arr(lockOutpoint)
        );
        vm.roll(block.number + 1);
        pool.attestBitcoinStateProven(abi.encode(r), "");
        assertTrue(pool.cbtcLockRedeemed(lockOutpoint));
    }

    function test_attest_rejects_spent_redeemed_conflict() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        ConfidentialPool.BitcoinRelayPublicValues memory r = _lockAttestPvWithRedeemed(
            pool.knownReflectionDigest(), bytes32(0), V_BTC, bytes32(0), _arr(lockOutpoint), _arr(lockOutpoint)
        );
        vm.roll(block.number + 1);
        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    function test_attest_rejects_unknown_spent_or_redeemed_lock() public {
        bytes32 unknown = keccak256("unknown-lock-delta");

        ConfidentialPool.BitcoinRelayPublicValues memory spent = _lockAttestPvWithRedeemed(
            pool.knownReflectionDigest(), bytes32(0), V_BTC, bytes32(0), _arr(unknown), new bytes32[](0)
        );
        vm.roll(block.number + 1);
        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        pool.attestBitcoinStateProven(abi.encode(spent), "");

        ConfidentialPool.BitcoinRelayPublicValues memory redeemed = _lockAttestPvWithRedeemed(
            pool.knownReflectionDigest(), bytes32(0), V_BTC, bytes32(0), new bytes32[](0), _arr(unknown)
        );
        vm.roll(block.number + 1);
        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        pool.attestBitcoinStateProven(abi.encode(redeemed), "");
    }

    function test_attest_rejects_duplicate_cbtc_lock_fold() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));

        ConfidentialPool.BitcoinRelayPublicValues memory dup =
            _lockAttestPv(pool.knownReflectionDigest(), lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        vm.roll(block.number + 1);
        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        pool.attestBitcoinStateProven(abi.encode(dup), "");
    }

    function test_attest_rejects_zero_cbtc_lock_outpoint() public {
        ConfidentialPool.BitcoinRelayPublicValues memory r =
            _lockAttestPv(pool.knownReflectionDigest(), bytes32(0), V_BTC, bytes32(0), new bytes32[](0));
        r.cbtcLocksFolded = new ConfidentialPool.CbtcLockFolded[](1);
        r.cbtcLocksFolded[0] =
            ConfidentialPool.CbtcLockFolded({outpoint: bytes32(0), vBtc: V_BTC, commitment: _cbtcCommit()});

        vm.roll(block.number + 1);
        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    function test_attest_rejects_duplicate_spent_lock_delta() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        bytes32[] memory spent = new bytes32[](2);
        spent[0] = lockOutpoint;
        spent[1] = lockOutpoint;

        ConfidentialPool.BitcoinRelayPublicValues memory r = _lockAttestPvWithRedeemed(
            pool.knownReflectionDigest(), bytes32(0), V_BTC, bytes32(0), spent, new bytes32[](0)
        );
        vm.roll(block.number + 1);
        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    // ---- cBTC mint: gated on the recorded lock + commitment + escrow + one-shot ----
    function _cbtcMintPv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv = _pv();
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = _cbtcLeaf();
        pv.cbtcMints = new ConfidentialPool.CbtcMint[](1);
        pv.cbtcMints[0] = ConfidentialPool.CbtcMint({outpoint: lockOutpoint, vBtc: V_BTC, commitment: _cbtcCommit()});
    }

    function test_cbtc_mint_happy_then_double_mint_reverts() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        assertFalse(pool.cbtcMinted(lockOutpoint));
        _settle(_cbtcMintPv());
        assertTrue(pool.cbtcMinted(lockOutpoint));
        // one-mint-per-lock
        ConfidentialPool.PublicValues memory pv = _cbtcMintPv();
        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        _settle(pv);
    }

    function test_cbtc_mint_rejects_spent_lock() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        bytes32[] memory spent = new bytes32[](1);
        spent[0] = lockOutpoint;
        _attestLock(bytes32(0), V_BTC, bytes32(0), spent);

        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        _settle(_cbtcMintPv());
    }

    function test_cbtc_mint_rejects_redeemed_lock() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        ConfidentialPool.BitcoinRelayPublicValues memory r = _lockAttestPvWithRedeemed(
            pool.knownReflectionDigest(), bytes32(0), V_BTC, bytes32(0), new bytes32[](0), _arr(lockOutpoint)
        );
        vm.roll(block.number + 1);
        pool.attestBitcoinStateProven(abi.encode(r), "");

        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        _settle(_cbtcMintPv());
    }

    function test_cbtc_mint_requires_recorded_lock() public {
        ConfidentialPool.PublicValues memory pv = _cbtcMintPv(); // never attested → vBtc 0 → mismatch
        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        _settle(pv);
    }

    function test_cbtc_mint_requires_matching_commitment() public {
        _attestLock(lockOutpoint, V_BTC, keccak256("different-commit"), new bytes32[](0));
        ConfidentialPool.PublicValues memory pv = _cbtcMintPv();
        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        _settle(pv);
    }

    function test_cbtc_mint_rejects_out_of_range_value_alias() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        ConfidentialPool.PublicValues memory pv = _cbtcMintPv();
        pv.cbtcMints[0].vBtc = uint256(type(uint64).max) + 1 + V_BTC;
        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        _settle(pv);
    }

    function test_cbtc_mint_requires_escrow() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        engine.setOk(false);
        ConfidentialPool.PublicValues memory pv = _cbtcMintPv();
        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        _settle(pv);
    }

    // ---- CDP mint: derive-authority + controller callback + position spend-once ----
    function _cdpDebtAsset(address c) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("tacit-cdp-debt-v1", c));
    }

    function _cdpMintPv(address ctrl, bytes32 debtAsset, bytes32 posLeaf)
        internal
        view
        returns (ConfidentialPool.PublicValues memory pv)
    {
        pv = _pv();
        pv.cdpMints = new ConfidentialPool.CdpMint[](1);
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: CBTC, value: V_BTC});
        pv.cdpMints[0] = ConfidentialPool.CdpMint({
            controller: ctrl,
            debtAsset: debtAsset,
            debtValue: 1000,
            positionLeaf: posLeaf,
            rateSnapshot: RAY,
            legs: legs,
            owner: bytes32(0)
        });
    }

    function _legs(uint256 v) internal pure returns (CdpLeg[] memory legs) {
        legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: CBTC, value: v});
    }

    function _cdpTopupPv(address ctrl, bytes32 oldPosLeaf, bytes32 newPosLeaf, bytes32 cdpRoot)
        internal
        view
        returns (ConfidentialPool.PublicValues memory pv)
    {
        pv = _pv();
        pv.cdpPositionRoot = cdpRoot;
        pv.cdpTopups = new ConfidentialPool.CdpTopup[](1);
        pv.cdpTopups[0] = ConfidentialPool.CdpTopup({
            controller: ctrl,
            debtValue: 1000,
            rateSnapshot: RAY,
            oldPositionNullifier: keccak256(abi.encodePacked("tacit-cdp-position-v1", oldPosLeaf, "spent")),
            newPositionLeaf: newPosLeaf,
            oldLegs: _legs(V_BTC),
            newLegs: _legs(uint256(V_BTC) + 1)
        });
    }

    function test_cdp_mint_derive_authority() public {
        bytes32 posLeaf = keccak256("pos-1");
        // wrong debt asset → BadCdpController
        ConfidentialPool.PublicValues memory bad = _cdpMintPv(address(controller), keccak256("not-derived"), posLeaf);
        vm.expectRevert(ConfidentialPool.BadCdpController.selector);
        _settle(bad);
        // correct derived asset → controller.onCdpMint fires + position appended
        _settle(_cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), posLeaf));
        assertEq(controller.mints(), 1);
    }

    function test_cdp_mint_rejects_non_contract_controller() public {
        address eoa = address(0xC0FFEE);
        vm.expectRevert(ConfidentialPool.BadCdpController.selector);
        _settle(_cdpMintPv(eoa, _cdpDebtAsset(eoa), keccak256("pos-eoa")));
    }

    function test_cdp_mint_controller_can_deny() public {
        controller.setRevert(true, false);
        ConfidentialPool.PublicValues memory pv =
            _cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), keccak256("pos-deny"));
        vm.expectRevert(bytes("deny"));
        _settle(pv);
    }

    function test_cdp_position_spend_once() public {
        bytes32 posLeaf = keccak256("pos-close");
        _settle(_cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), posLeaf));
        bytes32 cdpRoot = pool.cdpRoot();
        // close the position (membership is the guest's job; here the contract just dedups the nullifier)
        bytes32 posNu = keccak256(abi.encodePacked("tacit-cdp-position-v1", posLeaf, "spent"));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.cdpPositionRoot = cdpRoot;
        pv.cdpCloses = new ConfidentialPool.CdpClose[](1);
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: CBTC, value: V_BTC});
        pv.cdpCloses[0] = ConfidentialPool.CdpClose({
            controller: address(controller),
            debtValue: 1000,
            repaid: 1000,
            rateSnapshot: RAY,
            positionNullifier: posNu,
            legs: legs
        });
        _settle(pv);
        assertEq(controller.closes(), 1);
        // a second consume of the same position reverts
        vm.expectRevert(ConfidentialPool.CdpPositionAlreadySpent.selector);
        _settle(pv);
    }

    function test_zero_principal_receipt_close_does_not_require_cdp_root() public {
        bytes32 receiptNu = keccak256("farm-receipt-nullifier");
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.cdpPositionRoot = bytes32(0);
        pv.nullifiers = _arr(receiptNu);
        pv.leaves = _arr(keccak256("released-lp-note"));
        pv.cdpCloses = new ConfidentialPool.CdpClose[](1);
        pv.cdpCloses[0] = ConfidentialPool.CdpClose({
            controller: address(controller),
            debtValue: 0,
            repaid: 0,
            rateSnapshot: 0,
            positionNullifier: receiptNu,
            legs: _legs(V_BTC)
        });
        _settle(pv);
        assertEq(controller.closes(), 1);
    }

    function test_cdp_topup_consumes_old_position_and_appends_replacement() public {
        bytes32 oldLeaf = keccak256("pos-topup-old");
        bytes32 newLeaf = keccak256("pos-topup-new");
        _settle(_cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), oldLeaf));
        bytes32 oldRoot = pool.cdpRoot();

        ConfidentialPool.PublicValues memory topup = _cdpTopupPv(address(controller), oldLeaf, newLeaf, oldRoot);
        _settle(topup);
        assertEq(controller.topups(), 1);
        bytes32 newRoot = pool.cdpRoot();
        assertTrue(newRoot != oldRoot);

        ConfidentialPool.PublicValues memory closeOld = _pv();
        closeOld.cdpPositionRoot = oldRoot;
        closeOld.cdpCloses = new ConfidentialPool.CdpClose[](1);
        closeOld.cdpCloses[0] = ConfidentialPool.CdpClose({
            controller: address(controller),
            debtValue: 1000,
            repaid: 1000,
            rateSnapshot: RAY,
            positionNullifier: topup.cdpTopups[0].oldPositionNullifier,
            legs: _legs(V_BTC)
        });
        vm.expectRevert(ConfidentialPool.CdpPositionAlreadySpent.selector);
        _settle(closeOld);

        ConfidentialPool.PublicValues memory closeNew = _pv();
        closeNew.cdpPositionRoot = newRoot;
        closeNew.cdpCloses = new ConfidentialPool.CdpClose[](1);
        closeNew.cdpCloses[0] = ConfidentialPool.CdpClose({
            controller: address(controller),
            debtValue: 1000,
            repaid: 1000,
            rateSnapshot: RAY,
            positionNullifier: keccak256(abi.encodePacked("tacit-cdp-position-v1", newLeaf, "spent")),
            legs: _legs(uint256(V_BTC) + 1)
        });
        _settle(closeNew);
        assertEq(controller.closes(), 1);
    }

    function test_cdp_topup_requires_known_root() public {
        bytes32 oldLeaf = keccak256("pos-topup-root-old");
        bytes32 newLeaf = keccak256("pos-topup-root-new");
        ConfidentialPool.PublicValues memory pv = _cdpTopupPv(address(controller), oldLeaf, newLeaf, bytes32(0));
        vm.expectRevert(ConfidentialPool.UnknownCdpRoot.selector);
        _settle(pv);
    }

    function test_cdp_topup_controller_can_deny_without_spending_position() public {
        bytes32 oldLeaf = keccak256("pos-topup-deny-old");
        bytes32 newLeaf = keccak256("pos-topup-deny-new");
        _settle(_cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), oldLeaf));

        ConfidentialPool.PublicValues memory pv = _cdpTopupPv(address(controller), oldLeaf, newLeaf, pool.cdpRoot());
        controller.setRevertTopup(true);
        vm.expectRevert(bytes("topup-deny"));
        _settle(pv);

        controller.setRevertTopup(false);
        _settle(pv);
        assertEq(controller.topups(), 1);
    }

    function test_cdp_topup_rejects_non_contract_controller_without_spending_position() public {
        bytes32 oldLeaf = keccak256("pos-topup-eoa-old");
        bytes32 newLeaf = keccak256("pos-topup-eoa-new");
        _settle(_cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), oldLeaf));

        ConfidentialPool.PublicValues memory pv = _cdpTopupPv(address(0xC0FFEE), oldLeaf, newLeaf, pool.cdpRoot());
        vm.expectRevert(ConfidentialPool.BadCdpController.selector);
        _settle(pv);

        pv.cdpTopups[0].controller = address(controller);
        _settle(pv);
        assertEq(controller.topups(), 1);
    }

    function test_cdp_topup_rejects_sentinel_new_leaf_without_spending_position() public {
        bytes32 oldLeaf = keccak256("pos-topup-sentinel-old");
        _settle(_cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), oldLeaf));

        ConfidentialPool.PublicValues memory pv =
            _cdpTopupPv(address(controller), oldLeaf, bytes32(uint256(1)), pool.cdpRoot());
        vm.expectRevert(ConfidentialPool.BadCdpController.selector);
        _settle(pv);

        pv.cdpTopups[0].newPositionLeaf = keccak256("pos-topup-sentinel-new");
        _settle(pv);
        assertEq(controller.topups(), 1);
    }

    function test_cdp_close_rejects_non_contract_controller_without_spending_position() public {
        _settle(_cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), keccak256("pos-close-eoa")));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.cdpPositionRoot = pool.cdpRoot();
        pv.cdpCloses = new ConfidentialPool.CdpClose[](1);
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: CBTC, value: V_BTC});
        bytes32 posNu = keccak256("pos-close-eoa-nu");
        pv.cdpCloses[0] = ConfidentialPool.CdpClose({
            controller: address(0xC0FFEE),
            debtValue: 1000,
            repaid: 1000,
            rateSnapshot: RAY,
            positionNullifier: posNu,
            legs: legs
        });

        vm.expectRevert(ConfidentialPool.BadCdpController.selector);
        _settle(pv);

        pv.cdpCloses[0].controller = address(controller);
        _settle(pv);
        assertEq(controller.closes(), 1);
    }

    function test_cdp_liquidate_rejects_non_contract_controller_without_spending_position() public {
        _settle(_cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), keccak256("pos-liq-eoa")));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.cdpPositionRoot = pool.cdpRoot();
        pv.cdpLiquidations = new ConfidentialPool.CdpLiquidate[](1);
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: CBTC, value: V_BTC});
        bytes32 posNu = keccak256("pos-liq-eoa-nu");
        pv.cdpLiquidations[0] = ConfidentialPool.CdpLiquidate({
            controller: address(0xC0FFEE),
            debtValue: 1000,
            repaid: 1000,
            rateSnapshot: RAY,
            positionNullifier: posNu,
            legs: legs
        });

        vm.expectRevert(ConfidentialPool.BadCdpController.selector);
        _settle(pv);

        pv.cdpLiquidations[0].controller = address(controller);
        _settle(pv);
        assertEq(controller.liquidations(), 1);
    }

    // A liquidation/seizure payout is a PUBLIC cBTC withdrawal emitted by the proof, so cBTC must resolve to
    // a registered pool-minted ERC20 for the payout to succeed. cBTC-capable pools now wire factory + engine
    // atomically, so the payout mints canonical cBTC.tac instead of failing closed on an unregistered note id.
    function test_liquidation_seize_of_cbtc_resolves_and_mints() public {
        _settle(_cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), keccak256("pos-seize")));
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.cdpPositionRoot = pool.cdpRoot();
        pv.cdpLiquidations = new ConfidentialPool.CdpLiquidate[](1);
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: CBTC, value: V_BTC});
        pv.cdpLiquidations[0] = ConfidentialPool.CdpLiquidate({
            controller: address(controller),
            debtValue: 1000,
            repaid: 1000,
            rateSnapshot: RAY,
            positionNullifier: keccak256("pos-seize-nu"),
            legs: legs
        });
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal({assetId: CBTC, recipient: address(controller), value: V_BTC});

        _settle(pv);
        CanonicalBridgedERC20 cbtc = CanonicalBridgedERC20(pool.canonicalTokenFor(CBTC));
        assertEq(controller.liquidations(), 1);
        assertEq(cbtc.balanceOf(address(controller)), uint256(V_BTC) * 1e10);
    }

    function test_btc_homed_cdp_mint_records_consumed_nullifier() public {
        bytes32 btcRoot = keccak256("btc-cdp-root");
        bytes32 spentRoot = keccak256("btc-cdp-spent");
        _attestRoot(btcRoot, spentRoot, 1);

        bytes32 nu = keccak256("btc-cdp-nu");
        ConfidentialPool.PublicValues memory pv =
            _cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), keccak256("btc-cdp-pos"));
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spentRoot;
        pv.nullifiers = _arr(nu);
        _settle(pv);

        assertEq(pool.bitcoinConsumed(nu), btcRoot);
        assertEq(pool.bitcoinConsumedCount(), 1);
    }

    function test_btc_homed_cdp_mint_requires_consumed_nullifier() public {
        bytes32 btcRoot = keccak256("btc-cdp-root-empty");
        bytes32 spentRoot = keccak256("btc-cdp-spent-empty");
        _attestRoot(btcRoot, spentRoot, 1);

        ConfidentialPool.PublicValues memory pv =
            _cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), keccak256("btc-cdp-pos-empty"));
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spentRoot;
        vm.expectRevert(ConfidentialPool.BtcHomedValueExitMustBridge.selector);
        _settle(pv);
    }

    function test_btc_homed_cdp_topup_records_consumed_nullifier() public {
        bytes32 oldLeaf = keccak256("btc-topup-old");
        _settle(_cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), oldLeaf));
        bytes32 cdpRoot = pool.cdpRoot();

        bytes32 btcRoot = keccak256("btc-topup-root");
        bytes32 spentRoot = keccak256("btc-topup-spent");
        _attestRoot(btcRoot, spentRoot, 1);

        bytes32 nu = keccak256("btc-topup-nu");
        ConfidentialPool.PublicValues memory pv =
            _cdpTopupPv(address(controller), oldLeaf, keccak256("btc-topup-new"), cdpRoot);
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spentRoot;
        pv.nullifiers = _arr(nu);
        _settle(pv);

        assertEq(pool.bitcoinConsumed(nu), btcRoot);
        assertEq(pool.bitcoinConsumedCount(), 1);
        assertEq(controller.topups(), 1);
    }

    function test_btc_homed_cdp_topup_requires_consumed_nullifier() public {
        bytes32 oldLeaf = keccak256("btc-topup-empty-old");
        _settle(_cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), oldLeaf));

        bytes32 btcRoot = keccak256("btc-topup-empty-root");
        bytes32 spentRoot = keccak256("btc-topup-empty-spent");
        _attestRoot(btcRoot, spentRoot, 1);

        ConfidentialPool.PublicValues memory pv =
            _cdpTopupPv(address(controller), oldLeaf, keccak256("btc-topup-empty-new"), pool.cdpRoot());
        pv.spendRoot = btcRoot;
        pv.bitcoinSpentRoot = spentRoot;
        vm.expectRevert(ConfidentialPool.BtcHomedValueExitMustBridge.selector);
        _settle(pv);
    }
}
