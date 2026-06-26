// SPDX-License-Identifier: MIT
// Pinned to 0.8.20: the vendored SP1 base Groth16Verifier is fixed at solc 0.8.20, so this
// verify-only unit matches it (and cannot also import ConfidentialPool, ^0.8.28 — the pool↔
// verifier wiring is covered by the mock ConfidentialPoolSwap settle tests).
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the confidential OP_SWAP op ON-CHAIN, through the genuine
/// SP1VerifierGroth16 (v6.1.0) — no mock. The proof was GPU-proven on the box
/// (contracts/sp1/confidential/exec-swap.rs MODE=groth16) for the settle guest after OP_SWAP was
/// simplified to bind amounts with direct secp Pedersen openings (no in-guest BabyJubJub →
/// ~513K cycles/intent, vs ~6.06B with the BJJ+sigma binding). The batch: A→B 100→90, pool
/// reserves 1000/1000 → 1100/910. This closes the loop: JS assembler → SP1 guest (zkVM) → Groth16
/// wrap → EVM bn254 verify, and the committed SwapSettlement is the one the pool's settle applies.
/// Fixture: contracts/test/fixtures/swap_groth16.json.
contract ConfidentialSwapProofRealTest is Test {
    // Mirrors ConfidentialPool.PublicValues exactly (for decoding the committed swap settlement).
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct SwapSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 reserveAPost; uint256 reserveBPost; }
    struct LpSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 sharesPre; uint256 reserveAPost; uint256 reserveBPost; uint256 sharesPost; }
    struct PublicValues {
        uint16 version; bytes32 chainBinding; bytes32 spendRoot;
        bytes32[] nullifiers; bytes32[] leaves; bytes32[] depositsConsumed;
        Withdrawal[] withdrawals; FeePayment[] fees; bytes32[] bitcoinBurnsConsumed;
        CrossOut[] crossOuts; bytes32[] bitcoinRootsUsed; bytes32 bitcoinSpentRoot;
        bytes32 bitcoinBurnRoot; SwapSettlement[] swaps;
        LpSettlement[] liquidity;
    }

    bytes32 constant ASSET_A = bytes32(uint256(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa));
    bytes32 constant ASSET_B = bytes32(uint256(0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb));

    SP1Verifier verifier;
    bytes32 vkey;
    bytes publicValues;
    bytes proofBytes;

    function setUp() public {
        verifier = new SP1Verifier();
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/swap_groth16.json"));
        vkey = vm.parseJsonBytes32(json, ".vkey");
        publicValues = vm.parseJsonBytes(json, ".publicValues");
        proofBytes = vm.parseJsonBytes(json, ".proofBytes");
    }

    /// The real swap proof verifies on-chain against the settle-guest vkey (reverts on failure).
    function test_real_proof_verifies_onchain() public view {
        verifier.verifyProof(vkey, publicValues, proofBytes);
    }

    /// Coherence: the fixture's vkey IS the committed pin (elf-vkey-pin.json program_vkey) —
    /// so this real swap proof verifies against the SAME settle guest the pool is deployed with.
    function test_fixture_vkey_matches_pin() public view {
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        assertEq(vkey, vm.parseJsonBytes32(pin, ".program_vkey"), "fixture vkey != pinned program_vkey");
    }

    /// Ground-truth: the proof's selector is the one this verifier version expects.
    function test_proof_selector_matches_verifier() public view {
        bytes memory p = proofBytes;
        bytes4 sel;
        assembly { sel := mload(add(p, 0x20)) }
        assertEq(sel, bytes4(verifier.VERIFIER_HASH()), "selector matches v6.1.0 verifier");
    }

    /// The proof commits the exact SwapSettlement the pool's settle applies: poolId = keccak(A‖B),
    /// reserves 1000/1000 → 1100/910, with one input nullifier + one output leaf.
    function test_swap_settlement_decodes() public view {
        PublicValues memory pv = abi.decode(publicValues, (PublicValues));
        assertEq(pv.version, 1, "pv version");
        assertEq(pv.swaps.length, 1, "one swap settlement");
        SwapSettlement memory s = pv.swaps[0];
        assertEq(s.poolId, keccak256(abi.encode(ASSET_A, ASSET_B, uint32(30))), "poolId = keccak(assetA, assetB, feeBps)");
        assertEq(s.reserveAPre, 1000, "reserveAPre");
        assertEq(s.reserveBPre, 1000, "reserveBPre");
        assertEq(s.reserveAPost, 1100, "reserveAPost (A in)");
        assertEq(s.reserveBPost, 910, "reserveBPost (B out)");
        assertEq(pv.nullifiers.length, 1, "one input nullifier");
        assertEq(pv.leaves.length, 1, "one output leaf");
    }

    /// A flipped byte in the proof body fails the bn254 pairing check.
    function test_tampered_proof_rejected() public {
        bytes memory bad = proofBytes;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, publicValues, bad);
    }

    /// A different program vkey is rejected (the proof is bound to the settle guest).
    function test_wrong_vkey_rejected() public {
        vm.expectRevert();
        verifier.verifyProof(bytes32(uint256(vkey) ^ 1), publicValues, proofBytes);
    }

    /// Tampered public values are rejected (the proof commits to these exact bytes).
    function test_tampered_public_values_rejected() public {
        bytes memory bad = publicValues;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, bad, proofBytes);
    }
}
