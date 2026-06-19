// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ConfidentialPool, ISP1Verifier} from "../src/ConfidentialPool.sol";
import {CollateralEngine} from "../src/CollateralEngine.sol";
import {CanonicalAssetFactory} from "../src/CanonicalAssetFactory.sol";
import {CanonicalBridgedERC20} from "../src/CanonicalBridgedERC20.sol";

contract AcceptVerifier is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// End-to-end coverage for the DAY-1 cBTC link (closes M-1): with a CanonicalAssetFactory AND a
/// CollateralEngine both wired, the pool constructor deploy-or-adopts the canonical cBTC.tac ERC20 and pins
/// cBTC.zk → it, so (1) a cBTC note / a cUSD-CDP liquidation seize resolves to a mintable token (was
/// NotRegistered — see ConfidentialCdpCbtcSettle.test_liquidation_seize_of_unregistered_cbtc_fails_closed),
/// and (2) the engine's recoverSeizedCbtc can move the seized cBTC for the buy-and-burn. Real factory +
/// engine + pool (mock verifier only).
contract ConfidentialCbtcLinkTest is Test {
    ConfidentialPool pool;
    CanonicalAssetFactory factory;
    CollateralEngine engine;
    bytes32 constant CBTC = 0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8; // CBTC_ZK_ASSET_ID
    address admin = address(0xA11CE);

    function setUp() public {
        factory = new CanonicalAssetFactory();
        // Engine deployed first (pool unknown), wired after — the real circular-dep order.
        engine = new CollateralEngine(address(0), CBTC, 8, 8, admin);
        pool = new ConfidentialPool(
            address(new AcceptVerifier()),
            bytes32(uint256(0xABCD)),
            bytes32(0),
            address(factory), // factory wired
            address(0),
            bytes32(0),
            6,
            bytes32(0),
            bytes32(0),
            address(engine) // engine wired → triggers the constructor's day-1 cBTC pin
        );
        vm.prank(admin);
        engine.setPool(address(pool));
    }

    function _pv() internal view returns (ConfidentialPool.PublicValues memory pv) {
        pv.version = 1;
        pv.chainBinding = keccak256(abi.encodePacked(block.chainid, address(pool)));
    }

    function _cbtcTac() internal view returns (CanonicalBridgedERC20) {
        return CanonicalBridgedERC20(pool.canonicalTokenFor(CBTC));
    }

    function test_constructor_pins_cbtc_tac() public view {
        CanonicalBridgedERC20 cbtc = _cbtcTac();
        assertTrue(address(cbtc) != address(0), "cBTC.tac pinned");
        assertEq(cbtc.MINTER(), address(pool), "pool is the sole minter");
        assertEq(cbtc.ASSET_ID(), CBTC, "token commits CBTC_ZK_ASSET_ID");
        assertEq(cbtc.decimals(), 18, "canonical 18-dec ERC20");
        // resolves both directly (shared id) and via the cBTC note asset
        assertEq(pool.canonicalTokenFor(CBTC), address(cbtc));
    }

    // A cBTC withdrawal/seize now RESOLVES (M-1 link closed) and mints cBTC.tac at unitScale 10^10.
    function test_cbtc_withdrawal_resolves_and_mints() public {
        address recipient = address(0xB0B);
        uint64 vBtc = 100_000; // sats
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] = ConfidentialPool.Withdrawal({assetId: CBTC, recipient: recipient, value: vBtc});
        pool.settle(abi.encode(pv), "", new bytes[](0));
        assertEq(_cbtcTac().balanceOf(recipient), uint256(vBtc) * 1e10, "minted cBTC.tac = sats * 10^10");
    }

    // Full loop: a liquidation seizes cBTC to the engine (the controller-recipient), then the DAO recovers it.
    function test_seize_to_engine_then_recover() public {
        uint64 vBtc = 250_000;
        uint256 baseUnits = uint256(vBtc) * 1e10;
        ConfidentialPool.PublicValues memory pv = _pv();
        pv.withdrawals = new ConfidentialPool.Withdrawal[](1);
        pv.withdrawals[0] =
            ConfidentialPool.Withdrawal({assetId: CBTC, recipient: address(engine), value: vBtc});
        pool.settle(abi.encode(pv), "", new bytes[](0));

        CanonicalBridgedERC20 cbtc = _cbtcTac();
        assertEq(cbtc.balanceOf(address(engine)), baseUnits, "engine holds the seized cBTC.tac");

        address dao = address(0xDA0);
        vm.prank(admin);
        engine.recoverSeizedCbtc(baseUnits, dao);
        assertEq(cbtc.balanceOf(dao), baseUnits, "DAO recovered the seized cBTC for buy-and-burn");
        assertEq(cbtc.balanceOf(address(engine)), 0, "engine drained of the seized cBTC");
    }
}
