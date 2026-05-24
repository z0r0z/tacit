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
    function isKnownDepositRoot(bytes32 poolId, bytes32 root) external view returns (bool);
}

/// @title SP1PoolRootVerifier
/// @notice Verifies SP1 proofs of Tacit pool state transitions. Permissionless.
///
///         V1: genesis replay. Every proof processes ALL history from scratch.
///         The verifier enforces prev state == zeros.
///
///         Deposit roots are verified on-chain against the mixer's root history.
///         The prover supplies the root list alongside the proof; the verifier
///         checks the hash matches the SP1 commitment AND each root is known.
///
///         Accepted burns are recorded as exact claim IDs (bound to nullifier +
///         denomination + poolRoot + recipient + bindHash).
contract SP1PoolRootVerifier {
    ISP1Verifier public immutable SP1_VERIFIER;
    IRelay public immutable RELAY;
    IMixer public immutable MIXER_CONTRACT;
    bytes32 public immutable PROGRAM_VKEY;
    address public immutable MIXER;
    bytes32 public immutable ASSET_ID;
    uint8 public immutable NETWORK_TAG;
    bytes32 public immutable GROTH16_VK_HASH;
    bytes32 public immutable POOL_ID; // primary pool for deposit root checks

    struct ProvenState {
        bytes32 poolRoot;
        bytes32 nullifierRoot;
        bytes32 depositRootsHash;
        uint64 stateHeight;
        bytes32 lastBlockHash;
    }

    ProvenState public currentState;
    mapping(bytes32 => ProvenState) public provenStates;
    mapping(bytes32 => bool) public acceptedBurns;

    error DomainMismatch();
    error InvalidDepositRoot();
    error InvalidProof();
    error InvalidVkHash();
    error NotRelayTip();
    error StateMismatch();
    error ZeroAddress();
    error ZeroVKey();

    event StateAdvanced(bytes32 indexed newPoolRoot, bytes32 indexed newNullRoot, uint64 stateHeight);

    constructor(
        address sp1Verifier_, address relay_, bytes32 programVKey_,
        address mixer_, bytes32 assetId_, uint8 networkTag_,
        bytes32 groth16VkHash_, bytes32 poolId_
    ) {
        if (sp1Verifier_ == address(0) || relay_ == address(0) || mixer_ == address(0)) revert ZeroAddress();
        if (programVKey_ == bytes32(0)) revert ZeroVKey();
        SP1_VERIFIER = ISP1Verifier(sp1Verifier_);
        RELAY = IRelay(relay_);
        MIXER_CONTRACT = IMixer(mixer_);
        PROGRAM_VKEY = programVKey_;
        MIXER = mixer_;
        ASSET_ID = assetId_;
        NETWORK_TAG = networkTag_;
        GROTH16_VK_HASH = groth16VkHash_;
        POOL_ID = poolId_;
    }

    function proveStateTransition(
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes32[] calldata burnClaimIds,
        bytes32[] calldata depositRoots
    ) external {
        SP1_VERIFIER.verifyProof(PROGRAM_VKEY, publicValues, proofBytes);

        if (publicValues.length != 365) revert InvalidProof();

        bytes32 prevPoolRoot; bytes32 prevNullRoot; uint64 prevHeight; bytes32 prevBlockHash;
        bytes32 newPoolRoot; bytes32 newNullRoot; uint64 newHeight;
        bytes32 depositRootsHash; bytes32 vkHash; bytes32 nullBatchHash;
        bytes32 assetId; uint8 networkTag; uint64 chainId; address mixerAddr;
        bytes32 lastBlockHash;

        assembly {
            let p := publicValues.offset
            prevPoolRoot := calldataload(p)
            prevNullRoot := calldataload(add(p, 32))
            prevHeight := shr(192, calldataload(add(p, 64)))
            prevBlockHash := calldataload(add(p, 72))
            newPoolRoot := calldataload(add(p, 104))
            newNullRoot := calldataload(add(p, 136))
            newHeight := shr(192, calldataload(add(p, 168)))
            depositRootsHash := calldataload(add(p, 176))
            vkHash := calldataload(add(p, 208))
            nullBatchHash := calldataload(add(p, 240))
            assetId := calldataload(add(p, 272))
            networkTag := byte(0, calldataload(add(p, 304)))
            chainId := shr(192, calldataload(add(p, 305)))
            mixerAddr := shr(96, calldataload(add(p, 313)))
            lastBlockHash := calldataload(add(p, 333))
        }

        // Domain checks.
        if (mixerAddr != MIXER) revert DomainMismatch();
        if (uint256(chainId) != block.chainid) revert DomainMismatch();
        if (assetId != ASSET_ID) revert DomainMismatch();
        if (networkTag != NETWORK_TAG) revert DomainMismatch();
        if (vkHash != GROTH16_VK_HASH) revert InvalidVkHash();

        // V1: genesis replay.
        if (prevPoolRoot != bytes32(0)) revert StateMismatch();
        if (prevNullRoot != bytes32(0)) revert StateMismatch();
        if (prevHeight != 0) revert StateMismatch();
        if (prevBlockHash != bytes32(0)) revert StateMismatch();

        // Relay anchor.
        if (lastBlockHash == bytes32(0) && newHeight != 0) revert InvalidProof();
        if (lastBlockHash != bytes32(0) && lastBlockHash != RELAY.tip()) revert NotRelayTip();

        // Verify deposit roots: hash must match SP1 commitment, each must be known to the mixer.
        {
            bytes32 computed = _hashBatch(depositRoots);
            if (computed != depositRootsHash) revert InvalidProof();
            for (uint256 i; i < depositRoots.length; ++i) {
                if (!MIXER_CONTRACT.isKnownDepositRoot(POOL_ID, depositRoots[i])) {
                    revert InvalidDepositRoot();
                }
            }
        }

        // Verify and record accepted burn claims.
        {
            bytes32 computed = _hashBatch(burnClaimIds);
            if (computed != nullBatchHash) revert InvalidProof();
            for (uint256 i; i < burnClaimIds.length; ++i) {
                acceptedBurns[burnClaimIds[i]] = true;
            }
        }

        ProvenState memory ns = ProvenState({
            poolRoot: newPoolRoot,
            nullifierRoot: newNullRoot,
            depositRootsHash: depositRootsHash,
            stateHeight: newHeight,
            lastBlockHash: lastBlockHash
        });
        currentState = ns;
        provenStates[newPoolRoot] = ns;

        emit StateAdvanced(newPoolRoot, newNullRoot, newHeight);
    }

    function isAcceptedBurn(bytes32 claimId) external view returns (bool) {
        return acceptedBurns[claimId];
    }

    function getNullifierRoot(bytes32 poolRoot) external view returns (bytes32) {
        return provenStates[poolRoot].nullifierRoot;
    }

    function _hashBatch(bytes32[] calldata items) internal pure returns (bytes32) {
        if (items.length == 0) return bytes32(0);
        return sha256(abi.encodePacked(items));
    }
}
