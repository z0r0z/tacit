// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier, ICollateralEngine} from "../src/ConfidentialPool.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {PoolStateReader} from "./PoolStateReader.sol";

using PoolStateReader for ConfidentialPool;

contract AcceptVerifierX is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// Shared matured Bitcoin header relay (mirrors ConfidentialForwardLaneFreshness's MockRelayF): a linear
/// parent chain deep enough that a reflection batch anchoring to ANCHOR is buried REFLECTION_CONFIRMATIONS.
contract MockRelayX {
    bytes32 public tip;
    mapping(bytes32 => bytes32) public blockParent;

    constructor(bytes32 t) {
        tip = t;
    }

    function setTip(bytes32 t) external {
        tip = t;
    }

    function setParent(bytes32 child, bytes32 parent) external {
        blockParent[child] = parent;
    }
}

/// A CollateralEngine that reports escrow always-sufficient and is wired to its OWN pool. Using a per-pool
/// engine keeps this suite about C-01 (one Bitcoin source, two pool generations) and NOT C-02 (an engine
/// mis-bound to a foreign pool): each pool below owns an independently-funded engine, so the only shared
/// resource is the Bitcoin lock itself.
contract MockEngineX is ICollateralEngine {
    address public POOL;

    function setPool(address p) external {
        POOL = p;
    }

    function escrowSufficient(bytes32, uint256) external pure returns (bool) {
        return true;
    }
}

