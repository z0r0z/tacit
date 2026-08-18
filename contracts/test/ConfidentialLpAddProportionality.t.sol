// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract LpPropToken is ERC20 {
    function name() public pure override returns (string memory) {
        return "T";
    }

    function symbol() public pure override returns (string memory) {
        return "T";
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }
}

contract LpPropVerifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// Pins the M-03 on-chain LP-add proportionality bound (`_ckProp`) against the shapes the guest can now
/// produce after the change-output work.
///
/// WHY: the guest gained per-leg CHANGE outputs (and, next, multi-note inputs). Change notes append LEAVES
/// but must NOT perturb the reserve deltas the contract bounds. That was an ASSUMPTION when M-03 landed —
/// these tests make it a fact. If a future guest change starts folding change into the reserve move, the
/// honest-shape cases below flip to reverting and say so loudly.
///
/// The bound (ConfidentialPool._settle, LP-add branch) is, per side:
///     sharesMinted · reservePre  <=  reserveAdded · sharesPre
/// i.e. mint no more than the pro-rata claim on what was actually added. Floor-toward-the-pool, so an exact
/// in-ratio add is always accepted and dust accrues to existing LPs.
contract ConfidentialLpAddProportionalityTest is Test {
    ConfidentialPool pool;
    LpPropToken tokenA;
    LpPropToken tokenB;
    bytes32 assetA;
    bytes32 assetB;
    bytes32 poolId;

    // Seeded pool: 1_000_000 / 4_000_000 reserves against 1_000_000 shares (1 share per unit of A).
    uint256 constant RA = 1_000_000;
    uint256 constant RB = 4_000_000;
    uint256 constant SP = 1_000_000;

    function setUp() public {
        vm.chainId(1);
        pool = new ConfidentialPool(
            address(new LpPropVerifier()), bytes32(uint256(0xABCD)), bytes32(0), address(0),
            address(0), bytes32(0), 6, bytes32(0), bytes32(0), address(0)
        , address(0), address(0));
        tokenA = new LpPropToken();
        tokenB = new LpPropToken();
        assetA = pool.registerWrapped(address(tokenA), 1, bytes32(0), "A", "A", 8);
        assetB = pool.registerWrapped(address(tokenB), 1, bytes32(0), "B", "B", 8);
        if (assetA > assetB) (assetA, assetB) = (assetB, assetA);
        poolId = pool.createPair(assetA, assetB, 30, 0, bytes32(0), 0);
        // First mint seeds the reserves (empty → RA/RB/SP).
        _add(0, 0, 0, RA, RB, SP, 0);
    }

    function _pv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
    }

    /// One LP-add settle. `nChange` appends that many extra leaves, standing in for the guest's per-leg
    /// change notes: they must be irrelevant to the proportionality bound.
    function _add(
        uint256 ap,
        uint256 bp,
        uint256 sp,
        uint256 apost,
        uint256 bpost,
        uint256 spost,
        uint256 nChange
    ) internal {
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.liquidity = new ConfidentialPool.LpSettlement[](1);
        pv.liquidity[0] = ConfidentialPool.LpSettlement(poolId, ap, bp, sp, apost, bpost, spost);
        // share note + change notes
        pv.leaves = new bytes32[](1 + nChange);
        for (uint256 i; i < 1 + nChange; ++i) pv.leaves[i] = keccak256(abi.encodePacked("leaf", i, spost));
        bytes[] memory memos = new bytes[](pv.leaves.length);
        bytes32 mr;
        for (uint256 i; i < memos.length; ++i) mr = keccak256(abi.encodePacked(mr, keccak256(memos[i])));
        pv.memoRoot = mr;
        pool.settle(abi.encode(pv), "", memos);
    }

    // ──────────────── honest shapes must pass ────────────────

    /// Exact in-ratio partial add with change leaves present. Adding 10% of each reserve mints 10% more
    /// shares; the extra leaves (change) must not affect the bound.
    function test_partial_add_with_change_passes() public {
        _add(RA, RB, SP, RA + 100_000, RB + 400_000, SP + 100_000, 3);
    }

    /// Same reserve/share move, zero change leaves — must behave identically. This is the control proving
    /// the bound reads reserve deltas only, not leaf count.
    function test_same_move_without_change_passes() public {
        _add(RA, RB, SP, RA + 100_000, RB + 400_000, SP + 100_000, 0);
    }

    /// Off-ratio add: B is the limiting leg (min rule), so fewer shares than the A side alone would justify.
    /// Under-minting is always safe — the surplus accrues to existing LPs.
    function test_off_ratio_under_mint_passes() public {
        // +200_000 A (20%) but only +400_000 B (10%) ⇒ min rule mints 10%.
        _add(RA, RB, SP, RA + 200_000, RB + 400_000, SP + 100_000, 2);
    }

    /// Many change leaves: still purely a leaf-count change.
    function test_many_change_leaves_passes() public {
        _add(RA, RB, SP, RA + 100_000, RB + 400_000, SP + 100_000, 16);
    }

    // ──────────────── the bound must still bite ────────────────

    /// Over-minted shares (what a compromised guest would emit): 10% of reserves added but 20% of shares
    /// minted. The A side violates sharesMinted·reservePre <= reserveAdded·sharesPre.
    function test_over_mint_reverts() public {
        vm.expectRevert(ConfidentialPool.PoolReserveMismatch.selector);
        _add(RA, RB, SP, RA + 100_000, RB + 400_000, SP + 200_000, 0);
    }

    /// Over-mint is caught even when change leaves are present — change cannot be used to mask it.
    function test_over_mint_with_change_still_reverts() public {
        vm.expectRevert(ConfidentialPool.PoolReserveMismatch.selector);
        _add(RA, RB, SP, RA + 100_000, RB + 400_000, SP + 200_000, 4);
    }

    /// Shares minted against a one-sided add (B contributed nothing) must fail on the B side even though the
    /// A side alone would justify them — this is what makes the check two-sided.
    function test_one_sided_add_reverts_on_other_side() public {
        vm.expectRevert(ConfidentialPool.PoolReserveMismatch.selector);
        _add(RA, RB, SP, RA + 100_000, RB, SP + 100_000, 0);
    }
}
