// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {RelayRegistry} from "../src/RelayRegistry.sol";

interface ICreateX5 {
    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address newContract);
    function computeCreate3Address(bytes32 guardedSalt, address deployer) external pure returns (address computedAddress);
}

interface ITokenView {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Deploys RelayRegistry on Ethereum, staked in TAC. Nothing is deployed from a guess: the owner of the two numbers is named in the environment, and
///         the zero address (which fixes them for good) must be written out, not left out.
///
///           REGISTRY_ADMIN=0x… forge script script/DeployRelayRegistry.s.sol --rpc-url $RPC --sender $DEPLOYER                       (simulate)
///           REGISTRY_ADMIN=0x… forge script script/DeployRelayRegistry.s.sol --rpc-url $RPC --broadcast --private-key $KEY           (deploy)
///
///         REGISTRY_ADMIN: the owner of `minStake` and `unstakeDelay` (a DAO), or 0x0000…0000 to fix them. An owner with no code is refused unless
///         REGISTRY_ADMIN_IS_EOA=1: a bare key owning the numbers is a choice to make on purpose.
///         The numbers and their bounds are the defaults below unless set: REGISTRY_MIN_STAKE, REGISTRY_UNSTAKE_DELAY (seconds), REGISTRY_MIN_STAKE_LO / _HI,
///         REGISTRY_DELAY_LO / _HI, REGISTRY_PARAM_DELAY, as plain whole numbers in the token's smallest unit (2500000000000000000000, not 2,500 or 2500e18 or
///         7days). A setting that is present and cannot be read stops the run: forge's own default-if-unreadable would deploy the defaults without a word.
///         Leave a setting out to take its default; do not leave it empty. They are printed, and what is chosen here is what the deployment keeps: the bounds
///         cannot move. The defaults are written in 18-decimal TAC: another REGISTRY_TOKEN needs REGISTRY_MIN_STAKE, _LO and _HI set in its own units, and the
///         registry refuses a token that keeps a fee on a transfer.
///         REGISTRY_SALT (a banked salt of the deployer) puts it at CreateX's CREATE3 address for that salt, which depends on the salt and the deployer alone and
///         not on these arguments, so a wrong but valid number would keep the vanity address for good: read the printout before the broadcast. A salt needs
///         REGISTRY_EXPECTED, the address it must land at (a mistyped digit in a salt is still a valid salt, at another address), and the run refuses any
///         other. Without a salt it is a plain CREATE.
contract DeployRelayRegistry is Script {
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    ICreateX5 constant CREATEX = ICreateX5(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    function _uint(string memory name, uint256 def) internal view returns (uint256) {
        return vm.envExists(name) ? vm.envUint(name) : def;
    }

    function run() external returns (RelayRegistry reg) {
        require(vm.envExists("REGISTRY_ADMIN"), "set REGISTRY_ADMIN: the owner of the two numbers, or 0x0000000000000000000000000000000000000000 to fix them for good");
        address admin = vm.envAddress("REGISTRY_ADMIN");
        address token = vm.envExists("REGISTRY_TOKEN") ? vm.envAddress("REGISTRY_TOKEN") : TAC;
        if (token != TAC) {
            require(
                vm.envExists("REGISTRY_MIN_STAKE") && vm.envExists("REGISTRY_MIN_STAKE_LO") && vm.envExists("REGISTRY_MIN_STAKE_HI"),
                "another token: set REGISTRY_MIN_STAKE, REGISTRY_MIN_STAKE_LO and REGISTRY_MIN_STAKE_HI in its own units (the defaults are 18-decimal TAC)"
            );
        }
        uint256 minStake = _uint("REGISTRY_MIN_STAKE", 2_500 ether);
        uint256 delay = _uint("REGISTRY_UNSTAKE_DELAY", 7 days);
        uint256 minLo = _uint("REGISTRY_MIN_STAKE_LO", 500 ether);
        uint256 minHi = _uint("REGISTRY_MIN_STAKE_HI", 25_000 ether);
        uint256 delayLo = _uint("REGISTRY_DELAY_LO", 1 days);
        uint256 delayHi = _uint("REGISTRY_DELAY_HI", 30 days);
        uint256 paramDelay = _uint("REGISTRY_PARAM_DELAY", 2 days);
        bytes32 salt = vm.envExists("REGISTRY_SALT") ? vm.envBytes32("REGISTRY_SALT") : bytes32(0);
        address expected = vm.envExists("REGISTRY_EXPECTED") ? vm.envAddress("REGISTRY_EXPECTED") : address(0);

        require(token.code.length > 0, "no token at REGISTRY_TOKEN on this chain");
        // the same rule the contract holds: with an owner, a change must wait between a day and a year, or "time to see it" is empty
        require(admin == address(0) || (paramDelay >= 1 days && paramDelay <= 365 days), "REGISTRY_PARAM_DELAY must be between 1 and 365 days when there is an owner");
        if (admin != address(0) && admin.code.length == 0) {
            require(vm.envExists("REGISTRY_ADMIN_IS_EOA") && vm.envBool("REGISTRY_ADMIN_IS_EOA"), "REGISTRY_ADMIN has no code: set REGISTRY_ADMIN_IS_EOA=1 if a bare key is meant");
        }
        require(salt == bytes32(0) || expected != address(0), "a REGISTRY_SALT needs REGISTRY_EXPECTED: the address it must land at");
        // the token has to take a permit (one-transaction staking) and be the 18-decimal TAC the numbers are written for; with another token the numbers are its own
        ITokenView(token).DOMAIN_SEPARATOR();
        uint8 dec = ITokenView(token).decimals();
        if (token == TAC) require(dec == 18, "TAC is not at 18 decimals here");
        uint256 unit = 10 ** dec;

        console2.log("token", token, ITokenView(token).symbol());
        console2.log("  decimals", dec);
        console2.log("owner of the two numbers (zero: fixed)", admin);
        console2.log("min stake, whole tokens", minStake / unit);
        console2.log("  raw", minStake);
        console2.log("  bounds, whole tokens", minLo / unit, minHi / unit);
        console2.log("  bounds, raw", minLo, minHi);
        console2.log("unstake delay, in days", delay / 1 days);
        console2.log("  bounds", delayLo / 1 days, delayHi / 1 days);
        console2.log("a change waits, in days", paramDelay / 1 days);

        bytes memory init = abi.encodePacked(type(RelayRegistry).creationCode, abi.encode(token, admin, minStake, delay, minLo, minHi, delayLo, delayHi, paramDelay));
        vm.startBroadcast();
        if (salt == bytes32(0)) {
            require(expected == address(0), "REGISTRY_EXPECTED needs a REGISTRY_SALT: a plain deploy's address depends on the nonce");
            reg = new RelayRegistry(token, admin, minStake, delay, minLo, minHi, delayLo, delayHi, paramDelay);
        } else {
            (, address deployer,) = vm.readCallers();
            // CreateX guards a salt that leads with its sender and a zero flag byte as keccak256(sender ‖ salt): only that sender can deploy with it
            require(address(bytes20(salt)) == deployer, "this salt is not the deployer's: its first 20 bytes are another address");
            require(salt[20] == 0x00, "this salt's flag byte is not 0x00");
            address predicted = CREATEX.computeCreate3Address(keccak256(abi.encode(deployer, salt)), address(CREATEX));
            require(predicted.code.length == 0, "something is already at this salt's address (spent)");
            require(expected == address(0) || predicted == expected, "this salt's address is not REGISTRY_EXPECTED");
            address deployed = CREATEX.deployCreate3(salt, init);
            require(deployed == predicted, "did NOT land at the predicted address");
            reg = RelayRegistry(deployed);
        }
        vm.stopBroadcast();

        require(reg.TOKEN() == token && reg.owner() == admin && reg.minStake() == minStake && reg.unstakeDelay() == delay, "the deployed registry does not read back as asked");
        require(
            reg.MIN_STAKE_LO() == minLo && reg.MIN_STAKE_HI() == minHi && reg.DELAY_LO() == delayLo && reg.DELAY_HI() == delayHi && reg.PARAM_DELAY() == paramDelay,
            "the deployed registry's bounds do not read back as asked"
        );
        console2.log("RelayRegistry deployed at", address(reg));
    }
}
