// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ConfidentialPool} from "../../src/ConfidentialPool.sol";

/// Test helper: rebuild the full Asset struct from ConfidentialPool's public `assets` getter.
/// `assets` returns name/symbol as packed short-string `bytes32` (left-aligned, null-padded) to keep the
/// contract small; this unpacks them back to `string` for ergonomic test access.
function assetOf(ConfidentialPool pool, bytes32 id) view returns (ConfidentialPool.Asset memory a) {
    bytes32 nm;
    bytes32 sym;
    (a.registered, a.underlying, a.unitScale, a.crossChainLink, a.poolMinted, nm, sym, a.decimals) =
        pool.assets(id);
    a.name = _unpackShort(nm);
    a.symbol = _unpackShort(sym);
}

function _unpackShort(bytes32 b) pure returns (string memory s) {
    uint256 len;
    while (len < 32 && b[len] != 0) {
        unchecked {
            ++len;
        }
    }
    s = new string(len);
    assembly ("memory-safe") {
        mstore(add(s, 0x20), b)
    }
}
