// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

interface IMarketDeploy {
    function deploy(uint256 id, bytes calldata initcode) external payable returns (address);
    function addressOf(uint256 id) external view returns (address);
    function ownerOf(uint256 id) external view returns (address);
}

interface IShopKeep {
    function keep(uint256 id, uint8 nonce, address to) external;
}

contract Rejects {
    fallback() external payable { revert("no"); }
}

/// The page's small contract that only passes ETH on (dapp/shop/shelf.js `forwarderInit`), deployed to a token's address through the live vanity market, on a mainnet fork.
/// Requires an RPC URL:  FORK_URL=https://ethereum-rpc.publicnode.com forge test --match-path test/ShopForwarderFork.t.sol
/// Skips (not fails) when FORK_URL is unset. The token is minted on the fork only, by the live shop's owner.
contract ShopForwarderForkTest is Test {
    address constant SHOP = 0x00000000000785882df83d4CC6ED45c21eB1176C;
    IMarketDeploy constant MARKET = IMarketDeploy(0x000000000000b361194cfe6312EE3210d53C15AA);
    address constant OPS = 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2;

    function _fork() internal returns (bool) {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) { emit log("FORK_URL unset - skipping"); return false; }
        vm.createSelectFork(url);
        return true;
    }

    // the creation code, spelled out: PUSH1 0x23 DUP1 PUSH1 0x09 PUSH0 CODECOPY PUSH0 RETURN, then the runtime:
    // PUSH0 x4, SELFBALANCE, PUSH20 <to>, GAS, CALL, PUSH1 0x22, JUMPI, PUSH0, PUSH0, REVERT, JUMPDEST
    function _forwarder(address to) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"60238060095f395ff3", hex"5f5f5f5f47", hex"73", to, hex"5af16022575f5ffd5b");
    }

    function _token(uint96 low, uint8 nonce) internal returns (uint256 id, address vanity) {
        id = (uint256(uint160(SHOP)) << 96) | low;
        vm.prank(OPS);
        IShopKeep(SHOP).keep(id, nonce, address(this));
        vanity = MARKET.addressOf(id);
    }

    function testItDeploysThroughTheMarketAndPassesEthOn() public {
        if (!_fork()) return;
        address receiver = makeAddr("receiver");
        (uint256 id, address vanity) = _token(0x7777, 3);
        assertEq(vanity.code.length, 0);
        uint256 g = gasleft();
        address got = MARKET.deploy(id, _forwarder(receiver));
        uint256 used = g - gasleft();
        assertEq(got, vanity, 'it lands at the address the token stands for');
        assertEq(vanity.code.length, 35, 'the 35 bytes');
        assertEq(keccak256(vanity.code), keccak256(abi.encodePacked(hex"5f5f5f5f47", hex"73", receiver, hex"5af16022575f5ffd5b")), 'and exactly that code');
        assertLt(used, 400_000, 'a low nonce costs little to deploy');
        vm.expectRevert(); MARKET.ownerOf(id);                     // the token is used up

        vm.deal(address(this), 10 ether);
        (bool ok,) = vanity.call{value: 1 ether}("");
        assertTrue(ok); assertEq(receiver.balance, 1 ether); assertEq(vanity.balance, 0);
        (ok,) = vanity.call{value: 2 ether}(hex"deadbeef");           // any call data
        assertTrue(ok); assertEq(receiver.balance, 3 ether); assertEq(vanity.balance, 0);
        (ok,) = vanity.call("");                                      // no ETH
        assertTrue(ok); assertEq(receiver.balance, 3 ether);
        vm.deal(vanity, 4 ether);                                     // ETH that got in without a call goes on with the next one
        (ok,) = vanity.call("");
        assertTrue(ok); assertEq(receiver.balance, 7 ether); assertEq(vanity.balance, 0);
    }

    function testAReceiverThatTurnsEthAwayMakesTheSendFail() public {
        if (!_fork()) return;
        address receiver = address(new Rejects());
        (uint256 id, address vanity) = _token(0x7778, 0);
        MARKET.deploy(id, _forwarder(receiver));
        vm.deal(address(this), 1 ether);
        (bool ok,) = vanity.call{value: 1 ether}("");
        assertFalse(ok, 'the send reverts instead of leaving the ETH in it');
        assertEq(address(this).balance, 1 ether); assertEq(vanity.balance, 0);
    }

    function testAHighNonceCostsAboutOneEmptyContractCreationPerStep() public {
        if (!_fork()) return;
        address receiver = makeAddr("receiver");
        (uint256 id,) = _token(0x7779, 40);
        uint256 g = gasleft();
        MARKET.deploy(id, _forwarder(receiver));
        uint256 used = g - gasleft();
        assertGt(used, 40 * 30_000, 'forty steps are forty creations');
        assertLt(used, 40 * 40_000 + 200_000);
    }

    receive() external payable {}
}
