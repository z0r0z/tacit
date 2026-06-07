// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";

/// The canonical asset hub: a CREATE2 factory issues a deterministic public ERC20 per
/// asset (the public face, Uniswap-tradeable), gated mint/burn by the bridge/collateral
/// minter; ConfidentialPool then wraps it for the confidential face. This proves the
/// split (factory issues, pool makes confidential) and the deterministic address.
contract CanonicalAssetFactoryTest is Test {
    CanonicalAssetFactory factory;

    address constant MINTER = address(0xB121D6E); // the bridge / collateral vault
    address constant USER = address(0xA11CE);
    bytes32 constant ASSET = keccak256("cBTC.tac");

    function setUp() public {
        factory = new CanonicalAssetFactory();
    }

    function _deploy() internal returns (CanonicalBridgedERC20 tok) {
        tok = CanonicalBridgedERC20(factory.deployCanonical(ASSET, MINTER, "Canonical cBTC", "cBTC", 8));
    }

    function test_deploy_is_canonical_and_deterministic() public {
        address predicted = factory.predict(ASSET, MINTER, "Canonical cBTC", "cBTC", 8);
        CanonicalBridgedERC20 tok = _deploy();
        assertEq(address(tok), predicted, "address == predicted (deterministic)");
        assertEq(factory.tokenOf(ASSET), address(tok), "registered by asset id");
        assertEq(tok.ASSET_ID(), ASSET, "asset id stored");
        assertEq(tok.MINTER(), MINTER, "minter stored");
        assertEq(tok.name(), "Canonical cBTC");
        assertEq(tok.symbol(), "cBTC");
        assertEq(tok.decimals(), 8);
    }

    function test_one_canonical_per_asset() public {
        _deploy();
        vm.expectRevert(CanonicalAssetFactory.AlreadyDeployed.selector);
        factory.deployCanonical(ASSET, MINTER, "Canonical cBTC", "cBTC", 8);
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
        ConfidentialPool pool = new ConfidentialPool(address(0x5117), bytes32(uint256(1)), address(0));
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
        ConfidentialPool pool = new ConfidentialPool(address(0x5117), bytes32(uint256(1)), address(0));
        bytes32 poolAsset = pool.registerWrapped(address(tok), 1, ASSET, "Conf cBTC", "ccBTC", 8);

        vm.prank(USER);
        tok.approve(address(pool), 100e8);
        vm.prank(USER);
        pool.wrap(poolAsset, 100e8, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));

        assertEq(pool.escrow(poolAsset), 100e8, "pool escrows the canonical ERC20 (confidential face)");
        assertEq(tok.balanceOf(address(pool)), 100e8, "ERC20 custodied by the pool");
        assertEq(tok.balanceOf(USER), 0, "user moved value into the confidential pool");
    }
}
