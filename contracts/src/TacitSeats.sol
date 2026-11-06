// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface IERC20Seats {
    function balanceOf(address who) external view returns (uint256);
}

/// @notice Whose turn it is to land the next Tacit block. A seat is SEAT of TAC locked here; the seats take turns of
///         SLOT seconds in order (seat (now / SLOT) mod the number of seats), and with no seats BOOTSTRAP leads. A
///         holder may take as many seats as it locks TAC for.
///
///         Nothing here has an owner: no one can take a seat away, change the terms or move a stake. A seat is left
///         only by its holder, whose TAC comes back EXIT_DELAY later, so a stake cannot take turns and leave at once.
///         Turns follow the seat list, so they shift whenever a seat is taken or left.
///
///         A turn only says who proves the next block. A leader that lands nothing holds the chain back until the
///         landing contract lets anyone land (its WINDOW after the last landing), and one that leaves a spend out
///         cannot keep it out (the landing contract's queue).
contract TacitSeats {
    IERC20Seats public immutable TAC;
    /// @notice The TAC one seat locks.
    uint256 public immutable SEAT;
    /// @notice How long each turn lasts.
    uint256 public immutable SLOT;
    /// @notice Who leads while no one holds a seat.
    address public immutable BOOTSTRAP;
    uint256 public constant EXIT_DELAY = 7 days;
    uint256 public constant MIN_SLOT = 1 minutes;
    uint256 public constant MAX_SLOT = 1 hours;

    address[] internal held;
    /// @notice How many seats each holder has.
    mapping(address => uint256) public seatsOf;
    struct Leaving {
        uint192 amount;
        uint64 until;
    }
    /// @notice TAC of seats left and not yet claimed, and when it may be (the latest seat left sets it).
    mapping(address => Leaving) public leaving;

    event Joined(address indexed who, uint256 seat);
    /// @notice `who` left `seat`; the last seat, held by `moved`, took its place (`moved` is zero when the last seat
    ///         was the one left).
    event Left(address indexed who, uint256 seat, address moved, uint256 until);
    event Claimed(address indexed who, uint256 amount);
    /// @notice Where `who` takes spends for the blocks it lands: whatever it says, for wallets to find it.
    event Endpoint(address indexed who, string url);

    error BadTerms();
    error NotYours();
    error TooSoon();
    error Nothing();
    error TransferFailed();

    constructor(IERC20Seats tac, uint256 seat, uint256 slot, address bootstrap) {
        if (address(tac).code.length == 0 || seat == 0 || seat > type(uint192).max / 2 ** 32) revert BadTerms();
        if (slot < MIN_SLOT || slot > MAX_SLOT) revert BadTerms();
        TAC = tac;
        SEAT = seat;
        SLOT = slot;
        BOOTSTRAP = bootstrap;
    }

    /// @notice Locks SEAT of TAC (approved to this contract) for one more seat.
    function join() external returns (uint256 seat) {
        uint256 before = TAC.balanceOf(address(this));
        _call(abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), SEAT));
        if (TAC.balanceOf(address(this)) - before != SEAT) revert TransferFailed();
        seat = held.length;
        held.push(msg.sender);
        seatsOf[msg.sender] += 1;
        emit Joined(msg.sender, seat);
    }

    /// @notice Gives up seat `seat`, which the caller holds; its TAC may be claimed EXIT_DELAY from now.
    function leave(uint256 seat) external {
        if (seat >= held.length || held[seat] != msg.sender) revert NotYours();
        uint256 last = held.length - 1;
        address moved;
        if (seat != last) {
            moved = held[last];
            held[seat] = moved;
        }
        held.pop();
        seatsOf[msg.sender] -= 1;
        Leaving storage l = leaving[msg.sender];
        l.amount += uint192(SEAT);
        l.until = uint64(block.timestamp + EXIT_DELAY);
        emit Left(msg.sender, seat, moved, l.until);
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

    /// @notice Says where the caller takes spends.
    function announce(string calldata url) external {
        emit Endpoint(msg.sender, url);
    }

    /// @notice Who leads now: the landing contract lets only it land until the chain has gone WINDOW without a block.
    function leader() external view returns (address) {
        return leaderAt(block.timestamp);
    }

    /// @notice Who leads at time `t` if the seats stay as they are.
    function leaderAt(uint256 t) public view returns (address) {
        uint256 n = held.length;
        return n == 0 ? BOOTSTRAP : held[(t / SLOT) % n];
    }

    function seats() external view returns (uint256) {
        return held.length;
    }

    function seatAt(uint256 seat) external view returns (address) {
        return held[seat];
    }

    /// @dev A TAC call that must succeed and return true or nothing.
    function _call(bytes memory data) internal {
        (bool ok, bytes memory ret) = address(TAC).call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
