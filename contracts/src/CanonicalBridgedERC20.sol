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
        returns (bytes32 assetId, address minter, string memory symbol_, uint8 decimals_, bytes32 cid);
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
    /// IPFS metadata content hash (the CIDv1 dag-pb sha2-256 digest of a logo/description JSON),
    /// bound into ASSET_ID by the etch — so the contractURI is trustless. 0 ⇒ no metadata.
    bytes32 public immutable METADATA_CID;

    string private _symbol;
    uint8 private immutable _decimals;

    error NotMinter();

    constructor() {
        (bytes32 assetId, address minter, string memory s, uint8 d, bytes32 cid) =
            ICanonicalDeployParams(msg.sender).deployParams();
        ASSET_ID = assetId;
        MINTER = minter;
        _symbol = s;
        _decimals = d;
        METADATA_CID = cid;
    }

    function name() public pure override returns (string memory) { return "Tacit Token"; }
    function symbol() public view override returns (string memory) { return _symbol; }
    function decimals() public view override returns (uint8) { return _decimals; }

    /// @notice EIP-7572 contract-level metadata URI → the asset's logo/description JSON, pinned on
    ///         IPFS. The CID is the etch-proven `METADATA_CID` (bound into ASSET_ID), reconstructed
    ///         as a base16 CIDv1 (dag-pb, sha2-256), so the metadata is trustless, not operator-set.
    ///         Empty when the etch carried no metadata.
    function contractURI() external view returns (string memory) {
        if (METADATA_CID == bytes32(0)) return "";
        return string.concat("ipfs://f01701220", _toHex(METADATA_CID));
    }

    function _toHex(bytes32 b) internal pure returns (string memory) {
        bytes memory hexc = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i; i < 32; ++i) {
            out[i * 2] = hexc[uint8(b[i]) >> 4];
            out[i * 2 + 1] = hexc[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }

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
