// Poseidon over BN254 (circomlib parameters) for the shielded pools: Merkle nodes (2), nullifiers (3), note keys
// and leaves (4), EdDSA challenges (5), and the EVM pool's spend message (7); the mixer pool's nullifier hash (1).
// Its round constants are ~600 KB, so they live in this bundle, loaded only by the code that hashes, and the main
// vendor bundle every page loads first stays small.
export { poseidon1, poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
