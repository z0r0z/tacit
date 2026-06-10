// SPDX-License-Identifier: MIT
// Pinned to 0.8.20: the vendored SP1 base Groth16Verifier is fixed at solc 0.8.20, so this
// verify-only unit matches it (the pool↔verifier wiring is covered by the mock ConfidentialPoolSwap
// settle tests).
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the confidential OP_LP_ADD op ON-CHAIN, through the genuine
/// SP1VerifierGroth16 (v6.1.0) — no mock. The proof was GPU-proven on the box
/// (contracts/sp1/confidential/exec-lp.rs MODE=groth16) for the settle guest with the OP_LP_ADD /
/// OP_LP_REMOVE ops: confidential liquidity bound by direct secp Pedersen openings (~875K cycles).
/// The op: add 100 A + 200 B in-ratio to a 1000/2000 pool (1000 shares) → reserves 1100/2200, +100
/// LP shares, two contribution nullifiers + one minted LP-share leaf. This closes the loop: JS
/// assembler → SP1 guest (zkVM) → Groth16 wrap → EVM bn254 verify, and the committed LpSettlement is
/// the one the pool's settle applies. Fixture: contracts/test/fixtures/lp_groth16.json.
contract ConfidentialLpProofRealTest is Test {
    // Mirrors ConfidentialPool.PublicValues exactly (for decoding the committed LP settlement).
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct AssetMeta { bytes32 assetId; bytes16 ticker; uint8 tickerLen; uint8 decimals; }
    struct SwapSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 reserveAPost; uint256 reserveBPost; }
    struct LpSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 sharesPre; uint256 reserveAPost; uint256 reserveBPost; uint256 sharesPost; }
    struct PublicValues {
        uint16 version; bytes32 chainBinding; bytes32 spendRoot;
        bytes32[] nullifiers; bytes32[] leaves; bytes32[] depositsConsumed;
        Withdrawal[] withdrawals; FeePayment[] fees; bytes32[] bitcoinBurnsConsumed;
        CrossOut[] crossOuts; bytes32[] bitcoinRootsUsed; bytes32 bitcoinSpentRoot;
        bytes32 bitcoinBurnRoot; AssetMeta[] assetMetas; SwapSettlement[] swaps;
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
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/lp_groth16.json"));
        vkey = vm.parseJsonBytes32(json, ".vkey");
        publicValues = vm.parseJsonBytes(json, ".publicValues");
        proofBytes = vm.parseJsonBytes(json, ".proofBytes");
    }

    /// The real LP proof verifies on-chain against the settle-guest vkey (reverts on failure).
    function test_real_proof_verifies_onchain() public view {
        verifier.verifyProof(vkey, publicValues, proofBytes);
    }

    /// Coherence: the fixture's vkey IS the committed pin (elf-vkey-pin.json program_vkey) —
    /// so this real LP proof verifies against the SAME settle guest the pool is deployed with.
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

    /// The proof commits the exact LpSettlement the pool's settle applies: poolId = keccak(A‖B),
    /// reserves 1000/2000 → 1100/2200, totalShares 1000 → 1100, with two input nullifiers (the A + B
    /// contribution notes) + one output leaf (the minted LP-share note).
    function test_lp_settlement_decodes() public view {
        PublicValues memory pv = abi.decode(publicValues, (PublicValues));
        assertEq(pv.version, 1, "pv version");
        assertEq(pv.swaps.length, 0, "no swaps in this batch");
        assertEq(pv.liquidity.length, 1, "one LP settlement");
        LpSettlement memory l = pv.liquidity[0];
        assertEq(l.poolId, keccak256(abi.encode(ASSET_A, ASSET_B)), "poolId = keccak(assetA, assetB)");
        assertEq(l.reserveAPre, 1000, "reserveAPre");
        assertEq(l.reserveBPre, 2000, "reserveBPre");
        assertEq(l.sharesPre, 1000, "sharesPre");
        assertEq(l.reserveAPost, 1100, "reserveAPost (100 A in)");
        assertEq(l.reserveBPost, 2200, "reserveBPost (200 B in)");
        assertEq(l.sharesPost, 1100, "sharesPost (+100 proportional shares)");
        assertEq(pv.nullifiers.length, 2, "two contribution nullifiers");
        assertEq(pv.leaves.length, 1, "one minted LP-share leaf");
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
