// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ISP1Verifier {
    function verifyProof(
        bytes32 programVKey,
        bytes calldata publicValues,
        bytes calldata proofBytes
    ) external view;
}

interface IRelay {
    function tip() external view returns (bytes32);
}

interface IMixer {
    function getRootAccumulator(bytes32 poolId) external view returns (bytes32);
}

/// @title SP1PoolRootVerifier
/// @notice Verifies SP1 proofs of Tacit pool state transitions. Permissionless.
///         One instance per pool (denomination). The SP1 guest filters envelopes
///         by denomination and commits it in public values; this contract checks it.
///
///         Supports incremental proofs: each proof chains from the previous proven
///         state via matching prev values + state commitment. The state commitment
///         is SHA256(pool root + nullifier set hash + height + pool frontier +
///         null count) — it prevents a malicious prover from lying about private
///         witness data (tree frontier, nullifier history).
///
///         Withdrawals use the latest SP1-proven state, not necessarily the current
///         relay tip. This is an intentional liveness tradeoff: requiring tip match
///         at withdrawal time would block all withdrawals whenever the relay advances.
contract SP1PoolRootVerifier {
    ISP1Verifier public immutable SP1_VERIFIER;
    IRelay public immutable RELAY;
    IMixer public immutable MIXER_CONTRACT;
    bytes32 public immutable PROGRAM_VKEY;
    address public immutable MIXER;
    bytes32 public immutable ASSET_ID;
    uint8 public immutable NETWORK_TAG;
    bytes32 public immutable GROTH16_VK_HASH;
    bytes32 public immutable POOL_ID;
    bytes32 public immutable DENOMINATION;
    bytes32 public immutable GENESIS_ANCHOR_HASH;

    struct ProvenState {
        bytes32 poolRoot;
        bytes32 nullifierSetHash;
        bytes32 depositRootsAccumulator;
        uint64 stateHeight;
        bytes32 lastBlockHash;
    }

    ProvenState public currentState;
    bytes32 public currentStateCommitment;
    mapping(bytes32 => ProvenState) public provenStates;
    mapping(bytes32 => bool) public acceptedBurns;

    error DomainMismatch();
    error InvalidDepositRoot();
    error InvalidProof();
    error InvalidVkHash();
    error NotRelayTip();
    error StateMismatch();
    error ZeroAddress();
    error ZeroGenesis();
    error ZeroVKey();

    event StateAdvanced(bytes32 indexed newPoolRoot, bytes32 indexed newNullSetHash, uint64 stateHeight);

    constructor(
        address sp1Verifier_, address relay_, bytes32 programVKey_,
        address mixer_, bytes32 assetId_, uint8 networkTag_,
        bytes32 groth16VkHash_, bytes32 poolId_, bytes32 denomination_,
        bytes32 genesisAnchorHash_
    ) {
        if (sp1Verifier_ == address(0) || relay_ == address(0) || mixer_ == address(0)) revert ZeroAddress();
        if (programVKey_ == bytes32(0)) revert ZeroVKey();
        if (genesisAnchorHash_ == bytes32(0)) revert ZeroGenesis();
        SP1_VERIFIER = ISP1Verifier(sp1Verifier_);
        RELAY = IRelay(relay_);
        MIXER_CONTRACT = IMixer(mixer_);
        PROGRAM_VKEY = programVKey_;
        MIXER = mixer_;
        ASSET_ID = assetId_;
        NETWORK_TAG = networkTag_;
        GROTH16_VK_HASH = groth16VkHash_;
        POOL_ID = poolId_;
        DENOMINATION = denomination_;
        GENESIS_ANCHOR_HASH = genesisAnchorHash_;
        // Genesis: prev block hash = anchor, everything else zero.
        currentState.lastBlockHash = genesisAnchorHash_;
    }

    function proveStateTransition(
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes32[] calldata burnClaimIds
    ) external {
        SP1_VERIFIER.verifyProof(PROGRAM_VKEY, publicValues, proofBytes);

        if (publicValues.length != 461) revert InvalidProof();

        bytes32 prevPoolRoot; bytes32 prevNullRoot; uint64 prevHeight; bytes32 prevBlockHash;
        bytes32 newPoolRoot; bytes32 newNullRoot; uint64 newHeight;
        bytes32 depositRootsAccumulator; bytes32 vkHash; bytes32 nullBatchHash;
        bytes32 assetId; uint8 networkTag; uint64 chainId; address mixerAddr;
        bytes32 lastBlockHash; bytes32 denomination;
        bytes32 prevStateCommitment; bytes32 newStateCommitment;

        assembly {
            let p := publicValues.offset
            prevPoolRoot := calldataload(p)
            prevNullRoot := calldataload(add(p, 32))
            prevHeight := shr(192, calldataload(add(p, 64)))
            prevBlockHash := calldataload(add(p, 72))
            newPoolRoot := calldataload(add(p, 104))
            newNullRoot := calldataload(add(p, 136))
            newHeight := shr(192, calldataload(add(p, 168)))
            depositRootsAccumulator := calldataload(add(p, 176))
            vkHash := calldataload(add(p, 208))
            nullBatchHash := calldataload(add(p, 240))
            assetId := calldataload(add(p, 272))
            networkTag := byte(0, calldataload(add(p, 304)))
            chainId := shr(192, calldataload(add(p, 305)))
            mixerAddr := shr(96, calldataload(add(p, 313)))
            lastBlockHash := calldataload(add(p, 333))
            denomination := calldataload(add(p, 365))
            prevStateCommitment := calldataload(add(p, 397))
            newStateCommitment := calldataload(add(p, 429))
        }

        // Domain checks.
        if (mixerAddr != MIXER) revert DomainMismatch();
        if (uint256(chainId) != block.chainid) revert DomainMismatch();
        if (assetId != ASSET_ID) revert DomainMismatch();
        if (networkTag != NETWORK_TAG) revert DomainMismatch();
        if (denomination != DENOMINATION) revert DomainMismatch();
        if (vkHash != GROTH16_VK_HASH) revert InvalidVkHash();

        // State continuity: proof must chain from stored state.
        if (prevPoolRoot != currentState.poolRoot) revert StateMismatch();
        if (prevNullRoot != currentState.nullifierSetHash) revert StateMismatch();
        if (prevHeight != currentState.stateHeight) revert StateMismatch();
        if (prevBlockHash != currentState.lastBlockHash) revert StateMismatch();
        if (prevStateCommitment != currentStateCommitment) revert StateMismatch();

        // Relay anchor: every proof must process at least one block and end at tip.
        if (lastBlockHash == bytes32(0)) revert InvalidProof();
        if (lastBlockHash != RELAY.tip()) revert NotRelayTip();

        // Deposit roots: the SP1 proof commits a running accumulator computed from the
        // complete ordered root set. One comparison replaces the O(n) on-chain loop.
        if (depositRootsAccumulator != MIXER_CONTRACT.getRootAccumulator(POOL_ID)) revert InvalidDepositRoot();

        // Burn claims.
        {
            bytes32 computed = _hashBatch(burnClaimIds);
            if (computed != nullBatchHash) revert InvalidProof();
            for (uint256 i; i < burnClaimIds.length; ++i) {
                acceptedBurns[burnClaimIds[i]] = true;
            }
        }

        ProvenState memory ns = ProvenState({
            poolRoot: newPoolRoot,
            nullifierSetHash: newNullRoot,
            depositRootsAccumulator: depositRootsAccumulator,
            stateHeight: newHeight,
            lastBlockHash: lastBlockHash
        });
        currentState = ns;
        currentStateCommitment = newStateCommitment;
        provenStates[newPoolRoot] = ns;

        emit StateAdvanced(newPoolRoot, newNullRoot, newHeight);
    }

    function isAcceptedBurn(bytes32 claimId) external view returns (bool) {
        return acceptedBurns[claimId];
    }

    function getNullifierSetHash(bytes32 poolRoot) external view returns (bytes32) {
        return provenStates[poolRoot].nullifierSetHash;
    }

    function rootAccumulator() external view returns (bytes32) {
        return MIXER_CONTRACT.getRootAccumulator(POOL_ID);
    }

    function _hashBatch(bytes32[] calldata items) internal pure returns (bytes32) {
        if (items.length == 0) return bytes32(0);
        return sha256(abi.encodePacked(items));
    }
}
