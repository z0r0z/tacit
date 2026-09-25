//! spend.circom as a Halo2 circuit over BN254 Fr.
//!
//! Chips (disjoint columns, so the floor planner lays them side by side):
//!   Arith     a, b, c; ql·a + qr·b + qo·c + qm·a·b + qc = 0. Range checks are MSB-first bit
//!             decompositions in (a, b): a_next = 2·a + b, b boolean, from a = 0 to a = x.
//!   Poseidon  one row per round; lanes s_j, sq_j = (s_j + rc_j)², sbox = sq_j²·(s_j + rc_j). Inputs load
//!             from the io column (rotations 0..t−2), the output returns through io; io is the only
//!             equality column. Merkle levels chain on s_0 of the previous row, sibling in s_3, bit in io.
//!             Chip A: widths 3–6; chip B: width 3 (the second Merkle path).
//!   Ec        one BabyAdd per row (circomlib formula); fixed-base LSB-first, variable-base MSB-first,
//!             scalar accumulated in z. Second operands and bases load from the row above.
//!
//! Public inputs (instance column, rows 0..12): root, bodyHash, asset, nf[2], outLeaf[3], exitC[2], depC[2].

use crate::model::{self, Pt, SpendWitness, N_IN, N_OUT, TREE_DEPTH};
use ff::Field;
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, Region, SimpleFloorPlanner, Value},
    halo2curves::bn256::Fr,
    plonk::{Advice, Circuit, Column, ConstraintSystem, Constraints, Error, Expression, Fixed, Instance, Selector},
    poly::Rotation,
};
use num_bigint::BigUint;
use std::sync::OnceLock;

pub type AC = AssignedCell<Fr, Fr>;

pub const K: u32 = 12;

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

// ── Arith ──

#[derive(Clone, Debug)]
pub struct ArithConfig {
    a: Column<Advice>,
    b: Column<Advice>,
    c: Column<Advice>,
    q: [Column<Fixed>; 5], // ql, qr, qo, qm, qc
    q_bits: Selector,
}

