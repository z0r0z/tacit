// SPDX-License-Identifier: MIT
// Pinned to 0.8.20: the vendored SP1 base Groth16Verifier is fixed at solc 0.8.20,
// so this verify-only unit matches it (and cannot also import ConfidentialPool,
// which is ^0.8.28 — the pool↔verifier wiring is covered by the mock settle tests).
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the confidential guest's OP_UNWRAP (gasless exit)
/// ON-CHAIN, through the genuine SP1VerifierGroth16 (v6.1.0) — no mock. The proof is
/// GPU-proven on the prover box (contracts/sp1/confidential/harnesses/exec-unwrap.rs over
/// fixtures/unwrap_op.json) for the gen-1 guest. This closes the loop for the fund-critical
/// exit path: JS prover → SP1 guest (zkVM) → Groth16 wrap → EVM bn254 verify. The proven op
/// spends a 1500-value note to a public recipient with fee=100 ⇒ a Withdrawal of 1400 + a
/// FeePayment of 100 + one nullifier in the committed PublicValues.
/// Proof fixture: contracts/test/fixtures/unwrap_groth16.json (the box produces it).
contract ConfidentialUnwrapProofRealTest is Test {
    SP1Verifier verifier;
    bytes32 vkey;
    bytes publicValues;
    bytes proofBytes;

    function setUp() public {
        verifier = new SP1Verifier();
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/unwrap_groth16.json"));
        vkey = vm.parseJsonBytes32(json, ".vkey");
        publicValues = vm.parseJsonBytes(json, ".publicValues");
        proofBytes = vm.parseJsonBytes(json, ".proofBytes");
    }

    /// The real OP_UNWRAP proof verifies on-chain against the gen-1 vkey (reverts on failure).
    function test_real_proof_verifies_onchain() public view {
        verifier.verifyProof(vkey, publicValues, proofBytes);
    }

    /// Coherence: the fixture's vkey IS the committed pin (elf-vkey-pin.json program_vkey),
    /// so "this proof verifies" means "the pinned/deployed guest has an on-chain OP_UNWRAP proof" —
    /// not some drifted fixture. Without this, the ProofReal suite could pass against a lagging vkey.
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

    /// The real SP1 verifier rejects a zero program vkey — no valid proof exists for it.
    function test_zero_vkey_rejected() public {
        vm.expectRevert();
        verifier.verifyProof(bytes32(0), publicValues, proofBytes);
    }

    /// Tampered public values are rejected (the proof commits to these exact bytes — the
    /// recipient, the value−fee withdrawal, the fee, and the nullifier are all pinned here).
    function test_tampered_public_values_rejected() public {
        bytes memory bad = publicValues;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, bad, proofBytes);
    }
}
