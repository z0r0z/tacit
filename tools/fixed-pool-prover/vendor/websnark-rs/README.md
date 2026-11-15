# websnark-rs

websnark-rs is a Websnark-compatible Rust library for generating and verifying zk-SNARK proofs from artifacts produced by the Circom v1 compiler.

## Examples

```rust
use std::collections::HashMap;
use ark_bn254::Fr;
use ark_ff::AdditiveGroup;
use websnark_rs::circuit::{Circuit, Value};
use websnark_rs::proof::prove;
use websnark_rs::proving_key::ProvingKey;

let circuit_json = include_str!("src/testdata/withdraw.json");
let proving_key_json = include_str!("src/testdata/withdraw_proving_key.json");
let inputs_json = include_str!("src/testdata/withdraw_input_signals.json");

let circuit: Circuit = serde_json::from_str(circuit_json).unwrap();
let pk: ProvingKey = serde_json::from_str(proving_key_json).unwrap();
let inputs: HashMap<String, Value> = serde_json::from_str(inputs_json).unwrap();

let witness = circuit.witness(inputs).unwrap();
let (proof, pub_signals) = prove(&pk, &witness, Fr::ZERO, Fr::ZERO).unwrap();
```

## How it works

Circom V1 produces JSON artifacts for the circuit, proving key, and verification key. Unlike Circom V2, these circuit artifacts include JS code for witness generation that needs to be `eval`ed in JS at runtime. websnark-rs includes a Rust interpreter for this JS code, allowing it to generate witnesses directly without needing to run a separate process or embed a JS engine.

Compared to snarkjs, websnark-rs is significantly faster for both witness and proof generation. The below benchmarks were run against the tornadocash withdraw circuit on a Ryzen 5 3600 CPU.

## Benchmarks

| library                                        | witness generation | proof generation |
| ---------------------------------------------- | ------------------ | ---------------- |
| websnark-rs (native)                           | 120 ms             | 1200 ms          |
| websnark-rs (native +parallel)                 | 120 ms             | 300 ms           |
| websnark-rs (wasm32-unknown-unknown)           | 180 ms             | 4600 ms          |
| websnark-rs (wasm32-unknown-unknown +parallel) | 180 ms             | 1500 ms          |
| snarkjs 0.1.20 (nodejs 14)                     | 620 ms             | 3500 ms          |

## Features
 - `parallel`: Enables parallel proof generation using Rayon.

## Wasm support
websnark-rs can be compiled to WASM for use in web applications. 

The `parallel` feature is supported in WASM using [`wasm-bindgen-rayon`](https://github.com/RReverser/wasm-bindgen-rayon). When enabled, proof generation will be parallelized across multiple web workers. See the `wasm-bindgen-rayon` documentation for setup details.
