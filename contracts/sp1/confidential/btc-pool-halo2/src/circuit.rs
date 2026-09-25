//! spend.circom as a Halo2 circuit over BN254 Fr.
//!
//! Every chip shares one set of 12 advice columns (s0..s5, q0..q5) and 6 fixed columns (f0..f5), and the
//! regions stack vertically. Only s0..s2 take part in equality (one permutation product). Rotations:
//! s0, s1 {−2, −1, 0, 1}; s2 {−1, 0, 1}; s3..s5 {0, 1}; q0..q5 {0}. Public inputs are bound by a gate
//! (s0 of rows 0..12 equals the instance column), and the starting values of the bit decompositions and
//! the EC accumulators by gates, so there is no constants column.
//!
//!   Arith     a = s0, b = s1, c = s2; ql·a + qr·b + qo·c + qm·a·b + qc = 0 with (ql, qr, qo, qm, qc) in
//!             f0..f4. Range checks are MSB-first bit decompositions in (s0, s1): z_next = 2·z + b, b
//!             boolean, from z = 0 to z = x.
//!   Poseidon  one row per round; lanes s_j, squares q_j = (s_j + rc_j)², round constants f_j. A hash loads
//!             its inputs from the two rows above (s0..s2 of the row above, s0, s1 of the row before),
//!             and the output is s0 of the row after the last round.
//!   Merkle    both input paths in the same rows: path A in lanes s0..s2, path B in lanes s3..s5 (width 3
//!             each, shared round constants). The row between levels holds the running nodes (s4, s5),
//!             the index bits (s0, s1) and the siblings (q0, q1); the leaves enter and the roots leave
//!             through s0, s1.
//!   Ec        one BabyAdd per row (circomlib formula): x = s0, y = s1, z = s2, px = s3, py = s4,
//!             x2 = s5, y2 = q0, t = q1, b = q2; fixed-base tables in f0..f2. Fixed-base LSB-first,
//!             variable-base MSB-first, scalar accumulated in z. Second operands and bases load from the
//!             row above.
//!
//! Public inputs (instance column, rows 0..12): root, bodyHash, asset, nf[2], outLeaf[3], exitC[2], depC[2].

use crate::model::{self, Pt, SpendWitness, N_IN, N_OUT, TREE_DEPTH};
use ff::Field;
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, Region, SimpleFloorPlanner, Value},
    halo2curves::bn256::Fr,
    plonk::{Advice, Circuit, Column, ConstraintSystem, Constraints, Error, Expression, Fixed, Selector, VirtualCells},
    poly::Rotation,
};
use num_bigint::BigUint;
use std::sync::OnceLock;

pub type AC = AssignedCell<Fr, Fr>;

pub const K: u32 = 13;

fn c(x: Fr) -> Expression<Fr> {
    Expression::Constant(x)
}
fn cu(x: u64) -> Expression<Fr> {
    Expression::Constant(Fr::from(x))
}
fn bitv(x: Value<Fr>, i: usize) -> Value<Fr> {
    x.map(|v| if model::bit(&v, i) { Fr::ONE } else { Fr::ZERO })
}

thread_local! {
    static TAG: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}
/// Current region name; every region takes it, so constraint failures name the check.
fn tag() -> String {
    TAG.with(|t| t.borrow().clone())
}
fn set_tag(t: String) {
    TAG.with(|x| *x.borrow_mut() = t);
}

/// The shared columns.
#[derive(Clone, Copy, Debug)]
pub struct Cols {
    s: [Column<Advice>; 6],
    q: [Column<Advice>; 6],
    f: [Column<Fixed>; 6],
}

impl Cols {
    fn configure(meta: &mut ConstraintSystem<Fr>) -> Self {
        let s = [(); 6].map(|_| meta.advice_column());
        let q = [(); 6].map(|_| meta.advice_column());
        let f = [(); 6].map(|_| meta.fixed_column());
        for col in &s[..3] {
            meta.enable_equality(*col);
        }
        Cols { s, q, f }
    }
}

/// All selectors, allocated by gate degree (then by rows they share) so that halo2's greedy selector
/// compression packs them into few fixed columns.
#[derive(Clone, Copy, Debug)]
pub struct Sels {
    add: Selector,
    arith: Selector,
    full: [Selector; 3],
    part: [Selector; 3],
    pfull: Selector,
    ppart: Selector,
    plast: Selector,
    bits: Selector,
    mk: Selector,
    fix: Selector,
    var: Selector,
    load: Selector,
    ldp: Selector,
    dbl: Selector,
    ld2: Selector,
    vdbl: Selector,
    public: Selector,
    ecs: Selector,
    z0: Selector,
    mvin: Selector,
    mvout: Selector,
}

impl Sels {
    fn new(meta: &mut ConstraintSystem<Fr>) -> Self {
        let mut s = || meta.selector();
        Sels {
            add: s(),
            arith: s(),
            full: [s(), s(), s()],
            part: [s(), s(), s()],
            pfull: s(),
            ppart: s(),
            plast: s(),
            bits: s(),
            mk: s(),
            fix: s(),
            var: s(),
            load: s(),
            ldp: s(),
            dbl: s(),
            ld2: s(),
            vdbl: s(),
            public: s(),
            ecs: s(),
            z0: s(),
            mvin: s(),
            mvout: s(),
        }
    }
}

// ── Arith ──

#[derive(Clone, Debug)]
pub struct ArithConfig {
    a: Column<Advice>,
    b: Column<Advice>,
    c: Column<Advice>,
    q: [Column<Fixed>; 5], // ql, qr, qo, qm, qc
    q_arith: Selector,
    q_bits: Selector,
    q_z0: Selector,
}

impl ArithConfig {
    fn configure(meta: &mut ConstraintSystem<Fr>, cols: &Cols, sel: &Sels) -> Self {
        let (a, b, cc) = (cols.s[0], cols.s[1], cols.s[2]);
        let q = [cols.f[0], cols.f[1], cols.f[2], cols.f[3], cols.f[4]];
        let (q_arith, q_bits, q_z0) = (sel.arith, sel.bits, sel.z0);
        meta.create_gate("arith", |m| {
            let s = m.query_selector(q_arith);
            let (va, vb, vc) = (m.query_advice(a, Rotation::cur()), m.query_advice(b, Rotation::cur()), m.query_advice(cc, Rotation::cur()));
            let f = q.map(|x| m.query_fixed(x, Rotation::cur()));
            Constraints::with_selector(s, vec![f[0].clone() * va.clone() + f[1].clone() * vb.clone() + f[2].clone() * vc + f[3].clone() * va * vb + f[4].clone()])
        });
        meta.create_gate("bits", |m| {
            let s = m.query_selector(q_bits);
            let (z, bb, zn) = (m.query_advice(a, Rotation::cur()), m.query_advice(b, Rotation::cur()), m.query_advice(a, Rotation::next()));
            Constraints::with_selector(s, vec![bb.clone() * (cu(1) - bb.clone()), zn - (z * cu(2) + bb)])
        });
        meta.create_gate("bits start", |m| {
            let s = m.query_selector(q_z0);
            Constraints::with_selector(s, vec![m.query_advice(a, Rotation::cur())])
        });
        ArithConfig { a, b, c: cc, q, q_arith, q_bits, q_z0 }
    }
}

