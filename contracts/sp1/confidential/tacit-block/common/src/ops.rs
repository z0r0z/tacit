//! Operations a spend can carry in its body instead of an exit to an address: swaps and liquidity on the chain's own pools.
//!
//! A spend proof shows that its inputs' owners signed its body hash and that its value balances (inputs and a deposit = outputs and
//! an exit); what the body says is the block program's to read. A spend whose body names an operation sends its exit's value into
//! that operation instead of to an address, so the same proof a payment uses makes a swap, and no key of the spender's is ever the
//! block's to see. What an operation makes (a swap's proceeds, liquidity shares, what a limit leaves over) comes back as notes the
//! block program makes for one-time keys the body names, each published as a leaf and a memo the spender wrote, so whose they are and
//! what they hold stay hidden, as a payment's outputs do. Whoever proves the block sees the amounts, as the confidential pool's prover
//! does; the public sees each pool's reserves move and one price a block, which is all a wallet needs to work out what its own
//! operations made.
//!
//! In a block, liquidity is added and taken out first, each at the pool's reserves and shares as the block found them (two spends
//! naming one group, one of each asset of the pool, make an addition), then each pool's swaps clear at one price for everyone in both
//! directions (orders whose limit the price misses come back and the price is found again without them). None of it depends on the
//! order of the spends in the block, so whoever builds a block cannot trade ahead of the swaps in it.
//!
//! A zap adds one asset alone: the part a lone swap would sell to leave the rest in the pool's ratio (from the pool as the block found
//! it) is sold with the block's swaps, then what is left and what it bought go in at the pool as the swaps leave it, every zap of a
//! block at that one pool. Each step is priced as an addition or a swap is (a share of the pool, or the block's one price), so a zap
//! split into many small ones makes no more shares than one. Taking liquidity out into one asset is the reverse: both assets come out
//! at the pool as the block found it, and the other one is sold with the swaps.

use super::{fr_be, fr_from_be, poseidon, BTreeSet, Fr};
use ff::FromUniformBytes;
use num_bigint::BigUint;
use sha2::{Digest, Sha256};

pub const OP_SWAP: u8 = 1;
pub const OP_ADD: u8 = 2;
pub const OP_REMOVE: u8 = 3;
pub const OP_ZAP: u8 = 4;
pub const OP_REMOVE_TO: u8 = 5;
/// Liquidity a new pool locks for good, so its share price can never be pushed to an extreme.
pub const LOCKED_LIQUIDITY: u128 = 1000;
/// The swap fee, in thousandths, on what a pool takes in.
pub const FEE_KEEP: u64 = 997;
const LP_DOMAIN: &[u8] = b"tacit-block-lp-v1";

/// A note the block program makes: whose (the one-time keys of `leaf_of`) and the hash of the memo published with it (the spender's,
/// encrypted to whoever owns the keys, so the note is found again from the keys alone), as the body names them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NoteTo {
    pub npk: Fr,
    pub rho: Fr,
    pub memo: [u8; 32],
}

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    /// Sells the exit's value for asset `want` in the pool of the two: at least `min` of it to `to`, or, if this block's price
    /// misses that, the value back to `to`.
    Swap { want: Fr, min: u64, to: NoteTo },
    /// Adds the exit's value to the pool of this asset and `other`, with the spend naming the same `group` that adds `other`: at least
    /// `min` liquidity shares to `to`, and what the pool's ratio leaves over back to `back`.
    Add { other: Fr, group: [u8; 32], min: u64, to: NoteTo, back: NoteTo },
    /// Takes the exit's value, shares of a pool, out of it: at least `min_x` and `min_y` of its two assets (smaller asset first) to
    /// `to_x` and `to_y`, or the shares back to `back`.
    Remove { min_x: u64, min_y: u64, to_x: NoteTo, to_y: NoteTo, back: NoteTo },
    /// Adds the exit's value alone to the pool of this asset and `other`: the part `zap_part` names (from the pool as the block found
    /// it) is sold for `other` with the block's swaps, at least `min` of it, then both go in at the pool as the swaps leave it, the
    /// shares to `to` and what the pool's ratio leaves over, of either asset, back to `back`; or, if the block's price misses `min`,
    /// the whole value back to `back`.
    Zap { other: Fr, min: u64, to: NoteTo, back: NoteTo },
    /// Takes the exit's value, shares of a pool, out of it into `want`, one of its assets: both come out at the pool as the block found
    /// it and the other one is sold for `want` with the block's swaps, at least `min` of `want` in all to `to`; or, if the block's
    /// price misses that, the `want` that came out to `to` and the other asset to `back`.
    RemoveTo { want: Fr, min: u64, to: NoteTo, back: NoteTo },
}

