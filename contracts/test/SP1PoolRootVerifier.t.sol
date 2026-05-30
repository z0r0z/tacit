// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/SP1PoolRootVerifier.sol";

contract MockSP1Verifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract MockRelay is IRelay {
    bytes32 public tip;
    mapping(bytes32 => bytes32) public _parent;
    function setTip(bytes32 t) external { tip = t; }
    function setParent(bytes32 child, bytes32 parent) external { _parent[child] = parent; }
    function blockParent(bytes32 b) external view returns (bytes32) { return _parent[b]; }
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
    bytes32 denomsHash;
    bytes32 emptyBurnsHash;

    function setUp() public {
        sp1 = new MockSP1Verifier();
        relay = new MockRelay();
        mixerMock = new MockMixerForVerifier();
        poolId = keccak256(abi.encode(AID, DENOM));
        bytes32[] memory pids = new bytes32[](1);
        pids[0] = poolId;
        bytes32[] memory denoms = new bytes32[](1);
        denoms[0] = denomB32;
        denomsHash = sha256(abi.encodePacked(denoms));
        // Single-denom burns hash when all denominations have zero claims.
        bytes32[] memory zeroBatches = new bytes32[](1);
        emptyBurnsHash = sha256(abi.encodePacked(zeroBatches));
        verifier = new SP1PoolRootVerifier(
            address(sp1), address(relay), VKEY, address(mixerMock),
            AID, NTAG, VK_HASH, pids, denoms,
            GENESIS
        );
    }

    // ──── Denomination-count bound (matches the guest's 1..16 assert) ────

    function _denomArrays(uint256 n) internal pure returns (bytes32[] memory pids, bytes32[] memory denoms) {
        pids = new bytes32[](n);
        denoms = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            pids[i] = keccak256(abi.encode(AID, i + 1));
            denoms[i] = bytes32(i + 1);
        }
    }

    function test_constructor_rejects_more_than_16_denoms() public {
        (bytes32[] memory pids, bytes32[] memory denoms) = _denomArrays(17);
        vm.expectRevert();
        new SP1PoolRootVerifier(
            address(sp1), address(relay), VKEY, address(mixerMock),
            AID, NTAG, VK_HASH, pids, denoms, GENESIS
        );
    }

    function test_constructor_accepts_16_denoms() public {
        (bytes32[] memory pids, bytes32[] memory denoms) = _denomArrays(16);
        SP1PoolRootVerifier v = new SP1PoolRootVerifier(
            address(sp1), address(relay), VKEY, address(mixerMock),
            AID, NTAG, VK_HASH, pids, denoms, GENESIS
        );
        assertEq(v.NUM_DENOMS(), 16);
    }

    // ──── Calldata builders (NUM_DENOMS == 1) ────

    function _roots(bytes32 r) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = r;
    }

    function _emptyBurns() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    /// @dev Append the authenticated tail (NUM_DENOMS == 1): depositAcc | count | claims.
    function _withTail(bytes memory head, bytes32 depositAcc, bytes32[] memory burns)
        internal pure returns (bytes memory)
    {
        bytes memory pv = abi.encodePacked(head, depositAcc, uint32(burns.length));
        for (uint256 i; i < burns.length; ++i) pv = abi.encodePacked(pv, burns[i]);
        return pv;
    }

    function _submitEmpty(bytes memory pv, bytes32 depositAcc) internal {
        verifier.proveStateTransition(_withTail(pv, depositAcc, _emptyBurns()), "");
    }

    function _buildPV(
        bytes32 lastBlockHash,
        bytes32 assetId,
        uint8 networkTag,
        uint64 chainId,
        address mixerAddr,
        bytes32 vkHash,
        bytes32 depositAccsHash,
        bytes32 burnsHash,
        bytes32 denomsHash_,
        bytes32 newPoolsHash
    ) internal pure returns (bytes memory) {
        bytes memory pv = new bytes(461);
        // genesis prevPoolsHash = hash of NUM_DENOMS (==1) zero-roots, matching the
        // verifier's constructor init.
        _set32(pv, 0, sha256(abi.encodePacked(new bytes32[](1))));
        _set32(pv, 72, GENESIS);
        _set32(pv, 104, newPoolsHash);
        _set32(pv, 176, depositAccsHash);
        _set32(pv, 208, burnsHash);
        _set32(pv, 240, vkHash);
        _set32(pv, 272, assetId);
        pv[304] = bytes1(networkTag);
        _setU64(pv, 305, chainId);
        _setAddr(pv, 313, mixerAddr);
        _set32(pv, 333, lastBlockHash);
        _set32(pv, 365, denomsHash_);
        // prev_state_commitment at 397 = 0 (genesis)
        // new_state_commitment at 429 = 0 (placeholder)
        return pv;
    }

    /// @dev Valid PV with empty burns and a given pool root / deposit accumulator.
    function _validPV(bytes32 lastBlockHash, bytes32 poolRoot, bytes32 depositAcc)
        internal view returns (bytes memory)
    {
        return _buildPV(
            lastBlockHash, AID, NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH,
            sha256(abi.encodePacked(_roots(depositAcc))),
            emptyBurnsHash, denomsHash,
            sha256(abi.encodePacked(_roots(poolRoot)))
        );
    }

    // ──── Domain check tests ────

    function test_wrong_denomination_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), AID, NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH, sha256(abi.encodePacked(_roots(bytes32(0)))),
            emptyBurnsHash, bytes32(uint256(0xBAD)),
            sha256(abi.encodePacked(_roots(bytes32(0))))
        );
        vm.expectRevert(SP1PoolRootVerifier.DomainMismatch.selector);
        _submitEmpty(pv, bytes32(0));
    }

    function test_wrong_mixer_address_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), AID, NTAG, uint64(block.chainid),
            address(0xDEAD), VK_HASH, sha256(abi.encodePacked(_roots(bytes32(0)))),
            emptyBurnsHash, denomsHash, sha256(abi.encodePacked(_roots(bytes32(0))))
        );
        vm.expectRevert(SP1PoolRootVerifier.DomainMismatch.selector);
        _submitEmpty(pv, bytes32(0));
    }

    function test_wrong_chain_id_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), AID, NTAG, 99999,
            address(mixerMock), VK_HASH, sha256(abi.encodePacked(_roots(bytes32(0)))),
            emptyBurnsHash, denomsHash, sha256(abi.encodePacked(_roots(bytes32(0))))
        );
        vm.expectRevert(SP1PoolRootVerifier.DomainMismatch.selector);
        _submitEmpty(pv, bytes32(0));
    }

    function test_wrong_asset_id_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), bytes32(uint256(0xBAD)), NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH, sha256(abi.encodePacked(_roots(bytes32(0)))),
            emptyBurnsHash, denomsHash, sha256(abi.encodePacked(_roots(bytes32(0))))
        );
        vm.expectRevert(SP1PoolRootVerifier.DomainMismatch.selector);
        _submitEmpty(pv, bytes32(0));
    }

    function test_wrong_vk_hash_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), AID, NTAG, uint64(block.chainid),
            address(mixerMock), bytes32(uint256(0xBAD)), sha256(abi.encodePacked(_roots(bytes32(0)))),
            emptyBurnsHash, denomsHash, sha256(abi.encodePacked(_roots(bytes32(0))))
        );
        vm.expectRevert(SP1PoolRootVerifier.InvalidVkHash.selector);
        _submitEmpty(pv, bytes32(0));
    }

    function test_wrong_genesis_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _validPV(bytes32(uint256(0xFF)), bytes32(0), bytes32(0));
        _set32(pv, 72, bytes32(uint256(0xBAD))); // wrong prev_block_hash
        // Reorg finality window: walks blockParent up to FINALITY_WINDOW.
        // 0xBAD isn't a known ancestor of any tip in this mock → StalePrevBlock.
        vm.expectRevert(SP1PoolRootVerifier.StalePrevBlock.selector);
        _submitEmpty(pv, bytes32(0));
    }

    function test_not_relay_tip_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        bytes memory pv = _validPV(bytes32(uint256(0xEE)), bytes32(0), bytes32(0)); // != tip
        vm.expectRevert(SP1PoolRootVerifier.NotRelayTip.selector);
        _submitEmpty(pv, bytes32(0));
    }

    function test_finalityWindow_acceptsAncestorTip() public {
        // Reorg finality window: a proof whose lastBlockHash is the relay's
        // current tip OR a confirmed ancestor within FINALITY_WINDOW=6 should
        // be accepted. Simulates "prover started 4 blocks ago, relay advanced
        // in the meantime; the older lastBlockHash is still in-window." Audit #2.
        bytes32 oldTip = bytes32(uint256(0xAA));
        bytes32 mid1   = bytes32(uint256(0xBB));
        bytes32 mid2   = bytes32(uint256(0xCC));
        bytes32 newTip = bytes32(uint256(0xDD));
        relay.setParent(newTip, mid2);
        relay.setParent(mid2, mid1);
        relay.setParent(mid1, oldTip);
        relay.setTip(newTip);
        // PV: lastBlockHash = oldTip (3 ancestors deep, within window=6)
        bytes memory pv = _validPV(oldTip, bytes32(0), bytes32(0));
        // Should succeed (no revert)
        _submitEmpty(pv, bytes32(0));
    }

    // ──── Root accumulator tests ────

    function test_wrong_accumulator_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        mixerMock.addRoot(poolId, bytes32(uint256(0x111)));
        // PV commits a deposit accumulator hash that does not match the calldata.
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), AID, NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH, bytes32(uint256(0xBAD)),
            emptyBurnsHash, denomsHash, sha256(abi.encodePacked(_roots(bytes32(0))))
        );
        vm.expectRevert(SP1PoolRootVerifier.InvalidDepositRoot.selector);
        _submitEmpty(pv, bytes32(uint256(0xBAD)));
    }

    function test_wrong_accumulator_vs_mixer_reverts() public {
        relay.setTip(bytes32(uint256(0xFF)));
        mixerMock.addRoot(poolId, bytes32(uint256(0x111)));
        bytes32 acc = sha256(abi.encodePacked(bytes32(0), bytes32(uint256(0x111))));
        // Calldata acc hash matches PV, but acc value disagrees with the mixer.
        bytes32 wrongAcc = bytes32(uint256(0x222));
        bytes memory pv = _buildPV(
            bytes32(uint256(0xFF)), AID, NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH, sha256(abi.encodePacked(_roots(wrongAcc))),
            emptyBurnsHash, denomsHash, sha256(abi.encodePacked(_roots(bytes32(0))))
        );
        acc; // silence unused
        vm.expectRevert(SP1PoolRootVerifier.InvalidDepositRoot.selector);
        _submitEmpty(pv, wrongAcc);
    }

    function test_valid_submission_succeeds() public {
        bytes32 tipHash = bytes32(uint256(0xFF));
        relay.setTip(tipHash);
        bytes32 r1 = bytes32(uint256(0x111));
        mixerMock.addRoot(poolId, r1);
        // Compute the correct running accumulator matching the mixer.
        bytes32 acc = sha256(abi.encodePacked(bytes32(0), r1));
        bytes memory pv = _validPV(tipHash, bytes32(0), acc);
        _submitEmpty(pv, acc);
        (bytes32 poolsHash,,,) = verifier.currentState();
        assertEq(poolsHash, sha256(abi.encodePacked(_roots(bytes32(0)))));
    }

    function test_wrong_burn_batch_hash_reverts() public {
        bytes32 tipHash = bytes32(uint256(0xFF));
        relay.setTip(tipHash);
        bytes32[] memory burns = new bytes32[](1);
        burns[0] = bytes32(uint256(0xB04D));
        bytes memory pv = _buildPV(
            tipHash, AID, NTAG, uint64(block.chainid),
            address(mixerMock), VK_HASH, sha256(abi.encodePacked(_roots(bytes32(0)))),
            bytes32(uint256(0xBAD)), denomsHash, sha256(abi.encodePacked(_roots(bytes32(0))))
        );
        vm.expectRevert(SP1PoolRootVerifier.InvalidProof.selector);
        verifier.proveStateTransition(_withTail(pv, bytes32(0), burns), "");
    }

    function test_incremental_state_chaining() public {
        bytes32 tipHash = bytes32(uint256(0xFF));
        relay.setTip(tipHash);
        // First proof: genesis → state A
        bytes32 newPoolRoot = bytes32(uint256(0xAAA));
        bytes32 newNullHash = bytes32(uint256(0xBBB));
        bytes32 newCommitment = bytes32(uint256(0xCCC));
        bytes32 newPoolsHash = sha256(abi.encodePacked(_roots(newPoolRoot)));
        bytes memory pv1 = _validPV(tipHash, newPoolRoot, bytes32(0));
        _set32(pv1, 136, newNullHash);
        _setU64(pv1, 168, 5); // newHeight = 5
        _set32(pv1, 429, newCommitment); // newStateCommitment
        _submitEmpty(pv1, bytes32(0));
        (bytes32 storedPools, bytes32 storedNull, uint64 storedHeight,) = verifier.currentState();
        assertEq(storedPools, newPoolsHash);
        assertEq(storedNull, newNullHash);
        assertEq(storedHeight, 5);

        // Second proof: must chain from state A
        bytes32 tipHash2 = bytes32(uint256(0xEE));
        relay.setTip(tipHash2);
        bytes32 nextPoolRoot = bytes32(uint256(0xDDD));
        bytes32 nextPoolsHash = sha256(abi.encodePacked(_roots(nextPoolRoot)));
        bytes memory pv2 = new bytes(461);
        _set32(pv2, 0, newPoolsHash);     // prevPoolsHash
        _set32(pv2, 32, newNullHash);     // prevNullHash
        _setU64(pv2, 64, 5);             // prevHeight
        _set32(pv2, 72, tipHash);         // prevBlockHash = last proof's lastBlockHash
        _set32(pv2, 104, nextPoolsHash);  // new pools hash
        _set32(pv2, 136, bytes32(uint256(0xEEE))); // new null hash
        _setU64(pv2, 168, 8);            // newHeight
        _set32(pv2, 176, sha256(abi.encodePacked(_roots(bytes32(0))))); // depositAccsHash
        _set32(pv2, 208, emptyBurnsHash); // burnsHash
        _set32(pv2, 240, VK_HASH);
        _set32(pv2, 272, AID);
        pv2[304] = bytes1(NTAG);
        _setU64(pv2, 305, uint64(block.chainid));
        _setAddr(pv2, 313, address(mixerMock));
        _set32(pv2, 333, tipHash2);       // lastBlockHash = new tip
        _set32(pv2, 365, denomsHash);
        _set32(pv2, 397, newCommitment);  // prevStateCommitment must match stored
        _submitEmpty(pv2, bytes32(0));
        (storedPools,, storedHeight,) = verifier.currentState();
        assertEq(storedPools, nextPoolsHash);
        assertEq(storedHeight, 8);
    }

    function test_incremental_wrong_prev_root_reverts() public {
        bytes32 tipHash = bytes32(uint256(0xFF));
        relay.setTip(tipHash);
        // First proof
        bytes memory pv1 = _validPV(tipHash, bytes32(uint256(0xAAA)), bytes32(0));
        _set32(pv1, 429, bytes32(uint256(0xCCC)));
        _submitEmpty(pv1, bytes32(0));
        // Second proof with wrong prevPoolsHash — domain fields must be correct to reach state check
        bytes32 tipHash2 = bytes32(uint256(0xEE));
        relay.setTip(tipHash2);
        bytes memory pv2 = new bytes(461);
        _set32(pv2, 0, bytes32(uint256(0xDEAD))); // wrong prevPoolsHash
        _set32(pv2, 240, VK_HASH);
        _set32(pv2, 272, AID);
        pv2[304] = bytes1(NTAG);
        _setU64(pv2, 305, uint64(block.chainid));
        _setAddr(pv2, 313, address(mixerMock));
        _set32(pv2, 333, tipHash2);
        _set32(pv2, 365, denomsHash);
        vm.expectRevert(SP1PoolRootVerifier.StateMismatch.selector);
        _submitEmpty(pv2, bytes32(0));
    }

    function test_zero_genesis_constructor_reverts() public {
        bytes32[] memory pids = new bytes32[](1);
        pids[0] = poolId;
        bytes32[] memory denoms = new bytes32[](1);
        denoms[0] = denomB32;
        vm.expectRevert(SP1PoolRootVerifier.ZeroGenesis.selector);
        new SP1PoolRootVerifier(
            address(sp1), address(relay), VKEY, address(mixerMock),
            AID, NTAG, VK_HASH, pids, denoms,
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
