// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {assetOf} from "./helpers/AssetView.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract RealToken is ERC20 {
    function name() public pure override returns (string memory) { return "USD Coin"; }
    function symbol() public pure override returns (string memory) { return "USDC"; }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockSP1VerifierP is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

contract ConfidentialRegisterPoisonTest is Test {
    ConfidentialPool pool;
    RealToken usdc;
    address constant ATTACKER = address(0xBAD);
    address constant USER = address(0x111);

    function setUp() public {
        vm.chainId(1);
        pool = new ConfidentialPool(address(new MockSP1VerifierP()), bytes32(uint256(0xABCD)), bytes32(0), address(0), address(0), bytes32(0), 6, bytes32(0));
        usdc = new RealToken();
        usdc.mint(USER, 1_000_000e6);
        vm.prank(USER);
        usdc.approve(address(pool), type(uint256).max);
    }

    // GRIEF-2 (fixed): registerWrapped takes an operator-chosen unitScale and is permissionless, so an
    // attacker could once front-run a legit registration with an absurd scale that mis-aligns EVERY wrap
    // amount — permanently bricking that escrow token's confidential lane (no de-register/heal path).
    // The fix bounds an escrow asset's unitScale to its underlying's 10^decimals, so the poison reverts
    // BadDecimals and the honest auto-registration (scale derived from decimals) wins.
    function test_attacker_cannot_poison_unitScale() public {
        // attacker's absurd 10^30 scale (> 10^6 = USDC's 10^decimals) is rejected at registration.
        vm.prank(ATTACKER);
        vm.expectRevert(ConfidentialPool.BadDecimals.selector);
        pool.registerWrapped(address(usdc), 1e30, bytes32(0), "x", "x", 6);

        // the honest auto-registration then succeeds, deriving scale 1 (decimals 6 ≤ 8).
        bytes32 assetId = pool.registerWrappedAuto(address(usdc), bytes32(0));
        ConfidentialPool.Asset memory a = assetOf(pool, assetId);
        assertEq(a.unitScale, 1, "honest auto-scale (decimals 6 <= 8 => scale 1)");
        assertTrue(a.registered);

        // and a realistic USDC amount wraps fine — the lane is usable, not bricked.
        vm.prank(USER);
        pool.wrap(assetId, 1_000e6, keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)))));
    }
}