struct R<'a>(&'a [u8]);
impl R<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let (a, b) = (self.0.get(..n)?, self.0.get(n..)?);
        self.0 = b;
        Some(a)
    }
    fn fr(&mut self) -> Option<Fr> {
        fr_from_be(self.take(32)?)
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_be_bytes(self.take(8)?.try_into().ok()?))
    }
    fn to(&mut self) -> Option<NoteTo> {
        Some(NoteTo { npk: self.fr()?, rho: self.fr()?, memo: self.take(32)?.try_into().ok()? })
    }
}

impl Op {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = vec![];
        let to = |b: &mut Vec<u8>, t: &NoteTo| {
            b.extend(fr_be(&t.npk));
            b.extend(fr_be(&t.rho));
            b.extend(t.memo);
        };
        match self {
            Op::Swap { want, min, to: t } => {
                b.push(OP_SWAP);
                b.extend(fr_be(want));
                b.extend(min.to_be_bytes());
                to(&mut b, t);
            }
            Op::Add { other, group, min, to: t, back } => {
                b.push(OP_ADD);
                b.extend(fr_be(other));
                b.extend(group);
                b.extend(min.to_be_bytes());
                to(&mut b, t);
                to(&mut b, back);
            }
            Op::Remove { min_x, min_y, to_x, to_y, back } => {
                b.push(OP_REMOVE);
                b.extend(min_x.to_be_bytes());
                b.extend(min_y.to_be_bytes());
                to(&mut b, to_x);
                to(&mut b, to_y);
                to(&mut b, back);
            }
            Op::Zap { other, min, to: t, back } => {
                b.push(OP_ZAP);
                b.extend(fr_be(other));
                b.extend(min.to_be_bytes());
                to(&mut b, t);
                to(&mut b, back);
            }
            Op::RemoveTo { want, min, to: t, back } => {
                b.push(OP_REMOVE_TO);
                b.extend(fr_be(want));
                b.extend(min.to_be_bytes());
                to(&mut b, t);
                to(&mut b, back);
            }
        }
        b
    }

    /// The operation `to_bytes` wrote, all of `b`.
    pub fn from_bytes(b: &[u8]) -> Option<Op> {
        let (op, n) = Op::from_prefix(b)?;
        (n == b.len()).then_some(op)
    }

    /// The operation `to_bytes` wrote at the start of `b`, and how many bytes it took.
    pub fn from_prefix(b: &[u8]) -> Option<(Op, usize)> {
        let mut r = R(b);
        let op = match r.take(1)?[0] {
            OP_SWAP => Op::Swap { want: r.fr()?, min: r.u64()?, to: r.to()? },
            OP_ADD => Op::Add { other: r.fr()?, group: r.take(32)?.try_into().ok()?, min: r.u64()?, to: r.to()?, back: r.to()? },
            OP_REMOVE => Op::Remove { min_x: r.u64()?, min_y: r.u64()?, to_x: r.to()?, to_y: r.to()?, back: r.to()? },
            OP_ZAP => Op::Zap { other: r.fr()?, min: r.u64()?, to: r.to()?, back: r.to()? },
            OP_REMOVE_TO => Op::RemoveTo { want: r.fr()?, min: r.u64()?, to: r.to()?, back: r.to()? },
            _ => return None,
        };
        Some((op, b.len() - r.0.len()))
    }

    /// The receivers the operation names, in its order: the memos posted with a forced spend that carries it follow this order.
    pub fn receivers(&self) -> Vec<NoteTo> {
        match self {
            Op::Swap { to, .. } => vec![*to],
            Op::Add { to, back, .. } => vec![*to, *back],
            Op::Remove { to_x, to_y, back, .. } => vec![*to_x, *to_y, *back],
            Op::Zap { to, back, .. } | Op::RemoveTo { to, back, .. } => vec![*to, *back],
        }
    }
}

