// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @dev The factory exposes the deploy-time parameters via a callback so the ERC20
///      constructor takes NO arguments — keeping its init code constant so the CREATE2
///      address is a pure function of the asset id (salt). Uniswap-V2-pair pattern.
interface ICanonicalDeployParams {
    function deployParams()
        external
        view
        returns (bytes32 assetId, address minter, string memory symbol_, uint8 decimals_);
}

/// @title CanonicalBridgedERC20
/// @notice The canonical, public Ethereum ERC20 for a Tacit-native or synthetic asset
///         (TAC, cBTC, …) — tradeable on Uniswap, or wrapped into ConfidentialPool for
///         the confidential face. Deliberately dumb: all backing is enforced by the
///         immutable `MINTER` (the pool / bridge / vault), the sole mint/burn authority.
///
///         The constructor takes no arguments — it reads `(assetId, minter, symbol,
///         decimals)` back from its deployer (the factory). That keeps the init code
///         constant, so the CREATE2 address is `f(assetId)` alone: the bridge can compute
///         where to mint before the token exists, deploy it on first mint, and `mint`
///         against the same address forever after.
///
///         `name` is the constant brand `"Tacit Token"`. A Tacit asset carries no
///         trustless on-chain name (the etch envelope holds only `ticker` + `decimals`;
///         the richer name is off-chain in IPFS), so the per-asset identity is the
///         `symbol` (the etch ticker, trustlessly proven) and the address — not a
///         spoofable or off-chain-sourced name field.
contract CanonicalBridgedERC20 is ERC20 {
    address public immutable MINTER;
    bytes32 public immutable ASSET_ID;

    string private _symbol;
    uint8 private immutable _decimals;

    error NotMinter();

    constructor() {
        (bytes32 assetId, address minter, string memory s, uint8 d) =
            ICanonicalDeployParams(msg.sender).deployParams();
        ASSET_ID = assetId;
        MINTER = minter;
        _symbol = s;
        _decimals = d;
    }

    function name() public pure override returns (string memory) { return "Tacit Token"; }
    function symbol() public view override returns (string memory) { return _symbol; }
    function decimals() public view override returns (uint8) { return _decimals; }

    /// @notice Mint backed supply. Only the minter, which enforces the backing (the SP1
    ///         bridge proof for bridged assets; collateral health for synthetics).
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
