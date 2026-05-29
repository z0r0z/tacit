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
        require(poolIds_.length == denominations_.length && poolIds_.length > 0 && poolIds_.length <= 16);
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
        DENOMS_HASH = _hashArrayMem(denominations_);
        currentState.lastBlockHash = genesisAnchorHash_;
        // Genesis pool state = NUM_DENOMS empty (zero) roots; the prover's first
        // proof advances from this to the initialized empty-tree roots. Must equal
        // the prover's genesis prev_pools_hash or the first proof reverts StateMismatch.
        currentState.poolsHash = _hashArrayMem(new bytes32[](poolIds_.length));
    }

    /// @param publicValues SP1-committed public values: a fixed 461-byte head of
    ///        state/domain hashes, then an authenticated tail this call consumes —
    ///        deposit accumulators (checked against the mixer) and burn claim IDs
    ///        (marked accepted). Tail layout, all SP1-authenticated:
    ///        depositAccs[NUM_DENOMS*32] | counts[NUM_DENOMS*4 BE] | burnClaims[sum*32].
    /// @param proofBytes   The SP1 proof over publicValues.
    function proveStateTransition(
        bytes calldata publicValues,
        bytes calldata proofBytes
    ) external {
        SP1_VERIFIER.verifyProof(PROGRAM_VKEY, publicValues, proofBytes);
        if (publicValues.length < 461) revert InvalidProof();

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

        uint256 nd = NUM_DENOMS;

        // ── Authenticated tail: depositAccs[nd] | counts[nd] | burnClaims[sum] ──
        // newPoolsHash is the proven new pool state and is stored directly; the pool
        // roots themselves are never needed on-chain. depositAccs and the burn claims
        // are read straight from the SP1-authenticated public values.
        uint256 accsAt = 461;
        uint256 countsAt = accsAt + nd * 32;
        uint256 claimsAt = countsAt + nd * 4;
        if (publicValues.length < claimsAt) revert InvalidProof();

        // Deposit accumulators: tie to the committed hash, then check each is fresh
        // against the mixer (rejects a proof a later deposit has staled).
        if (sha256(publicValues[accsAt:countsAt]) != depositAccsHash) revert InvalidDepositRoot();
        for (uint256 i; i < nd; ++i) {
            if (_cd32(publicValues, accsAt + i * 32) != MIXER_CONTRACT.getRootAccumulator(poolIds[i])) {
                revert InvalidDepositRoot();
            }
        }

        // Burn claims: per-denom counts, then a flat run of claim IDs to accept.
        {
            bytes32[] memory burnBatches = new bytes32[](nd);
            uint256 off = claimsAt;
            for (uint256 i; i < nd; ++i) {
                uint256 cnt;
                assembly { cnt := shr(224, calldataload(add(publicValues.offset, add(countsAt, mul(i, 4))))) }
                if (cnt == 0) continue;
                uint256 spanEnd = off + cnt * 32;
                if (publicValues.length < spanEnd) revert InvalidProof();
                burnBatches[i] = sha256(publicValues[off:spanEnd]);
                for (uint256 j; j < cnt; ++j) {
                    bytes32 claimId = _cd32(publicValues, off + j * 32);
                    acceptedBurns[claimId] = true;
                    emit BurnClaimAccepted(claimId);
                }
                off = spanEnd;
            }
            if (_hashArrayMem(burnBatches) != burnsHash) revert InvalidProof();
            if (off != publicValues.length) revert InvalidProof();
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

    function _hashArrayMem(bytes32[] memory arr) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(arr));
    }

    function _cd32(bytes calldata data, uint256 off) private pure returns (bytes32 v) {
        assembly { v := calldataload(add(data.offset, off)) }
    }
}
