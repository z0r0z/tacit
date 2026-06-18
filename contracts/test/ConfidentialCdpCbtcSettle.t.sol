// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier, ICdpController, ICollateralEngine, CdpLeg} from "../src/ConfidentialPool.sol";

// Mock verifier: accept any proof (the guest crypto is the real-proof suite's job; this pins the on-chain
// cBTC-lock-registry + CDP state machine + the controller/escrow gates).
contract MockSP1Verifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

// Mock CollateralEngine: the cBTC escrow gate. Toggle `ok` to exercise the escrow-insufficient path.
contract MockEngine is ICollateralEngine {
    bool public ok = true;
    function setOk(bool v) external { ok = v; }
    function escrowSufficient(bytes32, uint256) external view returns (bool) { return ok; }
}

// Mock CDP controller: records the callbacks the pool makes; can be set to revert (deny).
contract MockController is ICdpController {
    uint256 public mints;
    uint256 public closes;
    uint256 public liquidations;
    bool public revertMint;
    bool public revertLiquidate;
    function setRevert(bool m, bool l) external { revertMint = m; revertLiquidate = l; }
    function onCdpMint(CdpLeg[] calldata, uint256, bytes32) external { require(!revertMint, "deny"); mints++; }
    function onCdpClose(uint256, CdpLeg[] calldata, bytes32) external { closes++; }
    function onCdpLiquidate(CdpLeg[] calldata, uint256, bytes32) external { require(!revertLiquidate, "healthy"); liquidations++; }
}

/// Integration coverage for the IMMUTABLE cBTC + CDP contract paths (audit C-2): the cBTC lock registry
/// recorded in attest, the escrow/commitment/one-shot-gated cBTC mint, the CDP derive-authority check,
/// the controller callback, and the position spend-once dedup. The guest crypto is the real-proof suite's
/// job; here the mock verifier lets us drive the contract state machine with constructed public values.
contract ConfidentialCdpCbtcSettleTest is Test {
    ConfidentialPool pool;
    MockEngine engine;
    MockController controller;

    bytes32 constant CBTC = 0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8; // CBTC_ZK_ASSET_ID
    bytes32 lockOutpoint = keccak256("lock-outpoint-1");
    uint64 constant V_BTC = 100_000;
    bytes32 cbtcCx = bytes32(uint256(0xC0));
    bytes32 cbtcCy = bytes32(uint256(0xC1));

    function setUp() public {
        vm.chainId(1);
        engine = new MockEngine();
        // BITCOIN_RELAY_VKEY non-zero (so attest is meaningful) but HEADER_RELAY=0 (skip the anchor) and a
        // matching genesis resume digest; the mock verifier makes verifyProof a no-op.
        pool = new ConfidentialPool(
            address(new MockSP1Verifier()), bytes32(uint256(0xABCD)), bytes32(0),
            address(0), address(0), bytes32(0), 6, bytes32(0), bytes32(0), address(engine)
        );
        controller = new MockController();
    }

    // ---- helpers ----
    function _attestLock(bytes32 outpoint, uint64 vBtc, bytes32 commitment, bytes32[] memory spent) internal {
        ConfidentialPool.BitcoinRelayPublicValues memory r;
        r.priorDigest = pool.knownReflectionDigest();
        r.bitcoinPoolRoot = keccak256(abi.encode("pool", block.number, outpoint));
        r.bitcoinSpentRoot = keccak256("spent-sentinel");
        r.bitcoinBurnRoot = keccak256("burn-sentinel");
        r.bitcoinHeight = uint64(block.number + 1);
        r.newDigest = keccak256(abi.encode("new", outpoint, vBtc));
        r.ethPoolReflected = bytes32(0);
        r.cbtcBackingSats = vBtc;
        r.cbtcLocksFolded = new ConfidentialPool.CbtcLockFolded[](outpoint == bytes32(0) ? 0 : 1);
        if (outpoint != bytes32(0)) r.cbtcLocksFolded[0] = ConfidentialPool.CbtcLockFolded({outpoint: outpoint, vBtc: vBtc, commitment: commitment});
        r.cbtcLocksSpent = spent;
        r.consumedCount = 0;
        vm.roll(block.number + 1);
        pool.attestBitcoinStateProven(abi.encode(r), "");
    }

    function _pv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = pool.PV_VERSION();
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
    }
    function _settle(ConfidentialPool.PublicValues memory pv) internal {
        pool.settle(abi.encode(pv), "", new bytes[](pv.leaves.length));
    }

    function _cbtcCommit() internal view returns (bytes32) { return keccak256(abi.encodePacked(cbtcCx, cbtcCy)); }
    function _cbtcLeaf() internal view returns (bytes32) { return keccak256(abi.encodePacked(CBTC, cbtcCx, cbtcCy, bytes32(0))); }

    // ---- cBTC lock registry recorded by attest ----
    function test_attest_records_cbtc_lock() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        assertEq(pool.cbtcLockVBtc(lockOutpoint), V_BTC);
        assertEq(pool.cbtcLockCommitment(lockOutpoint), _cbtcCommit());
        assertFalse(pool.cbtcLockSpent(lockOutpoint));
        assertEq(pool.cbtcBackingSats(), V_BTC);
    }

    function test_attest_records_spent_lock() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        bytes32[] memory spent = new bytes32[](1);
        spent[0] = lockOutpoint;
        _attestLock(bytes32(0), V_BTC, bytes32(0), spent); // a later batch flags the spend
        assertTrue(pool.cbtcLockSpent(lockOutpoint));
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
        _settle(_cbtcMintPv());
        assertTrue(pool.cbtcMinted(lockOutpoint));
        // one-mint-per-lock
        ConfidentialPool.PublicValues memory pv = _cbtcMintPv();
        vm.expectRevert(ConfidentialPool.CbtcAlreadyMinted.selector);
        _settle(pv);
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

    function test_cbtc_mint_requires_escrow() public {
        _attestLock(lockOutpoint, V_BTC, _cbtcCommit(), new bytes32[](0));
        engine.setOk(false);
        ConfidentialPool.PublicValues memory pv = _cbtcMintPv();
        vm.expectRevert(ConfidentialPool.CbtcEscrowInsufficient.selector);
        _settle(pv);
    }

    // ---- CDP mint: derive-authority + controller callback + position spend-once ----
    function _cdpDebtAsset(address c) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("tacit-cdp-debt-v1", c));
    }
    function _cdpMintPv(address ctrl, bytes32 debtAsset, bytes32 posLeaf) internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv = _pv();
        pv.cdpMints = new ConfidentialPool.CdpMint[](1);
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg({asset: CBTC, value: V_BTC});
        pv.cdpMints[0] = ConfidentialPool.CdpMint({controller: ctrl, debtAsset: debtAsset, debtValue: 1000, positionLeaf: posLeaf, legs: legs});
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

    function test_cdp_mint_controller_can_deny() public {
        controller.setRevert(true, false);
        ConfidentialPool.PublicValues memory pv = _cdpMintPv(address(controller), _cdpDebtAsset(address(controller)), keccak256("pos-deny"));
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
        pv.cdpCloses[0] = ConfidentialPool.CdpClose({controller: address(controller), debtValue: 1000, positionNullifier: posNu, legs: legs});
        _settle(pv);
        assertTrue(pool.cdpPositionSpent(posNu));
        assertEq(controller.closes(), 1);
        // a second consume of the same position reverts
        vm.expectRevert(ConfidentialPool.CdpPositionAlreadySpent.selector);
        _settle(pv);
    }
}
