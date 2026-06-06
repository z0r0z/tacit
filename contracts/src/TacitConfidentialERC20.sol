// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ConfidentialNoteCore} from "./lib/ConfidentialNoteCore.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title TacitConfidentialERC20
/// @notice A confidential wrapper for an existing ERC20: value is held as
///         denominated secp256k1 Pedersen notes, not per-address balances.
///         Amounts are blinded; only the wrap/unwrap boundary is public.
///
///  wrap(d_i)   public deposit of d_i·UNIT_SCALE underlying → a note committing
///              to d_i with a Schnorr PoK of the blinding
///  transfer    confidential 2-in/2-out (inherited from ConfidentialNoteCore)
///  unwrap(d_i) prove a note opens to d_i, burn it, release d_i·UNIT_SCALE underlying
///
///  `UNIT_SCALE` aligns the protocol-wide ladder (d_i = 10**i) to the
///  underlying's decimals, so the same fixed denomination points back tokens of
///  any precision. Custody invariant (structural): escrow == Σ active note
///  denominations · UNIT_SCALE.
contract TacitConfidentialERC20 is ConfidentialNoteCore {
    address public immutable UNDERLYING;
    bytes32 public immutable ASSET_ID;
    uint256 public immutable UNIT_SCALE;
    uint256 public escrow;

    event Wrap(bytes32 indexed noteId, uint8 denomIdx);
    event Unwrap(bytes32 indexed noteId, address indexed to, uint8 denomIdx);

    constructor(address underlying_, uint256 unitScale_, string memory name_, string memory symbol_, uint8 decimals_)
        ConfidentialNoteCore(name_, symbol_, decimals_)
    {
        require(underlying_ != address(0) && unitScale_ != 0);
        UNDERLYING = underlying_;
        UNIT_SCALE = unitScale_;
        ASSET_ID = sha256(abi.encodePacked("tacit-evm-token-v1", uint64(block.chainid), underlying_));
    }

    /// @notice Deposit d_i·UNIT_SCALE underlying and create a note committing to d_i.
    function wrap(uint8 denomIdx, uint256 cx, uint256 cy, address rAddr, uint256 z) external nonReentrant {
        if (denomIdx >= K) revert BadDenomIdx();
        bytes32 id = _noteId(cx, cy);
        if (noteStatus[id] != 0) revert NoteExists();
        if (!_verifyOpen(cx, cy, denomIdx, address(0), rAddr, z)) revert BadProof();

        uint256 amount = _denom(denomIdx) * UNIT_SCALE;
        noteStatus[id] = 1;
        escrow += amount;
        SafeTransferLib.safeTransferFrom(UNDERLYING, msg.sender, address(this), amount);
        emit Wrap(id, denomIdx);
    }

    /// @notice Prove a note opens to d_i, burn it, release d_i·UNIT_SCALE underlying to `to`.
    function unwrap(uint8 denomIdx, uint256 cx, uint256 cy, address to, address rAddr, uint256 z) external nonReentrant {
        if (denomIdx >= K) revert BadDenomIdx();
        if (to == address(0)) revert BadProof();
        bytes32 id = _noteId(cx, cy);
        if (noteStatus[id] != 1) revert NoteNotActive();
        if (!_verifyOpen(cx, cy, denomIdx, to, rAddr, z)) revert BadProof();

        uint256 amount = _denom(denomIdx) * UNIT_SCALE;
        noteStatus[id] = 2;
        escrow -= amount;
        SafeTransferLib.safeTransfer(UNDERLYING, to, amount);
        emit Unwrap(id, to, denomIdx);
    }
}
