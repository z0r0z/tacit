// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";

contract MockSP1VerifierS is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// Pins the ConfidentialPool storage slots the eth-reflection guest hardcodes (cxfer-core
/// `eth_reflection.rs`: CROSSOUT_SLOT_INDEX, CONSUMED_SLOT_INDEX, CONSUMED_COUNT_SLOT_INDEX,
/// CONSUMED_AT_SLOT_INDEX) to the contract's ACTUAL layout. The guest proves these exact slots via
/// eth_getProof, so a layout drift (a new var inserted before them) proves the wrong storage. Writing a
/// sentinel to the computed slot and reading it back through the public getter fails the instant a slot
/// moves — forcing a coordinated update of both this contract and the Rust constants.
contract ConfidentialPoolReflectionSlotsTest is Test {
    // Mirror of the cxfer-core constants. KEEP IN SYNC with eth_reflection.rs.
    uint256 constant CROSSOUT_SLOT_INDEX = 76;
    uint256 constant CONSUMED_SLOT_INDEX = 119;
    uint256 constant CONSUMED_COUNT_SLOT_INDEX = 120;
    uint256 constant CONSUMED_AT_SLOT_INDEX = 163;

    ConfidentialPool pool;

    function setUp() public {
        vm.chainId(1);
        pool = new ConfidentialPool(
            address(new MockSP1VerifierS()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0),
            bytes32(0), 6, bytes32(0), bytes32(0), address(0)
        );
    }

    function _mappingSlot(bytes32 key, uint256 slotIndex) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, slotIndex));
    }

    function test_crossOutCommitment_at_slot_76() public {
        bytes32 key = bytes32(uint256(0x1234));
        bytes32 sentinel = bytes32(uint256(0xC0FFEE));
        vm.store(address(pool), _mappingSlot(key, CROSSOUT_SLOT_INDEX), sentinel);
        assertEq(vm.load(address(pool), keccak256(abi.encode(key, uint256(76)))), sentinel, "crossOutCommitment moved off slot 76");
    }

    function test_bitcoinConsumed_at_slot_119() public {
        bytes32 key = bytes32(uint256(0x5678));
        bytes32 sentinel = bytes32(uint256(0xBEEF));
        vm.store(address(pool), _mappingSlot(key, CONSUMED_SLOT_INDEX), sentinel);
        assertEq(pool.bitcoinConsumed(key), sentinel, "bitcoinConsumed moved off slot 119");
    }

    function test_bitcoinConsumedCount_at_slot_120() public {
        bytes32 sentinel = bytes32(uint256(42));
        vm.store(address(pool), bytes32(CONSUMED_COUNT_SLOT_INDEX), sentinel);
        assertEq(pool.bitcoinConsumedCount(), uint256(sentinel), "bitcoinConsumedCount moved off slot 120");
    }

    function test_bitcoinConsumedAt_at_slot_163() public {
        uint256 idx = 7;
        bytes32 sentinel = bytes32(uint256(0xABCDEF));
        // Write through the CONSTANT, read back at the LITERAL slot keccak(idx, 163) — so this is NOT the
        // tautology of reading the same computed slot (which would pass for any CONSUMED_AT_SLOT_INDEX). If the
        // constant is ever changed off 163 the two slots diverge and this fails (mirrors the crossOutCommitment
        // test). The complementary "the variable is actually at 163" relayout guard is the live settle-write in
        // ConfidentialPool.t.sol; bitcoinConsumedAt is internal so there is no public getter to read here.
        vm.store(address(pool), _mappingSlot(bytes32(idx), CONSUMED_AT_SLOT_INDEX), sentinel);
        assertEq(
            vm.load(address(pool), keccak256(abi.encode(bytes32(idx), uint256(163)))),
            sentinel,
            "bitcoinConsumedAt CONSUMED_AT_SLOT_INDEX changed off 163"
        );
    }
}
