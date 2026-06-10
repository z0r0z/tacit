// SPDX-License-Identifier: MIT
// Pinned to 0.8.20 to match the vendored SP1 base Groth16Verifier (same as
// ConfidentialProofReal). Verify-only; the pool↔verifier digest chaining is covered by
// ConfidentialPool.t.sol (test_reflection_digest_chains).
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the REFLECTION guest ON-CHAIN, through the genuine
/// SP1VerifierGroth16 — no mock. The proof was GPU-proven on the prover box
/// (contracts/sp1/confidential/exec-reflect-prove.rs) of the reflection guest folding a REAL
/// signet confidential transfer (T_CXFER_BPP, block 307547): real PoW + 146-txid merkle
/// inclusion, real vins, real envelope output commitments, the witnessed accumulator
/// transitions. Its vkey is BITCOIN_RELAY_VKEY; its public values are the
/// BitcoinReflectionPublicValues that ConfidentialPool.attestBitcoinStateProven verifies +
/// chains. Fixture: contracts/test/fixtures/reflection_groth16.json.
contract ConfidentialReflectionProofRealTest is Test {
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
    /// the real block height, and the newDigest the JS indexer + native reproduction computed.
    function test_reflection_public_values_decode() public view {
        (
            bytes32 priorDigest,
            bytes32 poolRoot,
            bytes32 spentRoot,
            bytes32 burnRoot,
            uint64 height,
            bytes32 newDigest,
            bytes32 prevHash,
            bytes32 tipHash
        ) = abi.decode(publicValues, (bytes32, bytes32, bytes32, bytes32, uint64, bytes32, bytes32, bytes32));
        assertEq(height, 307547, "the real signet block height");
        assertEq(newDigest, 0x11985609c63b8145f57edf50c103eebb29a751028d71e60116ec76aba82d84ea, "newDigest == indexer");
        assertTrue(priorDigest != bytes32(0) && poolRoot != bytes32(0) && spentRoot != bytes32(0), "non-zero roots");
        // The header anchor the contract pins to RELAY.tip()/the prior tip: tip non-zero, prev = the
        // batch's resume anchor (headers[0]'s prev field).
        assertTrue(tipHash != bytes32(0), "committed Bitcoin tip hash (relay anchor)");
        prevHash; // bound in the proof; the contract checks it against the prior attested tip
        assertTrue(burnRoot != bytes32(0), "burn root is the non-zero sentinel (no burns in this transfer)");
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
