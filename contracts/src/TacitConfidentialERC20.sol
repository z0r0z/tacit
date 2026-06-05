// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ConfidentialNoteCore} from "./lib/ConfidentialNoteCore.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title TacitConfidentialERC20
/// @notice A confidential wrapper for an existing ERC20: value is held as
///         denominated secp256k1 Pedersen notes, not per-address balances.
///         Amounts are blinded; only the wrap/unwrap boundary is public.
///
///  wrap(d_i)   public deposit of d_i underlying → a note committing to d_i
///              with a Schnorr PoK of the blinding
///  transfer    confidential 2-in/2-out (inherited from ConfidentialNoteCore)
///  unwrap(d_i) prove a note opens to d_i, burn it, release d_i underlying
///
///  Custody invariant (structural): escrow == Σ active note denominations.
contract TacitConfidentialERC20 is ConfidentialNoteCore {
    address public immutable UNDERLYING;
    bytes32 public immutable ASSET_ID;
    uint256 public escrow;

    event Wrap(bytes32 indexed noteId, uint8 denomIdx);
    event Unwrap(bytes32 indexed noteId, address indexed to, uint8 denomIdx);

    constructor(address underlying_, uint256[K] memory ladder_, uint256[K] memory Dx_, uint256[K] memory Dy_)
        ConfidentialNoteCore(ladder_, Dx_, Dy_)
    {
        require(underlying_ != address(0));
        UNDERLYING = underlying_;
        ASSET_ID = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), underlying_));
    }

    /// @notice Deposit d_i underlying and create a note committing to d_i.
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
}
