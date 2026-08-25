// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface ISP1VerifierLib {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

interface IRelayLib {
    function tip() external view returns (bytes32);
    function blockParent(bytes32 blockHash) external view returns (bytes32);
}

interface IPredecessorPoolLib {
    function attestedReflectionDigest() external view returns (bytes32);
    function attestedBitcoinConsumedCount() external view returns (uint256);
    function attestedCrossOutCount() external view returns (uint256);
}

/// External reflection/attest surface for ConfidentialPool. Deployed separately and linked; every function
/// runs via DELEGATECALL from the pool, so it operates directly on the pool's storage via the mapping
/// storage-reference params, while value-type state travels in/out through the `ReflectionState` struct that
/// the pool writes back. Behaviour, revert selectors, event emissions and storage effects are byte-identical
/// to the original in-pool code — only the code lives here to keep the immutable pool under EIP-170.
library ReflectionLib {
    /// Reorg walk bound (mirrors the pool's constant of the same name).
    uint256 internal constant REFLECTION_FINALITY_WINDOW = 36;

    struct CbtcLockFolded {
        bytes32 outpoint;
        uint256 vBtc;
        bytes32 commitment;
    }

    struct AssetMeta {
        bytes32 assetId;
        bytes16 ticker;
        uint8 tickerLen;
        uint8 decimals;
        bytes32 cid;
    }

    struct BitcoinRelayPublicValues {
        bytes32 priorDigest;
        bytes32 bitcoinPoolRoot;
        bytes32 bitcoinSpentRoot;
        bytes32 bitcoinBurnRoot;
        uint64 bitcoinHeight;
        bytes32 newDigest;
        bytes32 bitcoinPrevHash;
        bytes32 bitcoinTipHash;
        bytes32 ethPoolReflected;
        uint256 cbtcBackingSats;
        CbtcLockFolded[] cbtcLocksFolded;
        bytes32[] cbtcLocksSpent;
        bytes32[] cbtcLocksRedeemed;
        uint64 consumedCount;
        uint64 crossOutCount;
        uint64 foldedCrossOutCount;
        AssetMeta[] attestedAssetMetas;
        bytes32[] btcCallsFolded;
        bytes32 rebasedFromDigest;
        bytes32 chainBinding;
        uint8[] consumedBound;
        bytes32[] overflowRoots;
        uint64 overflowCount;
    }

    /// Value-type pool state the attest mutates: passed in with the pool's current values, returned updated,
    /// and written back by the thin pool wrapper (external libraries can't hold storage refs to value types).
    struct ReflectionState {
        bytes32 knownReflectionDigest;
        bytes32 knownBitcoinSpentRoot;
        bytes32 knownBitcoinBurnRoot;
        uint256 cbtcBackingSats;
        bytes32 lastReflectionBlockHash;
        uint64 lastRelayHeight;
        bool generationalRebaseSettled;
        uint256 pendingOverflowChunks;
    }

    /// Immutable/read-only inputs the attest reads (immutables + the two freshness counters).
    struct Config {
        address sp1Verifier;
        address headerRelay;
        address predecessor;
        bytes32 bitcoinRelayVkey;
        bytes32 chainBinding;
        uint256 reflectionConfirmations;
        uint256 bitcoinConsumedCount;
        uint256 crossOutCount;
    }

    error ZeroVKey();
    error WrongEthPool();
    error ChainMismatch();
    error StaleReflectionDigest();
    error StaleRelayProof();
    error StaleBitcoinSpentRoot();
    error StaleBitcoinBurnRoot();
    error ZeroBitcoinPoolRoot();
    error ConsumedCountStale();
    error UnanchoredReflection();
    error ValueOutOfRange();
    error BadBtcCallPairs();
    error MetaNotDeferred();

    /// The attest body. Returns the updated value-state and the asset metas the pool should lazy-register
    /// (registration is left in the pool — it touches disjoint storage, so surfacing it after the returns is
    /// order-independent w.r.t. the lock/terminal effects applied here).
    function attest(
        bytes calldata publicValues,
        bytes calldata proofBytes,
        Config memory cfg,
        ReflectionState memory st,
        mapping(bytes32 => bool) storage knownBitcoinRoot,
        mapping(bytes32 => uint64) storage cbtcLockVBtc,
        mapping(bytes32 => bytes32) storage cbtcLockCommitment,
        mapping(bytes32 => bool) storage cbtcLockSpent,
        mapping(bytes32 => bool) storage cbtcLockRedeemed,
        mapping(bytes32 => bytes32) storage pendingBtcCall,
        mapping(bytes32 => uint64) storage overflowQueue
    ) external returns (ReflectionState memory, AssetMeta[] memory metasToRegister) {
        if (cfg.bitcoinRelayVkey == bytes32(0)) revert ZeroVKey();
        ISP1VerifierLib(cfg.sp1Verifier).verifyProof(cfg.bitcoinRelayVkey, publicValues, proofBytes);
        BitcoinRelayPublicValues memory r = abi.decode(publicValues, (BitcoinRelayPublicValues));
        address ethPool = address(uint160(uint256(r.ethPoolReflected)));
        if (ethPool != address(this) && ethPool != address(0)) revert WrongEthPool();
        if (r.chainBinding != cfg.chainBinding) revert ChainMismatch();
        if (cfg.predecessor != address(0) && !st.generationalRebaseSettled) {
            bytes32 expected = keccak256(
                abi.encodePacked(
                    IPredecessorPoolLib(cfg.predecessor).attestedReflectionDigest(),
                    IPredecessorPoolLib(cfg.predecessor).attestedBitcoinConsumedCount(),
                    IPredecessorPoolLib(cfg.predecessor).attestedCrossOutCount()
                )
            );
            if (r.rebasedFromDigest != expected) revert StaleReflectionDigest();
            st.generationalRebaseSettled = true;
        } else if (r.rebasedFromDigest != bytes32(0)) {
            revert StaleReflectionDigest();
        }
        if (r.priorDigest != st.knownReflectionDigest) revert StaleReflectionDigest();
        if (r.newDigest == bytes32(0)) revert StaleReflectionDigest();
        if (r.bitcoinHeight < st.lastRelayHeight) revert StaleRelayProof();
        if (r.bitcoinSpentRoot == bytes32(0)) revert StaleBitcoinSpentRoot();
        if (r.bitcoinBurnRoot == bytes32(0)) revert StaleBitcoinBurnRoot();
        if (r.bitcoinPoolRoot == bytes32(0)) revert ZeroBitcoinPoolRoot();
        if (r.consumedCount != cfg.bitcoinConsumedCount) revert ConsumedCountStale();
        if ((ethPool == address(this) ? r.crossOutCount : r.foldedCrossOutCount) != cfg.crossOutCount) {
            revert ConsumedCountStale();
        }
        if (cfg.headerRelay != address(0)) {
            _anchorReflection(cfg, st.lastReflectionBlockHash, r.bitcoinPrevHash, r.bitcoinTipHash);
            st.lastReflectionBlockHash = r.bitcoinTipHash;
        }
        st.lastRelayHeight = r.bitcoinHeight;
        knownBitcoinRoot[r.bitcoinPoolRoot] = true;
        st.knownBitcoinSpentRoot = r.bitcoinSpentRoot;
        st.knownBitcoinBurnRoot = r.bitcoinBurnRoot;
        st.knownReflectionDigest = r.newDigest;
        st.cbtcBackingSats = r.cbtcBackingSats;
        for (uint256 i; i < r.cbtcLocksFolded.length; ++i) {
            CbtcLockFolded memory f = r.cbtcLocksFolded[i];
            if (f.vBtc == 0 || f.vBtc > type(uint64).max) revert ValueOutOfRange();
            if (
                f.outpoint == bytes32(0) || cbtcLockVBtc[f.outpoint] != 0 || cbtcLockSpent[f.outpoint]
                    || cbtcLockRedeemed[f.outpoint]
            ) continue;
            cbtcLockVBtc[f.outpoint] = uint64(f.vBtc);
            cbtcLockCommitment[f.outpoint] = f.commitment;
        }
        for (uint256 i; i < r.cbtcLocksSpent.length; ++i) {
            bytes32 outpoint = r.cbtcLocksSpent[i];
            if (outpoint == bytes32(0) || cbtcLockSpent[outpoint] || cbtcLockRedeemed[outpoint]) continue;
            cbtcLockSpent[outpoint] = true;
        }
        for (uint256 i; i < r.cbtcLocksRedeemed.length; ++i) {
            bytes32 outpoint = r.cbtcLocksRedeemed[i];
            if (outpoint == bytes32(0) || cbtcLockSpent[outpoint] || cbtcLockRedeemed[outpoint]) continue;
            cbtcLockRedeemed[outpoint] = true;
        }
        bytes32[] memory calls = r.btcCallsFolded;
        if (calls.length % 2 != 0) revert BadBtcCallPairs();
        for (uint256 i; i + 1 < calls.length; i += 2) {
            pendingBtcCall[calls[i]] = calls[i + 1];
        }
        for (uint256 i; i < r.overflowRoots.length; ++i) {
            bytes32 root = r.overflowRoots[i];
            if (root != bytes32(0) && overflowQueue[root] == 0) {
                overflowQueue[root] = 1;
                unchecked {
                    ++st.pendingOverflowChunks;
                }
            }
        }
        return (st, r.attestedAssetMetas);
    }

    /// Drain one deferred overflow chunk. Terminals are applied BEFORE lock registration (opposite of attest,
    /// per the guest's committed leaf order). Returns the metas the pool should lazy-register.
    function drainOverflow(
        bytes32[] calldata terminals,
        uint256 spentCount,
        CbtcLockFolded[] calldata locks,
        AssetMeta[] calldata metas,
        bytes32[] calldata calls,
        ReflectionState memory st,
        mapping(bytes32 => uint64) storage overflowQueue,
        mapping(bytes32 => uint64) storage cbtcLockVBtc,
        mapping(bytes32 => bytes32) storage cbtcLockCommitment,
        mapping(bytes32 => bool) storage cbtcLockSpent,
        mapping(bytes32 => bool) storage cbtcLockRedeemed,
        mapping(bytes32 => bytes32) storage pendingBtcCall
    ) external returns (ReflectionState memory, AssetMeta[] memory metasToRegister) {
        if (calls.length % 2 != 0 || spentCount > terminals.length) revert BadBtcCallPairs();
        bytes32 acc;
        for (uint256 i; i < terminals.length; ++i) {
            acc = keccak256(
                abi.encodePacked(acc, keccak256(abi.encodePacked(i < spentCount ? uint8(0x04) : uint8(0x05), terminals[i])))
            );
        }
        for (uint256 i; i < locks.length; ++i) {
            if (locks[i].vBtc == 0 || locks[i].vBtc > type(uint64).max) revert ValueOutOfRange();
            bytes32 leaf =
                keccak256(abi.encodePacked(uint8(0x01), locks[i].outpoint, uint64(locks[i].vBtc), locks[i].commitment));
            acc = keccak256(abi.encodePacked(acc, leaf));
        }
        for (uint256 i; i < metas.length; ++i) {
            bytes32 leaf = keccak256(
                abi.encodePacked(uint8(0x02), metas[i].assetId, metas[i].ticker, metas[i].tickerLen, metas[i].decimals, metas[i].cid)
            );
            acc = keccak256(abi.encodePacked(acc, leaf));
        }
        for (uint256 i; i + 1 < calls.length; i += 2) {
            bytes32 leaf = keccak256(abi.encodePacked(uint8(0x03), calls[i], calls[i + 1]));
            acc = keccak256(abi.encodePacked(acc, leaf));
        }
        if (overflowQueue[acc] == 0) revert MetaNotDeferred();
        delete overflowQueue[acc];
        unchecked {
            --st.pendingOverflowChunks;
        }
        for (uint256 i; i < terminals.length; ++i) {
            bytes32 op = terminals[i];
            if (op == bytes32(0) || cbtcLockSpent[op] || cbtcLockRedeemed[op]) continue;
            if (i < spentCount) cbtcLockSpent[op] = true;
            else cbtcLockRedeemed[op] = true;
        }
        for (uint256 i; i < locks.length; ++i) {
            bytes32 op = locks[i].outpoint;
            if (op == bytes32(0) || cbtcLockVBtc[op] != 0 || cbtcLockSpent[op] || cbtcLockRedeemed[op]) continue;
            cbtcLockVBtc[op] = uint64(locks[i].vBtc);
            cbtcLockCommitment[op] = locks[i].commitment;
        }
        for (uint256 i; i + 1 < calls.length; i += 2) {
            pendingBtcCall[calls[i]] = calls[i + 1];
        }
        return (st, metas);
    }

    /// Anchor a reflection batch to canonical Bitcoin: `prev` must equal the prior attested tip; `tip` must be
    /// the matured relay anchor (relay tip walked back `reflectionConfirmations`) or a recent ancestor of it.
    function _anchorReflection(Config memory cfg, bytes32 lastReflectionBlockHash, bytes32 prev, bytes32 tip)
        internal
        view
    {
        if (prev != lastReflectionBlockHash) revert UnanchoredReflection();
        bytes32 matured = IRelayLib(cfg.headerRelay).tip();
        for (uint256 i; i < cfg.reflectionConfirmations; ++i) {
            if (matured == bytes32(0)) revert UnanchoredReflection();
            matured = IRelayLib(cfg.headerRelay).blockParent(matured);
        }
        if (!_isTipOrRecentAncestor(cfg.headerRelay, tip, matured)) revert UnanchoredReflection();
    }

    /// True iff `h == anchor` or `h` is within REFLECTION_FINALITY_WINDOW parents of `anchor`.
    function _isTipOrRecentAncestor(address headerRelay, bytes32 h, bytes32 anchor) internal view returns (bool) {
        if (h == bytes32(0)) return false;
        if (h == anchor) return true;
        bytes32 walk = anchor;
        for (uint256 i; i < REFLECTION_FINALITY_WINDOW; ++i) {
            walk = IRelayLib(headerRelay).blockParent(walk);
            if (walk == bytes32(0)) return false;
            if (walk == h) return true;
        }
        return false;
    }
}
