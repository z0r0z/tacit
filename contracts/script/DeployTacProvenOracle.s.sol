// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {TacProvenOracle} from "../src/TacProvenOracle.sol";
import {TacVaultsDeployment as D} from "./TacVaultsDeployment.sol";

interface ICreateX3 {
    function deployCreate2(bytes32 salt, bytes memory initCode) external payable returns (address newContract);
    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address newContract);
    function computeCreate3Address(bytes32 guardedSalt) external view returns (address);
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
///         [SALT=<bytes32>] forge script script/DeployTacProvenOracle.s.sol --rpc-url $RPC --broadcast
///             --account <any funded account>
///
///         Two salt forms, told apart by the salt itself:
///           - the deployer's 20 bytes then 0x00: a salt the pool mined for a CREATE3 vanity address. Only that
///             deployer reaches the address, and the slot is single use, so check the address has no code first.
///           - 20 zero bytes then 0x01 (the default): CREATE2, where the address also pins this init code.
contract DeployTacProvenOracle is Script {
    /// Intervals every proof answers for, from X - 1: through X + 3, so its prices keep answering for three intervals
    /// after its own, and within the four the shortest window (12 intervals at two thirds) can go unrecorded. Its depth
    /// answers for two (X - 1 and X): borrowing needs the proof of each interval within GRACE blocks of its end.
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

    /// True for a salt mined against a CREATE3 address, which CreateX binds to `deployer`: its first 20 bytes are the
    /// deployer and its 21st is zero. Any other accepted salt is the CREATE2 form, 20 zero bytes then 0x01.
    function isCreate3(bytes32 salt, address deployer) public pure returns (bool) {
        return bytes20(salt) == bytes20(deployer) && uint8(salt[20]) == 0;
    }

    /// The address CreateX gives `initCodeHash` under `salt`, a salt bound to this chain. The CREATE2 form only: a
    /// CREATE3 address does not depend on the init code, so `predictCreate3` takes no hash.
    function predict(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        require(bytes20(salt) == bytes20(0) && uint8(salt[20]) == 1, "salt form");
        bytes32 guarded = keccak256(abi.encode(block.chainid, salt));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), D.CREATEX, guarded, initCodeHash)))));
    }

    /// The address CreateX gives a deployer-bound CREATE3 salt, the form the salt pool mines. CreateX hashes the salt
    /// with the sender, so only `deployer` reaches this address and the slot is single use on this chain.
    function predictCreate3(bytes32 salt, address deployer) public view returns (address) {
        require(isCreate3(salt, deployer), "salt is not bound to this deployer");
        bytes32 guarded = keccak256(abi.encodePacked(uint256(uint160(deployer)), salt));
        return ICreateX3(D.CREATEX).computeCreate3Address(guarded);
    }

    function run() external {
        require(block.chainid == 1, "mainnet only");
        bytes32 vkey = vm.envBytes32("PROGRAM_VKEY");
        // The key of the committed program (build-program.sh writes the pin); ALLOW_UNPINNED_VKEY=1 for a fork or a test.
        if (!vm.envOr("ALLOW_UNPINNED_VKEY", false)) {
            string memory pin = vm.readFile(string.concat(vm.projectRoot(), "/sp1/tac-oracle/elf-vkey-pin.json"));
            require(vm.parseJsonBytes32(pin, ".program_vkey") == vkey, "PROGRAM_VKEY is not the pinned program's key");
        } else {
            console2.log("WARNING: the program key is NOT checked against the pin");
        }
        uint256 grace = vm.envUint("GRACE");
        require(grace > 0 && grace < D.ORACLE_STEP, "GRACE: 1 to STEP - 1 blocks for a proof to land in");
        bytes32 salt = vm.envOr("SALT", bytes32(uint256(1) << 88));
        bytes memory init = initCode(vkey, grace);
        // A salt the pool mined for a CREATE3 address carries the deployer; anything else is the CREATE2 form. The
        // CREATE3 address holds whatever its one deploy puts there, so the signers read the terms below off the chain
        // rather than from the address, which a CREATE2 address would itself pin to this init code.
        bool create3 = isCreate3(salt, msg.sender);
        address at = create3 ? predictCreate3(salt, msg.sender) : predict(salt, keccak256(init));
        console2.log(create3 ? "CREATE3, salt bound to the deployer" : "CREATE2, salt bound to the chain", msg.sender);
        if (at.code.length == 0) {
            vm.broadcast();
            address landed = create3
                ? ICreateX3(D.CREATEX).deployCreate3(salt, init)
                : ICreateX3(D.CREATEX).deployCreate2(salt, init);
            require(landed == at, "landed elsewhere");
            console2.log("deployed TacProvenOracle", at);
        } else {
            console2.log("already there", at);
        }
        TacProvenOracle o = TacProvenOracle(at);
        (bytes32 a, bytes32 b) = IAmmVenue(D.AMM_ORACLE).slots();
        require(o.SLOT_A() == a && o.SLOT_B() == b, "slots differ from the venue oracle's");
        require(o.PROGRAM_VKEY() == vkey && o.GRACE() == grace && o.FALLBACK() == D.PAIR_ORACLE, "terms");
        console2.log("terms the multisig signers commit to: PROGRAM_VKEY, GRACE, COUNT, FALLBACK");
        console2.logBytes32(o.PROGRAM_VKEY());
        console2.log("GRACE", o.GRACE());
        console2.log("COUNT", o.COUNT());
        console2.log("FALLBACK", o.FALLBACK());
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
