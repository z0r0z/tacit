// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TacitConfidentialEtched} from "./TacitConfidentialEtched.sol";

/// @title TacitConfidentialFactory
/// @notice CREATE2 deployer for etched confidential tokens. Gives each token a
///         deterministic, indexer-addressable asset_id domain-separated from the
///         Bitcoin-layer namespace, and a deterministic address from the salt.
///         The ladder constants D_i = d_i·H are supplied by the etcher and are
///         publicly verifiable; the factory does not mint or hold value.
contract TacitConfidentialFactory {
    uint256 internal constant K = 8;

    /// asset_id => token address (0 if unset). Also guards salt/asset reuse.
    mapping(bytes32 => address) public tokenOf;

    event Etched(bytes32 indexed assetId, address indexed token, address indexed etcher, bool fairLaunch, string metadataURI);

    error AlreadyEtched();

    /// @notice Deploy an etched confidential token.
    /// @param mintAuthority issuer that may mint (0 ⇒ fair-launch / petch).
    /// @param petch [denomIdx, cap, startBlock, endBlock] for fair-launch; zeros in authority mode.
    function etch(
        address mintAuthority,
        uint256[K] calldata ladder,
        uint256[K] calldata Dx,
        uint256[K] calldata Dy,
        uint256[4] calldata petch,
        bytes32 salt,
        string calldata metadataURI
    ) external returns (address token, bytes32 assetId) {
        assetId = sha256(abi.encodePacked("tacit-evm-etch-v1", uint64(block.chainid), address(this), salt, msg.sender));
        if (tokenOf[assetId] != address(0)) revert AlreadyEtched();

        token = address(new TacitConfidentialEtched{salt: salt}(assetId, mintAuthority, ladder, Dx, Dy, petch));
        tokenOf[assetId] = token;
        emit Etched(assetId, token, msg.sender, mintAuthority == address(0), metadataURI);
    }

    /// @notice The address `etch` will deploy to for a given etcher and salt.
    function predictAddress(
        address mintAuthority,
        uint256[K] calldata ladder,
        uint256[K] calldata Dx,
        uint256[K] calldata Dy,
        uint256[4] calldata petch,
        bytes32 salt,
        address etcher
    ) external view returns (address) {
        bytes32 assetId = sha256(abi.encodePacked("tacit-evm-etch-v1", uint64(block.chainid), address(this), salt, etcher));
        bytes32 initHash = keccak256(abi.encodePacked(
            type(TacitConfidentialEtched).creationCode,
            abi.encode(assetId, mintAuthority, ladder, Dx, Dy, petch)
        ));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }
}
