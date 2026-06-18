// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";
import {InvERC20, AcceptAllVerifier} from "./ConfidentialPoolInvariant.t.sol";

/// Stateless property fuzzing of the value/unitScale boundary — the no-inflation
/// edge the guest cannot see (it never holds unitScale). Pins: a payout releases
/// exactly value·unitScale, wrap binds the in-system value (not the amount), the
/// u64 and alignment guards hold, claimIds are non-malleable, pool-minted supply is
/// conserved, and a nullifier spends once.
contract ConfidentialPoolFuzzTest is Test {
    ConfidentialPool pool;
    AcceptAllVerifier verifier;

    address constant USER = address(0xA11CE);
    address constant RECIP = address(0xB0B);

    function setUp() public {
        vm.chainId(1);
        verifier = new AcceptAllVerifier();
        pool = new ConfidentialPool(address(verifier), bytes32(uint256(1)), bytes32(0), address(0), address(0), bytes32(0), 6, bytes32(0), bytes32(0));
    }

    function _pv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = pool.PV_VERSION();
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
    }
    function _settle(ConfidentialPool.PublicValues memory pv) internal {
        pool.settle(abi.encode(pv), "", new bytes[](pv.leaves.length));
    }
    // Seed `n` leaves so the no-inflation floor (#evm-spends ≤ #leaves) has headroom for the spends.
    function _seedLeaves(uint256 n) internal {
        ConfidentialPool.PublicValues memory seed = _pv();
        seed.leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) seed.leaves[i] = keccak256(abi.encodePacked("seed", i));
        _settle(seed);
    }
    function _register(uint256 scale) internal returns (bytes32 id, InvERC20 t) {
        t = new InvERC20("X", "X", 18);
        id = pool.registerWrapped(address(t), scale, bytes32(0), "cX", "cX", 18);
    }

    /// A withdrawal of in-system value `v` releases EXACTLY v·unitScale of the
    /// underlying and reduces escrow by the same — the guest emits only `v`.
    function testFuzz_payout_scales_exactly(uint64 value, uint8 scaleExp) public {
        value = uint64(bound(value, 1, 1e9));
        uint256 scale = 10 ** uint256(bound(scaleExp, 0, 9));
        (bytes32 id, InvERC20 t) = _register(scale);
        uint256 amount = uint256(value) * scale;

        t.mint(USER, amount);
        vm.prank(USER);
        t.approve(address(pool), amount);
        vm.prank(USER);
        pool.wrap(id, amount, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)))));
        assertEq(pool.escrow(id), amount, "escrow holds the underlying");

        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(id, RECIP, value);
        _settle(pv);

        assertEq(t.balanceOf(RECIP), amount, "payout == value * unitScale");
        assertEq(pool.escrow(id), 0, "escrow fully released");
    }

    /// wrap binds the deposit to the in-system VALUE (amount/unitScale), never the
    /// underlying amount — so a matching deposit id forces value·unitScale == amount.
    function testFuzz_wrap_binds_value_not_amount(uint64 value, uint8 scaleExp) public {
        value = uint64(bound(value, 1, 1e9));
        uint256 scale = 10 ** uint256(bound(scaleExp, 1, 12)); // scale>1 so value != amount
        (bytes32 id, InvERC20 t) = _register(scale);
        uint256 amount = uint256(value) * scale;
        bytes32 cx = bytes32(uint256(0xc1));
        bytes32 cy = bytes32(uint256(0xc2));
        bytes32 owner = bytes32(uint256(0xc3));

        t.mint(USER, amount);
        vm.prank(USER);
        t.approve(address(pool), amount);
        vm.prank(USER);
        pool.wrap(id, amount, keccak256(abi.encodePacked(cx, cy, owner)));

        bytes32 commit = keccak256(abi.encodePacked(cx, cy, owner));
        assertEq(pool.depositStatus(keccak256(abi.encode(id, uint256(value), commit))), 1, "bound to value");
        assertEq(pool.depositStatus(keccak256(abi.encode(id, amount, commit))), 0, "not bound to amount");
    }

    /// An in-system value above u64 is rejected at the boundary (it would bind a
    /// deposit id the u64-guest can never reproduce — unconsumable escrow).
    function testFuzz_wrap_value_over_u64_reverts(uint256 amount) public {
        (bytes32 id, InvERC20 t) = _register(1); // scale 1 → value == amount
        amount = bound(amount, uint256(type(uint64).max) + 1, type(uint256).max);
        t.mint(USER, amount);
        vm.prank(USER);
        t.approve(address(pool), amount);
        vm.prank(USER);
        vm.expectRevert(ConfidentialPool.ValueOutOfRange.selector);
        pool.wrap(id, amount, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)))));
    }

    /// An amount that is not a whole multiple of unitScale is rejected (sub-precision
    /// dust cannot cross into the pool).
    function testFuzz_wrap_unaligned_reverts(uint256 amount, uint8 scaleExp) public {
        uint256 scale = 10 ** uint256(bound(scaleExp, 1, 12));
        (bytes32 id, InvERC20 t) = _register(scale);
        amount = bound(amount, 1, scale - 1); // 0 < amount < scale → never a multiple
        t.mint(USER, amount);
        vm.prank(USER);
        t.approve(address(pool), amount);
        vm.prank(USER);
        vm.expectRevert(ConfidentialPool.AmountNotAligned.selector);
        pool.wrap(id, amount, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)))));
    }

    /// A crossOut record is honored only if its claimId binds its own fields — the
    /// on-chain re-derivation blocks a malleable instruction to Bitcoin validators.
    function testFuzz_crossout_claimid_binding(uint16 destChain, bytes32 destC, bytes32 nu, bytes32 wrong) public {
        (bytes32 id,) = _register(1);
        bytes32 right = keccak256(abi.encodePacked(destChain, destC, nu, id));
        vm.assume(wrong != right);
        _seedLeaves(1); // the burned note is a prior leaf

        // correct binding settles + nullifies
        ConfidentialPool.PublicValues memory ok = _pv();
        ok.nullifiers = new bytes32[](1);
        ok.nullifiers[0] = nu;
        ok.crossOuts = new ConfidentialPool.CrossOut[](1);
        ok.crossOuts[0] = ConfidentialPool.CrossOut(destChain, destC, nu, id, right);
        _settle(ok);
        assertTrue(pool.nullifierSpent(nu), "burned note nullified");

        // wrong binding reverts (fresh nullifier so we reach the crossOut loop)
        ConfidentialPool.PublicValues memory bad = _pv();
        bad.crossOuts = new ConfidentialPool.CrossOut[](1);
        bad.crossOuts[0] = ConfidentialPool.CrossOut(destChain, destC, keccak256("other"), id, wrong);
        vm.expectRevert(ConfidentialPool.CrossOutClaimMismatch.selector);
        _settle(bad);
    }

    /// A pool-minted (Tacit-recorded) asset: exit mints exactly value·unitScale of the
    /// canonical ERC20, re-entry burns it, escrow stays zero, supply == minted − burned.
    function testFuzz_poolminted_supply_conserved(uint64 value, uint8 dExp) public {
        value = uint64(bound(value, 1, 1e9));
        // unitScale is DERIVED from the native precision, not registrant-chosen: tacitDecimals ∈
        // [9,18] ⇒ scale = 10^(18−tacitDecimals) ∈ [10^0, 10^9] (the same range the old free scale spanned).
        uint8 tacitDecimals = uint8(bound(dExp, 9, 18));
        uint256 scale = 10 ** uint256(18 - uint256(tacitDecimals));
        uint256 amount = uint256(value) * scale;

        CanonicalAssetFactory fac = new CanonicalAssetFactory();
        bytes32 canonId = keccak256("TAC");
        CanonicalBridgedERC20 tac =
            CanonicalBridgedERC20(fac.deployCanonical(canonId, address(pool), "TAC", 18));
        bytes32 a = pool.registerMinted(address(tac), "Conf TAC", "TAC", tacitDecimals);

        // exit: unwrap mints the public ERC20
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal(a, USER, value);
        _settle(pv);
        assertEq(tac.balanceOf(USER), amount, "exit minted value*scale");
        assertEq(tac.totalSupply(), amount, "supply == exited");
        assertEq(pool.escrow(a), 0, "pool-minted assets never escrow");

        // re-enter: wrap burns the ERC20 back to confidential
        vm.prank(USER);
        pool.wrap(a, amount, keccak256(abi.encodePacked(bytes32(uint256(7)), bytes32(uint256(8)), bytes32(uint256(9)))));
        assertEq(tac.totalSupply(), 0, "supply back to confidential");
        assertEq(pool.escrow(a), 0, "still no escrow");
    }

    /// A nullifier is consumable exactly once across settles.
    function testFuzz_nullifier_spends_once(bytes32 nu) public {
        _seedLeaves(1); // the spent note is a prior leaf
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.nullifiers = new bytes32[](1);
        pv.nullifiers[0] = nu;
        _settle(pv);
        assertTrue(pool.nullifierSpent(nu), "spent");

        ConfidentialPool.PublicValues memory pv2 = _pv();
        pv2.nullifiers = new bytes32[](1);
        pv2.nullifiers[0] = nu;
        vm.expectRevert(ConfidentialPool.NullifierAlreadySpent.selector);
        _settle(pv2);
    }
}
