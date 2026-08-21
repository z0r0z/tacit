// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {PoolStateReader} from "./PoolStateReader.sol";

using PoolStateReader for ConfidentialPool;
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";
import {assetOf, AssetView} from "./helpers/AssetView.sol";

contract AcceptVerifierH is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract MockRelayH {
    bytes32 public tip;
    mapping(bytes32 => bytes32) public blockParent;

    constructor(bytes32 t) {
        tip = t;
    }

    function setTip(bytes32 t) external {
        tip = t;
    }

    function setParent(bytes32 child, bytes32 parent) external {
        blockParent[child] = parent;
    }
}

/// Pins the `_autoRegisterFromMeta` HEAL branch (ConfidentialPool.sol:2149-2166): an attacker permissionlessly
/// deploys the canonical ERC20 for a not-yet-bridged asset id (the factory is open) and `registerMinted`s it —
/// creating a LOCAL registry entry with NO cross-chain link and a squatter-chosen unitScale. When the real
/// bridge attest later arrives, the heal branch must (a) adopt the GUEST-PROVEN scale, (b) heal the bridged
/// link so a bridged unwrap resolves, and (c) NOT enable a scale-poison drain — which holds because a
/// pool-minted asset has no escrow and the canonical token can only be minted by the pool (the squatter holds
/// zero balance, so there is no outstanding value at the old scale).
contract ConfidentialRegisterHealTest is Test {
    ConfidentialPool pool;
    CanonicalAssetFactory factory;
    address constant SQUATTER = address(0xBAD);

    bytes32 constant BR = keccak256("bridged-asset-BRG"); // the shared (Bitcoin-side) asset id
    bytes32 constant CID = keccak256("brg-metadata-cid");
    bytes32 constant BURN_SENTINEL = keccak256("imt-empty-burn-sentinel");
    bytes32 constant RELAY_VKEY = bytes32(uint256(0xBEEF));
    bytes32 constant ANCHOR = bytes32(uint256(0xB17C0)); // genesis reflection anchor == matured relay tip
    MockRelayH relay;

    function setUp() public {
        vm.chainId(1);
        factory = new CanonicalAssetFactory();
        relay = new MockRelayH(ANCHOR);
        pool = new ConfidentialPool(
            address(new AcceptVerifierH()), bytes32(uint256(0xABCD)), RELAY_VKEY, address(factory),
            address(relay), ANCHOR, 6, bytes32(0), bytes32(0), address(0)
        , address(0), address(0));
        // Bury ANCHOR exactly REFLECTION_CONFIRMATIONS (6) deep so a batch whose tip == ANCHOR is matured.
        bytes32 t = ANCHOR;
        for (uint256 i; i < 6; ++i) {
            bytes32 child = keccak256(abi.encodePacked("matured-relay", ANCHOR, i));
            relay.setParent(child, t);
            t = child;
        }
        relay.setTip(t);
    }

    function _attestWithMeta(ConfidentialPool.AssetMeta[] memory metas) internal {
        bytes32 prior = pool.knownReflectionDigest();
        bytes32 poolRoot = keccak256("btc-pool-root");
        bytes32 next = keccak256(abi.encode(prior, poolRoot));
        pool.attestBitcoinStateProven(
            abi.encode(
                ConfidentialPool.BitcoinRelayPublicValues(
                    prior, poolRoot, keccak256("imt-empty-sentinel"), BURN_SENTINEL, 1, next,
                    ANCHOR, ANCHOR, bytes32(uint256(uint160(address(pool)))), 0,
                    new ConfidentialPool.CbtcLockFolded[](0), new bytes32[](0), new bytes32[](0),
                    uint64(0), uint64(0), uint64(0), metas, new bytes32[](0) // fresh pool => bitcoinConsumedCount == 0 && crossOutCount == 0
                , bytes32(0), keccak256(abi.encodePacked(block.chainid, address(pool))), new uint8[](0))
            ),
            ""
        );
    }

    function test_autoRegister_heals_a_squatted_minted_entry() public {
        // 1. Squatter deploys the EXACT canonical token the meta will resolve to (salt = assetId,pool,symbol,18,cid)
        //    and registers it as a pool-minted local asset with a DIFFERENT scale (tacitDecimals 18 => scale 1).
        vm.startPrank(SQUATTER);
        CanonicalBridgedERC20 token = CanonicalBridgedERC20(factory.deployCanonical(BR, address(pool), "BRG", 18, CID));
        bytes32 internalId = pool.registerMinted(address(token), "Squat", "BRG", 18);
        vm.stopPrank();

        AssetView memory pre = assetOf(pool, internalId);
        assertEq(pre.unitScale, 1, "squatter set scale 1 (18 tacit decimals)");
        assertEq(pre.crossChainLink, bytes32(0), "registerMinted sets NO cross-chain link");
        assertEq(pool.localAssetOf(BR), bytes32(0), "shared id not yet linked");
        assertEq(token.totalSupply(), 0, "squatter minted nothing (only the pool can mint)");

        // 2. The real bridge attest carries the etch-proven meta (decimals 8 => scale 1e10).
        ConfidentialPool.AssetMeta[] memory metas = new ConfidentialPool.AssetMeta[](1);
        metas[0] = ConfidentialPool.AssetMeta({assetId: BR, ticker: bytes16("BRG"), tickerLen: 3, decimals: 8, cid: CID});
        _attestWithMeta(metas);

        // 3. The heal branch fired: link healed, guest-proven scale adopted, canonical token unchanged.
        AssetView memory post = assetOf(pool, internalId);
        assertEq(post.crossChainLink, BR, "bridged link healed");
        assertEq(post.unitScale, 1e10, "guest-proven scale adopted (decimals 8 => 1e10)");
        assertTrue(post.poolMinted, "still a pool-minted asset");
        assertEq(pool.localAssetOf(BR), internalId, "shared id resolves to the local entry");
        assertEq(pool.canonicalTokenFor(BR), address(token), "the squatter's token IS the canonical one (salt-bound to the pool)");

        // F3 REGRESSION: a query/wrap by the SHARED id must resolve to the healed local entry. Before the
        // fix, assets()/wrap() read _assets[sharedId] RAW → registered=false → wrap(sharedId) reverted
        // NotRegistered (a healed canonical asset was un-wrappable by the id the router hands out + notes
        // carry). The lookups now go through _resolveAsset, so the shared id finds the healed entry.
        (bool sharedReg,, uint256 sharedScale,, bool sharedMinted,) = pool.assets(BR);
        assertTrue(sharedReg, "F3: shared-id query of a healed asset resolves as registered");
        assertEq(sharedScale, 1e10, "F3: shared-id query returns the healed guest-proven scale");
        assertTrue(sharedMinted, "F3: shared-id query returns the healed pool-minted flag");

        // 4. SAFETY: no scale-poison drain is possible — a pool-minted asset has no escrow, and the canonical
        //    token has zero supply, so the overwritten scale governs no outstanding value.
        assertEq(pool.escrow(internalId), 0, "pool-minted asset never holds escrow");
        assertEq(token.totalSupply(), 0, "no value existed at the old scale to mis-redeem");

        // 5. Idempotent: re-attesting the same meta is a no-op (already linked => early return).
        _attestWithMeta(metas);
        assertEq(assetOf(pool, internalId).unitScale, 1e10, "re-attest leaves the healed record unchanged");
    }

    // a block that authenticates more etches than attest deploys inline (MAX_AUTOREGISTER_PER_ATTEST = 8)
    // records the surplus as cheap commitments instead of deploying — so a junk-etch flood can never exceed the
    // gas limit and halt the pipeline. The deferred etches are completed permissionlessly via registerAttestedMeta.
    function test_autoRegister_defers_overflow_beyond_cap() public {
        uint256 N = 10;
        ConfidentialPool.AssetMeta[] memory metas = new ConfidentialPool.AssetMeta[](N);
        for (uint256 i; i < N; ++i) {
            metas[i] = ConfidentialPool.AssetMeta({
                assetId: keccak256(abi.encode("flood-asset", i)),
                ticker: bytes16("FLD"),
                tickerLen: 3,
                decimals: 8,
                cid: keccak256(abi.encode("flood-cid", i))
            });
        }
        _attestWithMeta(metas);

        // First 8 deployed inline (linked); the last 2 deferred (a commitment, not yet linked).
        for (uint256 i; i < 8; ++i) {
            assertTrue(pool.localAssetOf(metas[i].assetId) != bytes32(0), "first 8 metas auto-registered inline");
            assertEq(pool.attestedMetaCommit(metas[i].assetId), bytes32(0), "deployed metas hold no deferred commitment");
        }
        for (uint256 i = 8; i < N; ++i) {
            assertEq(pool.localAssetOf(metas[i].assetId), bytes32(0), "overflow metas are NOT deployed inline");
            assertEq(
                pool.attestedMetaCommit(metas[i].assetId), keccak256(abi.encode(metas[i])), "overflow metas deferred as commitments"
            );
        }

        // Anyone completes a deferred deploy by presenting the exact meta.
        pool.registerAttestedMeta(metas[8]);
        assertTrue(pool.localAssetOf(metas[8].assetId) != bytes32(0), "registerAttestedMeta deploys the deferred asset");
        assertEq(pool.attestedMetaCommit(metas[8].assetId), bytes32(0), "the commitment is cleared once completed");

        // A meta that was never deferred (or a tampered one) reverts.
        vm.expectRevert(ConfidentialPool.MetaNotDeferred.selector);
        pool.registerAttestedMeta(metas[0]); // already deployed inline => no commitment
    }
}
