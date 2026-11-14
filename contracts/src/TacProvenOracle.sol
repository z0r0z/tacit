// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// @title TacProvenOracle
/// @notice The TAC vaults' oracle, answered from one SP1 proof per update instead of one storage proof per interval.
///
///         The proven program reads the same thing the venue oracles record (each STEP-block interval's sample block,
///         picked by the next block's RANDAO value; the ETH/TAC Precision pool's and the confidential pool's
///         end-of-block reserves there) for every interval its windows need, checks the headers back to an anchor block
///         and computes what TacPairOracle would answer with those samples recorded and no later ones. It commits:
///
///           word 0   keccak256(the anchor block's hash, CONFIG): the chain it read and the venues, slots, scales
///                    and windows it read them with
///           word 1   the head: X (newest interval proven) | X - 1 | count | latest | depth at X - 1 | depth at X |
///                    the anchor block's number, at bits 0, 32, 64, 72, 104, 136 and 168
///           word 2+  for each N from X - 1 on, COUNT words: (low, high, recovery) for SHORT_WINDOW, WINDOW and
///                    MAX_WINDOW as nine 28-bit floats, 84 bits per window, as TacPairOracle answers when N is the
///                    newest interval that counts (intervals after X counted as not recorded); 0 where it reverts
///
///         `record` checks the anchor against BLOCKHASH or EIP-2935, verifies the proof and stores the head and the
///         words. A view answers from them while the newest interval that counts is one they cover (and depthMin only
///         at X - 1 and X, the intervals for which every sample is proven); otherwise, or where a word holds no
///         answer, it passes the call unchanged to FALLBACK, the pair oracle the vaults used before. Every proof
///         covers COUNT intervals, so a newer proof never covers less than the one it replaces.
///
///         FALLBACK is still recorded the slow way, and `record` takes those records too: a call that carries storage
///         proofs is a venue oracle's record, whose last `proofB` element is one byte naming the venue (0 for FALLBACK's
///         A, 1 for its B); the call goes to that venue without it, and its answer or error comes back.
///
///         The proof is SP1 v6.1.0 Groth16, verified here against that circuit's key with the program key, the
///         recursion key root and a zero exit code folded into one constant point at deployment, so only the public
///         values digest and the proof nonce are multiplied in at verification. `record` keeps the venue oracles'
///         selector and its AlreadyRecorded error, and A and B are this contract, so TacVaultRouter passes it through.
///
///         Floats are `exponent << m | mantissa` with an implicit leading one (m = 20 for answers, 24 for the head's
///         latest and depths) and truncate: an answer is at most 2^-20 of itself below the exact value, never above.
///         No owner and no settings.
contract TacProvenOracle {
    // ─────────────── SP1 v6.1.0 Groth16 (gnark), the circuit every v6.1.0 program shares ───────────────

    uint256 internal constant R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;
    uint256 internal constant VK_ROOT = 0x002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352;
    uint256 internal constant ALPHA_X = 15279411540481963483749982645131486879260751823620651493692884460296130891713;
    uint256 internal constant ALPHA_Y = 15872895802316430142046488442363778159164596024024981740547841316113839677454;
    uint256 internal constant BETA_NEG_X_0 = 6145571844528009385227270901181311049451968424667282936975270874464890915386;
    uint256 internal constant BETA_NEG_X_1 = 12771786691609444002416405093387705070206640282801320788762089789398249455552;
    uint256 internal constant BETA_NEG_Y_0 = 4488883874756188982949192438322346627006627895205628031405236004639323835517;
    uint256 internal constant BETA_NEG_Y_1 = 1735169520034591855846686229876971881413094324547255227368057137445726296809;
    uint256 internal constant GAMMA_NEG_X_0 =
        10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 internal constant GAMMA_NEG_X_1 =
        11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 internal constant GAMMA_NEG_Y_0 =
        13392588948715843804641432497768002650278120570034223513918757245338268106653;
    uint256 internal constant GAMMA_NEG_Y_1 =
        17805874995975841540914202342111839520379459829704422454583296818431106115052;
    uint256 internal constant DELTA_NEG_X_0 =
        10465707362494635227101096813108413078937487707553051407465224907243675430929;
    uint256 internal constant DELTA_NEG_X_1 = 8014260607368773541998918215611927658290278403999176336697043972644519659243;
    uint256 internal constant DELTA_NEG_Y_0 =
        19389283139277148919245778864125350153699493315071306268776225113374776030523;
    uint256 internal constant DELTA_NEG_Y_1 =
        16335894885742905444968709132584769120387318573561090701871591658625758958113;
    uint256 internal constant CONSTANT_X = 20281192269339458123687070687118212311775320590888414619062163734024177320592;
    uint256 internal constant CONSTANT_Y = 4733327396113282720944079206751955104965328647794767422434462962576999295035;
    uint256 internal constant PUB_0_X = 6933777020392885277709527453058337947310422411038083362275568070104688005311;
    uint256 internal constant PUB_0_Y = 981134475045095331624771061624185350383934842154508663637397442918499383708;
    uint256 internal constant PUB_1_X = 4994703368938944727583784298191985234033403433117347198670233075674015451426;
    uint256 internal constant PUB_1_Y = 8251219283963080431419977720140972699009004688253176317231536639169726973868;
    uint256 internal constant PUB_3_X = 10868099250506113890234768256645470833285719586092080686774540776807380789751;
    uint256 internal constant PUB_3_Y = 481415511937576118656966359026147167555048629225366340770167496559184060449;
    uint256 internal constant PUB_4_X = 248210862999154995000539012177951057105481472135341820587821789934938975214;
    uint256 internal constant PUB_4_Y = 4435539404843896136682123140600986858809597152596796648926707165831171499457;

    // ─────────────── layout ───────────────

    uint256 internal constant BLOCK_SECONDS = 12;
    uint256 internal constant WAD = 1e18;
    address internal constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    /// Answer words kept: a proof covers at most this many intervals.
    uint256 public constant SPAN = 8;
    uint256 internal constant M32 = 0xffffffff;
    uint256 internal constant M28 = 0xfffffff;
    // The Precision pool's packed reserves and its LP supply (solady ERC20's supply slot).
    bytes32 internal constant RESERVES_SLOT = bytes32(0);
    bytes32 internal constant SUPPLY_SLOT = bytes32(uint256(0x05345cdf77eb68f44c));

    /// The program's verification key (SP1's `vk.bytes32()`).
    bytes32 public immutable PROGRAM_VKEY;
    // CONSTANT + PROGRAM_VKEY·PUB_0 + VK_ROOT·PUB_3 (exit code 0 adds nothing).
    uint256 internal immutable KX;
    uint256 internal immutable KY;

    uint256 public immutable STEP;
    uint256 public immutable SHORT_WINDOW;
    uint256 public immutable WINDOW;
    uint256 public immutable MAX_WINDOW;
    /// Blocks after an interval ends before it counts. Under STEP, so a proof made once an interval ends lands while
    /// it covers the newest interval that counts.
    uint256 public immutable GRACE;
    /// The intervals every proof answers for, from X - 1.
    uint256 public immutable COUNT;

    /// The pair oracle that answers whatever the proofs do not, and its two venue oracles.
    address public immutable FALLBACK;
    address internal immutable VENUE_A;
    address internal immutable VENUE_B;

    /// Share of a window's intervals that must hold a sample for a median, as the venue oracles require.
    uint256 public immutable MIN_COVERAGE_BPS;
    address public immutable PRECISION;
    uint256 public immutable SQRT_P_LOW;
    uint256 public immutable SQRT_P_HIGH;
    address public immutable POOL;
    bytes32 public immutable POOL_ID;
    /// POOL_ID's reserveA and reserveB slots in POOL's `pools` mapping.
    bytes32 public immutable SLOT_A;
    bytes32 public immutable SLOT_B;
    uint256 public immutable ETH_SCALE;
    uint256 public immutable TAC_SCALE;
    /// keccak256(abi.encode(STEP, the three windows in intervals, MIN_COVERAGE_BPS, PRECISION, its reserves and supply
    /// slots, SQRT_P_LOW, SQRT_P_HIGH, POOL, SLOT_A, SLOT_B, ETH_SCALE, TAC_SCALE)): what the program reads and how.
    bytes32 public immutable CONFIG;

    // X | X - 1 | count | latest | depth at X - 1 | depth at X | anchor, as committed (slot 0).
    uint256 internal _head;
    // The answer word for N at N % SPAN (slots 1 to 8).
    uint256[SPAN] internal _words;

    error BadConfig();
    error BadBlock();
    error BadValues();
    error AlreadyRecorded();
    error ProofInvalid();
    error TooFewSamples();

    event Proven(uint256 interval);

    struct Config {
        bytes32 programVKey;
        address precision;
        address tac;
        address pool;
        bytes32 poolId;
        bytes32 ethAsset;
        bytes32 tacAsset;
        uint256 mappingSlot;
        uint256 step;
        uint256 shortWindow;
        uint256 window;
        uint256 maxWindow;
        uint256 grace;
        uint256 count;
        uint256 minCoverageBps;
        address fallbackOracle;
    }

    constructor(Config memory c) {
        uint256 stepSeconds = c.step * BLOCK_SECONDS;
        if (c.step == 0 || c.grace >= c.step || uint256(c.programVKey) >= R) revert BadConfig();
        if (c.count < 2 || c.count > SPAN || c.minCoverageBps == 0 || c.minCoverageBps > 10_000) revert BadConfig();
        if (c.shortWindow < stepSeconds || c.window < c.shortWindow || c.maxWindow < c.window) revert BadConfig();
        (address venueA, address venueB) = (address(0), address(0));
        if (c.fallbackOracle != address(0)) {
            IFallback f = IFallback(c.fallbackOracle);
            if (
                f.STEP() != c.step || f.SHORT_WINDOW() != c.shortWindow || f.WINDOW() != c.window
                    || f.MAX_WINDOW() != c.maxWindow
            ) revert BadConfig();
            (venueA, venueB) = (f.A(), f.B());
        }
        (address base, address quote) = IPrecision(c.precision).tapePair();
        if (base != address(0) || quote != c.tac) revert BadConfig();
        uint256 lo = IPrecision(c.precision).sqrtPLow();
        uint256 hi = IPrecision(c.precision).sqrtPHigh();
        if (lo == 0 || hi <= lo) revert BadConfig();
        (bool init, bytes32 assetA, bytes32 assetB,,,,) = IConfidentialPool(c.pool).pools(c.poolId);
        if (!init || assetA != c.ethAsset || assetB != c.tacAsset) revert BadConfig();
        (bool ethOk, address ethU, uint256 ethScale,,,) = IConfidentialPool(c.pool).assets(c.ethAsset);
        (bool tacOk, address tacU, uint256 tacScale,,,) = IConfidentialPool(c.pool).assets(c.tacAsset);
        if (!ethOk || ethU != address(0) || !tacOk || tacU != c.tac || ethScale == 0 || tacScale == 0) {
            revert BadConfig();
        }

        uint256 kx;
        uint256 ky;
        uint256 vkey = uint256(c.programVKey);
        bool ok;
        assembly ("memory-safe") {
            let f := mload(0x40)
            let g := add(f, 0x40)
            mstore(f, CONSTANT_X)
            mstore(add(f, 0x20), CONSTANT_Y)
            mstore(g, PUB_0_X)
            mstore(add(g, 0x20), PUB_0_Y)
            mstore(add(g, 0x40), vkey)
            ok := staticcall(gas(), 0x07, g, 0x60, g, 0x40)
            ok := and(ok, staticcall(gas(), 0x06, f, 0x80, f, 0x40))
            mstore(g, PUB_3_X)
            mstore(add(g, 0x20), PUB_3_Y)
            mstore(add(g, 0x40), VK_ROOT)
            ok := and(ok, staticcall(gas(), 0x07, g, 0x60, g, 0x40))
            ok := and(ok, staticcall(gas(), 0x06, f, 0x80, f, 0x40))
            kx := mload(f)
            ky := mload(add(f, 0x20))
        }
        if (!ok) revert BadConfig();

        PROGRAM_VKEY = c.programVKey;
        (KX, KY) = (kx, ky);
        (STEP, SHORT_WINDOW, WINDOW, MAX_WINDOW, GRACE) = (c.step, c.shortWindow, c.window, c.maxWindow, c.grace);
        COUNT = c.count;
        MIN_COVERAGE_BPS = c.minCoverageBps;
        (FALLBACK, VENUE_A, VENUE_B) = (c.fallbackOracle, venueA, venueB);
        (PRECISION, SQRT_P_LOW, SQRT_P_HIGH) = (c.precision, lo, hi);
        (POOL, POOL_ID, ETH_SCALE, TAC_SCALE) = (c.pool, c.poolId, ethScale, tacScale);
        uint256 entry = uint256(keccak256(abi.encode(c.poolId, c.mappingSlot)));
        (bytes32 slotA, bytes32 slotB) = (bytes32(entry + 3), bytes32(entry + 4));
        (SLOT_A, SLOT_B) = (slotA, slotB);
        CONFIG = keccak256(
            abi.encode(
                c.step,
                c.shortWindow / stepSeconds,
                c.window / stepSeconds,
                c.maxWindow / stepSeconds,
                c.minCoverageBps,
                c.precision,
                RESERVES_SLOT,
                SUPPLY_SLOT,
                lo,
                hi,
                c.pool,
                slotA,
                slotB,
                ethScale,
                tacScale
            )
        );
    }

    // ─────────────── record ───────────────

    /// Stores a proof's answers: `publicValues` as committed (see above), `proof` as the nine words nonce, A, B, C of
    /// SP1's Groth16 proof (its bytes after the selector, exit code and vk root), the three arrays empty. The
    /// signature is the venue oracles' so TacVaultRouter forwards it. Reverts AlreadyRecorded unless X is newer than
    /// what is stored. With storage proofs in the arrays it is a venue oracle's record, passed on (see above).
    function record(
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata accountProof,
        bytes[] calldata proofA,
        bytes[] calldata proofB
    ) external returns (uint256, uint256) {
        if (accountProof.length != 0) return _toVenue(proofB);
        uint256 step = STEP;
        uint256 count = COUNT;
        bytes32 config = CONFIG;
        uint256 head;
        uint256 x;
        assembly ("memory-safe") {
            function fail(sel) {
                mstore(0, sel)
                revert(0x1c, 0x04)
            }
            head := calldataload(add(publicValues.offset, 0x20))
            x := and(head, M32)
            // COUNT words from X - 1, and the length to match.
            if or(iszero(eq(and(shr(64, head), 0xff), count)), iszero(eq(publicValues.length, add(0x40, shl(5, count))))) {
                fail(0xd26b7728) // BadValues()
            }
            if iszero(eq(and(shr(32, head), M32), sub(x, 1))) { fail(0xd26b7728) }
            if iszero(gt(x, and(sload(_head.slot), M32))) { fail(0x103b4afe) } // AlreadyRecorded()
            // The anchor: at or after the block that picks X's sample, before this one, with the committed hash.
            let anchor := and(shr(168, head), M32)
            if or(lt(anchor, mul(add(x, 1), step)), iszero(lt(anchor, number()))) { fail(0xa4b881ea) } // BadBlock()
            let h := 0
            switch gt(sub(number(), anchor), 256)
            case 0 { h := blockhash(anchor) }
            default {
                mstore(0, anchor)
                if staticcall(gas(), HISTORY, 0, 0x20, 0, 0x20) { if eq(returndatasize(), 0x20) { h := mload(0) } }
            }
            if iszero(h) { fail(0xa4b881ea) }
            mstore(0, h)
            mstore(0x20, config)
            if iszero(eq(keccak256(0, 0x40), calldataload(publicValues.offset))) { fail(0xa4b881ea) }
        }
        _verify(publicValues, proof);
        assembly ("memory-safe") {
            sstore(_head.slot, head)
            let first := sub(x, 1)
            let src := add(publicValues.offset, 0x40)
            for { let i := 0 } lt(i, count) { i := add(i, 1) } {
                sstore(add(_words.slot, and(add(first, i), sub(SPAN, 1))), calldataload(add(src, shl(5, i))))
            }
        }
        emit Proven(x);
        return (x, count);
    }

    // A venue oracle's record, to FALLBACK's A or B as its last `proofB` element says. The call goes on as it came
    // with `proofB`'s length one less, so the venue decodes exactly the record without the tag.
    function _toVenue(bytes[] calldata proofB) internal returns (uint256, uint256) {
        uint256 n = proofB.length;
        if (n < 2 || proofB[n - 1].length != 1 || uint8(proofB[n - 1][0]) > 1) revert BadValues();
        address venue = uint8(proofB[n - 1][0]) == 0 ? VENUE_A : VENUE_B;
        if (venue == address(0)) revert BadConfig();
        assembly ("memory-safe") {
            let m := mload(0x40)
            calldatacopy(m, 0, calldatasize())
            mstore(add(m, sub(proofB.offset, 0x20)), sub(n, 1))
            let ok := call(gas(), venue, 0, m, calldatasize(), 0, 0)
            returndatacopy(m, 0, returndatasize())
            if iszero(and(ok, eq(returndatasize(), 0x40))) { revert(m, returndatasize()) }
            return(m, 0x40)
        }
    }

    /// Verifies `proof` for PROGRAM_VKEY and `publicValues` as SP1VerifierGroth16 v6.1.0 does with exit code 0 and
    /// its vk root: one pairing check of e(A, B)·e(C, -δ)·e(α, -β)·e(L, -γ), L the public inputs' combination.
    function _verify(bytes calldata publicValues, bytes calldata proof) internal view virtual {
        uint256 digest;
        uint256 nonce;
        bool ok;
        assembly ("memory-safe") {
            // The public values digest: sha256, top three bits cleared.
            let f := mload(0x40)
            calldatacopy(f, publicValues.offset, publicValues.length)
            ok := and(eq(proof.length, 0x120), staticcall(gas(), 0x02, f, publicValues.length, f, 0x20))
            digest := and(mload(f), 0x1fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff)
            nonce := calldataload(proof.offset)
        }
        (uint256 lx, uint256 ly, bool okL) = _inputs(digest, nonce);
        assembly ("memory-safe") {
            // (A, B), (C, -δ), (α, -β), (L, -γ); A, B, C are in the precompile's encoding already.
            let f := mload(0x40)
            calldatacopy(f, add(proof.offset, 0x20), 0x100)
            mstore(add(f, 0x100), DELTA_NEG_X_1)
            mstore(add(f, 0x120), DELTA_NEG_X_0)
            mstore(add(f, 0x140), DELTA_NEG_Y_1)
            mstore(add(f, 0x160), DELTA_NEG_Y_0)
            mstore(add(f, 0x180), ALPHA_X)
            mstore(add(f, 0x1a0), ALPHA_Y)
            mstore(add(f, 0x1c0), BETA_NEG_X_1)
            mstore(add(f, 0x1e0), BETA_NEG_X_0)
            mstore(add(f, 0x200), BETA_NEG_Y_1)
            mstore(add(f, 0x220), BETA_NEG_Y_0)
            mstore(add(f, 0x240), lx)
            mstore(add(f, 0x260), ly)
            mstore(add(f, 0x280), GAMMA_NEG_X_1)
            mstore(add(f, 0x2a0), GAMMA_NEG_X_0)
            mstore(add(f, 0x2c0), GAMMA_NEG_Y_1)
            mstore(add(f, 0x2e0), GAMMA_NEG_Y_0)
            ok := and(and(ok, okL), staticcall(gas(), 0x08, f, 0x300, f, 0x20))
            if iszero(and(ok, mload(f))) {
                mstore(0, 0x7fcdd1f4) // ProofInvalid()
                revert(0x1c, 0x04)
            }
        }
    }

    /// L = K + digest·PUB_1 + nonce·PUB_4, the five public inputs' combination with the three fixed ones folded into
    /// K. A digest is under 2^253, so in the field; a nonce must be. A zero nonce (local proving) adds nothing.
    function _inputs(uint256 digest, uint256 nonce) internal view returns (uint256 lx, uint256 ly, bool ok) {
        uint256 kx = KX;
        uint256 ky = KY;
        assembly ("memory-safe") {
            let f := mload(0x40)
            let g := add(f, 0x40)
            mstore(f, kx)
            mstore(add(f, 0x20), ky)
            mstore(g, PUB_1_X)
            mstore(add(g, 0x20), PUB_1_Y)
            mstore(add(g, 0x40), digest)
            ok := and(lt(nonce, R), staticcall(gas(), 0x07, g, 0x60, g, 0x40))
            ok := and(ok, staticcall(gas(), 0x06, f, 0x80, f, 0x40))
            if nonce {
                mstore(g, PUB_4_X)
                mstore(add(g, 0x20), PUB_4_Y)
                mstore(add(g, 0x40), nonce)
                ok := and(ok, staticcall(gas(), 0x07, g, 0x60, g, 0x40))
                ok := and(ok, staticcall(gas(), 0x06, f, 0x80, f, 0x40))
            }
            lx := mload(f)
            ly := mload(add(f, 0x20))
        }
    }

    // ─────────────── views (TacPairOracle's) ───────────────

    /// The lower and upper median ETH per TAC over the last `window` seconds.
    function prices(uint256 window) external view returns (uint256 low, uint256 high) {
        (uint256 word, uint256 k) = _word(window);
        low = _unpack(word >> k, 20, M28);
        high = _unpack(word >> (k + 28), 20, M28);
        if (low == 0) _forward();
    }

    /// The higher of the venues' lower medians over the last `window` seconds.
    function recovery(uint256 window) external view returns (uint256 low) {
        (uint256 word, uint256 k) = _word(window);
        low = _unpack(word >> (k + 56), 20, M28);
        if (low == 0) _forward();
    }

    /// The smallest ETH depth over MAX_WINDOW, at X - 1 and X.
    function depthMin(uint256 window) external view returns (uint256 depth) {
        uint256 head = _head;
        uint256 j;
        unchecked {
            j = _newest(GRACE) - ((head >> 32) & M32);
        }
        if (window != MAX_WINDOW || j > 1 || head == 0) _forward();
        depth = _unpack(head >> (104 + 32 * j), 24, M32);
        if (depth == 0) _forward();
    }

    /// The newest proven price, while the proof covers the newest interval that counts (past it, FALLBACK's, which a
    /// record of either venue moves on).
    function latest() external view returns (uint256 ethPerTac) {
        uint256 head = _head;
        unchecked {
            if (head == 0 || _newest(GRACE) - ((head >> 32) & M32) >= (head >> 64) & 0xff) _forward();
        }
        ethPerTac = _unpack(head >> 72, 24, M32);
        if (ethPerTac == 0) _forward();
    }

    /// The lower of the two venues' ETH per TAC now.
    function spot() external view returns (uint256) {
        return FixedPointMathLib.min(_precisionSpot(), _ammSpot());
    }

    /// The router's venue check: this contract is both venues.
    function A() external view returns (address) {
        return address(this);
    }

    function B() external view returns (address) {
        return address(this);
    }

    /// X, the first interval covered (X - 1) and how many, as stored.
    function coverage() external view returns (uint256 x, uint256 first, uint256 count) {
        uint256 head = _head;
        (x, first, count) = (head & M32, (head >> 32) & M32, (head >> 64) & 0xff);
    }

    // The answer word for the newest interval that counts and the bit offset of `window`'s fields in it; forwards
    // to FALLBACK when the word does not cover that interval or `window` is not one of the three.
    function _word(uint256 window) internal view returns (uint256 word, uint256 k) {
        if (window == SHORT_WINDOW) k = 0;
        else if (window == WINDOW) k = 84;
        else if (window == MAX_WINDOW) k = 168;
        else _forward();
        uint256 n = _newest(GRACE);
        uint256 head = _head;
        unchecked {
            if (n - ((head >> 32) & M32) >= (head >> 64) & 0xff) _forward();
        }
        assembly ("memory-safe") {
            word := sload(add(_words.slot, and(n, sub(SPAN, 1))))
        }
    }

    // The newest interval whose following block is more than `grace` blocks old.
    function _newest(uint256 grace) internal view returns (uint256) {
        uint256 last = block.number - 1;
        if (last < grace + STEP) revert TooFewSamples();
        unchecked {
            return (last - grace) / STEP - 1;
        }
    }

    // Repeats this call on FALLBACK and returns or reverts with what it gives.
    function _forward() internal view {
        address f = FALLBACK;
        assembly ("memory-safe") {
            if iszero(f) {
                mstore(0, 0xa889a81f) // TooFewSamples()
                revert(0x1c, 0x04)
            }
            let m := mload(0x40)
            calldatacopy(m, 0, calldatasize())
            let ok := staticcall(gas(), f, m, calldatasize(), 0, 0)
            returndatacopy(m, 0, returndatasize())
            if ok { return(m, returndatasize()) }
            revert(m, returndatasize())
        }
    }

    function _precisionSpot() internal view returns (uint256) {
        address p = PRECISION;
        uint256 supply;
        uint256 r0;
        uint256 r1;
        assembly ("memory-safe") {
            let ok := 1
            mstore(0, 0x18160ddd) // totalSupply()
            ok := and(ok, staticcall(gas(), p, 0x1c, 0x04, 0x00, 0x20))
            ok := and(ok, eq(returndatasize(), 0x20))
            supply := mload(0x00)
            mstore(0, 0x443cb4bc) // reserve0()
            ok := and(ok, staticcall(gas(), p, 0x1c, 0x04, 0x00, 0x20))
            ok := and(ok, eq(returndatasize(), 0x20))
            r0 := mload(0x00)
            mstore(0, 0x5a76f25e) // reserve1()
            ok := and(ok, staticcall(gas(), p, 0x1c, 0x04, 0x00, 0x20))
            ok := and(ok, eq(returndatasize(), 0x20))
            r1 := mload(0x00)
            if iszero(and(ok, iszero(or(shr(128, r0), shr(128, r1))))) { revert(0, 0) }
        }
        uint256 eth = supply * WAD / SQRT_P_HIGH + r0;
        uint256 tac = supply * SQRT_P_LOW / WAD + r1;
        if (supply == 0 || tac == 0) revert BadBlock();
        return FixedPointMathLib.fullMulDiv(eth, WAD, tac);
    }

    function _ammSpot() internal view returns (uint256) {
        address p = POOL;
        bytes32 id = POOL_ID;
        uint256 ra;
        uint256 rb;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, 0xb5217bb4) // pools(bytes32)
            mstore(add(m, 0x20), id)
            let ok := staticcall(gas(), p, add(m, 0x1c), 0x24, m, 0xe0)
            if iszero(and(ok, eq(returndatasize(), 0xe0))) { revert(0, 0) }
            ra := mload(add(m, 0x60))
            rb := mload(add(m, 0x80))
        }
        if (ra == 0 || rb == 0) revert BadBlock();
        return FixedPointMathLib.fullMulDiv(ra * ETH_SCALE, WAD, rb * TAC_SCALE);
    }

    // A float of `m` mantissa bits (`mask` its width plus eight): exponent 0 holds the value, e > 0 an implicit
    // leading one shifted by e - 1.
    function _unpack(uint256 p, uint256 m, uint256 mask) internal pure returns (uint256 v) {
        unchecked {
            p &= mask;
            uint256 e = p >> m;
            v = p & ((1 << m) - 1);
            if (e != 0) v = (v | (1 << m)) << (e - 1);
        }
    }
}

