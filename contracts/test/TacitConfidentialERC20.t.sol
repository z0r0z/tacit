// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacitConfidentialERC20} from "../src/TacitConfidentialERC20.sol";
import {ConfidentialNoteCore} from "../src/lib/ConfidentialNoteCore.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract MockERC20 is ERC20 {
    function name() public pure override returns (string memory) { return "Mock"; }
    function symbol() public pure override returns (string memory) { return "MCK"; }
    function decimals() public pure override returns (uint8) { return 18; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// Full confidential-token lifecycle against real noble proofs: wrap 100 +
/// wrap 10 -> a 2-in/2-out confidential transfer (denominations hidden by
/// OR-proofs, conservation by a kernel) -> unwrap one output (100). Bound to a
/// deterministic contract address so the challenge recomputes match.
/// Fixture: tests/gen-confidential-erc20-fixture.mjs.
contract TacitConfidentialERC20Test is Test {
    address constant DEPLOYER = 0x00000000000000000000000000000000DeaDBeef;

    MockERC20 token;
    TacitConfidentialERC20 t20;
    string json;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/confidential_erc20.json"));
        vm.chainId(vm.parseJsonUint(json, ".chainId"));

        token = new MockERC20();
        token.mint(address(this), 1000);

        address predicted = vm.computeCreateAddress(DEPLOYER, 0);
        require(predicted == vm.parseJsonAddress(json, ".contract"), "deployer/nonce drift");

        uint256[8] memory ladder = _u8(".ladder");
        uint256[8] memory Dx = _u8(".Dx");
        uint256[8] memory Dy = _u8(".Dy");
        vm.prank(DEPLOYER);
        t20 = new TacitConfidentialERC20(address(token), ladder, Dx, Dy);
        require(address(t20) == predicted, "wrapper address");

        token.approve(address(t20), type(uint256).max);
    }

    function test_lifecycle_wrap_transfer_unwrap() public {
        // ── wrap two notes ──
        _wrap(".wrap[0]");
        _wrap(".wrap[1]");
        assertEq(t20.escrow(), 110, "escrow after wraps");
        assertEq(token.balanceOf(address(t20)), 110, "underlying held");

        bytes32 in0 = _id(".transfer.cinx", ".transfer.ciny", 0);
        bytes32 in1 = _id(".transfer.cinx", ".transfer.ciny", 1);
        assertEq(t20.noteStatus(in0), 1, "in0 active");
        assertEq(t20.noteStatus(in1), 1, "in1 active");

        // ── confidential transfer ──
        t20.transfer(_loadTransfer());
        bytes32 out0 = _id(".transfer.coutx", ".transfer.couty", 0);
        bytes32 out1 = _id(".transfer.coutx", ".transfer.couty", 1);
        assertEq(t20.noteStatus(in0), 2, "in0 spent");
        assertEq(t20.noteStatus(in1), 2, "in1 spent");
        assertEq(t20.noteStatus(out0), 1, "out0 active");
        assertEq(t20.noteStatus(out1), 1, "out1 active");
        assertEq(t20.escrow(), 110, "escrow unchanged by transfer");

        // ── unwrap output 0 (denom 100) ──
        address to = vm.parseJsonAddress(json, ".unwrap.to");
        _unwrap(".unwrap");
        assertEq(token.balanceOf(to), 100, "recipient received underlying");
        assertEq(t20.escrow(), 10, "escrow after unwrap");
        assertEq(t20.noteStatus(out0), 2, "unwrapped note spent");
    }

    function test_wrap_bad_pok_reverts() public {
        uint8 d = uint8(vm.parseJsonUint(json, ".wrap[0].denomIdx"));
        uint256 cx = vm.parseJsonUint(json, ".wrap[0].x");
        uint256 cy = vm.parseJsonUint(json, ".wrap[0].y");
        address rAddr = vm.parseJsonAddress(json, ".wrap[0].rAddr");
        uint256 z = vm.parseJsonUint(json, ".wrap[0].z");
        vm.expectRevert(ConfidentialNoteCore.BadProof.selector);
        t20.wrap(d, cx, cy, rAddr, z + 1); // tampered response
    }

    function test_transfer_tampered_orproof_reverts() public {
        _wrap(".wrap[0]"); _wrap(".wrap[1]");
        TacitConfidentialERC20.Transfer memory t = _loadTransfer();
        t.z0[2] = t.z0[2] ^ 1; // flip an OR-proof branch response
        vm.expectRevert(ConfidentialNoteCore.BadProof.selector);
        t20.transfer(t);
    }

    function test_transfer_tampered_kernel_reverts() public {
        _wrap(".wrap[0]"); _wrap(".wrap[1]");
        TacitConfidentialERC20.Transfer memory t = _loadTransfer();
        t.kernelZ = t.kernelZ ^ 1;
        vm.expectRevert(ConfidentialNoteCore.BadConservation.selector);
        t20.transfer(t);
    }

    function test_double_spend_input_reverts() public {
        _wrap(".wrap[0]"); _wrap(".wrap[1]");
        t20.transfer(_loadTransfer());
        vm.expectRevert(ConfidentialNoteCore.NoteNotActive.selector);
        t20.transfer(_loadTransfer()); // inputs already spent
    }

    function test_unwrap_unknown_note_reverts() public {
        uint8 d = uint8(vm.parseJsonUint(json, ".unwrap.denomIdx"));
        uint256 cx = vm.parseJsonUint(json, ".unwrap.x");
        uint256 cy = vm.parseJsonUint(json, ".unwrap.y");
        address to = vm.parseJsonAddress(json, ".unwrap.to");
        address rAddr = vm.parseJsonAddress(json, ".unwrap.rAddr");
        uint256 z = vm.parseJsonUint(json, ".unwrap.z");
        vm.expectRevert(ConfidentialNoteCore.NoteNotActive.selector); // never wrapped/transferred
        t20.unwrap(d, cx, cy, to, rAddr, z);
    }

    function test_attest_discloses_denomination() public {
        _wrap(".wrap[0]"); // Cin0 active (denom 100)
        (uint8 d, uint256 cx, uint256 cy, address r, uint256 z) = _attestArgs();
        address attester = vm.parseJsonAddress(json, ".attest.attester");
        bytes32 id = keccak256(abi.encodePacked(cx, cy));
        vm.expectEmit(true, true, false, true, address(t20));
        emit ConfidentialNoteCore.Attested(attester, id, d);
        vm.prank(attester);
        t20.attest(d, cx, cy, r, z);
    }

    function test_attest_wrong_caller_reverts() public {
        _wrap(".wrap[0]");
        (uint8 d, uint256 cx, uint256 cy, address r, uint256 z) = _attestArgs();
        vm.prank(address(0xBAD)); // PoK binds msg.sender → mismatched caller fails
        vm.expectRevert(ConfidentialNoteCore.BadProof.selector);
        t20.attest(d, cx, cy, r, z);
    }

    function _attestArgs() internal view returns (uint8 d, uint256 cx, uint256 cy, address r, uint256 z) {
        d = uint8(vm.parseJsonUint(json, ".attest.denomIdx"));
        cx = vm.parseJsonUint(json, ".attest.x");
        cy = vm.parseJsonUint(json, ".attest.y");
        r = vm.parseJsonAddress(json, ".attest.rAddr");
        z = vm.parseJsonUint(json, ".attest.z");
    }

    function test_gas_lifecycle() public {
        // Pre-parse every argument so the measured regions are pure contract calls
        // (vm.parseJson cheatcodes otherwise dominate the delta).
        uint8 wd0 = uint8(vm.parseJsonUint(json, ".wrap[0].denomIdx"));
        uint256 wx0 = vm.parseJsonUint(json, ".wrap[0].x");
        uint256 wy0 = vm.parseJsonUint(json, ".wrap[0].y");
        address wr0 = vm.parseJsonAddress(json, ".wrap[0].rAddr");
        uint256 wz0 = vm.parseJsonUint(json, ".wrap[0].z");
        TacitConfidentialERC20.Transfer memory t = _loadTransfer();
        uint8 ud = uint8(vm.parseJsonUint(json, ".unwrap.denomIdx"));
        uint256 ux = vm.parseJsonUint(json, ".unwrap.x");
        uint256 uy = vm.parseJsonUint(json, ".unwrap.y");
        address uto = vm.parseJsonAddress(json, ".unwrap.to");
        address ur = vm.parseJsonAddress(json, ".unwrap.rAddr");
        uint256 uz = vm.parseJsonUint(json, ".unwrap.z");

        uint256 g = gasleft(); t20.wrap(wd0, wx0, wy0, wr0, wz0); emit log_named_uint("gas: wrap", g - gasleft());
        _wrap(".wrap[1]");
        g = gasleft(); t20.transfer(t); emit log_named_uint("gas: confidential transfer (2-in/2-out)", g - gasleft());
        g = gasleft(); t20.unwrap(ud, ux, uy, uto, ur, uz); emit log_named_uint("gas: unwrap", g - gasleft());
    }

    // ──────────────────── helpers ────────────────────

    function _wrap(string memory base) internal {
        t20.wrap(
            uint8(vm.parseJsonUint(json, string.concat(base, ".denomIdx"))),
            vm.parseJsonUint(json, string.concat(base, ".x")),
            vm.parseJsonUint(json, string.concat(base, ".y")),
            vm.parseJsonAddress(json, string.concat(base, ".rAddr")),
            vm.parseJsonUint(json, string.concat(base, ".z"))
        );
    }

    function _unwrap(string memory base) internal {
        t20.unwrap(
            uint8(vm.parseJsonUint(json, string.concat(base, ".denomIdx"))),
            vm.parseJsonUint(json, string.concat(base, ".x")),
            vm.parseJsonUint(json, string.concat(base, ".y")),
            vm.parseJsonAddress(json, string.concat(base, ".to")),
            vm.parseJsonAddress(json, string.concat(base, ".rAddr")),
            vm.parseJsonUint(json, string.concat(base, ".z"))
        );
    }

    function _loadTransfer() internal view returns (TacitConfidentialERC20.Transfer memory t) {
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