enum Op<'a> {
    Cell(&'a AC),
    Val(Value<Fr>),
    None,
}

pub struct Arith<'c> {
    cfg: &'c ArithConfig,
}

impl<'c> Arith<'c> {
    /// Names the regions that follow (surfaces in constraint failures).
    pub fn at(&self, t: impl Into<String>) {
        set_tag(t.into());
    }
    pub fn eq(&self, ly: &mut impl Layouter<Fr>, x: &AC, y: &AC) -> Result<(), Error> {
        ly.assign_region(tag, |mut r| r.constrain_equal(x.cell(), y.cell()))
    }

    /// One gate row; returns the three cells (unused slots hold 0).
    fn row(&self, ly: &mut impl Layouter<Fr>, ops: [Op; 3], coeff: [Fr; 5]) -> Result<[AC; 3], Error> {
        ly.assign_region(tag, |mut r| {
            self.cfg.q_arith.enable(&mut r, 0)?;
            let cols = [self.cfg.a, self.cfg.b, self.cfg.c];
            let mut out = Vec::with_capacity(3);
            for (i, op) in ops.iter().enumerate() {
                let cell = match op {
                    Op::Cell(x) => x.copy_advice(|| "", &mut r, cols[i], 0)?,
                    Op::Val(v) => r.assign_advice(|| "", cols[i], 0, || *v)?,
                    Op::None => r.assign_advice(|| "", cols[i], 0, || Value::known(Fr::ZERO))?,
                };
                out.push(cell);
            }
            for (i, q) in self.cfg.q.iter().enumerate() {
                r.assign_fixed(|| "", *q, 0, || Value::known(coeff[i]))?;
            }
            Ok([out[0].clone(), out[1].clone(), out[2].clone()])
        })
    }

    pub fn witness(&self, ly: &mut impl Layouter<Fr>, v: Value<Fr>) -> Result<AC, Error> {
        Ok(self.row(ly, [Op::Val(v), Op::None, Op::None], [Fr::ZERO; 5])?[0].clone())
    }
    /// ca·x + cb·y + k
    pub fn lin(&self, ly: &mut impl Layouter<Fr>, x: &AC, ca: Fr, y: Option<&AC>, cb: Fr, k: Fr) -> Result<AC, Error> {
        let yv = y.map(|y| y.value().copied()).unwrap_or(Value::known(Fr::ZERO));
        let v = x.value().copied().zip(yv).map(|(a, b)| ca * a + cb * b + k);
        let yop = match y {
            Some(y) => Op::Cell(y),
            None => Op::None,
        };
        Ok(self.row(ly, [Op::Cell(x), yop, Op::Val(v)], [ca, cb, -Fr::ONE, Fr::ZERO, k])?[2].clone())
    }
    pub fn add(&self, ly: &mut impl Layouter<Fr>, x: &AC, y: &AC) -> Result<AC, Error> {
        self.lin(ly, x, Fr::ONE, Some(y), Fr::ONE, Fr::ZERO)
    }
    pub fn sub(&self, ly: &mut impl Layouter<Fr>, x: &AC, y: &AC) -> Result<AC, Error> {
        self.lin(ly, x, Fr::ONE, Some(y), -Fr::ONE, Fr::ZERO)
    }
    pub fn mul(&self, ly: &mut impl Layouter<Fr>, x: &AC, y: &AC) -> Result<AC, Error> {
        let v = x.value().copied() * y.value().copied();
        Ok(self.row(ly, [Op::Cell(x), Op::Cell(y), Op::Val(v)], [Fr::ZERO, Fr::ZERO, -Fr::ONE, Fr::ONE, Fr::ZERO])?[2].clone())
    }
    /// x·y = 0
    pub fn assert_mul_zero(&self, ly: &mut impl Layouter<Fr>, x: &AC, y: &AC) -> Result<(), Error> {
        self.row(ly, [Op::Cell(x), Op::Cell(y), Op::None], [Fr::ZERO, Fr::ZERO, Fr::ZERO, Fr::ONE, Fr::ZERO])?;
        Ok(())
    }
    /// x·(1 − e) = 0
    pub fn assert_zero_unless(&self, ly: &mut impl Layouter<Fr>, x: &AC, e: &AC) -> Result<(), Error> {
        self.row(ly, [Op::Cell(x), Op::Cell(e), Op::None], [Fr::ONE, Fr::ZERO, Fr::ZERO, -Fr::ONE, Fr::ZERO])?;
        Ok(())
    }
    /// circomlib IsZero: out = 1 − x·inv, x·out = 0.
    pub fn is_zero(&self, ly: &mut impl Layouter<Fr>, x: &AC) -> Result<AC, Error> {
        let inv = x.value().map(|v| v.invert().unwrap_or(Fr::ZERO));
        let out = x.value().copied().zip(inv).map(|(v, i)| Fr::ONE - v * i);
        let r = self.row(ly, [Op::Cell(x), Op::Val(inv), Op::Val(out)], [Fr::ZERO, Fr::ZERO, Fr::ONE, Fr::ONE, -Fr::ONE])?;
        self.assert_mul_zero(ly, x, &r[2])?;
        Ok(r[2].clone())
    }
    /// 0 ≤ x < 2^n (n ≤ 253): z_0 = 0, z_{i+1} = 2·z_i + b_i, z_n = x.
    pub fn range(&self, ly: &mut impl Layouter<Fr>, x: &AC, n: usize, name: &str) -> Result<(), Error> {
        assert!(n <= 253);
        ly.assign_region(
            || format!("{name} range"),
            |mut r| {
                self.cfg.q_z0.enable(&mut r, 0)?;
                r.assign_advice(|| "z0", self.cfg.a, 0, || Value::known(Fr::ZERO))?;
                let mut z = Value::known(Fr::ZERO);
                for i in 0..n {
                    self.cfg.q_bits.enable(&mut r, i)?;
                    let b = bitv(x.value().copied(), n - 1 - i);
                    r.assign_advice(|| "b", self.cfg.b, i, || b)?;
                    z = z.zip(b).map(|(z, b)| z.double() + b);
                    let zc = r.assign_advice(|| "z", self.cfg.a, i + 1, || z)?;
                    if i == n - 1 {
                        r.constrain_equal(zc.cell(), x.cell())?;
                    }
                }
                Ok(())
            },
        )
    }
}

// ── Poseidon ──

/// Standalone hash widths (inputs + 1). The Merkle paths use width 3 in the paired layout.
const WIDTHS: [usize; 3] = [4, 5, 6];

