// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal interface to the canonical CreateX factory
///         (0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed on every major chain, testnets + L2s).
///
///         Only the CREATE3 surface Tacit's deploy needs. CREATE3 yields an address that is a
///         function of (factory, guardedSalt) ALONE — independent of initCode — so the same salt
///         produces the same address on every chain regardless of per-chain constructor args.
///
///         Salt-guarding gotcha (see ops/CREATEX-VANITY-DEPLOY.md): `deployCreate3(salt, initCode)`
///         runs `salt` through CreateX's `_guard` before the proxy CREATE2, whereas
///         `computeCreate3Address(salt)` does NOT — it treats its argument as already guarded. For
///         a "Random" salt (high 20 bytes are not msg.sender and not zero, byte[20] != 0x01) the
///         guard is the fully portable `keccak256(abi.encode(salt))` (no msg.sender, no chainid).
///         So to predict a deploy you must precompute with the guarded salt:
///             computeCreate3Address(keccak256(abi.encode(rawSalt))).
interface ICreateX {
    /// @dev Deploys `initCode` via CREATE3 keyed on `_guard(salt)`. Permissionless for Random salts.
    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address newContract);

    /// @dev CREATE3 address for an ALREADY-GUARDED salt (does NOT apply _guard). Deployer is CreateX itself.
    function computeCreate3Address(bytes32 salt) external view returns (address computedAddress);

    /// @dev CREATE3 address for an already-guarded salt under an arbitrary deployer (pure).
    function computeCreate3Address(bytes32 salt, address deployer) external pure returns (address computedAddress);
}
