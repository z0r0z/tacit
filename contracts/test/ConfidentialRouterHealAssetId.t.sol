// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialRouter} from "../src/ConfidentialRouter.sol";

/// Minimal pool surface the router's `_poolAssetId` reads: the canonical token bound to a shared id and the
/// shared→local heal map. Nothing else is exercised.
contract MockHealPool {
    mapping(bytes32 => address) public canonicalTokenFor;
    mapping(bytes32 => bytes32) public localAssetOf;

    function setCanonical(bytes32 sharedId, address token) external {
        canonicalTokenFor[sharedId] = token;
    }

    function setLocal(bytes32 sharedId, bytes32 localId) external {
        localAssetOf[sharedId] = localId;
    }
}

/// A canonical bridged ERC20 commits to its shared cross-chain id via ASSET_ID().
contract MockCanonToken {
    bytes32 public immutable ASSET_ID;

    constructor(bytes32 id) {
        ASSET_ID = id;
    }
}

contract StubPermit2 {}

/// Exposes the internal `_poolAssetId` for a direct assertion.
contract RouterHarness is ConfidentialRouter {
    constructor(address pool_, address permit2_) ConfidentialRouter(pool_, address(0), permit2_) {}

    function poolAssetId(address token) external view returns (bytes32) {
        return _poolAssetId(token);
    }
}

/// Pins that a HEALED canonical asset (registered under a LOCAL id with localAssetOf[shared]=local, local !=
/// shared) is keyed to the pool by its SHARED id — the id its bridge-minted notes carry — NOT the local id.
/// Returning the local id here would bind a router-wrapped note to the local id and fork the confidential
/// supply away from bridge-minted notes under the shared id (a silent fungibility split).
contract ConfidentialRouterHealAssetIdTest is Test {
    RouterHarness router;
    MockHealPool pool;

    bytes32 constant SHARED = keccak256("bridged-shared-id");
    bytes32 constant LOCAL = keccak256("local-internal-id"); // != SHARED

    function setUp() public {
        pool = new MockHealPool();
        router = new RouterHarness(address(pool), address(new StubPermit2()));
    }

    function test_healedCanonical_keysByShared_notLocal() public {
        MockCanonToken token = new MockCanonToken(SHARED);
        pool.setCanonical(SHARED, address(token));
        pool.setLocal(SHARED, LOCAL); // healed: shared resolves to a different local id

        assertTrue(LOCAL != SHARED, "precondition: healed local id differs from shared id");
        assertEq(
            router.poolAssetId(address(token)),
            SHARED,
            "healed canonical asset must key by its SHARED id (fungible with bridged notes), not the local id"
        );
    }

    function test_directCanonical_keysByShared() public {
        // A directly-registered canonical asset has localAssetOf[shared] == shared (self-link) or unset;
        // either way the router keys it by the shared id.
        MockCanonToken token = new MockCanonToken(SHARED);
        pool.setCanonical(SHARED, address(token));
        pool.setLocal(SHARED, SHARED);
        assertEq(router.poolAssetId(address(token)), SHARED, "direct canonical keys by shared id");
    }

    function test_nonCanonical_fallsBackToEvmId() public {
        // A token that is NOT the canonical token for its claimed id (or has no ASSET_ID) falls back to the
        // address-derived _evmAssetId — the router must not treat it as a canonical asset.
        MockCanonToken token = new MockCanonToken(SHARED);
        // pool.canonicalTokenFor(SHARED) is address(0) here, so the ASSET_ID branch is skipped.
        bytes32 got = router.poolAssetId(address(token));
        assertTrue(got != SHARED, "non-canonical token must not key by the claimed shared id");
    }
}
