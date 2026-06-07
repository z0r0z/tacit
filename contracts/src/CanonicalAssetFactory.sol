// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CanonicalBridgedERC20} from "./CanonicalBridgedERC20.sol";

/// @title CanonicalAssetFactory
/// @notice CREATE2 deployer for canonical bridged ERC20s — one per asset id, at an
///         address that is a pure function of the asset id (salt = assetId, constant
///         init code). The bridge computes that address from `assetId` alone, deploys
///         the ERC20 on first mint, and `mint`s against the same address forever after.
///         The factory issues; the `minter` (the pool / bridge / vault) backs; the pool
///         makes confidential — clean separation.
///
///         Token `name` is the constant brand `"Tacit Token"`; the only per-asset
///         metadata is `(symbol, decimals)`, which is deterministic to the real asset —
///         carried on-chain in the etch envelope. For EVM-native etched assets the asset
///         id additionally COMMITS to `(symbol, decimals)` via `meta_hash` (per
///         SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT), so they are canonical by construction:
///         `etchCanonical` derives the id from the metadata and `verifyMetadata` lets
///         anyone recompute the binding on-chain. For assets whose id comes from elsewhere
///         (a Bitcoin etch, a wrapped ERC20), `deployCanonical` takes the id directly and
///         the metadata is certified on that asset's own terms (the etch-envelope proof).
contract CanonicalAssetFactory {
    /// @dev Domain tag for the EVM etch id derivation.
    bytes public constant ETCH_TAG = "tacit-evm-etch-v1";

    /// @notice asset_id => canonical ERC20 (0 if unset). One per asset.
    mapping(bytes32 => address) public tokenOf;

    /// @dev Deploy-time parameters read back by the ERC20 constructor (so its init code
    ///      is constant and the address is f(assetId)). Set immediately before CREATE2
    ///      and cleared immediately after.
    struct DeployParams {
        bytes32 assetId;
        address minter;
        string symbol;
        uint8 decimals;
    }

    DeployParams private _params;

    /// @notice Callback used by `CanonicalBridgedERC20`'s constructor.
    function deployParams() external view returns (bytes32, address, string memory, uint8) {
        return (_params.assetId, _params.minter, _params.symbol, _params.decimals);
    }

    event Deployed(bytes32 indexed assetId, address indexed token, address indexed minter, string symbol, uint8 decimals);

    error AlreadyDeployed();
    error LabelTooLong();

    /// @notice Canonical, language-neutral commitment to a token's per-asset metadata:
    ///         sha256( u8(len symbol) ‖ symbol ‖ u8(decimals) ). (`name` is the constant
    ///         brand, so it is not part of the commitment.)
    function metaHash(string memory symbol_, uint8 decimals_) public pure returns (bytes32) {
        bytes memory s = bytes(symbol_);
        if (s.length > 255) revert LabelTooLong();
        return sha256(abi.encodePacked(uint8(s.length), s, decimals_));
    }

    /// @notice The canonical EVM-etch asset id, per the amendment:
    ///         sha256(ETCH_TAG ‖ chainid_be8 ‖ factory ‖ salt ‖ etcher ‖ meta_hash).
    ///         The metadata is bound INTO the id, so a given id has exactly one official
    ///         (symbol, decimals).
    function deriveAssetId(address etcher, bytes32 salt, string memory symbol_, uint8 decimals_)
        public
        view
        returns (bytes32)
    {
        return sha256(
            abi.encodePacked(ETCH_TAG, bytes8(uint64(block.chainid)), address(this), salt, etcher, metaHash(symbol_, decimals_))
        );
    }

    /// @notice True iff (symbol, decimals) are the official metadata for an EVM-etched
    ///         `assetId` given (etcher, salt). Pure on-chain check — no registry, no
    ///         trust, no market resolution.
    function verifyMetadata(bytes32 assetId, address etcher, bytes32 salt, string calldata symbol_, uint8 decimals_)
        external
        view
        returns (bool)
    {
        return assetId == deriveAssetId(etcher, salt, symbol_, decimals_);
    }

    /// @notice The CREATE2 address for `assetId` — a pure function of the id (constant
    ///         init code), so it is knowable before the token is deployed.
    function predict(bytes32 assetId) public view returns (address) {
        bytes32 initHash = keccak256(type(CanonicalBridgedERC20).creationCode);
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), assetId, initHash)))));
    }

    /// @notice Etch an EVM-native canonical asset: the id is DERIVED from the metadata,
    ///         so it is self-certifying — re-deriving anywhere yields the same id, and
    ///         the metadata cannot be forged for it. Permissionless; address = f(id).
    function etchCanonical(address etcher, bytes32 salt, address minter, string calldata symbol_, uint8 decimals_)
        external
        returns (bytes32 assetId, address token)
    {
        assetId = deriveAssetId(etcher, salt, symbol_, decimals_);
        token = _deploy(assetId, minter, symbol_, decimals_);
    }

    /// @notice Deploy the canonical ERC20 for an externally-derived `assetId` (a Bitcoin
    ///         etch, a wrapped ERC20) with `minter` as sole mint/burn authority. Metadata
    ///         is certified on that asset's own terms (e.g. a Bitcoin etch-envelope proof).
    function deployCanonical(bytes32 assetId, address minter, string calldata symbol_, uint8 decimals_)
        external
        returns (address token)
    {
        token = _deploy(assetId, minter, symbol_, decimals_);
    }

    function _deploy(bytes32 assetId, address minter, string memory symbol_, uint8 decimals_)
        internal
        returns (address token)
    {
        if (tokenOf[assetId] != address(0)) revert AlreadyDeployed();
        _params = DeployParams(assetId, minter, symbol_, decimals_);
        token = address(new CanonicalBridgedERC20{salt: assetId}());
        delete _params;
        tokenOf[assetId] = token;
        emit Deployed(assetId, token, minter, symbol_, decimals_);
    }
}
