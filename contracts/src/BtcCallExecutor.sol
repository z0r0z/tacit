// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";

interface IConfidentialPoolBtcCalls {
    /// callId => keccak(executor ‖ target ‖ calldataHash ‖ callerPubkey), recorded by attestBitcoinStateProven; 0 = unknown.
    function pendingBtcCall(bytes32 callId) external view returns (bytes32 recordHash);
}

/// A contract a Bitcoin-authorized call invokes. `callerPubkey` is the x-only Bitcoin signer that authorized
/// the call (Schnorr-verified in the reflection guest); a target gates on it. `value` is always 0 in Mode B.
/// A target SHOULD require `msg.sender == <the canonical BtcCallExecutor>` and may verify
/// `IBtcCallExecutorPool(msg.sender).POOL() == <its trusted pool>` to bind the executor to the pool it trusts.
interface IBitcoinHook {
    function onBitcoinReflect(bytes calldata data, uint256 value, bytes32 callerPubkey) external;
}

/// Fires value-free Bitcoin-authorized calls (SPEC-BITCOIN-HOOK-AMENDMENT §1.4) that the ConfidentialPool
/// reflection proved and recorded in `pendingBtcCall`. It is deliberately a SEPARATE contract from the pool:
///   1. Liveness — a reverting / gas-heavy target can only fail its OWN executeBtcCall, never the reflection
///      attest (the bridge's liveness-critical advance). The pool records; this fires.
///   2. Least privilege — the pool is the MINTER for canonical ERC20s and holds the verifier; it must never
///      be the caller of an arbitrary contract. This executor holds NO privileges anywhere — a pure relay —
///      so it cannot be leveraged even by a target with a `msg.sender`-gated path.
contract BtcCallExecutor is ReentrancyGuardTransient {
    IConfidentialPoolBtcCalls public immutable POOL;

    /// callId => fired. One-shot; a re-attested call stays blocked here even if the pool re-records it.
    mapping(bytes32 => bool) public fired;

    event BtcCallExecuted(bytes32 indexed callId, address indexed target, bytes32 callerPubkey);

    error BadRecord();
    error NotProven();
    error AlreadyFired();

    constructor(address pool) {
        POOL = IConfidentialPoolBtcCalls(pool);
    }

    /// Fire a recorded Bitcoin-authorized call. `target`, `callerPubkey`, and `data` are all public from the
    /// Bitcoin tx; they are re-supplied here and checked against the pool's commitment, so a relayer can
    /// neither redirect the target nor alter the calldata: keccak(address(this) ‖ target ‖ keccak(data) ‖
    /// callerPubkey) must equal the recorded `recordHash`. `address(this)` is the authorized executor the
    /// caller signed over — so a call recorded for a DIFFERENT deployment's executor reverts here (no
    /// cross-deployment replay) — and the same check pins the target, the caller, and the calldata (its hash
    /// is the Bitcoin-committed `calldataHash`). Permissionless; one-shot.
    function executeBtcCall(bytes32 callId, address target, bytes32 callerPubkey, bytes calldata data)
        external
        nonReentrant
    {
        bytes32 recordHash = POOL.pendingBtcCall(callId);
        if (recordHash == bytes32(0)) revert NotProven();
        if (fired[callId]) revert AlreadyFired();
        bytes32 calldataHash = keccak256(data);
        if (keccak256(abi.encodePacked(address(this), target, calldataHash, callerPubkey)) != recordHash) {
            revert BadRecord();
        }
        fired[callId] = true; // CEI: one-shot committed before the external call
        IBitcoinHook(target).onBitcoinReflect(data, 0, callerPubkey);
        emit BtcCallExecuted(callId, target, callerPubkey);
    }
}