#[derive(Clone, Debug)]
pub struct PoseidonConfig {
    cols: Cols,
    q_full: [Selector; 3],
    q_part: [Selector; 3],
    q_load: Selector,
    q_pfull: Selector,
    q_ppart: Selector,
    q_plast: Selector,
    q_mk: Selector,
    q_mvin: Selector,
    q_mvout: Selector,
}

/// x_j = s_j + rc for lane j, with the round constant of lane j mod w.
fn lanes(m: &mut VirtualCells<'_, Fr>, cols: &Cols, n: usize, w: usize) -> Vec<Expression<Fr>> {
    (0..n).map(|j| m.query_advice(cols.s[j], Rotation::cur()) + m.query_fixed(cols.f[j % w], Rotation::cur())).collect()
}

impl PoseidonConfig {
    fn configure(meta: &mut ConstraintSystem<Fr>, cols: &Cols, sel: &Sels) -> Self {
        let (q_full, q_part, q_load) = (sel.full, sel.part, sel.load);
        let (q_pfull, q_ppart, q_plast, q_mk, q_mvin, q_mvout) = (sel.pfull, sel.ppart, sel.plast, sel.mk, sel.mvin, sel.mvout);
        let cl = *cols;

        // One round over `groups` independent states of width t laid side by side. `sbox_all`: full round.
        // `out_lanes`: Some(dst) constrains only lane 0 of each group, into column s[dst[g]].
        let round = move |m: &mut VirtualCells<'_, Fr>, t: usize, groups: usize, sbox_all: bool, out_lanes: Option<&[usize]>| -> Vec<Expression<Fr>> {
            let x = lanes(m, &cl, t * groups, t);
            let mut cs = Vec::new();
            let mut sb = Vec::with_capacity(t * groups);
            for (j, xj) in x.iter().enumerate() {
                if sbox_all || j % t == 0 {
                    let sq = m.query_advice(cl.q[j], Rotation::cur());
                    cs.push(sq.clone() - xj.clone() * xj.clone());
                    sb.push(sq.clone() * sq * xj.clone());
                } else {
                    sb.push(xj.clone());
                }
            }
            for g in 0..groups {
                let rows: Vec<usize> = match out_lanes {
                    Some(_) => vec![0],
                    None => (0..t).collect(),
                };
                for i in rows {
                    let mut acc = c(Fr::ZERO);
                    for j in 0..t {
                        acc = acc + c(model::mds(t, i, j)) * sb[g * t + j].clone();
                    }
                    let dst = match out_lanes {
                        Some(d) => d[g],
                        None => g * t + i,
                    };
                    cs.push(m.query_advice(cl.s[dst], Rotation::next()) - acc);
                }
            }
            cs
        };

