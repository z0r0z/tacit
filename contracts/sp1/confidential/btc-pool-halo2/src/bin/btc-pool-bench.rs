//! Native benchmarks: rows/k, columns, proof size, keygen, prove (current rayon pool), verify, key sizes.
//! RAYON_NUM_THREADS=1 for single-thread numbers.

use btc_pool_halo2::{fixture::Fixture, *};
use halo2_proofs::{dev::CircuitCost, halo2curves::bn256::G1, plonk::ConstraintSystem, SerdeFormat};
use std::time::Instant;

fn main() {
    let runs: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(5);
    let threads = rayon::current_num_threads();
    let t = Instant::now();
    let params = srs::load_or_convert(None).expect("params");
    let t_params = t.elapsed();
    let t = Instant::now();
    let pk = keygen(&params).unwrap();
    let t_keygen = t.elapsed();
    let vk = pk.get_vk();

    let mut cs = ConstraintSystem::default();
    let _ = <SpendCircuit as halo2_proofs::plonk::Circuit<_>>::configure(&mut cs);
    let f = Fixture::new();
    let w = f.pay();
    let cost = CircuitCost::<G1, SpendCircuit>::measure(K, &SpendCircuit { w: Some(w.clone()) });
    let proof_size: usize = cost.proof_size(1).into();

    let mut times = vec![];
    let mut proof = vec![];
    for _ in 0..runs {
        let t = Instant::now();
        proof = prove(&params, &pk, &w).unwrap();
        times.push(t.elapsed().as_secs_f64());
    }
    let t = Instant::now();
    let n_ver = 20;
    for _ in 0..n_ver {
        assert!(verify(&params, vk, &w.publics(), &proof));
    }
    let t_verify = t.elapsed().as_secs_f64() / n_ver as f64;

    let params_bytes = srs::write_params(&params).len();
    let pk_bytes = pk.to_bytes(SerdeFormat::RawBytes).len();
    let vk_len = vk_bytes(vk).len();
    let mut ts = times.clone();
    ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("k = {K} (2^{K} = {} rows), degree {}, advice {}, fixed {}, selectors {}, lookups {}, equality columns {}",
        1u64 << K, cs.degree(), cs.num_advice_columns(), cs.num_fixed_columns(), cs.num_selectors(), cs.lookups().len(), cs.permutation().get_columns().len());
    println!("minimum rows (blinding) {}", cs.minimum_rows());
    let vcs = vk.cs();
    println!(
        "after selector compression: fixed {}, queries advice {} fixed {} instance {}",
        vcs.num_fixed_columns(),
        vcs.advice_queries().len(),
        vcs.fixed_queries().len(),
        vcs.instance_queries().len()
    );
    println!("proof {} B (CircuitCost estimate {} B)", proof.len(), proof_size);
    println!("threads {threads}: prove min {:.3} s, median {:.3} s over {runs} ({})", ts[0], ts[ts.len() / 2], times.iter().map(|x| format!("{x:.2}")).collect::<Vec<_>>().join(" / "));
    println!("verify {:.2} ms", t_verify * 1e3);
    println!("params load {:.2} s, keygen (vk + pk) {:.2} s", t_params.as_secs_f64(), t_keygen.as_secs_f64());
    println!("params {} B (compressed points), pk {} B (RawBytes), vk {} B, vk digest {}", params_bytes, pk_bytes, vk_len, vk_digest(vk));
}
