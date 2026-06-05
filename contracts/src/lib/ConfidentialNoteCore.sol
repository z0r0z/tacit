// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Secp256k1} from "./Secp256k1.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";

/// @title ConfidentialNoteCore
/// @notice Shared core for confidential tokens whose value is held as
///         denominated secp256k1 Pedersen notes (C = d·H + r·G) rather than
///         per-address balances. Provides the note store, the confidential
///         2-in/2-out transfer, and the proof primitives. Concrete tokens add
///         the supply side: a wrapper backs notes with an escrowed ERC20
///         (wrap/unwrap); an etched token backs them with authorized issuance
///         (mint/burn). Both keep the invariant `backing == Σ active note
///         denominations`.
///
///  Notes are denominated, so d·H is always one of the precomputed ladder
///  constants D_i and every check stays on the cheap ecrecover / ecAdd path in
///  Secp256k1 with no on-chain scalar multiplication.
abstract contract ConfidentialNoteCore is ReentrancyGuardTransient {
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant PP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 internal constant K = 8; // denomination ladder length

    uint256[K] internal _ladder; // denominations in base units
    uint256[K] internal _Dx;     // D_i = d_i·H (x), public constants
    uint256[K] internal _Dy;     // D_i = d_i·H (y)

    // note id = keccak256(cx, cy); status 0 = unknown, 1 = active, 2 = spent.
    mapping(bytes32 => uint8) public noteStatus;

    struct Transfer {
        uint256[2] cinx; uint256[2] ciny;
        uint256[2] coutx; uint256[2] couty;
        uint256[K] Ax0; uint256[K] Ay0; uint256[K] e0; uint256[K] z0;
        uint256[K] Ax1; uint256[K] Ay1; uint256[K] e1; uint256[K] z1;
        address kernelRAddr; uint256 kernelZ;
    }

    event Transferred(bytes32 indexed inId0, bytes32 indexed inId1, bytes32 outId0, bytes32 outId1);

    error BadDenomIdx();
    error NoteExists();
    error NoteNotActive();
    error BadProof();
    error BadConservation();
    error FreshOutputRequired();

    constructor(uint256[K] memory ladder_, uint256[K] memory Dx_, uint256[K] memory Dy_) {
        for (uint256 i; i < K; ++i) {
            require(ladder_[i] != 0 && Dx_[i] != 0, "bad ladder");
            _ladder[i] = ladder_[i]; _Dx[i] = Dx_[i]; _Dy[i] = Dy_[i];
        }
    }

    /// @notice Confidential 2-in/2-out transfer. Inputs are spent; outputs are
    ///         created with denomination-hiding OR-proofs; the kernel proves
    ///         Σin = Σout. Backing is unchanged.
    function transfer(Transfer calldata t) external nonReentrant {
        bytes32 in0 = _noteId(t.cinx[0], t.ciny[0]);
        bytes32 in1 = _noteId(t.cinx[1], t.ciny[1]);
        bytes32 out0 = _noteId(t.coutx[0], t.couty[0]);
        bytes32 out1 = _noteId(t.coutx[1], t.couty[1]);
        if (noteStatus[in0] != 1 || noteStatus[in1] != 1) revert NoteNotActive();
        if (noteStatus[out0] != 0 || noteStatus[out1] != 0 || out0 == out1) revert FreshOutputRequired();

        if (!_verifyOrProof(t.coutx[0], t.couty[0], t.Ax0, t.Ay0, t.e0, t.z0)) revert BadProof();
        if (!_verifyOrProof(t.coutx[1], t.couty[1], t.Ax1, t.Ay1, t.e1, t.z1)) revert BadProof();
        if (!_verifyKernel(t)) revert BadConservation();

        noteStatus[in0] = 2; noteStatus[in1] = 2;
        noteStatus[out0] = 1; noteStatus[out1] = 1;
        emit Transferred(in0, in1, out0, out1);
    }

    function ladder(uint256 i) external view returns (uint256) { return _ladder[i]; }
    function denomPoint(uint256 i) external view returns (uint256, uint256) { return (_Dx[i], _Dy[i]); }

    // ──────────────────── internals ────────────────────

    function _noteId(uint256 cx, uint256 cy) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(cx, cy));
    }

    /// Schnorr PoK that C − D_i is a multiple of G (blinding known, denom = d_i).
    function _verifyOpen(uint256 cx, uint256 cy, uint8 denomIdx, address to, address rAddr, uint256 z)
        internal view returns (bool)
    {
        (uint256 px, uint256 py) = Secp256k1.ecAdd(cx, cy, _Dx[denomIdx], PP - _Dy[denomIdx]);
        uint256 e = uint256(keccak256(abi.encodePacked(
            "tacit-evm-cnote-pok-v1", uint256(block.chainid), address(this), cx, cy, denomIdx, to, rAddr
        ))) % N;
        return Secp256k1.verifyLinear(px, uint8(py & 1), e, z, rAddr);
    }

    /// 1-of-8 CDS OR-proof that C opens to one of {d_i·H + r·G}.
    function _verifyOrProof(
        uint256 cx, uint256 cy,
        uint256[K] calldata Ax, uint256[K] calldata Ay, uint256[K] calldata e, uint256[K] calldata z
    ) internal view returns (bool) {
        bytes memory tr = abi.encodePacked(cx, cy);
        for (uint256 i; i < K; ++i) tr = abi.encodePacked(tr, Ax[i], Ay[i]);
        uint256 chal = uint256(keccak256(tr)) % N;

        uint256 sumE;
        for (uint256 i; i < K; ++i) {
            sumE = addmod(sumE, e[i], N);
            (uint256 mx, uint256 my) = Secp256k1.ecAdd(cx, cy, _Dx[i], PP - _Dy[i]);
            uint256 ne = e[i] == 0 ? 0 : N - e[i];
            if (Secp256k1.mulmuladd(mx, uint8(my & 1), z[i], ne) != Secp256k1.addrOf(Ax[i], Ay[i])) return false;
        }
        return sumE == chal;
    }

    /// Conservation: Σin − Σout == excess·G, by a kernel Schnorr bound to the notes.
    function _verifyKernel(Transfer calldata t) internal view returns (bool) {
        (uint256 x, uint256 y) = Secp256k1.ecAdd(t.cinx[0], t.ciny[0], t.cinx[1], t.ciny[1]);
        (x, y) = Secp256k1.ecAdd(x, y, t.coutx[0], PP - t.couty[0]);
        (x, y) = Secp256k1.ecAdd(x, y, t.coutx[1], PP - t.couty[1]);
        uint256 e = uint256(keccak256(abi.encodePacked(
            "tacit-evm-cnote-kernel-v1", address(this),
            t.cinx[0], t.ciny[0], t.cinx[1], t.ciny[1],
            t.coutx[0], t.couty[0], t.coutx[1], t.couty[1],
            t.kernelRAddr
        ))) % N;
        return Secp256k1.verifyLinear(x, uint8(y & 1), e, t.kernelZ, t.kernelRAddr);
    }
}
