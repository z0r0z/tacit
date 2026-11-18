// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {RelayRegistry} from "../src/RelayRegistry.sol";

/// Stands in for TAC: a Solady ERC-20 named and sized as the real one, with a mint for the tests.
contract TestTAC is ERC20 {
    function name() public pure override returns (string memory) {
        return "Tacit Token";
    }

    function symbol() public pure override returns (string memory) {
        return "TAC";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A token that can start keeping one percent of every transfer, which the registry must refuse (it would owe more than it holds).
contract FeeToken is TestTAC {
    bool public taking;

    function take(bool on) external {
        taking = on;
    }

    function _afterTokenTransfer(address from, address to, uint256 amount) internal override {
        if (taking && from != address(0) && to != address(0)) _burn(to, amount / 100);
    }
}

contract RelayRegistryTest is Test {
    TestTAC tac;
    RelayRegistry reg;

    address constant DAO = address(0xDA0);
    address relayerA = address(0xA11CE);
    address relayerB = address(0xB0B);
    address cold = address(0xC01D);

    uint256 constant MIN = 2_500e18;
    uint256 constant DELAY = 7 days;
    uint256 constant PARAM_DELAY = 2 days;
    string constant URL = "https://relay.example/1/evm-pool/keeper";

    function setUp() public {
        vm.warp(1_800_000_000);
        tac = new TestTAC();
        reg = new RelayRegistry(address(tac), DAO, MIN, DELAY, 500e18, 100_000e18, 1 days, 30 days, PARAM_DELAY);
        tac.mint(relayerA, 1_000_000e18);
        tac.mint(relayerB, 1_000_000e18);
    }

    function _reg(address who, uint64 chainId, string memory url, address owner_, uint256 amount) internal returns (uint256 id) {
        vm.startPrank(who);
        tac.approve(address(reg), type(uint256).max);
        id = reg.register(chainId, url, owner_, amount);
        vm.stopPrank();
    }

    function _list(uint64 chainId) internal view returns (address[] memory r, uint256[] memory s, string[] memory u, uint256 next) {
        return reg.list(chainId, 0, 100);
    }

    // ---- registering ----

    function testRegisterLocksTheStakeAndListsTheRelay() public {
        uint256 id = _reg(relayerA, 1, URL, cold, MIN);
        assertEq(id, 1);
        assertEq(tac.balanceOf(address(reg)), MIN);
        assertEq(tac.balanceOf(relayerA), 1_000_000e18 - MIN);
        (address relayer, uint64 chainId, uint32 pos, address owner_, uint64 exitAt, uint256 stake) = reg.relays(id);
        assertEq(relayer, relayerA);
        assertEq(chainId, 1);
        assertEq(pos, 0);
        assertEq(owner_, cold);
        assertEq(exitAt, 0);
        assertEq(stake, MIN);
        assertEq(reg.urlOf(id), URL);
        assertEq(reg.idOf(keccak256(abi.encode(uint64(1), relayerA))), id);
        (address[] memory r, uint256[] memory s, string[] memory u, uint256 next) = _list(1);
        assertEq(r.length, 1);
        assertEq(r[0], relayerA);
        assertEq(s[0], MIN);
        assertEq(u[0], URL);
        assertEq(next, 1);
    }

    function testTheRegistrantIsTheRelayerSoNoOneListsAnotherAddress() public {
        // there is no argument naming the relayer: it is the caller, so an address nobody holds the key to cannot be listed
        _reg(relayerA, 1, URL, cold, MIN);
        (address r,,,,,) = reg.relays(1);
        assertEq(r, relayerA);
        vm.prank(relayerB);
        tac.approve(address(reg), MIN);
        vm.prank(relayerB);
        uint256 id = reg.register(1, "https://other.example/evm-pool/keeper", cold, MIN);
        (address rb,,,,,) = reg.relays(id);
        assertEq(rb, relayerB);
    }

    function testStakeBelowTheMinimumIsRefusedAndTheMinimumIsAccepted() public {
        vm.startPrank(relayerA);
        tac.approve(address(reg), type(uint256).max);
        vm.expectRevert(RelayRegistry.BelowMinimum.selector);
        reg.register(1, URL, cold, MIN - 1);
        reg.register(1, URL, cold, MIN);
        vm.stopPrank();
    }

    function testOneEntryForARelayerOnAChainButOtherChainsAreFree() public {
        _reg(relayerA, 1, URL, cold, MIN);
        vm.startPrank(relayerA);
        vm.expectRevert(RelayRegistry.AlreadyListed.selector);
        reg.register(1, "https://two.example/evm-pool/keeper", cold, MIN);
        reg.register(8453, "https://relay.example/8453/evm-pool/keeper", cold, MIN);
        vm.stopPrank();
        (address[] memory r1,,,) = _list(1);
        (address[] memory r2,,,) = _list(8453);
        assertEq(r1.length, 1);
        assertEq(r2.length, 1);
        (address[] memory r3,,,) = _list(4663);
        assertEq(r3.length, 0);
    }

    function testZeroChainAndZeroOwnerAreRefused() public {
        vm.startPrank(relayerA);
        tac.approve(address(reg), type(uint256).max);
        vm.expectRevert(RelayRegistry.BadChain.selector);
        reg.register(0, URL, cold, MIN);
        vm.expectRevert(RelayRegistry.BadOwner.selector);
        reg.register(1, URL, address(0), MIN);
        // an owner that cannot call startExit would hold the stake for good: the registry and the token are such
        vm.expectRevert(RelayRegistry.BadOwner.selector);
        reg.register(1, URL, address(reg), MIN);
        vm.expectRevert(RelayRegistry.BadOwner.selector);
        reg.register(1, URL, address(tac), MIN);
        vm.stopPrank();
    }

    function testUrlRules() public {
        string[15] memory bad = [
            "http://relay.example/evm-pool/keeper", // not https
            "https://relay.example/evm-pool/keepers", // wrong ending
            "https://relay.example/evm-pool/keeper/", // trailing slash
            "https://relay.example/evm-pool/keeper?x=1", // query
            "https://relay.example/evm-pool/keeper#x", // fragment
            "https://user:pw@relay.example/evm-pool/keeper", // credentials
            "https://relay example/evm-pool/keeper", // a space
            "https://relay.example/evm-pool/keeper\n", // a control character
            "ftp://relay.example/evm-pool/keeper", // another scheme
            "https:///evm-pool/keeper", // no host
            "/evm-pool/keeper", // no scheme
            "https://relay.example/evm-pool/Keeper", // case
            "https://./evm-pool/keeper", // a dot for a host (long enough, so not refused for its size)
            "https://:/evm-pool/keeper", // a colon for a host
            "https:////evm-pool/keeper" // an empty host
        ];
        vm.startPrank(relayerA);
        tac.approve(address(reg), type(uint256).max);
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(RelayRegistry.BadUrl.selector);
            reg.register(1, bad[i], cold, MIN);
        }
        // too long: 129 bytes
        bytes memory host = new bytes(129 - 8 - 16);
        for (uint256 i; i < host.length; ++i) host[i] = "a";
        vm.expectRevert(RelayRegistry.BadUrl.selector);
        reg.register(1, string.concat("https://", string(host), "/evm-pool/keeper"), cold, MIN);
        // exactly 128 is fine, and so are a port, a path under a chain id, an underscore, a hyphen and capitals
        bytes memory host2 = new bytes(128 - 8 - 16);
        for (uint256 i; i < host2.length; ++i) host2[i] = "a";
        reg.register(1, string.concat("https://", string(host2), "/evm-pool/keeper"), cold, MIN);
        reg.register(2, "https://Relay-1_a.example:8443/8453/evm-pool/keeper", cold, MIN);
        vm.stopPrank();
    }

    function testRegisterWithPermitIsOneTransaction() public {
        (address who, uint256 pk) = makeAddrAndKey("permit relayer");
        tac.mint(who, MIN);
        (uint8 v, bytes32 r, bytes32 s) = _permit(pk, who, address(reg), MIN, block.timestamp + 1 hours);
        vm.prank(who);
        uint256 id = reg.registerWithPermit(1, URL, cold, MIN, block.timestamp + 1 hours, v, r, s);
        (address relayer,,,,, uint256 stake) = reg.relays(id);
        assertEq(relayer, who);
        assertEq(stake, MIN);
        assertEq(tac.balanceOf(who), 0);
    }

    function testAPermitTakenFromTheMempoolAndSentFirstDoesNotStopTheRegistration() public {
        (address who, uint256 pk) = makeAddrAndKey("front-run relayer");
        tac.mint(who, MIN);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(pk, who, address(reg), MIN, deadline);
        tac.permit(who, address(reg), MIN, deadline, v, r, s); // someone else sends the permit first
        vm.prank(who);
        reg.registerWithPermit(1, URL, cold, MIN, deadline, v, r, s); // the permit reverts inside; the allowance is there
        (address relayer,,,,,) = reg.relays(1);
        assertEq(relayer, who);
    }

    function testABadPermitWithNoAllowanceStopsTheRegistration() public {
        (address who, uint256 pk) = makeAddrAndKey("no allowance");
        tac.mint(who, MIN);
        (uint8 v, bytes32 r, bytes32 s) = _permit(pk, who, address(reg), MIN, block.timestamp - 1); // expired
        vm.prank(who);
        vm.expectRevert();
        reg.registerWithPermit(1, URL, cold, MIN, block.timestamp - 1, v, r, s);
    }

    function _permit(uint256 pk, address owner_, address spender, uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), owner_, spender, value, tac.nonces(owner_), deadline)
        );
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", tac.DOMAIN_SEPARATOR(), structHash)));
    }

    // ---- stake, url ----

    function testAnyoneCanTopUpAndTheStakeIsTheOwners() public {
        uint256 id = _reg(relayerA, 1, URL, cold, MIN);
        vm.startPrank(relayerB);
        tac.approve(address(reg), 1_000e18);
        reg.topUp(id, 1_000e18);
        vm.stopPrank();
        (,,,,, uint256 stake) = reg.relays(id);
        assertEq(stake, MIN + 1_000e18);
        (, uint256[] memory s,,) = _list(1);
        assertEq(s[0], MIN + 1_000e18);
        // the one who topped up cannot take it back: only the entry's owner exits
        vm.prank(relayerB);
        vm.expectRevert(RelayRegistry.NotYours.selector);
        reg.startExit(id);
    }

    function testNoTopUpOfAnEntryThatIsLeaving() public {
        uint256 id = _reg(relayerA, 1, URL, cold, MIN);
        vm.prank(cold);
        reg.startExit(id);
        vm.startPrank(relayerB);
        tac.approve(address(reg), 1e18);
        vm.expectRevert(RelayRegistry.Exiting.selector);
        reg.topUp(id, 1e18);
        vm.stopPrank();
    }

    function testTopUpOfNothingThatExistsIsRefused() public {
        vm.expectRevert(RelayRegistry.NoSuchRelay.selector);
        reg.topUp(99, 1);
    }

    function testTheOwnerOrTheRelayerMovesTheUrlAndNoOneElse() public {
        uint256 id = _reg(relayerA, 1, URL, cold, MIN);
        string memory next = "https://new.example/1/evm-pool/keeper";
        vm.prank(cold);
        reg.setUrl(id, next);
        assertEq(reg.urlOf(id), next);
        vm.prank(relayerA);
        reg.setUrl(id, URL);
        assertEq(reg.urlOf(id), URL);
        vm.prank(relayerB);
        vm.expectRevert(RelayRegistry.NotYours.selector);
        reg.setUrl(id, next);
        vm.prank(cold);
        vm.expectRevert(RelayRegistry.BadUrl.selector);
        reg.setUrl(id, "http://x.example/evm-pool/keeper");
    }

    // ---- leaving ----

    function testExitTakesTheRelayOffTheListAtOnceAndPaysTheOwnerAfterTheWait() public {
        uint256 id = _reg(relayerA, 1, URL, cold, MIN);
        vm.prank(relayerA);
        vm.expectRevert(RelayRegistry.NotYours.selector); // the relay's hot key cannot withdraw
        reg.startExit(id);

        vm.prank(cold);
        reg.startExit(id);
        (address[] memory r,,,) = _list(1);
        assertEq(r.length, 0, "off the list at once");
        (,,,, uint64 exitAt, uint256 stake) = reg.relays(id);
        assertEq(exitAt, block.timestamp + DELAY);
        assertEq(stake, MIN, "still locked");

        vm.expectRevert(RelayRegistry.TooEarly.selector);
        reg.finishExit(id);
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert(RelayRegistry.TooEarly.selector);
        reg.finishExit(id);
        vm.warp(block.timestamp + 1);
        vm.prank(address(0xBEEF)); // anyone may finish it; the stake goes to the owner
        reg.finishExit(id);
        assertEq(tac.balanceOf(cold), MIN);
        assertEq(tac.balanceOf(address(reg)), 0);
        vm.expectRevert(RelayRegistry.NoSuchRelay.selector);
        reg.finishExit(id);
        assertEq(reg.idOf(keccak256(abi.encode(uint64(1), relayerA))), 0);
    }

    function testExitCannotBeStartedTwiceOrFinishedBeforeItStarts() public {
        uint256 id = _reg(relayerA, 1, URL, cold, MIN);
        vm.expectRevert(RelayRegistry.NotExiting.selector);
        reg.finishExit(id);
        vm.startPrank(cold);
        reg.startExit(id);
        vm.expectRevert(RelayRegistry.Exiting.selector);
        reg.startExit(id);
        vm.stopPrank();
    }

    function testARelayCanRegisterAgainAfterItHasLeft() public {
        uint256 id = _reg(relayerA, 1, URL, cold, MIN);
        vm.prank(cold);
        reg.startExit(id);
        vm.warp(block.timestamp + DELAY);
        reg.finishExit(id);
        uint256 again = _reg(relayerA, 1, URL, cold, MIN);
        assertEq(again, 2);
        (address[] memory r,,,) = _list(1);
        assertEq(r.length, 1);
    }

    function testTheListStaysDenseWhenAnEntryLeavesFromTheMiddle() public {
        address[5] memory who = [address(0x1), address(0x2), address(0x3), address(0x4), address(0x5)];
        uint256[5] memory ids;
        for (uint256 i; i < 5; ++i) {
            tac.mint(who[i], MIN);
            ids[i] = _reg(who[i], 1, URL, who[i], MIN);
        }
        assertEq(reg.lengthOf(1), 5);
        // the clock is kept here, not read again from the block: the compiler may reuse a first read of it after a warp
        uint256 t = block.timestamp;
        // the second leaves: the last takes its place
        vm.prank(who[1]);
        reg.startExit(ids[1]);
        t += DELAY;
        vm.warp(t);
        reg.finishExit(ids[1]);
        assertEq(reg.lengthOf(1), 4);
        (address[] memory r,,, uint256 next) = _list(1);
        assertEq(r.length, 4);
        assertEq(next, 4);
        (, , uint32 pos5,,,) = reg.relays(ids[4]);
        assertEq(pos5, 1, "the last entry moved into the gap");
        // the first leaves, then the (moved) last one, then the rest: no gap, no stale position
        uint256[4] memory order = [ids[0], ids[4], ids[2], ids[3]];
        address[4] memory owners = [who[0], who[4], who[2], who[3]];
        for (uint256 k; k < 4; ++k) {
            vm.prank(owners[k]);
            reg.startExit(order[k]);
            t += DELAY;
            vm.warp(t);
            reg.finishExit(order[k]);
            assertEq(reg.lengthOf(1), 3 - k);
        }
        assertEq(tac.balanceOf(address(reg)), 0);
    }

    // ---- the list ----

    function testTheListSkipsAnEntryBelowTheMinimumAndTheMinimumCanBeRaisedByTheOwner() public {
        _reg(relayerA, 1, URL, cold, MIN);
        _reg(relayerB, 1, "https://b.example/evm-pool/keeper", cold, 5_000e18);
        vm.prank(DAO);
        reg.queueParams(4_000e18, DELAY);
        vm.warp(block.timestamp + PARAM_DELAY);
        reg.applyParams();
        (address[] memory r, uint256[] memory s,,) = _list(1);
        assertEq(r.length, 1, "the smaller stake is no longer listed");
        assertEq(r[0], relayerB);
        assertEq(s[0], 5_000e18);
        // it is not lost: it can top up and come back
        vm.startPrank(relayerA);
        reg.topUp(1, 1_500e18);
        vm.stopPrank();
        (address[] memory r2,,,) = _list(1);
        assertEq(r2.length, 2);
    }

    function testListPagesAndNeverReturnsMoreThanAHundred() public {
        for (uint256 i = 1; i <= 130; ++i) {
            address who = address(uint160(0x1000 + i));
            tac.mint(who, MIN);
            _reg(who, 1, URL, who, MIN);
        }
        (address[] memory a,,, uint256 next) = reg.list(1, 0, 500);
        assertEq(a.length, 100);
        assertEq(next, 100);
        (address[] memory b,,, uint256 next2) = reg.list(1, next, 500);
        assertEq(b.length, 30);
        assertEq(next2, 130);
        (address[] memory c,,, uint256 next3) = reg.list(1, 0, 10);
        assertEq(c.length, 10);
        assertEq(next3, 10);
        (address[] memory d,,, uint256 next4) = reg.list(1, 130, 10);
        assertEq(d.length, 0);
        assertEq(next4, 130);
        (address[] memory e,,, uint256 next5) = reg.list(1, 9999, 10);
        assertEq(e.length, 0);
        assertEq(next5, 130, "a start past the end is the end: a reader that loops until next reaches the length stops");
        (address[] memory z,,, uint256 next6) = reg.list(1, 0, 0);
        assertEq(z.length, 100, "a page of zero is a full page, not an empty one that never moves on");
        assertEq(next6, 100);
    }

    function testPagingSkipsTheOnesNotListedAndNextStillMovesOn() public {
        for (uint256 i = 1; i <= 6; ++i) {
            address who = address(uint160(0x2000 + i));
            tac.mint(who, MIN);
            uint256 id = _reg(who, 1, URL, who, MIN);
            if (i % 2 == 0) {
                vm.prank(who);
                reg.startExit(id);
            }
        }
        (address[] memory a,,, uint256 next) = reg.list(1, 0, 2);
        assertEq(a.length, 2);
        assertEq(next, 3, "read the first, skipped the exiting second, read the third");
        (address[] memory b,,, uint256 next2) = reg.list(1, next, 2);
        assertEq(b.length, 1);
        assertEq(next2, 6);
    }


    // ---- the review's findings ----

    function testAScanStopsAtFiveHundredPlacesSoARunOfSkippedEntriesCannotExhaustAReader() public {
        // 550 entries that are leaving, then 50 that are listed
        for (uint256 i = 1; i <= 600; ++i) {
            address who = address(uint160(0x3000 + i));
            tac.mint(who, MIN);
            uint256 id = _reg(who, 1, URL, who, MIN);
            if (i <= 550) {
                vm.prank(who);
                reg.startExit(id);
            }
        }
        // the cost of a call that finds nothing is measured cold, as a node's first read of those places is; storage the setup touched is not warm
        vm.cool(address(reg));
        uint256 g = gasleft();
        (address[] memory a,,, uint256 next) = reg.list(1, 0, 100);
        uint256 used = g - gasleft();
        assertEq(a.length, 0, "five hundred places looked at, none listed");
        assertEq(next, 500, "and it says where to go on, not that it is done");
        assertLt(used, 3_000_000, "bounded work for a call that finds nothing (2.4M measured)");
        (address[] memory b,,, uint256 next2) = reg.list(1, next, 100);
        assertEq(b.length, 50);
        assertEq(next2, 600);
    }

    /// The most a call can cost: a full page of entries with the longest url, then a run of entries a raised minimum unlists, measured cold. A node's
    /// eth_call gas cap has to be above this for a wallet to read the list.
    function testTheDearestListCallStaysUnderSixMillionGasCold() public {
        bytes memory host = new bytes(104);
        for (uint256 k; k < 104; ++k) host[k] = "a";
        string memory longUrl = string.concat("https://", string(host), "/evm-pool/keeper");
        assertEq(bytes(longUrl).length, 128);
        for (uint256 i = 1; i <= 500; ++i) {
            address who = address(uint160(0x9000 + i));
            uint256 amt = i <= 99 ? 5_000e18 : MIN;
            tac.mint(who, amt);
            vm.startPrank(who);
            tac.approve(address(reg), amt);
            reg.register(1, longUrl, who, amt);
            vm.stopPrank();
        }
        vm.prank(DAO);
        reg.queueParams(4_000e18, DELAY);
        vm.warp(block.timestamp + PARAM_DELAY);
        reg.applyParams();
        vm.cool(address(reg));
        uint256 g = gasleft();
        (address[] memory r,,, uint256 next) = reg.list(1, 0, 100);
        uint256 used = g - gasleft();
        assertEq(r.length, 99);
        assertEq(next, 500);
        assertLt(used, 6_000_000, "the dearest read (5.0M measured)");
    }

    function testATokenThatKeepsAFeeIsRefusedWhetherItComesToRegisterOrToTopUp() public {
        FeeToken fee = new FeeToken();
        RelayRegistry r = new RelayRegistry(address(fee), DAO, MIN, DELAY, 500e18, 100_000e18, 1 days, 30 days, PARAM_DELAY);
        fee.mint(relayerA, 1_000_000e18);
        fee.mint(relayerB, 1_000_000e18);
        vm.startPrank(relayerA);
        fee.approve(address(r), type(uint256).max);
        uint256 id = r.register(1, URL, cold, MIN); // no fee yet: it goes through
        vm.stopPrank();
        fee.take(true);
        vm.startPrank(relayerB);
        fee.approve(address(r), type(uint256).max);
        vm.expectRevert(RelayRegistry.TokenTookAFee.selector);
        r.register(1, URL, cold, MIN);
        vm.expectRevert(RelayRegistry.TokenTookAFee.selector);
        r.topUp(id, 1_000e18);
        vm.stopPrank();
        assertEq(r.count(), 1, "the refused registration left no entry");
        (,,,,, uint256 stake) = r.relays(id);
        assertEq(stake, MIN, "and the refused top up added nothing");
        assertEq(fee.balanceOf(address(r)), MIN, "and the registry holds what it owes");
    }

    function testTheChangeWaitIsBoundedWhenThereIsAnOwnerAndFreeWhenThereIsNot() public {
        vm.expectRevert("bad change wait");
        new RelayRegistry(address(tac), DAO, MIN, DELAY, 500e18, 100_000e18, 1 days, 30 days, 0);
        vm.expectRevert("bad change wait");
        new RelayRegistry(address(tac), DAO, MIN, DELAY, 500e18, 100_000e18, 1 days, 30 days, 1 days - 1);
        vm.expectRevert("bad change wait");
        new RelayRegistry(address(tac), DAO, MIN, DELAY, 500e18, 100_000e18, 1 days, 30 days, 365 days + 1);
        vm.expectRevert("bad change wait");
        new RelayRegistry(address(tac), DAO, MIN, DELAY, 500e18, 100_000e18, 1 days, 30 days, type(uint64).max);
        new RelayRegistry(address(tac), DAO, MIN, DELAY, 500e18, 100_000e18, 1 days, 30 days, 1 days);
        new RelayRegistry(address(tac), DAO, MIN, DELAY, 500e18, 100_000e18, 1 days, 30 days, 365 days);
        // with no owner nothing can be changed, so the wait is moot
        new RelayRegistry(address(tac), address(0), MIN, DELAY, 500e18, 100_000e18, 1 days, 30 days, 0);
    }

    function testRenouncingDropsAChangeStillWaitingSoTheNumbersAreFixedForGood() public {
        vm.startPrank(DAO);
        reg.queueParams(100_000e18, 30 days);
        reg.renounceOwnership();
        vm.stopPrank();
        assertEq(reg.owner(), address(0));
        (, , uint64 eta) = reg.pending();
        assertEq(eta, 0, "nothing is left waiting");
        vm.expectRevert(Ownable.Unauthorized.selector);
        reg.cancelParams();
        vm.warp(block.timestamp + PARAM_DELAY);
        vm.expectRevert(RelayRegistry.NothingPending.selector);
        reg.applyParams();
        assertEq(reg.minStake(), MIN);
        assertEq(reg.unstakeDelay(), DELAY);
    }

    function testRenouncingWithNothingWaitingIsPlain() public {
        vm.prank(DAO);
        reg.renounceOwnership();
        assertEq(reg.owner(), address(0));
    }

    function testAnEntryIsReachableByItsPlace() public {
        uint256 id = _reg(relayerA, 1, URL, cold, MIN);
        assertEq(reg.idAt(1, 0), id);
        vm.expectRevert();
        reg.idAt(1, 1);
    }

    function testTwoEntriesMayShareAUrlAndNothingHereDecidesWhichIsRight() public {
        // the server at the URL names one address; a wallet uses the entry that address matches (dapp/evm-pool-relays.js, evm-pool-wallet.js)
        _reg(relayerA, 1, URL, cold, MIN);
        _reg(relayerB, 1, URL, cold, MIN);
        (address[] memory r,, string[] memory u,) = _list(1);
        assertEq(r.length, 2);
        assertEq(u[0], u[1]);
    }

    // ---- the two numbers ----

    function testOnlyTheOwnerQueuesAndTheBoundsHold() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        reg.queueParams(MIN, DELAY);
        vm.startPrank(DAO);
        vm.expectRevert(RelayRegistry.OutOfBounds.selector);
        reg.queueParams(499e18, DELAY);
        vm.expectRevert(RelayRegistry.OutOfBounds.selector);
        reg.queueParams(100_001e18, DELAY);
        vm.expectRevert(RelayRegistry.OutOfBounds.selector);
        reg.queueParams(MIN, 1 days - 1);
        vm.expectRevert(RelayRegistry.OutOfBounds.selector);
        reg.queueParams(MIN, 30 days + 1);
        reg.queueParams(500e18, 1 days); // both ends are allowed
        reg.queueParams(100_000e18, 30 days);
        vm.stopPrank();
    }

    function testAChangeWaitsForItsTimeAndAnyoneCanApplyIt() public {
        vm.prank(DAO);
        reg.queueParams(3_000e18, 10 days);
        assertEq(reg.minStake(), MIN, "nothing yet");
        vm.expectRevert(RelayRegistry.TooEarly.selector);
        reg.applyParams();
        vm.warp(block.timestamp + PARAM_DELAY - 1);
        vm.expectRevert(RelayRegistry.TooEarly.selector);
        reg.applyParams();
        vm.warp(block.timestamp + 1);
        vm.prank(address(0xBEEF));
        reg.applyParams();
        assertEq(reg.minStake(), 3_000e18);
        assertEq(reg.unstakeDelay(), 10 days);
        vm.expectRevert(RelayRegistry.NothingPending.selector);
        reg.applyParams();
    }

    function testAQueuedChangeCanBeCancelledAndANewOneReplacesIt() public {
        vm.startPrank(DAO);
        reg.queueParams(3_000e18, 10 days);
        reg.cancelParams();
        vm.expectRevert(RelayRegistry.NothingPending.selector);
        reg.cancelParams();
        reg.queueParams(3_000e18, 10 days);
        vm.warp(block.timestamp + 1 days);
        reg.queueParams(4_000e18, 5 days); // the later proposal takes over, with its own wait
        vm.stopPrank();
        vm.warp(block.timestamp + PARAM_DELAY - 1);
        vm.expectRevert(RelayRegistry.TooEarly.selector);
        reg.applyParams();
        vm.warp(block.timestamp + 1);
        reg.applyParams();
        assertEq(reg.minStake(), 4_000e18);
        assertEq(reg.unstakeDelay(), 5 days);
    }

    function testALaterDelayDoesNotReachAnExitThatHasBegun() public {
        uint256 id = _reg(relayerA, 1, URL, cold, MIN);
        vm.prank(cold);
        reg.startExit(id);
        (,,,, uint64 exitAt,) = reg.relays(id);
        vm.prank(DAO);
        reg.queueParams(MIN, 30 days);
        vm.warp(block.timestamp + PARAM_DELAY);
        reg.applyParams();
        (,,,, uint64 exitAt2,) = reg.relays(id);
        assertEq(exitAt2, exitAt, "the same day as promised");
        vm.warp(exitAt);
        reg.finishExit(id);
        assertEq(tac.balanceOf(cold), MIN);
        // and one begun after it waits the new length
        uint256 id2 = _reg(relayerB, 1, URL, cold, MIN);
        vm.prank(cold);
        reg.startExit(id2);
        (,,,, uint64 exitAt3,) = reg.relays(id2);
        assertEq(exitAt3, block.timestamp + 30 days);
    }

    function testWithNoOwnerTheNumbersAreFixedForGood() public {
        RelayRegistry fixedReg = new RelayRegistry(address(tac), address(0), MIN, DELAY, 500e18, 100_000e18, 1 days, 30 days, PARAM_DELAY);
        assertEq(fixedReg.owner(), address(0));
        vm.prank(DAO);
        vm.expectRevert(Ownable.Unauthorized.selector);
        fixedReg.queueParams(MIN, DELAY);
        vm.expectRevert(Ownable.Unauthorized.selector);
        fixedReg.queueParams(MIN, DELAY);
        vm.expectRevert(RelayRegistry.NothingPending.selector);
        fixedReg.applyParams();
    }

    function testTheOwnerHasNoPowerOverAnEntryOrAStake() public {
        uint256 id = _reg(relayerA, 1, URL, cold, MIN);
        vm.startPrank(DAO);
        vm.expectRevert(RelayRegistry.NotYours.selector);
        reg.startExit(id);
        vm.expectRevert(RelayRegistry.NotYours.selector);
        reg.setUrl(id, "https://dao.example/evm-pool/keeper");
        vm.stopPrank();
        assertEq(reg.urlOf(id), URL);
        assertEq(tac.balanceOf(address(reg)), MIN);
    }

    function testConstructorRefusesBadBounds() public {
        vm.expectRevert("no token");
        new RelayRegistry(address(0xDEAD), DAO, MIN, DELAY, 500e18, 100_000e18, 1 days, 30 days, PARAM_DELAY);
        vm.expectRevert("bad stake bounds");
        new RelayRegistry(address(tac), DAO, MIN, DELAY, 0, 100_000e18, 1 days, 30 days, PARAM_DELAY);
        vm.expectRevert("bad stake bounds");
        new RelayRegistry(address(tac), DAO, MIN, DELAY, 600e18, 500e18, 1 days, 30 days, PARAM_DELAY);
        vm.expectRevert("bad delay bounds");
        new RelayRegistry(address(tac), DAO, MIN, DELAY, 500e18, 100_000e18, 31 days, 30 days, PARAM_DELAY);
        vm.expectRevert("min stake outside bounds");
        new RelayRegistry(address(tac), DAO, 400e18, DELAY, 500e18, 100_000e18, 1 days, 30 days, PARAM_DELAY);
        vm.expectRevert("delay outside bounds");
        new RelayRegistry(address(tac), DAO, MIN, 31 days, 500e18, 100_000e18, 1 days, 30 days, PARAM_DELAY);
    }

}