        for (wi, &t) in WIDTHS.iter().enumerate() {
            meta.create_gate("poseidon full", |m| {
                let q = m.query_selector(q_full[wi]);
                Constraints::with_selector(q, round(m, t, 1, true, None))
            });
            meta.create_gate("poseidon partial", |m| {
                let q = m.query_selector(q_part[wi]);
                Constraints::with_selector(q, round(m, t, 1, false, None))
            });
        }
        // every width: lanes 1..3 from s0..s2 of the row above, lanes 4, 5 from s0, s1 two rows above
        // (unused lanes and their input cells hold 0)
        meta.create_gate("poseidon load", |m| {
            let q = m.query_selector(q_load);
            let mut v = vec![m.query_advice(cl.s[0], Rotation::cur())];
            for j in 1..6 {
                let src = if j <= 3 { m.query_advice(cl.s[j - 1], Rotation::prev()) } else { m.query_advice(cl.s[j - 4], Rotation(-2)) };
                v.push(m.query_advice(cl.s[j], Rotation::cur()) - src);
            }
            Constraints::with_selector(q, v)
        });
        meta.create_gate("poseidon pair full", |m| {
            let q = m.query_selector(q_pfull);
            Constraints::with_selector(q, round(m, 3, 2, true, None))
        });
        meta.create_gate("poseidon pair partial", |m| {
            let q = m.query_selector(q_ppart);
            Constraints::with_selector(q, round(m, 3, 2, false, None))
        });
        meta.create_gate("poseidon pair last", |m| {
            let q = m.query_selector(q_plast);
            Constraints::with_selector(q, round(m, 3, 2, true, Some(&[4, 5])))
        });
        meta.create_gate("merkle level", |m| {
            let q = m.query_selector(q_mk);
            let cur = |m: &mut VirtualCells<'_, Fr>, col| m.query_advice(col, Rotation::cur());
            let (pa, pb, ba, bb, sa, sbb) = (cur(m, cl.s[4]), cur(m, cl.s[5]), cur(m, cl.s[0]), cur(m, cl.s[1]), cur(m, cl.q[0]), cur(m, cl.q[1]));
            let nx: Vec<_> = (0..6).map(|j| m.query_advice(cl.s[j], Rotation::next())).collect();
            Constraints::with_selector(
                q,
                vec![
                    ba.clone() * (cu(1) - ba.clone()),
                    bb.clone() * (cu(1) - bb.clone()),
                    nx[0].clone(),
                    nx[1].clone() - (pa.clone() + ba.clone() * (sa.clone() - pa.clone())),
                    nx[2].clone() - (sa.clone() + ba * (pa - sa)),
                    nx[3].clone(),
                    nx[4].clone() - (pb.clone() + bb.clone() * (sbb.clone() - pb.clone())),
                    nx[5].clone() - (sbb.clone() + bb * (pb - sbb)),
                ],
            )
        });
        // the running nodes live in s4, s5; the leaves enter from s0, s1 and the roots leave through them
        for (sel, from, to, rot) in [(q_mvin, [0, 1], [4, 5], 1), (q_mvout, [4, 5], [0, 1], 1)] {
            meta.create_gate("merkle move", |m| {
                let q = m.query_selector(sel);
                let v = (0..2).map(|i| m.query_advice(cl.s[to[i]], Rotation(rot)) - m.query_advice(cl.s[from[i]], Rotation::cur())).collect::<Vec<_>>();
                Constraints::with_selector(q, v)
            });
        }
        PoseidonConfig { cols: *cols, q_full, q_part, q_load, q_pfull, q_ppart, q_plast, q_mk, q_mvin, q_mvout }
    }

    fn rounds(t: usize) -> usize {
        model::FULL_ROUNDS + model::partial_rounds(t)
    }

    /// Rounds at rows off..off+R of `groups` width-t states side by side; the caller has assigned the lanes
    /// at `off`. `last`: the final round writes only lane 0 of each group, into s0, s1, ….
    fn permute(&self, r: &mut Region<'_, Fr>, off: usize, t: usize, init: Vec<Value<Fr>>, paired: bool) -> Result<Vec<AC>, Error> {
        let n = init.len();
        let groups = n / t;
        let wi = WIDTHS.iter().position(|&w| w == t);
        let mut st: Value<Vec<Fr>> = init.iter().fold(Value::known(Vec::with_capacity(n)), |acc, v| {
            acc.zip(*v).map(|(mut a, b)| {
                a.push(b);
                a
            })
        });
        let rounds = Self::rounds(t);
        for rd in 0..rounds {
            let row = off + rd;
            let full = model::is_full_round(t, rd);
            let sel = match (paired, full, rd + 1 == rounds) {
                (true, true, true) => self.q_plast,
                (true, true, false) => self.q_pfull,
                (true, false, _) => self.q_ppart,
                (false, true, _) => self.q_full[wi.expect("width")],
                (false, false, _) => self.q_part[wi.expect("width")],
            };
            sel.enable(r, row)?;
            for j in 0..t {
                let k = model::round_constant(t, rd, j);
                r.assign_fixed(|| "rc", self.cols.f[j], row, || Value::known(k))?;
            }
            for j in 0..n {
                let k = model::round_constant(t, rd, j % t);
                if rd > 0 {
                    r.assign_advice(|| "s", self.cols.s[j], row, || st.as_ref().map(|s| s[j]))?;
                }
                if full || j % t == 0 {
                    r.assign_advice(|| "sq", self.cols.q[j], row, || st.as_ref().map(|s| (s[j] + k).square()))?;
                }
            }
            st = st.map(|mut s| {
                for g in 0..groups {
                    model::poseidon_round(t, rd, &mut s[g * t..(g + 1) * t]);
                }
                s
            });
        }
        let row = off + rounds;
        if paired {
            (0..groups).map(|g| r.assign_advice(|| "out", self.cols.s[4 + g], row, || st.as_ref().map(|s| s[g * t]))).collect()
        } else {
            let out = r.assign_advice(|| "out", self.cols.s[0], row, || st.as_ref().map(|s| s[0]))?;
            for j in 1..t {
                r.assign_advice(|| "s out", self.cols.s[j], row, || st.as_ref().map(|s| s[j]))?;
            }
            Ok(vec![out])
        }
    }

    /// circomlib Poseidon(inputs), 3 ≤ inputs + 1 ≤ 6.
    pub fn hash(&self, ly: &mut impl Layouter<Fr>, inputs: &[&AC]) -> Result<AC, Error> {
        let t = inputs.len() + 1;
        assert!(WIDTHS.contains(&t));
        ly.assign_region(
            || format!("{} poseidon", tag()),
            |mut r| {
                // inputs 0..2 in s0..s2 of row 1, inputs 3, 4 in s0, s1 of row 0; round 0 at row 2
                let zero = Value::known(Fr::ZERO);
                for j in 0..5 {
                    let (col, row) = if j < 3 { (self.cols.s[j], 1) } else { (self.cols.s[j - 3], 0) };
                    match inputs.get(j) {
                        Some(x) => x.copy_advice(|| "in", &mut r, col, row)?,
                        None => r.assign_advice(|| "unused", col, row, || zero)?,
                    };
                }
                self.q_load.enable(&mut r, 2)?;
                let mut init = vec![zero];
                r.assign_advice(|| "cap", self.cols.s[0], 2, || zero)?;
                for j in 1..6 {
                    let v = inputs.get(j - 1).map(|x| x.value().copied()).unwrap_or(zero);
                    r.assign_advice(|| "lane", self.cols.s[j], 2, || v)?;
                    if j < t {
                        init.push(v);
                    }
                }
                Ok(self.permute(&mut r, 2, t, init, false)?.remove(0))
            },
        )
    }

    /// Both Poseidon(2) paths of fixed depth, side by side. Returns the two roots and the per-level index
    /// bits of each path.
    #[allow(clippy::type_complexity)]
    pub fn merkle2(&self, ly: &mut impl Layouter<Fr>, leaf: [&AC; 2], path: [&[Value<Fr>; TREE_DEPTH]; 2], bits: [&[Value<Fr>; TREE_DEPTH]; 2]) -> Result<([AC; 2], [Vec<AC>; 2]), Error> {
        ly.assign_region(
            || format!("{} merkle", tag()),
            |mut r| {
                let s = self.cols.s;
                // row 0: the leaves; level d at row 1 + 66·d: nodes (s4, s5), bits (s0, s1), siblings (q0, q1)
                leaf[0].copy_advice(|| "leaf", &mut r, s[0], 0)?;
                leaf[1].copy_advice(|| "leaf", &mut r, s[1], 0)?;
                self.q_mvin.enable(&mut r, 0)?;
                let mut node: Vec<Value<Fr>> = vec![leaf[0].value().copied(), leaf[1].value().copied()];
                for p in 0..2 {
                    r.assign_advice(|| "node", s[4 + p], 1, || node[p])?;
                }
                let mut bit_cells = [Vec::with_capacity(TREE_DEPTH), Vec::with_capacity(TREE_DEPTH)];
                let rows = Self::rounds(3) + 1;
                for d in 0..TREE_DEPTH {
                    let m = 1 + d * rows;
                    self.q_mk.enable(&mut r, m)?;
                    let mut init = Vec::with_capacity(6);
                    for p in 0..2 {
                        r.assign_advice(|| "sib", self.cols.q[p], m, || path[p][d])?;
                        bit_cells[p].push(r.assign_advice(|| "bit", s[p], m, || bits[p][d])?);
                        let prev = node[p];
                        let l = prev.zip(path[p][d]).zip(bits[p][d]).map(|((p, s), b)| p + b * (s - p));
                        let rr = prev.zip(path[p][d]).zip(bits[p][d]).map(|((p, s), b)| s + b * (p - s));
                        r.assign_advice(|| "cap", s[3 * p], m + 1, || Value::known(Fr::ZERO))?;
                        r.assign_advice(|| "L", s[3 * p + 1], m + 1, || l)?;
                        r.assign_advice(|| "R", s[3 * p + 2], m + 1, || rr)?;
                        init.extend([Value::known(Fr::ZERO), l, rr]);
                    }
                    let o = self.permute(&mut r, m + 1, 3, init, true)?;
                    node = o.iter().map(|c| c.value().copied()).collect();
                }
                let end = 1 + TREE_DEPTH * rows;
                self.q_mvout.enable(&mut r, end)?;
                let roots = [r.assign_advice(|| "root", s[0], end + 1, || node[0])?, r.assign_advice(|| "root", s[1], end + 1, || node[1])?];
                Ok((roots, bit_cells))
            },
        )
    }
}

// ── Ec ──