/// A pool of two assets (`x` the smaller field element), its reserves and its liquidity shares, all in the assets' units.
#[derive(Clone, Debug, PartialEq)]
pub struct Pool {
    pub x: Fr,
    pub y: Fr,
    pub rx: u128,
    pub ry: u128,
    pub supply: u128,
}

pub const POOL_LEN: usize = 32 + 32 + 16 + 16 + 16;

impl Pool {
    pub fn to_bytes(&self) -> Vec<u8> {
        [fr_be(&self.x).to_vec(), fr_be(&self.y).to_vec(), self.rx.to_be_bytes().to_vec(), self.ry.to_be_bytes().to_vec(), self.supply.to_be_bytes().to_vec()].concat()
    }

    pub fn from_bytes(b: &[u8]) -> Option<Pool> {
        if b.len() != POOL_LEN {
            return None;
        }
        let u = |i: usize| u128::from_be_bytes(b[i..i + 16].try_into().unwrap());
        let (x, y) = (fr_from_be(&b[..32])?, fr_from_be(&b[32..64])?);
        (fr_be(&x) < fr_be(&y)).then_some(Pool { x, y, rx: u(64), ry: u(80), supply: u(96) })
    }

    pub fn shares(&self) -> Fr {
        lp_asset(&self.x, &self.y)
    }
}

/// The asset field of the shares of the pool of `x` and `y` (in either order): no token deposited on L1 has it, so shares never leave
/// the chain.
pub fn lp_asset(x: &Fr, y: &Fr) -> Fr {
    let (a, b) = order(x, y);
    let mut wide = [0u8; 64];
    for (i, half) in wide.chunks_mut(32).enumerate() {
        let mut h = Sha256::new();
        h.update(LP_DOMAIN);
        h.update(fr_be(&a));
        h.update(fr_be(&b));
        h.update([i as u8]);
        half.copy_from_slice(&h.finalize());
    }
    Fr::from_uniform_bytes(&wide)
}

fn order(a: &Fr, b: &Fr) -> (Fr, Fr) {
    if fr_be(a) < fr_be(b) {
        (*a, *b)
    } else {
        (*b, *a)
    }
}

/// What a spend sends into an operation: its asset, the exit's value and the operation.
#[derive(Clone, Debug)]
pub struct Intent {
    pub asset: Fr,
    pub amount: u64,
    pub op: Op,
}

/// A note an operation makes: its asset, value and keys.
#[derive(Clone, Debug, PartialEq)]
pub struct Made {
    pub asset: Fr,
    pub value: u64,
    pub to: NoteTo,
}

impl Made {
    pub fn leaf(&self) -> Fr {
        poseidon(&[self.asset, Fr::from(self.value), self.to.npk, self.to.rho])
    }
}

/// A pool a block changed, as published: the pool as the block leaves it, the price its swaps cleared at (of x in y, as numerator and
/// denominator, 32 bytes each; both zero when nothing traded), then its reserves and shares as the swaps left it, before any zap went
/// in (16 bytes each): what a wallet needs, beside the pool as the block found it, to work out what each of its operations made.
pub fn change_bytes(p: &Pool, price: &Option<(BigUint, BigUint)>, mid: &Pool) -> Vec<u8> {
    let w = |v: &BigUint| {
        let b = v.to_bytes_be();
        let mut out = [0u8; 32];
        out[32 - b.len()..].copy_from_slice(&b);
        out
    };
    let (n, d) = match price {
        Some((n, d)) => (w(n), w(d)),
        None => ([0u8; 32], [0u8; 32]),
    };
    [p.to_bytes(), n.to_vec(), d.to_vec(), mid.rx.to_be_bytes().to_vec(), mid.ry.to_be_bytes().to_vec(), mid.supply.to_be_bytes().to_vec()].concat()
}

