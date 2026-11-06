//! The custom gates' polynomials as one flat program in which every distinct subexpression is computed once.
//! A verifying key builds it on first use; the verifier then evaluates it at x for each proof instead of
//! walking every expression tree, where the same terms (a Poseidon S-box under several outputs, a point's
//! coordinates under several constraints) recur.

use super::circuit::{Expression, Gate};
use ff::PrimeField;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Clone, Debug)]
enum Op<F> {
    Constant(F),
    Fixed(usize),
    Advice(usize),
    Instance(usize),
    Challenge(usize),
    Negated(usize),
    Sum(usize, usize),
    Product(usize, usize),
    Scaled(usize, F),
}

/// An `Op` by what it computes: constants by their canonical bytes, operands by node, sums and products with
/// the smaller node first (both commute).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Key {
    Constant([u8; 32]),
    Fixed(usize),
    Advice(usize),
    Instance(usize),
    Challenge(usize),
    Negated(usize),
    Sum(usize, usize),
    Product(usize, usize),
    Scaled(usize, [u8; 32]),
}

/// FNV-1a over the key's bytes: the default keyed hasher is costly in the zkVM and the keys need no secrecy.
#[derive(Default)]
struct Fnv(u64);

impl Hasher for Fnv {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        let mut h = if self.0 == 0 { 0xcbf29ce484222325 } else { self.0 };
        for b in bytes {
            h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
        }
        self.0 = h;
    }
}

type Seen = HashMap<Key, usize, BuildHasherDefault<Fnv>>;

/// A field element's canonical bytes, at most 32 (the scalar fields this verifier runs on).
fn bytes32<F: PrimeField>(f: &F) -> [u8; 32] {
    let r = f.to_repr();
    let mut b = [0u8; 32];
    b[..r.as_ref().len()].copy_from_slice(r.as_ref());
    b
}

/// Nodes in evaluation order (every operand before its use) and, for each gate polynomial in gate order, the
/// node holding its value.
#[derive(Clone, Debug)]
pub(crate) struct GateProgram<F> {
    ops: Vec<Op<F>>,
    outputs: Vec<usize>,
}

impl<F: PrimeField> GateProgram<F> {
    pub(crate) fn new(gates: &[Gate<F>]) -> Self {
        let mut p = GateProgram { ops: vec![], outputs: vec![] };
        let mut seen = Seen::default();
        for gate in gates {
            for poly in gate.polynomials() {
                let id = p.node(poly, &mut seen);
                p.outputs.push(id);
            }
        }
        p
    }

    fn push(&mut self, key: Key, op: Op<F>, seen: &mut Seen) -> usize {
        if let Some(&id) = seen.get(&key) {
            return id;
        }
        let id = self.ops.len();
        self.ops.push(op);
        seen.insert(key, id);
        id
    }

    fn node(&mut self, e: &Expression<F>, seen: &mut Seen) -> usize {
        match e {
            Expression::Constant(c) => self.push(Key::Constant(bytes32(c)), Op::Constant(*c), seen),
            Expression::Selector(_) => panic!("virtual selectors are removed during optimization"),
            Expression::Fixed(q) => {
                let i = q.index.unwrap();
                self.push(Key::Fixed(i), Op::Fixed(i), seen)
            }
            Expression::Advice(q) => {
                let i = q.index.unwrap();
                self.push(Key::Advice(i), Op::Advice(i), seen)
            }
            Expression::Instance(q) => {
                let i = q.index.unwrap();
                self.push(Key::Instance(i), Op::Instance(i), seen)
            }
            Expression::Challenge(c) => {
                let i = c.index();
                self.push(Key::Challenge(i), Op::Challenge(i), seen)
            }
            Expression::Negated(a) => {
                let a = self.node(a, seen);
                self.push(Key::Negated(a), Op::Negated(a), seen)
            }
            Expression::Sum(a, b) => {
                let (a, b) = (self.node(a, seen), self.node(b, seen));
                let (a, b) = (a.min(b), a.max(b));
                self.push(Key::Sum(a, b), Op::Sum(a, b), seen)
            }
            Expression::Product(a, b) => {
                let (a, b) = (self.node(a, seen), self.node(b, seen));
                let (a, b) = (a.min(b), a.max(b));
                self.push(Key::Product(a, b), Op::Product(a, b), seen)
            }
            Expression::Scaled(a, f) => {
                let a = self.node(a, seen);
                self.push(Key::Scaled(a, bytes32(f)), Op::Scaled(a, *f), seen)
            }
        }
    }

    /// Every gate polynomial's value from the proof's evaluations, in gate order.
    pub(crate) fn evaluate(&self, fixed: &[F], advice: &[F], instance: &[F], challenges: &[F]) -> Vec<F> {
        let mut v: Vec<F> = Vec::with_capacity(self.ops.len());
        for op in &self.ops {
            let x = match op {
                Op::Constant(c) => *c,
                Op::Fixed(i) => fixed[*i],
                Op::Advice(i) => advice[*i],
                Op::Instance(i) => instance[*i],
                Op::Challenge(i) => challenges[*i],
                Op::Negated(a) => -v[*a],
                Op::Sum(a, b) => v[*a] + v[*b],
                Op::Product(a, b) => v[*a] * v[*b],
                Op::Scaled(a, f) => v[*a] * *f,
            };
            v.push(x);
        }
        self.outputs.iter().map(|&o| v[o]).collect()
    }
}
