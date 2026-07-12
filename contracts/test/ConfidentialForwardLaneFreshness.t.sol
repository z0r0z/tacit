// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {PoolStateReader} from "./PoolStateReader.sol";

using PoolStateReader for ConfidentialPool;

contract AcceptVerifierF is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract MockRelayF {
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

/// Pins the two-mode cross-out freshness gate (ConfidentialPool.attestBitcoinStateProven):
///  - A cross-out's 0x65 mint folds only when it lands in a Bitcoin block, so between a recorded crossOut()
///    (on-chain crossOutCount bumped) and its mint being folded, foldedCrossOutCount lags crossOutCount.
///  - A FORWARD batch (ethPool == 0) SKIPS 0x65 (skip-not-panic), so it may advance only when
///    foldedCrossOutCount == crossOutCount (no mint pending an unfolded 0x65). It is blocked during the gap
///    and revives once caught up — instead of being frozen forever after the first cross-out.
///  - A MODE-B batch (ethPool == this) is a folding scan gated on the eth-set-fresh crossOutCount, so it stays
///    live during the gap (foldedCrossOutCount is not gated for it).
contract ConfidentialForwardLaneFreshnessTest is Test {
    ConfidentialPool pool;

    bytes32 constant RELAY_VKEY = bytes32(uint256(0xBEEF));
    bytes32 constant ANCHOR = bytes32(uint256(0xB17C0));
    uint256 constant CROSSOUT_COUNT_SLOT = 169;
    MockRelayF relay;

    function setUp() public {
        vm.chainId(1);
        relay = new MockRelayF(ANCHOR);
        pool = new ConfidentialPool(
            address(new AcceptVerifierF()), bytes32(uint256(0xABCD)), RELAY_VKEY, address(0),
            address(relay), ANCHOR, 6, bytes32(0), bytes32(0), address(0)
        );
        bytes32 t = ANCHOR;
        for (uint256 i; i < 6; ++i) {
            bytes32 child = keccak256(abi.encodePacked("matured-relay", ANCHOR, i));
            relay.setParent(child, t);
            t = child;
        }
        relay.setTip(t);
    }

    // Simulate a recorded ETH→BTC cross-out whose 0x65 mint has not yet been folded.
    function _recordCrossOut(uint256 n) internal {
        vm.store(address(pool), bytes32(CROSSOUT_COUNT_SLOT), bytes32(n));
        assertEq(uint256(vm.load(address(pool), bytes32(CROSSOUT_COUNT_SLOT))), n, "crossOutCount storage slot");
    }

    function _pv(bytes32 ethPool, uint64 crossOutCount_, uint64 foldedCrossOutCount_)
        internal
        view
        returns (bytes memory)
    {
        bytes32 prior = pool.knownReflectionDigest();
        bytes32 poolRoot = keccak256("btc-pool-root");
        bytes32 next = keccak256(abi.encode(prior, poolRoot, ethPool, foldedCrossOutCount_));
        return abi.encode(
            ConfidentialPool.BitcoinRelayPublicValues(
                prior, poolRoot, keccak256("spent-sentinel"), keccak256("burn-sentinel"), 1, next,
                ANCHOR, ANCHOR, ethPool, 0,
                new ConfidentialPool.CbtcLockFolded[](0), new bytes32[](0), new bytes32[](0),
                uint64(0), crossOutCount_, foldedCrossOutCount_,
                new ConfidentialPool.AssetMeta[](0), new bytes32[](0)
            )
        );
    }

    function test_forward_blocked_while_mint_pending() public {
        _recordCrossOut(1); // crossOut recorded, 0x65 not yet folded (foldedCrossOutCount still 0)
        // Forward batch (ethPool == 0), foldedCrossOutCount 0 < crossOutCount 1 → must revert.
        vm.expectRevert(ConfidentialPool.ConsumedCountStale.selector);
        pool.attestBitcoinStateProven(_pv(bytes32(0), 0, 0), "");
    }

    function test_forward_revives_when_caught_up() public {
        _recordCrossOut(1);
        // Forward batch with foldedCrossOutCount 1 == crossOutCount 1 → the mint has been folded, so a forward
        // scan can advance again (no pending 0x65 to skip).
        pool.attestBitcoinStateProven(_pv(bytes32(0), 0, 1), "");
        assertEq(pool.knownReflectionDigest() != bytes32(0), true, "forward attest advanced the chain");
    }

    function test_modeB_stays_live_during_mint_gap() public {
        _recordCrossOut(1);
        // Mode-B batch (ethPool == this) carries a fresh eth set (crossOutCount 1 == on-chain) but has not yet
        // folded the 0x65 (foldedCrossOutCount 0). It must still advance — Mode-B is the folding scan that
        // covers the gap.
        pool.attestBitcoinStateProven(_pv(bytes32(uint256(uint160(address(pool)))), 1, 0), "");
        assertEq(pool.knownReflectionDigest() != bytes32(0), true, "mode-B attest advanced during the gap");
    }

    function test_modeB_stale_ethset_reverts() public {
        _recordCrossOut(1);
        // Mode-B batch reflecting a STALE crossOutCount (0 < on-chain 1) → the eth set predates the recorded
        // cross-out → revert (unchanged Mode-B freshness gate).
        vm.expectRevert(ConfidentialPool.ConsumedCountStale.selector);
        pool.attestBitcoinStateProven(_pv(bytes32(uint256(uint160(address(pool)))), 0, 0), "");
    }

    function test_forward_normal_when_no_crossout() public {
        // No cross-out ever recorded (crossOutCount 0): a forward batch with foldedCrossOutCount 0 advances.
        pool.attestBitcoinStateProven(_pv(bytes32(0), 0, 0), "");
        assertEq(pool.knownReflectionDigest() != bytes32(0), true, "forward attest advances with no cross-out");
    }
}
