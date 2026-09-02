// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../src/lib/BitcoinLightRelay.sol";

// Extends the abstract base (not the sealed production BitcoinLightRelay) so it can loosen the difficulty
// decode for signet — it is a separate, testnet-only contract, never the production relay.
contract TestnetLightRelay is BitcoinLightRelayBase {
    // Signet powLimit (0x00000377ae…, easier/larger than the mainnet cap) — signet blocks are below
    // mainnet difficulty, so MAX_TARGET must be the signet floor or the retarget clamp would cap real
    // signet targets. initTestnetGenesis below seeds the anchor directly (no MAX_TARGET genesis check).
    constructor() BitcoinLightRelayBase(0x00000377ae000000000000000000000000000000000000000000000000000000) {}

    function _bitsToTarget(uint32 bits) internal pure override returns (uint256) {
        if (bits & 0x00800000 != 0) revert InvalidTarget();
        uint256 exp = bits >> 24;
        uint256 mantissa = bits & 0x7fffff;
        if (mantissa == 0) revert InvalidTarget();
        uint256 target;
        if (exp <= 3) {
            target = mantissa >> (8 * (3 - exp));
        } else {
            if (exp > 32) revert InvalidPoW();
            target = mantissa << (8 * (exp - 3));
        }
        if (target == 0) revert InvalidTarget();
        return target;
    }
    // Not named with a `test` prefix: forge's fuzzer targets any external
    // `test*` function, and a deploy-only initializer fuzzed with adversarial
    // args is a spurious suite failure.
    function initTestnetGenesis(
        uint256 epochStart, uint256 target, uint256 startTimestamp,
        bytes32 tipHash, uint256 tipHeight_, uint256 tipWork_
    ) external {
        if (msg.sender != DEPLOYER) revert Unauthorized();
        if (initialized) revert AlreadyInitialized();
        require(tipWork_ > 0);
        uint256 epoch = epochStart / EPOCH_LENGTH;
        genesisEpoch = epoch;
        epochStartTimestamp[epoch] = startTimestamp;
        tip = tipHash;
        tipHeight = tipHeight_;
        tipWork = tipWork_;
        blockWork[tipHash] = tipWork_;
        blockHeight[tipHash] = tipHeight_;
        // Per-branch target of the anchor: blocks above it inherit/derive from here. Without it the first
        // advanceTip reads blockTarget[prev] == 0 and reverts UnknownEpoch, bricking the relay.
        blockTarget[tipHash] = target;
        // RELAY-3: seed genesis timestamp for advanceTip's monotonic check.
        blockTimestamp[tipHash] = uint32(startTimestamp);
        initialized = true;
    }
}
