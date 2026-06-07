// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CanonicalBridgedERC20} from "./CanonicalBridgedERC20.sol";

/// @title CanonicalAssetFactory
/// @notice CREATE2 deployer for canonical bridged ERC20s — one per asset id, at a
///         deterministic address. Bringing a Tacit-native or synthetic asset onto
///         Ethereum is: deploy its canonical ERC20 here (the public face), then it
///         trades publicly (Uniswap) or wraps into ConfidentialPool (confidential).
///         The factory issues; the `minter` (bridge / collateral vault) backs; the
///         pool makes confidential — clean separation, each contract dumb.
contract CanonicalAssetFactory {
    /// @notice asset_id => canonical ERC20 (0 if unset). Guarantees one per asset.
    mapping(bytes32 => address) public tokenOf;

    event Deployed(bytes32 indexed assetId, address indexed token, address indexed minter, string name, string symbol, uint8 decimals);

    error AlreadyDeployed();

    /// @notice Deploy the canonical ERC20 for `assetId` (salt = assetId) with `minter`
    ///         as its sole mint/burn authority. One per asset (dedup).
    function deployCanonical(bytes32 assetId, address minter, string calldata name_, string calldata symbol_, uint8 decimals_)
        external
        returns (address token)
    {
        if (tokenOf[assetId] != address(0)) revert AlreadyDeployed();
        token = address(new CanonicalBridgedERC20{salt: assetId}(assetId, minter, name_, symbol_, decimals_));
        tokenOf[assetId] = token;
        emit Deployed(assetId, token, minter, name_, symbol_, decimals_);
    }

    /// @notice The address `deployCanonical` will produce for these exact args.
    function predict(bytes32 assetId, address minter, string calldata name_, string calldata symbol_, uint8 decimals_)
        external
        view
        returns (address)
    {
        bytes32 initHash = keccak256(
            abi.encodePacked(type(CanonicalBridgedERC20).creationCode, abi.encode(assetId, minter, name_, symbol_, decimals_))
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), assetId, initHash)))));
    }
}
