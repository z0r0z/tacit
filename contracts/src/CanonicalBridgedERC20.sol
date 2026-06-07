// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @title CanonicalBridgedERC20
/// @notice The canonical, public Ethereum ERC20 for a Tacit-native or synthetic
///         asset (TAC, cBTC, …). A plain ERC20 — tradeable on Uniswap, or wrapped
///         into ConfidentialPool for the confidential face. It is deliberately dumb:
///         all backing is enforced by the immutable `MINTER` (the bridge for
///         Bitcoin-locked assets, or the collateral vault for synthetics like
///         cBTC.tac), which is the sole mint/burn authority. Supply ≤ backing is the
///         minter's invariant, not this token's.
contract CanonicalBridgedERC20 is ERC20 {
    /// @notice Sole mint/burn authority — the bridge / collateral module that holds
    ///         the backing and gates issuance against it.
    address public immutable MINTER;
    /// @notice Canonical asset id (the cross-chain/Tacit identity). Lets indexers bind
    ///         this ERC20 to its Bitcoin-side asset by derivation, not a registry.
    bytes32 public immutable ASSET_ID;

    string private _name;
    string private _symbol;
    uint8 private immutable _decimals;

    error NotMinter();

    constructor(bytes32 assetId, address minter, string memory name_, string memory symbol_, uint8 decimals_) {
        ASSET_ID = assetId;
        MINTER = minter;
        _name = name_;
        _symbol = symbol_;
        _decimals = decimals_;
    }

    function name() public view override returns (string memory) { return _name; }
    function symbol() public view override returns (string memory) { return _symbol; }
    function decimals() public view override returns (uint8) { return _decimals; }

    /// @notice Mint backed supply. Only the minter, which enforces the backing
    ///         (SP1 Bitcoin-lock proof for bridged assets; collateral health for
    ///         synthetics). This token trusts its minter and does no accounting.
    function mint(address to, uint256 amount) external {
        if (msg.sender != MINTER) revert NotMinter();
        _mint(to, amount);
    }

    /// @notice Burn on redemption — the minter releases the backing on the source side.
    function burn(address from, uint256 amount) external {
        if (msg.sender != MINTER) revert NotMinter();
        _burn(from, amount);
    }
}
