// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Secp256k1} from "../src/lib/Secp256k1.sol";

/// External surface for the secp256k1 primitives so forge measures real call
/// gas. Mirrors the Tier-A confidential-token verification: a 1-of-8 CDS
/// OR-proof per output note (the denomination membership proof) plus a
/// conservation kernel (Mimblewimble-style excess Schnorr).
contract Secp256k1Probe {
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant PP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    function mulmuladd(uint256 px, uint8 par, uint256 a, uint256 b) external pure returns (address) {
        return Secp256k1.mulmuladd(px, par, a, b);
    }

    function ecAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2) external view returns (uint256, uint256) {
        return Secp256k1.ecAdd(x1, y1, x2, y2);
    }

    function verifyLinear(uint256 px, uint8 par, uint256 e, uint256 z, address rAddr) external pure returns (bool) {
        return Secp256k1.verifyLinear(px, par, e, z, rAddr);
    }

    /// 1-of-8 CDS OR-proof: C opens to one of {d_i·H + r·G}. Recompute the
    /// Fiat-Shamir challenge, sum branch challenges, check every branch.
    function verifyOrProof(
        uint256 cx, uint256 cy,
        uint256[8] calldata Dx, uint256[8] calldata Dy,
        uint256[8] calldata Ax, uint256[8] calldata Ay,
        uint256[8] calldata e, uint256[8] calldata z
    ) public view returns (bool) {
        bytes memory t = abi.encodePacked(cx, cy);
        for (uint256 i; i < 8; ++i) t = abi.encodePacked(t, Ax[i], Ay[i]);
        uint256 chal = uint256(keccak256(t)) % N;

        uint256 sumE;
        for (uint256 i; i < 8; ++i) {
            sumE = addmod(sumE, e[i], N);
            (uint256 mx, uint256 my) = Secp256k1.ecAdd(cx, cy, Dx[i], PP - Dy[i]); // C − d_i·H
            uint256 ne = e[i] == 0 ? 0 : N - e[i];
            if (Secp256k1.mulmuladd(mx, uint8(my & 1), z[i], ne) != Secp256k1.addrOf(Ax[i], Ay[i])) return false;
        }
        return sumE == chal;
    }

    /// Conservation kernel for a 2-in-2-out transfer: Σin − Σout == excess·G,
    /// verified by a Schnorr over the excess. (fee == 0 here.)
    function verifyKernel(
        uint256[2] calldata cinx, uint256[2] calldata ciny,
        uint256[2] calldata coutx, uint256[2] calldata couty,
        uint256 e, uint256 z, address rAddr
    ) public view returns (bool) {
        (uint256 x, uint256 y) = Secp256k1.ecAdd(cinx[0], ciny[0], cinx[1], ciny[1]);
        (x, y) = Secp256k1.ecAdd(x, y, coutx[0], PP - couty[0]);
        (x, y) = Secp256k1.ecAdd(x, y, coutx[1], PP - couty[1]);
        return Secp256k1.verifyLinear(x, uint8(y & 1), e, z, rAddr);
    }

}

