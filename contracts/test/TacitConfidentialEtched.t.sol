// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacitConfidentialEtched} from "../src/TacitConfidentialEtched.sol";
import {ConfidentialNoteCore} from "../src/lib/ConfidentialNoteCore.sol";

/// Etched-token supply lifecycle against real noble proofs (same primitives as
/// the wrapper, so the same fixture drives it): mint 100 + mint 10 -> a
/// confidential transfer -> burn one output (100). Deployed at the deterministic
/// fixture address so the challenge recomputes match.
/// Fixture: tests/gen-confidential-erc20-fixture.mjs.
contract TacitConfidentialEtchedTest is Test {
    address constant DEPLOYER = 0x00000000000000000000000000000000DeaDBeef;

    TacitConfidentialEtched tok;
    string json;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/confidential_erc20.json"));
        vm.chainId(vm.parseJsonUint(json, ".chainId"));

        address predicted = vm.computeCreateAddress(DEPLOYER, 0);
        require(predicted == vm.parseJsonAddress(json, ".contract"), "deployer/nonce drift");

        TacitConfidentialEtched.Petch memory noPetch;
        vm.prank(DEPLOYER);
        // mintAuthority = this test contract, so it can mint.
        tok = new TacitConfidentialEtched(bytes32(uint256(0xA55E7)), address(this), noPetch, "Etched", "ETCH", 8);
        require(address(tok) == predicted, "token address");
    }

    function test_authority_nonzero_petch_reverts() public {
        TacitConfidentialEtched.Petch memory bad;
        bad.endBlock = 1; // any nonzero field in authority mode is rejected
        vm.expectRevert(bytes("petch in authority mode"));
        new TacitConfidentialEtched(bytes32(uint256(1)), address(this), bad, "X", "X", 8);
    }

    function test_onchain_metadata() public view {
        assertEq(tok.name(), "Etched", "name");
        assertEq(tok.symbol(), "ETCH", "symbol");
        assertEq(tok.decimals(), 8, "decimals");
    }

    function test_lifecycle_mint_transfer_burn() public {
        _mint(".wrap[0]");
        _mint(".wrap[1]");
        assertEq(tok.supply(), 110, "supply after mints");

        tok.transfer(_loadTransfer());
        bytes32 out0 = _id(".transfer.coutx", ".transfer.couty", 0);
        assertEq(tok.noteStatus(out0), 1, "out0 active");

        _burn(".etchedBurn");
        assertEq(tok.supply(), 10, "supply after burn");
        assertEq(tok.noteStatus(out0), 2, "burned note spent");
    }

    function test_mint_only_authority() public {
        (uint8 d, uint256 cx, uint256 cy, address r, uint256 z) = _args(".wrap[0]");
        vm.prank(address(0xBEEF));
        vm.expectRevert(TacitConfidentialEtched.NotAuthority.selector);
        tok.mint(d, cx, cy, r, z);
    }

    function test_renounce_closes_mint() public {
        tok.renounceMint();
        (uint8 d, uint256 cx, uint256 cy, address r, uint256 z) = _args(".wrap[0]");
        vm.expectRevert(TacitConfidentialEtched.MintClosed.selector);
        tok.mint(d, cx, cy, r, z);
    }

    function test_mint_bad_pok_reverts() public {
        (uint8 d, uint256 cx, uint256 cy, address r, uint256 z) = _args(".wrap[0]");
        vm.expectRevert(ConfidentialNoteCore.BadProof.selector);
        tok.mint(d, cx, cy, r, z + 1);
    }

    function test_burn_unknown_reverts() public {
        (uint8 d, uint256 cx, uint256 cy, address r, uint256 z) = _args(".etchedBurn");
        vm.expectRevert(ConfidentialNoteCore.NoteNotActive.selector);
        tok.burn(d, cx, cy, r, z);
    }

    function test_double_mint_reverts() public {
        _mint(".wrap[0]");
        (uint8 d, uint256 cx, uint256 cy, address r, uint256 z) = _args(".wrap[0]");
        vm.expectRevert(ConfidentialNoteCore.NoteExists.selector);
        tok.mint(d, cx, cy, r, z);
    }

    // ──────────────────── helpers ────────────────────

    function _args(string memory base) internal view returns (uint8 d, uint256 cx, uint256 cy, address r, uint256 z) {
        d = uint8(vm.parseJsonUint(json, string.concat(base, ".denomIdx")));
        cx = vm.parseJsonUint(json, string.concat(base, ".x"));
        cy = vm.parseJsonUint(json, string.concat(base, ".y"));
        r = vm.parseJsonAddress(json, string.concat(base, ".rAddr"));
        z = vm.parseJsonUint(json, string.concat(base, ".z"));
    }

    function _mint(string memory base) internal {
        (uint8 d, uint256 cx, uint256 cy, address r, uint256 z) = _args(base);
        tok.mint(d, cx, cy, r, z);
    }

    function _burn(string memory base) internal {
        (uint8 d, uint256 cx, uint256 cy, address r, uint256 z) = _args(base);
        tok.burn(d, cx, cy, r, z);
    }

    function _loadTransfer() internal view returns (TacitConfidentialEtched.Transfer memory t) {
        t.cinx = _u2(".transfer.cinx"); t.ciny = _u2(".transfer.ciny");
        t.coutx = _u2(".transfer.coutx"); t.couty = _u2(".transfer.couty");
        t.Ax0 = _u8(".transfer.or0.Ax"); t.Ay0 = _u8(".transfer.or0.Ay");
        t.e0 = _u8(".transfer.or0.e"); t.z0 = _u8(".transfer.or0.z");
        t.Ax1 = _u8(".transfer.or1.Ax"); t.Ay1 = _u8(".transfer.or1.Ay");
        t.e1 = _u8(".transfer.or1.e"); t.z1 = _u8(".transfer.or1.z");
        t.kernelRAddr = vm.parseJsonAddress(json, ".transfer.kernelRAddr");
        t.kernelZ = vm.parseJsonUint(json, ".transfer.kernelZ");
    }

    function _id(string memory xk, string memory yk, uint256 i) internal view returns (bytes32) {
        uint256[] memory xs = vm.parseJsonUintArray(json, xk);
        uint256[] memory ys = vm.parseJsonUintArray(json, yk);
        return keccak256(abi.encodePacked(xs[i], ys[i]));
    }

    function _u8(string memory key) internal view returns (uint256[8] memory out) {
        uint256[] memory a = vm.parseJsonUintArray(json, key);
        for (uint256 i; i < 8; ++i) out[i] = a[i];
    }

    function _u2(string memory key) internal view returns (uint256[2] memory out) {
        uint256[] memory a = vm.parseJsonUintArray(json, key);
        out[0] = a[0]; out[1] = a[1];
    }
}
