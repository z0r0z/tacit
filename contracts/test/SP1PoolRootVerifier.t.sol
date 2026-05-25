// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/SP1PoolRootVerifier.sol";

contract MockSP1Verifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract MockRelay is IRelay {
    bytes32 public tip;
    function setTip(bytes32 t) external { tip = t; }
}

contract MockMixerForVerifier is IMixer {
    mapping(bytes32 => bytes32) public accumulators;

    function addRoot(bytes32 pid, bytes32 root) external {
        accumulators[pid] = sha256(abi.encodePacked(accumulators[pid], root));
    }

    function getRootAccumulator(bytes32 pid) external view returns (bytes32) {
        return accumulators[pid];
    }
}

contract SP1PoolRootVerifierTest is Test {
    MockSP1Verifier sp1;
    MockRelay relay;
    MockMixerForVerifier mixerMock;
    SP1PoolRootVerifier verifier;

    bytes32 constant VKEY = bytes32(uint256(0x1234));
    bytes32 constant AID = bytes32(uint256(0xAA));
    bytes32 constant GENESIS = bytes32(uint256(0xBBCC));
    bytes32 constant VK_HASH = bytes32(uint256(0xDD));
    uint8 constant NTAG = 0x01;
    uint256 constant DENOM = 1 ether;
    bytes32 denomB32 = bytes32(DENOM);
    bytes32 poolId;

    function setUp() public {
        sp1 = new MockSP1Verifier();
        relay = new MockRelay();
        mixerMock = new MockMixerForVerifier();
        poolId = keccak256(abi.encode(AID, DENOM));
        verifier = new SP1PoolRootVerifier(
            address(sp1), address(relay), VKEY, address(mixerMock),
            AID, NTAG, VK_HASH, poolId, denomB32,
            GENESIS
        );
    }

    function _buildPV(
        bytes32 lastBlockHash,
        bytes32 assetId,
        uint8 networkTag,
        uint64 chainId,
        address mixerAddr,
        bytes32 vkHash,
        bytes32 depositRootsAccumulator,
        bytes32 nullBatchHash,
        bytes32 denomination
    ) internal pure returns (bytes memory) {
        bytes memory pv = new bytes(461);
        _set32(pv, 72, GENESIS);
        _set32(pv, 176, depositRootsAccumulator);
        _set32(pv, 208, vkHash);
        _set32(pv, 240, nullBatchHash);
        _set32(pv, 272, assetId);
        pv[304] = bytes1(networkTag);
        _setU64(pv, 305, chainId);
        _setAddr(pv, 313, mixerAddr);
        _set32(pv, 333, lastBlockHash);
        _set32(pv, 365, denomination);
        // prev_state_commitment at 397 = 0 (genesis)
        // new_state_commitment at 429 = 0 (placeholder)
        return pv;
    }

    function _validPV(bytes32 lastBlockHash) internal view returns (bytes memory) {
        return _buildPV(
            lastBlockHash, AID, NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH, bytes32(0), bytes32(0), denomB32
        );
    }

    // ──── Domain check tests ────

    function test_wrong_denomination_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), AID, NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH, bytes32(0), bytes32(0),
            bytes32(uint256(0.1 ether))
        );
        vm.expectRevert(SP1PoolRootVerifier.DomainMismatch.selector);
        verifier.proveStateTransition(pv, "", new bytes32[](0));
    }

    function test_wrong_mixer_address_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), AID, NTAG, uint64(block.chainid),
            address(0xDEAD), VK_HASH, bytes32(0), bytes32(0), denomB32
        );
        vm.expectRevert(SP1PoolRootVerifier.DomainMismatch.selector);
        verifier.proveStateTransition(pv, "", new bytes32[](0));
    }

    function test_wrong_chain_id_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), AID, NTAG, 99999,
            address(mixerMock), VK_HASH, bytes32(0), bytes32(0), denomB32
        );
        vm.expectRevert(SP1PoolRootVerifier.DomainMismatch.selector);
        verifier.proveStateTransition(pv, "", new bytes32[](0));
    }

    function test_wrong_asset_id_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), bytes32(uint256(0xBAD)), NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH, bytes32(0), bytes32(0), denomB32
        );
        vm.expectRevert(SP1PoolRootVerifier.DomainMismatch.selector);
        verifier.proveStateTransition(pv, "", new bytes32[](0));
    }

    function test_wrong_vk_hash_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), AID, NTAG, uint64(block.chainid),
            address(mixerMock), bytes32(uint256(0xBAD)), bytes32(0), bytes32(0), denomB32
        );
        vm.expectRevert(SP1PoolRootVerifier.InvalidVkHash.selector);
        verifier.proveStateTransition(pv, "", new bytes32[](0));
    }

    function test_wrong_genesis_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _validPV(bytes32(uint256(0xFF)));
        _set32(pv, 72, bytes32(uint256(0xBAD))); // wrong prev_block_hash
        vm.expectRevert(SP1PoolRootVerifier.StateMismatch.selector);
        verifier.proveStateTransition(pv, "", new bytes32[](0));
    }

    function test_not_relay_tip_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _validPV(bytes32(uint256(0xEE))); // != tip
        vm.expectRevert(SP1PoolRootVerifier.NotRelayTip.selector);
        verifier.proveStateTransition(pv, "", new bytes32[](0));
    }

    // ──── Root accumulator tests ────

    function test_wrong_accumulator_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        mixerMock.addRoot(poolId, bytes32(uint256(0x111)));
        // PV commits a different accumulator than the mixer's.
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), AID, NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH, bytes32(uint256(0xBAD)), bytes32(0), denomB32
        );
        vm.expectRevert(SP1PoolRootVerifier.InvalidDepositRoot.selector);
        verifier.proveStateTransition(pv, "", new bytes32[](0));
    }

    function test_valid_submission_succeeds() public {
        bytes32 tipHash = bytes32(uint256(0xFF));
        relay.setTip(tipHash);
        bytes32 r1 = bytes32(uint256(0x111));
        mixerMock.addRoot(poolId, r1);
        // Compute the correct running accumulator matching the mixer.
        bytes32 acc = sha256(abi.encodePacked(bytes32(0), r1));
        bytes memory pv = _buildPV(
            tipHash, AID, NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH, acc, bytes32(0), denomB32
        );
        verifier.proveStateTransition(pv, "", new bytes32[](0));
        (bytes32 poolRoot,,,,) = verifier.currentState();
        assertEq(poolRoot, bytes32(0));
    }

    function test_wrong_burn_batch_hash_reverts() public {
        bytes32 tipHash = bytes32(uint256(0xFF));
        relay.setTip(tipHash);
        bytes32[] memory burns = new bytes32[](1);
        burns[0] = bytes32(uint256(0xB04D));
        bytes memory pv = _buildPV(
            tipHash, AID, NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH, bytes32(0), bytes32(uint256(0xBAD)), denomB32
        );
        vm.expectRevert(SP1PoolRootVerifier.InvalidProof.selector);
        verifier.proveStateTransition(pv, "", burns);
    }

    function test_incremental_state_chaining() public {
        bytes32 tipHash = bytes32(uint256(0xFF));
        relay.setTip(tipHash);
        // First proof: genesis → state A
        bytes memory pv1 = _validPV(tipHash);
        bytes32 newPoolRoot = bytes32(uint256(0xAAA));
        bytes32 newNullHash = bytes32(uint256(0xBBB));
        bytes32 newCommitment = bytes32(uint256(0xCCC));
        _set32(pv1, 104, newPoolRoot);
        _set32(pv1, 136, newNullHash);
        _setU64(pv1, 168, 5); // newHeight = 5
        _set32(pv1, 429, newCommitment); // newStateCommitment
        verifier.proveStateTransition(pv1, "", new bytes32[](0));
        (bytes32 storedRoot, bytes32 storedNull,, uint64 storedHeight,) = verifier.currentState();
        assertEq(storedRoot, newPoolRoot);
        assertEq(storedNull, newNullHash);
        assertEq(storedHeight, 5);

        // Second proof: must chain from state A
        bytes32 tipHash2 = bytes32(uint256(0xEE));
        relay.setTip(tipHash2);
        bytes memory pv2 = new bytes(461);
        _set32(pv2, 0, newPoolRoot);      // prevPoolRoot
        _set32(pv2, 32, newNullHash);     // prevNullHash
        _setU64(pv2, 64, 5);             // prevHeight
        _set32(pv2, 72, tipHash);         // prevBlockHash = last proof's lastBlockHash
        _set32(pv2, 104, bytes32(uint256(0xDDD))); // new pool root
        _set32(pv2, 136, bytes32(uint256(0xEEE))); // new null hash
        _setU64(pv2, 168, 8);            // newHeight
        _set32(pv2, 272, AID);
        pv2[304] = bytes1(NTAG);
        _setU64(pv2, 305, uint64(block.chainid));
        _setAddr(pv2, 313, address(mixerMock));
        _set32(pv2, 333, tipHash2);       // lastBlockHash = new tip
        _set32(pv2, 365, denomB32);
        _set32(pv2, 397, newCommitment);  // prevStateCommitment must match stored
        _set32(pv2, 208, VK_HASH);
        verifier.proveStateTransition(pv2, "", new bytes32[](0));
        (storedRoot,,, storedHeight,) = verifier.currentState();
        assertEq(storedRoot, bytes32(uint256(0xDDD)));
        assertEq(storedHeight, 8);
    }

    function test_incremental_wrong_prev_root_reverts() public {
        bytes32 tipHash = bytes32(uint256(0xFF));
        relay.setTip(tipHash);
        // First proof
        bytes memory pv1 = _validPV(tipHash);
        _set32(pv1, 104, bytes32(uint256(0xAAA)));
        _set32(pv1, 429, bytes32(uint256(0xCCC)));
        verifier.proveStateTransition(pv1, "", new bytes32[](0));
        // Second proof with wrong prevPoolRoot — domain fields must be correct to reach state check
        bytes32 tipHash2 = bytes32(uint256(0xEE));
        relay.setTip(tipHash2);
        bytes memory pv2 = new bytes(461);
        _set32(pv2, 0, bytes32(uint256(0xDEAD))); // wrong prevPoolRoot
        _set32(pv2, 272, AID);
        pv2[304] = bytes1(NTAG);
        _setU64(pv2, 305, uint64(block.chainid));
        _setAddr(pv2, 313, address(mixerMock));
        _set32(pv2, 333, tipHash2);
        _set32(pv2, 365, denomB32);
        _set32(pv2, 208, VK_HASH);
        vm.expectRevert(SP1PoolRootVerifier.StateMismatch.selector);
        verifier.proveStateTransition(pv2, "", new bytes32[](0));
    }

    function test_zero_genesis_constructor_reverts() public {
        vm.expectRevert(SP1PoolRootVerifier.ZeroGenesis.selector);
        new SP1PoolRootVerifier(
            address(sp1), address(relay), VKEY, address(mixerMock),
            AID, NTAG, VK_HASH, poolId, denomB32,
            bytes32(0)
        );
    }

    // ──── Helpers ────

    function _set32(bytes memory b, uint256 offset, bytes32 val) internal pure {
        assembly { mstore(add(add(b, 32), offset), val) }
    }

    function _setU64(bytes memory b, uint256 offset, uint64 val) internal pure {
        for (uint256 i; i < 8; ++i) {
            b[offset + i] = bytes1(uint8(val >> (56 - i * 8)));
        }
    }

    function _setAddr(bytes memory b, uint256 offset, address addr) internal pure {
        bytes20 a = bytes20(addr);
        for (uint256 i; i < 20; ++i) {
            b[offset + i] = a[i];
        }
    }
}
