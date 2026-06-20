// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ConfidentialPool} from "../../src/ConfidentialPool.sol";

/// Test helper: read ConfidentialPool's `assets` getter. name/symbol are not stored on-chain (they ride the
/// AssetRegistered event), so they are not part of this view.
function assetOf(ConfidentialPool pool, bytes32 id) view returns (ConfidentialPool.Asset memory a) {
    (a.registered, a.underlying, a.unitScale, a.crossChainLink, a.poolMinted, a.decimals) = pool.assets(id);
}
