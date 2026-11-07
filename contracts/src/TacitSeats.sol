// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface IERC20Seats {
    function balanceOf(address who) external view returns (uint256);
}

/// @notice Whose turn it is to land the next Tacit block. A seat is SEAT of TAC locked here, and a holder may take as many seats as it
///         locks TAC for. Time runs in slots of SLOT_BLOCKS Ethereum blocks and epochs of EPOCH_SLOTS slots. Each slot one seat leads,
///         drawn from the epoch's seats by the slot's number and the epoch's seed: the beacon chain's randomness (`block.prevrandao`)
///         in the first block of the epoch's blocks 1 to SEED_BLOCKS (block 0's is known to the proposer of the block before it, which
///         may still take or leave seats for this epoch) in which anyone keeps it (`turn`). A seat taken or left counts from the
///         next epoch, so an epoch's seats are fixed before its seed exists, and no holder can choose its turns by taking or leaving
///         seats: over time each seat leads its share of them. A block hash would not do: whoever builds the block can try as many
///         as it likes. The beacon randomness of a block is fixed before the block is built, so the most anyone can choose is which of
///         the first SEED_BLOCKS keeps it (a proposer can also withhold its block, about one bit more). With no seats, BOOTSTRAP leads.
///
///         Nothing here has an owner: no one can take a seat away, change the terms or move a stake. A seat is left only by its holder,
///         whose TAC comes back EXIT_DELAY later.
///
///         A turn only says who proves the next block. A leader that lands nothing holds the chain back until the landing contract lets
///         anyone land (its WINDOW after the last landing), and one that leaves a spend out cannot keep it out (the landing contract's
///         queue). An epoch whose seed nobody kept in its first SEED_BLOCKS has no leader, and anyone may land in it; a leader keeps
///         it by calling `turn` as the epoch begins (landing calls it too, but a landing that reverts keeps nothing).
///
///         A leader that starts a block late in its slot may not land it in time; a leader proves only what it can land before its
///         slot ends.
contract TacitSeats {
    IERC20Seats public immutable TAC;
    /// @notice The TAC one seat locks.
    uint256 public immutable SEAT;
    /// @notice How many Ethereum blocks each turn lasts.
    uint256 public immutable SLOT_BLOCKS;
    /// @notice Who leads while no one holds a seat.
    address public immutable BOOTSTRAP;
    uint256 public constant EPOCH_SLOTS = 16;
    uint256 public constant EXIT_DELAY = 7 days;
    uint256 public constant MIN_SLOT_BLOCKS = 5;
    uint256 public constant MAX_SLOT_BLOCKS = 300;
    /// @notice How many blocks from an epoch's start its seed can be kept in.
    uint256 public constant SEED_BLOCKS = 4;

    /// A seat's holder in the draw, and the holder that takes its place from epoch `nextFrom` on (none while it is 0). Every change counts
    /// from the epoch after the one it is made in, so two holders are all a seat ever needs.
    struct Seat {
        address holder;
        address next;
        uint64 nextFrom;
    }
    mapping(uint256 => Seat) internal seat;
    /// How many seats the draw has, and how many from epoch `countNextFrom` on.
    uint64 internal count;
    uint64 internal countNext;
    uint64 internal countNextFrom;
    /// @notice The seeds kept, by epoch.
    mapping(uint256 => bytes32) public seedOf;
    /// @notice How many seats each holder has from the next epoch on.
    mapping(address => uint256) public seatsOf;
    struct Leaving {
        uint192 amount;
        uint64 until;
    }
    /// @notice TAC of seats left and not yet claimed, and when it may be (the latest seat left sets it).
    mapping(address => Leaving) public leaving;

    /// @notice `who` took `seat`, which is in the draw from `epoch` on.
    event Joined(address indexed who, uint256 seat, uint256 epoch);
    /// @notice `who` left `seat` (from `epoch` on); the last seat, held by `moved`, takes its place (`moved` is zero when the last seat
    ///         was the one left).
    event Left(address indexed who, uint256 seat, address moved, uint256 epoch, uint256 until);
    event Claimed(address indexed who, uint256 amount);
    /// @notice Where `who`, a seat holder, takes spends for the blocks it lands: what it says, for wallets to find it (a wallet uses only
    ///         the latest one of a holder of a seat in the current epoch).
    event Endpoint(address indexed who, string url);

    error BadTerms();
    error NotYours();
    error TooSoon();
    error Nothing();
    error TransferFailed();

    constructor(IERC20Seats tac, uint256 seatStake, uint256 slotBlocks, address bootstrap) {
        if (address(tac).code.length == 0 || seatStake == 0 || seatStake > type(uint192).max / 2 ** 32) revert BadTerms();
        if (slotBlocks < MIN_SLOT_BLOCKS || slotBlocks > MAX_SLOT_BLOCKS) revert BadTerms();
        TAC = tac;
        SEAT = seatStake;
        SLOT_BLOCKS = slotBlocks;
        BOOTSTRAP = bootstrap;
    }

    /// @notice Locks SEAT of TAC (approved to this contract) for one more seat, in the draw from the next epoch on.
    function join() external returns (uint256 i) {
        uint256 before = TAC.balanceOf(address(this));
        _call(abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), SEAT));
        if (TAC.balanceOf(address(this)) - before != SEAT) revert TransferFailed();
        uint256 next = epoch() + 1;
        i = _countAt(next);
        _setSeat(i, msg.sender);
        _setCount(i + 1);
        seatsOf[msg.sender] += 1;
        emit Joined(msg.sender, i, next);
    }

    /// @notice Gives up seat `i` (as the next epoch numbers it), which the caller holds: from the next epoch on it is out of the draw, and
    ///         its TAC may be claimed EXIT_DELAY from now.
    function leave(uint256 i) external {
        uint256 next = epoch() + 1;
        uint256 n = _countAt(next);
        if (i >= n || _holderAt(i, next) != msg.sender) revert NotYours();
        uint256 last = n - 1;
        address moved;
        if (i != last) {
            moved = _holderAt(last, next);
            _setSeat(i, moved);
        }
        _setCount(last);
        seatsOf[msg.sender] -= 1;
        Leaving storage l = leaving[msg.sender];
        l.amount += uint192(SEAT);
        l.until = uint64(block.timestamp + EXIT_DELAY);
        emit Left(msg.sender, i, moved, next, l.until);
    }

    /// @notice Sends the caller the TAC of the seats it left, once EXIT_DELAY has passed since it left the last.
    function claim() external {
        Leaving memory l = leaving[msg.sender];
        if (l.amount == 0) revert Nothing();
        if (block.timestamp < l.until) revert TooSoon();
        delete leaving[msg.sender];
        _call(abi.encodeWithSelector(0xa9059cbb, msg.sender, uint256(l.amount)));
        emit Claimed(msg.sender, l.amount);
    }

    /// @notice Says where the caller, a seat holder, takes spends.
    function announce(string calldata url) external {
        if (seatsOf[msg.sender] == 0) revert NotYours();
        emit Endpoint(msg.sender, url);
    }

    /// @notice Who leads now, keeping this epoch's seed if no one has yet. Anyone may call it; landing does.
    function turn() external returns (address) {
        uint256 e = epoch();
        // with no seat in the draw BOOTSTRAP leads and no seed is needed
        // from the epoch's second block: the first one's randomness is its parent's reveal, which that parent's proposer knows while
        // it can still take or leave seats for this epoch
        uint256 at = block.number - e * SLOT_BLOCKS * EPOCH_SLOTS;
        if (seedOf[e] == 0 && _countAt(e) != 0 && at != 0 && at <= SEED_BLOCKS) {
            bytes32 s = keccak256(abi.encode(block.prevrandao, e));
            seedOf[e] = s == 0 ? bytes32(uint256(1)) : s;
        }
        return leader();
    }

    /// @notice Who leads now: zero while this epoch's seed is not kept (and for good once its first SEED_BLOCKS have passed).
    function leader() public view returns (address) {
        return leaderAt(block.number);
    }

    /// @notice Who leads at block `b` of an epoch, as the seats stand: zero while that epoch's seed is not kept.
    function leaderAt(uint256 b) public view returns (address) {
        uint256 e = b / (SLOT_BLOCKS * EPOCH_SLOTS);
        uint256 n = _countAt(e);
        if (n == 0) return BOOTSTRAP;
        bytes32 s = seedAt(e);
        if (s == 0) return address(0);
        return _holderAt(uint256(keccak256(abi.encode(s, b / SLOT_BLOCKS))) % n, e);
    }

    /// @notice Epoch `e`'s seed: the one kept, else zero.
    function seedAt(uint256 e) public view returns (bytes32) {
        return seedOf[e];
    }

    function epoch() public view returns (uint256) {
        return block.number / (SLOT_BLOCKS * EPOCH_SLOTS);
    }

    /// @notice How many seats this epoch draws from.
    function seats() external view returns (uint256) {
        return _countAt(epoch());
    }

    /// @notice Who holds seat `i` in this epoch's draw (or, with `next`, the next epoch's).
    function seatAt(uint256 i, bool next) external view returns (address) {
        return _holderAt(i, epoch() + (next ? 1 : 0));
    }

    function _holderAt(uint256 i, uint256 e) internal view returns (address) {
        Seat storage s = seat[i];
        return s.nextFrom != 0 && s.nextFrom <= e ? s.next : s.holder;
    }

    function _countAt(uint256 e) internal view returns (uint256) {
        return countNextFrom != 0 && countNextFrom <= e ? countNext : count;
    }

    /// @dev Seat `i`'s holder from the next epoch on (the version in force now becomes the current one first).
    function _setSeat(uint256 i, address who) internal {
        uint64 next = uint64(epoch() + 1);
        Seat storage s = seat[i];
        if (s.nextFrom != 0 && s.nextFrom < next) s.holder = s.next;
        s.next = who;
        s.nextFrom = next;
    }

    function _setCount(uint256 n) internal {
        uint64 next = uint64(epoch() + 1);
        if (countNextFrom != 0 && countNextFrom < next) count = countNext;
        countNext = uint64(n);
        countNextFrom = next;
    }

    /// @dev A TAC call that must succeed and return true or nothing.
    function _call(bytes memory data) internal {
        (bool ok, bytes memory ret) = address(TAC).call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
