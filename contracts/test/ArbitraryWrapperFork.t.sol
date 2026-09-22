// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {FarmController} from "../src/FarmController.sol";
import {ConfidentialPool} from "../src/ConfidentialPool.sol";

/// Plain ERC20 at any decimals.
contract StdToken is ERC20 {
    uint8 private immutable _d;
    constructor(uint8 d) { _d = d; }
    function name() public pure override returns (string memory) { return "Std"; }
    function symbol() public pure override returns (string memory) { return "STD"; }
    function decimals() public view override returns (uint8) { return _d; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// USDT-style: transfer/transferFrom/approve return NOTHING.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function decimals() external pure returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transfer(address to, uint256 a) external { balanceOf[msg.sender] -= a; balanceOf[to] += a; }
    function transferFrom(address f, address to, uint256 a) external {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[to] += a;
    }
}

/// Fee-on-transfer: the recipient always gets 1 wei less than sent.
contract FeeOnTransfer is ERC20 {
    function name() public pure override returns (string memory) { return "Fee"; }
    function symbol() public pure override returns (string memory) { return "FEE"; }
    function mint(address to, uint256 a) external { _mint(to, a); }
    function _afterTokenTransfer(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && amount > 0) _burn(to, 1);
    }
}

/// MAINNET FORK ONLY (skipped elsewhere): the live pool + a FarmController support ARBITRARY external wrapper tokens.
///   forge test --match-contract ArbitraryWrapperFork --fork-url $RPC -vv
/// For each token shape: register it as an escrow asset (scale derived from its decimals), fund a farm with it (escrow IN),
/// let the period + grace lapse with nobody staked, and recover it (payout OUT). Nothing may be lost or stuck.
contract ArbitraryWrapperFork is Test {
    address constant POOL = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address gov = address(0x60A);
    address funder = address(0xF00D);
    address sink = address(0x51AC);
    uint256 constant VALUE = 1e10; // in-system reward value units (8-decimal) to fund

    function setUp() public { if (block.chainid != 1) vm.skip(true); }

    function _roundTrip(address token, uint8 dec, function(address, address, uint256) internal mintFn) internal {
        uint8 tacitDec = dec > 8 ? 8 : dec;
        uint256 scale = 10 ** uint256(dec - tacitDec);
        uint256 amount = VALUE * scale;
        bytes32 id = ConfidentialPool(payable(POOL)).registerWrappedAuto(token, bytes32(0));
        (bool reg, address und, uint256 us, bytes32 link, bool minted, uint8 d) = ConfidentialPool(payable(POOL)).assets(id);
        assertTrue(reg); assertEq(und, token); assertEq(us, scale); assertEq(link, bytes32(0)); assertFalse(minted); assertEq(d, dec);

        FarmController farm = new FarmController(POOL, keccak256(abi.encode("stake", token)), id, true, true, gov, 0);
        mintFn(token, funder, amount);
        vm.startPrank(funder);
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", POOL, type(uint256).max));
        assertTrue(ok);
        ConfidentialPool(payable(POOL)).farmEscrow(address(farm), id, amount, address(0)); // escrow IN
        vm.stopPrank();
        assertEq(_bal(token, POOL), amount);

        vm.prank(gov);
        farm.notifyRewardAmount(VALUE, 1 days);
        vm.warp(block.timestamp + 1 days + 7 days + 1);
        vm.prank(gov);
        farm.recover(sink); // payout OUT
        assertEq(_bal(token, sink), amount); // every unit came back
        assertEq(_bal(token, POOL), 0);
    }

    function _bal(address t, address who) internal view returns (uint256) { return abi.decode(_call(t, abi.encodeWithSignature("balanceOf(address)", who)), (uint256)); }
    function _call(address t, bytes memory d) internal view returns (bytes memory r) { bool ok; (ok, r) = t.staticcall(d); require(ok); }
    function _mintStd(address t, address to, uint256 a) internal { StdToken(t).mint(to, a); }
    function _mintNoReturn(address t, address to, uint256 a) internal { NoReturnToken(t).mint(to, a); }

    function test_18DecimalWrapper() public { _roundTrip(address(new StdToken(18)), 18, _mintStd); }
    function test_6DecimalWrapper() public { _roundTrip(address(new StdToken(6)), 6, _mintStd); }
    function test_8DecimalWrapper() public { _roundTrip(address(new StdToken(8)), 8, _mintStd); }
    function test_0DecimalWrapper() public { _roundTrip(address(new StdToken(0)), 0, _mintStd); }
    function test_30DecimalWrapper() public { _roundTrip(address(new StdToken(30)), 30, _mintStd); }
    function test_tokenThatReturnsNothing() public { _roundTrip(address(new NoReturnToken()), 6, _mintNoReturn); }

    function test_moreThan77DecimalsIsRefused() public {
        StdToken t = new StdToken(78);
        vm.expectRevert();
        ConfidentialPool(payable(POOL)).registerWrappedAuto(address(t), bytes32(0));
    }

    function test_feeOnTransferTokenCannotFundAFarm() public {
        FeeOnTransfer t = new FeeOnTransfer();
        bytes32 id = ConfidentialPool(payable(POOL)).registerWrappedAuto(address(t), bytes32(0));
        FarmController farm = new FarmController(POOL, keccak256("stake"), id, true, true, gov, 0);
        t.mint(funder, 1000 ether);
        vm.startPrank(funder);
        t.approve(POOL, type(uint256).max);
        vm.expectRevert(); // the realized-delta guard: the pool never books more than it actually received
        ConfidentialPool(payable(POOL)).farmEscrow(address(farm), id, 100 ether, address(0));
        vm.stopPrank();
        assertEq(t.balanceOf(POOL), 0);
    }
}
