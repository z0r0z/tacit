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
        address predicted = factory.predict(ASSET);
        CanonicalBridgedERC20 tok = _deploy();
        assertEq(address(tok), predicted, "address == predicted (deterministic)");
        assertEq(factory.tokenOf(ASSET), address(tok), "registered by asset id");
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
        ConfidentialPool pool = new ConfidentialPool(address(0x5117), bytes32(uint256(1)), bytes32(0));
        vm.expectRevert(ConfidentialPool.PoolNotMinter.selector);
        pool.registerMinted(address(tok), 1, ASSET, "x", "x", 8);
    }

    /// The two faces: a canonical ERC20 (public) wraps into ConfidentialPool
    /// (confidential). The pool is asset-agnostic — it just escrows the ERC20.
    function test_canonical_erc20_wraps_into_pool() public {
        CanonicalBridgedERC20 tok = _deploy();
        vm.prank(MINTER);
        tok.mint(USER, 100e8);

        // verifier address is a non-zero placeholder; wrap never calls it (only settle does).
        ConfidentialPool pool = new ConfidentialPool(address(0x5117), bytes32(uint256(1)), bytes32(0));
        bytes32 poolAsset = pool.registerWrapped(address(tok), 1, ASSET, "Conf cBTC", "ccBTC", 8);

        vm.prank(USER);
        tok.approve(address(pool), 100e8);
        vm.prank(USER);
        pool.wrap(poolAsset, 100e8, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));

        assertEq(pool.escrow(poolAsset), 100e8, "pool escrows the canonical ERC20 (confidential face)");
        assertEq(tok.balanceOf(address(pool)), 100e8, "ERC20 custodied by the pool");
        assertEq(tok.balanceOf(USER), 0, "user moved value into the confidential pool");
    }

    // ── self-certifying EVM-etch path: the asset id commits to (symbol, decimals) ──

    function test_etch_derives_and_self_certifies() public {
        (bytes32 id, address token) = factory.etchCanonical(ETCHER, SALT, MINTER, "TAC", 18);

        assertEq(id, factory.deriveAssetId(ETCHER, SALT, "TAC", 18), "id is the metadata derivation");
        assertEq(factory.tokenOf(id), token, "registered by derived id");

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
        address predicted = factory.predict(id);
        (bytes32 idDeployed, address token) = factory.etchCanonical(ETCHER, SALT, MINTER, "TAC", 18);
        assertEq(idDeployed, id, "derive == etch id");
        assertEq(token, predicted, "address == predicted");
    }

    /// The property the bridge relies on: the canonical address is a pure function of the
    /// asset id — computable BEFORE deploy and independent of the metadata, so the bridge
    /// can mint to it on first touch and forever after.
    function test_address_is_pure_function_of_id() public {
        bytes32 id = keccak256("some-bitcoin-asset");
        address predicted = factory.predict(id); // knowable before the token exists
        address token = factory.deployCanonical(id, MINTER, "WHATEVER", 3);
        assertEq(token, predicted, "deployed address == predicted(id) regardless of metadata");
        assertEq(CanonicalBridgedERC20(token).name(), "Tacit Token");
        assertEq(CanonicalBridgedERC20(token).symbol(), "WHATEVER");
        assertEq(CanonicalBridgedERC20(token).decimals(), 3);
        assertEq(CanonicalBridgedERC20(token).MINTER(), MINTER);
    }

    function test_metaHash_distinguishes_symbol_and_decimals() public view {
        bytes32 h = factory.metaHash("TAC", 18);
        assertTrue(h != factory.metaHash("TAK", 18), "symbol bound");
        assertTrue(h != factory.metaHash("TAC", 8), "decimals bound");
    }

    /// Cross-language KAT — must equal tests/confidential-canonical-asset-id.mjs so the
    /// derivation is identical in Solidity, JS, and Rust.
    function test_metaHash_kat() public view {
        assertEq(
            factory.metaHash("TAC", 18),
            0xdf3026173e81ffe48ad033a90d78054b461ea8303f5d76989bd8d5e050311215,
            "metaHash KAT (TAC/18)"
        );
    }

    // ── pool lazy-deploys + harmonizes decimals deterministically (registerMintedAuto) ──

    function _pool() internal returns (ConfidentialPool) {
        return new ConfidentialPool(address(0x5117), bytes32(uint256(1)), bytes32(0));
    }

    function test_registerMintedAuto_lazy_deploys_and_harmonizes() public {
        ConfidentialPool pool = _pool();
        bytes32 tacId = keccak256("TAC-bitcoin-asset");
        (bytes32 assetId, address token) = pool.registerMintedAuto(address(factory), tacId, "TAC", 8);

        assertEq(token, factory.predict(tacId), "lazy-deployed at f(tacitAssetId)");
        assertEq(factory.tokenOf(tacId), token, "registered in factory");

        CanonicalBridgedERC20 t = CanonicalBridgedERC20(token);
        assertEq(t.decimals(), 18, "8-dec Tacit asset presented at 18 on Ethereum");
        assertEq(t.name(), "Tacit Token", "constant brand");
        assertEq(t.symbol(), "TAC", "ticker carried");
        assertEq(t.MINTER(), address(pool), "pool is the minter");

        ConfidentialPool.Asset memory a = pool.getAsset(assetId);
        assertEq(a.unitScale, 1e10, "unitScale = 10^(18-8), derived on-chain");
        assertEq(a.crossChainLink, tacId, "linked to the Bitcoin/Tacit asset id");
        assertEq(a.decimals, 18);
        assertTrue(a.poolMinted);
    }

    function test_registerMintedAuto_adopts_prior_factory_token() public {
        ConfidentialPool pool = _pool();
        bytes32 tacId = keccak256("PRE");
        address pre = factory.deployCanonical(tacId, address(pool), "PRE", 18); // pre-deployed, pool = minter
        (bytes32 assetId, address token) = pool.registerMintedAuto(address(factory), tacId, "PRE", 6);
        assertEq(token, pre, "adopts the existing factory token, no redeploy");
        assertEq(pool.getAsset(assetId).unitScale, 1e12, "unitScale = 10^(18-6)");
    }

    function test_registerMintedAuto_rejects_bad_decimals() public {
        ConfidentialPool pool = _pool();
        vm.expectRevert(ConfidentialPool.BadDecimals.selector);
        pool.registerMintedAuto(address(factory), keccak256("X"), "X", 19);
    }

    function test_registerMintedAuto_rejects_if_pool_not_minter() public {
        ConfidentialPool pool = _pool();
        bytes32 tacId = keccak256("NOTMINE");
        factory.deployCanonical(tacId, MINTER, "NM", 18); // minter = MINTER, not the pool
        vm.expectRevert(ConfidentialPool.PoolNotMinter.selector);
        pool.registerMintedAuto(address(factory), tacId, "NM", 8);
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
