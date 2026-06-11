// SPDX-License-Identifier: MIT
// Pinned to 0.8.20: the vendored SP1 base Groth16Verifier is fixed at solc 0.8.20, so this
// verify-only unit matches it (the pool↔verifier wiring is covered by the mock settle tests).
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the confidential OP_OTC op ON-CHAIN, through the genuine
/// SP1VerifierGroth16 (v6.1.0) — no mock. The proof was GPU-proven on the box
/// (contracts/sp1/confidential/exec-otc.rs MODE=groth16) for the settle guest's OP_OTC: a 2-party
/// direct swap of shielded notes (maker gives 100 A for 50 B, maker spends a 150 A note → 50 A
/// change; taker exact). Amounts bound by opening sigmas under a shared intent context. The op
/// emits 2 input nullifiers + 3 output leaves (taker A, maker B, maker A change) and no
/// swap/LP settlement. Fixture: contracts/test/fixtures/otc_groth16.json.
contract ConfidentialOtcProofRealTest is Test {
    // Mirrors ConfidentialPool.PublicValues exactly.
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct AssetMeta { bytes32 assetId; bytes16 ticker; uint8 tickerLen; uint8 decimals; bytes32 cid; }
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

    SP1Verifier verifier;
    bytes32 vkey;
    bytes publicValues;
    bytes proofBytes;

    function setUp() public {
        verifier = new SP1Verifier();
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/otc_groth16.json"));
        vkey = vm.parseJsonBytes32(json, ".vkey");
        publicValues = vm.parseJsonBytes(json, ".publicValues");
        proofBytes = vm.parseJsonBytes(json, ".proofBytes");
    }

    /// The real OTC proof verifies on-chain against the settle-guest vkey (reverts on failure).
    function test_real_proof_verifies_onchain() public view {
        verifier.verifyProof(vkey, publicValues, proofBytes);
    }

    /// Coherence: the fixture's vkey IS the committed pin — the same settle guest the pool deploys.
    function test_fixture_vkey_matches_pin() public view {
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        assertEq(vkey, vm.parseJsonBytes32(pin, ".program_vkey"), "fixture vkey != pinned program_vkey");
    }

    function test_proof_selector_matches_verifier() public view {
        bytes memory p = proofBytes;
        bytes4 sel;
        assembly { sel := mload(add(p, 0x20)) }
        assertEq(sel, bytes4(verifier.VERIFIER_HASH()), "selector matches v6.1.0 verifier");
    }

    /// The proof commits the OTC effect the pool's settle applies: 2 input nullifiers + 3 output
    /// leaves, and no pool (swap/LP) settlement.
    function test_otc_effect_decodes() public view {
        PublicValues memory pv = abi.decode(publicValues, (PublicValues));
        assertEq(pv.version, 1, "pv version");
        assertEq(pv.swaps.length, 0, "no swaps");
        assertEq(pv.liquidity.length, 0, "no liquidity");
        assertEq(pv.nullifiers.length, 2, "two input nullifiers (maker + taker)");
        assertEq(pv.leaves.length, 3, "three output leaves (taker A, maker B, maker A change)");
        assertTrue(pv.nullifiers[0] != pv.nullifiers[1], "distinct nullifiers");
    }

    function test_tampered_proof_rejected() public {
        bytes memory bad = proofBytes;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, publicValues, bad);
    }

    function test_wrong_vkey_rejected() public {
        vm.expectRevert();
        verifier.verifyProof(bytes32(uint256(vkey) ^ 1), publicValues, proofBytes);
    }

    function test_tampered_public_values_rejected() public {
        bytes memory bad = publicValues;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, bad, proofBytes);
    }
}
