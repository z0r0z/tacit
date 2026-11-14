//! What the TacProvenOracle program proves.
//!
//! From the block headers between the oldest interval it needs and an anchor block (each linked to the next by its
//! parent hash) and the two venues' account and storage proofs at each interval's sample block, it computes what
//! TacPairOracle answers over TacBlockOracle and TacAmmOracle with every interval from X - MAX_POINTS to X recorded and
//! none after, and returns the public values TacProvenOracle.record takes.
//!
//! An interval is unrecorded only where the chain makes it so: the venue's account or one of its two slots is absent
//! (proven by an exclusion proof), or its values fail the venue oracle's own checks. Every interval in range must come
//! with its proofs, so the answers for a given X are fixed by the chain.

use alloy_primitives::{keccak256, Address, Bytes, B256, U256, U512};
use alloy_rlp::Header as RlpHeader;
use alloy_trie::{proof::verify_proof, Nibbles, TrieAccount};
use serde::{Deserialize, Serialize};

pub const BPS: u64 = 10_000;
/// Answer words a proof may carry.
pub const SPAN: u64 = 8;
/// The Precision pool's packed reserves (reserve0 low, reserve1 high) and its LP supply (solady ERC20's slot).
pub const RESERVES_SLOT: B256 = B256::ZERO;
pub const SUPPLY_SLOT: B256 = B256::new([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x34, 0x5c, 0xdf, 0x77, 0xeb, 0x68, 0xf4, 0x4c,
]);

fn wad() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}

// The venue oracles' bound on a stored price or depth: 2^104 - 1.
fn mask() -> U256 {
    (U256::from(1) << 104) - U256::from(1)
}

/// The venues, slots, scales and windows, as TacProvenOracle stores them; `digest` is its CONFIG.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    pub step: u64,
    pub short_points: u64,
    pub window_points: u64,
    pub max_points: u64,
    pub min_coverage_bps: u64,
    pub precision: Address,
    pub sqrt_p_low: U256,
    pub sqrt_p_high: U256,
    pub pool: Address,
    pub slot_a: B256,
    pub slot_b: B256,
    pub eth_scale: U256,
    pub tac_scale: U256,
}

impl Config {
    /// keccak256(abi.encode(...)) in TacProvenOracle's order.
    pub fn digest(&self) -> B256 {
        let mut b = Vec::with_capacity(15 * 32);
        for w in [
            U256::from(self.step),
            U256::from(self.short_points),
            U256::from(self.window_points),
            U256::from(self.max_points),
            U256::from(self.min_coverage_bps),
        ] {
            b.extend_from_slice(&w.to_be_bytes::<32>());
        }
        b.extend_from_slice(self.precision.into_word().as_slice());
        b.extend_from_slice(RESERVES_SLOT.as_slice());
        b.extend_from_slice(SUPPLY_SLOT.as_slice());
        b.extend_from_slice(&self.sqrt_p_low.to_be_bytes::<32>());
        b.extend_from_slice(&self.sqrt_p_high.to_be_bytes::<32>());
        b.extend_from_slice(self.pool.into_word().as_slice());
        b.extend_from_slice(self.slot_a.as_slice());
        b.extend_from_slice(self.slot_b.as_slice());
        b.extend_from_slice(&self.eth_scale.to_be_bytes::<32>());
        b.extend_from_slice(&self.tac_scale.to_be_bytes::<32>());
        keccak256(b)
    }

    fn check(&self) -> Result<(), Error> {
        let p = (self.short_points, self.window_points, self.max_points);
        if self.step == 0 || p.0 == 0 || p.1 < p.0 || p.2 < p.1 || self.min_coverage_bps == 0 {
            return Err(Error::Config);
        }
        if self.min_coverage_bps > BPS || self.sqrt_p_high.is_zero() || self.sqrt_p_low.is_zero() {
            return Err(Error::Config);
        }
        Ok(())
    }
}

/// An account as `eth_getProof` gives it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub nonce: u64,
    pub balance: U256,
    pub storage_root: B256,
    pub code_hash: B256,
}

/// A storage slot's value (zero for an absent slot) and its proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Slot {
    pub value: U256,
    pub proof: Vec<Bytes>,
}

