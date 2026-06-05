// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Secp256k1} from "./lib/Secp256k1.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title TacitConfidentialERC20
/// @notice A confidential wrapper for an ERC20: value is held as denominated
///         secp256k1 Pedersen notes (C = d·H + r·G), not per-address balances.
///         Amounts are blinded; only the wrap/unwrap boundary is public.
///
///  Lifecycle:
///    wrap(d_i)        public deposit of d_i underlying → a note committing to
///                     d_i with a Schnorr PoK of the blinding
///    transfer         2-in/2-out: input notes spent, output notes created with
///                     1-of-8 OR-proofs (denomination hidden) and a conservation
///                     kernel (Σin = Σout) — no escrow change
///    unwrap(d_i)      prove a note opens to d_i, burn it, release d_i underlying
///
///  Notes are denominated, so d·H is always one of the precomputed ladder
///  constants D_i — every check reduces to the cheap ecrecover / ecAdd
///  primitives in Secp256k1 with no on-chain scalar multiplication.
///
///  Custody invariant (structural): escrow == Σ active note denominations. wrap
///  adds a note and its denomination; transfer conserves (kernel + OR-proofs);
///  unwrap removes both. No inflation: every output is a positive ladder
///  denomination and the kernel balances the hidden sums.
contract TacitConfidentialERC20 is ReentrancyGuardTransient {
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant PP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 internal constant K = 8; // denomination ladder length

    address public immutable UNDERLYING;
    bytes32 public immutable ASSET_ID;
    uint256 public escrow;

    uint256[K] internal _ladder; // denominations in underlying base units
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

    event Wrap(bytes32 indexed noteId, uint8 denomIdx);
    event Transferred(bytes32 indexed inId0, bytes32 indexed inId1, bytes32 outId0, bytes32 outId1);
    event Unwrap(bytes32 indexed noteId, address indexed to, uint8 denomIdx);

    error BadDenomIdx();
    error NoteExists();
    error NoteNotActive();
    error BadProof();
    error BadConservation();
    error FreshOutputRequired();

    constructor(address underlying_, uint256[K] memory ladder_, uint256[K] memory Dx_, uint256[K] memory Dy_) {
        require(underlying_ != address(0));
        UNDERLYING = underlying_;
        ASSET_ID = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), underlying_));
        for (uint256 i; i < K; ++i) {
            require(ladder_[i] != 0 && Dx_[i] != 0, "bad ladder");
            _ladder[i] = ladder_[i]; _Dx[i] = Dx_[i]; _Dy[i] = Dy_[i];
        }
    }

    // ──────────────────── wrap ────────────────────

    /// @notice Deposit d_i underlying and create a note committing to d_i.
    ///         (cx, cy) is the Pedersen commitment; (rAddr, z) is a Schnorr PoK
    ///         that the note's blinding is known and its denomination is d_i.
    function wrap(uint8 denomIdx, uint256 cx, uint256 cy, address rAddr, uint256 z) external nonReentrant {
        if (denomIdx >= K) revert BadDenomIdx();
        bytes32 id = _noteId(cx, cy);
        if (noteStatus[id] != 0) revert NoteExists();
        if (!_verifyOpen(cx, cy, denomIdx, address(0), rAddr, z)) revert BadProof();

        noteStatus[id] = 1;
        escrow += _ladder[denomIdx];
        SafeTransferLib.safeTransferFrom(UNDERLYING, msg.sender, address(this), _ladder[denomIdx]);
        emit Wrap(id, denomIdx);
    }

    // ──────────────────── transfer ────────────────────

    /// @notice Confidential 2-in/2-out transfer. Inputs are spent; outputs are
    ///         created with denomination-hiding OR-proofs; the kernel proves
    ///         Σin = Σout. Escrow is unchanged.
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

    // ──────────────────── unwrap ────────────────────

    /// @notice Prove a note opens to d_i, burn it, release d_i underlying to `to`.
    function unwrap(uint8 denomIdx, uint256 cx, uint256 cy, address to, address rAddr, uint256 z) external nonReentrant {
        if (denomIdx >= K) revert BadDenomIdx();
        if (to == address(0)) revert BadProof();
        bytes32 id = _noteId(cx, cy);
        if (noteStatus[id] != 1) revert NoteNotActive();
        if (!_verifyOpen(cx, cy, denomIdx, to, rAddr, z)) revert BadProof();

        noteStatus[id] = 2;
        escrow -= _ladder[denomIdx];
        SafeTransferLib.safeTransfer(UNDERLYING, to, _ladder[denomIdx]);
        emit Unwrap(id, to, denomIdx);
    }

    // ──────────────────── views ────────────────────

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
