// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";

/// @notice Create the next generation of a ConfidentialPool. A migrating generation can only come into
///         existence through its predecessor's own `createNextGen` (the successor's constructor accepts a
///         predecessor only when that predecessor is its deployer), so this script never deploys anything
///         itself: it assembles the successor's init code and has the predecessor deploy it. Broadcast from
///         the predecessor's lineage steward.
///
///         The successor's reflected genesis is not an input. Its first attest proves a rebase of the
///         predecessor's live attested state and continues from the predecessor's attested tip, so the
///         resume digest and the genesis anchor are both zero by construction. Periphery that the successor
///         binds at construction (canonical factory, header relay, engine, public AMM) must already exist;
///         the engine's `setPool` and the public AMM's `initialize` are wired to the successor afterwards,
///         exactly as for a genesis deploy. The successor lands at the plain CREATE2 address of
///         (predecessor, SALT_NEXT_GEN, keccak256(initCode)), which this script predicts and asserts.
contract CreateNextGen is Script {
    function run() external {
        ConfidentialPool predecessor = ConfidentialPool(vm.envAddress("PREDECESSOR"));
        bytes32 salt = vm.envBytes32("SALT_NEXT_GEN");
        bytes memory args = abi.encode(
            vm.envAddress("SP1_VERIFIER"),
            vm.envBytes32("PROGRAM_VKEY"),
            vm.envBytes32("BITCOIN_RELAY_VKEY"),
            vm.envAddress("CANONICAL_FACTORY"),
            vm.envAddress("HEADER_RELAY"),
            bytes32(0), // genesis anchor: read live from the predecessor at the first attest
            vm.envOr("REFLECTION_CONFIRMATIONS", uint256(6)),
            bytes32(0), // resume digest: proven by the first attest's rebase
            vm.envOr("TETH_BITCOIN_ID", bytes32(0)),
            vm.envOr("COLLATERAL_ENGINE", address(0)),
            vm.envOr("LINEAGE_STEWARD", msg.sender),
            address(predecessor),
            vm.envOr("PUBLIC_AMM", address(0))
        );
        require(args.length == 13 * 32, "pool ctor arity != 13");
        bytes memory initCode = abi.encodePacked(type(ConfidentialPool).creationCode, args);
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), address(predecessor));
        console2.log("predicted successor:", predicted);

        vm.startBroadcast();
        address next = predecessor.createNextGen(initCode, salt);
        vm.stopBroadcast();

        require(next == predicted, "successor address mismatch");
        require(predecessor.successor() == next, "predecessor did not record the successor");
        console2.log("successor:", next);
    }
}
