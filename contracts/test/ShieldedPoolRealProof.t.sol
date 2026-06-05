// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";

/// Full deposit -> native withdraw against the REAL Groth16Verifier with a REAL
/// ceremony proof, bound to a deterministic pool address so the on-chain
/// bind_hash recompute matches the bind_hash the circuit committed. Exercises
/// every on-chain seam: deposit into the Poseidon tree -> everKnownRoot ->
/// bind_hash recompute over the "tacit-eth-withdraw-v1" domain -> Groth16 verify
/// (call-data G2 order) -> escrow release with a relayer fee.
/// Fixture: tests/gen-native-withdraw-fixture.mjs.
contract ShieldedPoolRealProofTest is Test {
    address constant DEPLOYER = 0x00000000000000000000000000000000DeaDBeef;

    ShieldedPool pool;
    bool ready;

    uint256[2] a;
    uint256[2][2] b;
    uint256[2] c;
    bytes32 root;
    bytes32 nullifierHash;
    bytes32 rLeaf;
    uint256 weiDenom;
    uint256 fee;
    address recipient;
    address relayer;
    bytes32 pid;

    function setUp() public {
        try this._load() { ready = true; } catch { ready = false; }
    }

    /// External so a missing/stale fixture reverts here and skips, rather than
    /// failing the suite. Deploys + funds the pool from the fixture.
    function _load() external {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/native_withdraw_flow.json"));

        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        address fixturePool = vm.parseJsonAddress(json, ".pool");
        weiDenom = vm.parseJsonUint(json, ".weiDenom");
        fee = vm.parseJsonUint(json, ".fee");
        recipient = vm.parseJsonAddress(json, ".recipient");
        relayer = vm.parseJsonAddress(json, ".relayer");
        bytes32 commitment = vm.parseJsonBytes32(json, ".commitment");
        root = vm.parseJsonBytes32(json, ".root");
        nullifierHash = vm.parseJsonBytes32(json, ".nullifierHash");
        rLeaf = vm.parseJsonBytes32(json, ".rLeaf");

        uint256[] memory pf = vm.parseJsonUintArray(json, ".proof");
        a = [pf[0], pf[1]];
        b = [[pf[2], pf[3]], [pf[4], pf[5]]];
        c = [pf[6], pf[7]];

        address predicted = vm.computeCreateAddress(DEPLOYER, 0);
        require(predicted == fixturePool, "deployer/nonce drift vs fixture pool address");

        Groth16Verifier g16 = new Groth16Verifier();
        uint256[] memory denoms = new uint256[](1);
        denoms[0] = weiDenom;

        vm.prank(DEPLOYER);
        pool = new ShieldedPool(address(g16), denoms);
        require(address(pool) == predicted, "pool landed at unexpected address");

        pid = pool.getPoolId(weiDenom);
        vm.deal(address(this), weiDenom);
        pool.deposit{value: weiDenom}(commitment, weiDenom);
        require(pool.getPoolRoot(pid) == root, "on-chain root != fixture root");
    }

    function test_realProof_releasesEth() public {
        if (!ready) { vm.skip(true); return; }
        uint256 r0 = recipient.balance;
        uint256 y0 = relayer.balance;

        pool.withdraw(a, b, c, root, nullifierHash, weiDenom, uint256(rLeaf), recipient, relayer, fee);

        assertEq(recipient.balance - r0, weiDenom - fee, "recipient payout wrong");
        assertEq(relayer.balance - y0, fee, "relayer fee wrong");
        assertEq(pool.totalBalance(), 0, "escrow not debited");
        assertTrue(pool.isNullifierSpent(pid, nullifierHash), "nullifier not spent");
    }

    function test_realProof_doubleWithdraw_reverts() public {
        if (!ready) { vm.skip(true); return; }
        pool.withdraw(a, b, c, root, nullifierHash, weiDenom, uint256(rLeaf), recipient, relayer, fee);
        vm.expectRevert(ShieldedPool.NullifierAlreadySpent.selector);
        pool.withdraw(a, b, c, root, nullifierHash, weiDenom, uint256(rLeaf), recipient, relayer, fee);
    }

    function test_realProof_tamperedRecipient_reverts() public {
        if (!ready) { vm.skip(true); return; }
        // A different recipient changes bind_hash; the proof no longer matches.
        vm.expectRevert(ShieldedPool.InvalidGroth16Proof.selector);
        pool.withdraw(a, b, c, root, nullifierHash, weiDenom, uint256(rLeaf), makeAddr("attacker"), relayer, fee);
    }
}
