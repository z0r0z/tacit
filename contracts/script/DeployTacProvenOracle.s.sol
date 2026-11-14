// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {TacProvenOracle} from "../src/TacProvenOracle.sol";
import {TacVaultsDeployment as D} from "./TacVaultsDeployment.sol";

interface ICreateX3 {
    function deployCreate2(bytes32 salt, bytes memory initCode) external payable returns (address newContract);
}

interface IAmmVenue {
    function slots() external view returns (bytes32, bytes32);
}

/// @notice Deploys TacProvenOracle over the vaults' two venues, with their pair oracle as its fallback, through CreateX
///         with a salt guarded by the chain, then prints the ops multisig calls that put it in both vaults:
///         `queueOracle` now and `executeOracle` once ORACLE_DELAY has passed and a proof covers the interval that
///         counts (the vault checks the new oracle answers every view).
///
///         PROGRAM_VKEY=<sp1/tac-oracle/elf-vkey-pin.json's key> GRACE=<blocks, 1 to STEP - 1>
///         [SALT=<bytes32: 20 zero bytes, 0x01, any 11>]
///         forge script script/DeployTacProvenOracle.s.sol --rpc-url $RPC --broadcast --account <any funded account>
contract DeployTacProvenOracle is Script {
    /// Intervals every proof answers for, from X - 1: through X + 3, so a proof keeps answering for three intervals
    /// after its own, and within the four the shortest window (12 intervals at two thirds) can go unrecorded.
    uint256 internal constant COUNT = 5;

    function config(bytes32 vkey, uint256 grace) public pure returns (TacProvenOracle.Config memory) {
        return TacProvenOracle.Config({
            programVKey: vkey,
            precision: D.PRECISION_POOL,
            tac: D.TAC,
            pool: D.CONFIDENTIAL_POOL,
            poolId: D.AMM_POOL_ID,
            ethAsset: D.ETH_ASSET,
            tacAsset: D.TAC_ASSET,
            mappingSlot: D.POOLS_SLOT,
            step: D.ORACLE_STEP,
            shortWindow: D.ORACLE_SHORT_WINDOW,
            window: D.ORACLE_WINDOW,
            maxWindow: D.ORACLE_MAX_WINDOW,
            grace: grace,
            count: COUNT,
            minCoverageBps: D.ORACLE_COVERAGE_BPS,
            fallbackOracle: D.PAIR_ORACLE
        });
    }

    function initCode(bytes32 vkey, uint256 grace) public pure returns (bytes memory) {
        return abi.encodePacked(type(TacProvenOracle).creationCode, abi.encode(config(vkey, grace)));
    }

    /// The address CreateX gives `initCodeHash` under `salt`, a salt bound to this chain.
    function predict(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        require(bytes20(salt) == bytes20(0) && uint8(salt[20]) == 1, "salt form");
        bytes32 guarded = keccak256(abi.encode(block.chainid, salt));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), D.CREATEX, guarded, initCodeHash)))));
    }

    function run() external {
        require(block.chainid == 1, "mainnet only");
        bytes32 vkey = vm.envBytes32("PROGRAM_VKEY");
        // The key of the committed program (build-program.sh writes the pin); ALLOW_UNPINNED_VKEY=1 for a fork or a test.
        if (!vm.envOr("ALLOW_UNPINNED_VKEY", false)) {
            string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/tac-oracle/elf-vkey-pin.json"));
            require(vm.parseJsonBytes32(pin, ".program_vkey") == vkey, "PROGRAM_VKEY is not the pinned program's key");
        }
        uint256 grace = vm.envUint("GRACE");
        require(grace > 0, "GRACE: blocks for a proof to land in");
        bytes32 salt = vm.envOr("SALT", bytes32(uint256(1) << 88));
        bytes memory init = initCode(vkey, grace);
        address at = predict(salt, keccak256(init));
        if (at.code.length == 0) {
            vm.broadcast();
            require(ICreateX3(D.CREATEX).deployCreate2(salt, init) == at, "landed elsewhere");
            console2.log("deployed TacProvenOracle", at);
        } else {
            console2.log("already there", at);
        }
        TacProvenOracle o = TacProvenOracle(at);
        (bytes32 a, bytes32 b) = IAmmVenue(D.AMM_ORACLE).slots();
        require(o.SLOT_A() == a && o.SLOT_B() == b, "slots differ from the venue oracle's");
        require(o.PROGRAM_VKEY() == vkey && o.GRACE() == grace && o.FALLBACK() == D.PAIR_ORACLE, "terms");
        console2.log("CONFIG");
        console2.logBytes32(o.CONFIG());

        bytes memory queue = abi.encodeWithSignature("queueOracle(address)", at);
        bytes memory execute = abi.encodeWithSignature("executeOracle()");
        console2.log("ops multisig, now: queueOracle(%s) on", at);
        console2.log("  USD vault", D.USD_VAULT);
        console2.log("  ETH vault", D.ETH_VAULT);
        console2.logBytes(queue);
        console2.log("ops multisig, after ORACLE_DELAY and a proof: executeOracle() on both vaults");
        console2.logBytes(execute);
        address[] memory to = new address[](2);
        (to[0], to[1]) = (D.USD_VAULT, D.ETH_VAULT);
        bytes[] memory q = new bytes[](2);
        (q[0], q[1]) = (queue, queue);
        console2.log("as one batch(address[],uint256[],bytes[]):");
        console2.logBytes(abi.encodeWithSignature("batch(address[],uint256[],bytes[])", to, new uint256[](2), q));
    }
}