#[derive(Clone, Debug)]
pub struct EcConfig {
    x: Column<Advice>,
    y: Column<Advice>,
    x2: Column<Advice>,
    y2: Column<Advice>,
    t: Column<Advice>,
    b: Column<Advice>,
    z: Column<Advice>,
    px: Column<Advice>,
    py: Column<Advice>,
    gx: Column<Fixed>,
    gy: Column<Fixed>,
    pw: Column<Fixed>,
    q_add: Selector,
    q_dbl: Selector,
    q_fix: Selector,
    q_var: Selector,
    q_vdbl: Selector,
    q_ld2: Selector,
    q_ldp: Selector,
    q_ecs: Selector,
}

pub type ECell = [AC; 2];

impl EcConfig {
    fn configure(meta: &mut ConstraintSystem<Fr>, cols: &Cols, sel: &Sels) -> Self {
        let [x, y, z, px, py, x2] = cols.s;
        let [y2, t, b, _, _, _] = cols.q;
        let (gx, gy, pw) = (cols.f[0], cols.f[1], cols.f[2]);
        let (q_add, q_dbl, q_fix, q_var, q_vdbl, q_ld2, q_ldp, q_ecs) = (sel.add, sel.dbl, sel.fix, sel.var, sel.vdbl, sel.ld2, sel.ldp, sel.ecs);
        let (a, d) = (cu(model::BJJ_A), cu(model::BJJ_D));

        meta.create_gate("babyadd", |m| {
            let q = m.query_selector(q_add);
            let (vx, vy, vx2, vy2, vt) = (
                m.query_advice(x, Rotation::cur()),
                m.query_advice(y, Rotation::cur()),
                m.query_advice(x2, Rotation::cur()),
                m.query_advice(y2, Rotation::cur()),
                m.query_advice(t, Rotation::cur()),
            );
            let (nx, ny) = (m.query_advice(x, Rotation::next()), m.query_advice(y, Rotation::next()));
            Constraints::with_selector(
                q,
                vec![
                    vt.clone() - vx.clone() * vx2.clone() * vy.clone() * vy2.clone(),
                    nx * (cu(1) + d.clone() * vt.clone()) - (vx.clone() * vy2.clone() + vy.clone() * vx2.clone()),
                    ny * (cu(1) - d * vt) - (vy * vy2 - a * vx * vx2),
                ],
            )
        });
        meta.create_gate("double", |m| {
            let q = m.query_selector(q_dbl);
            Constraints::with_selector(
                q,
                vec![
                    m.query_advice(x2, Rotation::cur()) - m.query_advice(x, Rotation::cur()),
                    m.query_advice(y2, Rotation::cur()) - m.query_advice(y, Rotation::cur()),
                ],
            )
        });
        meta.create_gate("fixed-base step", |m| {
            let q = m.query_selector(q_fix);
            let vb = m.query_advice(b, Rotation::cur());
            let (fx, fy, fp) = (m.query_fixed(gx, Rotation::cur()), m.query_fixed(gy, Rotation::cur()), m.query_fixed(pw, Rotation::cur()));
            Constraints::with_selector(
                q,
                vec![
                    vb.clone() * (cu(1) - vb.clone()),
                    m.query_advice(x2, Rotation::cur()) - vb.clone() * fx,
                    m.query_advice(y2, Rotation::cur()) - (cu(1) + vb.clone() * (fy - cu(1))),
                    m.query_advice(z, Rotation::next()) - (m.query_advice(z, Rotation::cur()) + vb * fp),
                ],
            )
        });
        // base carried to the next row in both variable-base row kinds
        let chain = |m: &mut VirtualCells<'_, Fr>| {
            vec![
                m.query_advice(px, Rotation::next()) - m.query_advice(px, Rotation::cur()),
                m.query_advice(py, Rotation::next()) - m.query_advice(py, Rotation::cur()),
            ]
        };
        meta.create_gate("variable-base step", |m| {
            let q = m.query_selector(q_var);
            let vb = m.query_advice(b, Rotation::cur());
            let (vpx, vpy) = (m.query_advice(px, Rotation::cur()), m.query_advice(py, Rotation::cur()));
            let mut v = vec![
                vb.clone() * (cu(1) - vb.clone()),
                m.query_advice(x2, Rotation::cur()) - vb.clone() * vpx,
                m.query_advice(y2, Rotation::cur()) - (cu(1) + vb.clone() * (vpy - cu(1))),
                m.query_advice(z, Rotation::next()) - (cu(2) * m.query_advice(z, Rotation::cur()) + vb),
            ];
            v.extend(chain(m));
            Constraints::with_selector(q, v)
        });
        meta.create_gate("variable-base double", |m| {
            let q = m.query_selector(q_vdbl);
            let mut v = vec![
                m.query_advice(x2, Rotation::cur()) - m.query_advice(x, Rotation::cur()),
                m.query_advice(y2, Rotation::cur()) - m.query_advice(y, Rotation::cur()),
                m.query_advice(z, Rotation::next()) - m.query_advice(z, Rotation::cur()),
            ];
            v.extend(chain(m));
            Constraints::with_selector(q, v)
        });
        for (sel, cx, cy) in [(q_ld2, x2, y2), (q_ldp, px, py)] {
            meta.create_gate("load from row above", |m| {
                let q = m.query_selector(sel);
                Constraints::with_selector(
                    q,
                    vec![
                        m.query_advice(cx, Rotation::cur()) - m.query_advice(x, Rotation::prev()),
                        m.query_advice(cy, Rotation::cur()) - m.query_advice(y, Rotation::prev()),
                    ],
                )
            });
        }
        // accumulator start: the identity (0, 1) and z = 0
        meta.create_gate("ec start", |m| {
            let q = m.query_selector(q_ecs);
            Constraints::with_selector(q, vec![m.query_advice(x, Rotation::cur()), m.query_advice(y, Rotation::cur()) - cu(1), m.query_advice(z, Rotation::cur())])
        });
        EcConfig { x, y, x2, y2, t, b, z, px, py, gx, gy, pw, q_add, q_dbl, q_fix, q_var, q_vdbl, q_ld2, q_ldp, q_ecs }
    }

    /// Assigns the second operand (when `assign_q`) and t at `row`; returns the sum.
    fn add_row(&self, r: &mut Region<'_, Fr>, row: usize, p: Value<Pt>, q2: Value<Pt>, assign_q: bool) -> Result<Value<Pt>, Error> {
        self.q_add.enable(r, row)?;
        if assign_q {
            r.assign_advice(|| "x2", self.x2, row, || q2.map(|q| q[0]))?;
            r.assign_advice(|| "y2", self.y2, row, || q2.map(|q| q[1]))?;
        }
        r.assign_advice(|| "t", self.t, row, || p.zip(q2).map(|(p, q)| p[0] * q[0] * p[1] * q[1]))?;
        Ok(p.zip(q2).map(|(p, q)| model::add(&p, &q)))
    }

    fn put(&self, r: &mut Region<'_, Fr>, row: usize, p: Value<Pt>) -> Result<ECell, Error> {
        Ok([r.assign_advice(|| "x", self.x, row, || p.map(|p| p[0]))?, r.assign_advice(|| "y", self.y, row, || p.map(|p| p[1]))?])
    }

    fn start(&self, r: &mut Region<'_, Fr>, row: usize) -> Result<(), Error> {
        self.q_ecs.enable(r, row)?;
        r.assign_advice(|| "x0", self.x, row, || Value::known(Fr::ZERO))?;
        r.assign_advice(|| "y0", self.y, row, || Value::known(Fr::ONE))?;
        r.assign_advice(|| "z0", self.z, row, || Value::known(Fr::ZERO))?;
        Ok(())
    }

    fn val(p: &ECell) -> Value<Pt> {
        p[0].value().copied().zip(p[1].value().copied()).map(|(a, b)| [a, b])
    }

    /// Σ b_i·2^i·base over `n` bits of `k`, LSB first. Returns (point, z = Σ b_i·2^i).
    pub fn fixed_mul(&self, ly: &mut impl Layouter<Fr>, base: &'static [Pt], n: usize, k: Value<Fr>) -> Result<(ECell, AC), Error> {
        assert!(base.len() >= n);
        ly.assign_region(
            || format!("{} fixed-base mul", tag()),
            |mut r| {
                self.start(&mut r, 0)?;
                let mut acc = Value::known(model::identity());
                let mut z = Value::known(Fr::ZERO);
                let mut pow = Fr::ONE;
                for i in 0..n {
                    let bi = bitv(k, i);
                    self.q_fix.enable(&mut r, i)?;
                    r.assign_fixed(|| "gx", self.gx, i, || Value::known(base[i][0]))?;
                    r.assign_fixed(|| "gy", self.gy, i, || Value::known(base[i][1]))?;
                    r.assign_fixed(|| "pw", self.pw, i, || Value::known(pow))?;
                    r.assign_advice(|| "b", self.b, i, || bi)?;
                    let q2 = bi.map(|b| if b == Fr::ONE { base[i] } else { model::identity() });
                    if i > 0 {
                        self.put(&mut r, i, acc)?;
                        r.assign_advice(|| "z", self.z, i, || z)?;
                    }
                    acc = self.add_row(&mut r, i, acc, q2, true)?;
                    z = z.zip(bi).map(|(z, b)| z + b * pow);
                    pow = pow.double();
                }
                let p = self.put(&mut r, n, acc)?;
                let zc = r.assign_advice(|| "z", self.z, n, || z)?;
                Ok((p, zc))
            },
        )
    }

    /// Σ b_j·2^j·P over the n bits of `k`, MSB first. Returns (point, z = k's bits, z after the top
    /// `hi_bits` bits).
    pub fn var_mul(&self, ly: &mut impl Layouter<Fr>, p: &ECell, k: Value<Fr>, n: usize, hi_bits: usize) -> Result<(ECell, AC, AC), Error> {
        ly.assign_region(
            || format!("{} variable-base mul", tag()),
            |mut r| {
                p[0].copy_advice(|| "px", &mut r, self.x, 0)?;
                p[1].copy_advice(|| "py", &mut r, self.y, 0)?;
                let pv = Self::val(p);
                self.start(&mut r, 1)?;
                self.q_ldp.enable(&mut r, 1)?;
                let mut acc = Value::known(model::identity());
                let mut z = Value::known(Fr::ZERO);
                let mut hi = None;
                for j in 0..n {
                    let bi = bitv(k, n - 1 - j);
                    let (rd, ra) = (1 + 2 * j, 2 + 2 * j);
                    self.q_vdbl.enable(&mut r, rd)?;
                    if j > 0 {
                        self.put(&mut r, rd, acc)?;
                        let zc = r.assign_advice(|| "z", self.z, rd, || z)?;
                        if j == hi_bits {
                            hi = Some(zc);
                        }
                    }
                    r.assign_advice(|| "px", self.px, rd, || pv.map(|p| p[0]))?;
                    r.assign_advice(|| "py", self.py, rd, || pv.map(|p| p[1]))?;
                    r.assign_advice(|| "x2", self.x2, rd, || acc.map(|a| a[0]))?;
                    r.assign_advice(|| "y2", self.y2, rd, || acc.map(|a| a[1]))?;
                    acc = self.add_row(&mut r, rd, acc, acc, false)?;

                    self.q_var.enable(&mut r, ra)?;
                    self.put(&mut r, ra, acc)?;
                    r.assign_advice(|| "z", self.z, ra, || z)?;
                    r.assign_advice(|| "px", self.px, ra, || pv.map(|p| p[0]))?;
                    r.assign_advice(|| "py", self.py, ra, || pv.map(|p| p[1]))?;
                    r.assign_advice(|| "b", self.b, ra, || bi)?;
                    let q2 = bi.zip(pv).map(|(b, p)| if b == Fr::ONE { p } else { model::identity() });
                    acc = self.add_row(&mut r, ra, acc, q2, true)?;
                    z = z.zip(bi).map(|(z, b)| z.double() + b);
                }
                let last = 1 + 2 * n;
                let out = self.put(&mut r, last, acc)?;
                let zc = r.assign_advice(|| "z", self.z, last, || z)?;
                r.assign_advice(|| "px", self.px, last, || pv.map(|p| p[0]))?;
                r.assign_advice(|| "py", self.py, last, || pv.map(|p| p[1]))?;
                Ok((out, zc.clone(), hi.unwrap_or(zc)))
            },
        )
    }

    /// P + Q.
    pub fn add(&self, ly: &mut impl Layouter<Fr>, p: &ECell, q: &ECell) -> Result<ECell, Error> {
        ly.assign_region(
            || format!("{} babyadd", tag()),
            |mut r| {
                q[0].copy_advice(|| "qx", &mut r, self.x, 0)?;
                q[1].copy_advice(|| "qy", &mut r, self.y, 0)?;
                p[0].copy_advice(|| "x", &mut r, self.x, 1)?;
                p[1].copy_advice(|| "y", &mut r, self.y, 1)?;
                let qv = Self::val(q);
                self.q_ld2.enable(&mut r, 1)?;
                r.assign_advice(|| "x2", self.x2, 1, || qv.map(|q| q[0]))?;
                r.assign_advice(|| "y2", self.y2, 1, || qv.map(|q| q[1]))?;
                let s = self.add_row(&mut r, 1, Self::val(p), qv, false)?;
                self.put(&mut r, 2, s)
            },
        )
    }

    /// 2P, 4P, 8P.
    pub fn dbl3(&self, ly: &mut impl Layouter<Fr>, p: &ECell) -> Result<[ECell; 3], Error> {
        ly.assign_region(
            || format!("{} dbl3", tag()),
            |mut r| {
                p[0].copy_advice(|| "x", &mut r, self.x, 0)?;
                p[1].copy_advice(|| "y", &mut r, self.y, 0)?;
                let mut acc = Self::val(p);
                let mut outs = Vec::new();
                for i in 0..3 {
                    self.q_dbl.enable(&mut r, i)?;
                    r.assign_advice(|| "x2", self.x2, i, || acc.map(|a| a[0]))?;
                    r.assign_advice(|| "y2", self.y2, i, || acc.map(|a| a[1]))?;
                    acc = self.add_row(&mut r, i, acc, acc, false)?;
                    outs.push(self.put(&mut r, i + 1, acc)?);
                }
                Ok([outs[0].clone(), outs[1].clone(), outs[2].clone()])
            },
        )
    }
}

