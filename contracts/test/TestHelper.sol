// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/lib/BitcoinLightRelay.sol";
import "../src/TacitBridgeMixer.sol";
import "./MockGroth16Verifier.sol";
import "./TestLightRelay.sol";

/// @dev Shared test helper. Uses TestLightRelay which skips PoW so tests
///      can build arbitrary header chains without real mining.
contract TestHelper is Test {
    uint256 constant TEST_TARGET = 0x00000000ffff0000000000000000000000000000000000000000000000000000;

    function _deployRelay() internal returns (TestLightRelay) {
        TestLightRelay r = new TestLightRelay();
        // Tip set to a deterministic hash so tests have a known anchor.
        bytes32 genesisTip = keccak256("test-genesis-tip");
        r.genesis(0, TEST_TARGET, 1000, genesisTip, 0, 1);
        return r;
    }

    /// @dev Build a raw 80-byte Bitcoin header. No PoW requirement — TestLightRelay skips it.
    function _makeHeader(bytes32 prevBlock, bytes32 merkleRoot, uint32 ts, uint32 nonce) internal pure returns (bytes memory) {
        bytes memory h = new bytes(80);
        h[0] = 0x01;
        for (uint256 i; i < 32; ++i) {
            h[4 + i] = prevBlock[i];
            h[36 + i] = merkleRoot[i];
        }
        h[68] = bytes1(uint8(ts & 0xff));
        h[69] = bytes1(uint8((ts >> 8) & 0xff));
        h[70] = bytes1(uint8((ts >> 16) & 0xff));
        h[71] = bytes1(uint8((ts >> 24) & 0xff));
        // bits = 0x1d00ffff LE
        h[72] = 0xff; h[73] = 0xff; h[74] = 0x00; h[75] = 0x1d;
        h[76] = bytes1(uint8(nonce & 0xff));
        h[77] = bytes1(uint8((nonce >> 8) & 0xff));
        h[78] = bytes1(uint8((nonce >> 16) & 0xff));
        h[79] = bytes1(uint8((nonce >> 24) & 0xff));
        return h;
    }

    function _dsha256(bytes memory d) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(d)));
    }

    /// @dev Build a chain of N connected headers. First header has the given
    ///      merkle root; subsequent headers have arbitrary merkle roots.
    function _buildChain(bytes32 startPrev, bytes32 targetMR, uint256 count) internal pure returns (bytes memory chain) {
        chain = new bytes(0);
        bytes32 prev = startPrev;
        for (uint256 i; i < count; ++i) {
            bytes32 mr = i == 0 ? targetMR : bytes32(uint256(0xF00D + i));
            bytes memory h = _makeHeader(prev, mr, uint32(2000 + i * 600), uint32(i));
            chain = abi.encodePacked(chain, h);
            prev = _dsha256(h);
        }
    }

    /// @dev Build a minimal Bitcoin tx wrapping a burn envelope in OP_RETURN.
    function _wrapInBtcTx(bytes memory envelope) internal pure returns (bytes memory) {
        uint256 envLen = envelope.length;
        bool usePD2 = envLen > 255;
        uint256 scriptLen = 1 + (usePD2 ? 3 : 2) + envLen;
        uint256 slVI = scriptLen < 0xfd ? 1 : 3;
        uint256 txLen = 4 + 1 + 36 + 1 + 4 + 1 + 8 + slVI + scriptLen + 4;

        bytes memory tx_ = new bytes(txLen);
        uint256 p;
        tx_[p++] = 0x01; tx_[p++] = 0x00; tx_[p++] = 0x00; tx_[p++] = 0x00;
        tx_[p++] = 0x01;
        for (uint256 i; i < 32; ++i) tx_[p++] = 0x00;
        tx_[p++] = 0xff; tx_[p++] = 0xff; tx_[p++] = 0xff; tx_[p++] = 0xff;
        tx_[p++] = 0x00;
        tx_[p++] = 0xff; tx_[p++] = 0xff; tx_[p++] = 0xff; tx_[p++] = 0xff;
        tx_[p++] = 0x01;
        for (uint256 i; i < 8; ++i) tx_[p++] = 0x00;

        if (scriptLen < 0xfd) { tx_[p++] = bytes1(uint8(scriptLen)); }
        else { tx_[p++] = 0xfd; tx_[p++] = bytes1(uint8(scriptLen & 0xff)); tx_[p++] = bytes1(uint8((scriptLen >> 8) & 0xff)); }

        tx_[p++] = 0x6a;
        if (usePD2) { tx_[p++] = 0x4d; tx_[p++] = bytes1(uint8(envLen & 0xff)); tx_[p++] = bytes1(uint8((envLen >> 8) & 0xff)); }
        else { tx_[p++] = 0x4c; tx_[p++] = bytes1(uint8(envLen)); }
        for (uint256 i; i < envLen; ++i) tx_[p++] = envelope[i];
        tx_[p++] = 0x00; tx_[p++] = 0x00; tx_[p++] = 0x00; tx_[p++] = 0x00;
        return tx_;
    }
}
