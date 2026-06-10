// SPDX-License-Identifier: MIT
// Pinned to 0.8.20 to match the vendored SP1 base Groth16Verifier (as
// ConfidentialProofReal.t.sol), so this verify-only unit links against it.
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of a BRIDGE cross-lane settle ON-CHAIN,
/// through the genuine SP1VerifierGroth16 (v6.1.0). The cross-lane path is a settle
/// whose guest ran the per-input Bitcoin spent-set NON-MEMBERSHIP check (a transfer
/// with `bitcoinSpentRoot != 0`), proving the cross-lane gate end-to-end — not just
/// `CROSSLANE_OK` in the zkVM. Proof fixture: test/fixtures/crosslane_groth16.json,
/// produced by the prover box (contracts/sp1/confidential/exec-crosslane.rs) for the
/// frozen gen-1 guest vkey.
///
/// FIXTURE-GATED: until the box drops the fixture, this is a documented no-op so it
/// never blocks the suite; the on-chain verification lands automatically the instant
/// the proof exists. See ops/RUNBOOK-confidential-pool-deploy.md (cross-lane activation).
contract ConfidentialCrossLaneProofRealTest is Test {
    function _path() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/fixtures/crosslane_groth16.json");
    }

    /// The real cross-lane proof verifies on-chain against the frozen guest vkey.
    function test_crosslane_proof_verifies_onchain() public {
        if (!vm.exists(_path())) {
            emit log("crosslane_groth16.json absent - box proof pending (see deploy runbook)");
            return;
        }
        string memory json = vm.readFile(_path());
        bytes32 vkey = vm.parseJsonBytes32(json, ".vkey");
        bytes memory publicValues = vm.parseJsonBytes(json, ".publicValues");
        bytes memory proofBytes = vm.parseJsonBytes(json, ".proofBytes");
        // Coherence: the cross-lane fixture is a proof of the SAME pinned settle guest.
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        assertEq(vkey, vm.parseJsonBytes32(pin, ".program_vkey"), "fixture vkey != pinned program_vkey");
        SP1Verifier verifier = new SP1Verifier();
        verifier.verifyProof(vkey, publicValues, proofBytes); // reverts on failure

        // Sanity-check the (trusted, box-produced) fixture is the BRIDGE path: the
        // box records the settle's cross-lane root as `.bitcoinSpentRoot`, which must
        // be non-zero (a plain transfer commits 0 and runs no non-membership check).
        // The authoritative check is the on-chain verification above; this guards
        // against pointing the fixture at a non-cross-lane proof by mistake.
        assertTrue(
            vm.parseJsonBytes32(json, ".bitcoinSpentRoot") != bytes32(0),
            "cross-lane proof commits a non-zero Bitcoin spent root"
        );
    }
}
