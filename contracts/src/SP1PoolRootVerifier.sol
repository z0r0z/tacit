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
/// @notice Verifies SP1 proofs of Tacit pool state transitions across all
///         denominations for a single asset. One instance per asset.
///
///         The SP1 guest commits compact hashes of per-denomination data
///         (pool roots, deposit accumulators, burn batches). This contract
///         receives the per-denomination arrays as calldata and verifies
///         them against the committed hashes.
contract SP1PoolRootVerifier {
    ISP1Verifier public immutable SP1_VERIFIER;
    IRelay public immutable RELAY;
    IMixer public immutable MIXER_CONTRACT;
    bytes32 public immutable PROGRAM_VKEY;
    address public immutable MIXER;
    bytes32 public immutable ASSET_ID;
    uint8 public immutable NETWORK_TAG;
    bytes32 public immutable GROTH16_VK_HASH;
    bytes32 public immutable GENESIS_ANCHOR_HASH;
    bytes32 public immutable DENOMS_HASH;
    uint8 public immutable NUM_DENOMS;

    bytes32[] public poolIds;
    bytes32[] public denominations;

    struct ProvenState {
        bytes32 poolsHash;
        bytes32 nullifierSetHash;
        uint64 stateHeight;
        bytes32 lastBlockHash;
    }

    ProvenState public currentState;
    bytes32 public currentStateCommitment;
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

    event StateAdvanced(bytes32 indexed newPoolsHash, bytes32 indexed newNullSetHash, uint64 stateHeight);
    event BurnClaimAccepted(bytes32 indexed claimId);

    constructor(
        address sp1Verifier_, address relay_, bytes32 programVKey_,
        address mixer_, bytes32 assetId_, uint8 networkTag_,
        bytes32 groth16VkHash_,
        bytes32[] memory poolIds_, bytes32[] memory denominations_,
        bytes32 genesisAnchorHash_
    ) {
        if (sp1Verifier_ == address(0) || relay_ == address(0) || mixer_ == address(0)) revert ZeroAddress();
        if (programVKey_ == bytes32(0)) revert ZeroVKey();
        if (genesisAnchorHash_ == bytes32(0)) revert ZeroGenesis();
        require(poolIds_.length == denominations_.length && poolIds_.length > 0);
        SP1_VERIFIER = ISP1Verifier(sp1Verifier_);
        RELAY = IRelay(relay_);
        MIXER_CONTRACT = IMixer(mixer_);
        PROGRAM_VKEY = programVKey_;
        MIXER = mixer_;
        ASSET_ID = assetId_;
        NETWORK_TAG = networkTag_;
        GROTH16_VK_HASH = groth16VkHash_;
        GENESIS_ANCHOR_HASH = genesisAnchorHash_;
        NUM_DENOMS = uint8(poolIds_.length);
        for (uint256 i; i < poolIds_.length; ++i) {
            poolIds.push(poolIds_[i]);
            denominations.push(denominations_[i]);
        }
        DENOMS_HASH = _hashArray(denominations_);
        currentState.lastBlockHash = genesisAnchorHash_;
    }

    /// @param publicValues 393 bytes committed by the SP1 guest.
    /// @param proofBytes   The SP1 proof.
    /// @param poolRoots    Per-denomination new pool roots (length == NUM_DENOMS).
    /// @param depositAccs  Per-denomination deposit root accumulators.
    /// @param burnClaims   Flat array of all burn claim IDs across denominations.
    /// @param burnCounts   Per-denomination count of claims in burnClaims.
    function proveStateTransition(
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes32[] calldata poolRoots,
        bytes32[] calldata depositAccs,
        bytes32[] calldata burnClaims,
        uint8[] calldata burnCounts
    ) external {
        SP1_VERIFIER.verifyProof(PROGRAM_VKEY, publicValues, proofBytes);
        if (publicValues.length != 461) revert InvalidProof();

        bytes32 prevPoolsHash; bytes32 prevNullRoot; uint64 prevHeight; bytes32 prevBlockHash;
        bytes32 newPoolsHash; bytes32 newNullRoot; uint64 newHeight;
        bytes32 depositAccsHash; bytes32 burnsHash; bytes32 vkHash;
        bytes32 assetId; uint8 networkTag; uint64 chainId; address mixerAddr;
        bytes32 lastBlockHash; bytes32 denomsHash;
        bytes32 prevStateCmt; bytes32 newStateCmt;

        assembly {
            let p := publicValues.offset
            prevPoolsHash   := calldataload(p)
            prevNullRoot    := calldataload(add(p, 32))
            prevHeight      := shr(192, calldataload(add(p, 64)))
            prevBlockHash   := calldataload(add(p, 72))
            newPoolsHash    := calldataload(add(p, 104))
            newNullRoot     := calldataload(add(p, 136))
            newHeight       := shr(192, calldataload(add(p, 168)))
            depositAccsHash := calldataload(add(p, 176))
            burnsHash       := calldataload(add(p, 208))
            vkHash          := calldataload(add(p, 240))
            assetId         := calldataload(add(p, 272))
            networkTag      := byte(0, calldataload(add(p, 304)))
            chainId         := shr(192, calldataload(add(p, 305)))
            mixerAddr       := shr(96, calldataload(add(p, 313)))
            lastBlockHash   := calldataload(add(p, 333))
            denomsHash      := calldataload(add(p, 365))
            prevStateCmt    := calldataload(add(p, 397))
            newStateCmt     := calldataload(add(p, 429))
        }

        // Domain checks.
        if (mixerAddr != MIXER) revert DomainMismatch();
        if (uint256(chainId) != block.chainid) revert DomainMismatch();
        if (assetId != ASSET_ID) revert DomainMismatch();
        if (networkTag != NETWORK_TAG) revert DomainMismatch();
        if (denomsHash != DENOMS_HASH) revert DomainMismatch();
        if (vkHash != GROTH16_VK_HASH) revert InvalidVkHash();

        // State continuity.
        if (prevPoolsHash != currentState.poolsHash) revert StateMismatch();
        if (prevNullRoot != currentState.nullifierSetHash) revert StateMismatch();
        if (prevHeight != currentState.stateHeight) revert StateMismatch();
        if (prevBlockHash != currentState.lastBlockHash) revert StateMismatch();
        if (prevStateCmt != currentStateCommitment) revert StateMismatch();

        // Relay anchor.
        if (lastBlockHash == bytes32(0)) revert InvalidProof();
        if (lastBlockHash != RELAY.tip()) revert NotRelayTip();

        uint8 nd = NUM_DENOMS;
        require(poolRoots.length == nd && depositAccs.length == nd && burnCounts.length == nd);

        // Verify per-denomination calldata against committed hashes.
        if (_hashArray(poolRoots) != newPoolsHash) revert InvalidProof();
        if (_hashArray(depositAccs) != depositAccsHash) revert InvalidDepositRoot();

        // Verify each deposit accumulator against the mixer contract.
        for (uint256 i; i < nd; ++i) {
            if (depositAccs[i] != MIXER_CONTRACT.getRootAccumulator(poolIds[i])) revert InvalidDepositRoot();
        }

        // Verify burns hash and accept claims.
        {
            bytes32[] memory burnBatches = new bytes32[](nd);
            uint256 offset;
            for (uint256 i; i < nd; ++i) {
                uint256 cnt = burnCounts[i];
                if (cnt == 0) {
                    burnBatches[i] = bytes32(0);
                } else {
                    burnBatches[i] = sha256(abi.encodePacked(burnClaims[offset:offset + cnt]));
                    for (uint256 j; j < cnt; ++j) {
                        acceptedBurns[burnClaims[offset + j]] = true;
                        emit BurnClaimAccepted(burnClaims[offset + j]);
                    }
                    offset += cnt;
                }
            }
            if (_hashArrayMem(burnBatches) != burnsHash) revert InvalidProof();
            require(offset == burnClaims.length);
        }

        currentState = ProvenState({
            poolsHash: newPoolsHash,
            nullifierSetHash: newNullRoot,
            stateHeight: newHeight,
            lastBlockHash: lastBlockHash
        });
        currentStateCommitment = newStateCmt;

        emit StateAdvanced(newPoolsHash, newNullRoot, newHeight);
    }

    function isAcceptedBurn(bytes32 claimId) external view returns (bool) {
        return acceptedBurns[claimId];
    }

    function coversPool(bytes32 poolId) external view returns (bool) {
        for (uint256 i; i < poolIds.length; ++i) {
            if (poolIds[i] == poolId) return true;
        }
        return false;
    }

    function rootAccumulator(bytes32 poolId) external view returns (bytes32) {
        return MIXER_CONTRACT.getRootAccumulator(poolId);
    }

    function _hashArray(bytes32[] calldata arr) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(arr));
    }

    function _hashArrayMem(bytes32[] memory arr) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(arr));
    }
}
