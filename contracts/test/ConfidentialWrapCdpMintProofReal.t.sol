// SPDX-License-Identifier: MIT
// Pinned to 0.8.20: the vendored SP1 base Groth16Verifier is fixed at solc 0.8.20 (same as the swap/lp/otc/bid
// and farm ProofReal units), so this verify-only unit mirrors ConfidentialPool.PublicValues locally rather than
// importing the ^0.8.28 pool.
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the fusion settle op OP_WRAP_CDP_MINT (op 30) ON-CHAIN, through the
/// genuine SP1VerifierGroth16 (v6.1.0) — no mock. The proof was GPU-proven on the box against the committed settle
/// ELF, the same vkey the pool deploys with. OP_WRAP_CDP_MINT consumes pending PUBLIC deposit(s) as the
/// collateral basket and mints a confidential CDP debt note (cUSD) in one settle (OP_CDP_MINT with
/// deposit-collateral). Closes the loop: router.wrapAndMintCusd → SP1 guest (zkVM) → Groth16 wrap → EVM bn254
/// verify, and the committed CdpMint is the one the pool's settle applies.
/// Fixture: contracts/test/fixtures/wrapcdpmint_groth16.json.
contract ConfidentialWrapCdpMintProofRealTest is Test {
    // Mirrors ConfidentialPool.PublicValues exactly (for decoding the committed wrap-cdp-mint settlement).
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

    function test_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("wrapcdpmint_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("wrapcdpmint_groth16.json");
        assertEq(vkey, _pinnedVkey(), "wrap-cdp-mint fixture vkey != pinned program_vkey");
    }

    function test_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("wrapcdpmint_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        // The fused shape: pending PUBLIC deposit(s) are consumed as the collateral basket, and exactly one
        // confidential CDP debt note (cUSD) is minted in one settle.
        assertGt(pv.depositsConsumed.length, 0, "depositsConsumed non-empty (the collateral basket)");
        assertEq(pv.cdpMints.length, 1, "exactly one CdpMint (the cUSD debt position)");
        assertGt(pv.cdpMints[0].debtValue, 0, "debtValue > 0 (the cUSD debt)");
        assertTrue(pv.cdpMints[0].positionLeaf != RECEIPT, "positionLeaf != RECEIPT (a real CDP position, not a bond)");
        assertGt(pv.cdpMints[0].legs.length, 0, "CdpMint has collateral legs");
        assertEq(pv.leaves.length, 1, "one leaf (the cUSD debt note)");
    }

    function test_tampered_proof_rejected() public {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("wrapcdpmint_groth16.json");
        proof[proof.length - 1] ^= 0x01;
        vm.expectRevert();
        verifier.verifyProof(vkey, pv, proof);
    }
}
