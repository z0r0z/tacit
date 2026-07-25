// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier, CdpLeg} from "../src/ConfidentialPool.sol";
import {FarmController} from "../src/FarmController.sol";

contract AcceptVerifierF2 is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// A controller that accepts every callback. Deploying one is permissionless: ConfidentialPool gates a
/// controller ONLY on `code.length != 0` (ConfidentialPool.sol:2001, :2032, :2046, :2052) — there is no
/// allowlist anywhere in the contract.
contract EvilController {
    fallback() external payable {}
}

/// Pins the farm bond/unbond ASSET-SWAP gap.
///
/// THE DEFECT (cross-asset inflation, settle guest + pool):
///   `farm_receipt_leaf` (cxfer-core/src/lib.rs:4820) commits (farm, shares, rps_entry, owner, nonce) —
///   it does NOT commit the staked asset id. OP_FARM_BOND spends notes of a WITNESSED `lp_asset`
///   (main.rs:3560) and mints that receipt. OP_FARM_UNBOND reconstructs the SAME leaf from
///   (controller, shares, rps_entry, owner, nonce) — never re-deriving the asset — then mints
///   `leaf(&lp_asset, ...)` for a SECOND, independently witnessed `lp_asset` (main.rs:3766, :3814).
///   Nothing in the guest ties the unbond asset to the bond asset. The owner BIP-340 signature does bind
///   `lp_asset`, but the attacker IS the owner, so they simply sign the asset they want.
///
/// WHY THE POOL DOES NOT CATCH IT:
///   The farm asset gate (ConfidentialPool.sol:2017) is keyed `positionLeaf == 1 && debtValue != 0`, so it
///   covers OP_FARM_HARVEST but NOT the bond/unbond pair — a bond is debtValue == 0, and an unbond arrives as
///   a `cdpClose` with debtValue == 0 / repaid == 0. The cdpCloses loop (:2044-2049) checks only
///   `code.length != 0` and forwards to the controller. It never inspects `legs[0].asset`.
///
/// WHERE THE INVARIANT ACTUALLY LIVES:
///   Only in the honest FarmController (`_stakeWeight`, FarmController.sol:215:
///   `legs[i].asset != STAKE_ASSET -> WrongStakeAsset`). That contract is attacker-substitutable, so the
///   invariant is unenforced against a hostile controller.
///
/// IMPACT: the minted asset is redeemed from POOL-WIDE `escrow[assetId]`, NOT from `farmTreasury[controller]`.
///   So a hostile farm drains depositors who never interacted with any farm. Contrast OP_FARM_HARVEST, which
///   IS treasury-bounded at :2017-2024 — same trust assumption, only one path enforces it.
///
/// SCOPE OF THIS TEST: the mock verifier stands in for the guest, so what is pinned here is that the POOL
///   imposes no constraint — the missing gate. The guest half is established by `farm_receipt_leaf` omitting
///   the asset (cited above), which no contract-level test can exercise. test_honest_controller_rejects is
///   the positive control proving the invariant exists but lives in the wrong place.
contract ConfidentialFarmUnbondAssetSwapTest is Test {
    ConfidentialPool pool;
    address attacker = address(0xBADBAD);

    bytes32 constant TETH_LINK = bytes32(uint256(0xE7A));

    function setUp() public {
        vm.chainId(1);
        pool = new ConfidentialPool(
            address(new AcceptVerifierF2()), bytes32(uint256(0xABCD)), bytes32(0), address(0),
            address(0), bytes32(0), 6, bytes32(0), TETH_LINK, address(0)
        );
    }

    function _pv() internal view returns (ConfidentialPool.PublicValues memory p) {
        p.version = 1;
        p.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
    }

    function _settle(ConfidentialPool.PublicValues memory p) internal {
        pool.settle(abi.encode(p), "", new bytes[](0));
    }

    /// The pool accepts an unbond-shaped close from an ARBITRARY controller carrying an ARBITRARY leg asset.
    /// This is the missing gate: nothing links the asset a receipt was bonded with to the asset released.
    function test_pool_does_not_constrain_unbond_asset() public {
        address evil = address(new EvilController());
        bytes32 bondedAsset = keccak256("junk-token-the-attacker-deployed");
        bytes32 releasedAsset = keccak256("cETH-escrow-backed-real-depositor-funds");

        assertTrue(bondedAsset != releasedAsset, "the two assets differ");

        // The unbond leg the guest emits: debtValue == 0, repaid == 0, legs = [released asset, shares].
        ConfidentialPool.PublicValues memory p = _pv();
        p.cdpCloses = new ConfidentialPool.CdpClose[](1);
        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(releasedAsset, 1e8); // 1e8 tacit units == 1 ETH at unitScale 1e10
        p.cdpCloses[0] = ConfidentialPool.CdpClose({
            controller: evil,
            debtValue: 0,
            repaid: 0,
            rateSnapshot: 0,
            positionNullifier: keccak256("farm-receipt-nullifier"),
            legs: legs
        });

        // No revert: the pool never compares the released asset to anything the receipt was bonded with.
        _settle(p);

        // The receipt nullifier was consumed even though the asset was never checked: replaying it reverts.
        vm.expectRevert(ConfidentialPool.CdpPositionAlreadySpent.selector);
        _settle(p);
    }

    /// Positive control: the HONEST controller does enforce the invariant — so it exists, it is simply located
    /// in a contract the attacker replaces. Same legs, real FarmController, reverts WrongStakeAsset.
    function test_honest_controller_rejects_mismatched_asset() public {
        bytes32 stakeAsset = keccak256("the-real-LP-share-asset");
        bytes32 rewardAsset = keccak256("the-real-reward-asset");
        // escrowMode must differ from (rewardAsset == debtAsset); rewardAsset here is not the debt asset.
        FarmController farm =
            new FarmController(address(pool), stakeAsset, rewardAsset, true, true, address(this), 0);

        CdpLeg[] memory legs = new CdpLeg[](1);
        legs[0] = CdpLeg(keccak256("cETH-escrow-backed-real-depositor-funds"), 1e8); // NOT stakeAsset

        vm.prank(address(pool));
        vm.expectRevert(FarmController.WrongStakeAsset.selector);
        farm.onCdpClose(0, 0, 0, legs, keccak256("farm-receipt-nullifier"));
    }
}
