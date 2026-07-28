// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthCallOutbox} from "../src/EthCallOutbox.sol";

contract EthCallOutboxTest is Test {
    // Mirror of the eth-reflection guest constants. KEEP IN SYNC with the outbox slot indices there.
    uint256 constant MSG_COUNT_SLOT_INDEX = 0;
    uint256 constant MSG_AT_SLOT_INDEX = 1;
    uint256 constant MSG_RECORD_SLOT_INDEX = 2;

    bytes32 constant NS_ATTEST = keccak256("tacit-ns-attest-v1");
    uint16 constant DEST_BITCOIN = 1;

    EthCallOutbox outbox;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.chainId(1);
        outbox = new EthCallOutbox();
    }

    function _mappingSlot(bytes32 key, uint256 slotIndex) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, slotIndex));
    }

    // --- storage layout is consensus: the guest proves these slots by index ---

    function test_msgCount_at_slot_0() public {
        vm.store(address(outbox), bytes32(MSG_COUNT_SLOT_INDEX), bytes32(uint256(42)));
        assertEq(outbox.msgCount(), 42, "msgCount moved off slot 0");
    }

    function test_msgAt_at_slot_1() public {
        bytes32 sentinel = bytes32(uint256(0xC0FFEE));
        vm.store(address(outbox), _mappingSlot(bytes32(uint256(7)), MSG_AT_SLOT_INDEX), sentinel);
        assertEq(outbox.msgAt(7), sentinel, "msgAt moved off slot 1");
    }

    function test_msgRecord_at_slot_2() public {
        bytes32 key = bytes32(uint256(0x1234));
        bytes32 sentinel = bytes32(uint256(0xBEEF));
        vm.store(address(outbox), _mappingSlot(key, MSG_RECORD_SLOT_INDEX), sentinel);
        assertEq(outbox.msgRecord(key), sentinel, "msgRecord moved off slot 2");
    }

    // --- recording ---

    function test_send_records_id_record_and_advances_cursor() public {
        bytes memory payload = hex"deadbeef";
        vm.prank(alice);
        bytes32 msgId = outbox.send(DEST_BITCOIN, NS_ATTEST, payload);

        bytes32 expectedRecord = outbox.recordHashOf(DEST_BITCOIN, NS_ATTEST, alice, keccak256(payload));
        bytes32 expectedId = keccak256(abi.encodePacked(address(outbox), block.chainid, expectedRecord, uint64(0)));

        assertEq(msgId, expectedId, "msgId derivation");
        assertEq(outbox.msgRecord(msgId), expectedRecord, "record not committed");
        assertEq(outbox.msgAt(0), msgId, "not enumerable at its index");
        assertEq(outbox.msgCount(), 1, "cursor did not advance");
    }

    /// Repeat identical messages must not collide: `index` is inside the id, so each is one-shot on its own.
    function test_identical_messages_get_distinct_ids() public {
        bytes memory payload = hex"01";
        vm.startPrank(alice);
        bytes32 first = outbox.send(DEST_BITCOIN, NS_ATTEST, payload);
        bytes32 second = outbox.send(DEST_BITCOIN, NS_ATTEST, payload);
        vm.stopPrank();

        assertTrue(first != second, "identical messages collided");
        assertEq(outbox.msgRecord(first), outbox.msgRecord(second), "same message, same record");
        assertEq(outbox.msgAt(0), first);
        assertEq(outbox.msgAt(1), second);
        assertEq(outbox.msgCount(), 2);
    }

    // --- what the record binds: nothing a relayer supplies may be swapped ---

    function test_record_binds_sender() public {
        bytes memory payload = hex"aa";
        vm.prank(alice);
        bytes32 a = outbox.msgRecord(outbox.send(DEST_BITCOIN, NS_ATTEST, payload));
        vm.prank(bob);
        bytes32 b = outbox.msgRecord(outbox.send(DEST_BITCOIN, NS_ATTEST, payload));
        assertTrue(a != b, "sender not bound: a handler could be spoofed");
    }

    function test_record_binds_namespace_destchain_and_payload() public view {
        bytes32 base = outbox.recordHashOf(DEST_BITCOIN, NS_ATTEST, alice, keccak256(hex"aa"));
        assertTrue(base != outbox.recordHashOf(DEST_BITCOIN, keccak256("other-ns"), alice, keccak256(hex"aa")), "ns not bound");
        assertTrue(base != outbox.recordHashOf(2, NS_ATTEST, alice, keccak256(hex"aa")), "destChain not bound");
        assertTrue(base != outbox.recordHashOf(DEST_BITCOIN, NS_ATTEST, alice, keccak256(hex"ab")), "payload not bound");
    }

    /// The id binds the deployment: the same message from an outbox at another address is a different id.
    function test_id_binds_this_deployment() public {
        bytes memory payload = hex"aa";
        vm.prank(alice);
        bytes32 here = outbox.send(DEST_BITCOIN, NS_ATTEST, payload);

        EthCallOutbox other = new EthCallOutbox();
        vm.prank(alice);
        bytes32 there = other.send(DEST_BITCOIN, NS_ATTEST, payload);

        assertTrue(here != there, "id not bound to the outbox address");
    }

    function test_id_binds_chain() public {
        bytes memory payload = hex"aa";
        vm.prank(alice);
        bytes32 onMainnet = outbox.send(DEST_BITCOIN, NS_ATTEST, payload);

        vm.chainId(11155111);
        EthCallOutbox sepolia = new EthCallOutbox();
        vm.prank(alice);
        bytes32 onSepolia = sepolia.send(DEST_BITCOIN, NS_ATTEST, payload);
        // Addresses differ too, so this asserts the pair; chainid is pinned by the derivation test above.
        assertTrue(onMainnet != onSepolia, "id not bound to the chain");
    }

    /// CROSS-LANGUAGE KAT. The same vector is asserted in cxfer-core
    /// (`eth_reflection::tests::message_record_matches_solidity_recordhashof`). The contract is the
    /// BINDING side — it refuses payloads the guest could not fold — so if these two ever disagree, a
    /// message accepted here would be unfoldable on Bitcoin. Change both or neither.
    function test_recordHash_kat() public view {
        bytes32 ns = keccak256("tacit-ns-attest-v1");
        bytes32 payloadHash = keccak256("hello");
        address sender = address(0xA11c);
        assertEq(
            outbox.recordHashOf(DEST_BITCOIN, ns, sender, payloadHash),
            0x0d6a81b8062c850eabea90ec9a223a5e2aba6f7e8ddaf5d46c102e63507241be,
            "recordHash drifted from the cxfer-core vector"
        );
    }

    // --- guards ---

    function test_rejects_zero_destchain() public {
        vm.expectRevert(EthCallOutbox.BadDestChain.selector);
        outbox.send(0, NS_ATTEST, hex"aa");
    }

    function test_payload_cap_is_1024() public {
        assertEq(outbox.MAX_PAYLOAD(), 1024, "cap must match the in-guest assert");
        outbox.send(DEST_BITCOIN, NS_ATTEST, new bytes(1024));
        vm.expectRevert(EthCallOutbox.PayloadTooLarge.selector);
        outbox.send(DEST_BITCOIN, NS_ATTEST, new bytes(1025));
    }

    function test_empty_payload_is_allowed() public {
        vm.prank(alice);
        bytes32 msgId = outbox.send(DEST_BITCOIN, NS_ATTEST, "");
        assertEq(outbox.msgRecord(msgId), outbox.recordHashOf(DEST_BITCOIN, NS_ATTEST, alice, keccak256("")));
    }

    /// An unknown namespace is an unhandled attestation, not an error — no registry, no coordination.
    function test_unknown_namespace_is_accepted() public {
        bytes32 msgId = outbox.send(DEST_BITCOIN, keccak256("nobody-handles-this"), hex"aa");
        assertTrue(outbox.msgRecord(msgId) != bytes32(0), "unknown ns should still record");
    }

    /// Value is never authorized: there is no payable path, so the outbox cannot custody or forward funds.
    function test_cannot_receive_value() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(outbox).call{value: 1 wei}("");
        assertFalse(ok, "outbox must not accept value");
        assertEq(address(outbox).balance, 0);
    }

    function testFuzz_record_and_id_are_deterministic(uint16 destChain, bytes32 ns, bytes calldata payload) public {
        vm.assume(destChain != 0);
        vm.assume(payload.length <= 1024);
        uint64 index = outbox.msgCount();
        vm.prank(alice);
        bytes32 msgId = outbox.send(destChain, ns, payload);
        bytes32 record = outbox.recordHashOf(destChain, ns, alice, keccak256(payload));
        assertEq(outbox.msgRecord(msgId), record);
        assertEq(msgId, keccak256(abi.encodePacked(address(outbox), block.chainid, record, index)));
    }
}