/// Cross-generation replay regression suite (the decisive test called for by the ConfidentialPool audit
/// exchange on C-01). The finding: a ConfidentialPool's Bitcoin single-use state — `nullifierSpent`,
/// `bitcoinConsumed`, `cbtcMinted` — is scoped to ONE contract, while the reflected Bitcoin roots/digest are
/// a SHARED lineage that any same-generation successor pool can resume. So two independently-deployed pools
/// that both recognize the same reflected Bitcoin pool root can each pass their own one-shot check against
/// the SAME Bitcoin source — one Bitcoin note / one Bitcoin lock backing value in two EVM pools.
///
/// These tests deploy TWO pools that both attest the same reflected Bitcoin state (the shared-lineage
/// condition), then drive the same Bitcoin authorization into both:
///   - test_same_btc_note_consumes_in_two_pools     — one Bitcoin-homed ν → a value leaf in A AND in B.
///   - test_same_cbtc_lock_mints_in_two_pools        — one Bitcoin cBTC lock outpoint → cBTC minted in A AND B.
/// Each is paired with a POSITIVE CONTROL proving the intra-pool guard is faithful (a second attempt in the
/// SAME pool reverts), so the failure is specifically the missing CROSS-pool / cross-generation dimension —
/// no global consumption authority binds the two instances.
///
/// Mechanics are exercised through the mock SP1 verifier (AcceptVerifierX): the guest's own non-membership /
/// conservation checks are out of scope here — the point is what the SOLIDITY enforces across instances.
contract ConfidentialCrossGenReplayTest is Test {
    bytes32 constant RELAY_VKEY = bytes32(uint256(0xBEEF));
    bytes32 constant PROGRAM_VKEY = bytes32(uint256(0xABCD));
    bytes32 constant ANCHOR = bytes32(uint256(0xB17C0));
    uint256 constant CONFIRMATIONS = 6;

    MockRelayX relay;
    address verifier;

    function setUp() public {
        vm.chainId(1);
        verifier = address(new AcceptVerifierX());
        relay = new MockRelayX(ANCHOR);
        // A matured chain: CONFIRMATIONS children above ANCHOR, so a batch whose tip == ANCHOR is buried deep
        // enough that _anchorReflection (relay.tip() walked back CONFIRMATIONS parents) lands on ANCHOR.
        bytes32 t = ANCHOR;
        for (uint256 i; i < CONFIRMATIONS; ++i) {
            bytes32 child = keccak256(abi.encodePacked("matured", ANCHOR, i));
            relay.setParent(child, t);
            t = child;
        }
        relay.setTip(t);
    }

    // ──────────────────── shared-lineage attestation ────────────────────

    // A forward reflection batch (ethPool == 0) that seeds `poolRoot` into knownBitcoinRoot and `spentRoot`
    // into knownBitcoinSpentRoot, optionally folding cBTC locks. Identical bytes attested to each pool make
    // the two instances recognize the same reflected Bitcoin state — the shared-lineage precondition.
    function _attest(
        ConfidentialPool pool,
        bytes32 poolRoot,
        bytes32 spentRoot,
        ConfidentialPool.CbtcLockFolded[] memory locks
    ) internal {
        bytes32 prior = pool.knownReflectionDigest();
        bytes32 next = keccak256(abi.encode(prior, poolRoot, spentRoot, "next"));
        bytes memory pv = abi.encode(
            ConfidentialPool.BitcoinRelayPublicValues(
                prior,
                poolRoot,
                spentRoot,
                keccak256("burn-sentinel"),
                1, // bitcoinHeight
                next,
                ANCHOR, // bitcoinPrevHash == lastReflectionBlockHash
                ANCHOR, // bitcoinTipHash (matured anchor)
                bytes32(0), // ethPoolReflected == 0 → forward batch
                0, // cbtcBackingSats
                locks,
                new bytes32[](0), // cbtcLocksSpent
                new bytes32[](0), // cbtcLocksRedeemed
                uint64(0), // consumedCount
                uint64(0), // crossOutCount
                uint64(0), // foldedCrossOutCount
                new ConfidentialPool.AssetMeta[](0),
                new bytes32[](0) // btcCallsFolded
            , bytes32(0), keccak256(abi.encodePacked(block.chainid, address(pool))), new uint8[](0))
        );
        pool.attestBitcoinStateProven(pv, "");
    }

    // A single-leaf settle envelope (one note leaf, one memo). Callers set the value-bearing fields.
    function _settle(ConfidentialPool pool, ConfidentialPool.PublicValues memory p, bytes32 leaf) internal {
        p.version = 1;
        p.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
        p.leaves = new bytes32[](1);
        p.leaves[0] = leaf;
        bytes memory memo = abi.encodePacked("memo", leaf);
        p.memoRoot = keccak256(abi.encodePacked(bytes32(0), keccak256(memo)));
        bytes[] memory memos = new bytes[](1);
        memos[0] = memo;
        pool.settle(abi.encode(p), "", memos);
    }

    function _newReflectingPool(address factory, address engine) internal returns (ConfidentialPool) {
        return new ConfidentialPool(
            verifier, PROGRAM_VKEY, RELAY_VKEY, factory, address(relay), ANCHOR, CONFIRMATIONS,
            bytes32(0), bytes32(0), engine
        , address(0), address(0));
    }

    // ──────────────────── C-01: fast-lane note double-consume ────────────────────

    /// One Bitcoin-homed note (nullifier ν) exits to a value LEAF in pool A AND, with a separately
    /// chain-bound proof, in pool B. Both settlements succeed and both record ν in their local
    /// `bitcoinConsumed` map — one Bitcoin source, two EVM-homed outputs. Each leaf is later unwrappable
    /// against its own pool's escrow (ConfidentialPool.sol:2414-2425 pays escrow-backed assets), so with two
    /// independently-funded generations this is double-extraction of exogenous depositor value, not merely a
    /// duplicated pool-minted token.
    function test_same_btc_note_consumes_in_two_pools() public {
        ConfidentialPool a = _newReflectingPool(address(0), address(0));
        ConfidentialPool b = _newReflectingPool(address(0), address(0));

        bytes32 poolRoot = keccak256("shared-btc-pool-root");
        bytes32 spentRoot = keccak256("shared-btc-spent-root"); // non-zero sentinel, as the guest seeds it
        ConfidentialPool.CbtcLockFolded[] memory noLocks = new ConfidentialPool.CbtcLockFolded[](0);

        // Both pools attest the SAME reflected Bitcoin state — the shared-lineage condition a gen-N resume
        // reproduces on mainnet (the live manifest resumes from a non-zero digest; here two genesis pools fold
        // the identical batch, which recognizes the same roots identically).
        _attest(a, poolRoot, spentRoot, noLocks);
        _attest(b, poolRoot, spentRoot, noLocks);

        bytes32 nu = keccak256("bitcoin-homed-nullifier");
        bytes32 src = keccak256("shared-btc-src-asset"); // consumed source's asset id (C-01 full-source binding)

        // Bitcoin-homed spend (spendRoot ∈ knownBitcoinRoot ⇒ btcHomed), non-membership pinned to the shared
        // spent root, value exits as an opaque leaf. Recorded once per pool.
        ConfidentialPool.PublicValues memory pa;
        pa.spendRoot = poolRoot;
        pa.bitcoinSpentRoot = spentRoot;
        pa.nullifiers = new bytes32[](1);
        pa.nullifiers[0] = nu;
        pa.bitcoinConsumedSources = new bytes32[](1);
        pa.bitcoinConsumedSources[0] = src;
        _settle(a, pa, keccak256("leaf-A"));

        ConfidentialPool.PublicValues memory pb;
        pb.spendRoot = poolRoot;
        pb.bitcoinSpentRoot = spentRoot;
        pb.nullifiers = new bytes32[](1);
        pb.nullifiers[0] = nu;
        pb.bitcoinConsumedSources = new bytes32[](1);
        pb.bitcoinConsumedSources[0] = src;
        _settle(b, pb, keccak256("leaf-B"));

        // The one-shot check is LOCAL to each contract: the same ν passed in both.
        bytes32 rec = keccak256(abi.encodePacked(poolRoot, src));
        assertEq(a.bitcoinConsumed(nu), rec, "pool A consumed the Bitcoin note");
        assertEq(b.bitcoinConsumed(nu), rec, "pool B consumed the SAME Bitcoin note");
        assertEq(a.bitcoinConsumedCount(), 1, "A recorded one consume");
        assertEq(b.bitcoinConsumedCount(), 1, "B recorded one consume");
        // No on-chain state links the two: neither reverted, both hold a value leaf from one Bitcoin source.
    }

    /// Positive control: within ONE pool the guard is real — the same ν cannot be consumed twice.
    function test_same_btc_note_reverts_within_one_pool() public {
        ConfidentialPool a = _newReflectingPool(address(0), address(0));
        bytes32 poolRoot = keccak256("shared-btc-pool-root");
        bytes32 spentRoot = keccak256("shared-btc-spent-root");
        _attest(a, poolRoot, spentRoot, new ConfidentialPool.CbtcLockFolded[](0));

        bytes32 nu = keccak256("bitcoin-homed-nullifier");
        bytes32 src = keccak256("shared-btc-src-asset");
        ConfidentialPool.PublicValues memory p;
        p.spendRoot = poolRoot;
        p.bitcoinSpentRoot = spentRoot;
        p.nullifiers = new bytes32[](1);
        p.nullifiers[0] = nu;
        p.bitcoinConsumedSources = new bytes32[](1);
        p.bitcoinConsumedSources[0] = src;
        _settle(a, p, keccak256("leaf-1"));

        ConfidentialPool.PublicValues memory p2;
        p2.spendRoot = poolRoot;
        p2.bitcoinSpentRoot = spentRoot;
        p2.nullifiers = new bytes32[](1);
        p2.nullifiers[0] = nu;
        p2.bitcoinConsumedSources = new bytes32[](1);
        p2.bitcoinConsumedSources[0] = src;
        vm.expectRevert(ConfidentialPool.NullifierAlreadySpent.selector);
        _settle(a, p2, keccak256("leaf-2"));
    }

    // ──────────────────── C-01: cBTC lock double-mint ────────────────────

    /// One Bitcoin cBTC lock outpoint mints a cBTC note in pool A AND in pool B — each gated only by its own
    /// `cbtcMinted[outpoint]` flag against its own always-sufficient engine escrow. One locked BTC backs two
    /// confidential cBTC obligations across the two generations.
    function test_same_cbtc_lock_mints_in_two_pools() public {
        (ConfidentialPool a,) = _newCbtcPool();
        (ConfidentialPool b,) = _newCbtcPool();

        bytes32 poolRoot = keccak256("shared-btc-pool-root");
        bytes32 spentRoot = keccak256("shared-btc-spent-root");
        bytes32 outpoint = keccak256("btc-cbtc-lock-outpoint");
        uint256 vBtc = 100_000_000; // 1 BTC in sats
        bytes32 commitment = keccak256("cbtc-note-commitment");

        ConfidentialPool.CbtcLockFolded[] memory locks = new ConfidentialPool.CbtcLockFolded[](1);
        locks[0] = ConfidentialPool.CbtcLockFolded(outpoint, vBtc, commitment);

        _attest(a, poolRoot, spentRoot, locks);
        _attest(b, poolRoot, spentRoot, locks);

        _cbtcMint(a, outpoint, vBtc, commitment, keccak256("cbtc-leaf-A"));
        _cbtcMint(b, outpoint, vBtc, commitment, keccak256("cbtc-leaf-B"));

        assertTrue(a.cbtcMinted(outpoint), "pool A minted cBTC against the lock");
        assertTrue(b.cbtcMinted(outpoint), "pool B minted cBTC against the SAME lock");
    }

    /// Positive control: within ONE pool the lock is one-shot — a second mint of the same outpoint reverts.
    function test_same_cbtc_lock_reverts_within_one_pool() public {
        (ConfidentialPool a,) = _newCbtcPool();
        bytes32 poolRoot = keccak256("shared-btc-pool-root");
        bytes32 spentRoot = keccak256("shared-btc-spent-root");
        bytes32 outpoint = keccak256("btc-cbtc-lock-outpoint");
        uint256 vBtc = 100_000_000;
        bytes32 commitment = keccak256("cbtc-note-commitment");

        ConfidentialPool.CbtcLockFolded[] memory locks = new ConfidentialPool.CbtcLockFolded[](1);
        locks[0] = ConfidentialPool.CbtcLockFolded(outpoint, vBtc, commitment);
        _attest(a, poolRoot, spentRoot, locks);

        _cbtcMint(a, outpoint, vBtc, commitment, keccak256("cbtc-leaf-1"));

        vm.expectRevert(ConfidentialPool.CbtcLockMismatch.selector);
        _cbtcMint(a, outpoint, vBtc, commitment, keccak256("cbtc-leaf-2"));
    }

    // A cBTC-capable pool: real CanonicalAssetFactory (constructor pins cBTC.tac / tacUSD) + a per-pool engine
    // reporting escrow always-sufficient and wired to itself (so C-02's foreign-engine binding is excluded).
    function _newCbtcPool() internal returns (ConfidentialPool pool, MockEngineX engine) {
        CanonicalAssetFactory factory = new CanonicalAssetFactory();
        engine = new MockEngineX();
        pool = _newReflectingPool(address(factory), address(engine));
        engine.setPool(address(pool));
    }

    function _cbtcMint(ConfidentialPool pool, bytes32 outpoint, uint256 vBtc, bytes32 commitment, bytes32 leaf)
        internal
    {
        ConfidentialPool.PublicValues memory p;
        p.cbtcMints = new ConfidentialPool.CbtcMint[](1);
        p.cbtcMints[0] = ConfidentialPool.CbtcMint(outpoint, vBtc, commitment);
        _settle(pool, p, leaf);
    }
}
