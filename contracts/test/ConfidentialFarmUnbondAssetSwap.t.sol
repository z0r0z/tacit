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

/// Documents the guest↔pool boundary for the farm bond/unbond stake asset — NOT a live defect.
///
/// WHERE THE CONTROL LIVES (the guest): `farm_receipt_leaf` commits the staked asset (v3 domain,
///   `tacit-farm-receipt-v3` in cxfer-core `lib.rs`). OP_FARM_BOND mints that receipt for the witnessed
///   `lp_asset`; OP_FARM_UNBOND/HARVEST reconstructs the receipt from a witnessed `lp_asset` and
///   membership-proves it against the note tree (`keccak_merkle_verify(&receipt, ..., &spend_root)`,
///   main.rs). A relabeled asset yields a leaf that was never inserted, so membership FAILS — a real proof
///   cannot swap the asset. The cxfer-core test `farm_receipt_leaf_binds_stake_asset` pins the leaf/ν
///   binding directly.
///
/// WHAT THIS SOLIDITY TEST PINS (the pool boundary): the pool does NOT independently re-gate the unbond
///   asset — the farm asset gate (`ConfidentialPool.sol` `positionLeaf == 1 && debtValue != 0`) covers
///   OP_FARM_HARVEST but not the bond/unbond pair, and the cdpCloses loop checks only `code.length != 0`
///   before forwarding to the controller. So with a MOCK verifier standing in for the guest, an
///   unbond-shaped close carries an arbitrary leg asset unchallenged by the pool. This is a boundary
///   statement, not an exploit: on mainnet a real SP1 proof is required, and the guest above forbids the
///   relabel. The honest FarmController (`_stakeWeight` → `WrongStakeAsset`) enforces the same invariant a
///   second time on the controller side; the positive control below shows it.
contract ConfidentialFarmUnbondAssetSwapTest is Test {
    ConfidentialPool pool;
    address attacker = address(0xBADBAD);

    bytes32 constant TETH_LINK = bytes32(uint256(0xE7A));

    function setUp() public {
        vm.chainId(1);
        pool = new ConfidentialPool(
            address(new AcceptVerifierF2()), bytes32(uint256(0xABCD)), bytes32(0), address(0),
            address(0), bytes32(0), 6, bytes32(0), TETH_LINK, address(0)
        , address(0));
    }

    function _pv() internal view returns (ConfidentialPool.PublicValues memory p) {
        p.version = 1;
        p.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
    }

    function _settle(ConfidentialPool.PublicValues memory p) internal {
        pool.settle(abi.encode(p), "", new bytes[](0));
    }

    /// The POOL accepts an unbond-shaped close from an arbitrary controller carrying an arbitrary leg asset:
    /// the pool does not independently re-check the released asset. The guest is what binds it (a real proof
    /// reconstructs + membership-proves the asset-committing receipt leaf, so the relabel below is
    /// unreachable with a real proof) — this pins only the pool-side boundary, exercised via a mock verifier.
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
