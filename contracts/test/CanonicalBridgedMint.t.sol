// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";

/// A minimal stand-in for the bridge/pool backing authority: it deploys the canonical ERC20 for an
/// externally-derived (Bitcoin-side) asset id with ITSELF as the token's sole MINTER, then mints/burns
/// against that authority. This is the same deploy-or-adopt + mint path the ConfidentialPool runs when it
/// materializes a bridged Tacit asset's public face (deployCanonical(assetId, address(this), …) → token.mint),
/// reduced to the on-chain authority so it is checkable without the SP1 settle.
contract MockBridgeMinter {
    CanonicalAssetFactory public immutable FACTORY;

    constructor(CanonicalAssetFactory factory) {
        FACTORY = factory;
    }

    /// Materialize the canonical ERC20 for a bridged asset id (deploy-or-adopt, tokenOf-first like the pool).
    function ensureToken(bytes32 assetId, string calldata symbol_, uint8 decimals_, bytes32 cid)
        external
        returns (address token)
    {
        token = FACTORY.tokenOf(assetId, address(this), symbol_, decimals_, cid);
        if (token == address(0)) token = FACTORY.deployCanonical(assetId, address(this), symbol_, decimals_, cid);
    }

    /// Release backing on the Ethereum side (the bridge_mint leg) — authority-gated by the token's MINTER.
    function bridgeMint(address token, address to, uint256 amount) external {
        CanonicalBridgedERC20(token).mint(to, amount);
    }

    /// Burn on redemption (the unwrap leg).
    function bridgeBurn(address token, address from, uint256 amount) external {
        CanonicalBridgedERC20(token).burn(from, amount);
    }
}

