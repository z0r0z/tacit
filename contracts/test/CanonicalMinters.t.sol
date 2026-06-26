// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, stdError} from "forge-std/Test.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";
import {CanonicalMinter, FixedSupplyMinter, CappedMintMinter} from "../src/CanonicalMinters.sol";

/// A factory whose `tokenOf` resolves a token this minter does NOT control — to exercise the
/// CanonicalMinter constructor's AdoptedTokenMismatch defense-in-depth (a wrong/compromised factory).
/// Selectors match CanonicalAssetFactory's 5-arg `deriveAssetId`/`tokenOf`, the only two it calls when
/// `tokenOf` returns non-zero.
contract MockBadFactory {
    address public immutable BAD_TOKEN;

    constructor(address badToken) {
        BAD_TOKEN = badToken;
    }

    function deriveAssetId(address, bytes32, string calldata, uint8, bytes32) external pure returns (bytes32) {
        return keccak256("bad-asset");
    }

    function tokenOf(bytes32, address, string calldata, uint8, bytes32) external view returns (address) {
        return BAD_TOKEN;
    }
}

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
        FixedSupplyMinter m = new FixedSupplyMinter(factory, ETCHER, SALT, "FIX", 18, bytes32(0), 1_000e18, ALICE);
        CanonicalBridgedERC20 tok = m.TOKEN();
        assertEq(tok.totalSupply(), 1_000e18, "minted total");
        assertEq(tok.balanceOf(ALICE), 1_000e18, "to recipient");
        assertEq(tok.MINTER(), address(m), "the helper is the sole MINTER");
        assertEq(tok.ASSET_ID(), m.ASSET_ID(), "token commits the etched id");
        // the helper exposes no mint/burn, and the token's mint is MINTER-only, so supply is frozen.
        vm.expectRevert();
        tok.mint(ALICE, 1); // caller != MINTER
    }

    function test_fixed_rejects_zero_recipient() public {
        vm.expectRevert(FixedSupplyMinter.InvalidRecipient.selector);
        new FixedSupplyMinter(factory, ETCHER, SALT, "FIX", 18, bytes32(0), 1_000e18, address(0));
    }

    /// Minting the WHOLE supply to the minter itself would strand it forever (no transfer/burn). The
    /// constructor rejects `recipient == address(this)` — the minter's address is predictable (CREATE), so
    /// this is a reachable footgun, guarded the same way as the zero address.
    function test_fixed_rejects_minter_as_recipient() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(FixedSupplyMinter.InvalidRecipient.selector);
        new FixedSupplyMinter(factory, ETCHER, SALT, "FIX", 18, bytes32(0), 1_000e18, predicted);
    }

    function test_fixed_adopts_predeployed_token() public {
        // Someone deploys the canonical token for our exact (id, minter, meta) slot first,
        // naming the minter's predicted address. The minter must adopt it, not revert.
        bytes32 assetId = factory.deriveAssetId(ETCHER, SALT, "FIX", 18);
        address predictedMinter = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address pre = factory.deployCanonical(assetId, predictedMinter, "FIX", 18);

        FixedSupplyMinter m = new FixedSupplyMinter(factory, ETCHER, SALT, "FIX", 18, bytes32(0), 1_000e18, ALICE);
        assertEq(address(m), predictedMinter, "minter landed at the predicted address");
        assertEq(address(m.TOKEN()), pre, "adopted the pre-deployed token");
        assertEq(m.TOKEN().MINTER(), address(m), "adopted token is minter-bound");
        assertEq(m.TOKEN().balanceOf(ALICE), 1_000e18, "minted into the adopted token");
    }

    function test_fixed_id_self_certifies() public {
        FixedSupplyMinter m = new FixedSupplyMinter(factory, ETCHER, SALT, "FIX", 18, bytes32(0), 1, ALICE);
        assertEq(m.ASSET_ID(), factory.deriveAssetId(ETCHER, SALT, "FIX", 18), "etch id is self-certifying");
    }

    // ── CappedMintMinter — the T_PETCH analog ──

    function test_capped_authority_mints_up_to_cap() public {
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 100e18, 0);
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

    function test_capped_rejects_zero_recipient() public {
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 0, 0);
        vm.prank(AUTH);
        vm.expectRevert(CappedMintMinter.InvalidRecipient.selector);
        m.mint(address(0), 1e18);
    }

    /// Minting to the minter itself strands those tokens (no transfer/burn) — rejected alongside address(0).
    function test_capped_rejects_minter_as_recipient() public {
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 0, 0);
        vm.prank(AUTH);
        vm.expectRevert(CappedMintMinter.InvalidRecipient.selector);
        m.mint(address(m), 1e18);
    }

    function test_capped_rejects_token_as_recipient() public {
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 0, 0);
        address token = address(m.TOKEN());
        vm.prank(AUTH);
        vm.expectRevert(CanonicalBridgedERC20.InvalidRecipient.selector);
        m.mint(token, 1e18);
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
        vm.warp(dl);
        vm.prank(AUTH);
        m.mint(ALICE, 1e18); // exactly at deadline is still open
        vm.warp(dl + 1);
        vm.prank(AUTH);
        vm.expectRevert(CappedMintMinter.MintClosed.selector);
        m.mint(ALICE, 1e18);
    }

    function test_capped_holder_burns_own_lifetime_cap_unchanged() public {
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 100e18, 0);
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

    /// The lifetime `minted` accumulator can never silently wrap: an uncapped minter that has
    /// already minted the full uint256 range reverts (checked arithmetic) rather than rolling
    /// `minted` back to a small value and re-opening phantom headroom — supply can't be inflated
    /// past the type ceiling. (Solady's _mint independently guards total-supply overflow too.)
    function test_capped_mint_overflow_reverts() public {
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 0, 0);
        vm.prank(AUTH);
        m.mint(ALICE, type(uint256).max);
        assertEq(m.minted(), type(uint256).max, "lifetime minted saturated at the type ceiling");
        vm.prank(AUTH);
        vm.expectRevert(stdError.arithmeticError); // minted + amount overflows the accumulator
        m.mint(ALICE, 1);
    }

    /// The Ethereum-side mint authority is deliberately OPEN (any address the deployer picks). A
    /// zero authority is ACCEPTED — not rejected — and simply yields an inert, non-mintable token:
    /// fail-closed (no usable key satisfies `msg.sender == address(0)`), no inflation surface, and
    /// recoverable (a real-authority deploy lands at a different minter/token address). We assert
    /// the non-guard on purpose so it is not "helpfully" clamped later, removing that flexibility.
    function test_capped_zero_authority_is_inert_not_reverting() public {
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), address(0), 0, 0);
        assertEq(m.MINT_AUTHORITY(), address(0), "zero authority accepted (open-minter design)");
        vm.prank(ALICE);
        vm.expectRevert(CappedMintMinter.NotAuthority.selector);
        m.mint(ALICE, 1e18);
    }

    // ── Soundness: a mintable form can NEVER become a pool-backed (bridged) asset ──
    // A bridged Bitcoin-native asset's ERC20 must be backing-controlled (the pool/bridge is its sole
    // minter, minting only against proof). The pool refuses to register any token it does not itself
    // mint, so a free-mintable CappedMintMinter token can never be wrapped/bridged as a backed asset —
    // its supply could outrun the Bitcoin-side backing. (The helpers also only etch EVM-NATIVE ids, which
    // are disjoint from Bitcoin asset ids, so a helper can't even target a Bitcoin asset.)
    function test_mintable_minter_can_never_be_pool_backed() public {
        CappedMintMinter m = new CappedMintMinter(factory, ETCHER, SALT, "CAP", 18, bytes32(0), AUTH, 0, 0);
        ConfidentialPool pool = new ConfidentialPool(
            address(0x5117),
            bytes32(uint256(1)),
            bytes32(0),
            address(0),
            address(0),
            bytes32(0),
            6,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        address token = address(m.TOKEN()); // resolve before expectRevert (else it consumes this staticcall)
        vm.expectRevert(ConfidentialPool.PoolNotMinter.selector);
        pool.registerMinted(token, "x", "x", 18); // MINTER is the helper, not the pool
    }

    // ── Defense-in-depth: reject a token a wrong/compromised factory resolves but this minter can't drive ──

    /// The factory is a trusted immutable, but the constructor still verifies the resolved token is THIS
    /// minter's. A factory whose `tokenOf` returns a foreign token (here, MINTER == 0xBAD) makes the deploy
    /// revert AdoptedTokenMismatch rather than silently adopting an uncontrollable token.
    function test_adopted_token_mismatch_reverts() public {
        // a real canonical token whose MINTER is some OTHER address, not the minter we deploy next
        address badToken = factory.deployCanonical(keccak256("bad"), address(0xBAD), "FIX", 18, bytes32(0));
        MockBadFactory bad = new MockBadFactory(badToken);
        vm.expectRevert(CanonicalMinter.AdoptedTokenMismatch.selector);
        new FixedSupplyMinter(CanonicalAssetFactory(address(bad)), ETCHER, SALT, "FIX", 18, bytes32(0), 1e18, ALICE);
    }
}
