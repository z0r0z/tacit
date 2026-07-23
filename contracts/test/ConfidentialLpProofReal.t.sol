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
        assertEq(l.poolId, keccak256(abi.encode(ASSET_A, ASSET_B, uint32(30))), "poolId = keccak(assetA, assetB, feeBps)");
        assertEq(l.reserveAPre, 1000, "reserveAPre");
        assertEq(l.reserveBPre, 2000, "reserveBPre");
        assertEq(l.sharesPre, 1000, "sharesPre");
        assertEq(l.reserveAPost, 1100, "reserveAPost (100 A in)");
        assertEq(l.reserveBPost, 2200, "reserveBPost (200 B in)");
        assertEq(l.sharesPost, 1100, "sharesPost (+100 proportional shares)");
        assertEq(pv.nullifiers.length, 2, "two contribution nullifiers");
        assertEq(pv.leaves.length, 1, "one minted LP-share leaf");
    }

    // ── OP_LP_REMOVE — the other LP direction (burn a shielded share note for the proportional A/B) ──
    function _removeFixture() internal view returns (bytes32 v, bytes memory pv, bytes memory pf) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/lp_remove_groth16.json"));
        v = vm.parseJsonBytes32(json, ".vkey");
        pv = vm.parseJsonBytes(json, ".publicValues");
        pf = vm.parseJsonBytes(json, ".proofBytes");
    }

    function test_lp_remove_proof_verifies_onchain() public view {
        (bytes32 v, bytes memory pv, bytes memory pf) = _removeFixture();
        verifier.verifyProof(v, pv, pf);
    }

    function test_lp_remove_fixture_vkey_matches_pin() public view {
        (bytes32 v,,) = _removeFixture();
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        assertEq(v, vm.parseJsonBytes32(pin, ".program_vkey"), "lp_remove fixture vkey != pinned program_vkey");
    }

    /// The remove commits the proportional withdrawal: 100 of 1100 shares → 100 A + 200 B out,
    /// reserves 1100/2200 → 1000/2000, totalShares 1100 → 1000; one share nullifier, two A/B leaves.
    function test_lp_remove_settlement_decodes() public view {
        (, bytes memory pvb,) = _removeFixture();
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.liquidity.length, 1, "one LP settlement (the remove)");
        LpSettlement memory l = pv.liquidity[0];
        assertEq(l.reserveAPost, 1000, "reserveAPost (100 A out)");
        assertEq(l.reserveBPost, 2000, "reserveBPost (200 B out)");
        assertEq(l.sharesPost, 1000, "sharesPost (100 shares burned)");
        assertEq(pv.nullifiers.length, 1, "one nullifier (the LP-share note)");
        assertEq(pv.leaves.length, 2, "two leaves (the withdrawn A + B notes)");
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

    // ── OP_LP_ADD with a non-zero protocol fee (Uniswap fee-switch): the 6-arg pool the confidential LP
    //    FUNDS and OP_SWAP skims. Closes the LP-funding gap (LP previously derived the 3-arg id, swap the
    //    6-arg id → fee pools were unfundable). Self-skips until the box produces lp_protofee_groth16.json
    //    (queued in box-prove-remote.sh: `prove lp_protofee ... lp_protofee_op.json`). ──
    function _protofeeFixture() internal view returns (bool present, bytes32 v, bytes memory pv, bytes memory pf) {
        string memory fx = string.concat(vm.projectRoot(), "/test/fixtures/lp_protofee_groth16.json");
        if (!vm.exists(fx)) return (false, bytes32(0), "", "");
        string memory json = vm.readFile(fx);
        return (true, vm.parseJsonBytes32(json, ".vkey"), vm.parseJsonBytes(json, ".publicValues"), vm.parseJsonBytes(json, ".proofBytes"));
    }

    function test_lp_protofee_proof_verifies_onchain() public {
        (bool present, bytes32 v, bytes memory pv, bytes memory pf) = _protofeeFixture();
        if (!present) { vm.skip(true); return; }
        verifier.verifyProof(v, pv, pf);
    }

    /// The fee-switch LP settlement commits the 6-arg protocol-fee pool id — DISTINCT from the 3-arg no-skim
    /// id — proving the confidential LP funds the SAME slot OP_SWAP skims against.
    function test_lp_protofee_uses_the_6arg_pool_id() public {
        (bool present,, bytes memory pvb,) = _protofeeFixture();
        if (!present) { vm.skip(true); return; }
        PublicValues memory pv = abi.decode(pvb, (PublicValues));
        assertEq(pv.liquidity.length, 1, "one LP settlement");
        assertTrue(
            pv.liquidity[0].poolId != keccak256(abi.encode(ASSET_A, ASSET_B, uint32(30))),
            "protocol-fee LP funds the 6-arg id, not the 3-arg no-skim pool"
        );
    }

    function test_lp_protofee_fixture_vkey_matches_pin() public {
        (bool present, bytes32 v,,) = _protofeeFixture();
        if (!present) { vm.skip(true); return; }
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        assertEq(v, vm.parseJsonBytes32(pin, ".program_vkey"), "lp_protofee fixture vkey != pinned program_vkey");
    }
}
