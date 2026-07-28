// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title EthCallOutbox
/// @notice The Ethereum→Bitcoin authenticated-message anchor: the mirror of `BtcCallExecutor`'s
///         `pendingBtcCall` record, in the other direction. A sender commits a message here; the
///         eth-reflection guest proves these storage slots against a finalized execution state root and
///         folds them into a membership accumulator; the Bitcoin reflection guest verifies that proof
///         recursively and honors a matching `T_ETH_CALL` (opcode 0x69) envelope. See
///         `ops/DESIGN-eth-call-outbox.md`.
///
///         Deliberately a SEPARATE contract from `ConfidentialPool`, for the same two reasons
///         `BtcCallExecutor` is separate from it:
///           1. Least privilege — the pool is the MINTER for canonical ERC20s and holds the verifier.
///              A permissionless message anchor must never live behind those privileges. This contract
///              holds none, anywhere, and can hold no balance.
///           2. Blast radius — the pool's storage layout is consumed by the reverse-reflection proofs
///              at pinned slot indices. A message set appended there would couple the two formats;
///              here it is a separate account proof against the same state root.
///
///         VALUE IS NEVER AUTHORIZED. `recordHash` commits no amount, so none can be. There is no
///         payable path and no way to move a token, which is what keeps a message channel from becoming
///         an unaudited bridge under the weaker (sync-committee) reverse anchor.
///
///         STORAGE LAYOUT IS CONSENSUS. The eth-reflection guest reads these slots by INDEX:
///         `msgCount` at 0, `msgAt` at 1, `msgRecord` at 2. Never reorder, never insert; append only.
contract EthCallOutbox {
    /// @notice Messages recorded so far. Slot 0 — the enumeration cursor, and the index bound into each
    ///         `msgId`. Monotone, so it is never legitimately absent-once-nonzero (the property the
    ///         guest's zero-tolerant slot verification relies on to bootstrap at 0).
    uint64 public msgCount;

    /// @notice index => msgId. Slot 1. Enumerable so an indexer can walk the log without event access,
    ///         and so a witness for any past message stays derivable forever — messages recorded before
    ///         a handler exists remain foldable afterwards.
    mapping(uint64 => bytes32) public msgAt;

    /// @notice msgId => recordHash. Slot 2. The commitment the Bitcoin envelope is checked against.
    mapping(bytes32 => bytes32) public msgRecord;

    /// @dev `destChain` selectors, matching `ConfidentialPool.CrossOut.destChain` and
    ///      `cxfer-core::eth_reflection::DEST_CHAIN_*`. 0 is reserved as the unset sentinel.
    uint16 internal constant DEST_CHAIN_BITCOIN = 1;

    /// @notice Payload ceiling. The binding limit is the guest's keccak over the payload during the
    ///         fold, not Bitcoin standardness (the envelope is witness-carried). Enforced identically
    ///         in-guest; both sides must agree or a message accepted here would be unfoldable there.
    uint256 public constant MAX_PAYLOAD = 1024;

    event EthMessageSent(
        bytes32 indexed msgId, uint16 destChain, bytes32 indexed ns, address indexed sender, uint64 index, bytes payload
    );

    error BadDestChain();
    error PayloadTooLarge();

    /// @notice Commit a message for a Bitcoin-side handler. Permissionless and value-free.
    /// @param destChain Destination selector; only `DEST_CHAIN_BITCOIN` is honored by the Bitcoin guest,
    ///                  but it is committed into `recordHash` regardless so a message can never be
    ///                  replayed onto a chain it was not addressed to.
    /// @param ns        Handler namespace, `keccak("tacit-ns-<handler>-v1")`. Unknown namespaces are
    ///                  simply unhandled — an attestation nobody acts on, not an error.
    /// @param payload   Handler-defined bytes, committed by hash. Bound, never interpreted here.
    /// @return msgId    The one-shot key the Bitcoin side fires against.
    function send(uint16 destChain, bytes32 ns, bytes calldata payload) external returns (bytes32 msgId) {
        if (destChain == 0) revert BadDestChain();
        if (payload.length > MAX_PAYLOAD) revert PayloadTooLarge();

        // `msg.sender` is the authority, carried verbatim — the mirror of `callerPubkey` in a Bitcoin-
        // authorized call. A Bitcoin-side handler gates on it exactly as an `IBitcoinHook` target gates
        // on the Bitcoin signer, so any Ethereum contract (a timelock, a module) is an authority with no
        // new key material.
        bytes32 recordHash = recordHashOf(destChain, ns, msg.sender, keccak256(payload));

        uint64 index = msgCount;
        // `address(this) ‖ chainid` binds the message to THIS deployment on THIS chain — the reverse of
        // `BtcCallExecutor` binding `address(this)` into its record. `index` makes the id unique for
        // otherwise-identical repeat messages and ties it to its position in the enumerable log.
        msgId = keccak256(abi.encodePacked(address(this), block.chainid, recordHash, index));

        // Each id is written exactly once: `index` is strictly increasing, so no overwrite is reachable
        // and no zero-guard is needed. The increment is left CHECKED deliberately — `unchecked` would save
        // a few gas on a counter that cannot realistically reach 2^64, and on an immutable contract that is
        // a bad trade against the reviewer question it invites.
        msgAt[index] = msgId;
        msgRecord[msgId] = recordHash;
        msgCount = index + 1;

        emit EthMessageSent(msgId, destChain, ns, msg.sender, index, payload);
    }

    /// @notice The commitment both guests re-derive: `keccak(destChain ‖ ns ‖ sender ‖ payloadHash)`.
    ///         The Bitcoin envelope re-supplies `(ns, sender, payload)` and the guest rebuilds this, so
    ///         whoever relays the message can neither redirect its handler nor alter its payload.
    ///         Exposed so off-chain encoders and the guest's cross-language vectors check against the
    ///         deployed bytecode rather than a hardcoded derivation that can drift.
    function recordHashOf(uint16 destChain, bytes32 ns, address sender, bytes32 payloadHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(destChain, ns, sender, payloadHash));
    }
}