/// A venue at a sample block: its account (None for an absent account, with an exclusion proof) and its two slots in
/// the order the venue oracle proves them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Venue {
    pub account: Option<Account>,
    pub account_proof: Vec<Bytes>,
    pub slots: Vec<Slot>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Input {
    pub config: Config,
    /// The newest interval proven.
    pub x: u64,
    /// Answer words, for N from x - 1.
    pub count: u64,
    /// The number of `headers[0]`.
    pub first_block: u64,
    /// RLP headers, consecutive, the last one the anchor.
    pub headers: Vec<Bytes>,
    /// For each interval from x - max_points to x, the Precision venue then the AMM venue at its sample block.
    pub intervals: Vec<Vec<Venue>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Config,
    Range,
    Header,
    Chain,
    Proof,
}

impl From<alloy_rlp::Error> for Error {
    fn from(_: alloy_rlp::Error) -> Self {
        Error::Header
    }
}

/// A sample: ETH per TAC (1e18) and ETH depth (wei).
pub type Sample = Option<(U256, U256)>;

/// The public values for `input`.
pub fn public_values(input: &Input) -> Result<Vec<u8>, Error> {
    let c = &input.config;
    c.check()?;
    let x = input.x;
    if input.count < 2 || input.count > SPAN || x <= c.max_points || x > u32::MAX as u64 {
        return Err(Error::Range);
    }
    let lo = x - c.max_points;
    if input.intervals.len() as u64 != c.max_points + 1 || input.headers.is_empty() {
        return Err(Error::Range);
    }

    // The headers: consecutive numbers, each the parent of the next.
    let mut roots = Vec::with_capacity(input.headers.len());
    let mut mixes = Vec::with_capacity(input.headers.len());
    let mut prev: Option<B256> = None;
    for (k, raw) in input.headers.iter().enumerate() {
        let h = header(raw)?;
        if h.number != input.first_block + k as u64 || prev.is_some_and(|p| p != h.parent) {
            return Err(Error::Chain);
        }
        prev = Some(h.hash);
        roots.push(h.state_root);
        mixes.push(h.mix);
    }
    let anchor = input.first_block + input.headers.len() as u64 - 1;
    let anchor_hash = prev.ok_or(Error::Chain)?;
    if anchor > u32::MAX as u64 {
        return Err(Error::Range);
    }
    let at = |n: u64| -> Result<usize, Error> {
        if n < input.first_block || n > anchor {
            return Err(Error::Range);
        }
        Ok((n - input.first_block) as usize)
    };

    // Each interval's sample block (the next interval's first block's mixHash picks it) and both venues there.
    let mut a: Vec<Sample> = Vec::with_capacity(input.intervals.len());
    let mut b: Vec<Sample> = Vec::with_capacity(input.intervals.len());
    for (k, venues) in input.intervals.iter().enumerate() {
        let i = lo + k as u64;
        if venues.len() != 2 {
            return Err(Error::Range);
        }
        let mix = U256::from_be_bytes(mixes[at((i + 1) * c.step)?].0);
        let sample = i * c.step + (mix % U256::from(c.step)).to::<u64>();
        let root = roots[at(sample)?];
        a.push(venue(c, false, root, &venues[0])?);
        b.push(venue(c, true, root, &venues[1])?);
    }

    let samples = Samples { c, x, lo, a: &a, b: &b };
    let mut pv = Vec::with_capacity(64 + 32 * input.count as usize);
    let mut bound = Vec::with_capacity(64);
    bound.extend_from_slice(anchor_hash.as_slice());
    bound.extend_from_slice(c.digest().as_slice());
    pv.extend_from_slice(keccak256(bound).as_slice());
    pv.extend_from_slice(&samples.head(input.count, anchor).to_be_bytes::<32>());
    for j in 0..input.count {
        pv.extend_from_slice(&samples.word(x - 1 + j).to_be_bytes::<32>());
    }
    Ok(pv)
}

/// Every venue sample from interval `lo` to `x`, and the answers they give.
pub struct Samples<'a> {
    pub c: &'a Config,
    pub x: u64,
    pub lo: u64,
    pub a: &'a [Sample],
    pub b: &'a [Sample],
}

