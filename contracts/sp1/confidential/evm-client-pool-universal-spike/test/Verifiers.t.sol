// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

// Deploys each snarkjs-exported verifier from its compiled artifact and calls verifyProof with the real
// proof (build/<sys>_call.hex) and a one-word-tampered copy (build/<sys>_bad.hex).
contract VerifiersTest is Test {
    function _run(string memory artifact, string memory sys) internal {
        string memory p = string.concat("build/", sys, "_call.hex");
        if (!vm.exists(p)) {
            console.log(sys, "skipped (no proof)");
            return;
        }
        address v = deployCode(artifact);
        console.log(sys, "runtime bytes", v.code.length);
        bytes memory good = vm.parseBytes(vm.readFile(p));
        bytes memory bad = vm.parseBytes(vm.readFile(string.concat("build/", sys, "_bad.hex")));

        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = v.staticcall(good);
        uint256 used = g0 - gasleft();
        assertTrue(ok, "call reverted");
        assertTrue(abi.decode(ret, (bool)), "valid proof rejected");
        console.log(sys, "verifyProof gas (valid)", used);

        (ok, ret) = v.staticcall(bad);
        assertTrue(!ok || !abi.decode(ret, (bool)), "tampered proof accepted");
        console.log(sys, "tampered public input rejected");
    }

    function test_groth16() public { _run("Groth16SpendVerifier.sol:Groth16Verifier", "g16"); }
    function test_plonk() public { _run("PlonkSpendVerifier.sol:PlonkVerifier", "plonk"); }
    function test_fflonk() public { _run("FflonkSpendVerifier.sol:FflonkVerifier", "fflonk"); }
}