impl ArithConfig {
    fn configure(meta: &mut ConstraintSystem<Fr>) -> Self {
        let (a, b, cc) = (meta.advice_column(), meta.advice_column(), meta.advice_column());
        for col in [a, b, cc] {
            meta.enable_equality(col);
        }
        let q = [(); 5].map(|_| meta.fixed_column());
        let q_bits = meta.selector();
        meta.create_gate("arith", |m| {
            let (va, vb, vc) = (m.query_advice(a, Rotation::cur()), m.query_advice(b, Rotation::cur()), m.query_advice(cc, Rotation::cur()));
            let f = q.map(|x| m.query_fixed(x, Rotation::cur()));
            vec![f[0].clone() * va.clone() + f[1].clone() * vb.clone() + f[2].clone() * vc + f[3].clone() * va * vb + f[4].clone()]
        });
        meta.create_gate("bits", |m| {
            let s = m.query_selector(q_bits);
            let (z, bb, zn) = (m.query_advice(a, Rotation::cur()), m.query_advice(b, Rotation::cur()), m.query_advice(a, Rotation::next()));
            Constraints::with_selector(s, vec![bb.clone() * (cu(1) - bb.clone()), zn - (z * cu(2) + bb)])
        });
        ArithConfig { a, b, c: cc, q, q_bits }
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
        ly.assign_region(
            tag,
            |mut r| {
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
            },
        )
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
                let z0 = r.assign_advice(|| "z0", self.cfg.a, 0, || Value::known(Fr::ZERO))?;
                r.constrain_constant(z0.cell(), Fr::ZERO)?;
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

#[derive(Clone, Debug)]
pub struct PoseidonConfig {
    widths: Vec<usize>,
    s: Vec<Column<Advice>>,
    sq: Vec<Column<Advice>>,
    io: Column<Advice>,
    rc: Vec<Column<Fixed>>,
    q_full: Vec<Selector>,
    q_part: Vec<Selector>,
    q_load: Vec<Selector>,
    q_in0: Selector,
    q_out: Selector,
    q_mk: Selector,
}

impl PoseidonConfig {
    fn configure(meta: &mut ConstraintSystem<Fr>, widths: &[usize]) -> Self {
        let maxw = *widths.iter().max().unwrap();
        let s: Vec<_> = (0..maxw.max(4)).map(|_| meta.advice_column()).collect();
        let sq: Vec<_> = (0..maxw).map(|_| meta.advice_column()).collect();
        let io = meta.advice_column();
        meta.enable_equality(io);
        let rc: Vec<_> = (0..maxw).map(|_| meta.fixed_column()).collect();
        let q_full: Vec<_> = widths.iter().map(|_| meta.selector()).collect();
        let q_part: Vec<_> = widths.iter().map(|_| meta.selector()).collect();
        let q_load: Vec<_> = widths.iter().map(|_| meta.selector()).collect();
        let (q_in0, q_out, q_mk) = (meta.selector(), meta.selector(), meta.selector());

        for (wi, &t) in widths.iter().enumerate() {
            for full in [true, false] {
                let sel = if full { q_full[wi] } else { q_part[wi] };
                meta.create_gate(if full { "poseidon full" } else { "poseidon partial" }, |m| {
                    let q = m.query_selector(sel);
                    let x: Vec<_> = (0..t).map(|j| m.query_advice(s[j], Rotation::cur()) + m.query_fixed(rc[j], Rotation::cur())).collect();
                    let sqv: Vec<_> = (0..t).map(|j| if full || j == 0 { m.query_advice(sq[j], Rotation::cur()) } else { c(Fr::ZERO) }).collect();
                    let nx: Vec<_> = (0..t).map(|j| m.query_advice(s[j], Rotation::next())).collect();
                    let sbox = |j: usize| -> Expression<Fr> {
                        if full || j == 0 {
                            sqv[j].clone() * sqv[j].clone() * x[j].clone()
                        } else {
                            x[j].clone()
                        }
                    };
                    let mut cs = Vec::new();
                    for j in 0..t {
                        if full || j == 0 {
                            cs.push(sqv[j].clone() - x[j].clone() * x[j].clone());
                        }
                    }
                    for i in 0..t {
                        let mut acc = c(Fr::ZERO);
                        for j in 0..t {
                            acc = acc + c(model::mds(t, i, j)) * sbox(j);
                        }
                        cs.push(nx[i].clone() - acc);
                    }
                    Constraints::with_selector(q, cs)
                });
            }
            meta.create_gate("poseidon load", |m| {
                let q = m.query_selector(q_load[wi]);
                let mut cs = vec![m.query_advice(s[0], Rotation::cur())];
                for j in 1..t {
                    cs.push(m.query_advice(s[j], Rotation::cur()) - m.query_advice(io, Rotation((j - 1) as i32)));
                }
                Constraints::with_selector(q, cs)
            });
        }
        meta.create_gate("poseidon io", |m| {
            let (qi, qo) = (m.query_selector(q_in0), m.query_selector(q_out));
            let d = m.query_advice(s[0], Rotation::cur()) - m.query_advice(io, Rotation::cur());
            vec![qi * d.clone(), qo * d]
        });
        meta.create_gate("merkle level", |m| {
            let q = m.query_selector(q_mk);
            let prev = m.query_advice(s[0], Rotation::prev());
            let b = m.query_advice(io, Rotation::cur());
            let sb = m.query_advice(s[3], Rotation::cur());
            let (s0, s1, s2) = (m.query_advice(s[0], Rotation::cur()), m.query_advice(s[1], Rotation::cur()), m.query_advice(s[2], Rotation::cur()));
            Constraints::with_selector(
                q,
                vec![
                    b.clone() * (cu(1) - b.clone()),
                    s0,
                    s1 - (prev.clone() + b.clone() * (sb.clone() - prev.clone())),
                    s2 - (sb.clone() + b * (prev - sb)),
                ],
            )
        });
        PoseidonConfig { widths: widths.to_vec(), s, sq, io, rc, q_full, q_part, q_load, q_in0, q_out, q_mk }
    }

    fn rounds(t: usize) -> usize {
        model::FULL_ROUNDS + model::partial_rounds(t)
    }

    /// Rounds at rows off..off+R, output state at off+R (s_0 also copied to io there). The caller has
    /// assigned the lanes at `off`.
    fn permute(&self, r: &mut Region<'_, Fr>, off: usize, t: usize, init: Vec<Value<Fr>>) -> Result<AC, Error> {
        let wi = self.widths.iter().position(|&w| w == t).expect("width");
        let mut st: Value<Vec<Fr>> = init.iter().fold(Value::known(Vec::with_capacity(t)), |acc, v| {
            acc.zip(*v).map(|(mut a, b)| {
                a.push(b);
                a
            })
        });
        let rounds = Self::rounds(t);
        for rd in 0..rounds {
            let row = off + rd;
            let full = model::is_full_round(t, rd);
            if full {
                self.q_full[wi].enable(r, row)?;
            } else {
                self.q_part[wi].enable(r, row)?;
            }
            for j in 0..t {
                let k = model::round_constant(t, rd, j);
                r.assign_fixed(|| "rc", self.rc[j], row, || Value::known(k))?;
                if rd > 0 {
                    r.assign_advice(|| "s", self.s[j], row, || st.as_ref().map(|s| s[j]))?;
                }
                if full || j == 0 {
                    r.assign_advice(|| "sq", self.sq[j], row, || st.as_ref().map(|s| (s[j] + k).square()))?;
                }
            }
            st = st.map(|mut s| {
                model::poseidon_round(t, rd, &mut s);
                s
            });
        }
        let row = off + rounds;
        for j in 0..t {
            r.assign_advice(|| "s out", self.s[j], row, || st.as_ref().map(|s| s[j]))?;
        }
        self.q_out.enable(r, row)?;
        r.assign_advice(|| "out", self.io, row, || st.as_ref().map(|s| s[0]))
    }

    /// circomlib Poseidon(inputs).
    pub fn hash(&self, ly: &mut impl Layouter<Fr>, inputs: &[&AC]) -> Result<AC, Error> {
        let t = inputs.len() + 1;
        let wi = self.widths.iter().position(|&w| w == t).expect("width");
        ly.assign_region(
            || format!("{} poseidon", tag()),
            |mut r| {
                self.q_load[wi].enable(&mut r, 0)?;
                let mut init = vec![Value::known(Fr::ZERO)];
                r.assign_advice(|| "cap", self.s[0], 0, || Value::known(Fr::ZERO))?;
                for (j, x) in inputs.iter().enumerate() {
                    x.copy_advice(|| "in", &mut r, self.io, j)?;
                    r.assign_advice(|| "lane", self.s[j + 1], 0, || x.value().copied())?;
                    init.push(x.value().copied());
                }
                self.permute(&mut r, 0, t, init)
            },
        )
    }

    /// Poseidon(2) path of fixed depth from `leaf`; returns the root and the per-level index bits.
    pub fn merkle(&self, ly: &mut impl Layouter<Fr>, leaf: &AC, path: &[Value<Fr>; TREE_DEPTH], bits: &[Value<Fr>; TREE_DEPTH]) -> Result<(AC, Vec<AC>), Error> {
        ly.assign_region(
            || format!("{} merkle", tag()),
            |mut r| {
                self.q_in0.enable(&mut r, 0)?;
                leaf.copy_advice(|| "leaf", &mut r, self.io, 0)?;
                let mut prev = leaf.value().copied();
                r.assign_advice(|| "leaf", self.s[0], 0, || prev)?;
                let mut bit_cells = Vec::with_capacity(TREE_DEPTH);
                let rows = Self::rounds(3) + 1;
                let mut out = None;
                for d in 0..TREE_DEPTH {
                    let off = 1 + d * rows;
                    self.q_mk.enable(&mut r, off)?;
                    r.assign_advice(|| "sib", self.s[3], off, || path[d])?;
                    bit_cells.push(r.assign_advice(|| "bit", self.io, off, || bits[d])?);
                    let l = prev.zip(path[d]).zip(bits[d]).map(|((p, s), b)| p + b * (s - p));
                    let rr = prev.zip(path[d]).zip(bits[d]).map(|((p, s), b)| s + b * (p - s));
                    r.assign_advice(|| "cap", self.s[0], off, || Value::known(Fr::ZERO))?;
                    r.assign_advice(|| "L", self.s[1], off, || l)?;
                    r.assign_advice(|| "R", self.s[2], off, || rr)?;
                    let o = self.permute(&mut r, off, 3, vec![Value::known(Fr::ZERO), l, rr])?;
                    prev = o.value().copied();
                    out = Some(o);
                }
                Ok((out.unwrap(), bit_cells))
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
    q_chain: Selector,
    q_ld2: Selector,
    q_ldp: Selector,
}

pub type ECell = [AC; 2];

impl EcConfig {
    fn configure(meta: &mut ConstraintSystem<Fr>) -> Self {
        let [x, y, x2, y2, t, b, z, px, py] = [(); 9].map(|_| meta.advice_column());
        for col in [x, y, z] {
            meta.enable_equality(col);
        }
        let (gx, gy, pw) = (meta.fixed_column(), meta.fixed_column(), meta.fixed_column());
        let [q_add, q_dbl, q_fix, q_var, q_vdbl, q_chain, q_ld2, q_ldp] = [(); 8].map(|_| meta.selector());
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
        meta.create_gate("variable-base step", |m| {
            let q = m.query_selector(q_var);
            let vb = m.query_advice(b, Rotation::cur());
            let (vpx, vpy) = (m.query_advice(px, Rotation::cur()), m.query_advice(py, Rotation::cur()));
            Constraints::with_selector(
                q,
                vec![
                    vb.clone() * (cu(1) - vb.clone()),
                    m.query_advice(x2, Rotation::cur()) - vb.clone() * vpx,
                    m.query_advice(y2, Rotation::cur()) - (cu(1) + vb.clone() * (vpy - cu(1))),
                    m.query_advice(z, Rotation::next()) - (cu(2) * m.query_advice(z, Rotation::cur()) + vb),
                ],
            )
        });
        meta.create_gate("variable-base double", |m| {
            let q = m.query_selector(q_vdbl);
            Constraints::with_selector(q, vec![m.query_advice(z, Rotation::next()) - m.query_advice(z, Rotation::cur())])
        });
        meta.create_gate("base chain", |m| {
            let q = m.query_selector(q_chain);
            Constraints::with_selector(
                q,
                vec![
                    m.query_advice(px, Rotation::next()) - m.query_advice(px, Rotation::cur()),
                    m.query_advice(py, Rotation::next()) - m.query_advice(py, Rotation::cur()),
                ],
            )
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
        EcConfig { x, y, x2, y2, t, b, z, px, py, gx, gy, pw, q_add, q_dbl, q_fix, q_var, q_vdbl, q_chain, q_ld2, q_ldp }
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
        r.assign_advice_from_constant(|| "x0", self.x, row, Fr::ZERO)?;
        r.assign_advice_from_constant(|| "y0", self.y, row, Fr::ONE)?;
        r.assign_advice_from_constant(|| "z0", self.z, row, Fr::ZERO)?;
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
                    self.q_dbl.enable(&mut r, rd)?;
                    self.q_vdbl.enable(&mut r, rd)?;
                    self.q_chain.enable(&mut r, rd)?;
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
                    self.q_chain.enable(&mut r, ra)?;
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
    pi: Column<Instance>,
    arith: ArithConfig,
    pos_a: PoseidonConfig,
    pos_b: PoseidonConfig,
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
        meta.enable_equality(pi);
        let constants = meta.fixed_column();
        meta.enable_constant(constants);
        SpendConfig {
            pi,
            arith: ArithConfig::configure(meta),
            pos_a: PoseidonConfig::configure(meta, &[3, 4, 5, 6]),
            pos_b: PoseidonConfig::configure(meta, &[3]),
            ec: EcConfig::configure(meta),
        }
    }

    fn synthesize(&self, cfg: SpendConfig, mut ly: impl Layouter<Fr>) -> Result<(), Error> {
        let ar = Arith { cfg: &cfg.arith };
        let ec = &cfg.ec;
        let pa = &cfg.pos_a;
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
        let root = ar.witness(ly, val(&|w| w.root))?;
        let body = ar.witness(ly, val(&|w| w.body_hash))?;
        let asset = ar.witness(ly, val(&|w| w.asset))?;
        let nf: Vec<AC> = (0..N_IN).map(|i| ar.witness(ly, val(&|w| w.nf[i]))).collect::<Result<_, _>>()?;
        let out_leaf: Vec<AC> = (0..N_OUT).map(|k| ar.witness(ly, val(&|w| w.out_leaf[k]))).collect::<Result<_, _>>()?;
        let exit_c: Vec<AC> = (0..2).map(|j| ar.witness(ly, val(&|w| w.exit_c[j]))).collect::<Result<_, _>>()?;
        let dep_c: Vec<AC> = (0..2).map(|j| ar.witness(ly, val(&|w| w.dep_c[j]))).collect::<Result<_, _>>()?;
        let pubs: Vec<&AC> = [&root, &body, &asset].into_iter().chain(nf.iter()).chain(out_leaf.iter()).chain(exit_c.iter()).chain(dep_c.iter()).collect();
        for (row, cell) in pubs.iter().enumerate() {
            ly.constrain_instance(cell.cell(), cfg.pi, row)?;
        }

        let mut sum_in: Option<AC> = None;
        for i in 0..N_IN {
            let pm = if i == 0 { &cfg.pos_a } else { &cfg.pos_b };
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

            // index = Σ bit_d·2^d over the 32 path bits
            ar.at(format!("in{i} index"));
            let path: [Value<Fr>; TREE_DEPTH] = std::array::from_fn(|d| val(&|w| w.in_path[i][d]));
            let bits: [Value<Fr>; TREE_DEPTH] = std::array::from_fn(|d| bitv(val(&|w| w.in_index[i]), d));
            let (root_i, bit_cells) = pm.merkle(ly, &leaf, &path, &bits)?;
            let index = ar.witness(ly, val(&|w| w.in_index[i]))?;
            let mut acc = bit_cells[0].clone();
            for (d, b) in bit_cells.iter().enumerate().skip(1) {
                acc = ar.lin(ly, &acc, Fr::ONE, Some(b), Fr::from(1u64 << d), Fr::ZERO)?;
            }
            ar.eq(ly, &acc, &index)?;

            // membership unless v = 0
            ar.at(format!("in{i} membership"));
            let zv = ar.is_zero(ly, &v)?;
            let droot = ar.sub(ly, &root_i, &root)?;
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
