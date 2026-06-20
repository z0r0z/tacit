// SPDX-License-Identifier: MIT
// Pinned to 0.8.20: the vendored SP1 base Groth16Verifier is fixed at solc 0.8.20 (same as the swap/lp/otc/bid
// ProofReal units), so this verify-only unit mirrors ConfidentialPool.PublicValues locally rather than importing
// the ^0.8.28 pool.
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies REAL SP1 Groth16 proofs of the fair-farm settle ops OP_FARM_BOND/HARVEST/UNBOND ON-CHAIN, through
/// the genuine SP1VerifierGroth16 (v6.1.0) — no mock. The proofs were GPU-proven on the box
/// (contracts/sp1/confidential/exec-farm.rs) against the committed settle ELF, the same vkey the pool deploys
/// with. Closes the loop for the farm: confidential-farm.js builder → SP1 guest (zkVM) → Groth16 wrap → EVM
/// bn254 verify, and the committed CdpMint/CdpClose is the one the pool's settle applies. Fixtures:
/// contracts/test/fixtures/farm_{bond,harvest,unbond}_groth16.json.
contract ConfidentialFarmProofRealTest is Test {
    // Mirrors ConfidentialPool.PublicValues exactly (for decoding the committed farm settlement).
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

    bytes32 constant RECEIPT = bytes32(uint256(1));
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

    // ── BOND ──
    function test_bond_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("farm_bond_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_bond_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("farm_bond_groth16.json");
        assertEq(vkey, _pinnedVkey(), "bond fixture vkey != pinned program_vkey");
    }

    function test_bond_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("farm_bond_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.cdpMints.length, 1, "one CdpMint (the bond)");
        assertEq(pv.cdpMints[0].positionLeaf, RECEIPT, "positionLeaf == 1 (receipt sentinel)");
        assertEq(pv.cdpMints[0].debtValue, 0, "debtValue == 0 (BOND)");
        assertEq(pv.leaves.length, 1, "one leaf (the receipt note)");
        assertEq(pv.nullifiers.length, 1, "one nullifier (the bonded LP-share leg)");
    }

    // ── HARVEST ──
    function test_harvest_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("farm_harvest_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_harvest_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("farm_harvest_groth16.json");
        assertEq(vkey, _pinnedVkey(), "harvest fixture vkey != pinned program_vkey");
    }

    function test_harvest_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("farm_harvest_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.cdpMints.length, 1, "one CdpMint (the harvest)");
        assertEq(pv.cdpMints[0].positionLeaf, RECEIPT, "positionLeaf == 1 (receipt sentinel)");
        assertGt(pv.cdpMints[0].debtValue, 0, "debtValue > 0 (HARVEST reward)");
        assertEq(pv.leaves.length, 2, "two leaves (advanced receipt + reward note)");
        assertEq(pv.nullifiers.length, 1, "one nullifier (the old receipt)");
    }

    // ── UNBOND ──
    function test_unbond_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("farm_unbond_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_unbond_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("farm_unbond_groth16.json");
        assertEq(vkey, _pinnedVkey(), "unbond fixture vkey != pinned program_vkey");
    }

    function test_unbond_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("farm_unbond_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.cdpCloses.length, 1, "one CdpClose (the unbond)");
        assertEq(pv.cdpMints.length, 0, "no CdpMint on unbond");
        assertEq(pv.leaves.length, 1, "one leaf (the re-minted LP-share note)");
        assertEq(pv.nullifiers.length, 1, "one nullifier (the receipt)");
    }

    // ── tamper ──
    function test_tampered_proof_rejected() public {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("farm_bond_groth16.json");
        proof[proof.length - 1] ^= 0x01;
        vm.expectRevert();
        verifier.verifyProof(vkey, pv, proof);
    }
}
