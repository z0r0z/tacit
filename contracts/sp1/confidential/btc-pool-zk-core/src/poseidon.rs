//! circomlib Poseidon over BN254 Fr (x^5, 8 full rounds, partial rounds per t), matching circomlibjs
//! `poseidon_reference` and circomlib `poseidon.circom`. Inputs 2..=5 (t = 3..=6).

use crate::poseidon_constants::*;
use bn::Fr;
use std::sync::OnceLock;

struct Params {
    c: Vec<Fr>,
    m: Vec<Vec<Fr>>,
    partial: usize,
}

fn fr_hex(h: &str) -> Fr {
    let mut b = [0u8; 32];
    for i in 0..32 {
        b[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).expect("hex");
    }
    Fr::from_slice(&b).expect("canonical constant")
}

fn build<const T: usize>(c: &[&str], m: &[[&str; T]; T], partial: usize) -> Params {
    Params {
        c: c.iter().map(|h| fr_hex(h)).collect(),
        m: m.iter().map(|row| row.iter().map(|h| fr_hex(h)).collect()).collect(),
        partial,
    }
}

fn params(t: usize) -> &'static Params {
    static P3: OnceLock<Params> = OnceLock::new();
    static P4: OnceLock<Params> = OnceLock::new();
    static P5: OnceLock<Params> = OnceLock::new();
    static P6: OnceLock<Params> = OnceLock::new();
    match t {
        3 => P3.get_or_init(|| build(&C3, &M3, 57)),
        4 => P4.get_or_init(|| build(&C4, &M4, 56)),
        5 => P5.get_or_init(|| build(&C5, &M5, 60)),
        6 => P6.get_or_init(|| build(&C6, &M6, 60)),
        _ => panic!("poseidon: unsupported width"),
    }
}

#[inline]
fn pow5(a: Fr) -> Fr {
    let a2 = a * a;
    let a4 = a2 * a2;
    a4 * a
}

/// Poseidon(inputs), 2 ≤ inputs.len() ≤ 5.
pub fn poseidon(inputs: &[Fr]) -> Fr {
    let t = inputs.len() + 1;
    let p = params(t);
    let mut s: Vec<Fr> = Vec::with_capacity(t);
    s.push(Fr::zero());
    s.extend_from_slice(inputs);
    let rounds = 8 + p.partial;
    for r in 0..rounds {
        for i in 0..t {
            s[i] = s[i] + p.c[r * t + i];
        }
        if r < 4 || r >= 4 + p.partial {
            for x in s.iter_mut() {
                *x = pow5(*x);
            }
        } else {
            s[0] = pow5(s[0]);
        }
        let mut n = vec![Fr::zero(); t];
        for i in 0..t {
            let mut acc = Fr::zero();
            for j in 0..t {
                acc = acc + p.m[i][j] * s[j];
            }
            n[i] = acc;
        }
        s = n;
    }
    s[0]
}