impl Samples<'_> {
    fn get(&self, venue: &[Sample], i: u64) -> Sample {
        if i > self.x || i < self.lo {
            return None;
        }
        venue[(i - self.lo) as usize]
    }

    /// A venue's lower and upper median over `points` intervals with N the newest, as TacIntervalOracle.prices.
    pub fn median(&self, venue: &[Sample], n: u64, points: u64) -> Option<(U256, U256)> {
        let mut found: Vec<U256> =
            (0..points.min(n + 1)).filter_map(|i| self.get(venue, n - i).map(|(p, _)| p)).collect();
        let k = found.len() as u64;
        if k * BPS < points * self.c.min_coverage_bps || (points - 1) / 2 < points - k || points / 2 >= k {
            return None;
        }
        found.sort();
        Some((found[((points - 1) / 2 - (points - k)) as usize], found[(points / 2) as usize]))
    }

    /// A venue's smallest depth over MAX_POINTS with N the newest, every interval recorded, as depthMin.
    pub fn depth(&self, venue: &[Sample], n: u64) -> Option<U256> {
        let p = self.c.max_points;
        (0..p).map(|i| self.get(venue, n.checked_sub(i)?).map(|(_, d)| d)).collect::<Option<Vec<_>>>()?.into_iter().min()
    }

    /// A venue's newest recorded price within MAX_POINTS of X, as latest() when X is the newest interval; 0 if none.
    pub fn latest(&self, venue: &[Sample]) -> U256 {
        (0..self.c.max_points.min(self.x + 1)).find_map(|i| self.get(venue, self.x - i).map(|(p, _)| p)).unwrap_or_default()
    }

    /// The answer word for N: (low, high, recovery) for each window, 84 bits apart; zeros where the pair reverts.
    pub fn word(&self, n: u64) -> U256 {
        let c = self.c;
        let mut word = U256::ZERO;
        for (k, points) in [c.short_points, c.window_points, c.max_points].into_iter().enumerate() {
            if let (Some(pa), Some(pb)) = (self.median(self.a, n, points), self.median(self.b, n, points)) {
                let (lo, hi, rec) = (pa.0.min(pb.0), pa.1.max(pb.1), pa.0.max(pb.0));
                let f = pack(lo, 20) | pack(hi, 20) << 28 | pack(rec, 20) << 56;
                word |= f << (84 * k);
            }
        }
        word
    }

    /// The head: X, X - 1, count, latest, depth at X - 1 and at X, the anchor.
    pub fn head(&self, count: u64, anchor: u64) -> U256 {
        let x = self.x;
        let depth = |n: u64| match (self.depth(self.a, n), self.depth(self.b, n)) {
            (Some(da), Some(db)) => pack(da.min(db), 24),
            _ => U256::ZERO,
        };
        let latest = pack(self.latest(self.a).min(self.latest(self.b)), 24);
        U256::from(x)
            | U256::from(x - 1) << 32
            | U256::from(count) << 64
            | latest << 72
            | depth(x - 1) << 104
            | depth(x) << 136
            | U256::from(anchor) << 168
    }
}

/// `v` as a float of `m` mantissa bits plus an 8-bit exponent: exponent 0 holds the value, e > 0 an implicit leading
/// one shifted by e - 1. Truncates.
pub fn pack(v: U256, m: usize) -> U256 {
    let one = U256::from(1) << m;
    if v < one << 1 {
        return if v < one { v } else { one | (v - one) };
    }
    let shift = 255 - v.leading_zeros() - m;
    U256::from(shift + 1) << m | ((v >> shift) & (one - U256::from(1)))
}

pub fn unpack(p: U256, m: usize) -> U256 {
    let one = U256::from(1) << m;
    let e = (p >> m).to::<usize>();
    let v = p & (one - U256::from(1));
    if e == 0 {
        v
    } else {
        (v | one) << (e - 1)
    }
}

struct Hdr {
    parent: B256,
    state_root: B256,
    number: u64,
    mix: B256,
    hash: B256,
}

// A post-merge header: parentHash (0), stateRoot (3) and mixHash (13) of 32 bytes, number (8), nonce (14) of 8, at
// least 15 fields, as the venue oracles require. Other fields may be anything, lists included.
fn header(raw: &Bytes) -> Result<Hdr, Error> {
    let mut buf: &[u8] = raw;
    let list = RlpHeader::decode(&mut buf)?;
    if !list.list || list.payload_length != buf.len() {
        return Err(Error::Header);
    }
    let mut fields: Vec<Option<&[u8]>> = Vec::with_capacity(21);
    while !buf.is_empty() {
        let h = RlpHeader::decode(&mut buf)?;
        if h.payload_length > buf.len() {
            return Err(Error::Header);
        }
        let (v, rest) = buf.split_at(h.payload_length);
        fields.push((!h.list).then_some(v));
        buf = rest;
    }
    let field = |i: usize, len: Option<usize>| -> Result<&[u8], Error> {
        let f = fields.get(i).copied().flatten().ok_or(Error::Header)?;
        if len.is_some_and(|l| f.len() != l) || f.len() > 32 {
            return Err(Error::Header);
        }
        Ok(f)
    };
    if fields.len() < 15 {
        return Err(Error::Header);
    }
    let (parent, state_root, mix) = (field(0, Some(32))?, field(3, Some(32))?, field(13, Some(32))?);
    field(14, Some(8))?;
    let number_bytes = field(8, None)?;
    if number_bytes.len() > 8 {
        return Err(Error::Header);
    }
    let number = number_bytes.iter().fold(0u64, |n, b| n << 8 | *b as u64);
    Ok(Hdr {
        parent: B256::from_slice(parent),
        state_root: B256::from_slice(state_root),
        number,
        mix: B256::from_slice(mix),
        hash: keccak256(raw),
    })
}

