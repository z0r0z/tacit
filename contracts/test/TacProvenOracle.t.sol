// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {TacLaunchFixture} from "./TacLaunchFixture.sol";
import {TacProvenOracle, TacProvenPack} from "../src/TacProvenOracle.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TacVaultRouter} from "../src/TacVaultRouter.sol";
import {LiveFeed} from "./TacVaultMocks.sol";

/// The oracle with its proof check skipped, to test what it does with what a proof commits.
contract ProvenNoVerify is TacProvenOracle {
    constructor(Config memory c) TacProvenOracle(c) {}

    function _verify(bytes calldata, bytes calldata) internal view override {}
}

/// The oracle's proof check on its own.
contract ProvenProbe is TacProvenOracle {
    constructor(Config memory c) TacProvenOracle(c) {}

    function verify(bytes calldata pv, bytes calldata proof) external view {
        _verify(pv, proof);
    }

    function inputs(uint256 digest, uint256 nonce) external view returns (uint256 x, uint256 y, bool ok) {
        return _inputs(digest, nonce);
    }
}

/// EIP-2935's history contract: a 32-byte block number in, its hash out.
contract MockHistory {
    mapping(uint256 => bytes32) internal _h;

    function set(uint256 n, bytes32 h) external {
        _h[n] = h;
    }

    fallback(bytes calldata d) external returns (bytes memory) {
        return abi.encode(_h[abi.decode(d, (uint256))]);
    }
}

/// A venue oracle that keeps a hash of the record it decoded and answers (7, 8), or refuses it as already recorded.
contract RecordingVenue {
    bytes32 public got;
    bool public refuse;

    function setRefuse(bool r) external {
        refuse = r;
    }

    function record(bytes calldata h, bytes calldata n, bytes[] calldata a, bytes[] calldata pa, bytes[] calldata pb)
        external
        returns (uint256, uint256)
    {
        if (refuse) revert TacProvenOracle.AlreadyRecorded();
        got = keccak256(abi.encode(h, n, a, pa, pb));
        return (7, 8);
    }
}

/// A pair over two RecordingVenues with the launch fixture's interval and windows.
contract RecordingPair {
    address public immutable A;
    address public immutable B;

    constructor(address a, address b) {
        (A, B) = (a, b);
    }

    function STEP() external pure returns (uint256) {
        return 50;
    }

    function SHORT_WINDOW() external pure returns (uint256) {
        return 7_200;
    }

    function WINDOW() external pure returns (uint256) {
        return 10_800;
    }

    function MAX_WINDOW() external pure returns (uint256) {
        return 21_600;
    }
}