contract Secp256k1ProbeTest is Test {
    Secp256k1Probe probe;
    string json;

    function setUp() public {
        probe = new Secp256k1Probe();
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/secp_probe.json"));
    }

    // ──────────────────── correctness vs noble ────────────────────

    function test_mulmuladd_matches_noble() public view {
        for (uint256 i; i < 3; ++i) {
            string memory b = string.concat(".mulmuladd[", vm.toString(i), "]");
            uint256 px = vm.parseJsonUint(json, string.concat(b, ".px"));
            uint8 par = uint8(vm.parseJsonUint(json, string.concat(b, ".pyParity")));
            uint256 a = vm.parseJsonUint(json, string.concat(b, ".a"));
            uint256 bb = vm.parseJsonUint(json, string.concat(b, ".b"));
            address exp = vm.parseJsonAddress(json, string.concat(b, ".expected"));
            assertEq(probe.mulmuladd(px, par, a, bb), exp, "mulmuladd != noble");
        }
    }

    function test_ecAdd_matches_noble() public view {
        for (uint256 i; i < 2; ++i) {
            string memory b = string.concat(".ecAdd[", vm.toString(i), "]");
            (uint256 x, uint256 y) = probe.ecAdd(
                vm.parseJsonUint(json, string.concat(b, ".p1x")), vm.parseJsonUint(json, string.concat(b, ".p1y")),
                vm.parseJsonUint(json, string.concat(b, ".p2x")), vm.parseJsonUint(json, string.concat(b, ".p2y"))
            );
            assertEq(x, vm.parseJsonUint(json, string.concat(b, ".sx")), "ecAdd x");
            assertEq(y, vm.parseJsonUint(json, string.concat(b, ".sy")), "ecAdd y");
        }
    }

    function test_schnorr_verifies_and_rejects() public view {
        uint256 px = vm.parseJsonUint(json, ".schnorr.px");
        uint8 par = uint8(vm.parseJsonUint(json, ".schnorr.pyParity"));
        uint256 e = vm.parseJsonUint(json, ".schnorr.e");
        uint256 z = vm.parseJsonUint(json, ".schnorr.z");
        address r = vm.parseJsonAddress(json, ".schnorr.rAddr");
        assertTrue(probe.verifyLinear(px, par, e, z, r), "valid schnorr rejected");
        assertFalse(probe.verifyLinear(px, par, e, z + 1, r), "tampered z accepted");
    }

    function test_orProof_verifies() public view {
        (uint256 cx, uint256 cy, uint256[8] memory Dx, uint256[8] memory Dy,
         uint256[8] memory Ax, uint256[8] memory Ay, uint256[8] memory e, uint256[8] memory z) = _loadOr(".orproof");
        assertTrue(probe.verifyOrProof(cx, cy, Dx, Dy, Ax, Ay, e, z), "valid OR-proof rejected");
    }

    function test_orProof_rejects_tampered_response() public view {
        (uint256 cx, uint256 cy, uint256[8] memory Dx, uint256[8] memory Dy,
         uint256[8] memory Ax, uint256[8] memory Ay, uint256[8] memory e, uint256[8] memory z) = _loadOr(".orproofBad");
        z[2] = z[2] ^ 1; // flip one branch response
        assertFalse(probe.verifyOrProof(cx, cy, Dx, Dy, Ax, Ay, e, z), "tampered OR-proof accepted");
    }

    function test_orProof_rejects_wrong_challenge_split() public view {
        (uint256 cx, uint256 cy, uint256[8] memory Dx, uint256[8] memory Dy,
         uint256[8] memory Ax, uint256[8] memory Ay, uint256[8] memory e, uint256[8] memory z) = _loadOr(".orproof");
        e[0] = e[0] ^ 1; // Σ e_i no longer equals the recomputed challenge
        assertFalse(probe.verifyOrProof(cx, cy, Dx, Dy, Ax, Ay, e, z), "bad challenge split accepted");
    }

    function test_conservation_kernel_verifies() public view {
        (uint256[2] memory cinx, uint256[2] memory ciny, uint256[2] memory coutx, uint256[2] memory couty) = _loadCons();
        uint256 e = vm.parseJsonUint(json, ".conservation.kernelE");
        uint256 z = vm.parseJsonUint(json, ".conservation.kernelZ");
        address r = vm.parseJsonAddress(json, ".conservation.kernelRAddr");
        assertTrue(probe.verifyKernel(cinx, ciny, coutx, couty, e, z, r), "valid kernel rejected");
        assertFalse(probe.verifyKernel(cinx, ciny, coutx, couty, e, z + 1, r), "tampered kernel accepted");
    }

    // ──────────────────── gas probe ────────────────────

    function test_gas_report() public {
        // mulmuladd (one ecrecover)
        uint256 px = vm.parseJsonUint(json, ".mulmuladd[0].px");
        uint8 par = uint8(vm.parseJsonUint(json, ".mulmuladd[0].pyParity"));
        uint256 a = vm.parseJsonUint(json, ".mulmuladd[0].a");
        uint256 b = vm.parseJsonUint(json, ".mulmuladd[0].b");
        uint256 g = gasleft(); probe.mulmuladd(px, par, a, b); _log("mulmuladd (1 ecrecover)", g - gasleft());

        // ecAdd (one modexp inverse)
        string memory ea = ".ecAdd[0]";
        uint256 x1 = vm.parseJsonUint(json, string.concat(ea, ".p1x")); uint256 y1 = vm.parseJsonUint(json, string.concat(ea, ".p1y"));
        uint256 x2 = vm.parseJsonUint(json, string.concat(ea, ".p2x")); uint256 y2 = vm.parseJsonUint(json, string.concat(ea, ".p2y"));
        g = gasleft(); probe.ecAdd(x1, y1, x2, y2); _log("ecAdd (1 modexp inv)", g - gasleft());

        // Schnorr verify
        {
            uint256 spx = vm.parseJsonUint(json, ".schnorr.px"); uint8 spar = uint8(vm.parseJsonUint(json, ".schnorr.pyParity"));
            uint256 se = vm.parseJsonUint(json, ".schnorr.e"); uint256 sz = vm.parseJsonUint(json, ".schnorr.z");
            address sr = vm.parseJsonAddress(json, ".schnorr.rAddr");
            g = gasleft(); probe.verifyLinear(spx, spar, se, sz, sr); _log("schnorr verify", g - gasleft());
        }

        // 1-of-8 OR-proof (per output note)
        uint256 orGas;
        {
            (uint256 cx, uint256 cy, uint256[8] memory Dx, uint256[8] memory Dy,
             uint256[8] memory Ax, uint256[8] memory Ay, uint256[8] memory e, uint256[8] memory z) = _loadOr(".orproof");
            g = gasleft(); probe.verifyOrProof(cx, cy, Dx, Dy, Ax, Ay, e, z); orGas = g - gasleft();
            _log("OR-proof 1-of-8 (per output)", orGas);
        }

        // conservation kernel
        uint256 kGas;
        {
            (uint256[2] memory cinx, uint256[2] memory ciny, uint256[2] memory coutx, uint256[2] memory couty) = _loadCons();
            uint256 ke = vm.parseJsonUint(json, ".conservation.kernelE"); uint256 kz = vm.parseJsonUint(json, ".conservation.kernelZ");
            address kr = vm.parseJsonAddress(json, ".conservation.kernelRAddr");
            g = gasleft(); probe.verifyKernel(cinx, ciny, coutx, couty, ke, kz, kr); kGas = g - gasleft();
            _log("conservation kernel", kGas);
        }

        emit log_named_uint("==> 2-in-2-out transfer (2 OR + kernel) approx", 2 * orGas + kGas);
    }

    function _log(string memory name, uint256 g) internal {
        emit log_named_uint(string.concat("gas: ", name), g);
    }

    // ──────────────────── fixture loaders ────────────────────

    function _loadOr(string memory base) internal view returns (
        uint256 cx, uint256 cy,
        uint256[8] memory Dx, uint256[8] memory Dy,
        uint256[8] memory Ax, uint256[8] memory Ay,
        uint256[8] memory e, uint256[8] memory z
    ) {
        cx = vm.parseJsonUint(json, string.concat(base, ".cx"));
        cy = vm.parseJsonUint(json, string.concat(base, ".cy"));
        Dx = _u8(string.concat(base, ".Dx")); Dy = _u8(string.concat(base, ".Dy"));
        Ax = _u8(string.concat(base, ".Ax")); Ay = _u8(string.concat(base, ".Ay"));
        e = _u8(string.concat(base, ".e")); z = _u8(string.concat(base, ".z"));
    }

    function _loadCons() internal view returns (
        uint256[2] memory cinx, uint256[2] memory ciny, uint256[2] memory coutx, uint256[2] memory couty
    ) {
        cinx = _u2(".conservation.cinx"); ciny = _u2(".conservation.ciny");
        coutx = _u2(".conservation.coutx"); couty = _u2(".conservation.couty");
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
