// SPDX-License-Identifier: MIT
// Pinned to 0.8.20 to match the vendored SP1 base Groth16Verifier (same as ConfidentialReflectionProofReal).
pragma solidity 0.8.20;

import {Test} from "forge-std/Test.sol";
import {SP1Verifier} from "./vendor/sp1/v6.1.0/SP1VerifierGroth16.sol";

/// Verifies a REAL SP1 Groth16 proof of the reflection guest folding a TAC BURN-DEPOSIT (scan-free
/// onboarding: a 0x2B burn of a pre-existing, never-reflected note proven real via per-bridge provenance
/// to the etch supply note C_0) ON-CHAIN, through the genuine SP1VerifierGroth16 — the on-chain ground
/// truth that the burn-deposit dispatch (reflect.rs ~208) is sound, not just native-exec/JS-mirror validated.
///
/// TURNKEY / GATED: the fixture (test/fixtures/reflection_burn_deposit_groth16.json) is produced by the
/// Sepolia E2 coordinated re-prove. If the fixture is absent in a partial checkout these tests self-skip;
/// in the canonical tree it verifies for real at the pinned BITCOIN_RELAY_VKEY.
///
/// Box command to generate the fixture (on the prover host, after the re-prove builds the guest):
///   REFLECT_INPUT=/root/work/cxfer/fixtures/reflection_burn_deposit.json REFLECT_OUT_TAG=burndep \
///   ELF_VKEY_PIN=.../elf-vkey-pin.json cargo run --release --bin exec-reflect-prove
///   → burndep_public_values.hex + burndep_proof_bytes.hex → assemble into the json {vkey, publicValues, proofBytes}.
/// The input fixture is built by tests/gen-reflection-burn-deposit.mjs (a fixed-supply C_0 → conserving
/// CXFER → 0x2B burn, easy-PoW so the guest accepts it).
contract ConfidentialReflectionBurnDepositProofRealTest is Test {
    struct CbtcLockFolded { bytes32 outpoint; uint256 vBtc; bytes32 commitment; }
    struct BitcoinRelayPublicValues {
        bytes32 priorDigest;
        bytes32 bitcoinPoolRoot;
        bytes32 bitcoinSpentRoot;
        bytes32 bitcoinBurnRoot;
        uint64 bitcoinHeight;
        bytes32 newDigest;
        bytes32 bitcoinPrevHash;
        bytes32 bitcoinTipHash;
        bytes32 ethPoolReflected;
        uint256 cbtcBackingSats;
        CbtcLockFolded[] cbtcLocksFolded;
        bytes32[] cbtcLocksSpent;
        uint64 consumedCount;
    }

    SP1Verifier verifier;
    bool fixturePresent;
    bytes32 vkey;
    bytes publicValues;
    bytes proofBytes;
    // Prior roots from the assembled input — the burn-deposit must ADVANCE all three (onboard note,
    // nullify ν, record ν → dest), so the proven roots must differ from these.
    bytes32 priorPoolRoot;
    bytes32 priorSpentRoot;
    bytes32 priorBurnRoot;
    uint64 expectedHeight;

    function setUp() public {
        verifier = new SP1Verifier();
        string memory fx = string.concat(vm.projectRoot(), "/test/fixtures/reflection_burn_deposit_groth16.json");
        if (!vm.exists(fx)) return; // fixture not yet generated (pending the re-prove) → tests self-skip
        fixturePresent = true;
        string memory json = vm.readFile(fx);
        vkey = vm.parseJsonBytes32(json, ".vkey");
        publicValues = vm.parseJsonBytes(json, ".publicValues");
        proofBytes = vm.parseJsonBytes(json, ".proofBytes");

        string memory inp = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/fixtures/reflection_burn_deposit.json"));
        priorPoolRoot = vm.parseJsonBytes32(inp, ".prior.poolRoot");
        priorSpentRoot = vm.parseJsonBytes32(inp, ".prior.spentRoot");
        priorBurnRoot = vm.parseJsonBytes32(inp, ".prior.burnRoot");
        expectedHeight = uint64(vm.parseJsonUint(inp, ".anchorHeight")); // single scan block → height == anchorHeight
    }

    modifier gated() {
        if (!fixturePresent) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// The real burn-deposit reflection proof verifies on-chain against BITCOIN_RELAY_VKEY (reverts on failure).
    function test_burn_deposit_proof_verifies_onchain() public gated {
        verifier.verifyProof(vkey, publicValues, proofBytes);
    }

    /// Coherence: the fixture's vkey IS the committed pin — this is a proof of the SAME reflection guest a
    /// deployer sets BITCOIN_RELAY_VKEY to (after the re-prove rotates it), not a drifted one.
    function test_fixture_vkey_matches_pin() public gated {
        string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/confidential/elf-vkey-pin.json"));
        assertEq(vkey, vm.parseJsonBytes32(pin, ".bitcoin_relay_vkey"), "fixture vkey != pinned bitcoin_relay_vkey");
    }

    /// The burn-deposit ACTUALLY folded: decode the dynamic BitcoinReflectionPublicValues and assert the
    /// onboarding effects — the burned note is appended to the pool tree (poolRoot advances), its ν is
    /// nullified (spentRoot advances), and ν → destCommitment is recorded in the bridge-burn set (burnRoot
    /// advances + non-zero). bitcoinBurnRoot is what OP_BRIDGE_MINT proves membership against on Ethereum,
    /// so this is the surface that authorizes the v_mint == v_burn mint.
    function test_burn_deposit_public_values_reflect_the_fold() public gated {
        BitcoinRelayPublicValues memory pv = abi.decode(publicValues, (BitcoinRelayPublicValues));
        assertEq(pv.bitcoinHeight, expectedHeight, "the burn-deposit scan block height");
        assertEq(pv.newDigest, 0xb276adf40cb9bfa1c08b11250dcd81afcfb30be3b19bf6e89c9f7968376af190, "burn-deposit newDigest");
        assertTrue(pv.priorDigest != bytes32(0) && pv.newDigest != bytes32(0) && pv.newDigest != pv.priorDigest, "digest advanced");
        // The three burn-deposit effects (vs the assembled input's prior roots):
        assertTrue(pv.bitcoinBurnRoot != bytes32(0) && pv.bitcoinBurnRoot != priorBurnRoot, "burnRoot advanced: nu -> dest recorded (mint authority)");
        assertTrue(pv.bitcoinPoolRoot != priorPoolRoot, "poolRoot advanced: the burned note onboarded as a pool member");
        assertTrue(pv.bitcoinSpentRoot != priorSpentRoot, "spentRoot advanced: the burned note's nu nullified (no double-bridge)");
        assertTrue(pv.bitcoinTipHash != bytes32(0), "committed Bitcoin tip (relay anchor)");
        pv.bitcoinPrevHash; // bound in the proof; the contract checks it against the prior attested tip
        assertEq(pv.ethPoolReflected, bytes32(0), "forward fixture has no Mode-B eth pool");
        assertEq(pv.cbtcBackingSats, 0, "no cBTC lock in this burn-deposit fixture");
        assertEq(pv.cbtcLocksFolded.length, 0, "no cBTC locks folded");
        assertEq(pv.cbtcLocksSpent.length, 0, "no cBTC locks spent");
        assertEq(pv.consumedCount, 0, "no fast-lane consumes folded");
    }

    /// The proof's selector matches this verifier version.
    function test_proof_selector_matches_verifier() public gated {
        bytes memory p = proofBytes;
        bytes4 sel;
        assembly {
            sel := mload(add(p, 0x20))
        }
        assertEq(sel, bytes4(verifier.VERIFIER_HASH()), "selector matches the vendored verifier");
    }

    /// A flipped byte in the proof body fails the bn254 pairing check.
    function test_tampered_proof_rejected() public gated {
        bytes memory bad = proofBytes;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, publicValues, bad);
    }

    /// A different vkey is rejected (the proof is bound to the reflection guest).
    function test_wrong_vkey_rejected() public gated {
        vm.expectRevert();
        verifier.verifyProof(bytes32(uint256(vkey) ^ 1), publicValues, proofBytes);
    }

    /// Tampered public values are rejected (the proof commits to these exact roots/digest).
    function test_tampered_public_values_rejected() public gated {
        bytes memory bad = publicValues;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifier.verifyProof(vkey, bad, proofBytes);
    }
}
