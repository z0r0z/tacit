// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ConfidentialNoteCore} from "./lib/ConfidentialNoteCore.sol";

/// @title TacitConfidentialEtched
/// @notice An etched confidential token: supply is issued as denominated
///         secp256k1 Pedersen notes, with no backing underlying. Two issuance
///         modes, fixed at construction:
///
///         - **authority** (`mintAuthority != 0`) — only that address mints,
///           any denomination, anytime; it can `renounceMint()` to make supply
///           permanently fixed.
///         - **fair-launch / petch** (`mintAuthority == 0`) — anyone mints
///           exactly the petch denomination, inside `[start, end]` blocks, up to
///           `cap`. Gas is the rate limiter, mirroring T_PMINT.
///
///  transfer is the inherited confidential 2-in/2-out. `burn` proves a note
///  opens to its denomination and retires it. Invariant: `supply == Σ active
///  note denominations` (mint adds both, burn removes both, transfer conserves).
contract TacitConfidentialEtched is ConfidentialNoteCore {
    /// Fair-launch parameters (mintAuthority == 0): anyone mints exactly
    /// `denomIdx` inside `[startBlock, endBlock]` up to `cap`.
    struct Petch {
        uint8 denomIdx;
        uint256 cap;
        uint256 startBlock;
        uint256 endBlock;
    }

    bytes32 public immutable ASSET_ID;
    address public immutable MINT_AUTHORITY; // 0 ⇒ fair-launch (petch)
    uint8 public immutable PETCH_DENOM;
    uint256 public immutable PETCH_CAP;
    uint256 public immutable PETCH_START;
    uint256 public immutable PETCH_END;

    uint256 public supply;
    bool public mintRenounced;

    event Mint(bytes32 indexed noteId, uint8 denomIdx);
    event Burn(bytes32 indexed noteId, uint8 denomIdx);
    event MintRenounced();

    error NotAuthority();
    error MintClosed();
    error PetchWindow();
    error PetchDenom();
    error PetchCap();

    /// @param petch used only when mintAuthority == 0 (fair-launch). In
    ///        authority mode it must be zero — it is unused there, so a nonzero
    ///        value would only perturb the CREATE2 address.
    constructor(
        bytes32 assetId_,
        address mintAuthority_,
        Petch memory petch,
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ConfidentialNoteCore(name_, symbol_, decimals_) {
        ASSET_ID = assetId_;
        MINT_AUTHORITY = mintAuthority_;
        if (mintAuthority_ == address(0)) {
            require(petch.denomIdx < K && petch.cap != 0 && petch.endBlock >= petch.startBlock, "bad petch");
            PETCH_DENOM = petch.denomIdx;
            PETCH_CAP = petch.cap;
            PETCH_START = petch.startBlock;
            PETCH_END = petch.endBlock;
        } else {
            require(
                petch.denomIdx == 0 && petch.cap == 0 && petch.startBlock == 0 && petch.endBlock == 0,
                "petch in authority mode"
            );
        }
    }

    /// @notice Issue a note committing to d_i (PoK of the blinding). In authority
    ///         mode only MINT_AUTHORITY may call; in petch mode anyone may, under
    ///         the fixed denom / window / cap.
    function mint(uint8 denomIdx, uint256 cx, uint256 cy, address rAddr, uint256 z) external nonReentrant {
        if (denomIdx >= K) revert BadDenomIdx();
        if (MINT_AUTHORITY != address(0)) {
            if (msg.sender != MINT_AUTHORITY) revert NotAuthority();
            if (mintRenounced) revert MintClosed();
        } else {
            if (denomIdx != PETCH_DENOM) revert PetchDenom();
            if (block.number < PETCH_START || block.number > PETCH_END) revert PetchWindow();
            if (supply + _denom(denomIdx) > PETCH_CAP) revert PetchCap();
        }
        bytes32 id = _noteId(cx, cy);
        if (noteStatus[id] != 0) revert NoteExists();
        if (!_verifyOpen(cx, cy, denomIdx, address(0), rAddr, z)) revert BadProof();

        noteStatus[id] = 1;
        supply += _denom(denomIdx);
        emit Mint(id, denomIdx);
    }

    /// @notice Permanently close authority minting (makes supply fixed).
    function renounceMint() external {
        if (msg.sender != MINT_AUTHORITY) revert NotAuthority();
        mintRenounced = true;
        emit MintRenounced();
    }

    /// @notice Prove a note opens to d_i and retire it; supply decreases.
    function burn(uint8 denomIdx, uint256 cx, uint256 cy, address rAddr, uint256 z) external nonReentrant {
        if (denomIdx >= K) revert BadDenomIdx();
        bytes32 id = _noteId(cx, cy);
        if (noteStatus[id] != 1) revert NoteNotActive();
        if (!_verifyOpen(cx, cy, denomIdx, address(0), rAddr, z)) revert BadProof();

        noteStatus[id] = 2;
        supply -= _denom(denomIdx);
        emit Burn(id, denomIdx);
    }
}
