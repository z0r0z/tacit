// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";
import {LibString} from "solady/utils/LibString.sol";

/// @dev The factory exposes the deploy-time parameters via a callback so the ERC20
///      constructor takes NO arguments — keeping its init code constant so the CREATE2
///      address is a pure function of the factory salt `(assetId, minter, symbol, decimals, cid)`.
///      Uniswap-V2-pair pattern.
interface ICanonicalDeployParams {
    function deployParams()
        external
        view
        returns (bytes32 assetId, address minter, string memory symbol_, uint8 decimals_, bytes32 cid);
}

/// @title CanonicalBridgedERC20
/// @notice The canonical, public Ethereum ERC20 for a Tacit-native or synthetic asset
///         (TAC, cBTC, …) — tradeable on Uniswap, or wrapped into ConfidentialPool for
///         the confidential face. Deliberately dumb: all backing is enforced by the
///         immutable `MINTER` (the pool / bridge / vault), the sole mint/burn authority.
///
///         The constructor takes no arguments — it reads `(assetId, minter, symbol,
///         decimals, cid)` back from its deployer (the factory). That keeps the init code
///         constant, so the CREATE2 address is `f(assetId, minter, symbol, decimals, cid)`:
///         the bridge can compute where to mint before the token exists, deploy it on first
///         mint, and `mint` against the same address forever after.
///
///         `name` is the constant brand `"Tacit Token"`. A Tacit asset carries no
///         trustless on-chain name (the etch envelope holds only `ticker` + `decimals`;
///         the richer name is off-chain in IPFS), so the per-asset identity is the
///         `symbol` (the etch ticker, trustlessly proven) and the address — not a
///         spoofable or off-chain-sourced name field.
///
/// @dev    Inherits solady's default Permit2 support: the canonical Permit2 singleton holds an infinite
///         allowance on every token (gasless approvals for the public/Uniswap face). Safe here — the pool
///         never custodies its own canonical tokens (pool-minted assets have no escrow; mint goes to the
///         recipient, burn pulls from `msg.sender`) — but integrators should expect the nonzero default.
contract CanonicalBridgedERC20 is ERC20 {
    address public immutable MINTER;
    bytes32 public immutable ASSET_ID;
    /// IPFS metadata content hash (the CIDv1 raw sha2-256 digest of a logo/description JSON —
    /// i.e. sha256 of the JSON bytes), bound into ASSET_ID by the etch so the contractURI is
    /// trustless and recomputable from the JSON alone. 0 ⇒ no metadata.
    bytes32 public immutable METADATA_CID;

    string private _symbol;
    uint8 private immutable _decimals;

    error NotMinter();
    error InvalidRecipient();

    /// @dev EIP-7572: signals indexers/marketplaces to (re)fetch `contractURI`. The metadata is
    ///      immutable (bound into ASSET_ID), so it is emitted once at deploy — never again.
    event ContractURIUpdated();

    constructor() {
        (bytes32 assetId, address minter, string memory s, uint8 d, bytes32 cid) =
            ICanonicalDeployParams(msg.sender).deployParams();
        ASSET_ID = assetId;
        MINTER = minter;
        _symbol = s;
        _decimals = d;
        METADATA_CID = cid;
        if (cid != bytes32(0)) emit ContractURIUpdated();
    }

    function name() public pure override returns (string memory) {
        return "Tacit Token";
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @dev `name` is a compile-time constant, so the EIP-2612 / EIP-712 name hash is too —
    ///      return it directly so `permit` / `DOMAIN_SEPARATOR` skip hashing the string each call.
    function _constantNameHash() internal pure override returns (bytes32) {
        return keccak256("Tacit Token");
    }

    /// @notice EIP-7572 contract-level metadata URI → the asset's logo/description JSON, pinned on
    ///         IPFS. The CID is the etch-proven `METADATA_CID` (bound into ASSET_ID), reconstructed
    ///         as a base16 CIDv1 (raw codec, sha2-256), so the metadata is trustless, not
    ///         operator-set. Empty when the etch carried no metadata.
    ///         Layout: `f`(base16) ‖ `01`(v1) ‖ `55`(raw) ‖ `12`(sha2-256) ‖ `20`(len 32) ‖ cid.
    function contractURI() external view returns (string memory) {
        if (METADATA_CID == bytes32(0)) return "";
        return string.concat("ipfs://f01551220", LibString.toHexStringNoPrefix(uint256(METADATA_CID), 32));
    }

    /// @notice Mint backed supply. Only the minter, which enforces the backing (the SP1
    ///         bridge proof for bridged assets; collateral health for synthetics). Rejects the zero
    ///         address and the token itself — solady guards neither, and supply minted to either is
    ///         stranded (no holder can move it; only the minter could burn it back).
    function mint(address to, uint256 amount) external {
        if (msg.sender != MINTER) revert NotMinter();
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        _mint(to, amount);
    }

    /// @notice Burn on redemption — the minter releases the backing on the source side. The minter may
    ///         burn ANY holder's balance (the bridge burns the depositor's tokens on wrap), so a minter
    ///         implementation must only ever burn with the holder's consent.
    function burn(address from, uint256 amount) external {
        if (msg.sender != MINTER) revert NotMinter();
        _burn(from, amount);
    }
}