pub const CHANGE_LEN: usize = POOL_LEN + 64 + 48;

/// How much of `a` a zap sells, from the reserve `r` of what it sells in the pool as the block found it: the part a lone swap at the
/// pool's fee would sell to leave the rest and what it buys in the pool's ratio, the root of γs² + (1 + γ)rs − ar = 0 (γ = FEE_KEEP
/// / 1000), rounded down. It is below `a`.
pub fn zap_part(a: u64, r: u128) -> u64 {
    let (g, k) = (BigUint::from(FEE_KEEP), BigUint::from(1000u32));
    let (a, r) = (BigUint::from(a), big(r));
    let kg = &k + &g;
    let d = &kg * &kg * &r * &r + BigUint::from(4u8) * &g * &k * &a * &r;
    // d ≥ ((k + g)r)², so its root is at least (k + g)r
    note(&((d.sqrt() - &kg * &r) / (BigUint::from(2u8) * &g))).unwrap_or(0)
}

fn big(v: u128) -> BigUint {
    BigUint::from(v)
}

/// A value as a note can hold it, if it fits.
fn note(v: &BigUint) -> Option<u64> {
    u64::try_from(v).ok()
}

/// Where an order's proceeds go: a swap's to its receiver, a zap's into its addition, a removal into one asset's (`run`'s `outs`) to
/// its receiver with what came out of that asset.
#[derive(Clone, Copy)]
enum Leg {
    Swap(NoteTo),
    Zap,
    Out(usize),
}

struct Order {
    i: usize,
    amount: u64,
    min: u64,
    sells_x: bool,
    leg: Leg,
}

/// A removal into one asset once its liquidity came out: its pool's pair, what came out of the asset it wants and of the other, the
/// least of `want` it takes in all, and its receivers.
struct Out {
    i: usize,
    pair: (Fr, Fr),
    want_x: bool,
    o_want: u64,
    o_other: u64,
    min: u64,
    to: NoteTo,
    back: NoteTo,
}

