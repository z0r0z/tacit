// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface ISP1VerifierLib {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

interface IMintBurnLib {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function MINTER() external view returns (address);
}

interface IERC20MetadataLib {
    function decimals() external view returns (uint8);
}

interface IAssetIdLib {
    function ASSET_ID() external view returns (bytes32);
}

interface IRelayLib {
    function tip() external view returns (bytes32);
    function blockParent(bytes32 blockHash) external view returns (bytes32);
}

interface IPredecessorPoolLib {
    function attestedReflectionDigest() external view returns (bytes32);
    function attestedBitcoinConsumedCount() external view returns (uint256);
    function attestedCrossOutCount() external view returns (uint256);
    function attestedReflectionTip() external view returns (bytes32);
}

/// External reflection/attest surface for ConfidentialPool. Deployed separately and linked; every function
/// runs via DELEGATECALL from the pool, so it operates directly on the pool's storage via the mapping
/// storage-reference params, while value-type state travels in/out through the `ReflectionState` struct that
/// the pool writes back. Revert selectors match the pool's (see the error block below); the split exists only
/// to keep the immutable pool under EIP-170.
library ReflectionLib {
    /// Ancestor walk bound (mirrors the pool's constant of the same name).
    uint256 internal constant REFLECTION_MAX_LAG = 2016;

    /// A registered Tacit asset. Field order is storage-packing-significant, not cosmetic: the sub-word
    /// fields pack with the 20-byte address into ONE slot (1+20+1+1 = 23 <= 32), so the hot trio
    /// registered/poolMinted/underlying shares a single warm SLOAD on every wrap/payout, and a registration
    /// writes 3 slots. name/symbol are NOT stored — they ride the pool's `AssetRegistered` event.
    struct AssetStore {
        bool registered;
        address underlying; // ERC-20 backing; for poolMinted assets, the canonical ERC20 this pool mints/burns
        bool poolMinted; // true ⇒ this pool mints/burns the canonical ERC20; false ⇒ escrow-backed
        uint8 decimals;
        uint256 unitScale; // underlying base units per in-system value unit
        bytes32 crossChainLink; // Bitcoin-side asset id for shared-asset recognition (0 if none)
    }

    /// A confidential AMM pool slot (poolId => Pool). Declared here (not in the pool) so slot-management
    /// logic that touches it (`_ensurePair`) can delegate for the same EIP-170 reason AssetStore/register do.
    struct Pool {
        bool init;
        bytes32 assetA;
        bytes32 assetB;
        uint256 reserveA;
        uint256 reserveB;
        uint32 feeBps;
        uint256 totalShares;
    }

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
        // NESTING LEVEL of every root in `overflowRoots` (1 = a leaf chunk draining via `drainOverflow`
        // directly; N>1 = a meta chunk of N-1-level roots draining via `drainOverflowRoots`, which requeues
        // them one level down). A backlog spanning enough Bitcoin blocks can defer more LEAF CHUNKS than a
        // single attest can afford to enqueue (each queued root is its own SSTORE), so past
        // MAX_OVERFLOW_ROOTS_SURFACED the guest wraps `overflowRoots` itself the same way it wraps raw
        // leaves — recursively, until the top-level array attest() loops over is bounded regardless of how
        // large the backlog was. Zero (a hand-built PublicValues that leaves this field unset) is treated
        // as 1, since an empty or small `overflowRoots` never needed wrapping.
        uint64 overflowRootLevel;
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

    // Every error here that also exists in ConfidentialPool carries the SAME selector (identical
    // name+signature ⇒ identical selector), so a revert raised inside a delegatecall into this library is
    // indistinguishable to callers from one raised by the pool itself — a caller checking the pool's own
    // error still matches. Ordered by identifier length, then alphabetically.
    error ZeroVKey();
    error SameAsset();
    error FeeTooHigh();
    error PoolExists();
    error BadDecimals();
    error ZeroAddress();
    error NotAContract();
    error WrongEthPool();
    error ChainMismatch();
    error NotRegistered();
    error CanonicalAsset();
    error BadBtcCallPairs();
    error MetaNotDeferred();
    error StaleRelayProof();
    error ValueOutOfRange();
    error AmountNotAligned();
    error BadOverflowLevel();
    error CrossChainEscrow();
    error AlreadyRegistered();
    error ConsumedCountStale();
    error InsufficientEscrow();
    error CrossChainLinkTaken();
    error ZeroBitcoinPoolRoot();
    error StaleBitcoinBurnRoot();
    error UnanchoredReflection();
    error InsufficientLiquidity();
    error StaleBitcoinSpentRoot();
    error StaleReflectionDigest();
    error CrossChainTokenMismatch();
    error FeeOnTransferUnsupported();

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
        // The predecessor's attested tip is the block this generation's first cycle continues from; for
        // every later cycle (and every non-generational deploy) it is this generation's own last tip.
        bytes32 prevAnchor = st.lastReflectionBlockHash;
        if (cfg.predecessor != address(0) && !st.generationalRebaseSettled) {
            // MIGRATION cycle: the proof's `priorDigest` is the successor genesis the guest derived by
            // rebasing the predecessor state it witnessed, and `rebasedFromDigest` binds that witnessed
            // state to the predecessor's LIVE attested digest + drained counters (read here, never pinned at
            // deploy). That binding is what authenticates `priorDigest` on this one cycle — the predecessor
            // keeps reflecting after the handoff, so a proof built against an older predecessor state simply
            // fails this check and is rebuilt; nothing has to be redeployed.
            IPredecessorPoolLib pred = IPredecessorPoolLib(cfg.predecessor);
            bytes32 expected = keccak256(
                abi.encodePacked(
                    pred.attestedReflectionDigest(), pred.attestedBitcoinConsumedCount(), pred.attestedCrossOutCount()
                )
            );
            if (r.rebasedFromDigest != expected) revert StaleReflectionDigest();
            prevAnchor = pred.attestedReflectionTip();
            st.generationalRebaseSettled = true;
        } else {
            if (r.rebasedFromDigest != bytes32(0)) revert StaleReflectionDigest();
            if (r.priorDigest != st.knownReflectionDigest) revert StaleReflectionDigest();
        }
        if (r.newDigest == bytes32(0)) revert StaleReflectionDigest();
        if (r.bitcoinHeight < st.lastRelayHeight) revert StaleRelayProof();
        if (r.bitcoinSpentRoot == bytes32(0)) revert StaleBitcoinSpentRoot();
        if (r.bitcoinBurnRoot == bytes32(0)) revert StaleBitcoinBurnRoot();
        if (r.bitcoinPoolRoot == bytes32(0)) revert ZeroBitcoinPoolRoot();
        if (r.consumedCount != cfg.bitcoinConsumedCount) revert ConsumedCountStale();
        // Reuses ConsumedCountStale for the crossOut-count freshness check too (same backstop: the proof's
        // accounting must equal live on-chain state); the shared selector is intentional, not a copy-paste slip.
        if ((ethPool == address(this) ? r.crossOutCount : r.foldedCrossOutCount) != cfg.crossOutCount) {
            revert ConsumedCountStale();
        }
        if (cfg.headerRelay != address(0)) {
            _anchorReflection(cfg, prevAnchor, r.bitcoinPrevHash, r.bitcoinTipHash);
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
        // A backlog spanning many Bitcoin blocks can defer more leaf chunks than a single attest can afford
        // to enqueue (each is its own SSTORE); the guest wraps `overflowRoots` itself into higher-level
        // chunks when that happens (see the field doc), so this loop is bounded no matter how deep the
        // backlog. Level 0 (a hand-built proof that leaves the field unset) means "never wrapped" == 1.
        uint64 level = r.overflowRootLevel == 0 ? 1 : r.overflowRootLevel;
        for (uint256 i; i < r.overflowRoots.length; ++i) {
            bytes32 root = r.overflowRoots[i];
            if (root != bytes32(0) && overflowQueue[root] == 0) {
                overflowQueue[root] = level;
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
        // Level 1 == a leaf chunk (terminals/locks/metas/calls, the tag domain this function reconstructs).
        // A level>1 meta chunk (wrapped sub-roots, tag 0x06) is drained via `drainOverflowRoots` instead —
        // its `acc` lives in a disjoint hash domain, but the level check makes the split explicit rather
        // than relying on tag-domain separation alone.
        if (overflowQueue[acc] != 1) revert MetaNotDeferred();
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

    /// Unwrap one level of a wrapped overflow-root chunk: the caller re-supplies the exact `subroots` a
    /// deeper backlog forced the guest to fold under one meta-root (tag 0x06, disjoint from the leaf-chunk
    /// tag domain `drainOverflow` reconstructs), this recomputes that meta-root, and on a match requeues
    /// each subroot one level down — a level-1 subroot becomes directly `drainOverflow`-able, a level>1
    /// subroot is itself a further meta chunk needing another call here. Repeating this drains a backlog of
    /// any size down to its real leaf chunks, the same way `drainOverflow` always drains a leaf chunk of any
    /// content in one bounded transaction.
    function drainOverflowRoots(
        bytes32[] calldata subroots,
        uint64 level,
        ReflectionState memory st,
        mapping(bytes32 => uint64) storage overflowQueue
    ) external returns (ReflectionState memory) {
        if (level < 2) revert BadOverflowLevel();
        bytes32 acc;
        for (uint256 i; i < subroots.length; ++i) {
            acc = keccak256(abi.encodePacked(acc, keccak256(abi.encodePacked(uint8(0x06), subroots[i]))));
        }
        if (overflowQueue[acc] != level) revert MetaNotDeferred();
        delete overflowQueue[acc];
        unchecked {
            --st.pendingOverflowChunks;
        }
        uint64 childLevel = level - 1;
        for (uint256 i; i < subroots.length; ++i) {
            bytes32 root = subroots[i];
            if (root != bytes32(0) && overflowQueue[root] == 0) {
                overflowQueue[root] = childLevel;
                unchecked {
                    ++st.pendingOverflowChunks;
                }
            }
        }
        return st;
    }

    /// Release `value` in-system units of an asset to `to`, scaled to underlying by `unitScale`: mint the
    /// canonical ERC20 for a pool-minted asset (the note being released was already the backed unit — this
    /// only changes its form), or debit `escrow` and transfer the real underlying otherwise. All-scalar
    /// (no pool-local struct crosses the boundary; `escrow` is a plain `bytes32 => uint256` map, not tied to
    /// any pool-specific type), so this is a clean delegatecall extraction — `_payout`'s AssetStore lookup
    /// is the only part that has to stay on the pool side.
    function payout(
        bool poolMinted,
        address underlying,
        uint256 value,
        uint256 unitScale,
        address to,
        bytes32 assetId,
        mapping(bytes32 => uint256) storage escrow
    ) external returns (uint256 amount) {
        amount = value * unitScale;
        if (poolMinted) {
            IMintBurnLib(underlying).mint(to, amount);
        } else {
            if (escrow[assetId] < amount) revert InsufficientEscrow();
            unchecked {
                escrow[assetId] -= amount; // guarded by the check directly above
            }
            if (underlying == address(0)) {
                // Native ETH — force-send so a non-payable recipient can't stall the batch settle. Safe
                // under reentrancy: the escrow decrement is committed first (checks-effects-interactions)
                // and the pool's settle/payout paths hold nonReentrant, so even the gas-stipended call
                // forceSafeTransferETH attempts first (before its selfdestruct-push fallback) cannot
                // re-enter the pool.
                SafeTransferLib.forceSafeTransferETH(to, amount);
            } else {
                SafeTransferLib.safeTransfer(underlying, to, amount);
            }
        }
    }

    /// Move `amount` of an asset IN to the pool's custody: burn the canonical ERC20 (pool-minted, re-
    /// entering confidential), escrow native ETH, or escrow an external ERC20 with a realized-delta
    /// (fee-on-transfer) guard. `msg.sender`/`address(this)` resolve to the POOL under delegatecall, so this
    /// is a clean extraction — `_moveInUnderlying`'s AssetStore lookup is the only part that stays on the
    /// pool side.
    function moveInUnderlying(
        bool poolMinted,
        address underlying,
        bytes32 assetId,
        uint256 amount,
        mapping(bytes32 => uint256) storage escrow
    ) external {
        if (poolMinted) {
            IMintBurnLib(underlying).burn(msg.sender, amount);
        } else if (underlying == address(0)) {
            escrow[assetId] += amount; // native ETH — caller verified msg.value covers it
        } else {
            uint256 balBefore = SafeTransferLib.balanceOf(underlying, address(this));
            SafeTransferLib.safeTransferFrom(underlying, msg.sender, address(this), amount);
            if (SafeTransferLib.balanceOf(underlying, address(this)) - balBefore != amount) {
                revert FeeOnTransferUnsupported();
            }
            escrow[assetId] += amount;
        }
    }

    /// keccak-free asset id derivation (SHA256 precompile) — mirrors the pool's own `_evmAssetId`; lives
    /// here because `register` is its only caller on this side of the boundary.
    function _evmAssetId(address underlying) internal view returns (bytes32 assetId) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, shl(112, 0x74616369742d65766d2d746f6b656e2d7631)) // "tacit-evm-token-v1"
            mstore(add(m, 18), shl(192, chainid()))
            mstore(add(m, 26), shl(96, underlying))
            if iszero(staticcall(gas(), 2, m, 46, m, 32)) { revert(0, 0) }
            assetId := mload(m)
        }
    }

    /// Validate + write a new asset registration — the structural/decimals/cross-chain-link checks behind
    /// `ConfidentialPool._register`, kept here for EIP-170 headroom (mapping storage refs cross a
    /// delegatecall boundary cheaply, and `AssetStore` is declared in this library so the `_assets` mapping
    /// can). The pool wrapper emits `AssetRegistered` itself: name/symbol are display-only strings, and
    /// keeping them out of this call avoids marshaling them across the boundary for no logic benefit.
    ///
    /// `underlying == address(0)` is the NATIVE ETH sentinel — valid only for an escrow asset (a pool-minted
    /// asset must have a real canonical ERC20). An escrow registration (external ERC20) must be a deployed,
    /// non-canonical token: a canonical token of the pool registers only via the guest-proven minted path,
    /// and a not-yet-deployed canonical address must not be claimable as escrow (which would pre-empt its
    /// later auto-registration). A cross-chain link keys the entry by the SHARED id so bridged-in and
    /// wrapped-from-ERC20 supply are ONE fungible asset; only a pool-minted token that COMMITS to that id
    /// (ASSET_ID == link), or native ETH from the pool's own constructor, may back a linked asset — a foreign
    /// ERC20 escrow cannot (its backing the pool can't control).
    function register(
        address underlying,
        uint256 unitScale,
        bytes32 crossChainLink,
        bool poolMinted,
        uint8 decimals_,
        uint8 ethDecimals,
        mapping(bytes32 => AssetStore) storage assets_,
        mapping(bytes32 => bytes32) storage localAssetOf
    ) external returns (bytes32 assetId) {
        if (underlying == address(0) && poolMinted) revert ZeroAddress();
        if (unitScale == 0) revert AmountNotAligned();
        if (!poolMinted && underlying != address(0)) {
            if (underlying.code.length == 0) revert NotAContract();
            try IMintBurnLib(underlying).MINTER() returns (address mtr) {
                if (mtr == address(this)) revert CanonicalAsset();
            } catch {}
            uint8 d = IERC20MetadataLib(underlying).decimals();
            if (d > 77) revert BadDecimals();
            uint8 tacitDecimals = d > 8 ? 8 : d;
            if (decimals_ != d || unitScale != 10 ** uint256(d - tacitDecimals)) revert BadDecimals();
        }
        if (underlying == address(0) && (decimals_ != ethDecimals || unitScale != 10 ** 10)) revert BadDecimals();
        assetId = _evmAssetId(underlying);
        if (assets_[assetId].registered) revert AlreadyRegistered();
        if (crossChainLink != bytes32(0)) {
            assetId = crossChainLink;
            if (underlying == address(0)) {
                // native ETH (tETH): reached only from the pool's own constructor; the protocol's own
                // escrow is the bridged backing, and there is no token to commit.
            } else if (!poolMinted) {
                revert CrossChainEscrow();
            } else {
                try IAssetIdLib(underlying).ASSET_ID() returns (bytes32 aid) {
                    if (aid != crossChainLink) revert CrossChainTokenMismatch();
                } catch {
                    revert CrossChainTokenMismatch();
                }
            }
            if (localAssetOf[crossChainLink] != bytes32(0)) revert CrossChainLinkTaken();
            localAssetOf[crossChainLink] = assetId;
        }
        assets_[assetId] = AssetStore({
            registered: true,
            underlying: underlying,
            unitScale: unitScale,
            crossChainLink: crossChainLink,
            poolMinted: poolMinted,
            decimals: decimals_
        });
    }

    /// @dev Resolve a note's asset id to its local registry key: a native note carries the local id
    /// (already registered); a bridged note carries the SHARED (Bitcoin-side) id, which `localAssetOf` maps
    /// to the local entry. Returns the input unchanged if neither is registered. Mirrors the pool's own
    /// `_resolveAsset`, duplicated here alongside `ensurePair` since it exists only to feed it.
    function _resolveAsset(
        bytes32 assetId,
        mapping(bytes32 => AssetStore) storage assets_,
        mapping(bytes32 => bytes32) storage localAssetOf
    ) internal view returns (bytes32) {
        if (assets_[assetId].registered) return assetId;
        bytes32 local = localAssetOf[assetId];
        if (local != bytes32(0)) return local;
        return assetId;
    }

    /// Validate + (idempotently) initialize a confidential AMM pool slot — the body of
    /// `ConfidentialPool._ensurePair`, kept here for EIP-170 headroom; see its doc for the CANONICAL (sorted)
    /// pair + fee-bound poolId reasoning. SameAsset is checked on the RESOLVED (shared→local) ids so an alias
    /// of one underlying can't form a self-pair, while the pair still hashes/sorts/stores the passed ids so
    /// the poolId matches the guest, the router, and the shared-keyed escrow. `protocolFeeBps` is the
    /// fee-switch fraction of the LP fee, so it is not bounded by the swap-fee max; capped < 10000 to match
    /// the Bitcoin POOL_INIT bound (the lazy-mintFee `10000 - bps` denominator underflows at 10000).
    function ensurePair(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        uint8 rcptPrefix,
        bytes32 rcptX,
        uint32 protocolFeeBps,
        bool revertIfExists,
        uint32 maxPoolFeeBps,
        mapping(bytes32 => AssetStore) storage assets_,
        mapping(bytes32 => bytes32) storage localAssetOf,
        mapping(bytes32 => Pool) storage pools_
    ) external returns (bytes32 poolId) {
        bytes32 ra = _resolveAsset(assetA, assets_, localAssetOf);
        bytes32 rb = _resolveAsset(assetB, assets_, localAssetOf);
        if (ra == rb) revert SameAsset();
        if (!assets_[ra].registered || !assets_[rb].registered) revert NotRegistered();
        if (feeBps > maxPoolFeeBps || protocolFeeBps >= 10000) revert FeeTooHigh();
        (bytes32 lo, bytes32 hi) = assetA < assetB ? (assetA, assetB) : (assetB, assetA);
        poolId = protocolFeeBps == 0
            ? _poolId(lo, hi, feeBps)
            : keccak256(abi.encodePacked(lo, hi, bytes32(uint256(feeBps)), rcptPrefix, rcptX, bytes32(uint256(protocolFeeBps))));
        if (pools_[poolId].init) {
            if (revertIfExists) revert PoolExists();
            return poolId;
        }
        pools_[poolId] =
            Pool({init: true, assetA: lo, assetB: hi, reserveA: 0, reserveB: 0, feeBps: feeBps, totalShares: 0});
    }

    /// @dev Mirrors the pool's own `_poolId` (duplicated here alongside `ensurePair`, its only caller here).
    function _poolId(bytes32 lo, bytes32 hi, uint32 feeBps) internal pure returns (bytes32 poolId) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, lo)
            mstore(add(m, 0x20), hi)
            mstore(add(m, 0x40), and(feeBps, 0xffffffff))
            poolId := keccak256(m, 0x60)
        }
    }

    /// The reserve/totalShares conservation math for `ConfidentialPool.applyPublicAddLiquidity` (`Pool` is
    /// declared here so the slot can cross the boundary) — an add to an existing pool must mint no more
    /// than pro-rata for the reserves actually added (so minted shares can never be redeemed for more than
    /// backs them); a founding add caps `minted` at isqrt(vLo*vHi) so the founder can't over-mint. Returns
    /// the caller's off-ratio excess (0 if none) rather than paying it out itself, so the pool's own
    /// `_payout` (also delegated, but from the pool's calling context) still does the actual transfer/mint.
    function applyAddLiquidity(
        Pool storage p,
        uint256 vLo,
        uint256 vHi,
        uint256 minted,
        uint256 addLo,
        uint256 addHi,
        uint256 minimumLiquidity
    ) external returns (uint256 sharesMinted, uint256 refundLo, uint256 refundHi) {
        if (p.totalShares != 0) {
            if (
                minted == 0 || addLo > vLo || addHi > vHi || minted * p.reserveA > addLo * p.totalShares
                    || minted * p.reserveB > addHi * p.totalShares
            ) revert InsufficientLiquidity();
            p.reserveA += addLo;
            p.reserveB += addHi;
            p.totalShares += minted;
            if (p.reserveA > type(uint64).max || p.reserveB > type(uint64).max || p.totalShares > type(uint64).max)
            {
                revert ValueOutOfRange();
            }
            sharesMinted = minted;
            if (vLo > addLo) refundLo = vLo - addLo;
            if (vHi > addHi) refundHi = vHi - addHi;
        } else {
            if (minted * minted > vLo * vHi || minted <= minimumLiquidity) revert InsufficientLiquidity();
            p.reserveA = vLo;
            p.reserveB = vHi;
            p.totalShares = minted;
            sharesMinted = minted - minimumLiquidity;
        }
    }

    /// Anchor a reflection batch to canonical Bitcoin. Two independent gates:
    ///   * CONTINUITY — `prev` must equal the prior attested tip EXACTLY. This is the append-only cursor: no
    ///     skipping, no reordering, no replay, and (with the guest's `anchor_height == prior height + 1`) no
    ///     gap between one batch's last block and the next batch's first.
    ///   * CANONICALITY + MATURITY — `tip` must be the matured relay anchor (relay tip walked back
    ///     `reflectionConfirmations`) or an ancestor of it within REFLECTION_MAX_LAG. The batch's header chain
    ///     carries real proof-of-work on its own, so this walk is what rules out a privately-mined branch off
    ///     `prev`: only the relay's own fork choice decides which chain is canonical. Landing at or below the
    ///     matured anchor is also what buries every effect the batch folds.
    /// The two are deliberately independent. Continuity is where the append-only guarantee lives and is
    /// absolute; how FRESH the tip is only decides how many Bitcoin blocks a single proof has to span, which
    /// is why the lag bound is generous (see REFLECTION_MAX_LAG) while this exact-prev check is not.
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
        if (!_isAnchorOrAncestor(cfg.headerRelay, tip, matured)) revert UnanchoredReflection();
    }

    /// True iff `h == anchor` or `h` is within REFLECTION_MAX_LAG parents of `anchor`. The walk only ever
    /// descends the relay's canonical chain, so an orphaned block is never reachable however large the bound
    /// is — and a block at or above `anchor` is never reachable at all, which is what keeps the maturity
    /// (upper) bound absolute. The early exit makes the honest cost the batch's actual lag, not the bound.
    function _isAnchorOrAncestor(address headerRelay, bytes32 h, bytes32 anchor) internal view returns (bool) {
        if (h == bytes32(0)) return false;
        if (h == anchor) return true;
        bytes32 walk = anchor;
        for (uint256 i; i < REFLECTION_MAX_LAG; ++i) {
            walk = IRelayLib(headerRelay).blockParent(walk);
            if (walk == bytes32(0)) return false;
            if (walk == h) return true;
        }
        return false;
    }
}