interface IFallback {
    function A() external view returns (address);
    function B() external view returns (address);
    function STEP() external view returns (uint256);
    function SHORT_WINDOW() external view returns (uint256);
    function WINDOW() external view returns (uint256);
    function MAX_WINDOW() external view returns (uint256);
}

interface IPrecision {
    function tapePair() external view returns (address base, address quote);
    function sqrtPLow() external view returns (uint256);
    function sqrtPHigh() external view returns (uint256);
}

interface IConfidentialPool {
    function pools(bytes32 poolId)
        external
        view
        returns (bool, bytes32, bytes32, uint256, uint256, uint32, uint256);
    function assets(bytes32 assetId) external view returns (bool, address, uint256, bytes32, bool, uint8);
}

/// The float packing the proven program commits, for the program's tests and off-chain readers.
library TacProvenPack {
    /// Packs `v` into a float of `m` mantissa bits, truncating.
    function pack(uint256 v, uint256 m) internal pure returns (uint256) {
        if (v < (1 << m) << 1) {
            // exponent 0 (below 2^m) or 1 (2^m to 2^(m+1)): exact
            return v < (1 << m) ? v : (1 << m) | (v - (1 << m));
        }
        uint256 msb = FixedPointMathLib.log2(v);
        uint256 shift = msb - m;
        return ((shift + 1) << m) | ((v >> shift) & ((1 << m) - 1));
    }

    function unpack(uint256 p, uint256 m) internal pure returns (uint256 v) {
        uint256 e = p >> m;
        v = p & ((1 << m) - 1);
        if (e != 0) v = (v | (1 << m)) << (e - 1);
    }
}
