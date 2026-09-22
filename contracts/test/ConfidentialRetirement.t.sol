// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier, CdpLeg} from "../src/ConfidentialPool.sol";
import {ReflectionLib} from "../src/ReflectionLib.sol";
import {PoolStateReader} from "./PoolStateReader.sol";

using PoolStateReader for ConfidentialPool;

contract AcceptVerifierR is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract MockRelayR {
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

/// A pool-minted canonical ERC20 stand-in: the pool is its sole minter and burns it on wrap.
contract MockCanonicalR {
    address public immutable MINTER;

    constructor(address m) {
        MINTER = m;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function mint(address, uint256) external {}
    function burn(address, uint256) external {}
}

/// Lineage: a pool creates its own successor (`createNextGen`), the successor authenticates its
/// predecessor by construction and rebases from the predecessor's LIVE attested state at its first attest,
/// and a RETIRED pool keeps every exit and its reflection open while refusing new value
/// entry and every cross-lane primitive. The SP1 verifier is mocked (AcceptVerifierR): the point is what the
/// SOLIDITY enforces around a proof, not the guest.
contract ConfidentialRetirementTest is Test {
    bytes32 constant RELAY_VKEY = bytes32(uint256(0xBEEF));
    bytes32 constant PROGRAM_VKEY = bytes32(uint256(0xABCD));
    bytes32 constant ANCHOR = bytes32(uint256(0xB17C0));
    bytes32 constant POOL_ROOT = keccak256("btc-pool-root");
    bytes32 constant SPENT_ROOT = keccak256("btc-spent-root");
    bytes32 constant BURN_ROOT = keccak256("btc-burn-root");
    bytes32 constant SALT = keccak256("next-gen");
    uint256 constant CONFIRMATIONS = 6;

    MockRelayR relay;
    address verifier;
    ConfidentialPool pool;
    uint256 leafSeed;

    event GenerationRetired(address indexed successor);

    function setUp() public {
        vm.chainId(1);
        verifier = address(new AcceptVerifierR());
        relay = new MockRelayR(ANCHOR);
        bytes32 t = ANCHOR;
        for (uint256 i; i < CONFIRMATIONS; ++i) {
            bytes32 child = keccak256(abi.encodePacked("matured", ANCHOR, i));
            relay.setParent(child, t);
            t = child;
        }
        relay.setTip(t);
        pool = new ConfidentialPool(
            verifier, PROGRAM_VKEY, RELAY_VKEY, address(0), address(relay), ANCHOR, CONFIRMATIONS, bytes32(0),
            bytes32(0), address(0), address(this), address(0), address(0)
        );
        assertEq(pool.successor(), address(0));
    }

    // ──────────────────── helpers ────────────────────

    /// A successor's init code: this test contract stays the steward, the predecessor is `predecessor`, and
    /// the two reflected-genesis inputs are zero (a successor derives both by proof).
    function _initCode(address predecessor, bytes32 resumeDigest, bytes32 anchor) internal view returns (bytes memory) {
        return abi.encodePacked(
            type(ConfidentialPool).creationCode,
            abi.encode(
                verifier, PROGRAM_VKEY, RELAY_VKEY, address(0), address(relay), anchor, CONFIRMATIONS, resumeDigest,
                bytes32(0), address(0), address(this), predecessor, address(0)
            )
        );
    }

    function _createNext(ConfidentialPool p) internal returns (ConfidentialPool succ) {
        succ = ConfidentialPool(p.createNextGen(_initCode(address(p), bytes32(0), bytes32(0)), SALT));
    }

    function _binding(ConfidentialPool p) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(p.knownReflectionDigest(), p.bitcoinConsumedCount(), p.crossOutCount()));
    }

    function _handoffBinding(ConfidentialPool p) internal view returns (bytes32) {
        (uint256 consumed, uint256 crossOuts) = p.handoffCounts();
        return keccak256(abi.encodePacked(p.handoffReflectionDigest(), consumed, crossOuts));
    }

    /// A reflection batch's public values continuing from `prev`: a forward batch (rebased == 0) whose
    /// `priorDigest` is the pool's current digest, or — with `rebased` set — a successor's first cycle,
    /// whose `priorDigest` is the guest-derived successor genesis (`prior`), authenticated by `rebased`.
    function _relayPv(ConfidentialPool p, bytes32 prior, bytes32 prev, bytes32 rebased)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(
            ReflectionLib.BitcoinRelayPublicValues(
                prior,
                POOL_ROOT,
                SPENT_ROOT,
                BURN_ROOT,
                1, // bitcoinHeight
                keccak256(abi.encode(prior, "next")),
                prev, // bitcoinPrevHash
                ANCHOR, // bitcoinTipHash == the matured anchor
                bytes32(0),
                0, // cbtcBackingSats
                new ReflectionLib.CbtcLockFolded[](0),
                new bytes32[](0),
                new bytes32[](0),
                uint64(0), // consumedCount
                uint64(0), // crossOutCount
                uint64(0), // foldedCrossOutCount
                new ReflectionLib.AssetMeta[](0),
                new bytes32[](0),
                rebased,
                keccak256(abi.encodePacked(block.chainid, address(p))),
                new uint8[](0),
                new bytes32[](0),
                uint64(0),
                uint64(0)
            )
        );
    }

    function _attest(ConfidentialPool p) internal {
        p.attestBitcoinStateProven(_relayPv(p, p.knownReflectionDigest(), ANCHOR, bytes32(0)), "");
    }

    /// The successor's first cycle: rebased from `pred`'s live state, continuing from `pred`'s tip.
    function _rebase(ConfidentialPool succ, ConfidentialPool pred) internal {
        succ.attestBitcoinStateProven(_relayPv(succ, keccak256("successor-genesis"), ANCHOR, _binding(pred)), "");
    }

    /// A bare settle envelope bound to `p` (no inputs, no effects) — callers set the fields under test.
    function _pv(ConfidentialPool p) internal view returns (ConfidentialPool.PublicValues memory v) {
        v.version = 1;
        v.chainBinding = keccak256(abi.encodePacked(block.chainid, address(p)));
    }

    function _one(bytes32 x) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = x;
    }

    /// Give the settle one fresh note leaf (+ its memo, memoRoot bound) so the EVM reserve floor
    /// (#spent <= #leaves) admits one spend alongside it.
    function _withLeaf(ConfidentialPool.PublicValues memory v) internal returns (bytes[] memory memos) {
        bytes32 leaf = keccak256(abi.encodePacked("leaf", ++leafSeed));
        v.leaves = _one(leaf);
        bytes memory memo = abi.encodePacked("memo", leaf);
        v.memoRoot = keccak256(abi.encodePacked(bytes32(0), keccak256(memo)));
        memos = new bytes[](1);
        memos[0] = memo;
    }

    function _settle(ConfidentialPool p, ConfidentialPool.PublicValues memory v, bytes[] memory memos) internal {
        p.settle(abi.encode(v), "", memos);
    }

    /// A purely local EVM-homed spend: one existing note spent, one change leaf minted.
    function _localSpend(ConfidentialPool p) internal returns (ConfidentialPool.PublicValues memory v, bytes[] memory memos) {
        v = _pv(p);
        memos = _withLeaf(v);
        v.spendRoot = p.currentRoot();
        v.nullifiers = _one(keccak256(abi.encodePacked("nu", leafSeed)));
    }

    /// A Bitcoin-homed fast-lane spend (membership against the attested Bitcoin pool root).
    function _btcHomedSpend(ConfidentialPool p) internal returns (ConfidentialPool.PublicValues memory v) {
        v = _pv(p);
        v.spendRoot = POOL_ROOT;
        v.bitcoinSpentRoot = SPENT_ROOT;
        v.nullifiers = _one(keccak256(abi.encodePacked("btc-nu", ++leafSeed)));
        v.bitcoinConsumedSources = _one(keccak256("src-leaf"));
    }

    /// An Ethereum note burned for Bitcoin (crossOut) — the other cross-lane mover.
    function _crossOut(ConfidentialPool p) internal returns (ConfidentialPool.PublicValues memory v, bytes[] memory memos) {
        (v, memos) = _localSpend(p);
        v.crossOuts = new ConfidentialPool.CrossOut[](1);
        bytes32 nu = v.nullifiers[0];
        bytes32 dest = keccak256("dest");
        bytes32 asset = keccak256("asset");
        v.crossOuts[0] = ConfidentialPool.CrossOut({
            destChain: 1,
            destCommitment: dest,
            nullifier: nu,
            assetId: asset,
            claimId: keccak256(abi.encodePacked(uint16(1), dest, nu, asset))
        });
    }

    // ──────────────────── creating the successor ────────────────────

    function test_create_next_gen_is_steward_only_one_shot_and_lands_at_create2() public {
        bytes memory code = _initCode(address(pool), bytes32(0), bytes32(0));
        address predicted = vm.computeCreate2Address(SALT, keccak256(code), address(pool));
        vm.prank(address(0xBAD));
        vm.expectRevert(ConfidentialPool.NotAuthorized.selector);
        pool.createNextGen(code, SALT);
        vm.expectEmit(true, false, false, true);
        emit GenerationRetired(predicted);
        address next = pool.createNextGen(code, SALT);
        assertEq(next, predicted);
        assertEq(pool.successor(), next);
        assertTrue(next.code.length != 0);
        // one-shot: a pool has exactly one successor, ever
        vm.expectRevert(ConfidentialPool.AlreadyRetired.selector);
        pool.createNextGen(code, keccak256("another"));
        // a successor with no runtime code would end the lineage on the spot
        ConfidentialPool fresh = new ConfidentialPool(
            verifier, PROGRAM_VKEY, RELAY_VKEY, address(0), address(relay), ANCHOR, CONFIRMATIONS, bytes32(0),
            bytes32(0), address(0), address(this), address(0), address(0)
        );
        vm.expectRevert(ConfidentialPool.NotAContract.selector);
        fresh.createNextGen(hex"00", SALT);
        assertEq(fresh.successor(), address(0));
        // a pool with no steward can never retire
        ConfidentialPool lone = new ConfidentialPool(
            verifier, PROGRAM_VKEY, RELAY_VKEY, address(0), address(relay), ANCHOR, CONFIRMATIONS, bytes32(0),
            bytes32(0), address(0), address(0), address(0), address(0)
        );
        vm.expectRevert(ConfidentialPool.NotAuthorized.selector);
        lone.createNextGen(_initCode(address(lone), bytes32(0), bytes32(0)), SALT);
    }

    /// A successor exists only as its predecessor's creation, with nothing about its reflected
    /// genesis pinned: any other shape fails closed at construction.
    function test_successor_ctor_fails_closed() public {
        // deployed directly (the deployer is not the predecessor it names)
        vm.expectRevert(ConfidentialPool.BadGenerationalConfig.selector);
        new ConfidentialPool(
            verifier, PROGRAM_VKEY, RELAY_VKEY, address(0), address(relay), bytes32(0), CONFIRMATIONS, bytes32(0),
            bytes32(0), address(0), address(this), address(pool), address(0)
        );
        // created by the predecessor, but with a pinned resume digest / genesis anchor: the CREATE2 reverts
        vm.expectRevert(ConfidentialPool.NotAContract.selector);
        pool.createNextGen(_initCode(address(pool), bytes32(uint256(1)), bytes32(0)), SALT);
        vm.expectRevert(ConfidentialPool.NotAContract.selector);
        pool.createNextGen(_initCode(address(pool), bytes32(0), ANCHOR), SALT);
        assertEq(pool.successor(), address(0), "a failed creation retires nothing");
    }

    // ──────────────────── the successor's rebase ────────────────────

    /// The successor's first attest is authenticated by the predecessor's LIVE state — digest, counters and
    /// tip all read at that moment — so nothing is pinned at deploy and the predecessor is free to keep
    /// reflecting; a rebase built against an older predecessor state is simply rebuilt.
    function test_successor_rebases_from_predecessor_live_state() public {
        _attest(pool);
        _attest(pool);
        ConfidentialPool succ = _createNext(pool);
        bytes32 staleBinding = _binding(pool);
        // the retired predecessor keeps reflecting
        _attest(pool);
        assertTrue(_binding(pool) != staleBinding);
        // a rebase bound to the predecessor's earlier state is stale
        vm.expectRevert(ReflectionLib.StaleReflectionDigest.selector);
        succ.attestBitcoinStateProven(_relayPv(succ, keccak256("g"), ANCHOR, staleBinding), "");
        // a forward batch (no rebase) cannot be the successor's first cycle
        vm.expectRevert(ReflectionLib.StaleReflectionDigest.selector);
        succ.attestBitcoinStateProven(_relayPv(succ, succ.knownReflectionDigest(), ANCHOR, bytes32(0)), "");
        // a rebase continuing from a block that is not the predecessor's tip is unanchored
        vm.expectRevert(ReflectionLib.UnanchoredReflection.selector);
        succ.attestBitcoinStateProven(_relayPv(succ, keccak256("g"), keccak256("elsewhere"), _binding(pool)), "");
        // the current binding, from the predecessor's tip: the successor genesis is whatever the proof derived
        _rebase(succ, pool);
        assertEq(succ.knownReflectionDigest(), keccak256(abi.encode(keccak256("successor-genesis"), "next")));
        // exactly once: a second rebase-flagged proof is refused, ordinary cycles continue from its own digest
        vm.expectRevert(ReflectionLib.StaleReflectionDigest.selector);
        _rebase(succ, pool);
        _attest(succ);
        // and the successor is the active pool (past `notRetired`, it fails on the unregistered asset)
        vm.expectRevert(ConfidentialPool.NotRegistered.selector);
        succ.wrap(bytes32(0), 1, bytes32(0));
    }

    /// The predecessor's first attest after retirement fixes a handoff record; a rebase built against it
    /// stays valid however many times the predecessor attests afterwards, so no bystander with a prover can
    /// stale it. The live state stays accepted alongside (the previous test), and nothing else is.
    function test_successor_rebases_from_the_handoff_record_after_later_predecessor_attests() public {
        _attest(pool);
        ConfidentialPool succ = _createNext(pool);
        assertEq(pool.handoffReflectionDigest(), bytes32(0), "no record before the first attest after retirement");
        _attest(pool);
        bytes32 handoff = pool.handoffReflectionDigest();
        bytes32 handoffTip = pool.handoffReflectionTip();
        bytes32 binding = _handoffBinding(pool);
        assertEq(handoff, pool.knownReflectionDigest());
        assertEq(handoffTip, ANCHOR, "the record carries the tip that attest reached");
        _attest(pool);
        _attest(pool);
        assertEq(pool.handoffReflectionDigest(), handoff, "the record is written once");
        assertTrue(_binding(pool) != binding, "the live state moved on");
        succ.attestBitcoinStateProven(_relayPv(succ, keccak256("successor-genesis"), handoffTip, binding), "");
        assertEq(succ.knownReflectionDigest(), keccak256(abi.encode(keccak256("successor-genesis"), "next")));
        // and it is a one-shot like the live path
        vm.expectRevert(ReflectionLib.StaleReflectionDigest.selector);
        succ.attestBitcoinStateProven(_relayPv(succ, keccak256("successor-genesis"), handoffTip, binding), "");
    }

    // ──────────────────── a retired pool ────────────────────

    function _retirePool() internal {
        _attest(pool);
        _createNext(pool);
        assertTrue(pool.successor() != address(0));
    }

    function test_retired_keeps_reflecting_and_refuses_new_entry() public {
        bytes32 eth = pool.registerWrapped(address(0), 1e10, bytes32(0), "Ether", "ETH", 18);
        _retirePool();
        _attest(pool);
        vm.expectRevert(ConfidentialPool.PoolRetired.selector);
        pool.wrap{value: 1e10}(eth, 1e10, keccak256("c"));
        vm.expectRevert(ConfidentialPool.PoolRetired.selector);
        pool.farmEscrow(address(0xF0), keccak256("asset"), 1, address(this));
    }

    /// A retired pool's own canonical token is not new value: it was minted here on an exit, and
    /// burning it back into a note is how a borrower repays (or a keeper liquidates) a position after the
    /// handoff. Only an external asset is refused (above).
    function test_retired_still_wraps_its_own_canonical_token() public {
        MockCanonicalR token = new MockCanonicalR(address(pool));
        bytes32 id = pool.registerMinted(address(token), "Tacit Token", "TT", 8);
        _retirePool();
        pool.wrap(id, 1e10, keccak256("c"));
        assertEq(pool.depositStatus(keccak256(abi.encodePacked(id, uint256(1), keccak256("c")))), 1);
    }

    function test_retired_keeps_local_exits_open() public {
        _retirePool();
        // a local spend + change leaf
        (ConfidentialPool.PublicValues memory v, bytes[] memory memos) = _localSpend(pool);
        _settle(pool, v, memos);
        // a new stealth/adaptor lock (its claim/refund is the exit) and a claim/refund spend
        (v, memos) = _localSpend(pool);
        v.lockLeaves = _one(keccak256("lock"));
        bytes memory lockMemo = "lock-memo";
        v.memoRoot = keccak256(abi.encodePacked(v.memoRoot, keccak256(lockMemo)));
        bytes[] memory m2 = new bytes[](2);
        m2[0] = memos[0];
        m2[1] = lockMemo;
        _settle(pool, v, m2);
        (v, memos) = _localSpend(pool);
        v.lockSetRoot = pool.lockRoot();
        v.lockNullifiers = _one(keccak256("lock-nu"));
        _settle(pool, v, memos);
        // an LP REMOVE passes the retirement gate (and then fails only on the unseeded pool slot)
        v = _pv(pool);
        v.liquidity = new ConfidentialPool.LpSettlement[](1);
        v.liquidity[0] = ConfidentialPool.LpSettlement(keccak256("pool"), 10, 10, 10, 9, 9, 9);
        vm.expectRevert(ConfidentialPool.PoolNotInit.selector);
        _settle(pool, v, new bytes[](0));
        // a CDP close / top-up / harvest pass the gate (and then fail only on the codeless controller)
        v = _pv(pool);
        v.cdpCloses = new ConfidentialPool.CdpClose[](1);
        v.cdpCloses[0] = ConfidentialPool.CdpClose(address(0xC0), 0, 0, 0, keccak256("pos"), new CdpLeg[](0));
        vm.expectRevert(ConfidentialPool.BadCdpController.selector);
        _settle(pool, v, new bytes[](0));
        v = _pv(pool);
        v.cdpPositionRoot = pool.cdpRoot();
        v.cdpTopups = new ConfidentialPool.CdpTopup[](1);
        v.cdpTopups[0] = ConfidentialPool.CdpTopup(
            address(0xC0), 1, 1, keccak256("old"), keccak256("new"), new CdpLeg[](0), new CdpLeg[](0)
        );
        vm.expectRevert(ConfidentialPool.BadCdpController.selector);
        _settle(pool, v, new bytes[](0));
        v = _pv(pool);
        v.cdpMints = new ConfidentialPool.CdpMint[](1);
        v.cdpMints[0] = ConfidentialPool.CdpMint(
            address(0xC0), bytes32(0), 5, bytes32(uint256(1)), 0, new CdpLeg[](0), bytes32(0)
        ); // positionLeaf == 1, debtValue > 0: a harvest
        v.harvestActionIds = _one(keccak256("harvest"));
        vm.expectRevert(ConfidentialPool.BadCdpController.selector);
        _settle(pool, v, new bytes[](0));
    }

    /// A Bitcoin burn that targeted this pool is redeemable ONLY here (its id carries this
    /// pool's chain binding), so a retired pool must still pay it — including one that confirmed
    /// after the handoff, which is why its reflection stays open.
    function test_retired_still_pays_a_bridge_mint_targeting_it() public {
        _retirePool();
        _attest(pool); // the burn confirmed after the handoff: reflected here, after retirement
        ConfidentialPool.PublicValues memory v = _pv(pool);
        bytes[] memory memos = _withLeaf(v);
        bytes32 nu = keccak256("burned-nu");
        v.nullifiers = _one(nu);
        v.bitcoinBurnsConsumed = _one(nu);
        v.bitcoinBurnIdsConsumed = _one(keccak256("burn-id"));
        v.bitcoinRootsUsed = _one(POOL_ROOT);
        v.bitcoinBurnRoot = BURN_ROOT;
        _settle(pool, v, memos);
        assertTrue(pool.nullifierSpent(nu));
        assertEq(pool.nextLeafIndex(), 1);
        // a deferred-effect drain is likewise an exit (a deferred lock redemption feeds escrow reclaim):
        // it gets past the retirement gate and fails only on the empty queue.
        vm.expectRevert(ReflectionLib.MetaNotDeferred.selector);
        pool.drainOverflow(new bytes32[](0), 0, new ReflectionLib.CbtcLockFolded[](0), new ReflectionLib.AssetMeta[](0), new bytes32[](0));
    }

    /// A retired pool still crosses out: it is the Bitcoin exit for value held here (a bridged asset, or
    /// the cBTC a locker needs to redeem a lock registered here). The handoff record keeps the counters it was
    /// attested at, so a cross-out recorded afterwards cannot stale a rebase built against the record.
    function test_retired_still_crosses_out_and_the_handoff_record_keeps_its_counts() public {
        ConfidentialPool succ = _createNext(pool);
        // before the handoff record exists a cross-out waits, so none can stall the attest that writes it
        (ConfidentialPool.PublicValues memory early, bytes[] memory earlyMemos) = _crossOut(pool);
        vm.expectRevert(ConfidentialPool.PoolRetired.selector);
        _settle(pool, early, earlyMemos);
        _attest(pool);
        bytes32 binding = _handoffBinding(pool);
        bytes32 handoffTip = pool.handoffReflectionTip();
        (ConfidentialPool.PublicValues memory co, bytes[] memory coMemos) = _crossOut(pool);
        _settle(pool, co, coMemos);
        assertEq(pool.crossOutCount(), 1, "the cross-out is recorded on the retired generation");
        (uint256 consumed, uint256 crossOuts) = pool.handoffCounts();
        assertEq(consumed, 0);
        assertEq(crossOuts, 0, "the record keeps the count it was attested at");
        assertTrue(_binding(pool) != binding, "the live anchor moved with the cross-out");
        succ.attestBitcoinStateProven(_relayPv(succ, keccak256("successor-genesis"), handoffTip, binding), "");
        assertEq(succ.knownReflectionDigest(), keccak256(abi.encode(keccak256("successor-genesis"), "next")));
    }

    function test_retired_refuses_cross_lane() public {
        _retirePool();
        // Bitcoin-homed spend (shared reflected root)
        vm.expectRevert(ConfidentialPool.PoolRetired.selector);
        _settle(pool, _btcHomedSpend(pool), new bytes[](0));
        // swap
        ConfidentialPool.PublicValues memory v = _pv(pool);
        v.swaps = new ConfidentialPool.SwapSettlement[](1);
        vm.expectRevert(ConfidentialPool.PoolRetired.selector);
        _settle(pool, v, new bytes[](0));
        // LP add
        v = _pv(pool);
        v.liquidity = new ConfidentialPool.LpSettlement[](1);
        v.liquidity[0] = ConfidentialPool.LpSettlement(keccak256("pool"), 10, 10, 10, 11, 11, 11);
        vm.expectRevert(ConfidentialPool.PoolRetired.selector);
        _settle(pool, v, new bytes[](0));
        // cBTC mint
        v = _pv(pool);
        v.cbtcMints = new ConfidentialPool.CbtcMint[](1);
        vm.expectRevert(ConfidentialPool.PoolRetired.selector);
        _settle(pool, v, new bytes[](0));
        // a farm bond (positionLeaf 1, debtValue 0), a payout (0) and a real position (keccak leaf)
        bytes32[3] memory leaves = [bytes32(uint256(1)), bytes32(0), keccak256("position")];
        for (uint256 i; i < 3; ++i) {
            v = _pv(pool);
            v.cdpMints = new ConfidentialPool.CdpMint[](1);
            v.cdpMints[0] = ConfidentialPool.CdpMint(
                address(0xC0), bytes32(0), i == 0 ? 0 : 5, leaves[i], 0, new CdpLeg[](0), bytes32(0)
            );
            vm.expectRevert(ConfidentialPool.PoolRetired.selector);
            _settle(pool, v, new bytes[](0));
        }
    }
}