/// Runs a block's operations on `pools` (sorted by pair). → the pools as the block leaves them (sorted), the notes the operations make
/// (in the order of `intents`; what did not go through comes back) and the pools it changed as published (`change_bytes`, by pair).
pub fn run(pools: &[Pool], intents: &[Intent]) -> (Vec<Pool>, Vec<Made>, Vec<Vec<u8>>) {
    // the pools as the block found them, which liquidity is priced at
    let start = pools.to_vec();
    let mut pools = pools.to_vec();
    let mut made: Vec<(usize, Made)> = vec![];
    let mut touched: BTreeSet<[u8; 64]> = BTreeSet::new();
    let mut prices: Vec<([u8; 64], (BigUint, BigUint))> = vec![];
    let key = |x: &Fr, y: &Fr| -> [u8; 64] { [fr_be(x), fr_be(y)].concat().try_into().unwrap() };
    let find = |pools: &[Pool], a: &Fr, b: &Fr| -> Option<usize> {
        let (x, y) = order(a, b);
        pools.iter().position(|p| p.x == x && p.y == y)
    };
    let give = |made: &mut Vec<(usize, Made)>, i: usize, asset: Fr, value: u64, to: NoteTo| {
        if value > 0 {
            made.push((i, Made { asset, value, to }));
        }
    };

    // 1. Liquidity taken out, in proportion to the shares, at the pool as the block found it: a removal into one asset keeps what came
    // out for the swaps.
    let mut outs: Vec<Out> = vec![];
    for (i, it) in intents.iter().enumerate() {
        let (back, want) = match &it.op {
            Op::Remove { back, .. } => (*back, None),
            Op::RemoveTo { want, back, .. } => (*back, Some(*want)),
            _ => continue,
        };
        let Some(k) = start.iter().position(|p| p.shares() == it.asset) else {
            give(&mut made, i, it.asset, it.amount, back);
            continue;
        };
        let p0 = &start[k];
        let e = big(it.amount as u128);
        let (ox, oy) = (note(&(&e * big(p0.rx) / big(p0.supply))), note(&(&e * big(p0.ry) / big(p0.supply))));
        let ok = match (&it.op, ox, oy) {
            _ if (it.amount as u128) >= p0.supply => false,
            (Op::Remove { min_x, min_y, .. }, Some(ox), Some(oy)) => ox >= *min_x && oy >= *min_y,
            // a removal into one asset that would sell nothing takes its minimum from what comes out
            (Op::RemoveTo { min, .. }, Some(ox), Some(oy)) => match want {
                Some(w) if w == p0.x => oy > 0 || ox >= *min,
                Some(w) if w == p0.y => ox > 0 || oy >= *min,
                _ => false,
            },
            _ => false,
        };
        let (Some(ox), Some(oy), true) = (ox, oy, ok) else {
            give(&mut made, i, it.asset, it.amount, back);
            continue;
        };
        let (x, y) = (p0.x, p0.y);
        let at = find(&pools, &x, &y).expect("a pool the block found");
        let p = &mut pools[at];
        p.rx -= ox as u128;
        p.ry -= oy as u128;
        p.supply -= it.amount as u128;
        touched.insert(key(&x, &y));
        match &it.op {
            Op::Remove { to_x, to_y, .. } => {
                give(&mut made, i, x, ox, *to_x);
                give(&mut made, i, y, oy, *to_y);
            }
            Op::RemoveTo { min, to, .. } => {
                let want_x = want == Some(x);
                let (o_want, o_other) = if want_x { (ox, oy) } else { (oy, ox) };
                outs.push(Out { i, pair: (x, y), want_x, o_want, o_other, min: *min, to: *to, back });
            }
            _ => unreachable!(),
        }
    }

    // 2. Liquidity added: the first two spends that name one group, add the pool's two assets, name each other's asset and the same
    // minimum and receiver make one addition (one owner's two spends, as a spend holds one asset), priced at the pool as the block found
    // it. A pool the block makes is made by the first such addition of its pair alone.
    let mut paired = vec![false; intents.len()];
    for i in 0..intents.len() {
        let it = &intents[i];
        let Op::Add { other, group, min, to, .. } = &it.op else { continue };
        if paired[i] || it.asset == *other {
            continue;
        }
        let partner = (i + 1..intents.len()).find(|&j| {
            !paired[j]
                && intents[j].asset == *other
                && matches!(&intents[j].op, Op::Add { other: o2, group: g2, min: m2, to: t2, .. } if g2 == group && *o2 == it.asset && m2 == min && t2 == to)
        });
        let Some(j) = partner else { continue };
        paired[i] = true;
        paired[j] = true;
        let ((xi, xa), (yi, ya)) = if fr_be(&it.asset) < fr_be(&intents[j].asset) { ((i, it), (j, &intents[j])) } else { ((j, &intents[j]), (i, it)) };
        let (Op::Add { back: back_x, .. }, Op::Add { back: back_y, .. }) = (&xa.op, &ya.op) else { unreachable!() };
        let (ex, ey) = (xa.amount as u128, ya.amount as u128);
        let made_here = find(&start, &xa.asset, &ya.asset).is_none() && find(&pools, &xa.asset, &ya.asset).is_some();
        // (shares made, x and y the pool takes)
        let (shares, ux, uy) = match find(&start, &xa.asset, &ya.asset) {
            _ if made_here => (0, 0, 0),
            None => {
                let s = u128::try_from((big(ex) * big(ey)).sqrt()).unwrap_or(0);
                if s <= LOCKED_LIQUIDITY {
                    (0, 0, 0)
                } else {
                    (s - LOCKED_LIQUIDITY, ex, ey)
                }
            }
            Some(k) => {
                let p = &start[k];
                let s = (big(ex) * big(p.supply) / big(p.rx)).min(big(ey) * big(p.supply) / big(p.ry));
                let ceil = |r: u128| (&s * big(r) + big(p.supply) - 1u8) / big(p.supply);
                match (u128::try_from(&s), u128::try_from(&ceil(p.rx)), u128::try_from(&ceil(p.ry))) {
                    (Ok(s), Ok(ux), Ok(uy)) if ux <= ex && uy <= ey => (s, ux, uy),
                    _ => (0, 0, 0),
                }
            }
        };
        match u64::try_from(shares) {
            Ok(s) if s > 0 && s >= *min => {
                match find(&pools, &xa.asset, &ya.asset) {
                    None => {
                        let p = Pool { x: xa.asset, y: ya.asset, rx: ux, ry: uy, supply: shares + LOCKED_LIQUIDITY };
                        let pos = pools.iter().position(|q| key(&q.x, &q.y) > key(&p.x, &p.y)).unwrap_or(pools.len());
                        pools.insert(pos, p);
                    }
                    Some(k) => {
                        let p = &mut pools[k];
                        p.rx += ux;
                        p.ry += uy;
                        p.supply += shares;
                    }
                }
                touched.insert(key(&xa.asset, &ya.asset));
                give(&mut made, xi.min(yi), lp_asset(&xa.asset, &ya.asset), s, *to);
                give(&mut made, xi, xa.asset, (ex - ux) as u64, *back_x);
                give(&mut made, yi, ya.asset, (ey - uy) as u64, *back_y);
            }
            _ => {
                give(&mut made, xi, xa.asset, xa.amount, *back_x);
                give(&mut made, yi, ya.asset, ya.amount, *back_y);
            }
        }
    }
    // an addition no partner made: its value back
    for (i, it) in intents.iter().enumerate() {
        if let (Op::Add { back, .. }, false) = (&it.op, paired[i]) {
            give(&mut made, i, it.asset, it.amount, *back);
        }
    }

    // 3. Each pool's swaps, cleared at one price on the reserves liquidity left: the swaps themselves, the part of each zap it sells
    // (from the pool as the block found it, so a pool the block makes takes no zap) and the other asset of each removal into one.
    let mut orders: Vec<Vec<Order>> = (0..pools.len()).map(|_| vec![]).collect();
    for (i, it) in intents.iter().enumerate() {
        match &it.op {
            Op::Swap { want, min, to } => match (it.asset != *want).then(|| find(&pools, &it.asset, want)).flatten() {
                Some(k) => orders[k].push(Order { i, amount: it.amount, min: *min, sells_x: pools[k].x == it.asset, leg: Leg::Swap(*to) }),
                None => give(&mut made, i, it.asset, it.amount, *to),
            },
            Op::Zap { other, min, back, .. } => {
                let found = (it.asset != *other).then(|| find(&start, &it.asset, other)).flatten();
                let sell = found.map(|k| zap_part(it.amount, if start[k].x == it.asset { start[k].rx } else { start[k].ry })).unwrap_or(0);
                match find(&pools, &it.asset, other) {
                    Some(k) if found.is_some() && sell > 0 && sell < it.amount => {
                        orders[k].push(Order { i, amount: sell, min: *min, sells_x: pools[k].x == it.asset, leg: Leg::Zap })
                    }
                    _ => give(&mut made, i, it.asset, it.amount, *back),
                }
            }
            _ => {}
        }
    }
    for (j, o) in outs.iter().enumerate() {
        let k = find(&pools, &o.pair.0, &o.pair.1).expect("a pool the block found");
        if o.o_other == 0 {
            give(&mut made, o.i, if o.want_x { o.pair.0 } else { o.pair.1 }, o.o_want, o.to);
        } else {
            orders[k].push(Order { i: o.i, amount: o.o_other, min: o.min.saturating_sub(o.o_want), sells_x: !o.want_x, leg: Leg::Out(j) });
        }
    }
    // what each zap's sold part bought: (intent, pool, sold, bought)
    let mut zapped: Vec<(usize, usize, u64, u64)> = vec![];
    for (k, list) in orders.into_iter().enumerate() {
        if list.is_empty() {
            continue;
        }
        let p = pools[k].clone();
        let (fills, refunds, rx, ry, price) = clear(&p, &list);
        for (o, out) in fills {
            let bought = if o.sells_x { p.y } else { p.x };
            match o.leg {
                Leg::Swap(to) => give(&mut made, o.i, bought, out, to),
                Leg::Zap => zapped.push((o.i, k, o.amount, out)),
                Leg::Out(j) => {
                    let w = &outs[j];
                    match w.o_want.checked_add(out) {
                        Some(all) => give(&mut made, o.i, bought, all, w.to),
                        None => {
                            give(&mut made, o.i, bought, w.o_want, w.to);
                            give(&mut made, o.i, bought, out, w.to);
                        }
                    }
                }
            }
        }
        for o in refunds {
            let (sold, bought) = if o.sells_x { (p.x, p.y) } else { (p.y, p.x) };
            match o.leg {
                Leg::Swap(to) => give(&mut made, o.i, sold, o.amount, to),
                Leg::Zap => {
                    let Op::Zap { back, .. } = &intents[o.i].op else { unreachable!() };
                    give(&mut made, o.i, sold, intents[o.i].amount, *back);
                }
                Leg::Out(j) => {
                    let w = &outs[j];
                    give(&mut made, o.i, bought, w.o_want, w.to);
                    give(&mut made, o.i, sold, o.amount, w.back);
                }
            }
        }
        if let Some(price) = price {
            pools[k].rx = rx;
            pools[k].ry = ry;
            touched.insert(key(&p.x, &p.y));
            prices.push((key(&p.x, &p.y), price));
        }
    }

    // 4. Each zap's rest and what its sold part bought go in, all of a block's zaps at the pool as the swaps leave it (`mid`): a share of
    // the pool for its share of the reserves, as an addition is priced, and what the ratio leaves over back.
    let mid = pools.clone();
    for (i, k, sold, bought) in zapped {
        let it = &intents[i];
        let Op::Zap { to, back, .. } = &it.op else { unreachable!() };
        let p = &mid[k];
        let left = (it.amount - sold) as u128;
        let (ex, ey) = if p.x == it.asset { (left, bought as u128) } else { (bought as u128, left) };
        let s = (big(ex) * big(p.supply) / big(p.rx)).min(big(ey) * big(p.supply) / big(p.ry));
        let ceil = |r: u128| (&s * big(r) + big(p.supply) - 1u8) / big(p.supply);
        let took = match (u64::try_from(&s), u128::try_from(&ceil(p.rx)), u128::try_from(&ceil(p.ry))) {
            (Ok(s), Ok(ux), Ok(uy)) if s > 0 && ux <= ex && uy <= ey => Some((s, ux, uy)),
            _ => None,
        };
        let (x, y) = (p.x, p.y);
        match took {
            Some((s, ux, uy)) => {
                let q = &mut pools[k];
                q.rx += ux;
                q.ry += uy;
                q.supply += s as u128;
                touched.insert(key(&x, &y));
                give(&mut made, i, lp_asset(&x, &y), s, *to);
                give(&mut made, i, x, (ex - ux) as u64, *back);
                give(&mut made, i, y, (ey - uy) as u64, *back);
            }
            None => {
                give(&mut made, i, x, ex as u64, *back);
                give(&mut made, i, y, ey as u64, *back);
            }
        }
    }

    made.sort_by_key(|(i, _)| *i);
    let changes = pools
        .iter()
        .zip(&mid)
        .filter(|(p, _)| touched.contains(&key(&p.x, &p.y)))
        .map(|(p, m)| change_bytes(p, &prices.iter().find(|(k, _)| *k == key(&p.x, &p.y)).map(|(_, v)| v.clone()), m))
        .collect();
    (pools, made.into_iter().map(|(_, m)| m).collect(), changes)
}

