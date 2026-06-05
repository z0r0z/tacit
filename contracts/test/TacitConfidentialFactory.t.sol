// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacitConfidentialFactory} from "../src/TacitConfidentialFactory.sol";
import {TacitConfidentialEtched} from "../src/TacitConfidentialEtched.sol";

/// Deployment mechanics for the etch factory — asset_id derivation, CREATE2
/// determinism, duplicate guard, and authority vs fair-launch wiring. The note
/// crypto itself is exercised in TacitConfidentialEtched.t.sol.
contract TacitConfidentialFactoryTest is Test {
    TacitConfidentialFactory factory;
    uint256[8] ladder;
    uint256[8] Dx;
    uint256[8] Dy;

    function setUp() public {
        vm.chainId(1);
        factory = new TacitConfidentialFactory();
        // A self-consistent ladder is unnecessary for deployment mechanics; the
        // constructor only requires nonzero ladder/Dx entries.
        for (uint256 i; i < 8; ++i) { ladder[i] = (i + 1) * 10; Dx[i] = i + 1; Dy[i] = i + 7; }
    }

    function test_etch_authority_mode() public {
        uint256[4] memory noPetch;
        bytes32 salt = keccak256("token-A");
        (address token, bytes32 assetId) = factory.etch(address(0xA11CE), ladder, Dx, Dy, noPetch, salt, "ipfs://meta");

        bytes32 expectedId = sha256(abi.encodePacked(
            "tacit-evm-etch-v1", uint64(uint256(1)), address(factory), salt, address(this)
        ));
        assertEq(assetId, expectedId, "asset_id derivation");
        assertEq(factory.tokenOf(assetId), token, "registry");

        TacitConfidentialEtched t = TacitConfidentialEtched(token);
        assertEq(t.ASSET_ID(), assetId, "token asset_id");
        assertEq(t.MINT_AUTHORITY(), address(0xA11CE), "mint authority");
        assertEq(t.ladder(2), 30, "ladder wired");
    }

    function test_predictAddress_matches() public {
        uint256[4] memory noPetch;
        bytes32 salt = keccak256("token-B");
        address predicted = factory.predictAddress(address(0xA11CE), ladder, Dx, Dy, noPetch, salt, address(this));
        (address token,) = factory.etch(address(0xA11CE), ladder, Dx, Dy, noPetch, salt, "ipfs://meta");
        assertEq(token, predicted, "CREATE2 prediction");
    }

    function test_duplicate_etch_reverts() public {
        uint256[4] memory noPetch;
        bytes32 salt = keccak256("token-C");
        factory.etch(address(0xA11CE), ladder, Dx, Dy, noPetch, salt, "ipfs://meta");
        vm.expectRevert(TacitConfidentialFactory.AlreadyEtched.selector);
        factory.etch(address(0xA11CE), ladder, Dx, Dy, noPetch, salt, "ipfs://meta");
    }

    function test_same_salt_different_etcher_distinct() public {
        uint256[4] memory noPetch;
        bytes32 salt = keccak256("token-D");
        (address t1,) = factory.etch(address(0xA11CE), ladder, Dx, Dy, noPetch, salt, "m");
        vm.prank(address(0xB0B));
        (address t2,) = factory.etch(address(0xA11CE), ladder, Dx, Dy, noPetch, salt, "m");
        assertTrue(t1 != t2, "etcher is part of asset_id + salt namespace");
    }

    function test_etch_fairlaunch_mode() public {
        uint256[4] memory petch = [uint256(2), uint256(1000), uint256(1), uint256(100)]; // denom idx 2, cap 1000, blocks 1..100
        bytes32 salt = keccak256("petch-A");
        (address token,) = factory.etch(address(0), ladder, Dx, Dy, petch, salt, "ipfs://fair");

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
}
