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

    /// @dev Wrap a burn envelope in a minimal segwit Taproot reveal tx. The
    ///      TACIT-framed envelope rides in vin[0]'s witness item 1 (the
    ///      tapscript), matching the mixer's _extractTaprootEnvelope:
    ///      PUSH32 x-only | OP_CHECKSIG | OP_FALSE | OP_IF | push(frame||env) | OP_ENDIF.
    function _wrapInBtcTx(bytes memory envelope) internal pure returns (bytes memory) {
        bytes memory framed = abi.encodePacked(bytes6(0x544143495401), envelope); // "TACIT" || 0x01 || env
        uint256 fl = framed.length;
        bytes memory push;
        if (fl <= 75) push = abi.encodePacked(bytes1(uint8(fl)), framed);
        else if (fl <= 255) push = abi.encodePacked(bytes1(0x4c), bytes1(uint8(fl)), framed);
        else push = abi.encodePacked(bytes1(0x4d), bytes1(uint8(fl & 0xff)), bytes1(uint8((fl >> 8) & 0xff)), framed);

        bytes memory tapscript = abi.encodePacked(
            bytes1(0x20), bytes32(0),    // PUSH32 x-only internal key (value unchecked by parser)
            bytes1(0xac),                // OP_CHECKSIG
            bytes1(0x00), bytes1(0x63),  // OP_FALSE OP_IF
            push,
            bytes1(0x68)                 // OP_ENDIF
        );
        return abi.encodePacked(
            bytes4(0x02000000),                              // version
            bytes1(0x00), bytes1(0x01),                      // segwit marker + flag
            bytes1(0x01),                                    // 1 input
            bytes32(0), bytes4(0xffffffff),                  // outpoint (txid || vout)
            bytes1(0x00), bytes4(0xffffffff),                // empty scriptSig + sequence
            bytes1(0x01),                                    // 1 output
            bytes8(0), bytes1(0x00),                         // value 0 + empty scriptPubKey
            bytes1(0x02), bytes1(0x00),                      // witness: 2 items; item 0 = empty sig
            _varInt(tapscript.length), tapscript,            // item 1 = tapscript
            bytes4(0x00000000)                               // locktime
        );
    }

    /// @dev Witness-stripped txid, mirroring TacitBridgeMixer._computeTxid for the
    ///      fixed shape _wrapInBtcTx emits (drops marker/flag + witness). Use this
    ///      for the merkle-inclusion root, not _dsha256(rawTx).
    function _btcTxid(bytes memory rawTx) internal pure returns (bytes32) {
        // version(4) | 00 01 | in(1+36+1+4) | out(1+8+1) | witness | locktime(4)
        uint256 inOutEnd = 6 + 1 + 36 + 1 + 4 + 1 + 8 + 1; // 58
        bytes memory stripped = abi.encodePacked(rawTx[0], rawTx[1], rawTx[2], rawTx[3]);
        for (uint256 i = 6; i < inOutEnd; ++i) stripped = abi.encodePacked(stripped, rawTx[i]);
        uint256 L = rawTx.length;
        return _dsha256(abi.encodePacked(stripped, rawTx[L - 4], rawTx[L - 3], rawTx[L - 2], rawTx[L - 1]));
    }

    /// @dev CompactSize varint (covers tapscript lengths < 2^16).
    function _varInt(uint256 n) internal pure returns (bytes memory) {
        if (n < 0xfd) return abi.encodePacked(bytes1(uint8(n)));
        return abi.encodePacked(bytes1(0xfd), bytes1(uint8(n & 0xff)), bytes1(uint8((n >> 8) & 0xff)));
    }
}
