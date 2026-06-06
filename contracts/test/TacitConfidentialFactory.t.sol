// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacitConfidentialFactory} from "../src/TacitConfidentialFactory.sol";
import {TacitConfidentialEtched} from "../src/TacitConfidentialEtched.sol";

/// Deployment mechanics for the etch factory — asset_id derivation, CREATE2
/// determinism, duplicate guard, on-chain metadata, and authority vs fair-launch
/// wiring. The note crypto itself is exercised in TacitConfidentialEtched.t.sol.
/// The denomination ladder is protocol-wide and baked into the token.
contract TacitConfidentialFactoryTest is Test {
    TacitConfidentialFactory factory;

    function setUp() public {
        vm.chainId(1);
        factory = new TacitConfidentialFactory();
    }

    function _meta() internal pure returns (TacitConfidentialFactory.Meta memory) {
        return TacitConfidentialFactory.Meta({name: "Alpha", symbol: "ALPHA", decimals: 8, uri: "ipfs://meta"});
    }

    function test_etch_authority_mode() public {
        bytes32 salt = keccak256("token-A");
        (address token, bytes32 assetId) = factory.etchAuthority(address(0xA11CE), _meta(), salt);

        bytes32 expectedId = sha256(abi.encodePacked(
            "tacit-evm-etch-v1", uint64(uint256(1)), address(factory), salt, address(this)
        ));
        assertEq(assetId, expectedId, "asset_id derivation");
        assertEq(factory.tokenOf(assetId), token, "registry");

        TacitConfidentialEtched t = TacitConfidentialEtched(token);
        assertEq(t.ASSET_ID(), assetId, "token asset_id");
        assertEq(t.MINT_AUTHORITY(), address(0xA11CE), "mint authority");
        assertEq(t.ladder(2), 100, "ladder is the baked-in d_i = 10**i");
        assertEq(t.name(), "Alpha", "on-chain name");
        assertEq(t.symbol(), "ALPHA", "on-chain symbol");
        assertEq(t.decimals(), 8, "on-chain decimals");
    }

    function test_etchAuthority_zero_reverts() public {
        vm.expectRevert(TacitConfidentialFactory.ZeroAuthority.selector);
        factory.etchAuthority(address(0), _meta(), keccak256("z"));
    }

    function test_predictAuthority_matches() public {
        bytes32 salt = keccak256("token-B");
        address predicted = factory.predictAuthority(address(0xA11CE), _meta(), salt, address(this));
        (address token,) = factory.etchAuthority(address(0xA11CE), _meta(), salt);
        assertEq(token, predicted, "CREATE2 prediction");
    }

    function test_duplicate_etch_reverts() public {
        bytes32 salt = keccak256("token-C");
        factory.etchAuthority(address(0xA11CE), _meta(), salt);
        vm.expectRevert(TacitConfidentialFactory.AlreadyEtched.selector);
        factory.etchAuthority(address(0xA11CE), _meta(), salt);
    }

    function test_same_salt_different_etcher_distinct() public {
        bytes32 salt = keccak256("token-D");
        (address t1,) = factory.etchAuthority(address(0xA11CE), _meta(), salt);
        vm.prank(address(0xB0B));
        (address t2,) = factory.etchAuthority(address(0xA11CE), _meta(), salt);
        assertTrue(t1 != t2, "etcher is part of asset_id + salt namespace");
    }

    function test_etch_fairlaunch_mode() public {
        TacitConfidentialEtched.Petch memory petch =
            TacitConfidentialEtched.Petch({denomIdx: 2, cap: 1000, startBlock: 1, endBlock: 100});
        bytes32 salt = keccak256("petch-A");
        (address token,) = factory.etchFairLaunch(petch, _meta(), salt);

        TacitConfidentialEtched t = TacitConfidentialEtched(token);
        assertEq(t.MINT_AUTHORITY(), address(0), "fair launch");
        assertEq(t.PETCH_DENOM(), 2, "petch denom");
        assertEq(t.PETCH_CAP(), 1000, "petch cap");

        // Petch gating runs before the PoK: wrong denom and out-of-window are
        // rejected without needing a valid proof.
        vm.roll(50);
        vm.expectRevert(TacitConfidentialEtched.PetchDenom.selector);
        t.mint(3, 1, 1, address(1), 1);
        vm.roll(200);
        vm.expectRevert(TacitConfidentialEtched.PetchWindow.selector);
        t.mint(2, 1, 1, address(1), 1);
    }

    function test_predictFairLaunch_matches() public {
        TacitConfidentialEtched.Petch memory petch =
            TacitConfidentialEtched.Petch({denomIdx: 2, cap: 1000, startBlock: 1, endBlock: 100});
        bytes32 salt = keccak256("petch-B");
        address predicted = factory.predictFairLaunch(petch, _meta(), salt, address(this));
        (address token,) = factory.etchFairLaunch(petch, _meta(), salt);
        assertEq(token, predicted, "fair-launch CREATE2 prediction");
    }
}
