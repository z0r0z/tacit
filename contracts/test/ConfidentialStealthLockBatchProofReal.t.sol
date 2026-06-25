// SPDX-License-Identifier: MIT
// Pinned to 0.8.20: the vendored SP1 base Groth16Verifier is fixed at solc 0.8.20,
// so this verify-only unit matches it (and cannot also import ConfidentialPool,
// which is ^0.8.28 — the pool↔verifier wiring is covered by the mock settle tests).
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the confidential guest's OP_STEALTH_LOCK batch (the
/// airdrop path: N funding notes → N lock-set leaves in one proof) ON-CHAIN, through the genuine
/// SP1VerifierGroth16 (v6.1.0) — no mock. GPU-proven on the box (harnesses/exec-stealthlockbatch.rs
/// over fixtures/stealthlockbatch_op.json) for the gen-1 guest. Each lock spends its funding note's
/// nullifier (membership-proven) and appends a stealth_lock_leaf bound to a recipient one-time pubkey.
/// Proof fixture: contracts/test/fixtures/stealthlockbatch_groth16.json (the box produces it).
contract ConfidentialStealthLockBatchProofRealTest is Test {
    SP1Verifier verifier;
    bytes32 vkey;
    bytes publicValues;
    bytes proofBytes;

    function setUp() public {
        verifier = new SP1Verifier();
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/stealthlockbatch_groth16.json"));
        vkey = vm.parseJsonBytes32(json, ".vkey");
        publicValues = vm.parseJsonBytes(json, ".publicValues");
        proofBytes = vm.parseJsonBytes(json, ".proofBytes");
    }

    /// The real OP_STEALTH_LOCK batch proof verifies on-chain against the gen-1 vkey.
    function test_real_proof_verifies_onchain() public view {
        verifier.verifyProof(vkey, publicValues, proofBytes);
    }

    /// Coherence: the fixture's vkey IS the committed pin (elf-vkey-pin.json program_vkey).
    function test_fixture_vkey_matches_pin() public view {
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        assertEq(vkey, vm.parseJsonBytes32(pin, ".program_vkey"), "fixture vkey != pinned program_vkey");
    }

    /// Ground-truth: the proof's selector is the one this verifier version expects.
    function test_proof_selector_matches_verifier() public view {
        bytes memory p = proofBytes;
        bytes4 sel;
        assembly {
            sel := mload(add(p, 0x20))
        }
        assertEq(sel, bytes4(verifier.VERIFIER_HASH()), "selector matches v6.1.0 verifier");
    }

    /// A flipped byte in the proof body fails the bn254 pairing check.
    function test_tampered_proof_rejected() public {
        bytes memory bad = proofBytes;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, publicValues, bad);
    }

    /// A different program vkey is rejected (the proof is bound to the gen-1 guest).
    function test_wrong_vkey_rejected() public {
        vm.expectRevert();
        verifier.verifyProof(bytes32(uint256(vkey) ^ 1), publicValues, proofBytes);
    }

    /// The real SP1 verifier rejects a zero program vkey.
    function test_zero_vkey_rejected() public {
        vm.expectRevert();
        verifier.verifyProof(bytes32(0), publicValues, proofBytes);
    }

    /// Tampered public values are rejected (the proof commits to these exact bytes).
    function test_tampered_public_values_rejected() public {
        bytes memory bad = publicValues;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, bad, proofBytes);
    }
}
