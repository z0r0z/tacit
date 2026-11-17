// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {TacitSplitDeposit} from "../src/TacitSplitDeposit.sol";

interface IPoolView {
    function ASSET() external view returns (address);
    function denomination() external view returns (uint256);
}

interface ICreateX4 {
    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address newContract);
    function computeCreate3Address(bytes32 guardedSalt, address deployer) external pure returns (address computedAddress);
}

/// @notice Deploys TacitSplitDeposit with the mainnet defaults: the Tacit ETH pool and the four Tornado Cash ETH pools (0.1, 1, 10, 100 ETH).
///         The contract has no owner and nothing to configure after this: the pools it will send to are fixed here and cannot be changed.
///
///           forge script script/DeploySplitDeposit.s.sol --rpc-url $RPC --sender $DEPLOYER                      (simulate: prints the address and the pools)
///           forge script script/DeploySplitDeposit.s.sol --rpc-url $RPC --broadcast --private-key $KEY          (deploy)
///
///         SPLIT_SALT (a banked salt of the deployer) puts it at CreateX's CREATE3 address for that salt, which depends on the salt and the deployer alone,
///         so the address is known before the deploy and no one else can take it; SPLIT_EXPECTED makes the run refuse any other address. Without a salt it
///         is a plain CREATE at the deployer's next nonce (do not publish that address before the deploy has landed). On another chain set SPLIT_TACIT_POOL
///         and SPLIT_POOLS (comma separated); the run refuses a pool with no code, and the contract's constructor refuses one that gives no size.
///         The page is told the address in dapp/fixed-pool-pay.js (SPLIT_DEPOSITORS), after a canary has shown a Tacit deposit goes through it.
contract DeploySplitDeposit is Script {
    address constant TACIT_ETH_POOL = 0x000000c2A20657CE25f2Ba99737933D031AFBEE9;
    address constant T01 = 0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc;
    address constant T1 = 0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936;
    address constant T10 = 0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF;
    address constant T100 = 0xA160cdAB225685dA1d56aa342Ad8841c3b53f291;
    ICreateX4 constant CREATEX = ICreateX4(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    function run() external returns (TacitSplitDeposit fwd) {
        address tacit = vm.envOr("SPLIT_TACIT_POOL", TACIT_ETH_POOL);
        address[] memory pools;
        if (vm.envExists("SPLIT_POOLS")) {
            pools = vm.envAddress("SPLIT_POOLS", ",");
        } else {
            pools = new address[](4);
            pools[0] = T01;
            pools[1] = T1;
            pools[2] = T10;
            pools[3] = T100;
        }
        bytes32 salt = vm.envOr("SPLIT_SALT", bytes32(0));
        address expected = vm.envOr("SPLIT_EXPECTED", address(0));

        require(tacit.code.length > 0, "no Tacit pool at SPLIT_TACIT_POOL on this chain");
        require(IPoolView(tacit).ASSET() == address(0), "the Tacit pool is not the ETH pool (its ASSET is not the zero address)");
        for (uint256 i; i < pools.length; ++i) require(pools[i].code.length > 0, "a pool in the list has no code on this chain");
        // A salted CREATE3 address does not depend on the constructor arguments, so a wrong but valid argument would burn the salt for good: with the defaults, the
        // four pools must be the four sizes they are meant to be, in this order. With SPLIT_POOLS the sizes are printed below for the operator to check.
        if (!vm.envExists("SPLIT_POOLS")) {
            uint256[4] memory want = [uint256(0.1 ether), 1 ether, 10 ether, 100 ether];
            for (uint256 i; i < 4; ++i) require(IPoolView(pools[i]).denomination() == want[i], "a default pool is not the size it should be");
        }

        vm.startBroadcast();
        if (salt == bytes32(0)) {
            require(expected == address(0), "SPLIT_EXPECTED needs a SPLIT_SALT: a plain deploy's address depends on the nonce");
            fwd = new TacitSplitDeposit(tacit, pools);
        } else {
            (, address deployer,) = vm.readCallers();
            // CreateX guards a salt that leads with its sender and a zero flag byte as keccak256(sender ‖ salt): only that sender can deploy with it
            require(address(bytes20(salt)) == deployer, "this salt is not the deployer's: its first 20 bytes are another address");
            require(salt[20] == 0x00, "this salt's flag byte is not 0x00");
            address predicted = CREATEX.computeCreate3Address(keccak256(abi.encode(deployer, salt)), address(CREATEX));
            require(predicted.code.length == 0, "something is already at this salt's address (spent)");
            require(expected == address(0) || predicted == expected, "this salt's address is not SPLIT_EXPECTED");
            address deployed = CREATEX.deployCreate3(salt, abi.encodePacked(type(TacitSplitDeposit).creationCode, abi.encode(tacit, pools)));
            require(deployed == predicted, "did NOT land at the predicted address");
            fwd = TacitSplitDeposit(deployed);
        }
        vm.stopBroadcast();

        require(address(fwd.TACIT_POOL()) == tacit, "wiring mismatch");
        console2.log("TacitSplitDeposit deployed at:", address(fwd));
        console2.log("  Tacit ETH pool:", tacit);
        for (uint256 i; i < pools.length; ++i) console2.log("  pool, size in wei:", pools[i], fwd.denominationOf(pools[i]));
    }
}
