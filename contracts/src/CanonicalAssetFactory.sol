// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CanonicalBridgedERC20} from "./CanonicalBridgedERC20.sol";

/// @title CanonicalAssetFactory
/// @notice CREATE2 deployer for canonical bridged ERC20s, at an address that is a pure
///         function of `(assetId, minter, symbol, decimals, cid)` (the salt; init code is
///         constant). The backing authority and metadata are bound into the salt — not the
///         id alone — so the canonical address is specific to a given minter + metadata,
///         each deterministic-to-real for a canonical asset. The bridge computes that
///         address, deploys the ERC20 on first mint, and `mint`s against the same address
///         forever after. The factory issues; the `minter` (the pool / bridge / vault)
///         backs; the pool makes confidential — clean separation.
///
///         Token `name` is the constant brand `"Tacit Token"`; the per-asset metadata is
///         `(symbol, decimals, cid)` — `cid` the IPFS metadata content hash (logo/description
///         JSON → `contractURI`, 0 = none) — all deterministic to the real asset, carried
///         on-chain in the etch envelope. For EVM-native etched assets the asset id COMMITS to
///         `(symbol, decimals, cid)` via `meta_hash`, so they are canonical by construction:
///         `etchCanonical` derives the id from the metadata and `verifyMetadata` lets
///         anyone recompute the binding on-chain. For assets whose id comes from elsewhere
///         (a Bitcoin etch, a wrapped ERC20), `deployCanonical` takes the id directly and
///         the metadata is certified on that asset's own terms (the etch-envelope proof).
contract CanonicalAssetFactory {
    /// @dev Domain tag for the EVM etch id derivation.
    bytes public constant ETCH_TAG = "tacit-evm-etch-v1";

    /// @notice keccak of the (constant, arg-less) ERC20 creation code — the CREATE2 init-code hash,
    ///         read by `predict` (the rehash is paid once at deploy). Public so off-chain tooling derives
    ///         a canonical address from this factory's exact deployed bytecode rather than a hardcoded
    ///         hash that drifts with compiler settings.
    bytes32 public immutable INIT_CODE_HASH = keccak256(type(CanonicalBridgedERC20).creationCode);

    /// @dev deploy slot => canonical ERC20 (0 if unset). The slot binds the backing
    ///      authority (`minter`) and the FULL metadata (`symbol`, `decimals`, `cid`)
    ///      alongside the asset id, so the canonical address is specific to a given
    ///      minter + metadata rather than the asset id alone. `cid` is in the slot so a
    ///      token pre-deployed with a different metadata cid lands at a DIFFERENT address
    ///      and can never shadow the etch-proven one (the cid is bound into asset_id, so
    ///      the legitimate cid is determined by the id — the address stays predictable for
    ///      it, while any wrong-cid pre-deploy is harmless).
    mapping(bytes32 => address) internal _token;

    function _slot(bytes32 assetId, address minter, string memory symbol_, uint8 decimals_, bytes32 cid)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(assetId, minter, symbol_, decimals_, cid));
    }

    /// @notice The ERC20 for (assetId, minter, symbol, decimals, cid), or 0 if unset. This is a
    ///         minter+metadata-specific lookup, NOT the canonicity oracle for an asset: only an
    ///         EVM-native etch's id self-certifies its metadata (`verifyMetadata`). For an
    ///         externally-derived id (a Bitcoin etch, a wrapped ERC20) the id does not commit to its
    ///         metadata, so several variants can deploy at different addresses; the canonical token for
    ///         a bridged asset is `ConfidentialPool.canonicalTokenFor(assetId)` (first-write-wins on
    ///         the backing authority), not this lookup.
    function tokenOf(bytes32 assetId, address minter, string calldata symbol_, uint8 decimals_, bytes32 cid)
        external
        view
        returns (address)
    {
        return _token[_slot(assetId, minter, symbol_, decimals_, cid)];
    }

    function tokenOf(bytes32 assetId, address minter, string calldata symbol_, uint8 decimals_)
        external
        view
        returns (address)
    {
        return _token[_slot(assetId, minter, symbol_, decimals_, bytes32(0))];
    }

    /// @dev Deploy-time parameters read back by the ERC20 constructor (so its init code is
    ///      constant and the address is f(assetId, minter, symbol, decimals, cid) — the salt). Set
    ///      immediately before CREATE2 and cleared immediately after.
    struct DeployParams {
        bytes32 assetId;
        address minter;
        string symbol;
        uint8 decimals;
        bytes32 cid; // IPFS metadata content hash (logo/description JSON), surfaced as contractURI
    }

    DeployParams private _params;

    /// @notice Callback used by `CanonicalBridgedERC20`'s constructor.
    function deployParams() external view returns (bytes32, address, string memory, uint8, bytes32) {
        return (_params.assetId, _params.minter, _params.symbol, _params.decimals, _params.cid);
    }

    event Deployed(bytes32 indexed assetId, address indexed token, address indexed minter, string symbol, uint8 decimals, bytes32 cid);

    error LabelTooLong();
    error AlreadyDeployed();

    /// @notice Canonical, language-neutral commitment to a token's per-asset metadata:
    ///         sha256( u8(len symbol) ‖ symbol ‖ u8(decimals) ‖ cid ). (`name` is the constant
    ///         brand, so it is not part of the commitment.) `cid` is the IPFS metadata content
    ///         hash (logo/description JSON; 0 = none) — bound here so the id commits to it, like
    ///         (symbol, decimals).
    function metaHash(string memory symbol_, uint8 decimals_, bytes32 cid) public pure returns (bytes32) {
        bytes memory s = bytes(symbol_);
        if (s.length > 255) revert LabelTooLong();
        return sha256(abi.encodePacked(uint8(s.length), s, decimals_, cid));
    }

    /// @notice The canonical EVM-etch asset id, per the amendment:
    ///         sha256(ETCH_TAG ‖ chainid_be8 ‖ factory ‖ salt ‖ etcher ‖ meta_hash).
    ///         The metadata is bound INTO the id, so a given id has exactly one official
    ///         (symbol, decimals, cid).
    function deriveAssetId(address etcher, bytes32 salt, string memory symbol_, uint8 decimals_, bytes32 cid)
        public
        view
        returns (bytes32)
    {
        return sha256(
            abi.encodePacked(ETCH_TAG, bytes8(uint64(block.chainid)), address(this), salt, etcher, metaHash(symbol_, decimals_, cid))
        );
    }

    /// @notice True if (symbol, decimals, cid) are the official metadata for an EVM-etched
    ///         `assetId` given (etcher, salt). Pure on-chain check — no registry, no
    ///         trust, no market resolution.
    function verifyMetadata(bytes32 assetId, address etcher, bytes32 salt, string calldata symbol_, uint8 decimals_, bytes32 cid)
        external
        view
        returns (bool)
    {
        return assetId == deriveAssetId(etcher, salt, symbol_, decimals_, cid);
    }

    /// @notice The CREATE2 address for (assetId, minter, symbol, decimals, cid) — a pure
    ///         function of those (constant init code), so it is knowable before the token
    ///         is deployed. The metadata + backing authority are deterministic-to-real for
    ///         a canonical asset, so the address stays predictable and is specific to that
    ///         (minter, metadata) tuple — `cid` included, so no wrong-cid pre-deploy can
    ///         shadow the canonical address. Like `tokenOf`, this is a (minter, metadata)-specific
    ///         address, not the canonicity oracle for an externally-derived id — for a bridged asset
    ///         resolve through `ConfidentialPool.canonicalTokenFor`.
    function predict(bytes32 assetId, address minter, string calldata symbol_, uint8 decimals_, bytes32 cid)
        public
        view
        returns (address)
    {
        bytes32 salt = _slot(assetId, minter, symbol_, decimals_, cid);
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, INIT_CODE_HASH)))));
    }

    function predict(bytes32 assetId, address minter, string calldata symbol_, uint8 decimals_)
        public
        view
        returns (address)
    {
        return predict(assetId, minter, symbol_, decimals_, bytes32(0));
    }

    /// @notice Etch an EVM-native canonical asset: the id is DERIVED from the metadata, so it is
    ///         self-certifying — re-deriving anywhere yields the same id, and the metadata cannot be
    ///         forged for it. Permissionless; the id fixes (symbol, decimals, cid), so the token
    ///         address is f(id, minter) (the full salt is (id, minter, symbol, decimals, cid)).
    function etchCanonical(address etcher, bytes32 salt, address minter, string calldata symbol_, uint8 decimals_, bytes32 cid)
        external
        returns (bytes32 assetId, address token)
    {
        assetId = deriveAssetId(etcher, salt, symbol_, decimals_, cid);
        token = _deploy(assetId, minter, symbol_, decimals_, cid);
    }

    /// @notice Deploy the canonical ERC20 for an externally-derived `assetId` (a Bitcoin
    ///         etch, a wrapped ERC20) with `minter` as sole mint/burn authority. Metadata
    ///         is certified on that asset's own terms (e.g. a Bitcoin etch-envelope proof).
    function deployCanonical(bytes32 assetId, address minter, string calldata symbol_, uint8 decimals_, bytes32 cid)
        external
        returns (address token)
    {
        token = _deploy(assetId, minter, symbol_, decimals_, cid);
    }

    // ── No-metadata overloads (cid = 0): short forms for an asset without an IPFS metadata blob. ──
    function metaHash(string memory symbol_, uint8 decimals_) public pure returns (bytes32) {
        return metaHash(symbol_, decimals_, bytes32(0));
    }

    function deriveAssetId(address etcher, bytes32 salt, string memory symbol_, uint8 decimals_)
        public
        view
        returns (bytes32)
    {
        return deriveAssetId(etcher, salt, symbol_, decimals_, bytes32(0));
    }

    function verifyMetadata(bytes32 assetId, address etcher, bytes32 salt, string calldata symbol_, uint8 decimals_)
        external
        view
        returns (bool)
    {
        return assetId == deriveAssetId(etcher, salt, symbol_, decimals_, bytes32(0));
    }

    function etchCanonical(address etcher, bytes32 salt, address minter, string calldata symbol_, uint8 decimals_)
        external
        returns (bytes32 assetId, address token)
    {
        assetId = deriveAssetId(etcher, salt, symbol_, decimals_, bytes32(0));
        token = _deploy(assetId, minter, symbol_, decimals_, bytes32(0));
    }

    function deployCanonical(bytes32 assetId, address minter, string calldata symbol_, uint8 decimals_)
        external
        returns (address token)
    {
        token = _deploy(assetId, minter, symbol_, decimals_, bytes32(0));
    }

    function _deploy(bytes32 assetId, address minter, string memory symbol_, uint8 decimals_, bytes32 cid)
        internal
        returns (address token)
    {
        // Bound the symbol (matching metaHash) so the deployCanonical path — which doesn't derive through
        // metaHash — can't deploy a runaway-length label (gas/indexer grief). A zero id or zero minter is
        // permitted by design: it yields an inert, unmintable token (no authority).
        if (bytes(symbol_).length > 255) revert LabelTooLong();
        bytes32 slot = _slot(assetId, minter, symbol_, decimals_, cid);
        if (_token[slot] != address(0)) revert AlreadyDeployed();
        _params = DeployParams({assetId: assetId, minter: minter, symbol: symbol_, decimals: decimals_, cid: cid});
        token = address(new CanonicalBridgedERC20{salt: slot}());
        delete _params;
        _token[slot] = token;
        emit Deployed(assetId, token, minter, symbol_, decimals_, cid);
    }
}
