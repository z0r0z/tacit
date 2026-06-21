// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

/// Minimal mintable ERC20 backing an escrow-asset registration.
contract InvERC20 is ERC20 {
    string _n;
    string _s;
    uint8 _d;

    constructor(string memory n_, string memory s_, uint8 d_) {
        _n = n_;
        _s = s_;
        _d = d_;
    }

    function name() public view override returns (string memory) {
        return _n;
    }

    function symbol() public view override returns (string memory) {
        return _s;
    }

    function decimals() public view override returns (uint8) {
        return _d;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// Accept-all SP1 verifier: the proof system is exercised by the real-proof suite;
/// the invariant run pins the on-chain state machine GIVEN a valid proof — i.e. the
/// half of soundness the guest cannot backstop (escrow accounting, tree/root, relay).
contract AcceptAllVerifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external view {}
}

/// Fuzz driver: randomized wrap / deposit-consume / withdraw / fee / transfer / attest
/// against the pool, mirroring each effect into ghost accounting so the invariants can
/// assert the contract never drifts from the value it owes.
contract PoolHandler is Test {
    ConfidentialPool public pool;
    InvERC20 public tokenA;
    InvERC20 public tokenB;
    bytes32 public assetA;
    bytes32 public assetB;
    uint256 public scaleA;
    uint256 public scaleB;

    mapping(bytes32 => uint256) public ghostEscrow; // underlying owed per external asset
    uint256 public ghostLeaves;
    uint256 public ghostRelayHeight;

    // AMM ghost state: a single confidential pool over (assetA, assetB), funded once by initPoolOp.
    // ghostReserve tracks the in-system VALUE sitting in pool reserves per asset, so the invariants can
    // assert (a) the on-chain pool mirrors it and (b) escrow always backs it (reserves are escrowed,
    // never minted out of thin air). Note value lives in escrow MINUS reserves — withdraw/fee bound to
    // that free headroom, since pool-locked value can't be spent as a note.
    bool public poolInit;
    bytes32 public poolId;
    bytes32 public poolLo;
    bytes32 public poolHi;
    uint256 public scaleLo;
    uint256 public scaleHi;
    mapping(bytes32 => uint256) public ghostReserve;
    uint256 public ghostShares;
    uint32 constant POOL_FEE = 30;
    uint256 constant MIN_LIQ = 1000; // == pool.MINIMUM_LIQUIDITY()

    bytes32[] public pending; // unconsumed deposit ids
    uint256 internal nonce;

    constructor(ConfidentialPool p, InvERC20 a, InvERC20 b, bytes32 ida, bytes32 idb, uint256 sa, uint256 sb) {
        pool = p;
        tokenA = a;
        tokenB = b;
        assetA = ida;
        assetB = idb;
        scaleA = sa;
        scaleB = sb;
    }

    function _pv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
    }

    function _settle(ConfidentialPool.PublicValues memory pv) internal {
        pool.settle(abi.encode(pv), "", new bytes[](pv.leaves.length));
    }

    function _pick(uint256 seed) internal view returns (InvERC20 t, bytes32 id, uint256 scale) {
        if (seed & 1 == 0) return (tokenA, assetA, scaleA);
        return (tokenB, assetB, scaleB);
    }

    /// Escrow `amount` (aligned, in-system value ≤ u64) for a fresh note; record a pending deposit.
    function wrap(uint256 seed, uint256 amount) external {
        (InvERC20 t, bytes32 id, uint256 scale) = _pick(seed);
        amount = bound(amount, scale, scale * 1e12);
        amount -= amount % scale;
        if (amount == 0) return;
        uint256 value = amount / scale;
        if (value > type(uint64).max) return;
        bytes32 cx = keccak256(abi.encode("cx", nonce));
        bytes32 cy = keccak256(abi.encode("cy", nonce));
        bytes32 owner = keccak256(abi.encode("ow", nonce));
        nonce++;
        bytes32 depId = keccak256(abi.encode(id, value, keccak256(abi.encodePacked(cx, cy, owner))));
        if (pool.depositStatus(depId) != 0) return;
        t.mint(address(this), amount);
        t.approve(address(pool), amount);
        pool.wrap(id, amount, keccak256(abi.encodePacked(cx, cy, owner)));
        ghostEscrow[id] += amount;
        pending.push(depId);
    }

    /// Consume a pending deposit (inserts its note leaf).
    function consumeDeposit(uint256 seed) external {
        if (pending.length == 0) return;
        uint256 i = seed % pending.length;
        bytes32 depId = pending[i];
        if (pool.depositStatus(depId) != 1) _drop(i);
        return;
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.depositsConsumed = new bytes32[](1);
        pv.depositsConsumed[0] = depId;
        pv.leaves = new bytes32[](1);
        pv.leaves[0] = keccak256(abi.encode("leaf", depId));
        _settle(pv);
        ghostLeaves += 1;
        _drop(i);
    }

    function _drop(uint256 i) internal {
        pending[i] = pending[pending.length - 1];
        pending.pop();
    }

    /// Free (note-backing) escrow value for an asset: total escrow minus what's locked in pool reserves.
    /// A withdrawal/fee spends a NOTE, so it can only draw on this — pool-locked value isn't a note.
    function _freeValue(bytes32 id, uint256 scale) internal view returns (uint256) {
        uint256 esc = pool.escrow(id);
        uint256 reserved = ghostReserve[id] * scale;
        return esc <= reserved ? 0 : (esc - reserved) / scale;
    }

    /// Unwrap to a public recipient — bounded to the free (non-reserve) escrow so reserves stay backed.
    function withdraw(uint256 seed, uint256 value) external {
        (, bytes32 id, uint256 scale) = _pick(seed);
        uint256 free = _freeValue(id, scale);
        if (free == 0) return;
        value = bound(value, 1, free);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(id, address(0xBEEF), value);
        _settle(pv);
        ghostEscrow[id] -= value * scale;
    }

    /// Settler fee — also bounded to the free (non-reserve) escrow.
    function feePay(uint256 seed, uint256 value) external {
        (, bytes32 id, uint256 scale) = _pick(seed);
        uint256 free = _freeValue(id, scale);
        if (free == 0) return;
        value = bound(value, 1, free);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.fees = new ConfidentialPool.FeePayment[](1);
        pv.fees[0] = ConfidentialPool.FeePayment(id, value);
        _settle(pv);
        ghostEscrow[id] -= value * scale;
    }

    /// A transfer: spend k fresh nullifiers against the current (always-known) root,
    /// insert k fresh output leaves.
    function transferOp(uint256 seed) external {
        uint256 k = (seed % 3) + 1;
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = pool.currentRoot();
        pv.nullifiers = new bytes32[](k);
        pv.leaves = new bytes32[](k);
        for (uint256 j; j < k; ++j) {
            pv.nullifiers[j] = keccak256(abi.encode("nu", nonce, j));
            pv.leaves[j] = keccak256(abi.encode("lf", nonce, j));
        }
        nonce++;
        _settle(pv);
        ghostLeaves += k;
    }

    function _liveReserves() internal view returns (uint256 rA, uint256 rB) {
        (,,, rA, rB,,) = pool.pools(poolId);
    }

    /// Create the single confidential AMM pool over (assetA, assetB) and seed it with a FIRST MINT —
    /// createPair makes an empty slot, then the first LP funds the reserves FROM SHIELDED NOTES: wrap both
    /// legs (escrow), then a first-mint OP_LP_ADD spends those notes INTO the reserves (so escrow backs the
    /// reserves, never minted from thin air). One-shot. Reserves are above MINIMUM_LIQUIDITY on both legs.
    function initPoolOp(uint256 ra, uint256 rb) external {
        if (poolInit) return;
        ra = bound(ra, MIN_LIQ + 1, 1e9);
        rb = bound(rb, MIN_LIQ + 1, 1e9);
        poolId = pool.createPair(assetA, assetB, POOL_FEE);
        (poolLo, poolHi) = assetA < assetB ? (assetA, assetB) : (assetB, assetA);
        scaleLo = poolLo == assetA ? scaleA : scaleB;
        scaleHi = poolHi == assetA ? scaleA : scaleB;
        // Wrap both legs → escrow (the reserves' backing comes from the LP's notes, like any wrap).
        uint256 amtA = ra * scaleA;
        uint256 amtB = rb * scaleB;
        tokenA.mint(address(this), amtA);
        tokenA.approve(address(pool), amtA);
        tokenB.mint(address(this), amtB);
        tokenB.approve(address(pool), amtB);
        pool.wrap(
            assetA, amtA, keccak256(abi.encodePacked(keccak256("seedcxA"), keccak256("seedcyA"), keccak256("seedowA")))
        );
        pool.wrap(
            assetB, amtB, keccak256(abi.encodePacked(keccak256("seedcxB"), keccak256("seedcyB"), keccak256("seedowB")))
        );
        ghostEscrow[assetA] += amtA;
        ghostEscrow[assetB] += amtB;
        // First-mint settle: consume both deposits (insert their leaves), spend them into the reserves
        // (nullify), seed reserves + totalShares (rLo), mint the LP-share leaf.
        (uint256 rLo, uint256 rHi) = poolLo == assetA ? (ra, rb) : (rb, ra);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.spendRoot = pool.currentRoot();
        pv.depositsConsumed = new bytes32[](2);
        pv.depositsConsumed[0] = keccak256(
            abi.encode(
                assetA,
                ra,
                keccak256(abi.encodePacked(keccak256("seedcxA"), keccak256("seedcyA"), keccak256("seedowA")))
            )
        );
        pv.depositsConsumed[1] = keccak256(
            abi.encode(
                assetB,
                rb,
                keccak256(abi.encodePacked(keccak256("seedcxB"), keccak256("seedcyB"), keccak256("seedowB")))
            )
        );
        pv.nullifiers = new bytes32[](2);
        pv.nullifiers[0] = keccak256("seednuA");
        pv.nullifiers[1] = keccak256("seednuB");
        pv.leaves = new bytes32[](3); // 2 consumed-deposit leaves + 1 LP-share leaf
        pv.leaves[0] = keccak256("seedlfA");
        pv.leaves[1] = keccak256("seedlfB");
        pv.leaves[2] = keccak256("seedshare");
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = ConfidentialPool.LpSettlement(poolId, 0, 0, 0, rLo, rHi, rLo);
        _settle(pv);
        ghostReserve[assetA] += ra;
        ghostReserve[assetB] += rb;
        ghostShares = rLo;
        ghostLeaves += 3;
        poolInit = true;
    }

    /// An honest swap: move value INTO one reserve (bounded by the in-asset's free escrow, so reserves
    /// stay backed) and OUT of the other (kept positive). No escrow moves — the trader's note carries
    /// the value, conservation-bound in-guest. Pre is pinned to the live reserves so the contract's
    /// pre==live gate accepts it.
    function swapOp(uint256 dir, uint256 inSeed, uint256 outSeed) external {
        if (!poolInit) return;
        (uint256 rA, uint256 rB) = _liveReserves();
        bool inIsLo = dir & 1 == 0;
        bytes32 inId = inIsLo ? poolLo : poolHi;
        bytes32 outId = inIsLo ? poolHi : poolLo;
        uint256 inScale = inIsLo ? scaleLo : scaleHi;
        uint256 liveOut = inIsLo ? rB : rA;
        // In-leg can only grow into escrowed-but-unreserved value (free note headroom), capped at u64.
        uint256 head = pool.escrow(inId) / inScale - ghostReserve[inId];
        uint256 cap = uint256(type(uint64).max) - ghostReserve[inId];
        uint256 maxIn = head < cap ? head : cap;
        if (maxIn == 0 || liveOut <= 1) return;
        uint256 dIn = bound(inSeed, 1, maxIn);
        // Out leg bounded by the constant-product curve so the swap is k-non-decreasing — the guest's
        // OP_SWAP invariant, now also gated on-chain (ConstantProductDecreased). dOut ≤ rOut·dIn/(rIn+dIn)
        // ⇒ (rIn+dIn)·(rOut−dOut) ≥ rIn·rOut, so an honest handler swap is never rejected by that floor.
        uint256 rIn = inIsLo ? rA : rB;
        uint256 maxOut = (liveOut * dIn) / (rIn + dIn);
        if (maxOut == 0) return;
        uint256 dOut = bound(outSeed, 1, maxOut);
        uint256 newA = inIsLo ? rA + dIn : rA - dOut;
        uint256 newB = inIsLo ? rB - dOut : rB + dIn;
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.swaps = new ConfidentialPool.SwapSettlement[](1);
        pv.swaps[0] = ConfidentialPool.SwapSettlement(poolId, rA, rB, newA, newB);
        _settle(pv);
        ghostReserve[inId] += dIn;
        ghostReserve[outId] -= dOut;
    }

    /// An honest LP add or remove: reserves AND totalShares move together. Add grows both legs (bounded
    /// by free escrow, capped at u64) and shares; remove shrinks them, keeping each reserve positive and
    /// totalShares ≥ MINIMUM_LIQUIDITY. Escrow is untouched (the LP's notes carry the value).
    function lpOp(uint256 mode, uint256 s1, uint256 s2, uint256 s3) external {
        if (!poolInit) return;
        (uint256 rA, uint256 rB) = _liveReserves();
        uint256 shares = ghostShares;
        uint256 newA;
        uint256 newB;
        uint256 newS;
        if (mode & 1 == 0) {
            uint256 dA = bound(s1, 0, _addable(poolLo, scaleLo));
            uint256 dB = bound(s2, 0, _addable(poolHi, scaleHi));
            uint256 dS = bound(s3, 0, uint256(type(uint64).max) - shares);
            if (dA == 0 && dB == 0 && dS == 0) return;
            newA = rA + dA;
            newB = rB + dB;
            newS = shares + dS;
            _settleLp(rA, rB, shares, newA, newB, newS);
            ghostReserve[poolLo] += dA;
            ghostReserve[poolHi] += dB;
        } else {
            if (rA <= 1 || rB <= 1 || shares <= MIN_LIQ) return;
            uint256 dA = bound(s1, 0, rA - 1);
            uint256 dB = bound(s2, 0, rB - 1);
            uint256 dS = bound(s3, 0, shares - MIN_LIQ);
            newA = rA - dA;
            newB = rB - dB;
            newS = shares - dS;
            _settleLp(rA, rB, shares, newA, newB, newS);
            ghostReserve[poolLo] -= dA;
            ghostReserve[poolHi] -= dB;
        }
        ghostShares = newS;
    }

    // Free (non-reserve) headroom an add can grow a leg into, capped so the reserve stays < 2^64.
    function _addable(bytes32 id, uint256 scale) internal view returns (uint256) {
        uint256 head = pool.escrow(id) / scale - ghostReserve[id];
        uint256 cap = uint256(type(uint64).max) - ghostReserve[id];
        return head < cap ? head : cap;
    }

    function _settleLp(uint256 rA, uint256 rB, uint256 sp, uint256 nA, uint256 nB, uint256 nS) internal {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = ConfidentialPool.LpSettlement(poolId, rA, rB, sp, nA, nB, nS);
        _settle(pv);
    }

    /// Advance the relay (strictly increasing height, non-zero spent root).
    function attest(uint256 heightDelta, bytes32 spentSeed) external {
        uint64 newHeight = uint64(ghostRelayHeight + 1 + (heightDelta % 100));
        bytes32 spentRoot = keccak256(abi.encode("spent", spentSeed, newHeight));
        bytes32 burnRoot = keccak256(abi.encode("burn", spentSeed, newHeight));
        bytes32 poolRoot = keccak256(abi.encode("btcpool", spentSeed));
        bytes32 prior = pool.knownReflectionDigest();
        bytes32 next = keccak256(abi.encode(prior, poolRoot, spentRoot, burnRoot, newHeight));
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior,
            poolRoot,
            spentRoot,
            burnRoot,
            newHeight,
            next,
            bytes32(0),
            bytes32(0),
            bytes32(uint256(uint160(address(pool)))),
            0,
            new ConfidentialPool.CbtcLockFolded[](0),
            new bytes32[](0),
            new bytes32[](0),
            uint64(pool.bitcoinConsumedCount()),
            new ConfidentialPool.AssetMeta[](0),
            new bytes32[](0)
        );
        pool.attestBitcoinStateProven(abi.encode(r), "");
        ghostRelayHeight = newHeight;
    }
}

