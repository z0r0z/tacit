// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Standard SP1 verifier interface (succinctlabs/sp1-contracts). Vendored here for
// the on-chain verify test only; the SP1VerifierGroth16 in v6.1.0/ imports it.

interface ISP1Verifier {
    /// @notice Verifies a proof with given public values and vkey. Reverts on failure.
    function verifyProof(
        bytes32 programVKey,
        bytes calldata publicValues,
        bytes calldata proofBytes
    ) external view;
}

interface ISP1VerifierWithHash is ISP1Verifier {
    /// @notice Returns the hash of the verifier (its first 4 bytes are the proof selector).
    function VERIFIER_HASH() external pure returns (bytes32);
}