/// Random sequences of the actions that move a stake: what the registry holds is always exactly what its entries say.
contract Handler is Test {
    RelayRegistry public reg;
    TestTAC public tac;
    uint256 public ghost; // what the entries should add up to
    address[] public actors;
    uint256[] public ids;
    uint256 constant MIN = 2_500e18;

    constructor(RelayRegistry r, TestTAC t) {
        reg = r;
        tac = t;
        for (uint256 i; i < 6; ++i) {
            address a = address(uint160(0x5000 + i));
            actors.push(a);
            t.mint(a, 10_000_000e18);
            vm.prank(a);
            t.approve(address(r), type(uint256).max);
        }
    }

    function register(uint256 actorSeed, uint256 chainSeed, uint256 amount) external {
        address a = actors[actorSeed % actors.length];
        uint64 chainId = uint64(1 + (chainSeed % 3));
        amount = bound(amount, MIN, 100_000e18);
        vm.prank(a);
        try reg.register(chainId, "https://r.example/evm-pool/keeper", a, amount) returns (uint256 id) {
            ids.push(id);
            ghost += amount;
        } catch {}
    }

    function topUp(uint256 idSeed, uint256 actorSeed, uint256 amount) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        amount = bound(amount, 0, 50_000e18);
        vm.prank(actors[actorSeed % actors.length]);
        try reg.topUp(id, amount) {
            ghost += amount;
        } catch {}
    }

    function startExit(uint256 idSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        (, , , address o,,) = reg.relays(id);
        vm.prank(o);
        try reg.startExit(id) {} catch {}
    }

    function finishExit(uint256 idSeed, uint256 wait) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        vm.warp(block.timestamp + bound(wait, 0, 10 days));
        (,,,,, uint256 stake) = reg.relays(id);
        try reg.finishExit(id) {
            ghost -= stake;
        } catch {}
    }

    /// An entry's owner or relayer moves it to another host, or a stranger tries.
    function setUrl(uint256 idSeed, uint256 who, uint256 hostSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        (address relayer,,, address o,,) = reg.relays(id);
        address caller = who % 3 == 0 ? relayer : who % 3 == 1 ? o : actors[who % actors.length];
        string memory url = hostSeed % 2 == 0 ? "https://a.example/evm-pool/keeper" : "https://b.example/9/evm-pool/keeper";
        vm.prank(caller);
        try reg.setUrl(id, url) {} catch {}
    }

    /// The parameter owner changes the minimum stake (within the bounds), waits out the change and applies it.
    function changeMinimum(uint256 amount, uint256 delaySeed) external {
        amount = bound(amount, 500e18, 100_000e18);
        vm.prank(address(0xDA0));
        try reg.queueParams(amount, bound(delaySeed, 1 days, 30 days)) {
            vm.warp(block.timestamp + 2 days);
            try reg.applyParams() {} catch {}
        } catch {}
    }

    function totalOfLive() external view returns (uint256 sum) {
        for (uint256 id = 1; id <= reg.count(); ++id) {
            (,,,,, uint256 stake) = reg.relays(id);
            sum += stake;
        }
    }
}