// A venue's sample at state root `root`, or None where the venue oracle could not record it.
fn venue(c: &Config, amm: bool, root: B256, v: &Venue) -> Result<Sample, Error> {
    let (addr, slots) = if amm { (c.pool, [c.slot_a, c.slot_b]) } else { (c.precision, [RESERVES_SLOT, SUPPLY_SLOT]) };
    let key = Nibbles::unpack(keccak256(addr));
    let Some(acc) = &v.account else {
        verify_proof(root, key, None, &v.account_proof).map_err(|_| Error::Proof)?;
        return Ok(None);
    };
    let encoded = alloy_rlp::encode(TrieAccount {
        nonce: acc.nonce,
        balance: acc.balance,
        storage_root: acc.storage_root,
        code_hash: acc.code_hash,
    });
    verify_proof(root, key, Some(encoded), &v.account_proof).map_err(|_| Error::Proof)?;
    if v.slots.len() != 2 {
        return Err(Error::Range);
    }
    let mut values = [U256::ZERO; 2];
    let mut present = true;
    for (j, s) in v.slots.iter().enumerate() {
        let k = Nibbles::unpack(keccak256(slots[j]));
        let expected = if s.value.is_zero() { None } else { Some(alloy_rlp::encode(s.value)) };
        verify_proof(acc.storage_root, k, expected, &s.proof).map_err(|_| Error::Proof)?;
        present &= !s.value.is_zero();
        values[j] = s.value;
    }
    if !present {
        return Ok(None);
    }
    let read = if amm { amm_read(c, values[0], values[1]) } else { precision_read(c, values[0], values[1]) };
    Ok(read.filter(|(p, d)| !p.is_zero() && *p <= mask() && *d <= mask()))
}

// TacBlockOracle._read: virtual reserves ETH = L·1e18/sqrtPHigh + reserve0, TAC = L·sqrtPLow/1e18 + reserve1.
fn precision_read(c: &Config, reserves: U256, supply: U256) -> Sample {
    let r0 = reserves & ((U256::from(1) << 128) - U256::from(1));
    let r1 = reserves >> 128;
    let eth = supply.checked_mul(wad())?.checked_div(c.sqrt_p_high)?.checked_add(r0)?;
    let tac = supply.checked_mul(c.sqrt_p_low)?.checked_div(wad())?.checked_add(r1)?;
    if supply.is_zero() || tac.is_zero() {
        return None;
    }
    Some((full_mul_div(eth, wad(), tac)?, eth))
}

// TacAmmOracle._read: reserves scaled from value units to wei.
fn amm_read(c: &Config, reserve_a: U256, reserve_b: U256) -> Sample {
    if reserve_a.is_zero() || reserve_b.is_zero() {
        return None;
    }
    let eth = reserve_a.checked_mul(c.eth_scale)?;
    let tac = reserve_b.checked_mul(c.tac_scale)?;
    Some((full_mul_div(eth, wad(), tac)?, eth))
}

// floor(x·y/d) with a 512-bit product; None where solady's fullMulDiv reverts (d = 0 or the result over 256 bits).
pub fn full_mul_div(x: U256, y: U256, d: U256) -> Option<U256> {
    if d.is_zero() {
        return None;
    }
    let wide = |v: U256| {
        let mut l = [0u64; 8];
        l[..4].copy_from_slice(v.as_limbs());
        U512::from_limbs(l)
    };
    let q = (wide(x) * wide(y)) / wide(d);
    let l = q.as_limbs();
    if l[4..].iter().any(|w| *w != 0) {
        return None;
    }
    Some(U256::from_limbs([l[0], l[1], l[2], l[3]]))
}

#[cfg(test)]
mod tests;
