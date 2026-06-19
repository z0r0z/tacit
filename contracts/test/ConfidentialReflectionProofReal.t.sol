// SPDX-License-Identifier: MIT
// Pinned to 0.8.20 to match the vendored SP1 base Groth16Verifier (same as
// ConfidentialProofReal). Verify-only; the pool↔verifier digest chaining is covered by
// ConfidentialPool.t.sol (test_reflection_digest_chains).
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the REFLECTION guest ON-CHAIN, through the genuine
/// SP1VerifierGroth16 — no mock. The proof was GPU-proven on the prover box
/// (contracts/sp1/eth-reflection/prover-host/bitcoin_prove.rs): the reflection guest scans real signet through block 307547
/// (real PoW + full-block-merkle inclusion, real vins, witnessed accumulator transitions). Its vkey is
/// BITCOIN_RELAY_VKEY (genesis-pinned + the recursion hash_u32 digest); its public values are the
/// dynamic BitcoinReflectionPublicValues that ConfidentialPool.attestBitcoinStateProven verifies +
/// chains (incl. ethPoolReflected, cBTC per-lock deltas, consumedCount). Fixture:
/// contracts/test/fixtures/reflection_groth16.json. The fixture is regenerated from the committed
/// forward reflection input after the burn-envelope multi-live-spend / mismatched-ν skip-not-panic
/// hardening; the confirmed both-sided negative test (readiness-gate layer 9)
/// still shows the same ELF SKIPS non-conserving CXFERs.
contract ConfidentialReflectionProofRealTest is Test {
    struct CbtcLockFolded { bytes32 outpoint; uint256 vBtc; bytes32 commitment; }
    struct BitcoinRelayPublicValues {
        bytes32 priorDigest;
        bytes32 bitcoinPoolRoot;
        bytes32 bitcoinSpentRoot;
        bytes32 bitcoinBurnRoot;
        uint64 bitcoinHeight;
        bytes32 newDigest;
        bytes32 bitcoinPrevHash;
        bytes32 bitcoinTipHash;
        bytes32 ethPoolReflected;
        uint256 cbtcBackingSats;
        CbtcLockFolded[] cbtcLocksFolded;
        bytes32[] cbtcLocksSpent;
        uint64 consumedCount;
    }

    SP1Verifier verifier;
    bytes32 vkey;
    bytes publicValues;
    bytes proofBytes;

    function setUp() public {
        verifier = new SP1Verifier();
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/reflection_groth16.json"));
        vkey = vm.parseJsonBytes32(json, ".vkey");
        publicValues = vm.parseJsonBytes(json, ".publicValues");
        proofBytes = vm.parseJsonBytes(json, ".proofBytes");
    }

    /// The real reflection proof verifies on-chain against BITCOIN_RELAY_VKEY (reverts on failure).
    function test_reflection_proof_verifies_onchain() public view {
        verifier.verifyProof(vkey, publicValues, proofBytes);
    }

    /// Coherence: the reflection fixture's vkey IS the committed pin (elf-vkey-pin.json
    /// bitcoin_relay_vkey) — so this proof is of the SAME reflection guest a deployer would
    /// set BITCOIN_RELAY_VKEY to, not a drifted one.
    function test_fixture_vkey_matches_pin() public view {
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        assertEq(vkey, vm.parseJsonBytes32(pin, ".bitcoin_relay_vkey"), "fixture vkey != pinned bitcoin_relay_vkey");
    }

    /// The proof commits the BitcoinReflectionPublicValues attestBitcoinStateProven decodes:
    /// the real block height, and the newDigest the Mode-B reflection proof committed.
    function test_reflection_public_values_decode() public view {
        BitcoinRelayPublicValues memory pv = abi.decode(publicValues, (BitcoinRelayPublicValues));
        assertEq(pv.bitcoinHeight, 307547, "the real signet block height");
        assertEq(pv.bitcoinPoolRoot, 0x1658bfbe60f84b673045cad56a060c91cfa8a442d4320431a949bf2180d496c6, "bitcoinPoolRoot (forward reflection fixture)");
        assertEq(pv.newDigest, 0x522e57e3ab07b8adcbf8341341a7e532c8278b3cf1c9fdd48cf62e9f5fa0b475, "newDigest (forward reflection fixture)");
        assertTrue(pv.priorDigest != bytes32(0) && pv.bitcoinPoolRoot != bytes32(0) && pv.bitcoinSpentRoot != bytes32(0), "non-zero roots");
        // The header anchor the contract pins to RELAY.tip()/the prior tip: tip non-zero, prev = the
        // batch's resume anchor (headers[0]'s prev field).
        assertTrue(pv.bitcoinTipHash != bytes32(0), "committed Bitcoin tip hash (relay anchor)");
        pv.bitcoinPrevHash; // bound in the proof; the contract checks it against the prior attested tip
        assertTrue(pv.bitcoinBurnRoot != bytes32(0), "burn root is the non-zero sentinel (no burns in this transfer)");
        // Forward batch (modeB=0): no eth-reflection proof is supplied, so ethPoolReflected is the zero sentinel.
        assertEq(pv.ethPoolReflected, bytes32(0), "ethPoolReflected zero sentinel");
        // cBTC.zk: Σ live self-custody lock sats, digest-bound; 0 for this no-cBTC-lock fixture. The
        // off-pool CollateralEngine reads cbtcBackingSats() to size the peg shortfall.
        assertEq(pv.cbtcBackingSats, 0, "cbtcBackingSats (no cBTC lock in this fixture)");
        assertEq(pv.cbtcLocksFolded.length, 0, "no cBTC locks folded");
        assertEq(pv.cbtcLocksSpent.length, 0, "no cBTC locks spent");
        assertEq(pv.consumedCount, 0, "no fast-lane consumes folded");
    }

    /// Ground-truth: the proof's selector is the one this verifier version expects.
    function test_proof_selector_matches_verifier() public view {
        bytes memory p = proofBytes;
        bytes4 sel;
        assembly { sel := mload(add(p, 0x20)) }
        assertEq(sel, bytes4(verifier.VERIFIER_HASH()), "selector matches the vendored verifier");
    }

    /// A flipped byte in the proof body fails the bn254 pairing check.
    function test_tampered_proof_rejected() public {
        bytes memory bad = proofBytes;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, publicValues, bad);
    }

    /// A different vkey is rejected (the proof is bound to the reflection guest).
    function test_wrong_vkey_rejected() public {
        vm.expectRevert();
        verifier.verifyProof(bytes32(uint256(vkey) ^ 1), publicValues, proofBytes);
    }

    /// Tampered public values are rejected (the proof commits to these exact roots/digest).
    function test_tampered_public_values_rejected() public {
        bytes memory bad = publicValues;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, bad, proofBytes);
    }
}
