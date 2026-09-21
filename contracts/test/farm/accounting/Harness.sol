// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CdpLeg} from "../../../src/ConfidentialPool.sol";
import {FarmManager} from "../../../src/FarmManager.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// Plays the pool: same farmEscrow/farmTreasury semantics, harvest debits treasury BEFORE the hook.
contract MockPool {
    bytes32 public constant REWARD = keccak256("REWARD");
    MockToken public token;
    uint256 public unitScale;
    mapping(address => uint256) public farmTreasury;
    mapping(address => bytes32) public farmRewardAsset;
    mapping(bytes32 => bool) public harvestConsumed;
    uint256 public nonce;
    uint256 public totalReleased; // underlying released via recover
    uint256 public totalHarvested; // value units minted as reward notes

    constructor(MockToken t, uint256 scale) { token = t; unitScale = scale; }

    function assets(bytes32 id) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        if (id == REWARD) return (true, address(token), unitScale, bytes32(0), false, 18);
        return (true, address(0), 1, bytes32(0), true, 18);
    }

    function farmEscrow(address controller, bytes32 rewardAsset, uint256 amount, address to)
        external returns (uint256 out)
    {
        if (amount == 0) {
            require(farmRewardAsset[msg.sender] != bytes32(0) && farmRewardAsset[msg.sender] == rewardAsset, "pin");
            uint256 reserve = FarmManager(msg.sender).outstandingReward();
            out = farmTreasury[msg.sender];
            if (out > reserve) out -= reserve; else out = 0;
            farmTreasury[msg.sender] -= out;
            token.transfer(to, out * unitScale);
            totalReleased += out;
        } else {
            bytes32 pinned = farmRewardAsset[controller];
            if (pinned == bytes32(0)) {
                require(rewardAsset == FarmManager(controller).REWARD_ASSET(), "asset");
                farmRewardAsset[controller] = rewardAsset;
            } else require(pinned == rewardAsset, "asset2");
            require(amount % unitScale == 0, "align");
            token.transferFrom(msg.sender, address(this), amount);
            out = amount / unitScale;
            farmTreasury[controller] += out;
        }
    }

    // ---- what _settle does (fresh harvest id every call, as the guest supplies per-action ids) ----
    function bond(FarmManager m, bytes32 receipt, bytes32 stakeAsset, uint256 shares) external {
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(stakeAsset, shares);
        m.onCdpMint(l, 0, bytes32(uint256(1)), uint256(receipt));
    }

    function harvest(FarmManager m, bytes32 receipt, uint256 shares, uint256 amount) external {
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(REWARD, shares);
        require(farmTreasury[address(m)] >= amount, "InsufficientEscrow");
        farmTreasury[address(m)] -= amount;
        totalHarvested += amount;
        m.onCdpMint(l, amount, bytes32(uint256(1)), uint256(receipt));
    }

    function unbond(FarmManager m, bytes32 receipt, bytes32 stakeAsset, uint256 shares) external {
        CdpLeg[] memory l = new CdpLeg[](1);
        l[0] = CdpLeg(stakeAsset, shares);
        m.onCdpClose(0, 0, uint256(receipt), l, bytes32(0));
    }
}