/// Stateful invariants for ConfidentialPool's on-chain bookkeeping. The verifier is
/// accept-all, so this is precisely the contract's responsibility surface: given a
/// proof the guest blessed, does the contract conserve escrow, keep the tree honest,
/// and advance the relay monotonically — across any reachable sequence of ops.
contract ConfidentialPoolInvariantTest is Test {
    ConfidentialPool pool;
    AcceptAllVerifier verifier;
    InvERC20 tokenA;
    InvERC20 tokenB;
    bytes32 assetA;
    bytes32 assetB;
    PoolHandler handler;

    uint256 constant SCALE_A = 1;
    uint256 constant SCALE_B = 1e10; // the dust-on-Eth case (value != amount)

    function setUp() public {
        vm.chainId(1);
        verifier = new AcceptAllVerifier();
        pool = new ConfidentialPool(
            address(verifier),
            bytes32(uint256(1)),
            bytes32(0),
            address(0),
            address(0),
            bytes32(0),
            6,
            bytes32(0),
            bytes32(0),
            address(0)
        );
        tokenA = new InvERC20("A", "A", 18);
        tokenB = new InvERC20("B", "B", 18);
        assetA = pool.registerWrapped(address(tokenA), SCALE_A, bytes32(0), "cA", "cA", 18);
        assetB = pool.registerWrapped(address(tokenB), SCALE_B, bytes32(0), "cB", "cB", 18);
        handler = new PoolHandler(pool, tokenA, tokenB, assetA, assetB, SCALE_A, SCALE_B);

        bytes4[] memory sel = new bytes4[](9);
        sel[0] = PoolHandler.wrap.selector;
        sel[1] = PoolHandler.consumeDeposit.selector;
        sel[2] = PoolHandler.withdraw.selector;
        sel[3] = PoolHandler.feePay.selector;
        sel[4] = PoolHandler.transferOp.selector;
        sel[5] = PoolHandler.attest.selector;
        sel[6] = PoolHandler.initPoolOp.selector;
        sel[7] = PoolHandler.swapOp.selector;
        sel[8] = PoolHandler.lpOp.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// The pool holds exactly what it owes, per asset: escrow == ghost == on-chain balance.
    /// No sequence of proof-blessed effects can pay out more than was escrowed.
    function invariant_escrowSolvency() public view {
        assertEq(pool.escrow(assetA), handler.ghostEscrow(assetA), "escrow A drift");
        assertEq(pool.escrow(assetB), handler.ghostEscrow(assetB), "escrow B drift");
        assertEq(tokenA.balanceOf(address(pool)), pool.escrow(assetA), "A held != owed");
        assertEq(tokenB.balanceOf(address(pool)), pool.escrow(assetB), "B held != owed");
    }

    /// The tree only grows, by exactly the leaves settle inserted.
    function invariant_leafCount() public view {
        assertEq(pool.nextLeafIndex(), handler.ghostLeaves(), "leaf count drift");
    }

    /// The on-chain pool mirrors the ghost reserves/shares exactly — every swap/LP settlement moved
    /// the pool to precisely the proven post, across any interleaving with wraps/withdraws/etc.
    function invariant_poolMirrorsGhost() public view {
        if (!handler.poolInit()) return;
        (,,, uint256 rA, uint256 rB,, uint256 sh) = pool.pools(handler.poolId());
        assertEq(rA, handler.ghostReserve(handler.poolLo()), "reserveA drift");
        assertEq(rB, handler.ghostReserve(handler.poolHi()), "reserveB drift");
        assertEq(sh, handler.ghostShares(), "totalShares drift");
    }

    /// Escrow always BACKS the value locked in pool reserves (the rest backs notes/pending): the AMM
    /// path's analog of escrow solvency. A swap/LP that grew a reserve past its escrow — or a withdraw
    /// that drained escrow out from under a reserve — would break this. Reserves are < 2^64, so the
    /// scaled product never overflows.
    function invariant_reservesBackedByEscrow() public view {
        assertGe(pool.escrow(assetA), handler.ghostReserve(assetA) * SCALE_A, "A reserves unbacked");
        assertGe(pool.escrow(assetB), handler.ghostReserve(assetB) * SCALE_B, "B reserves unbacked");
    }

    /// Every settle leaves the current root in the accepted-root history.
    function invariant_rootAlwaysKnown() public view {
        assertTrue(pool.everKnownRoot(pool.currentRoot()), "current root not known");
    }

    /// The relay height tracks the attested height and the reflected spent root is
    /// never the zero sentinel once any state has been attested (the cross-lane gate's
    /// non-vacuity precondition).
    function invariant_relayMonotonic() public view {
        if (handler.ghostRelayHeight() > 0) {
            assertTrue(pool.knownBitcoinSpentRoot() != bytes32(0), "zero spent root attested");
        }
    }
}
