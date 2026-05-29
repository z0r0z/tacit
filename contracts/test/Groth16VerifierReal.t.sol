// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";

/// Exercises the REAL (non-mock) on-chain burn verifier with a REAL ceremony-key
/// proof — the path the Sepolia e2e only ran against a mock. The fixture is
/// produced by tests/gen-withdraw-proof-fixture.mjs against the finalized
/// ceremony zkey. Two things are proven:
///   1. the regenerated verifier accepts a genuine ceremony proof (the CRITICAL
///      key-mismatch fix actually works against a real proof), and
///   2. which G2 coordinate ordering the verifier requires — so the mixer's
///      _verifyProof, which forwards the envelope's native-order b, is checked
///      against ground truth rather than a mock.
contract Groth16VerifierRealTest is Test {
    Groth16Verifier verifier;

    uint256[2] a;
    uint256[2] c;
    uint256[5] pub;
    uint256[2][2] bNative;  // dapp _serializeGroth16Proof / guest order
    uint256[2][2] bSwapped; // EVM bn254 precompile order (snarkjs soliditycalldata)

    function setUp() public {
        verifier = new Groth16Verifier();
        string memory json = vm.readFile(
            string.concat(vm.projectRoot(), "/test/fixtures/withdraw_proof.json")
        );
        a[0] = vm.parseJsonUint(json, ".a[0]");
        a[1] = vm.parseJsonUint(json, ".a[1]");
        c[0] = vm.parseJsonUint(json, ".c[0]");
        c[1] = vm.parseJsonUint(json, ".c[1]");
        for (uint256 i; i < 5; ++i) {
            pub[i] = vm.parseJsonUint(json, string.concat(".publicSignals[", vm.toString(i), "]"));
        }
        bNative[0][0] = vm.parseJsonUint(json, ".b_native[0][0]");
        bNative[0][1] = vm.parseJsonUint(json, ".b_native[0][1]");
        bNative[1][0] = vm.parseJsonUint(json, ".b_native[1][0]");
        bNative[1][1] = vm.parseJsonUint(json, ".b_native[1][1]");
        // Swap c0/c1 within each Fq2 coordinate.
        bSwapped[0][0] = bNative[0][1];
        bSwapped[0][1] = bNative[0][0];
        bSwapped[1][0] = bNative[1][1];
        bSwapped[1][1] = bNative[1][0];
    }

    /// The verifier MUST accept a real ceremony proof in the precompile (swapped)
    /// ordering. If this fails, the on-chain key does not match the prover's key.
    function test_realProof_accepted_in_precompile_order() public view {
        assertTrue(verifier.verifyProof(a, bSwapped, c, pub), "real ceremony proof rejected in swapped order");
    }

    /// Ground-truth assertion of the ordering: the native (envelope) ordering is
    /// NOT what the verifier accepts. The mixer must swap b before calling.
    function test_nativeOrder_is_rejected() public view {
        assertFalse(verifier.verifyProof(a, bNative, c, pub), "native order unexpectedly accepted");
    }

    /// A flipped public input must be rejected (soundness sanity).
    function test_tamperedPublicInput_rejected() public view {
        uint256[5] memory bad = pub;
        bad[1] = bad[1] ^ 1;
        assertFalse(verifier.verifyProof(a, bSwapped, c, bad), "tampered public input accepted");
    }

    /// End-to-end of the mixer's path: pack the proof into envelope bytes exactly
    /// as the dapp's _serializeGroth16Proof does (native G2 order), then read it
    /// back with the SAME offset+swap logic TacitBridgeMixer._verifyProof now uses,
    /// and confirm the real verifier accepts. Guards against an envelope<->mixer
    /// G2-ordering regression that the mock-verifier e2e could not catch.
    function test_mixer_extraction_from_native_envelope_accepted() public view {
        // dapp packing: a[0],a[1], pi_b[0][0],pi_b[0][1],pi_b[1][0],pi_b[1][1], c[0],c[1]
        bytes memory proofBlob = abi.encodePacked(
            a[0], a[1],
            bNative[0][0], bNative[0][1], bNative[1][0], bNative[1][1],
            c[0], c[1]
        );
        // mixer extraction (post-fix): swap each Fq2 half of b.
        uint256[2] memory ea; uint256[2][2] memory eb; uint256[2] memory ec;
        ea[0] = _u(proofBlob, 0);   ea[1] = _u(proofBlob, 32);
        eb[0][0] = _u(proofBlob, 96);  eb[0][1] = _u(proofBlob, 64);
        eb[1][0] = _u(proofBlob, 160); eb[1][1] = _u(proofBlob, 128);
        ec[0] = _u(proofBlob, 192); ec[1] = _u(proofBlob, 224);
        assertTrue(verifier.verifyProof(ea, eb, ec, pub), "mixer-order extraction rejected by real verifier");
    }

    function _u(bytes memory d, uint256 o) internal pure returns (uint256 r) {
        assembly { r := mload(add(add(d, 32), o)) }
    }
}