/// TacProvenOracle against TacPairOracle over the launch fixture's venues (STEP 50, windows 2h / 3h / 6h, two thirds
/// coverage). The pair is the reference: the words a proof commits are built here from the pair's own answers with the
/// same samples recorded, which is what the proven program computes.
contract TacProvenOracleTest is TacLaunchFixture {
    uint256 internal constant G = 30;
    uint256 internal constant OLD_GRACE = 10;
    address internal constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;

    ProvenNoVerify internal po;
    bytes32 internal cfg;

    function setUp() public override {
        super.setUp();
        po = new ProvenNoVerify(_config(bytes32(uint256(1)), G, address(pair)));
        cfg = po.CONFIG();
    }

    function _config(bytes32 vkey, uint256 grace, address fb) internal view returns (TacProvenOracle.Config memory) {
        return _configN(vkey, grace, fb, 5);
    }

    function _configN(bytes32 vkey, uint256 grace, address fb, uint256 count)
        internal
        view
        returns (TacProvenOracle.Config memory)
    {
        return TacProvenOracle.Config({
            programVKey: vkey,
            precision: address(prec),
            tac: address(tac),
            pool: address(v1),
            poolId: POOL_ID,
            ethAsset: ETH_ASSET,
            tacAsset: TAC_ASSET,
            mappingSlot: 74,
            step: STEP,
            shortWindow: 7_200,
            window: 10_800,
            maxWindow: 21_600,
            grace: grace,
            count: count,
            minCoverageBps: 6_600,
            fallbackOracle: fb
        });
    }

    function _w(uint256 k) internal pure returns (uint256) {
        return k == 0 ? 7_200 : k == 1 ? 10_800 : 21_600;
    }

    // ─────────────── histories and the words a proof commits ───────────────

    function _put(address o, uint256 idx, uint256 price, uint256 depth) internal {
        vm.store(o, bytes32(idx % 128), bytes32(idx << 208 | price << 104 | depth));
    }

    // Both venues' samples for intervals x - 60 to x, nothing else in their rings.
    function _history(uint256 seed, uint256 x, uint256 minDepth) internal {
        for (uint256 i; i < 128; ++i) {
            vm.store(address(a), bytes32(i), 0);
            vm.store(address(b), bytes32(i), 0);
        }
        for (uint256 i = x - 60; i <= x; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            _put(address(a), i, baseA * (3_000 + r % 14_000) / 10_000 + 1, minDepth + (r >> 64) % 5_000e18);
            _put(address(b), i, baseB * (3_000 + (r >> 32) % 14_000) / 10_000 + 1, minDepth + (r >> 128) % 5_000e18);
        }
    }

    // The pair's answers for the newest interval that counts, as one word.
    function _pairWord() internal view returns (uint256 word) {
        for (uint256 k; k < 3; ++k) {
            try pair.prices(_w(k)) returns (uint256 lo, uint256 hi) {
                uint256 rec = pair.recovery(_w(k));
                word |= (_p(lo, 20) | _p(hi, 20) << 28 | _p(rec, 20) << 56) << (84 * k);
            } catch {}
        }
    }

    function _p(uint256 v, uint256 m) internal pure returns (uint256 p) {
        p = TacProvenPack.pack(v, m);
        uint256 back = TacProvenPack.unpack(p, m);
        // truncation: never above, at most 2^-m below
        assert(back <= v && v - back <= v >> m);
    }

    struct Proof {
        uint256 x;
        uint256 count;
        uint256 head;
        uint256[] words;
        uint256 anchor;
        bytes32 anchorHash;
    }

    // What a proof of X covering `count` intervals commits, from the pair with samples up to X recorded.
    function _expect(uint256 x, uint256 count) internal returns (Proof memory p) {
        p.x = x;
        p.count = count;
        p.words = new uint256[](count);
        uint256[2] memory d;
        for (uint256 j; j < count; ++j) {
            vm.roll((x - 1 + j + 1) * STEP + OLD_GRACE + 1);
            p.words[j] = _pairWord();
            if (j < 2) {
                try pair.depthMin(21_600) returns (uint256 v) {
                    d[j] = _p(v, 24);
                } catch {}
            }
        }
        vm.roll((x + 1) * STEP + 1);
        uint256 lt = _p(pair.latest(), 24);
        p.anchor = (x + 1) * STEP + 3;
        p.anchorHash = keccak256(abi.encode("anchor", x));
        p.head = x | (x - 1) << 32 | count << 64 | lt << 72 | d[0] << 104 | d[1] << 136 | p.anchor << 168;
    }

    // A copy (a memory struct assignment only aliases).
    function _copy(Proof memory p) internal pure returns (Proof memory q) {
        (q.x, q.count, q.head, q.words, q.anchor, q.anchorHash) = (p.x, p.count, p.head, p.words, p.anchor, p.anchorHash);
    }

    function _pv(Proof memory p) internal view returns (bytes memory pv) {
        pv = abi.encodePacked(keccak256(abi.encode(p.anchorHash, cfg)), p.head);
        for (uint256 j; j < p.words.length; ++j) {
            pv = bytes.concat(pv, abi.encode(p.words[j]));
        }
    }

    function _call(Proof memory p) internal view returns (bytes memory) {
        bytes[] memory none;
        return abi.encodeCall(TacProvenOracle.record, (_pv(p), new bytes(288), none, none, none));
    }

    function _record(Proof memory p) internal {
        if (block.number <= p.anchor) vm.roll(p.anchor + 1);
        vm.setBlockhash(p.anchor, p.anchorHash);
        (bool ok, bytes memory ret) = address(po).call(_call(p));
        require(ok, string(ret));
    }

    // The last block at which N is the newest interval that counts for the proven oracle. For N = X - 1 that is
    // inside GRACE after X ends, the only blocks at which a proof of X exists while X - 1 still counts.
    function _at(uint256 n) internal {
        vm.roll((n + 2) * STEP + G);
    }

    // ─────────────── the proven views equal the pair's ───────────────

    /// forge-config: default.fuzz.runs = 48
    function testFuzz_answersAsThePairDoesForEveryIntervalItCovers(uint256 seed, uint8 c) public {
        uint256 x = 519_950 + seed % 100;
        uint256 count = 2 + c % 7;
        po = new ProvenNoVerify(_configN(bytes32(uint256(1)), G, address(pair), count));
        _history(seed, x, 1e18);
        Proof memory p = _expect(x, count);
        _record(p);
        for (uint256 j; j < count; ++j) {
            uint256 n = x - 1 + j;
            _at(n);
            uint256 word = p.words[j];
            for (uint256 k; k < 3; ++k) {
                uint256 lo = TacProvenPack.unpack(word >> (84 * k) & 0xfffffff, 20);
                if (lo == 0) {
                    // a window the proof cannot answer is the pair's
                    _sameAsPair(abi.encodeCall(TacProvenOracle.prices, (_w(k))));
                    _sameAsPair(abi.encodeCall(TacProvenOracle.recovery, (_w(k))));
                    continue;
                }
                (uint256 pl, uint256 ph) = po.prices(_w(k));
                assertEq(pl, lo, "low");
                assertEq(ph, TacProvenPack.unpack(word >> (84 * k + 28) & 0xfffffff, 20), "high");
                assertEq(po.recovery(_w(k)), TacProvenPack.unpack(word >> (84 * k + 56) & 0xfffffff, 20), "recovery");
            }
            if (j < 2) {
                assertEq(po.depthMin(21_600), TacProvenPack.unpack(p.head >> (104 + 32 * j) & 0xffffffff, 24), "depth");
            } else {
                _sameAsPair(abi.encodeCall(TacProvenOracle.depthMin, (21_600)));
            }
            assertEq(po.latest(), TacProvenPack.unpack(p.head >> 72 & 0xffffffff, 24), "latest");
        }
        // Past what it covers, every view is the pair's, the newest price included.
        _at(x + count - 1);
        for (uint256 k; k < 3; ++k) {
            _sameAsPair(abi.encodeCall(TacProvenOracle.prices, (_w(k))));
            _sameAsPair(abi.encodeCall(TacProvenOracle.recovery, (_w(k))));
        }
        _sameAsPair(abi.encodeCall(TacProvenOracle.latest, ()));
        _sameAsPair(abi.encodeCall(TacProvenOracle.depthMin, (21_600)));
    }

    /// The proven program's answers (contracts/sp1/tac-oracle/core, written to test/fixtures/tac-proven/cases.json by
    /// its tests) are the pair's for the same samples, gaps included: every word and the head but its anchor.
    function test_theProgramsAnswersAreThePairs() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/tac-proven/cases.json"));
        for (uint256 c; c < 24; ++c) {
            string memory k = string.concat(".cases[", vm.toString(c), "]");
            uint256 x = vm.parseJsonUint(json, string.concat(k, ".x"));
            uint256 count = vm.parseJsonUint(json, string.concat(k, ".count"));
            uint256[] memory pa = vm.parseJsonUintArray(json, string.concat(k, ".priceA"));
            uint256[] memory da = vm.parseJsonUintArray(json, string.concat(k, ".depthA"));
            uint256[] memory pb = vm.parseJsonUintArray(json, string.concat(k, ".priceB"));
            uint256[] memory db = vm.parseJsonUintArray(json, string.concat(k, ".depthB"));
            for (uint256 i; i < 128; ++i) {
                vm.store(address(a), bytes32(i), 0);
                vm.store(address(b), bytes32(i), 0);
            }
            uint256 lo = x - 36;
            for (uint256 i; i < pa.length; ++i) {
                if (pa[i] != 0) _put(address(a), lo + i, pa[i], da[i]);
                if (pb[i] != 0) _put(address(b), lo + i, pb[i], db[i]);
            }
            Proof memory p = _expect(x, count);
            uint256[] memory words = vm.parseJsonUintArray(json, string.concat(k, ".words"));
            assertEq(words.length, count, "count");
            for (uint256 j; j < count; ++j) {
                assertEq(words[j], p.words[j], string.concat("case ", vm.toString(c), " word ", vm.toString(j)));
            }
            uint256 noAnchor = ~(uint256(M32) << 168);
            assertEq(vm.parseJsonUint(json, string.concat(k, ".head")), p.head & noAnchor, "head");
        }
    }

    uint256 internal constant M32 = 0xffffffff;

    // The proven oracle gives what the pair gives for `data`, a revert included.
    function _sameAsPair(bytes memory data) internal view {
        (bool ok1, bytes memory r1) = address(po).staticcall(data);
        (bool ok2, bytes memory r2) = address(pair).staticcall(data);
        assertEq(ok1, ok2, "same outcome");
        assertEq(r1, r2, "same answer");
    }

    function test_beforeAnyProofEveryViewIsThePairs() public {
        _fill(10_000, 3_000);
        for (uint256 k; k < 3; ++k) {
            _sameAsPair(abi.encodeCall(TacProvenOracle.prices, (_w(k))));
            _sameAsPair(abi.encodeCall(TacProvenOracle.recovery, (_w(k))));
        }
        _sameAsPair(abi.encodeCall(TacProvenOracle.depthMin, (21_600)));
        _sameAsPair(abi.encodeCall(TacProvenOracle.latest, ()));
        // a window other than the three
        _sameAsPair(abi.encodeCall(TacProvenOracle.prices, (14_400)));
        assertEq(po.spot(), pair.spot(), "spot");
    }

    function test_withoutAFallbackAnUncoveredViewReverts() public {
        ProvenNoVerify bare = new ProvenNoVerify(_config(bytes32(uint256(1)), G, address(0)));
        vm.expectRevert(TacProvenOracle.TooFewSamples.selector);
        bare.prices(7_200);
        vm.expectRevert(TacProvenOracle.TooFewSamples.selector);
        bare.depthMin(21_600);
        vm.expectRevert(TacProvenOracle.TooFewSamples.selector);
        bare.latest();
    }

    function test_spotIsThePairsAsReservesMove() public {
        assertEq(po.spot(), pair.spot());
        prec.setReserves(5e18, 1e22);
        assertEq(po.spot(), pair.spot());
        v1.setPool(POOL_ID, ETH_ASSET, TAC_ASSET, 1e8, 9e12);
        assertEq(po.spot(), pair.spot());
    }

    // ─────────────── record ───────────────

    function test_recordRulesAndTheRoutersSkippedError() public {
        uint256 x = 519_990;
        _history(1, x, 1e18);
        Proof memory p = _expect(x, 5);
        _record(p);
        (uint256 cx, uint256 first, uint256 count) = po.coverage();
        assertEq(cx, x);
        assertEq(first, x - 1);
        assertEq(count, 5);
        // the same X again, or an older one: AlreadyRecorded, the error TacVaultRouter lets through
        vm.expectRevert(bytes4(0x103b4afe));
        _recordRaw(p);
        Proof memory older = _expect(x - 1, 5);
        vm.roll(p.anchor + 5);
        vm.setBlockhash(older.anchor, older.anchorHash);
        vm.expectRevert(TacProvenOracle.AlreadyRecorded.selector);
        _recordRaw(older);
    }

    function _recordRaw(Proof memory p) internal {
        bytes[] memory none;
        po.record(_pv(p), new bytes(288), none, none, none);
    }

    function test_recordRefusesBadValues() public {
        uint256 x = 519_990;
        _history(2, x, 1e18);
        Proof memory p = _expect(x, 5);
        vm.roll(p.anchor + 5);
        vm.setBlockhash(p.anchor, p.anchorHash);
        bytes[] memory none;
        bytes memory pv = _pv(p);
        // count says 5, four words given
        vm.expectRevert(TacProvenOracle.BadValues.selector);
        po.record(_slice(pv, pv.length - 32), new bytes(288), none, none, none);
        // any count but COUNT, whatever the words
        for (uint256 c = 2; c < 9; c += 1) {
            if (c == 5) continue;
            Proof memory q = _copy(p);
            q.head = p.head & ~(uint256(0xff) << 64) | c << 64;
            q.words = new uint256[](c);
            vm.expectRevert(TacProvenOracle.BadValues.selector);
            po.record(_pv(q), new bytes(288), none, none, none);
        }
        // first interval not X - 1
        Proof memory r = _copy(p);
        r.head = p.head & ~(uint256(0xffffffff) << 32) | (x - 2) << 32;
        vm.expectRevert(TacProvenOracle.BadValues.selector);
        po.record(_pv(r), new bytes(288), none, none, none);
    }

    function _slice(bytes memory s, uint256 n) internal pure returns (bytes memory o) {
        o = new bytes(n);
        for (uint256 i; i < n; ++i) {
            o[i] = s[i];
        }
    }

    /// CONFIG is the encoding the program hashes, and its slots are the ones the AMM venue oracle proves.
    function test_configIsWhatTheProgramReads() public view {
        (bytes32 sa, bytes32 sb) = b.slots();
        assertEq(po.SLOT_A(), sa);
        assertEq(po.SLOT_B(), sb);
        bytes32 want = keccak256(
            abi.encode(
                uint256(50),
                uint256(12),
                uint256(18),
                uint256(36),
                uint256(6_600),
                address(prec),
                bytes32(0),
                bytes32(uint256(0x05345cdf77eb68f44c)),
                prec.sqrtPLow(),
                prec.sqrtPHigh(),
                address(v1),
                sa,
                sb,
                uint256(1e10),
                uint256(1e10)
            )
        );
        assertEq(po.CONFIG(), want);
    }

    /// A proof made with any other venues, slots, scales or windows is refused like a wrong anchor.
    function test_recordRefusesAProofForAnotherConfig() public {
        uint256 x = 519_990;
        _history(7, x, 1e18);
        Proof memory p = _expect(x, 5);
        vm.roll(p.anchor + 5);
        vm.setBlockhash(p.anchor, p.anchorHash);
        bytes memory pv = _pv(p);
        bytes32 other = keccak256(abi.encode(p.anchorHash, keccak256("another config")));
        assembly {
            mstore(add(pv, 0x20), other)
        }
        bytes[] memory none;
        vm.expectRevert(TacProvenOracle.BadBlock.selector);
        po.record(pv, new bytes(288), none, none, none);
        po.record(_pv(p), new bytes(288), none, none, none);
    }

    // A venue oracle's record arguments, `pb` with `tag` added last.
    function _venueArgs(bytes memory tag)
        internal
        pure
        returns (bytes memory h, bytes memory nx, bytes[] memory acc, bytes[] memory pa, bytes[] memory pb, bytes[] memory tagged)
    {
        (h, nx) = (hex"aa11", hex"bb22");
        acc = new bytes[](2);
        (acc[0], acc[1]) = (hex"c001", hex"c002");
        pa = new bytes[](1);
        pa[0] = hex"d001";
        pb = new bytes[](2);
        (pb[0], pb[1]) = (hex"e001", hex"e002");
        tagged = new bytes[](3);
        (tagged[0], tagged[1], tagged[2]) = (pb[0], pb[1], tag);
    }

    /// A record with storage proofs goes to the venue its last proofB element names, without that element; the
    /// venue's answer comes back, and its AlreadyRecorded too, which the live router lets through.
    function test_aVenueRecordGoesToTheVenueItNames() public {
        RecordingVenue va = new RecordingVenue();
        RecordingVenue vb = new RecordingVenue();
        ProvenNoVerify o =
            new ProvenNoVerify(_config(bytes32(uint256(1)), G, address(new RecordingPair(address(va), address(vb)))));
        (bytes memory h, bytes memory nx, bytes[] memory acc, bytes[] memory pa, bytes[] memory pb, bytes[] memory t0) =
            _venueArgs(hex"00");
        bytes32 want = keccak256(abi.encode(h, nx, acc, pa, pb));
        (uint256 r1, uint256 r2) = o.record(h, nx, acc, pa, t0);
        assertEq(r1, 7);
        assertEq(r2, 8);
        assertEq(va.got(), want, "venue A, without the tag");
        assertEq(vb.got(), bytes32(0));
        (,,,,, bytes[] memory t1) = _venueArgs(hex"01");
        o.record(h, nx, acc, pa, t1);
        assertEq(vb.got(), want, "venue B, without the tag");
        // a tag that names no venue, a tag of two bytes, a tag with no proof before it
        (,,,,, bytes[] memory t2) = _venueArgs(hex"02");
        vm.expectRevert(TacProvenOracle.BadValues.selector);
        o.record(h, nx, acc, pa, t2);
        (,,,,, bytes[] memory t3) = _venueArgs(hex"0001");
        vm.expectRevert(TacProvenOracle.BadValues.selector);
        o.record(h, nx, acc, pa, t3);
        bytes[] memory only = new bytes[](1);
        only[0] = hex"00";
        vm.expectRevert(TacProvenOracle.BadValues.selector);
        o.record(h, nx, acc, pa, only);
        // the venue's AlreadyRecorded comes back as it is, and the router lets it through
        va.setRefuse(true);
        vm.expectRevert(TacProvenOracle.AlreadyRecorded.selector);
        o.record(h, nx, acc, pa, t0);
        TacVault v2 = _vault(address(o));
        TacVaultRouter router = new TacVaultRouter(address(vault), address(v2));
        address[] memory venues = new address[](1);
        venues[0] = address(o);
        bytes[] memory data = new bytes[](1);
        data[0] = abi.encodeCall(TacProvenOracle.record, (h, nx, acc, pa, t0));
        router.records(address(v2), venues, data);
        va.setRefuse(false);
        router.records(address(v2), venues, data);
        assertEq(va.got(), want, "through the router");
        // with no pair behind it there is no venue to pass a record to
        ProvenNoVerify bare = new ProvenNoVerify(_config(bytes32(uint256(1)), G, address(0)));
        vm.expectRevert(TacProvenOracle.BadConfig.selector);
        bare.record(h, nx, acc, pa, t0);
    }

    function test_recordChecksTheAnchor() public {
        uint256 x = 519_990;
        _history(3, x, 1e18);
        Proof memory p = _expect(x, 5);
        bytes[] memory none;
        // a wrong hash
        vm.roll(p.anchor + 5);
        vm.setBlockhash(p.anchor, keccak256("other"));
        vm.expectRevert(TacProvenOracle.BadBlock.selector);
        po.record(_pv(p), new bytes(288), none, none, none);
        // an anchor before the block that picks X's sample
        Proof memory q = _copy(p);
        q.anchor = (x + 1) * STEP - 1;
        q.head = p.head & ~(uint256(0xffffffff) << 168) | q.anchor << 168;
        vm.setBlockhash(q.anchor, q.anchorHash);
        vm.expectRevert(TacProvenOracle.BadBlock.selector);
        po.record(_pv(q), new bytes(288), none, none, none);
        // the anchor not yet mined
        vm.setBlockhash(p.anchor, p.anchorHash);
        vm.roll(p.anchor);
        vm.expectRevert(TacProvenOracle.BadBlock.selector);
        po.record(_pv(p), new bytes(288), none, none, none);
        // more than 256 blocks old: EIP-2935, absent then present
        vm.roll(p.anchor + 300);
        vm.expectRevert(TacProvenOracle.BadBlock.selector);
        po.record(_pv(p), new bytes(288), none, none, none);
        vm.etch(HISTORY, address(new MockHistory()).code);
        MockHistory(HISTORY).set(p.anchor, p.anchorHash);
        po.record(_pv(p), new bytes(288), none, none, none);
        (uint256 cx,,) = po.coverage();
        assertEq(cx, x);
    }

    // ─────────────── the proof check, on real SP1 v6.1.0 proofs ───────────────

    function _fixture(string memory name) internal view returns (bytes32 vkey, bytes memory pv, bytes memory ours) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/", name));
        vkey = vm.parseJsonBytes32(json, ".vkey");
        pv = vm.parseJsonBytes(json, ".publicValues");
        bytes memory sp1 = vm.parseJsonBytes(json, ".proofBytes");
        // selector, exit code, vk root are folded in; nonce and the eight proof words remain
        ours = new bytes(288);
        for (uint256 i; i < 288; ++i) {
            ours[i] = sp1[68 + i];
        }
    }

    function test_theFoldedCheckAcceptsRealProofsAndRefusesTamperedOnes() public {
        string[2] memory names = [string("lp_groth16.json"), "lp_remove_groth16.json"];
        for (uint256 f; f < 2; ++f) {
            (bytes32 vkey, bytes memory pv, bytes memory proof) = _fixture(names[f]);
            ProvenProbe probe = new ProvenProbe(_config(vkey, G, address(pair)));
            probe.verify(pv, proof);

            bytes memory badPv = bytes.concat(pv);
            badPv[badPv.length - 1] ^= bytes1(0x01);
            vm.expectRevert(TacProvenOracle.ProofInvalid.selector);
            probe.verify{gas: 2_000_000}(badPv, proof);

            for (uint256 w; w < 9; ++w) {
                bytes memory bad = bytes.concat(proof);
                bad[32 * w + 31] ^= bytes1(0x01);
                vm.expectRevert(TacProvenOracle.ProofInvalid.selector);
                probe.verify{gas: 2_000_000}(pv, bad);
            }
            // nonce + R is the same field element; the check refuses it as SP1's does
            bytes memory wrapped = bytes.concat(proof);
            uint256 nonce;
            assembly {
                nonce := mload(add(wrapped, 0x20))
            }
            uint256 r = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;
            if (nonce < type(uint256).max - r) {
                assembly {
                    mstore(add(wrapped, 0x20), add(nonce, r))
                }
                vm.expectRevert(TacProvenOracle.ProofInvalid.selector);
                probe.verify{gas: 2_000_000}(pv, wrapped);
            }
            vm.expectRevert(TacProvenOracle.ProofInvalid.selector);
            probe.verify{gas: 2_000_000}(pv, _slice(proof, 287));

            ProvenProbe other = new ProvenProbe(_config(bytes32(uint256(vkey) ^ 1), G, address(pair)));
            vm.expectRevert(TacProvenOracle.ProofInvalid.selector);
            other.verify{gas: 2_000_000}(pv, proof);
        }
    }

    // SP1VerifierGroth16 v6.1.0's public input points and constant term.
    uint256 internal constant CX = 20281192269339458123687070687118212311775320590888414619062163734024177320592;
    uint256 internal constant CY = 4733327396113282720944079206751955104965328647794767422434462962576999295035;
    uint256 internal constant P0X = 6933777020392885277709527453058337947310422411038083362275568070104688005311;
    uint256 internal constant P0Y = 981134475045095331624771061624185350383934842154508663637397442918499383708;
    uint256 internal constant P1X = 4994703368938944727583784298191985234033403433117347198670233075674015451426;
    uint256 internal constant P1Y = 8251219283963080431419977720140972699009004688253176317231536639169726973868;
    uint256 internal constant P2X = 4290838847096051522936899065591427041691227664160185228987863596451823131267;
    uint256 internal constant P2Y = 20588566735491008722164159313316540988426258906449040460220495569364391658476;
    uint256 internal constant P3X = 10868099250506113890234768256645470833285719586092080686774540776807380789751;
    uint256 internal constant P3Y = 481415511937576118656966359026147167555048629225366340770167496559184060449;
    uint256 internal constant P4X = 248210862999154995000539012177951057105481472135341820587821789934938975214;
    uint256 internal constant P4Y = 4435539404843896136682123140600986858809597152596796648926707165831171499457;
    uint256 internal constant VKROOT = 0x002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352;
    uint256 internal constant FR = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;

    function _mulAdd(uint256[2] memory acc, uint256 px, uint256 py, uint256 s) internal view {
        uint256[3] memory m = [px, py, s];
        uint256[2] memory r;
        uint256[4] memory a;
        bool ok;
        assembly {
            ok := staticcall(gas(), 0x07, m, 0x60, r, 0x40)
        }
        require(ok, "mul");
        a = [acc[0], acc[1], r[0], r[1]];
        assembly {
            ok := staticcall(gas(), 0x06, a, 0x80, acc, 0x40)
        }
        require(ok, "add");
    }

    /// The folded combination equals SP1's five-term one, (vkey, digest, exit code 0, vk root, nonce), for any digest
    /// and nonce, zero nonce included.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_theFoldedInputsAreSP1s(uint256 vkeySeed, uint256 digest, uint256 nonce, bool zeroNonce) public {
        bytes32 vkey = bytes32(vkeySeed % FR);
        digest &= (1 << 253) - 1;
        nonce = zeroNonce ? 0 : nonce % FR;
        ProvenProbe probe = new ProvenProbe(_config(vkey, G, address(pair)));
        (uint256 x, uint256 y, bool ok) = probe.inputs(digest, nonce);
        assertTrue(ok);
        uint256[2] memory acc = [CX, CY];
        _mulAdd(acc, P0X, P0Y, uint256(vkey));
        _mulAdd(acc, P1X, P1Y, digest);
        _mulAdd(acc, P2X, P2Y, 0);
        _mulAdd(acc, P3X, P3Y, VKROOT);
        _mulAdd(acc, P4X, P4Y, nonce);
        assertEq(x, acc[0], "x");
        assertEq(y, acc[1], "y");
        // a nonce outside the field is refused
        (,, ok) = probe.inputs(digest, FR + nonce % 1000);
        assertFalse(ok);
    }

    function test_gas_theFoldedCheck() public {
        (bytes32 vkey, bytes memory pv, bytes memory proof) = _fixture("lp_groth16.json");
        ProvenProbe probe = new ProvenProbe(_config(vkey, G, address(pair)));
        uint256 g = gasleft();
        probe.verify(pv, proof);
        g -= gasleft();
        // SP1VerifierGroth16.verifyProof on the same proof, measured the same way: 225,041
        console2.log("folded check (2 of 5 multiplications)", g);
    }

    // ─────────────── through the router and into a vault ───────────────

    function _vault(address oracle) internal returns (TacVault v) {
        v = new TacVault(
            TacVault.Config({
                tac: address(tac),
                oracle: oracle,
                ethUsd: address(new LiveFeed()),
                owner: address(this),
                mintRatioBps: 35_000,
                liqRatioBps: 20_000,
                liqBonusBps: 2_500,
                auctionDuration: 5_400,
                ownerWindow: 1_200,
                minDebt: 100e18,
                feedMaxStaleness: 3_900,
                debtCeiling: 1_000_000e18,
                depthBps: 500,
                redemptionFeeBps: 50,
                borrowFeeBps: 100,
                feeTo: address(0xFEE),
                tacSink: address(0xdEaD),
                name: "TAC Dollar",
                symbol: "TACD"
            })
        );
    }

    function test_theLiveRouterForwardsAProofAndSkipsARepeat() public {
        TacVault v2 = _vault(address(po));
        TacVaultRouter router = new TacVaultRouter(address(vault), address(v2));
        uint256 x = 519_990;
        _history(4, x, 1e18);
        Proof memory p = _expect(x, 5);
        vm.roll(p.anchor + 5);
        vm.setBlockhash(p.anchor, p.anchorHash);
        address[] memory venues = new address[](1);
        venues[0] = address(po);
        bytes[] memory data = new bytes[](1);
        data[0] = _call(p);
        router.records(address(v2), venues, data);
        (uint256 cx,,) = po.coverage();
        assertEq(cx, x);
        router.records(address(v2), venues, data); // AlreadyRecorded, skipped
    }

    function test_aVaultTakesTheProvenOracleAfterThreeDaysAndBorrowsOnIt() public {
        uint256 x = (HEAD - 1 - G) / STEP - 1;
        _history(5, x, 1_000e18);
        Proof memory p = _expect(x, 5);
        _record(p);
        _at(x);
        vault.queueOracle(address(po));
        skip(3 days);
        vault.executeOracle();
        assertEq(address(vault.ORACLE()), address(po));
        vm.startPrank(alice);
        vault.deposit(100_000e18);
        vault.borrow(1_000e18, 100);
        vm.stopPrank();
    }

    // ─────────────── gas: every vault action, pair against proven ───────────────

    // The proven oracle at GRACE 10 (so it and the pair count the same interval) holding what the pair answers now.
    function _mirror(address o) internal {
        uint256 n = _newest();
        uint256 word = _pairWord();
        uint256 d = TacProvenPack.pack(pair.depthMin(21_600), 24);
        uint256 lt = TacProvenPack.pack(pair.latest(), 24);
        uint256 head = n | (n - 1) << 32 | uint256(2) << 64 | lt << 72 | d << 104 | d << 136 | ((n + 1) * STEP) << 168;
        vm.store(o, bytes32(0), bytes32(head));
        vm.store(o, bytes32(1 + n % 8), bytes32(word));
        vm.store(o, bytes32(1 + (n - 1) % 8), bytes32(word));
    }

    function _phase(address o, uint256 f, uint256 spread) internal {
        _fill(f, spread);
        if (o != address(0)) _mirror(o);
    }

    function _use(TacVault v) internal {
        vault = v;
        synth = v.SYNTH();
        vm.startPrank(alice);
        synth.approve(address(v), type(uint256).max);
        tac.approve(address(v), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(bob);
        synth.approve(address(v), type(uint256).max);
        tac.approve(address(v), type(uint256).max);
        vm.stopPrank();
    }

    function _sequence(address o, string memory tag) internal {
        _phase(o, 10_000, 3_000);
        uint256 g;
        vm.startPrank(alice);
        g = gasleft();
        vault.deposit(100_000e18);
        console2.log(tag, "deposit", g - gasleft());
        g = gasleft();
        vault.borrow(5_000e18, 100);
        console2.log(tag, "borrow (first)", g - gasleft());
        g = gasleft();
        vault.borrow(100e18, 100);
        console2.log(tag, "borrow (second)", g - gasleft());
        g = gasleft();
        vault.withdraw(1_000e18);
        console2.log(tag, "withdraw (with debt)", g - gasleft());
        vm.stopPrank();
        vm.startPrank(bob);
        vault.deposit(100_000e18);
        vault.borrow(5_000e18, 100);
        vm.stopPrank();
        _phase(o, 6_000, 3_000);
        vm.prank(alice);
        g = gasleft();
        vault.redeem(bob, 200e18, 0);
        console2.log(tag, "redeem", g - gasleft());
        _phase(o, 3_000, 3_000);
        g = gasleft();
        vault.liquidate(bob);
        console2.log(tag, "liquidate", g - gasleft());
        vault.liquidate(alice);
        skip(1_800);
        _phase(o, 3_000, 3_000);
        vm.prank(alice);
        g = gasleft();
        vault.bid(bob, 1_000e18, 0);
        console2.log(tag, "bid (partial)", g - gasleft());
        skip(5_400);
        _phase(o, 500, 3_000);
        vm.prank(alice);
        synth.transfer(address(vault), 2_000e18);
        g = gasleft();
        vault.absorb(alice);
        console2.log(tag, "absorb", g - gasleft());
        _phase(o, 10_000, 3_000);
        g = gasleft();
        vault.cancel(bob);
        console2.log(tag, "cancel (recovered)", g - gasleft());
    }

    function test_gas_vaultActionsOnThePair() public {
        _use(_vault(address(pair)));
        _sequence(address(0), "pair  ");
    }

    function test_gas_vaultActionsOnTheProvenOracle() public {
        ProvenNoVerify o = new ProvenNoVerify(_config(bytes32(uint256(1)), OLD_GRACE, address(pair)));
        _use(_vault(address(o)));
        _sequence(address(o), "proven");
    }

    function test_gas_recordFiveIntervals() public {
        uint256 x = 519_990;
        _history(6, x, 1e18);
        Proof memory p = _expect(x, 5);
        vm.roll(p.anchor + 5);
        vm.setBlockhash(p.anchor, p.anchorHash);
        // a ring that has done a lap: every slot already non-zero
        for (uint256 i; i < 9; ++i) {
            vm.store(address(po), bytes32(i), bytes32(uint256(1)));
        }
        bytes[] memory none;
        bytes memory pv = _pv(p);
        uint256 g = gasleft();
        po.record(pv, new bytes(288), none, none, none);
        console2.log("record, 5 intervals, proof check skipped", g - gasleft());
    }
}
