// Vendor bundle entry for the mixer feature — separated from the main
// tacit-deps.min.js so users who never visit the Mixer tab don't pay
// snarkjs's ~800 KB minified cost. tacit.js loads this lazily via dynamic
// import inside `verifyMixerProof` (and the broadcast prove path, when wired).
//
// Re-exports just what the dApp uses:
//   - groth16.verify  (proof verification at validator time)
//   - groth16.fullProve (sample/dev; production prove path runs in a worker)
export * as snarkjs from 'snarkjs';
