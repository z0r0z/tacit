//! A compact encoding of a finished `ConstraintSystem` (configured, selectors compressed), so a verifier that
//! runs where `configure` and selector compression are costly (a zkVM) can take the system as bytes. The host
//! encodes the system its circuit gives; `from_compact` rebuilds one whose `Debug` form is the same, which the
//! host checks. Lookups, shuffles and column annotations are not encoded: a system with any is refused.

use super::sealed::Phase;
use super::{Advice, AdviceQuery, Any, Challenge, Column, ConstraintSystem, Expression, Fixed, FixedQuery, Gate, Instance, InstanceQuery, Selector, VirtualCell};
use crate::plonk::permutation;
use crate::poly::Rotation;
use ff::PrimeField;

#[derive(Default)]
struct W(Vec<u8>);

impl W {
    fn u(&mut self, x: usize) {
        self.0.extend((u32::try_from(x).expect("fits in u32")).to_le_bytes());
    }
    fn b(&mut self, x: u8) {
        self.0.push(x);
    }
    fn i(&mut self, x: i32) {
        self.0.extend(x.to_le_bytes());
    }
    fn s(&mut self, x: &str) {
        self.u(x.len());
        self.0.extend(x.as_bytes());
    }
    fn opt(&mut self, x: Option<usize>) {
        match x {
            None => self.b(0),
            Some(v) => {
                self.b(1);
                self.u(v);
            }
        }
    }
    fn f<F: PrimeField>(&mut self, x: &F) {
        let r = x.to_repr();
        self.u(r.as_ref().len());
        self.0.extend(r.as_ref());
    }
    fn any(&mut self, c: &Column<Any>) {
        self.u(c.index);
        match c.column_type {
            Any::Advice(a) => {
                self.b(0);
                self.b(a.phase.0);
            }
            Any::Fixed => self.b(1),
            Any::Instance => self.b(2),
        }
    }
    fn expr<F: PrimeField>(&mut self, e: &Expression<F>) {
        match e {
            Expression::Constant(c) => {
                self.b(0);
                self.f(c);
            }
            Expression::Selector(s) => {
                self.b(1);
                self.u(s.0);
                self.b(s.1 as u8);
            }
            Expression::Fixed(q) => {
                self.b(2);
                self.opt(q.index);
                self.u(q.column_index);
                self.i(q.rotation.0);
            }
            Expression::Advice(q) => {
                self.b(3);
                self.opt(q.index);
                self.u(q.column_index);
                self.i(q.rotation.0);
                self.b(q.phase.0);
            }
            Expression::Instance(q) => {
                self.b(4);
                self.opt(q.index);
                self.u(q.column_index);
                self.i(q.rotation.0);
            }
            Expression::Challenge(c) => {
                self.b(5);
                self.u(c.index);
                self.b(c.phase.0);
            }
            Expression::Negated(a) => {
                self.b(6);
                self.expr(a);
            }
            Expression::Sum(a, b) => {
                self.b(7);
                self.expr(a);
                self.expr(b);
            }
            Expression::Product(a, b) => {
                self.b(8);
                self.expr(a);
                self.expr(b);
            }
            Expression::Scaled(a, f) => {
                self.b(9);
                self.expr(a);
                self.f(f);
            }
        }
    }
}

struct R<'a>(&'a [u8]);

impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.0.len() < n {
            return None;
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Some(a)
    }
    fn u(&mut self) -> Option<usize> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?) as usize)
    }
    fn b(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn i(&mut self) -> Option<i32> {
        Some(i32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn s(&mut self) -> Option<String> {
        let n = self.u()?;
        String::from_utf8(self.take(n)?.to_vec()).ok()
    }
    fn opt(&mut self) -> Option<Option<usize>> {
        match self.b()? {
            0 => Some(None),
            1 => Some(Some(self.u()?)),
            _ => None,
        }
    }
    fn f<F: PrimeField>(&mut self) -> Option<F> {
        let n = self.u()?;
        let mut r = F::Repr::default();
        if r.as_ref().len() != n {
            return None;
        }
        r.as_mut().copy_from_slice(self.take(n)?);
        Option::from(F::from_repr(r))
    }
    fn vec<T>(&mut self, mut one: impl FnMut(&mut Self) -> Option<T>) -> Option<Vec<T>> {
        let n = self.u()?;
        (0..n).map(|_| one(self)).collect()
    }
    fn any(&mut self) -> Option<Column<Any>> {
        let index = self.u()?;
        let column_type = match self.b()? {
            0 => Any::Advice(Advice { phase: Phase(self.b()?) }),
            1 => Any::Fixed,
            2 => Any::Instance,
            _ => return None,
        };
        Some(Column { index, column_type })
    }
    fn expr<F: PrimeField>(&mut self) -> Option<Expression<F>> {
        Some(match self.b()? {
            0 => Expression::Constant(self.f()?),
            1 => Expression::Selector(Selector(self.u()?, self.b()? != 0)),
            2 => Expression::Fixed(FixedQuery { index: self.opt()?, column_index: self.u()?, rotation: Rotation(self.i()?) }),
            3 => Expression::Advice(AdviceQuery { index: self.opt()?, column_index: self.u()?, rotation: Rotation(self.i()?), phase: Phase(self.b()?) }),
            4 => Expression::Instance(InstanceQuery { index: self.opt()?, column_index: self.u()?, rotation: Rotation(self.i()?) }),
            5 => Expression::Challenge(Challenge { index: self.u()?, phase: Phase(self.b()?) }),
            6 => Expression::Negated(Box::new(self.expr()?)),
            7 => Expression::Sum(Box::new(self.expr()?), Box::new(self.expr()?)),
            8 => Expression::Product(Box::new(self.expr()?), Box::new(self.expr()?)),
            9 => {
                let a = self.expr()?;
                Expression::Scaled(Box::new(a), self.f()?)
            }
            _ => return None,
        })
    }
}

impl<F: PrimeField> ConstraintSystem<F> {
    /// This system as bytes for `from_compact`, with `degree`, the degree its evaluation domain is built for
    /// (the configured system's, before selector compression). Panics on lookups, shuffles or annotations.
    pub fn to_compact(&self, degree: usize) -> Vec<u8> {
        self.compact(degree, true)
    }

    /// As `to_compact`, leaving the custom gates out: a verifier that reads the key with `VerifyingKey::read_with_program` takes
    /// them as their flat program instead, which costs far less to read than the expression trees.
    pub fn to_compact_without_gates(&self, degree: usize) -> Vec<u8> {
        self.compact(degree, false)
    }

    /// This system with its custom gates left out, as `to_compact_without_gates` writes it.
    pub fn without_gates(&self) -> Self {
        let mut cs = self.clone();
        cs.gates.clear();
        cs
    }

    fn compact(&self, degree: usize, gates: bool) -> Vec<u8> {
        assert!(self.lookups.is_empty() && self.shuffles.is_empty() && self.general_column_annotations.is_empty(), "not encoded");
        let mut w = W::default();
        w.u(degree);
        for n in [self.num_fixed_columns, self.num_advice_columns, self.num_instance_columns, self.num_selectors, self.num_challenges] {
            w.u(n);
        }
        w.u(self.unblinded_advice_columns.len());
        for c in &self.unblinded_advice_columns {
            w.u(*c);
        }
        for phases in [&self.advice_column_phase, &self.challenge_phase] {
            w.u(phases.len());
            for p in phases {
                w.b(p.0);
            }
        }
        w.u(self.selector_map.len());
        for c in &self.selector_map {
            w.u(c.index);
        }
        let none = vec![];
        let all = if gates { &self.gates } else { &none };
        w.u(all.len());
        for g in all {
            w.s(&g.name);
            w.u(g.constraint_names.len());
            for n in &g.constraint_names {
                w.s(n);
            }
            w.u(g.polys.len());
            for p in &g.polys {
                w.expr(p);
            }
            w.u(g.queried_selectors.len());
            for s in &g.queried_selectors {
                w.u(s.0);
                w.b(s.1 as u8);
            }
            w.u(g.queried_cells.len());
            for c in &g.queried_cells {
                w.any(&c.column);
                w.i(c.rotation.0);
            }
        }
        w.u(self.advice_queries.len());
        for (c, r) in &self.advice_queries {
            w.u(c.index);
            w.b(c.column_type.phase.0);
            w.i(r.0);
        }
        w.u(self.num_advice_queries.len());
        for n in &self.num_advice_queries {
            w.u(*n);
        }
        for queries in [
            self.instance_queries.iter().map(|(c, r)| (c.index, *r)).collect::<Vec<_>>(),
            self.fixed_queries.iter().map(|(c, r)| (c.index, *r)).collect::<Vec<_>>(),
        ] {
            w.u(queries.len());
            for (i, r) in queries {
                w.u(i);
                w.i(r.0);
            }
        }
        w.u(self.permutation.columns.len());
        for c in &self.permutation.columns {
            w.any(c);
        }
        w.u(self.constants.len());
        for c in &self.constants {
            w.u(c.index);
        }
        w.opt(self.minimum_degree);
        w.0
    }

    /// The system `to_compact` encoded and the degree given with it, or `None` if the bytes are not one.
    pub fn from_compact(b: &[u8]) -> Option<(Self, usize)> {
        let mut r = R(b);
        let degree = r.u()?;
        let mut cs = ConstraintSystem::<F>::default();
        cs.num_fixed_columns = r.u()?;
        cs.num_advice_columns = r.u()?;
        cs.num_instance_columns = r.u()?;
        cs.num_selectors = r.u()?;
        cs.num_challenges = r.u()?;
        cs.unblinded_advice_columns = r.vec(|r| r.u())?;
        cs.advice_column_phase = r.vec(|r| Some(Phase(r.b()?)))?;
        cs.challenge_phase = r.vec(|r| Some(Phase(r.b()?)))?;
        cs.selector_map = r.vec(|r| Some(Column { index: r.u()?, column_type: Fixed }))?;
        cs.gates = r.vec(|r| {
            Some(Gate {
                name: r.s()?,
                constraint_names: r.vec(|r| r.s())?,
                polys: r.vec(|r| r.expr())?,
                queried_selectors: r.vec(|r| Some(Selector(r.u()?, r.b()? != 0)))?,
                queried_cells: r.vec(|r| Some(VirtualCell { column: r.any()?, rotation: Rotation(r.i()?) }))?,
            })
        })?;
        cs.advice_queries = r.vec(|r| Some((Column { index: r.u()?, column_type: Advice { phase: Phase(r.b()?) } }, Rotation(r.i()?))))?;
        cs.num_advice_queries = r.vec(|r| r.u())?;
        cs.instance_queries = r.vec(|r| Some((Column { index: r.u()?, column_type: Instance }, Rotation(r.i()?))))?;
        cs.fixed_queries = r.vec(|r| Some((Column { index: r.u()?, column_type: Fixed }, Rotation(r.i()?))))?;
        cs.permutation = permutation::Argument { columns: r.vec(|r| r.any())? };
        cs.constants = r.vec(|r| Some(Column { index: r.u()?, column_type: Fixed }))?;
        cs.minimum_degree = r.opt()?;
        r.0.is_empty().then_some((cs, degree))
    }
}
