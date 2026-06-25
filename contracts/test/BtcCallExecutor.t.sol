// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BtcCallExecutor, IBitcoinHook} from "../src/BtcCallExecutor.sol";

/// Minimal stand-in for ConfidentialPool's `pendingBtcCall` commitment map (set by attestBitcoinStateProven).
contract MockPool {
    mapping(bytes32 => bytes32) public pendingBtcCall;

    function record(bytes32 callId, bytes32 recordHash) external {
        pendingBtcCall[callId] = recordHash;
    }
}

contract HookTarget is IBitcoinHook {
    bytes public lastData;
    uint256 public lastValue;
    bytes32 public lastCaller;
    uint256 public calls;
    bool public boom;

    function setBoom(bool b) external {
        boom = b;
    }

    function onBitcoinReflect(bytes calldata data, uint256 value, bytes32 callerPubkey) external {
        require(!boom, "boom");
        lastData = data;
        lastValue = value;
        lastCaller = callerPubkey;
        ++calls;
    }
}

contract BtcCallExecutorTest is Test {
    BtcCallExecutor exec;
    MockPool pool;
    HookTarget target;

    function setUp() public {
        pool = new MockPool();
        exec = new BtcCallExecutor(address(pool));
        target = new HookTarget();
    }

    function test_constructor_rejects_bad_pool() public {
        vm.expectRevert(BtcCallExecutor.BadPool.selector);
        new BtcCallExecutor(address(0));

        vm.expectRevert(BtcCallExecutor.BadPool.selector);
        new BtcCallExecutor(address(0xBEEF));
    }

    /// Mirror the reflection guest's record_hash = keccak(executor ‖ target ‖ calldataHash ‖ callerPubkey).
    function _record(bytes32 callId, address tgt, bytes memory data, bytes32 caller) internal {
        pool.record(callId, keccak256(abi.encodePacked(address(exec), tgt, keccak256(data), caller)));
    }

    function test_executes_recorded_call() public {
        bytes32 callId = keccak256("c1");
        bytes32 caller = keccak256("alice-btc-pubkey");
        bytes memory data = abi.encodeWithSignature("doThing(uint256)", 42);
        _record(callId, address(target), data, caller);

        exec.executeBtcCall(callId, address(target), caller, data);
        assertEq(target.calls(), 1);
        assertEq(target.lastValue(), 0, "Mode B is value-free");
        assertEq(target.lastCaller(), caller, "the Bitcoin signer reaches the target");
        assertEq(target.lastData(), data);
        assertTrue(exec.fired(callId));
    }

    function test_one_shot_after_success() public {
        bytes32 callId = keccak256("c1");
        bytes32 caller = keccak256("a");
        bytes memory data = hex"1234";
        _record(callId, address(target), data, caller);
        exec.executeBtcCall(callId, address(target), caller, data);
        vm.expectRevert(BtcCallExecutor.AlreadyFired.selector);
        exec.executeBtcCall(callId, address(target), caller, data);
    }

    function test_unproven_reverts() public {
        vm.expectRevert(BtcCallExecutor.NotProven.selector);
        exec.executeBtcCall(keccak256("nope"), address(target), keccak256("a"), hex"00");
    }

    function test_tampered_calldata_reverts() public {
        bytes32 callId = keccak256("c1");
        bytes32 caller = keccak256("a");
        _record(callId, address(target), hex"1234", caller);
        vm.expectRevert(BtcCallExecutor.BadRecord.selector);
        exec.executeBtcCall(callId, address(target), caller, hex"5678");
    }

    function test_tampered_target_reverts() public {
        bytes32 callId = keccak256("c1");
        bytes32 caller = keccak256("a");
        bytes memory data = hex"1234";
        _record(callId, address(target), data, caller);
        HookTarget other = new HookTarget();
        vm.expectRevert(BtcCallExecutor.BadRecord.selector);
        exec.executeBtcCall(callId, address(other), caller, data);
    }

    function test_non_contract_target_reverts_without_consuming_call() public {
        bytes32 callId = keccak256("c1");
        bytes32 caller = keccak256("a");
        address eoaTarget = address(0xBEEF);
        bytes memory data = hex"1234";
        _record(callId, eoaTarget, data, caller);

        vm.expectRevert(BtcCallExecutor.BadTarget.selector);
        exec.executeBtcCall(callId, eoaTarget, caller, data);
        assertFalse(exec.fired(callId), "bad target does not consume the call");
    }

    /// A reverting target only fails its OWN executeBtcCall; the one-shot flag rolls back, so it stays
    /// re-executable once the target recovers — the bridge's attest is never coupled to this.
    function test_reverting_target_is_retryable() public {
        bytes32 callId = keccak256("c1");
        bytes32 caller = keccak256("a");
        bytes memory data = hex"1234";
        _record(callId, address(target), data, caller);

        target.setBoom(true);
        vm.expectRevert(bytes("boom"));
        exec.executeBtcCall(callId, address(target), caller, data);
        assertFalse(exec.fired(callId), "a reverted fire does not consume the call");

        target.setBoom(false);
        exec.executeBtcCall(callId, address(target), caller, data);
        assertEq(target.calls(), 1);
        assertTrue(exec.fired(callId));
    }
}
