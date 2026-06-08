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
///  The denomination ladder is protocol-wide and fixed: d_i = 10**i and the
///  precomputed points D_i = d_i·H are baked in as pure lookups, so every check
///  stays on the cheap ecrecover / ecAdd path with no on-chain scalar
///  multiplication and no per-token constants to trust. The points are publicly
///  verifiable as d_i·H against the canonical NUMS H ("tacit-generator-H-v1");
///  reproduce them with `denomPoints()` in dapp/evm-confidential.js.
abstract contract ConfidentialNoteCore is ReentrancyGuardTransient {
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant PP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 internal constant K = 8; // denomination ladder length

    // note id = keccak256(cx, cy); status 0 = unknown, 1 = active, 2 = spent.
    mapping(bytes32 => uint8) public noteStatus;

    // On-chain asset identity — queryable with no indexer or off-chain fetch.
    // Not an ERC20 (value is in notes; no balanceOf), only the metadata triple.
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    struct Transfer {
        uint256[2] cinx; uint256[2] ciny;
        uint256[2] coutx; uint256[2] couty;
        uint256[K] Ax0; uint256[K] Ay0; uint256[K] e0; uint256[K] z0;
        uint256[K] Ax1; uint256[K] Ay1; uint256[K] e1; uint256[K] z1;
        address kernelRAddr; uint256 kernelZ;
    }

    event Transferred(bytes32 indexed inId0, bytes32 indexed inId1, bytes32 outId0, bytes32 outId1);
    event Attested(address indexed attester, bytes32 indexed noteId, uint8 denomIdx);

    error BadDenomIdx();
    error NoteExists();
    error NoteNotActive();
    error BadProof();
    error BadConservation();
    error FreshOutputRequired();
    error DuplicateInput();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
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
        // Inputs must be two distinct notes — a repeated input is summed on both sides,
        // so the kernel's Σin = Σout would relate one note to two outputs.
        if (in0 == in1) revert DuplicateInput();
        if (noteStatus[out0] != 0 || noteStatus[out1] != 0 || out0 == out1) revert FreshOutputRequired();

        if (!_verifyOrProof(t.coutx[0], t.couty[0], t.Ax0, t.Ay0, t.e0, t.z0)) revert BadProof();
        if (!_verifyOrProof(t.coutx[1], t.couty[1], t.Ax1, t.Ay1, t.e1, t.z1)) revert BadProof();
        if (!_verifyKernel(t)) revert BadConservation();

        noteStatus[in0] = 2; noteStatus[in1] = 2;
        noteStatus[out0] = 1; noteStatus[out1] = 1;
        emit Transferred(in0, in1, out0, out1);
    }

    /// @notice Anchor a selective balance disclosure: prove the caller controls
    ///         an active note opening to d_i (so holds at least `_denom(i)`),
    ///         emitting an event a consumer contract can gate on. The PoK binds
    ///         msg.sender, so the attestation is caller-specific and not replayable.
    function attest(uint8 denomIdx, uint256 cx, uint256 cy, address rAddr, uint256 z) external {
        if (denomIdx >= K) revert BadDenomIdx();
        bytes32 id = _noteId(cx, cy);
        if (noteStatus[id] != 1) revert NoteNotActive();
        if (!_verifyOpen(cx, cy, denomIdx, msg.sender, rAddr, z)) revert BadProof();
        emit Attested(msg.sender, id, denomIdx);
    }

    function ladder(uint256 i) external pure returns (uint256) { return _denom(i); }
    function denomPoint(uint256 i) external pure returns (uint256, uint256) { return _denomPoint(i); }

    // ──────────────────── internals ────────────────────

    function _noteId(uint256 cx, uint256 cy) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(cx, cy));
    }

    /// Denomination d_i = 10**i in base units.
    function _denom(uint256 i) internal pure returns (uint256) {
        if (i >= K) revert BadDenomIdx();
        return 10 ** i;
    }

    /// Precomputed D_i = d_i·H, the canonical ladder points (NUMS H,
    /// "tacit-generator-H-v1"). Baked in so there are no per-token constants to
    /// trust and no on-chain scalar multiplication.
    function _denomPoint(uint256 i) internal pure returns (uint256 dx, uint256 dy) {
        if (i == 0) return (0xbd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56,
                            0x6776ec702f7b57d8025f6693e8be345123065de0bd0313d1cf2abdb13ba68b2c);
        if (i == 1) return (0x355f893f5a261193cc69b265b9947b27f13227928e9a7ab7063ab064f9157ff1,
                            0xb213596cbd8829f24234f500fee922209f5d034cc6d0f0e7e50cf9cc033e800a);
        if (i == 2) return (0x46b5a717589c1fcd1fb149c4e52489a796342b804b73f424c8f31487041fc615,
                            0xce3ac583fe33b42c946c585cc6b084624ba8bdfbaa18a266380b4c5f16d36e9b);
        if (i == 3) return (0x0c965e28a96a03c9da868492b448d786f4a8623633c6929aa97c8e9f077b3227,
                            0x2b23499a0462f930565657fe339969652774e4287f4b73cb37b8a3129ac1d413);
        if (i == 4) return (0xa267d260b0e1efe1bb9812b600a2c0338f98144901c951568dc92a8311d58f07,
                            0x8cd1f8632b4b24118ad50001f9d8e9a7bf201dde97d6b63222486e80d667747b);
        if (i == 5) return (0x5c7957dfb2ef15fc4cff5964b70d900bc2d40abaa6888e0bb1b9fda03f0d217d,
                            0x06403d59529faa55b4df2a43381fc68da6886e70d1f9fd2d6224ef9399fcac0a);
        if (i == 6) return (0x32fe1697783bcd8218f8447787adc055b5ba5e04d76788215a4c5a546fb833cd,
                            0x174cf37aab71decdbb6ec2d57d4e0f579b3a22819b6e338e645abc1f15b57027);
        if (i == 7) return (0xf562792f672d8ef81d3a457f8368e469c43e795e4706603d113624fa1d9409c4,
                            0x30e90eb247961c1736eee0c5484b305b40a12ca64bb5226f234909718d4e7f3f);
        revert BadDenomIdx();
    }

    /// Schnorr PoK that C − D_i is a multiple of G (blinding known, denom = d_i).
    function _verifyOpen(uint256 cx, uint256 cy, uint8 denomIdx, address to, address rAddr, uint256 z)
        internal view returns (bool)
    {
        (uint256 dxi, uint256 dyi) = _denomPoint(denomIdx);
        (uint256 px, uint256 py) = Secp256k1.ecAdd(cx, cy, dxi, PP - dyi);
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
        bytes memory tr = abi.encodePacked("tacit-evm-cnote-or-v1", uint256(block.chainid), address(this), cx, cy);
        for (uint256 i; i < K; ++i) tr = abi.encodePacked(tr, Ax[i], Ay[i]);
        uint256 chal = uint256(keccak256(tr)) % N;

        uint256 sumE;
        for (uint256 i; i < K; ++i) {
            sumE = addmod(sumE, e[i], N);
            (uint256 dxi, uint256 dyi) = _denomPoint(i);
            (uint256 mx, uint256 my) = Secp256k1.ecAdd(cx, cy, dxi, PP - dyi);
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