/// One pool's swaps at one price P (of x in y) for both directions: with the pool's fee on what it takes in, P = γ(ry + ay)/(rx + γ ax)
/// when more x is sold than the y sold buys at that price, P = (ry + γ ay)/(γ(rx + ax)) when more y is sold, and ay/ax when the two
/// directions meet between those (the pool is then not traded). Payouts are rounded down, so the pool never pays out more than the
/// curve allows. Orders whose limit P misses come back, and P is found again without them, until every order left is filled.
/// → (filled orders with their payouts, orders that come back, the pool's reserves after, the price when anything filled).
#[allow(clippy::type_complexity)]
fn clear<'a>(p: &Pool, orders: &'a [Order]) -> (Vec<(&'a Order, u64)>, Vec<&'a Order>, u128, u128, Option<(BigUint, BigUint)>) {
    let (kn, kd) = (BigUint::from(FEE_KEEP), BigUint::from(1000u32));
    let mut live: Vec<&Order> = orders.iter().collect();
    let mut back: Vec<&Order> = vec![];
    loop {
        let ax: BigUint = live.iter().filter(|o| o.sells_x).map(|o| BigUint::from(o.amount)).sum();
        let ay: BigUint = live.iter().filter(|o| !o.sells_x).map(|o| BigUint::from(o.amount)).sum();
        if live.is_empty() {
            return (vec![], back, p.rx, p.ry, None);
        }
        let (rx, ry) = (big(p.rx), big(p.ry));
        // P as num/den, from the case the flows fall in
        let (an, ad) = (&kn * (&ry + &ay), &kd * &rx + &kn * &ax);
        let (bn, bd) = (&kd * &ry + &kn * &ay, &kn * (&rx + &ax));
        let zero = BigUint::from(0u8);
        let (num, den) = if ax == zero {
            (bn, bd)
        } else if ay == zero || &ay * &ad <= &an * &ax {
            (an, ad)
        } else if &ay * &bd >= &bn * &ax {
            (bn, bd)
        } else {
            (ay.clone(), ax.clone())
        };
        let pay = |o: &Order| -> Option<u64> {
            let a = BigUint::from(o.amount);
            let out = if o.sells_x { &a * &num / &den } else { &a * &den / &num };
            note(&out)
        };
        let (keep, miss): (Vec<&Order>, Vec<&Order>) = live.iter().partition(|o| pay(o).is_some_and(|v| v >= o.min && v > 0));
        if miss.is_empty() {
            let fills: Vec<(&Order, u64)> = keep.iter().map(|o| (*o, pay(o).unwrap())).collect();
            let paid_y: u128 = fills.iter().filter(|(o, _)| o.sells_x).map(|(_, v)| *v as u128).sum();
            let paid_x: u128 = fills.iter().filter(|(o, _)| !o.sells_x).map(|(_, v)| *v as u128).sum();
            let in_x: u128 = keep.iter().filter(|o| o.sells_x).map(|o| o.amount as u128).sum();
            let in_y: u128 = keep.iter().filter(|o| !o.sells_x).map(|o| o.amount as u128).sum();
            let (nx, ny) = (p.rx + in_x - paid_x, p.ry + in_y - paid_y);
            // what the derivation guarantees, held to anyway: a clearing that would shrink the pool's product takes nothing
            if big(nx) * big(ny) < big(p.rx) * big(p.ry) {
                back.extend(keep);
                return (vec![], back, p.rx, p.ry, None);
            }
            return (fills, back, nx, ny, Some((num, den)));
        }
        back.extend(miss);
        live = keep;
    }
}
