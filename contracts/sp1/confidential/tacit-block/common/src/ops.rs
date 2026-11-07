//! Operations a spend can carry in its body instead of an exit to an address.
//!
//! A spend proof shows that its inputs' owners signed its body hash and that its value balances (inputs and a deposit = outputs and
//! an exit); what the body says is the block program's to read. A spend whose body names an operation sends its exit's value into that
//! operation instead of to an address, so the same proof a payment uses carries it, and no key of the spender's is ever the block's to
//! see.
//!
//! The chain keeps no liquidity of its own: what an operation does with value on Ethereum happens in the confidential pool there
//! (V1), so the chain adds to that pool's liquidity and anonymity set instead of splitting them.

use super::{fr_be, fr_from_be, Fr};

/// Sends the exit's value into the confidential pool on Ethereum as a deposit for the note `commit` names there (the pool's
/// `wrap(asset, amount, commit)`): one exit and one deposit, with no address of the spender's in between.
pub const OP_HOP: u8 = 1;

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
    /// The exit's value into the confidential pool, as a deposit for `commit` (that pool's keccak(Cx ‖ Cy ‖ owner) of the note it
    /// makes).
    Hop { commit: [u8; 32] },
}

struct R<'a>(&'a [u8]);
impl R<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let (a, b) = (self.0.get(..n)?, self.0.get(n..)?);
        self.0 = b;
        Some(a)
    }
    #[allow(dead_code)]
    fn fr(&mut self) -> Option<Fr> {
        fr_from_be(self.take(32)?)
    }
}

impl Op {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = vec![];
        match self {
            Op::Hop { commit } => {
                b.push(OP_HOP);
                b.extend(commit);
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
            OP_HOP => Op::Hop { commit: r.take(32)?.try_into().ok()? },
            _ => return None,
        };
        Some((op, b.len() - r.0.len()))
    }

    /// The receivers of notes the operation makes, in its order: the memos posted with a forced spend that carries it follow this
    /// order. A hop makes none on this chain.
    pub fn receivers(&self) -> Vec<NoteTo> {
        match self {
            Op::Hop { .. } => vec![],
        }
    }
}

/// A hop as a block publishes it: the asset, the value (u64 in a 32-byte word) and the confidential pool's commitment, 96 bytes.
pub fn hop_bytes(asset: &Fr, value: u64, commit: &[u8; 32]) -> Vec<u8> {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&value.to_be_bytes());
    [fr_be(asset).to_vec(), w.to_vec(), commit.to_vec()].concat()
}

pub const HOP_LEN: usize = 96;
