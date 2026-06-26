// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ICreateX} from "../src/ICreateX.sol";

/// @notice Faithful local CreateX CREATE3 + Random-salt-guard implementation, mirroring the
///         canonical factory (0xba5Ed0…) so the test runs offline. The two behaviors under test:
///
///         - deployCreate3(salt, initCode): guards `salt` (Random form → keccak256(abi.encode(salt))),
///           CREATE2-deploys the 16-byte proxy keyed on guardedSalt, then the proxy CREATEs initCode at
///           nonce 1. Address = f(this, guardedSalt) — independent of initCode.
///         - computeCreate3Address(salt): treats `salt` as ALREADY guarded (no _guard) and derives the
///           same proxy→child chain. So predicting a deploy requires passing the guarded salt.
///
///         This is the exact asymmetry DeployV1SuiteCreateX.predict() relies on.
contract MockCreateX is ICreateX {
    bytes internal constant PROXY_INITCODE = hex"67363d3d37363d34f03d5260086018f3";
    bytes32 internal constant PROXY_INITCODE_HASH = keccak256(PROXY_INITCODE);

    function _guardRandom(bytes32 salt) internal pure returns (bytes32) {
        // Random / ZeroAddress-False branch of CreateX._guard — portable, no msg.sender / chainid.
        return keccak256(abi.encode(salt));
    }

    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address newContract) {
        bytes32 guardedSalt = _guardRandom(salt);
        address proxy;
        bytes memory init = PROXY_INITCODE;
        assembly {
            proxy := create2(0, add(init, 0x20), mload(init), guardedSalt)
        }
        require(proxy != address(0), "proxy deploy failed");
        (bool ok,) = proxy.call(initCode);
        require(ok, "child deploy failed");
        newContract = _child(proxy);
        require(newContract.code.length != 0, "no child code");
    }

    function deployCreate3(bytes memory) external payable returns (address) {
        revert("unused");
    }

    function computeCreate3Address(bytes32 salt) external view returns (address) {
        return computeCreate3Address(salt, address(this));
    }

    function computeCreate3Address(bytes32 salt, address deployer) public pure returns (address) {
        // salt here is treated as already-guarded (matches canonical: NO _guard applied).
        address proxy = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, PROXY_INITCODE_HASH))))
        );
        return _child(proxy);
    }

    function _child(address proxy) internal pure returns (address) {
        // proxy CREATEs at nonce 1 → RLP(proxy, 0x01) = 0xd6 0x94 <20> 0x01.
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", proxy, hex"01")))));
    }
}

contract Payload {
    uint256 public immutable v;

    constructor(uint256 _v) {
        v = _v;
    }
}

contract DeployV1SuiteCreateXTest is Test {
    address constant CREATEX_ADDR = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;
    ICreateX createx;

    function setUp() public {
        // Etch the faithful CreateX at the canonical address (same address the live script targets).
        MockCreateX impl = new MockCreateX();
        vm.etch(CREATEX_ADDR, address(impl).code);
        createx = ICreateX(CREATEX_ADDR);
    }

    /// Portable Random salt: high bytes are entropy (!= msg.sender, != 0), byte[20] = 0x00 (not 0x01).
    function _salt(bytes12 vanity) internal pure returns (bytes32) {
        return bytes32(vanity) | bytes32(uint256(0xdead0000) << 64);
    }

    /// computeCreate3Address(guardedSalt) MUST equal where deployCreate3(rawSalt,…) actually lands.
    function test_predict_matches_actual_deploy() public {
        bytes32 rawSalt = _salt(hex"0102030405060708090a0b0c");
        bytes32 guarded = keccak256(abi.encode(rawSalt));
        address predicted = createx.computeCreate3Address(guarded);

        address deployed = createx.deployCreate3(rawSalt, abi.encodePacked(type(Payload).creationCode, abi.encode(uint256(42))));
        assertEq(deployed, predicted, "computeCreate3Address(guarded) must predict deployCreate3(raw)");
        assertEq(Payload(deployed).v(), 42);
    }

    /// CROSS-CHAIN PORTABILITY proof: same salt, DIFFERENT constructor args → SAME address.
    /// (CREATE3 address = f(factory, guardedSalt) only; initCode is irrelevant to the address.)
    function test_same_salt_diff_args_same_address() public {
        bytes32 rawSalt = _salt(hex"aabbccddeeff00112233aabb");

        // Snapshot the clean state so "chain B" deploys at the SAME factory/salt from scratch.
        uint256 snap = vm.snapshotState();

        // "Chain A": one set of constructor args.
        address a = createx.deployCreate3(rawSalt, abi.encodePacked(type(Payload).creationCode, abi.encode(uint256(111))));
        assertEq(Payload(a).v(), 111);

        // Roll back to the clean state (proxy + child gone, nonces reset) — emulates a different chain.
        vm.revertToState(snap);
        createx = ICreateX(CREATEX_ADDR); // re-bind (etch survives revert, but be explicit)

        // "Chain B": DIFFERENT constructor args, SAME salt → must land at the SAME address.
        address b = createx.deployCreate3(rawSalt, abi.encodePacked(type(Payload).creationCode, abi.encode(uint256(999))));
        assertEq(Payload(b).v(), 999, "chain B used the different arg");
        assertEq(b, a, "SAME salt -> SAME CREATE3 address regardless of constructor args (cross-chain portability)");
    }

    /// A salt that differs ONLY in the vanity entropy lands at a DIFFERENT address (sanity).
    function test_different_salt_different_address() public view {
        address x = createx.computeCreate3Address(keccak256(abi.encode(_salt(hex"000000000000000000000001"))));
        address y = createx.computeCreate3Address(keccak256(abi.encode(_salt(hex"000000000000000000000002"))));
        assertTrue(x != y);
    }
}