contract RelayRegistryInvariantTest is Test {
    TestTAC tac;
    RelayRegistry reg;
    Handler h;

    function setUp() public {
        vm.warp(1_800_000_000);
        tac = new TestTAC();
        reg = new RelayRegistry(address(tac), address(0xDA0), 2_500e18, 7 days, 500e18, 100_000e18, 1 days, 30 days, 2 days);
        h = new Handler(reg, tac);
        targetContract(address(h));
    }

    /// The registry holds exactly what its live entries say, and no more or less.
    function invariant_BalanceIsTheSumOfTheStakes() public view {
        assertEq(tac.balanceOf(address(reg)), h.totalOfLive());
        assertEq(h.totalOfLive(), h.ghost());
    }

    /// Paging through a chain's list gives exactly the entries that are not leaving and hold at least the minimum, each with its own stake and url.
    function invariant_TheListIsExactlyTheEntriesThatAreListed() public view {
        uint256 min = reg.minStake();
        for (uint64 c = 1; c <= 3; ++c) {
            uint256 expected;
            for (uint256 id = 1; id <= reg.count(); ++id) {
                (address relayer, uint64 chainId,,, uint64 exitAt, uint256 stake) = reg.relays(id);
                if (relayer != address(0) && chainId == c && exitAt == 0 && stake >= min) ++expected;
            }
            uint256 got;
            uint256 at;
            uint256 len = reg.lengthOf(c);
            for (uint256 calls; at < len && calls < 1000; ++calls) {
                (address[] memory r, uint256[] memory st, string[] memory u, uint256 next) = reg.list(c, at, 7);
                for (uint256 i; i < r.length; ++i) {
                    assertGe(st[i], min);
                    assertGt(bytes(u[i]).length, 24);
                    (,,,,, uint256 own) = reg.relays(reg.idOf(keccak256(abi.encode(c, r[i]))));
                    assertEq(own, st[i]);
                }
                got += r.length;
                assertGt(next, at, "paging always moves on");
                at = next;
            }
            assertEq(got, expected, "every listed entry, once");
        }
    }

    /// Each chain's list has no gap and every entry knows its place in it.
    function invariant_ListsAreDenseAndEveryEntryKnowsItsPlace() public view {
        uint256 live;
        for (uint64 c = 1; c <= 3; ++c) live += reg.lengthOf(c);
        uint256 found;
        for (uint256 id = 1; id <= reg.count(); ++id) {
            (address relayer, uint64 chainId, uint32 pos,,,) = reg.relays(id);
            if (relayer == address(0)) continue;
            ++found;
            assertLt(pos, reg.lengthOf(chainId));
            assertEq(reg.idAt(chainId, pos), id, "the list holds the entry at the place the entry says");
            assertEq(reg.idOf(keccak256(abi.encode(chainId, relayer))), id);
        }
        assertEq(found, live);
    }
}

