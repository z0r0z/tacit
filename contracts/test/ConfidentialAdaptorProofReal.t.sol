// SPDX-License-Identifier: MIT
// Pinned to 0.8.20 (the vendored SP1 Groth16Verifier), like the swap/lp/otc/bid/farm/cdp/cbtc ProofReal units.
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the adaptor-swap claim (OP_ADAPTOR_CLAIM) ON-CHAIN, through the genuine
/// SP1VerifierGroth16 (v6.1.0) — no mock. GPU-proven on the box (exec-gap.rs, op 13) against the committed settle
/// ELF; the witness (lock-set membership of L, the output O opening-sigma — the locker-griefing fix — and the
/// adaptor-completed conservation kernel over L_C−O_C) is built from scratch in
/// scripts/build-adaptor-exec-fixture.mjs and pre-validated by the reflect-exec adaptor-execute emulator. This
/// brings the adaptor to the same on-chain-proof bar as every other value path; the contract-side lock-set /
/// deadline gates are covered by ConfidentialPool.t.sol (test_adaptor_*). Fixture:
/// contracts/test/fixtures/adaptor_claim_groth16.json.
contract ConfidentialAdaptorProofRealTest is Test {
    struct Withdrawal { bytes32 assetId; address recipient; uint256 value; }
    struct FeePayment { bytes32 assetId; uint256 value; }
    struct CrossOut { uint16 destChain; bytes32 destCommitment; bytes32 nullifier; bytes32 assetId; bytes32 claimId; }
    struct SwapSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 reserveAPost; uint256 reserveBPost; }
    struct LpSettlement { bytes32 poolId; uint256 reserveAPre; uint256 reserveBPre; uint256 sharesPre; uint256 reserveAPost; uint256 reserveBPost; uint256 sharesPost; }
    struct CdpLeg { bytes32 asset; uint256 value; }
    struct CdpMint { address controller; bytes32 debtAsset; uint256 debtValue; bytes32 positionLeaf; CdpLeg[] legs; }
    struct CdpClose { address controller; uint256 debtValue; bytes32 positionNullifier; CdpLeg[] legs; }
    struct CdpLiquidate { address controller; uint256 debtValue; bytes32 positionNullifier; CdpLeg[] legs; }
    struct CdpTopup { address controller; uint256 debtValue; bytes32 oldPositionNullifier; bytes32 newPositionLeaf; CdpLeg[] oldLegs; CdpLeg[] newLegs; }
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

    function setUp() public { verifier = new SP1Verifier(); }

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

    function test_adaptor_claim_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("adaptor_claim_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_adaptor_claim_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("adaptor_claim_groth16.json");
        assertEq(vkey, _pinnedVkey(), "adaptor fixture vkey != pinned program_vkey");
    }

    function test_adaptor_claim_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("adaptor_claim_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.adaptorClaimS.length, 1, "one committed kernel s (the t-reveal channel)");
        assertTrue(pv.adaptorClaimS[0] != bytes32(0), "kernel s is non-zero");
        assertEq(pv.lockNullifiers.length, 1, "one lock nullifier (L spent once)");
        assertEq(pv.leaves.length, 1, "one leaf (the recipient output note O)");
        assertTrue(pv.lockSetRoot != bytes32(0), "membership proven against a non-zero lock-set root");
        assertEq(pv.cdpMints.length, 0, "no CDP mint on an adaptor claim");
    }

    function test_tampered_proof_rejected() public {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("adaptor_claim_groth16.json");
        proof[proof.length - 1] ^= 0x01;
        vm.expectRevert();
        verifier.verifyProof(vkey, pv, proof);
    }
}