// ── circuit ──

#[derive(Clone, Debug)]
pub struct SpendConfig {
    q_pub: Selector,
    cols: Cols,
    arith: ArithConfig,
    pos: PoseidonConfig,
    ec: EcConfig,
}

#[derive(Clone, Default)]
pub struct SpendCircuit {
    pub w: Option<SpendWitness>,
}

fn table(base: Pt, n: usize) -> Vec<Pt> {
    let mut out = Vec::with_capacity(n);
    let mut p = base;
    for _ in 0..n {
        out.push(p);
        p = model::add(&p, &p);
    }
    out
}
fn tables() -> &'static [Vec<Pt>; 3] {
    static T: OnceLock<[Vec<Pt>; 3]> = OnceLock::new();
    T.get_or_init(|| [table(model::base8(), 253), table(model::h_bjj(), 64), table(model::g_bjj(), 251)])
}

impl Circuit<Fr> for SpendCircuit {
    type Config = SpendConfig;
    type FloorPlanner = SimpleFloorPlanner;

    fn without_witnesses(&self) -> Self {
        SpendCircuit { w: None }
    }

    fn configure(meta: &mut ConstraintSystem<Fr>) -> SpendConfig {
        let pi = meta.instance_column();
        let cols = Cols::configure(meta);
        let sel = Sels::new(meta);
        // public input i sits in s0 of row i (the first region) and equals instance row i
        meta.create_gate("public input", |m| {
            let q = m.query_selector(sel.public);
            Constraints::with_selector(q, vec![m.query_advice(cols.s[0], Rotation::cur()) - m.query_instance(pi, Rotation::cur())])
        });
        SpendConfig { q_pub: sel.public, cols, arith: ArithConfig::configure(meta, &cols, &sel), pos: PoseidonConfig::configure(meta, &cols, &sel), ec: EcConfig::configure(meta, &cols, &sel) }
    }

