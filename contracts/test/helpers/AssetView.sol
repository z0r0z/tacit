// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ConfidentialPool} from "../../src/ConfidentialPool.sol";

/// Test helper: rebuild the full Asset struct from ConfidentialPool's public `assets` mapping.
/// The contract exposes the mapping (auto-getter returns the field tuple); a redundant struct-
/// returning getter was dropped, so tests read the tuple and repack it here for ergonomic access.
function assetOf(ConfidentialPool pool, bytes32 id) view returns (ConfidentialPool.Asset memory a) {
    (a.registered, a.underlying, a.unitScale, a.crossChainLink, a.poolMinted, a.name, a.symbol, a.decimals) =
        pool.assets(id);
}
