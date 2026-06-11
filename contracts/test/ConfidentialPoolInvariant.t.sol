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
    constructor(string memory n_, string memory s_, uint8 d_) { _n = n_; _s = s_; _d = d_; }
    function name() public view override returns (string memory) { return _n; }
    function symbol() public view override returns (string memory) { return _s; }
    function decimals() public view override returns (uint8) { return _d; }
    function mint(address to, uint256 a) external { _mint(to, a); }
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

    bytes32[] public pending; // unconsumed deposit ids
    uint256 internal nonce;

    constructor(
        ConfidentialPool p,
        InvERC20 a,
        InvERC20 b,
        bytes32 ida,
        bytes32 idb,
        uint256 sa,
        uint256 sb
    ) {
        pool = p; tokenA = a; tokenB = b; assetA = ida; assetB = idb; scaleA = sa; scaleB = sb;
    }

    function _pv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = pool.PV_VERSION();
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
        bytes32 depId = keccak256(abi.encode(id, value, cx, cy, owner));
        if (pool.depositStatus(depId) != 0) return;
        t.mint(address(this), amount);
        t.approve(address(pool), amount);
        pool.wrap(id, amount, cx, cy, owner);
        ghostEscrow[id] += amount;
        pending.push(depId);
    }

    /// Consume a pending deposit (inserts its note leaf).
    function consumeDeposit(uint256 seed) external {
        if (pending.length == 0) return;
        uint256 i = seed % pending.length;
        bytes32 depId = pending[i];
        if (pool.depositStatus(depId) != 1) { _drop(i); return; }
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

    /// Unwrap to a public recipient — bounded so the payout never exceeds escrow.
    function withdraw(uint256 seed, uint256 value) external {
        (, bytes32 id, uint256 scale) = _pick(seed);
        uint256 esc = pool.escrow(id);
        if (esc < scale) return;
        value = bound(value, 1, esc / scale);
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(id, address(0xBEEF), value);
        _settle(pv);
        ghostEscrow[id] -= value * scale;
    }

    /// Settler fee — also bounded by escrow.
    function feePay(uint256 seed, uint256 value) external {
        (, bytes32 id, uint256 scale) = _pick(seed);
        uint256 esc = pool.escrow(id);
        if (esc < scale) return;
        value = bound(value, 1, esc / scale);
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

    /// Advance the relay (strictly increasing height, non-zero spent root).
    function attest(uint256 heightDelta, bytes32 spentSeed) external {
        uint64 newHeight = uint64(ghostRelayHeight + 1 + (heightDelta % 100));
        bytes32 spentRoot = keccak256(abi.encode("spent", spentSeed, newHeight));
        bytes32 burnRoot = keccak256(abi.encode("burn", spentSeed, newHeight));
        bytes32 poolRoot = keccak256(abi.encode("btcpool", spentSeed));
        bytes32 prior = pool.knownReflectionDigest();
        bytes32 next = keccak256(abi.encode(prior, poolRoot, spentRoot, burnRoot, newHeight));
        ConfidentialPool.BitcoinRelayPublicValues memory r = ConfidentialPool.BitcoinRelayPublicValues(
            prior, poolRoot, spentRoot, burnRoot, newHeight, next
        , bytes32(0), bytes32(0));
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
        pool = new ConfidentialPool(address(verifier), bytes32(uint256(1)), bytes32(0), address(0), address(0), bytes32(0));
        tokenA = new InvERC20("A", "A", 18);
        tokenB = new InvERC20("B", "B", 18);
        assetA = pool.registerWrapped(address(tokenA), SCALE_A, bytes32(0), "cA", "cA", 18);
        assetB = pool.registerWrapped(address(tokenB), SCALE_B, bytes32(0), "cB", "cB", 18);
        handler = new PoolHandler(pool, tokenA, tokenB, assetA, assetB, SCALE_A, SCALE_B);

        bytes4[] memory sel = new bytes4[](6);
        sel[0] = PoolHandler.wrap.selector;
        sel[1] = PoolHandler.consumeDeposit.selector;
        sel[2] = PoolHandler.withdraw.selector;
        sel[3] = PoolHandler.feePay.selector;
        sel[4] = PoolHandler.transferOp.selector;
        sel[5] = PoolHandler.attest.selector;
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

    /// Every settle leaves the current root in the accepted-root history.
    function invariant_rootAlwaysKnown() public view {
        assertTrue(pool.everKnownRoot(pool.currentRoot()), "current root not known");
    }

    /// The relay height tracks the attested height and the reflected spent root is
    /// never the zero sentinel once any state has been attested (the cross-lane gate's
    /// non-vacuity precondition).
    function invariant_relayMonotonic() public view {
        assertEq(pool.lastRelayHeight(), handler.ghostRelayHeight(), "relay height drift");
        if (pool.lastRelayHeight() > 0) {
            assertTrue(pool.knownBitcoinSpentRoot() != bytes32(0), "zero spent root attested");
        }
    }
}
