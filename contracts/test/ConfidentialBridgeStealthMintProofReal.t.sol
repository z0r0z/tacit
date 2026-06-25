// SPDX-License-Identifier: MIT
// Pinned to 0.8.20: the vendored SP1 base Groth16Verifier is fixed at solc 0.8.20, so this verify-only
// unit matches it (the pool↔verifier wiring is covered by the mock settle tests).
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of OP_BRIDGE_STEALTH_MINT (settle guest, op 26) ON-CHAIN, through
/// the genuine SP1VerifierGroth16 (v6.1.0) — no mock. OP_BRIDGE_STEALTH_MINT is the cross-chain
/// confidential PAY-TO-STEALTH: a Bitcoin bridge-burn's value is minted into the shared stealth lock-set
/// under the recipient's one-time pubkey (claimed later via OP_STEALTH_CLAIM), so the burn root must
/// contain the burned ν and the L opening sigma binds the cleartext amount (no over-mint).
///
/// SELF-SKIPS until the coordinated re-prove produces the fixture (contracts/test/fixtures/
/// bridgestealthmint_groth16.json, GPU-proven via harnesses/exec-bridgestealthmint.rs MODE=groth16) — the
/// stealth family has no on-chain fixture pre-re-prove (see ops/runbooks/V1-TESTNET-LAUNCH-PLAYBOOK.md §8).
/// Once the fixture lands, this verifies the real proof + pins the fixture vkey to the deployed guest, the
/// exact coherence check that catches a stale fixture. The off-chain op coverage is
/// tests/confidential-bridge-stealth-op.mjs (in the readiness gate node_suite).
contract ConfidentialBridgeStealthMintProofRealTest is Test {
    // Mirrors ConfidentialPool.PublicValues exactly (for the version decode).
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

    SP1Verifier verifier;
    bytes32 vkey;
    bytes publicValues;
    bytes proofBytes;
    bool fixturePresent;

    function setUp() public {
        verifier = new SP1Verifier();
        string memory fx = string.concat(vm.projectRoot(), "/test/fixtures/bridgestealthmint_groth16.json");
        if (!vm.exists(fx)) return; // fixture not yet generated (pending the re-prove) → tests self-skip
        fixturePresent = true;
        string memory json = vm.readFile(fx);
        vkey = vm.parseJsonBytes32(json, ".vkey");
        publicValues = vm.parseJsonBytes(json, ".publicValues");
        proofBytes = vm.parseJsonBytes(json, ".proofBytes");
    }

    modifier gated() {
        if (!fixturePresent) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// The real bridge-stealth-mint proof verifies on-chain against the settle-guest vkey (reverts on failure).
    function test_real_proof_verifies_onchain() public gated {
        verifier.verifyProof(vkey, publicValues, proofBytes);
    }

    /// Coherence: the fixture's vkey IS the committed pin — the same settle guest the pool deploys.
    function test_fixture_vkey_matches_pin() public gated {
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        assertEq(vkey, vm.parseJsonBytes32(pin, ".program_vkey"), "fixture vkey != pinned program_vkey");
    }

    function test_proof_selector_matches_verifier() public gated {
        bytes memory p = proofBytes;
        bytes4 sel;
        assembly { sel := mload(add(p, 0x20)) }
        assertEq(sel, bytes4(verifier.VERIFIER_HASH()), "selector matches v6.1.0 verifier");
    }

    /// The proof commits a v1 settle effect that consumes a Bitcoin bridge-burn (the minted value's source).
    function test_bridge_stealth_mint_effect_decodes() public gated {
        PublicValues memory pv = abi.decode(publicValues, (PublicValues));
        assertEq(pv.version, 1, "pv version");
        assertTrue(pv.bitcoinBurnRoot != bytes32(0), "burn root required (the burned-value source set)");
        assertEq(pv.swaps.length, 0, "no swaps");
        assertEq(pv.liquidity.length, 0, "no liquidity");
    }

    function test_tampered_proof_rejected() public gated {
        bytes memory bad = proofBytes;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, publicValues, bad);
    }

    function test_wrong_vkey_rejected() public gated {
        vm.expectRevert();
        verifier.verifyProof(bytes32(uint256(vkey) ^ 1), publicValues, proofBytes);
    }
}
