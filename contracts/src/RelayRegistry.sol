// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/// The relays a wallet may use for the EVM pool's proofs, each bound to a locked stake of one token (TAC).
///
/// The pool pays only the relayer a proof names, so who relays is whoever the wallet names. A wallet reads this list, asks each listed relay
/// for a quote, drops the ones priced well above the rest, and draws among the others by stake: more stake, better odds, never a better
/// price. The registry holds nothing but those stakes. It has no fee, no slashing (nothing a relay does wrong can be shown on chain) and no
/// say over who is listed: anyone whose stake is at least `minStake` is, and leaves by exiting.
///
/// An entry is made by the relayer's own key (`msg.sender`), so no one can list an address that is not theirs; a separate `owner` holds the
/// stake and receives it back, so the relay's hot key never has to hold or withdraw it. One entry for each relayer on each chain. The
/// listed `url` is the base of the relay's API, which the wallets and the private route recognise by its ending, `/evm-pool/keeper`.
///
/// Two numbers can change: `minStake` and `unstakeDelay`, by the `owner` of this contract (a DAO, or no one: with the zero address as owner
/// they are fixed for good). Each is held inside bounds fixed at deploy, and a change takes effect only after `PARAM_DELAY` (at least a day
/// when there is an owner), so anyone watching has that long to see it. The owner cannot list, remove, move or touch an entry or a stake. It can
/// raise the minimum, within its bound: an entry below the new minimum is then off the list until its owner tops it up, and its stake is
/// untouched. A change of `unstakeDelay` applies to exits begun after it, never to one already begun.
///
/// What the registry does not check: that the server at a `url` is the relay listed with it. That is shown to a wallet by the server's own quote,
/// which must name the listed `relayer`; two entries may share a URL, and only the one whose address the server names is ever used. Nor can an
/// entry's owner or relayer be changed: to move either, exit and register again. The `owner` must be an address that can call `startExit`
/// (this contract and the token are refused; a contract that cannot call it holds the stake for good). The token must be a plain ERC-20, as TAC
/// is: no fee on transfer, no rebasing, and no minter that burns a holder's balance without the holder's consent (TAC's pool burns only what its
/// caller holds). A transfer made straight to this contract belongs to no entry and stays here.
contract RelayRegistry is Ownable {
    using SafeTransferLib for address;

    /// One relay. `relayer` is zero for an entry that does not exist. `pos` is its place in its chain's list.
    struct Relay {
        address relayer;
        uint64 chainId;
        uint32 pos;
        address owner;
        uint64 exitAt;
        uint256 stake;
    }

    struct Pending {
        uint128 minStake;
        uint64 unstakeDelay;
        uint64 eta;
    }

    address public immutable TOKEN;
    uint256 public immutable MIN_STAKE_LO;
    uint256 public immutable MIN_STAKE_HI;
    uint256 public immutable DELAY_LO;
    uint256 public immutable DELAY_HI;
    uint256 public immutable PARAM_DELAY;
    uint256 internal constant MAX_PAGE = 100;
    uint256 internal constant MAX_SCAN = 500;
    uint256 internal constant MAX_URL = 128;

    uint256 public minStake;
    uint256 public unstakeDelay;
    Pending public pending;
    uint256 public count;

    mapping(uint256 id => Relay) public relays;
    mapping(uint256 id => string) internal _url;
    mapping(bytes32 key => uint256 id) public idOf;
    mapping(uint64 chainId => uint256[]) internal _byChain;

    event Registered(uint256 indexed id, uint64 indexed chainId, address indexed relayer, address owner, string url, uint256 stake);
    event StakeAdded(uint256 indexed id, address indexed from, uint256 amount, uint256 stake);
    event UrlChanged(uint256 indexed id, string url);
    event ExitStarted(uint256 indexed id, uint256 exitAt);
    event ExitFinished(uint256 indexed id, address indexed owner, uint256 stake);
    event ParamsQueued(uint256 minStake, uint256 unstakeDelay, uint256 eta);
    event ParamsCancelled();
    event ParamsApplied(uint256 minStake, uint256 unstakeDelay);

    error BadUrl();
    error BadChain();
    error BadOwner();
    error BelowMinimum();
    error AlreadyListed();
    error NoSuchRelay();
    error NotYours();
    error Exiting();
    error NotExiting();
    error TooEarly();
    error OutOfBounds();
    error NothingPending();
    error TokenTookAFee();

    /// @param admin Owner of the two parameters, or the zero address to fix them for good.
    constructor(
        address token,
        address admin,
        uint256 minStake_,
        uint256 unstakeDelay_,
        uint256 minStakeLo,
        uint256 minStakeHi,
        uint256 delayLo,
        uint256 delayHi,
        uint256 paramDelay
    ) {
        require(token.code.length != 0, "no token");
        require(minStakeLo != 0 && minStakeLo <= minStakeHi && minStakeHi <= type(uint128).max, "bad stake bounds");
        require(delayLo <= delayHi && delayHi <= type(uint64).max / 2, "bad delay bounds");
        require(admin == address(0) || (paramDelay >= 1 days && paramDelay <= 365 days), "bad change wait");
        require(minStake_ >= minStakeLo && minStake_ <= minStakeHi, "min stake outside bounds");
        require(unstakeDelay_ >= delayLo && unstakeDelay_ <= delayHi, "delay outside bounds");
        TOKEN = token;
        MIN_STAKE_LO = minStakeLo;
        MIN_STAKE_HI = minStakeHi;
        DELAY_LO = delayLo;
        DELAY_HI = delayHi;
        PARAM_DELAY = paramDelay;
        minStake = minStake_;
        unstakeDelay = unstakeDelay_;
        _initializeOwner(admin);
    }

    // ---- relays ----

    /// Lists the caller as a relay on `chainId`, at `url`, with `amount` of the token locked for `owner_`. The caller must have approved this contract.
    function register(uint64 chainId, string calldata url, address owner_, uint256 amount) external returns (uint256 id) {
        return _register(chainId, url, owner_, amount);
    }

    /// The same, with the approval given by a permit signed by the caller. A permit that was used already (taken from the mempool and sent first) leaves
    /// the allowance it gave, so the registration still goes through.
    function registerWithPermit(
        uint64 chainId,
        string calldata url,
        address owner_,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 id) {
        try IERC20Permit(TOKEN).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        return _register(chainId, url, owner_, amount);
    }

    function _register(uint64 chainId, string calldata url, address owner_, uint256 amount) private returns (uint256 id) {
        if (chainId == 0) revert BadChain();
        if (owner_ == address(0) || owner_ == address(this) || owner_ == TOKEN) revert BadOwner();
        if (amount < minStake) revert BelowMinimum();
        _checkUrl(url);
        bytes32 key = keccak256(abi.encode(chainId, msg.sender));
        if (idOf[key] != 0) revert AlreadyListed();

        id = ++count;
        idOf[key] = id;
        uint256[] storage list_ = _byChain[chainId];
        relays[id] = Relay({ relayer: msg.sender, chainId: chainId, pos: uint32(list_.length), owner: owner_, exitAt: 0, stake: amount });
        _url[id] = url;
        list_.push(id);
        emit Registered(id, chainId, msg.sender, owner_, url, amount);
        _pull(amount);
    }

    /// Adds `amount` from the caller to an entry's stake, whoever the caller is. The stake is the entry owner's.
    function topUp(uint256 id, uint256 amount) external {
        Relay storage r = _live(id);
        if (r.exitAt != 0) revert Exiting();
        uint256 stake = r.stake + amount;
        r.stake = stake;
        emit StakeAdded(id, msg.sender, amount, stake);
        _pull(amount);
    }

    /// Takes `amount` from the caller and checks that all of it arrived. A token that keeps a fee on a transfer would leave the registry holding less than
    /// the stakes it owes, and the last owner out would find the rest gone: TAC keeps none, and a token that does is refused here, not left to surprise someone.
    function _pull(uint256 amount) private {
        uint256 before = SafeTransferLib.balanceOf(TOKEN, address(this));
        TOKEN.safeTransferFrom(msg.sender, address(this), amount);
        if (SafeTransferLib.balanceOf(TOKEN, address(this)) - before != amount) revert TokenTookAFee();
    }

    /// Moves the relay to another host. Its owner or the relayer may.
    function setUrl(uint256 id, string calldata url) external {
        Relay storage r = _live(id);
        if (msg.sender != r.owner && msg.sender != r.relayer) revert NotYours();
        _checkUrl(url);
        _url[id] = url;
        emit UrlChanged(id, url);
    }

    /// Takes the entry off the list at once and starts the wait for its stake. Only the entry's owner.
    function startExit(uint256 id) external {
        Relay storage r = _live(id);
        if (msg.sender != r.owner) revert NotYours();
        if (r.exitAt != 0) revert Exiting();
        uint64 when_ = uint64(block.timestamp + unstakeDelay);
        r.exitAt = when_;
        emit ExitStarted(id, when_);
    }

    /// Pays the stake to the entry's owner once the wait is over, and removes the entry. Anyone may call it.
    function finishExit(uint256 id) external {
        Relay storage r = _live(id);
        uint64 when_ = r.exitAt;
        if (when_ == 0) revert NotExiting();
        if (block.timestamp < when_) revert TooEarly();
        address owner_ = r.owner;
        uint256 stake = r.stake;
        uint64 chainId = r.chainId;

        // out of its chain's list: the last entry takes its place, so the list never holds a gap
        uint256[] storage list_ = _byChain[chainId];
        uint256 last = list_[list_.length - 1];
        uint32 pos = r.pos;
        if (last != id) {
            list_[pos] = last;
            relays[last].pos = pos;
        }
        list_.pop();
        delete idOf[keccak256(abi.encode(chainId, r.relayer))];
        delete relays[id];
        delete _url[id];

        emit ExitFinished(id, owner_, stake);
        TOKEN.safeTransfer(owner_, stake);
    }

    function _live(uint256 id) private view returns (Relay storage r) {
        r = relays[id];
        if (r.relayer == address(0)) revert NoSuchRelay();
    }

    /// `https://` + host (letters, digits, `.`, `-`, `_`, `:`, `/`) ending `/evm-pool/keeper`, at most 128 bytes: what a wallet and the private route take
    /// for a relay's base URL, with no credentials, query or fragment.
    /// A url is `https://` and a host that starts with a letter or a digit, then letters, digits and `-._:/`, ending `/evm-pool/keeper`. Which hosts a wallet
    /// will call is the wallet's rule (a public name on a real origin), not this one: it drops an address, `localhost` or a local name whatever is listed.
    function _checkUrl(string calldata url) private pure {
        bytes calldata b = bytes(url);
        uint256 n = b.length;
        if (n < 25 || n > MAX_URL) revert BadUrl();
        if (bytes8(b[:8]) != "https://" || bytes16(b[n - 16:]) != "/evm-pool/keeper") revert BadUrl();
        uint8 h = uint8(b[8]);
        if (!((h >= 48 && h <= 57) || (h >= 65 && h <= 90) || (h >= 97 && h <= 122))) revert BadUrl();
        for (uint256 i = 8; i < n; ++i) {
            uint8 c = uint8(b[i]);
            bool ok = (c >= 48 && c <= 58) /* 0-9 and : */ || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 45 || c == 46 || c == 47 || c == 95;
            if (!ok) revert BadUrl();
        }
    }

    // ---- reading ----

    /// The relays listed on `chainId` from place `start` in its list: those with a stake of at least `minStake` and no exit begun, at most `max`
    /// (a `max` of zero, or more than 100, is 100), looking at no more than 500 places in one call, so a long run of entries that are not listed
    /// cannot make a call run out of gas. `next` is where to read on from, equal to the list's length when nothing is left: a reader goes on from
    /// `next` until it reaches the length, even through a call that found none. A relay's place can change when another leaves, so a reader that
    /// pages over several calls may see one twice or miss one: it reads again when it matters.
    function list(uint64 chainId, uint256 start, uint256 max)
        external
        view
        returns (address[] memory relayers, uint256[] memory stakes, string[] memory urls, uint256 next)
    {
        if (max == 0 || max > MAX_PAGE) max = MAX_PAGE;
        uint256[] storage ids = _byChain[chainId];
        uint256 len = ids.length;
        uint256 i = start > len ? len : start;
        uint256 end = len - i > MAX_SCAN ? i + MAX_SCAN : len;
        relayers = new address[](max);
        stakes = new uint256[](max);
        urls = new string[](max);
        uint256 found;
        uint256 min = minStake;
        for (; i < end && found < max; ++i) {
            uint256 id = ids[i];
            Relay storage r = relays[id];
            if (r.exitAt != 0 || r.stake < min) continue;
            relayers[found] = r.relayer;
            stakes[found] = r.stake;
            urls[found] = _url[id];
            ++found;
        }
        next = i;
        assembly ("memory-safe") {
            mstore(relayers, found)
            mstore(stakes, found)
            mstore(urls, found)
        }
    }

    /// The entries on `chainId`, listed or not.
    function lengthOf(uint64 chainId) external view returns (uint256) {
        return _byChain[chainId].length;
    }

    /// The entry at place `pos` of `chainId`'s list.
    function idAt(uint64 chainId, uint256 pos) external view returns (uint256) {
        return _byChain[chainId][pos];
    }

    function urlOf(uint256 id) external view returns (string memory) {
        return _url[id];
    }

    // ---- the two parameters ----

    /// Proposes a new minimum stake and unstake delay, each inside the bounds fixed at deploy. They take effect `PARAM_DELAY` from now, by `applyParams`.
    function queueParams(uint256 newMinStake, uint256 newUnstakeDelay) external onlyOwner {
        if (newMinStake < MIN_STAKE_LO || newMinStake > MIN_STAKE_HI || newUnstakeDelay < DELAY_LO || newUnstakeDelay > DELAY_HI) revert OutOfBounds();
        uint64 eta = uint64(block.timestamp + PARAM_DELAY);
        pending = Pending({ minStake: uint128(newMinStake), unstakeDelay: uint64(newUnstakeDelay), eta: eta });
        emit ParamsQueued(newMinStake, newUnstakeDelay, eta);
    }

    function cancelParams() external onlyOwner {
        if (pending.eta == 0) revert NothingPending();
        delete pending;
        emit ParamsCancelled();
    }

    /// Giving up the ownership fixes the two numbers for good, so a change still waiting goes with it: it could not be cancelled afterwards.
    function renounceOwnership() public payable override onlyOwner {
        if (pending.eta != 0) {
            delete pending;
            emit ParamsCancelled();
        }
        super.renounceOwnership();
    }

    /// Makes a queued change effective once its time has come. Anyone may call it.
    function applyParams() external {
        Pending memory p = pending;
        if (p.eta == 0) revert NothingPending();
        if (block.timestamp < p.eta) revert TooEarly();
        minStake = p.minStake;
        unstakeDelay = p.unstakeDelay;
        delete pending;
        emit ParamsApplied(p.minStake, p.unstakeDelay);
    }
}
