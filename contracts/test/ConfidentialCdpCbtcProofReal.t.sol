// SPDX-License-Identifier: MIT
// Pinned to 0.8.20 (the vendored SP1 Groth16Verifier), like the swap/lp/otc/bid/farm ProofReal units.
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies REAL SP1 Groth16 proofs of the full CDP family (OP_CDP_MINT/CLOSE/LIQUIDATE/TOPUP — the cUSD vault
/// path) and cBTC (OP_CBTC_MINT) settle ops ON-CHAIN, through the genuine SP1VerifierGroth16 (v6.1.0) — no mock.
/// GPU-proven on the box (contracts/sp1/confidential/exec-gap.rs) against the committed settle ELF, the vkey the
/// pool deploys with. Brings CDP/cUSD + cBTC to the same on-chain-proof bar as swap/lp/otc/bid/farm; the
/// contract-side gates (controller policy, cBTC lock/escrow) are covered by ConfidentialCdpCbtcSettle. Fixtures:
/// contracts/test/fixtures/{cdp_mint,cdp_close,cdp_liquidate,cdp_topup,cbtc_mint}_groth16.json.
contract ConfidentialCdpCbtcProofRealTest is Test {
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

    // ── CDP MINT (cUSD vault open) ──
    function test_cdp_mint_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("cdp_mint_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_cdp_mint_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("cdp_mint_groth16.json");
        assertEq(vkey, _pinnedVkey(), "cdp_mint fixture vkey != pinned program_vkey");
    }

    function test_cdp_mint_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("cdp_mint_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.cdpMints.length, 1, "one CdpMint (vault open)");
        assertGt(uint256(pv.cdpMints[0].positionLeaf), 1, "a REAL position leaf (not a farm sentinel)");
        assertGt(pv.cdpMints[0].debtValue, 0, "debtValue > 0 (cUSD minted)");
        assertEq(pv.leaves.length, 1, "one leaf (the debt note)");
        assertEq(pv.nullifiers.length, 1, "one nullifier (the collateral leg)");
    }

    // ── CDP CLOSE (cUSD vault close) ──
    function test_cdp_close_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("cdp_close_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_cdp_close_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("cdp_close_groth16.json");
        assertEq(vkey, _pinnedVkey(), "cdp_close fixture vkey != pinned program_vkey");
    }

    function test_cdp_close_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("cdp_close_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.cdpCloses.length, 1, "one CdpClose (vault close)");
        assertEq(pv.cdpMints.length, 0, "no CdpMint on close");
        assertEq(pv.leaves.length, 1, "one leaf (re-minted collateral)");
        assertEq(pv.nullifiers.length, 1, "one nullifier (the debt note burned)");
    }

    // ── cBTC MINT ──
    function test_cbtc_mint_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("cbtc_mint_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_cbtc_mint_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("cbtc_mint_groth16.json");
        assertEq(vkey, _pinnedVkey(), "cbtc_mint fixture vkey != pinned program_vkey");
    }

    function test_cbtc_mint_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("cbtc_mint_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.cbtcMints.length, 1, "one CbtcMint");
        assertGt(pv.cbtcMints[0].vBtc, 0, "vBtc > 0");
        assertEq(pv.leaves.length, 1, "one leaf (the cBTC note)");
    }

    // ── CDP LIQUIDATE (the seize path) ──
    function test_cdp_liquidate_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("cdp_liquidate_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_cdp_liquidate_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("cdp_liquidate_groth16.json");
        assertEq(vkey, _pinnedVkey(), "cdp_liquidate fixture vkey != pinned program_vkey");
    }

    function test_cdp_liquidate_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("cdp_liquidate_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.cdpLiquidations.length, 1, "one CdpLiquidate");
        assertEq(pv.withdrawals.length, 1, "the seized basket paid out as a withdrawal");
        assertEq(pv.nullifiers.length, 1, "one nullifier (the debt note burned)");
    }

    // ── CDP TOPUP (add collateral) ──
    function test_cdp_topup_proof_verifies_onchain() public view {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("cdp_topup_groth16.json");
        verifier.verifyProof(vkey, pv, proof);
    }

    function test_cdp_topup_fixture_vkey_matches_pin() public view {
        (bytes32 vkey,,) = _load("cdp_topup_groth16.json");
        assertEq(vkey, _pinnedVkey(), "cdp_topup fixture vkey != pinned program_vkey");
    }

    function test_cdp_topup_settlement_decodes() public view {
        (, bytes memory pvb,) = _load("cdp_topup_groth16.json");
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.cdpTopups.length, 1, "one CdpTopup");
        assertGt(uint256(pv.cdpTopups[0].newPositionLeaf), 1, "a REAL new position leaf");
        assertEq(pv.nullifiers.length, 1, "one nullifier (the old position)");
    }

    function test_tampered_proof_rejected() public {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _load("cdp_mint_groth16.json");
        proof[proof.length - 1] ^= 0x01;
        vm.expectRevert();
        verifier.verifyProof(vkey, pv, proof);
    }
}
