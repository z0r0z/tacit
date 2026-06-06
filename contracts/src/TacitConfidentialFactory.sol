// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TacitConfidentialEtched} from "./TacitConfidentialEtched.sol";

/// @title TacitConfidentialFactory
/// @notice CREATE2 deployer for etched confidential tokens. Gives each token a
///         deterministic, indexer-addressable asset_id domain-separated from the
///         Bitcoin-layer namespace, and a deterministic address from the salt.
///         The denomination ladder is protocol-wide (baked into the token), so
///         the factory carries no per-token constants; it does not mint or hold
///         value.
///
///  Two etch modes, one per entrypoint (no overloaded sentinel):
///    etchAuthority   — a fixed issuer mints any denomination; can renounce.
///    etchFairLaunch  — no issuer; anyone mints the petch denomination under a
///                      block window and cap.
///
///  `name` / `symbol` / `decimals` are carried on-chain by the token (queryable
///  with no indexer); `metadataURI` carries richer off-chain metadata via the
///  `Etched` event.
contract TacitConfidentialFactory {
    /// asset_id => token address (0 if unset). Also guards salt/asset reuse.
    mapping(bytes32 => address) public tokenOf;

    event Etched(bytes32 indexed assetId, address indexed token, address indexed etcher, bool fairLaunch, string metadataURI);

    error AlreadyEtched();
    error ZeroAuthority();

    struct Meta {
        string name;
        string symbol;
        uint8 decimals;
        string uri;
    }

    /// @notice Etch an authority-minted confidential token.
    /// @param mintAuthority issuer that may mint (must be nonzero).
    function etchAuthority(address mintAuthority, Meta calldata meta, bytes32 salt)
        external returns (address token, bytes32 assetId)
    {
        if (mintAuthority == address(0)) revert ZeroAuthority();
        TacitConfidentialEtched.Petch memory noPetch;
        return _etch(mintAuthority, noPetch, meta, salt);
    }

    /// @notice Etch a fair-launch (petch) confidential token: no issuer, anyone
    ///         mints the fixed denomination inside the window up to the cap.
    function etchFairLaunch(TacitConfidentialEtched.Petch calldata petch, Meta calldata meta, bytes32 salt)
        external returns (address token, bytes32 assetId)
    {
        return _etch(address(0), petch, meta, salt);
    }

    /// @notice The address etchAuthority will deploy to for a given etcher/salt.
    function predictAuthority(address mintAuthority, Meta calldata meta, bytes32 salt, address etcher)
        external view returns (address)
    {
        TacitConfidentialEtched.Petch memory noPetch;
        return _predict(mintAuthority, noPetch, meta, salt, etcher);
    }

    /// @notice The address etchFairLaunch will deploy to for a given etcher/salt.
    function predictFairLaunch(
        TacitConfidentialEtched.Petch calldata petch,
        Meta calldata meta,
        bytes32 salt,
        address etcher
    ) external view returns (address) {
        return _predict(address(0), petch, meta, salt, etcher);
    }

    // ──────────────────── internals ────────────────────

    function _etch(
        address mintAuthority,
        TacitConfidentialEtched.Petch memory petch,
        Meta calldata meta,
        bytes32 salt
    ) internal returns (address token, bytes32 assetId) {
        assetId = _assetId(salt, msg.sender);
        if (tokenOf[assetId] != address(0)) revert AlreadyEtched();

        token = address(new TacitConfidentialEtched{salt: salt}(
            assetId, mintAuthority, petch, meta.name, meta.symbol, meta.decimals
        ));
        tokenOf[assetId] = token;
        emit Etched(assetId, token, msg.sender, mintAuthority == address(0), meta.uri);
    }

    function _predict(
        address mintAuthority,
        TacitConfidentialEtched.Petch memory petch,
        Meta calldata meta,
        bytes32 salt,
        address etcher
    ) internal view returns (address) {
        bytes32 assetId = _assetId(salt, etcher);
        bytes32 initHash = keccak256(abi.encodePacked(
            type(TacitConfidentialEtched).creationCode,
            abi.encode(assetId, mintAuthority, petch, meta.name, meta.symbol, meta.decimals)
        ));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    function _assetId(bytes32 salt, address etcher) internal view returns (bytes32) {
        return sha256(abi.encodePacked("tacit-evm-etch-v1", uint64(block.chainid), address(this), salt, etcher));
    }
}