interface IMintable {
    function MINTER() external view returns (address);
    function mint(address to, uint256 amount) external;
}

/// Against the real TAC on a mainnet fork: `FORK_URL=https://ethereum-rpc.publicnode.com forge test --match-contract RelayRegistryForkTest`
contract RelayRegistryForkTest is Test {
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    string constant URL = "https://relay.example/1/evm-pool/keeper";

    function setUp() public {
        if (!vm.envExists("FORK_URL")) vm.skip(true);
        vm.createSelectFork(vm.envString("FORK_URL"));
    }

    function _permit(uint256 pk, address owner_, address spender, uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        (bool ok, bytes memory nonce) = TAC.staticcall(abi.encodeWithSignature("nonces(address)", owner_));
        require(ok);
        (bool ok2, bytes memory dom) = TAC.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        require(ok2);
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), owner_, spender, value, abi.decode(nonce, (uint256)), deadline)
        );
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", abi.decode(dom, (bytes32)), structHash)));
    }

    function testStakeAndLeaveWithTheRealToken() public {
        RelayRegistry reg = new RelayRegistry(TAC, address(0xDA0), 2_500e18, 7 days, 500e18, 100_000e18, 1 days, 30 days, 2 days);
        (address who, uint256 pk) = makeAddrAndKey("real tac relayer");
        address cold = address(0xC01D);
        vm.prank(IMintable(TAC).MINTER());
        IMintable(TAC).mint(who, 5_000e18);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(pk, who, address(reg), 3_000e18, deadline);
        vm.prank(who);
        uint256 id = reg.registerWithPermit(1, URL, cold, 3_000e18, deadline, v, r, s);

        (, uint256[] memory stakes, string[] memory urls,) = reg.list(1, 0, 10);
        assertEq(stakes.length, 1);
        assertEq(stakes[0], 3_000e18);
        assertEq(urls[0], URL);
        assertEq(IERC20Like(TAC).balanceOf(address(reg)), 3_000e18);

        vm.prank(cold);
        reg.startExit(id);
        vm.warp(block.timestamp + 7 days);
        reg.finishExit(id);
        assertEq(IERC20Like(TAC).balanceOf(cold), 3_000e18, "every token comes back");
        assertEq(IERC20Like(TAC).balanceOf(address(reg)), 0);
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}
