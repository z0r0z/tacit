// SPDX-License-Identifier: MIT
// Pinned to 0.8.20 (the vendored SP1 Groth16Verifier), like the other ProofReal units.
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the multi-hop AMM route (OP_SWAP_ROUTE) ON-CHAIN, through the genuine
/// SP1VerifierGroth16 (v6.1.0) — no mock. GPU-proven on the box (exec-gap.rs, op 11) against the committed settle
/// ELF; the witness (input note membership + per-hop reserve walk + the output opening-sigma) is the same one the
/// reflect-exec route-execute emulator validates. Single-swap is ConfidentialSwapProofReal; this covers the
/// chained N-hop path (one input note → two pool legs → one output note). Fixture:
/// contracts/test/fixtures/swap_route_groth16.json.
contract ConfidentialRouteProofRealTest is Test {
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

    function test_route_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("swap_route_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_route_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("swap_route_groth16.json");
        assertEq(vkey, _pinnedVkey(), "route fixture vkey != pinned program_vkey");
    }

    function test_route_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("swap_route_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.swaps.length, 2, "two swap settlements (the two hops)");
        assertEq(pv.leaves.length, 1, "one leaf (the output note)");
        assertEq(pv.nullifiers.length, 1, "one nullifier (the input note)");
        assertTrue(pv.swaps[0].poolId != bytes32(0) && pv.swaps[1].poolId != bytes32(0), "both hops settle a real pool");
    }

    function test_tampered_proof_rejected() public {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("swap_route_groth16.json");
        proof[proof.length - 1] ^= 0x01;
        vm.expectRevert();
        verifier.verifyProof(vkey, pv, proof);
    }
}
