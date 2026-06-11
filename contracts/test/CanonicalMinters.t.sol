// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {FixedSupplyMinter, CappedMintMinter} from "../src/CanonicalMinters.sol";

contract CanonicalMintersTest is Test {
    CanonicalAssetFactory factory;
    address constant ETCHER = address(0xE7);
    address constant ALICE = address(0xA11CE);
    address constant AUTH = address(0xA47);
    bytes32 constant SALT = keccak256("salt");

    function setUp() public {
        factory = new CanonicalAssetFactory();
    }

    // ── FixedSupplyMinter — the T_CETCH analog ──

    function test_fixed_mints_total_to_recipient_then_inert() public {
        FixedSupplyMinter m =
            new FixedSupplyMinter(factory, ETCHER, SALT, "FIX", 18, bytes32(0), 1_000e18, ALICE);
        CanonicalBridgedERC20 tok = m.TOKEN();
        assertEq(tok.totalSupply(), 1_000e18, "minted total");
        assertEq(tok.balanceOf(ALICE), 1_000e18, "to recipient");
        assertEq(tok.MINTER(), address(m), "the helper is the sole MINTER");
        assertEq(tok.ASSET_ID(), m.ASSET_ID(), "token commits the etched id");
        // the helper exposes no mint/burn, and the token's mint is MINTER-only, so supply is frozen.
        vm.expectRevert();
        tok.mint(ALICE, 1); // caller != MINTER
    }

    function test_fixed_id_self_certifies() public {
        FixedSupplyMinter m = new FixedSupplyMinter(factory, ETCHER, SALT, "FIX", 18, bytes32(0), 1, ALICE);
        assertEq(m.ASSET_ID(), factory.deriveAssetId(ETCHER, SALT, "FIX", 18), "etch id is self-certifying");
    }

    // ── CappedMintMinter — the T_PETCH analog ──

    function test_capped_authority_mints_up_to_cap() public {
        CappedMintMinter m =
            new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 100e18, 0);
        CanonicalBridgedERC20 tok = m.TOKEN();
        vm.prank(AUTH);
        m.mint(ALICE, 60e18);
        assertEq(tok.balanceOf(ALICE), 60e18, "minted");
        assertEq(m.remaining(), 40e18, "headroom = cap - minted");
        vm.prank(AUTH);
        m.mint(ALICE, 40e18);
        assertEq(m.minted(), 100e18, "at the cap");
        vm.prank(AUTH);
        vm.expectRevert(CappedMintMinter.CapExceeded.selector);
        m.mint(ALICE, 1);
    }

    function test_capped_only_authority_mints() public {
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 0, 0);
        vm.expectRevert(CappedMintMinter.NotAuthority.selector);
        m.mint(ALICE, 1);
    }

    function test_capped_deadline_closes_mint() public {
        uint64 dl = uint64(block.timestamp + 1 days);
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 0, dl);
        vm.prank(AUTH);
        m.mint(ALICE, 1e18); // before deadline
        vm.warp(dl + 1);
        vm.prank(AUTH);
        vm.expectRevert(CappedMintMinter.MintClosed.selector);
        m.mint(ALICE, 1e18);
    }

    function test_capped_holder_burns_own_lifetime_cap_unchanged() public {
        CappedMintMinter m =
            new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 100e18, 0);
        CanonicalBridgedERC20 tok = m.TOKEN();
        vm.prank(AUTH);
        m.mint(ALICE, 50e18);
        vm.prank(ALICE);
        m.burn(20e18);
        assertEq(tok.balanceOf(ALICE), 30e18, "holder burned its own");
        assertEq(m.minted(), 50e18, "lifetime cap unaffected by a burn");
        assertEq(m.remaining(), 50e18, "headroom does not reopen on burn");
    }

    function test_capped_uncapped_is_unlimited() public {
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 0, 0);
        assertEq(m.remaining(), type(uint256).max, "uncapped headroom");
        vm.prank(AUTH);
        m.mint(ALICE, 1_000_000e18);
        assertEq(m.TOKEN().balanceOf(ALICE), 1_000_000e18, "mints freely when uncapped");
    }

    // ── Soundness: a mintable form can NEVER become a pool-backed (bridged) asset ──
    // A bridged Bitcoin-native asset's ERC20 must be backing-controlled (the pool/bridge is its sole
    // minter, minting only against proof). The pool refuses to register any token it does not itself
    // mint, so a free-mintable CappedMintMinter token can never be wrapped/bridged as a backed asset —
    // its supply could outrun the Bitcoin-side backing. (The helpers also only etch EVM-NATIVE ids, which
    // are disjoint from Bitcoin asset ids, so a helper can't even target a Bitcoin asset.)
    function test_mintable_minter_can_never_be_pool_backed() public {
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 0, 0);
        ConfidentialPool pool =
            new ConfidentialPool(address(0x5117), bytes32(uint256(1)), bytes32(0), address(0), address(0), bytes32(0), 6);
        address token = address(m.TOKEN()); // resolve before expectRevert (else it consumes this staticcall)
        vm.expectRevert(ConfidentialPool.PoolNotMinter.selector);
        pool.registerMinted(token, "x", "x", 18); // MINTER is the helper, not the pool
    }
}