/// End-to-end mint authority for a BRIDGED Tacit asset turned into its public/canonical ERC20: the bridge is
/// the token's sole MINTER, mints land supply at the recipient, and every non-authority caller (an EOA, the
/// factory, an unrelated contract) is rejected. The asset id is externally derived (a Bitcoin-side etch id),
/// the deployCanonical path — distinct from the self-certifying EVM-etch helpers.
contract CanonicalBridgedMintTest is Test {
    CanonicalAssetFactory factory;
    MockBridgeMinter bridge;

    address constant USER = address(0xA11CE);
    address constant OUTSIDER = address(0xBAD);
    // an externally-derived id (a Bitcoin etch / wrapped asset), NOT a self-certifying EVM-etch derivation
    bytes32 constant BRIDGED_ASSET = keccak256("bitcoin-etch:TAC");

    function setUp() public {
        factory = new CanonicalAssetFactory();
        bridge = new MockBridgeMinter(factory);
    }

    function _token() internal returns (CanonicalBridgedERC20 tok) {
        tok = CanonicalBridgedERC20(bridge.ensureToken(BRIDGED_ASSET, "TAC", 8, bytes32(0)));
    }

    /// The canonical ERC20 for a bridged asset is deployed at the predicted address with the bridge as its
    /// immutable sole MINTER, carrying the bridged id and the proven metadata.
    function test_bridge_deploys_canonical_at_predicted_with_itself_as_minter() public {
        address predicted = factory.predict(BRIDGED_ASSET, address(bridge), "TAC", 8);
        CanonicalBridgedERC20 tok = _token();
        assertEq(address(tok), predicted, "deployed at the predicted canonical address");
        assertEq(tok.MINTER(), address(bridge), "the bridge is the sole mint authority");
        assertEq(tok.ASSET_ID(), BRIDGED_ASSET, "token carries the bridged asset id");
        assertEq(tok.symbol(), "TAC", "proven ticker");
        assertEq(tok.decimals(), 8, "proven decimals");
        assertEq(tok.totalSupply(), 0, "no supply before a mint");
    }

    /// The mint authority E2E: a bridge_mint lands supply at the recipient and grows totalSupply; a redeem
    /// burn reduces both. Supply moves only through the bridge authority.
    function test_bridge_mints_canonical_from_bridged_asset() public {
        CanonicalBridgedERC20 tok = _token();

        bridge.bridgeMint(address(tok), USER, 7e8);
        assertEq(tok.balanceOf(USER), 7e8, "minted to the recipient");
        assertEq(tok.totalSupply(), 7e8, "supply == minted");

        bridge.bridgeMint(address(tok), USER, 3e8);
        assertEq(tok.balanceOf(USER), 10e8, "a second mint accrues");
        assertEq(tok.totalSupply(), 10e8, "supply tracks total minted");

        bridge.bridgeBurn(address(tok), USER, 4e8);
        assertEq(tok.balanceOf(USER), 6e8, "redeem burn reduces the holder balance");
        assertEq(tok.totalSupply(), 6e8, "supply reduced on redeem");
    }

    /// Idempotent materialization: a second ensureToken adopts the already-deployed token (tokenOf-first), so
    /// the bridge mints against the same address forever — a re-touch can't fork the canonical token.
    function test_ensure_token_is_idempotent() public {
        CanonicalBridgedERC20 first = _token();
        CanonicalBridgedERC20 again = _token();
        assertEq(address(first), address(again), "re-materialize resolves the same token");
        bridge.bridgeMint(address(again), USER, 1e8);
        assertEq(again.balanceOf(USER), 1e8, "mints against the adopted token");
    }

    /// No caller other than the bridge can mint: an EOA, the factory, and an unrelated minter contract are all
    /// rejected — the authority is the token's immutable MINTER, not a transferable role.
    function test_only_bridge_authority_can_mint() public {
        CanonicalBridgedERC20 tok = _token();

        // an EOA calling the token directly
        vm.prank(OUTSIDER);
        vm.expectRevert(CanonicalBridgedERC20.NotMinter.selector);
        tok.mint(USER, 1e8);

        // the factory is not the minter
        vm.prank(address(factory));
        vm.expectRevert(CanonicalBridgedERC20.NotMinter.selector);
        tok.mint(USER, 1e8);

        // a DIFFERENT bridge instance (same factory, same asset id) is not THIS token's authority — its own
        // canonical token lands at a different address.
        MockBridgeMinter other = new MockBridgeMinter(factory);
        vm.expectRevert(CanonicalBridgedERC20.NotMinter.selector);
        other.bridgeMint(address(tok), USER, 1e8);
        assertTrue(
            address(tok) != other.ensureToken(BRIDGED_ASSET, "TAC", 8, bytes32(0)),
            "a different authority gets a different canonical token"
        );

        assertEq(tok.totalSupply(), 0, "no unauthorized mint changed supply");
    }

    /// Burning is authority-gated on the same MINTER, so no outsider can burn a holder's balance.
    function test_only_bridge_authority_can_burn() public {
        CanonicalBridgedERC20 tok = _token();
        bridge.bridgeMint(address(tok), USER, 5e8);

        vm.prank(OUTSIDER);
        vm.expectRevert(CanonicalBridgedERC20.NotMinter.selector);
        tok.burn(USER, 1e8);
        assertEq(tok.balanceOf(USER), 5e8, "an outsider cannot burn a holder's balance");
    }

    /// The bridge authority cannot mint into the zero address or the token itself (stranded/void supply) —
    /// the token guards both even for its real minter.
    function test_bridge_mint_rejects_void_recipients() public {
        CanonicalBridgedERC20 tok = _token();

        vm.expectRevert(CanonicalBridgedERC20.InvalidRecipient.selector);
        bridge.bridgeMint(address(tok), address(0), 1e8);

        vm.expectRevert(CanonicalBridgedERC20.InvalidRecipient.selector);
        bridge.bridgeMint(address(tok), address(tok), 1e8);

        assertEq(tok.totalSupply(), 0, "no supply minted to a void recipient");
    }
}
