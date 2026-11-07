// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {TacitBlocks} from "../../src/TacitBlocks.sol";
import {TacitBlocksFixture} from "../TacitBlocks.t.sol";

/// The landing contract's own gas for each fixture block, the callee's frame alone (vm.lastCallGas), so the test contract's
/// memory does not count: for comparing compilers.
contract GasCompare is TacitBlocksFixture {
    function landAndLog(uint256 b, string memory what) internal {
        bytes memory p = pv(b);
        TacitBlocks.Lists memory l = lists(b);
        if (b == 8) asBlobBlock(l);
        if (block.timestamp < uint256(words(b)[14])) vm.warp(uint256(words(b)[14]));
        vm.prank(SEQ);
        blocks.land(p, "", l);
        emit log_named_uint(what, vm.lastCallGas().gasTotalUsed);
    }

    function test_gas() public {
        depositFixture();
        landAndLog(0, "land 0 shield");
        landAndLog(1, "land 1 exit");
        bytes memory f = vm.parseJsonBytes(fx, ".forced");
        blocks.force(f);
        emit log_named_uint("force", vm.lastCallGas().gasTotalUsed);
        landAndLog(2, "land 2 forced");
        landAndLog(3, "land 3 hop");
        uint256 v = vm.parseJsonUint(fx, ".hop.value");
        bytes32 c = vm.parseJsonBytes32(fx, ".hop.commit");
        blocks.sendHop(v, c);
        emit log_named_uint("sendHop", vm.lastCallGas().gasTotalUsed);
    }
}
