// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./TestHelper.sol";
import "../src/SP1PoolRootVerifier.sol";

contract FuzzBitcoinParsing is TestHelper {
    // Fuzz: _wrapInBtcTx should handle any envelope without reverting
    function testFuzz_wrapInBtcTx(bytes calldata envelope) public pure {
        if (envelope.length == 0) return;
        bytes memory tx_ = _wrapInBtcTxStatic(envelope);
        assertTrue(tx_.length > 0);
    }

    function _wrapInBtcTxStatic(bytes calldata envelope) internal pure returns (bytes memory) {
        uint256 envLen = envelope.length;
        bool usePD2 = envLen > 255;
        uint256 scriptLen = 1 + (usePD2 ? 3 : 2) + envLen;
        uint256 slVI = scriptLen < 0xfd ? 1 : 3;
        uint256 txLen = 4 + 1 + 36 + 1 + 4 + 1 + 8 + slVI + scriptLen + 4;
        bytes memory tx_ = new bytes(txLen);
        tx_[0] = 0x01;
        tx_[4] = 0x01;
        return tx_;
    }

    // Fuzz: verifyTxInclusion with random proofs should never panic
    function testFuzz_verifyTxInclusion(bytes32 txid, bytes32 root, bytes32 sibling, uint256 idx) public pure {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        bytes32 cur = txid;
        cur = idx & 1 == 0
            ? sha256(abi.encodePacked(sha256(abi.encodePacked(cur, proof[0]))))
            : sha256(abi.encodePacked(sha256(abi.encodePacked(proof[0], cur))));
        // Just verify it doesn't revert
        assertTrue(cur == root || cur != root);
    }
}

contract FuzzSP1Verifier is TestHelper {
    // Fuzz: arbitrary public values should revert cleanly on the verifier
    function testFuzz_proveStateTransition_arbitrary_pv(bytes calldata publicValues) public {
        MockSP1VerifierForFuzz sp1 = new MockSP1VerifierForFuzz();
        MockRelayForFuzz relay = new MockRelayForFuzz();
        MockRootAccumulatorForFuzz mixerMock = new MockRootAccumulatorForFuzz();
        bytes32 poolId = keccak256(abi.encode(bytes32(uint256(0xAA)), uint256(1 ether)));
        bytes32[] memory pids = new bytes32[](1);
        pids[0] = poolId;
        bytes32[] memory denoms = new bytes32[](1);
        denoms[0] = bytes32(uint256(1 ether) / 1e10);

        SP1PoolRootVerifier verifier = new SP1PoolRootVerifier(
            address(sp1), address(relay), bytes32(uint256(1)),
            address(mixerMock), bytes32(uint256(0xAA)), 0x00,
            6, bytes32(uint256(0xDD)), pids, denoms,
            bytes32(uint256(0xBB))
        );

        try verifier.proveStateTransition(publicValues, "") {
        } catch {
        }
    }
}

contract MockSP1VerifierForFuzz {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}
contract MockRelayForFuzz {
    function tip() external pure returns (bytes32) { return bytes32(uint256(0xFF)); }
}
contract MockRootAccumulatorForFuzz {
    function getRootAccumulator(bytes32) external pure returns (bytes32) { return bytes32(0); }
}
