// SPDX-License-Identifier: MIT
// Pinned to 0.8.20: the vendored SP1 base Groth16Verifier is fixed at solc 0.8.20 (same as the farm/swap/lp/otc/bid
// ProofReal units), so this verify-only unit mirrors ConfidentialPool.PublicValues locally rather than importing
// the ^0.8.28 pool.
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of OP_SEND_AND_UNWRAP (op 28) ON-CHAIN, through the genuine
/// SP1VerifierGroth16 (v6.1.0) — no mock. The proof was GPU-proven on the box against the committed settle ELF,
/// the same vkey the pool deploys with. OP_SEND_AND_UNWRAP is a partial public exit: spend ONE hidden note → a
/// PUBLIC withdrawal(payout) to an EVM recipient + HIDDEN change note(s) back to the sender, in one settle. Only
/// `payout` (+ optional fee) is public; the note value stays PRIVATE (no full-value public exit). The opening
/// sigma binds (recipient, payout, fee, deadline). Fixture: contracts/test/fixtures/sendunwrap_groth16.json.
contract ConfidentialSendUnwrapProofRealTest is Test {
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

    function test_sendunwrap_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("sendunwrap_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_sendunwrap_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("sendunwrap_groth16.json");
        assertEq(vkey, _pinnedVkey(), "sendunwrap fixture vkey != pinned program_vkey");
    }

    function test_sendunwrap_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("sendunwrap_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        // Exactly one input note spent.
        assertEq(pv.nullifiers.length, 1, "one nullifier (the spent hidden note)");
        // Exactly one PUBLIC withdrawal: the payout to the EVM recipient.
        assertEq(pv.withdrawals.length, 1, "one withdrawal (the payout)");
        assertGt(pv.withdrawals[0].value, 0, "payout > 0");
        assertTrue(pv.withdrawals[0].recipient != address(0), "payout has an EVM recipient");
        // At least one HIDDEN change leaf back to the sender — this is what keeps the note value private
        // (a whole-note public exit would use OP_UNWRAP and emit no change leaf).
        assertGe(pv.leaves.length, 1, ">=1 hidden change leaf (note value stays private)");
        // No CDP / swap / LP / cross-out side effects: this is a pure partial-exit op.
        assertEq(pv.cdpMints.length, 0, "no CdpMint");
        assertEq(pv.cdpCloses.length, 0, "no CdpClose");
        assertEq(pv.swaps.length, 0, "no swaps");
        assertEq(pv.liquidity.length, 0, "no liquidity");
        assertEq(pv.crossOuts.length, 0, "no crossOuts");
    }

    function test_sendunwrap_tampered_proof_rejected() public {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("sendunwrap_groth16.json");
        proof[proof.length - 1] ^= 0x01;
        vm.expectRevert();
        verifier.verifyProof(vkey, pv, proof);
    }
}