    fn synthesize(&self, cfg: SpendConfig, mut ly: impl Layouter<Fr>) -> Result<(), Error> {
        let ar = Arith { cfg: &cfg.arith };
        let ec = &cfg.ec;
        let pa = &cfg.pos;
        let [tb8, th, tg] = tables();
        let (tb8, th, tg): (&'static [Pt], &'static [Pt], &'static [Pt]) = (tb8, th, tg);
        let w = self.w.as_ref();
        let val = |f: &dyn Fn(&SpendWitness) -> Fr| -> Value<Fr> { w.map(|w| Value::known(f(w))).unwrap_or(Value::unknown()) };
        let mut ly = ly.namespace(|| "spend");
        let ly = &mut ly;

        let l_minus_1 = model::fr(&(model::l_big() - 1u8));
        let p = model::p_big();
        let two128: BigUint = BigUint::from(1u8) << 128usize;
        let (p_hi, p_lo) = (model::fr(&(p >> 128usize)), model::fr(&(p % &two128)));
        let two128f = model::fr(&two128);

        ar.at("public");
        let pv: [Value<Fr>; crate::model::N_PUBLIC] = std::array::from_fn(|i| val(&|w| w.publics()[i]));
        let pubs: Vec<AC> = ly.assign_region(
            || "public",
            |mut r| {
                (0..pv.len())
                    .map(|i| {
                        cfg.q_pub.enable(&mut r, i)?;
                        r.assign_advice(|| "public", cfg.cols.s[0], i, || pv[i])
                    })
                    .collect()
            },
        )?;
        let (root, body, asset) = (pubs[0].clone(), pubs[1].clone(), pubs[2].clone());
        let nf: Vec<AC> = pubs[3..3 + N_IN].to_vec();
        let out_leaf: Vec<AC> = pubs[3 + N_IN..3 + N_IN + N_OUT].to_vec();
        let exit_c: Vec<AC> = pubs[3 + N_IN + N_OUT..5 + N_IN + N_OUT].to_vec();
        let dep_c: Vec<AC> = pubs[5 + N_IN + N_OUT..7 + N_IN + N_OUT].to_vec();

        // per input: emptiness, value, nk, note leaf
        struct In {
            e: AC,
            en: AC,
            v: AC,
            nk: AC,
            ak: ECell,
            leaf: AC,
        }
        let mut ins = Vec::with_capacity(N_IN);
        for i in 0..N_IN {
            // slot i is empty iff nf = 0; an empty slot carries value 0
            ar.at(format!("in{i} empty"));
            let e = ar.is_zero(ly, &nf[i])?;
            let en = ar.lin(ly, &e, -Fr::ONE, None, Fr::ZERO, Fr::ONE)?;
            let v = ar.witness(ly, val(&|w| w.in_v[i]))?;
            ar.assert_mul_zero(ly, &v, &e)?;
            ar.range(ly, &v, 64, &format!("in{i} v"))?;

            // NK = nk·B8 with 0 ≤ nk < l: nk < 2^251 by the decomposition, l − 1 − nk < 2^251
            ar.at(format!("in{i} nk"));
            let nk = ar.witness(ly, val(&|w| w.in_nk[i]))?;
            let (nk_pt, nk_z) = ec.fixed_mul(ly, tb8, 251, nk.value().copied())?;
            ar.eq(ly, &nk_z, &nk)?;
            let nk_gap = ar.lin(ly, &nk, -Fr::ONE, None, Fr::ZERO, l_minus_1)?;
            ar.range(ly, &nk_gap, 251, &format!("in{i} nk < l"))?;

            ar.at(format!("in{i} note"));
            let ak = [ar.witness(ly, val(&|w| w.in_ak[i][0]))?, ar.witness(ly, val(&|w| w.in_ak[i][1]))?];
            let npk = pa.hash(ly, &[&ak[0], &ak[1], &nk_pt[0], &nk_pt[1]])?;
            let rho = ar.witness(ly, val(&|w| w.in_rho[i]))?;
            let leaf = pa.hash(ly, &[&asset, &v, &npk, &rho])?;
            ins.push(In { e, en, v, nk, ak, leaf });
        }

        // both membership paths in one region
        ar.at("in index");
        let path: [[Value<Fr>; TREE_DEPTH]; N_IN] = std::array::from_fn(|i| std::array::from_fn(|d| val(&|w| w.in_path[i][d])));
        let bits: [[Value<Fr>; TREE_DEPTH]; N_IN] = std::array::from_fn(|i| std::array::from_fn(|d| bitv(val(&|w| w.in_index[i]), d)));
        let (roots, bit_cells) = pa.merkle2(ly, [&ins[0].leaf, &ins[1].leaf], [&path[0], &path[1]], [&bits[0], &bits[1]])?;

        let mut sum_in: Option<AC> = None;
        for (i, In { e, en, v, nk, ak, leaf }) in ins.into_iter().enumerate() {
            // index = Σ bit_d·2^d over the 32 path bits
            ar.at(format!("in{i} index"));
            let index = ar.witness(ly, val(&|w| w.in_index[i]))?;
            let mut acc = bit_cells[i][0].clone();
            for (d, b) in bit_cells[i].iter().enumerate().skip(1) {
                acc = ar.lin(ly, &acc, Fr::ONE, Some(b), Fr::from(1u64 << d), Fr::ZERO)?;
            }
            ar.eq(ly, &acc, &index)?;

            // membership unless v = 0
            ar.at(format!("in{i} membership"));
            let zv = ar.is_zero(ly, &v)?;
            let droot = ar.sub(ly, &roots[i], &root)?;
            ar.assert_zero_unless(ly, &droot, &zv)?;

            // nf = Poseidon(nk, leaf, index) unless empty
            ar.at(format!("in{i} nullifier"));
            let nfh = pa.hash(ly, &[&nk, &leaf, &index])?;
            let dnf = ar.sub(ly, &nfh, &nf[i])?;
            ar.assert_zero_unless(ly, &dnf, &e)?;

            // EdDSAPoseidonVerifier(enabled = en, A = Ak, M = bodyHash)
            ar.at(format!("in{i} sig S"));
            let s = ar.witness(ly, val(&|w| w.sig_s[i]))?;
            let (lhs, s_z) = ec.fixed_mul(ly, tb8, 253, s.value().copied())?;
            ar.eq(ly, &s_z, &s)?;
            let s_gap = ar.lin(ly, &s, -Fr::ONE, None, Fr::ZERO, l_minus_1)?;
            let s_gap_en = ar.mul(ly, &s_gap, &en)?;
            ar.range(ly, &s_gap_en, 251, &format!("in{i} sig S < l"))?;

            ar.at(format!("in{i} sig h"));
            let r8 = [ar.witness(ly, val(&|w| w.sig_r8[i][0]))?, ar.witness(ly, val(&|w| w.sig_r8[i][1]))?];
            let h = pa.hash(ly, &[&r8[0], &r8[1], &ak[0], &ak[1], &body])?;

            ar.at(format!("in{i} sig A"));
            let [_, a4, a8] = ec.dbl3(ly, &ak)?;
            let a4z = ar.is_zero(ly, &a4[0])?;
            ar.assert_mul_zero(ly, &a4z, &en)?;

            // h·8A over h's 254 bits, held canonical: hi ≤ p_hi, and lo < p_lo when hi = p_hi
            ar.at(format!("in{i} sig h bits"));
            let (right2, h_z, h_hi) = ec.var_mul(ly, &a8, h.value().copied(), 254, 126)?;
            ar.eq(ly, &h_z, &h)?;
            let hi_gap = ar.lin(ly, &h_hi, -Fr::ONE, None, Fr::ZERO, p_hi)?;
            ar.range(ly, &hi_gap, 126, &format!("in{i} sig h hi"))?;
            let hi_eq = ar.is_zero(ly, &hi_gap)?;
            let lo = ar.lin(ly, &h, Fr::ONE, Some(&h_hi), -two128f, Fr::ZERO)?;
            let lo_gap = ar.lin(ly, &lo, -Fr::ONE, None, Fr::ZERO, p_lo - Fr::ONE)?;
            let lo_gap_en = ar.mul(ly, &lo_gap, &hi_eq)?;
            ar.range(ly, &lo_gap_en, 128, &format!("in{i} sig h lo"))?;

            // S·B8 = R8 + h·8A when enabled
            ar.at(format!("in{i} sig eq"));
            let right = ec.add(ly, &r8, &right2)?;
            for j in 0..2 {
                let dd = ar.sub(ly, &lhs[j], &right[j])?;
                ar.assert_mul_zero(ly, &dd, &en)?;
            }

            ar.at("balance");
            sum_in = Some(match sum_in {
                None => v,
                Some(acc) => ar.add(ly, &acc, &v)?,
            });
        }

        let mut sum_out: Option<AC> = None;
        for k in 0..N_OUT {
            ar.at(format!("out{k} empty"));
            let oe = ar.is_zero(ly, &out_leaf[k])?;
            let v = ar.witness(ly, val(&|w| w.out_v[k]))?;
            ar.assert_mul_zero(ly, &v, &oe)?;
            ar.range(ly, &v, 64, &format!("out{k} v"))?;
            ar.at(format!("out{k} leaf"));
            let npk = ar.witness(ly, val(&|w| w.out_npk[k]))?;
            let rho = ar.witness(ly, val(&|w| w.out_rho[k]))?;
            let oh = pa.hash(ly, &[&asset, &v, &npk, &rho])?;
            let d = ar.sub(ly, &oh, &out_leaf[k])?;
            ar.assert_zero_unless(ly, &d, &oe)?;
            ar.at("balance");
            sum_out = Some(match sum_out {
                None => v,
                Some(acc) => ar.add(ly, &acc, &v)?,
            });
        }

        // PedersenBJJ: amount < 2^64 and r < 2^251 by the decompositions, C = amount·H + r·G
        let mut opened = Vec::new();
        for (cpub, name) in [(&exit_c, "exit"), (&dep_c, "dep")] {
            let is_exit = name == "exit";
            ar.at(format!("{name} v"));
            let v = ar.witness(ly, val(&|w| if is_exit { w.exit_v } else { w.dep_v }))?;
            let (vh, vz) = ec.fixed_mul(ly, th, 64, v.value().copied())?;
            ar.eq(ly, &vz, &v)?;
            ar.at(format!("{name} r"));
            let r = ar.witness(ly, val(&|w| if is_exit { w.exit_r } else { w.dep_r }))?;
            let (rgp, rz) = ec.fixed_mul(ly, tg, 251, r.value().copied())?;
            ar.eq(ly, &rz, &r)?;
            ar.at(format!("{name} commitment"));
            let sum = ec.add(ly, &vh, &rgp)?;
            ar.eq(ly, &sum[0], &cpub[0])?;
            ar.eq(ly, &sum[1], &cpub[1])?;
            opened.push(v);
        }
        let (exit_v, dep_v) = (&opened[0], &opened[1]);

        // Σ inV + depV = Σ outV + exitV
        ar.at("balance");
        let lhs = ar.add(ly, &sum_in.unwrap(), dep_v)?;
        let rhs = ar.add(ly, &sum_out.unwrap(), exit_v)?;
        ar.eq(ly, &lhs, &rhs)?;
        Ok(())
    }
}
