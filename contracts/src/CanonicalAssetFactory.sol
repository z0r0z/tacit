// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CanonicalBridgedERC20} from "./CanonicalBridgedERC20.sol";

/// @title CanonicalAssetFactory
/// @notice CREATE2 deployer for canonical bridged ERC20s — one per asset id, at a
///         deterministic address (salt = assetId). Bringing a Tacit-native or synthetic
///         asset onto Ethereum is: deploy its canonical ERC20 here (the public face),
///         then it trades publicly (Uniswap) or wraps into ConfidentialPool
///         (confidential). The factory issues; the `minter` (the pool / bridge / vault)
///         backs; the pool makes confidential — clean separation.
///
///         For EVM-native etched assets the asset id COMMITS to the token metadata
///         (per SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT), so name/symbol/decimals are
///         canonical by construction: `etchCanonical` derives the id from the metadata,
///         and `verifyMetadata` lets anyone recompute the binding on-chain. No registry,
///         no "market decides which token is faithful." For assets whose id comes from
///         elsewhere (a Bitcoin etch, a wrapped ERC20), `deployCanonical` takes the id
///         directly and its metadata is certified on that asset's own terms.
contract CanonicalAssetFactory {
    /// @dev Domain tag for the EVM etch id derivation.
    bytes public constant ETCH_TAG = "tacit-evm-etch-v1";

    /// @notice asset_id => canonical ERC20 (0 if unset). One per asset.
    mapping(bytes32 => address) public tokenOf;

    event Deployed(bytes32 indexed assetId, address indexed token, address indexed minter, string name, string symbol, uint8 decimals);

    error AlreadyDeployed();
    error MetadataMismatch();
    error LabelTooLong();

    /// @notice Canonical, language-neutral commitment to a token's display metadata:
    ///         sha256( u8(len name) ‖ name ‖ u8(len symbol) ‖ symbol ‖ u8(decimals) ).
    function metaHash(string memory name_, string memory symbol_, uint8 decimals_) public pure returns (bytes32) {
        bytes memory n = bytes(name_);
        bytes memory s = bytes(symbol_);
        if (n.length > 255 || s.length > 255) revert LabelTooLong();
        return sha256(abi.encodePacked(uint8(n.length), n, uint8(s.length), s, decimals_));
    }

    /// @notice The canonical EVM-etch asset id, per the amendment:
    ///         sha256(ETCH_TAG ‖ chainid_be8 ‖ factory ‖ salt ‖ etcher ‖ meta_hash).
    ///         The metadata is bound INTO the id, so a given id has exactly one official
    ///         (name, symbol, decimals).
    function deriveAssetId(address etcher, bytes32 salt, string memory name_, string memory symbol_, uint8 decimals_)
        public
        view
        returns (bytes32)
    {
        return sha256(
            abi.encodePacked(
                ETCH_TAG, bytes8(uint64(block.chainid)), address(this), salt, etcher, metaHash(name_, symbol_, decimals_)
            )
        );
    }

    /// @notice True iff (name, symbol, decimals) are the official metadata for an
    ///         EVM-etched `assetId` given (etcher, salt). Pure on-chain check — no
    ///         registry, no trust, no market resolution.
    function verifyMetadata(
        bytes32 assetId,
        address etcher,
        bytes32 salt,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_
    ) external view returns (bool) {
        return assetId == deriveAssetId(etcher, salt, name_, symbol_, decimals_);
    }

    /// @notice Etch an EVM-native canonical asset: the id is DERIVED from the metadata,
    ///         so it is self-certifying — re-deriving anywhere yields the same id, and
    ///         the metadata cannot be forged for it. Permissionless; address = f(id).
    function etchCanonical(
        address etcher,
        bytes32 salt,
        address minter,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_
    ) external returns (bytes32 assetId, address token) {
        assetId = deriveAssetId(etcher, salt, name_, symbol_, decimals_);
        token = _deploy(assetId, minter, name_, symbol_, decimals_);
    }

    /// @notice Deploy the canonical ERC20 for an externally-derived `assetId` (a Bitcoin
    ///         etch, a wrapped ERC20). Metadata is certified on that asset's own terms.
    function deployCanonical(bytes32 assetId, address minter, string calldata name_, string calldata symbol_, uint8 decimals_)
        external
        returns (address token)
    {
        token = _deploy(assetId, minter, name_, symbol_, decimals_);
    }

    function _deploy(bytes32 assetId, address minter, string calldata name_, string calldata symbol_, uint8 decimals_)
        internal
        returns (address token)
    {
        if (tokenOf[assetId] != address(0)) revert AlreadyDeployed();
        token = address(new CanonicalBridgedERC20{salt: assetId}(assetId, minter, name_, symbol_, decimals_));
        tokenOf[assetId] = token;
        emit Deployed(assetId, token, minter, name_, symbol_, decimals_);
    }

    /// @notice The address `deployCanonical` / `etchCanonical` will produce for these args.
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
