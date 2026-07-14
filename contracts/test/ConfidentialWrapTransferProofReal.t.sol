// SPDX-License-Identifier: MIT
// Pinned to 0.8.20: the vendored SP1 base Groth16Verifier is fixed at solc 0.8.20 (same as the farm/swap/lp
// ProofReal units), so this verify-only unit mirrors ConfidentialPool.PublicValues locally rather than
// importing the ^0.8.28 pool.
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the OP_WRAP_TRANSFER (op 27) settle ON-CHAIN, through the genuine
/// SP1VerifierGroth16 (v6.1.0) — no mock. OP_WRAP_TRANSFER is atomic wrap-and-send: it consumes a PENDING
/// PUBLIC deposit (opening-sigma bound, only the depositor who knows the blinding can spend it) and emits the
/// HIDDEN recipient note plus change note(s) under the OP_TRANSFER conservation kernel — in one settle. The
/// wrapped deposit is spent into the outputs (NOT re-emitted as a self-note leaf); the contract marks the
/// deposit consumed (pv.depositsConsumed) and inserts the output leaves. Fixture:
/// contracts/test/fixtures/wraptransfer_groth16.json.
contract ConfidentialWrapTransferProofRealTest is Test {
    // Mirrors ConfidentialPool.PublicValues exactly (for decoding the committed settlement).
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct SwapSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 reserveAPost; uint256 reserveBPost; }
    struct LpSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 sharesPre; uint256 reserveAPost; uint256 reserveBPost; uint256 sharesPost; }
    struct CdpLeg { bytes32 asset; uint256 value; }
    struct CdpMint { address controller; bytes32 debtAsset; uint256 debtValue; bytes32 positionLeaf; uint256 rateSnapshot; CdpLeg[] legs; }
    struct CdpClose { address controller; uint256 debtValue; uint256 repaid; uint256 rateSnapshot; bytes32 positionNullifier; CdpLeg[] legs; }
    struct CdpLiquidate { address controller; uint256 debtValue; uint256 repaid; uint256 rateSnapshot; bytes32 positionNullifier; CdpLeg[] legs; }
    struct CdpTopup { address controller; uint256 debtValue; uint256 rateSnapshot; bytes32 oldPositionNullifier; bytes32 newPositionLeaf; CdpLeg[] oldLegs; CdpLeg[] newLegs; }
    struct CbtcMint { bytes32 outpoint; uint256 vBtc; bytes32 commitment; }
    struct PublicValues {
        uint16 version; bytes32 chainBinding; bytes32 spendRoot;
        bytes32[] nullifiers; bytes32[] leaves; bytes32[] depositsConsumed;
        Withdrawal[] withdrawals; FeePayment[] fees; bytes32[] bitcoinBurnsConsumed;
        CrossOut[] crossOuts; bytes32[] bitcoinRootsUsed; bytes32 bitcoinSpentRoot; bytes32 bitcoinBurnRoot;
        SwapSettlement[] swaps; LpSettlement[] liquidity; uint64 deadline;
        bytes32 lockSetRoot; bytes32[] lockLeaves; bytes32[] lockNullifiers; bytes32[] adaptorClaimS; uint64 refundNotBefore;
        bytes32 cdpPositionRoot; CdpMint[] cdpMints; CdpClose[] cdpCloses; CdpLiquidate[] cdpLiquidations; CdpTopup[] cdpTopups; CbtcMint[] cbtcMints;
    }

    SP1Verifier verifier;

    function setUp() public {
        verifier = new SP1Verifier();
    }

    function _load(string memory name) internal view returns (bytes32 vkey, bytes memory pv, bytes memory proof) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/", name));
        vkey = vm.parseJsonBytes32(json, ".vkey");
        pv = vm.parseJsonBytes(json, ".publicValues");
        proof = vm.parseJsonBytes(json, ".proofBytes");
    }

    function _pinnedVkey() internal view returns (bytes32) {
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        return vm.parseJsonBytes32(pin, ".program_vkey");
    }

    function test_wraptransfer_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("wraptransfer_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_wraptransfer_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("wraptransfer_groth16.json");
        assertEq(vkey, _pinnedVkey(), "wraptransfer fixture vkey != pinned program_vkey");
    }

    function test_wraptransfer_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("wraptransfer_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        // The wrapped deposit is consumed (spent into the outputs, not re-emitted as a self-note leaf).
        assertEq(pv.depositsConsumed.length, 1, "one deposit consumed (the wrapped deposit)");
        // Output leaf = hidden recipient note (exact wrap, no change).
        assertEq(pv.leaves.length, 2, "two leaves (recipient + change notes)");
        // Single input is the public deposit commitment, not a tree note -> no nullifiers.
        assertEq(pv.nullifiers.length, 0, "no nullifiers (input is the public deposit, not a tree note)");
        // No public payout of the wrapped value: conservation keeps everything in hidden notes.
        assertEq(pv.withdrawals.length, 0, "no public withdrawals");
        assertEq(pv.crossOuts.length, 0, "no cross-outs");
        assertEq(pv.cdpMints.length, 0, "no CdpMint");
        assertEq(pv.cdpCloses.length, 0, "no CdpClose");
        // Router path is fee-free (user-sent); this fixture is the router shape.
        assertEq(pv.fees.length, 0, "no fee (router-sent wrap-transfer)");
    }

    function test_tampered_proof_rejected() public {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("wraptransfer_groth16.json");
        proof[proof.length - 1] ^= 0x01;
        vm.expectRevert();
        verifier.verifyProof(vkey, pv, proof);
    }
}
