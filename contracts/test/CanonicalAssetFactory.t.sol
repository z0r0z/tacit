// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";

/// The canonical asset hub: a CREATE2 factory issues a deterministic public ERC20 per
/// asset (the public face, Uniswap-tradeable), gated mint/burn by the bridge/collateral
/// minter; ConfidentialPool then wraps it for the confidential face. Address = f(assetId);
/// `name` is the constant brand "Tacit Token"; the only per-asset metadata is
/// (symbol, decimals), deterministic to the real asset.
contract CanonicalAssetFactoryTest is Test {
    CanonicalAssetFactory factory;

    address constant MINTER = address(0xB121D6E); // the bridge / collateral vault
    address constant USER = address(0xA11CE);
    bytes32 constant ASSET = keccak256("cBTC.tac");

    address constant ETCHER = address(0xE7C);
    bytes32 constant SALT = bytes32(uint256(7));

    function setUp() public {
        factory = new CanonicalAssetFactory();
    }

    function _deploy() internal returns (CanonicalBridgedERC20 tok) {
        tok = CanonicalBridgedERC20(factory.deployCanonical(ASSET, MINTER, "cBTC", 8));
    }

    function test_deploy_is_canonical_and_deterministic() public {
        address predicted = factory.predict(ASSET, MINTER, "cBTC", 8);
        CanonicalBridgedERC20 tok = _deploy();
        assertEq(address(tok), predicted, "address == predicted (deterministic)");
        assertEq(factory.tokenOf(ASSET, MINTER, "cBTC", 8), address(tok), "registered by (asset id, minter, metadata)");
        assertEq(tok.ASSET_ID(), ASSET, "asset id stored");
        assertEq(tok.MINTER(), MINTER, "minter stored");
        assertEq(tok.name(), "Tacit Token", "constant brand name");
        assertEq(tok.symbol(), "cBTC", "per-asset ticker");
        assertEq(tok.decimals(), 8, "per-asset decimals");
    }

    function test_one_canonical_per_asset() public {
        _deploy();
        vm.expectRevert(CanonicalAssetFactory.AlreadyDeployed.selector);
        factory.deployCanonical(ASSET, MINTER, "cBTC", 8);
    }

    function test_only_minter_mints_and_burns() public {
        CanonicalBridgedERC20 tok = _deploy();

        vm.expectRevert(CanonicalBridgedERC20.NotMinter.selector);
        tok.mint(USER, 1e8);

        vm.prank(MINTER);
        tok.mint(USER, 5e8);
        assertEq(tok.balanceOf(USER), 5e8, "minted");
        assertEq(tok.totalSupply(), 5e8, "supply");

        vm.expectRevert(CanonicalBridgedERC20.NotMinter.selector);
        tok.burn(USER, 1e8);

        vm.prank(MINTER);
        tok.burn(USER, 2e8);
        assertEq(tok.balanceOf(USER), 3e8, "burned on redeem");
        assertEq(tok.totalSupply(), 3e8, "supply reduced");
    }

    /// registerMinted is rejected unless the pool is the ERC20's minter — otherwise
    /// the asset could never exit (mint would revert), a footgun.
    function test_registerMinted_requires_pool_as_minter() public {
        CanonicalBridgedERC20 tok = _deploy(); // minter = MINTER, not the pool
        ConfidentialPool pool = new ConfidentialPool(address(0x5117), bytes32(uint256(1)), bytes32(0), address(0), address(0), bytes32(0), 6);
        vm.expectRevert(ConfidentialPool.PoolNotMinter.selector);
        pool.registerMinted(address(tok), "x", "x", 8);
    }

    /// The two faces: a canonical ERC20 (public) wraps into ConfidentialPool
    /// (confidential). The pool is asset-agnostic — it just escrows the ERC20.
    function test_canonical_erc20_wraps_into_pool() public {
        CanonicalBridgedERC20 tok = _deploy();
        vm.prank(MINTER);
        tok.mint(USER, 100e8);

        // verifier address is a non-zero placeholder; wrap never calls it (only settle does).
        ConfidentialPool pool = new ConfidentialPool(address(0x5117), bytes32(uint256(1)), bytes32(0), address(0), address(0), bytes32(0), 6);
        // Pure escrow custody (no cross-chain link): an externally-minted canonical token
        // escrowed for its confidential face. A cross-chain link is reserved for pool-minted
        // assets (where the pool is the supply authority backing bridge_mint), so escrowing
        // one with a link is rejected — escrow can't back bridged supply.
        bytes32 poolAsset = pool.registerWrapped(address(tok), 1, bytes32(0), "Conf cBTC", "ccBTC", 8);

        vm.prank(USER);
        tok.approve(address(pool), 100e8);
        vm.prank(USER);
        pool.wrap(poolAsset, 100e8, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));

        assertEq(pool.escrow(poolAsset), 100e8, "pool escrows the canonical ERC20 (confidential face)");
        assertEq(tok.balanceOf(address(pool)), 100e8, "ERC20 custodied by the pool");
        assertEq(tok.balanceOf(USER), 0, "user moved value into the confidential pool");
    }

    /// canonicalTokenFor is the one-call "is this the real one?" check: the pool returns only the token
    /// it actually backs, so an impostor ERC20 (same asset id / symbol, a different minter — never
    /// registered) resolves to address(0), not itself. The factory can't answer this — it deploys every
    /// variant — so the backing authority (the pool) is the source of truth.
    function test_canonicalTokenFor_rejects_impostors() public {
        CanonicalBridgedERC20 real = _deploy();
        ConfidentialPool pool =
            new ConfidentialPool(address(0x5117), bytes32(uint256(1)), bytes32(0), address(0), address(0), bytes32(0), 6);
        bytes32 poolAsset = pool.registerWrapped(address(real), 1, bytes32(0), "Conf cBTC", "ccBTC", 8);
        assertEq(pool.canonicalTokenFor(poolAsset), address(real), "the registered (real) token is returned");
        assertEq(pool.canonicalTokenFor(keccak256("impostor")), address(0), "an unregistered asset resolves to address(0)");
    }

    // ── self-certifying EVM-etch path: the asset id commits to (symbol, decimals) ──

    function test_etch_derives_and_self_certifies() public {
        (bytes32 id, address token) = factory.etchCanonical(ETCHER, SALT, MINTER, "TAC", 18);

        assertEq(id, factory.deriveAssetId(ETCHER, SALT, "TAC", 18), "id is the metadata derivation");
        assertEq(factory.tokenOf(id, MINTER, "TAC", 18), token, "registered by (id, minter, metadata)");

        CanonicalBridgedERC20 t = CanonicalBridgedERC20(token);
        assertEq(t.ASSET_ID(), id);
        assertEq(t.name(), "Tacit Token", "constant brand name");
        assertEq(t.symbol(), "TAC");
        assertEq(t.decimals(), 18);

        assertTrue(factory.verifyMetadata(id, ETCHER, SALT, "TAC", 18), "official metadata verifies on-chain");
    }

    function test_wrong_metadata_cannot_claim_the_id() public {
        (bytes32 id,) = factory.etchCanonical(ETCHER, SALT, MINTER, "TAC", 18);
        assertFalse(factory.verifyMetadata(id, ETCHER, SALT, "TAK", 18), "wrong symbol rejected");
        assertFalse(factory.verifyMetadata(id, ETCHER, SALT, "TAC", 8), "wrong decimals rejected");
        // wrong metadata lands at a DIFFERENT id — it can never occupy the canonical one
        (bytes32 id2,) = factory.etchCanonical(ETCHER, SALT, MINTER, "TAC", 8);
        assertTrue(id != id2, "different metadata -> different id");
    }

    function test_etch_address_is_deterministic_in_id() public {
        bytes32 id = factory.deriveAssetId(ETCHER, SALT, "TAC", 18);
        address predicted = factory.predict(id, MINTER, "TAC", 18);
        (bytes32 idDeployed, address token) = factory.etchCanonical(ETCHER, SALT, MINTER, "TAC", 18);
        assertEq(idDeployed, id, "derive == etch id");
        assertEq(token, predicted, "address == predicted");
    }

    /// The property the bridge relies on: the canonical address is a pure function of
    /// (asset id, minter, symbol, decimals) — all deterministic-to-real for a canonical
    /// asset — computable BEFORE deploy, so the bridge can mint to it on first touch and
    /// forever after. Binding the minter + metadata (not the id alone) is what stops a
    /// front-runner from occupying that address with a foreign minter or spoofed metadata.
    function test_address_is_pure_function_of_id_minter_meta() public {
        bytes32 id = keccak256("some-bitcoin-asset");
        address predicted = factory.predict(id, MINTER, "WHATEVER", 3); // knowable before deploy
        address token = factory.deployCanonical(id, MINTER, "WHATEVER", 3);
        assertEq(token, predicted, "deployed address == predicted(id, minter, symbol, decimals)");
        // A different minter or metadata lands on a DIFFERENT address — can't occupy this one.
        assertTrue(predicted != factory.predict(id, address(0xBEEF), "WHATEVER", 3), "minter bound");
        assertTrue(predicted != factory.predict(id, MINTER, "SPOOF", 3), "symbol bound");
        assertTrue(predicted != factory.predict(id, MINTER, "WHATEVER", 8), "decimals bound");
        assertEq(CanonicalBridgedERC20(token).name(), "Tacit Token");
        assertEq(CanonicalBridgedERC20(token).symbol(), "WHATEVER");
        assertEq(CanonicalBridgedERC20(token).decimals(), 3);
        assertEq(CanonicalBridgedERC20(token).MINTER(), MINTER);
    }

    function test_metaHash_distinguishes_symbol_decimals_and_cid() public view {
        bytes32 h = factory.metaHash("TAC", 18);
        assertTrue(h != factory.metaHash("TAK", 18), "symbol bound");
        assertTrue(h != factory.metaHash("TAC", 8), "decimals bound");
        assertTrue(h != factory.metaHash("TAC", 18, keccak256("cid")), "cid bound");
        // no-metadata short form == the cid=0 form
        assertEq(h, factory.metaHash("TAC", 18, bytes32(0)), "short form is cid=0");
    }

    /// Cross-language KAT — must equal tests/confidential-canonical-asset-id.mjs so the
    /// derivation is identical in Solidity, JS, and Rust. meta_hash now commits the metadata
    /// CID (0 in this vector → the no-metadata form).
    function test_metaHash_kat() public view {
        assertEq(
            factory.metaHash("TAC", 18),
            0xe4c8ab35e9869863d4b3a44796e370871abf8ccdae06b04d82fff892e89c06e6,
            "metaHash KAT (TAC/18/cid=0)"
        );
    }

    /// Cross-language KAT for the metadata-CID binding (nonzero cid) — locks that the full
    /// 32-byte cid is appended into meta_hash. Mirrors tests/confidential-canonical-asset-id.mjs.
    function test_metaHash_kat_with_cid() public view {
        bytes32 cid = 0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f;
        assertEq(
            factory.metaHash("cBTC", 8, cid),
            0x96dcb13599f507d7d84d8b1b44e25f7094fcd54115a74cfa1412d48a559a0c81,
            "metaHash KAT (cBTC/8/cid=0x00..1f)"
        );
    }

    // ── contractURI: the etch-proven metadata cid reconstructed as a CIDv1 base16 string ──

    /// EIP-7572 contractURI: the 32-byte METADATA_CID is surfaced as `ipfs://` + a CIDv1 in
    /// base16 (multibase `f`): 01(v1) ‖ 55(raw) ‖ 12(sha2-256) ‖ 20(len 32) ‖ hex(cid). With the
    /// raw codec the cid is simply sha256(metadata JSON bytes), recomputable from the JSON alone.
    /// KAT vector (bytes 0x00..0x1f) is mirrored in tests/confidential-canonical-asset-id.mjs.
    function test_contractURI_reconstructs_cidv1_base16() public {
        bytes32 cid = 0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f;
        CanonicalBridgedERC20 tok = CanonicalBridgedERC20(factory.deployCanonical(ASSET, MINTER, "cBTC", 8, cid));
        assertEq(tok.METADATA_CID(), cid, "cid bound into the token");
        assertEq(
            tok.contractURI(),
            "ipfs://f01551220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
            "CIDv1 base16: f 01 55 12 20 then hex(cid), zero-bytes preserved (left-padded)"
        );
    }

    function test_contractURI_empty_when_no_metadata() public {
        CanonicalBridgedERC20 tok = _deploy(); // cid = 0
        assertEq(tok.METADATA_CID(), bytes32(0), "no metadata cid");
        assertEq(tok.contractURI(), "", "absent metadata -> empty contractURI");
    }

    // ── pool lazy-deploys + harmonizes decimals from guest-proven metadata (attest_meta) ──
    // registerMintedAuto was removed: a cross-chain link is established ONLY by the guest-proven
    // attest_meta path (so a caller can't bind a link with an unauthenticated decimals/scale). Its
    // lazy-deploy + harmonize behavior is covered by ConfidentialPool.t.sol's attest_meta tests.

    function _pool() internal returns (ConfidentialPool) {
        return new ConfidentialPool(address(0x5117), bytes32(uint256(1)), bytes32(0), address(0), address(0), bytes32(0), 6);
    }

    // ── external ERC20 registration derives the Tacit-side scale (registerWrappedAuto) ──

    function test_registerWrappedAuto_derives_scale_from_decimals() public {
        ConfidentialPool pool = _pool();
        // 18-decimal external ERC20 (WETH-like) -> 8 on Tacit, scale 10^10
        address weth = factory.deployCanonical(keccak256("WETH-ext"), MINTER, "WE", 18);
        bytes32 a18 = pool.registerWrappedAuto(weth, bytes32(0));
        assertEq(pool.getAsset(a18).unitScale, 1e10, "18-dec -> scale 10^10");
        assertEq(pool.getAsset(a18).decimals, 18);
        assertFalse(pool.getAsset(a18).poolMinted, "external ERC20 = escrow");
        // 6-decimal external ERC20 (USDC-like) -> 6 on Tacit, scale 1 (no loss)
        address usdc = factory.deployCanonical(keccak256("USDC-ext"), MINTER, "US", 6);
        bytes32 a6 = pool.registerWrappedAuto(usdc, bytes32(0));
        assertEq(pool.getAsset(a6).unitScale, 1, "6-dec -> scale 1");
        assertEq(pool.getAsset(a6).decimals, 6);
    }
}
