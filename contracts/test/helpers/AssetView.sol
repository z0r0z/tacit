// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ConfidentialPool} from "../../src/ConfidentialPool.sol";

/// Test-only view of ConfidentialPool's `assets` getter. name/symbol are not stored on-chain (they ride the
/// AssetRegistered event), so they are not part of this view.
struct AssetView {
    bool registered;
    address underlying;
    uint256 unitScale;
    bytes32 crossChainLink;
    bool poolMinted;
    uint8 decimals;
}

function assetOf(ConfidentialPool pool, bytes32 id) view returns (AssetView memory a) {
    (a.registered, a.underlying, a.unitScale, a.crossChainLink, a.poolMinted, a.decimals) = pool.assets(id);
}
