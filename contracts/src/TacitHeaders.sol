// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice The Tacit chain's headers on Ethereum. Anyone may append the next one: it commits the pool's note tree (root and count), the
///         reflection the pool holds (Bitcoin's tacit state taken in, ending at that digest) and the light relay's Bitcoin tip, chained to
///         the header before it and to the Ethereum block it went on in. A header goes on only when one of those has moved, and at most
///         one per Ethereum block. It reads the pool's and the relay's public getters and writes nothing but its own storage, so it can
///         change neither; what it adds is one ordered, hash-chained record of the cross-chain pool's state that a contract can read here,
///         and that anyone elsewhere (the Bitcoin side through an eth-state proof of this contract's storage) can check with one storage
///         proof.
interface IPoolView {
    function currentRoot() external view returns (bytes32);
    function nextLeafIndex() external view returns (uint256);
    function attestedReflectionDigest() external view returns (bytes32);
}

interface IRelayView {
    function tip() external view returns (bytes32);
    function tipHeight() external view returns (uint256);
}

contract TacitHeaders {
    IPoolView public immutable POOL;
    IRelayView public immutable RELAY;

    /// @notice The header at each height, 0 first.
    mapping(uint256 => bytes32) public headerAt;
    /// @notice The newest header (zero before the first) and how many there are.
    bytes32 public head;
    uint256 public height;
    /// @dev What the newest header committed, so a header with nothing new is refused, and the Ethereum block it went on in.
    bytes32 internal lastState;
    uint256 internal lastBlock;

    event Header(
        uint256 indexed height,
        bytes32 indexed header,
        bytes32 prev,
        bytes32 noteRoot,
        uint256 notes,
        bytes32 reflection,
        uint256 btcHeight,
        bytes32 btcTip,
        address indexed by
    );

    error Unchanged();
    error SameBlock();

    constructor(IPoolView pool, IRelayView relay) {
        POOL = pool;
        RELAY = relay;
    }

    /// @notice Append the next header:
    ///         keccak256(abi.encode(prev, height, block.number, blockhash(block.number - 1), noteRoot, notes, reflection, btcHeight, btcTip)).
    function append() external returns (bytes32 header) {
        if (block.number == lastBlock) revert SameBlock();
        bytes32 noteRoot = POOL.currentRoot();
        uint256 notes = POOL.nextLeafIndex();
        bytes32 reflection = POOL.attestedReflectionDigest();
        bytes32 btcTip = RELAY.tip();
        uint256 btcHeight = RELAY.tipHeight();
        bytes32 state = keccak256(abi.encode(noteRoot, notes, reflection, btcHeight, btcTip));
        if (state == lastState) revert Unchanged();
        uint256 h = height;
        bytes32 prev = head;
        header = keccak256(abi.encode(prev, h, block.number, blockhash(block.number - 1), noteRoot, notes, reflection, btcHeight, btcTip));
        headerAt[h] = header;
        head = header;
        height = h + 1;
        lastState = state;
        lastBlock = block.number;
        emit Header(h, header, prev, noteRoot, notes, reflection, btcHeight, btcTip, msg.sender);
    }
}
