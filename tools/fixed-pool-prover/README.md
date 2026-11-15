# fixed-pool-prover

Proves a withdrawal from a fixed-denomination ETH pool in the browser. The page gives it the pool's commitments
in leaf order; it builds the tree (`new Tree(bytes)`, `tree.root()`), then `tree.prove(chainId, pool, preimageHex,
recipient)` returns the pool call for one note, with no relayer and no fee. The circuit and proving key come with
the pool crate (`kohaku-tornadocash` 0.2.0), inside the wasm, so nothing is fetched and no code is compiled at run
time.

`./build.sh` writes `dapp/vendor/fixed-pool-prover.js` and `dapp/vendor/fixed-pool-prover_bg.wasm`. Both are
checked in; rebuild only when this crate or its dependencies change.
