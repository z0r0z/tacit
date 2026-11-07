//! Locks: value a spend puts aside for a recipient until a deadline, the chain's half of an atomic swap with another chain (the fast
//! bridge's adaptor swap, against the Bitcoin pool or any chain with Schnorr signatures).
//!
//! A spend whose body names `ops::Op::Lock` sends its exit's value into a lock: a leaf in the note tree that no spend proof can ever
//! open (its first element is LOCK_TAG, never an asset, and its second an asset, never a value below 2^64), committing the recipient's
//! BIP-340 key, the deadline and the keys of the two notes it can become. Before the deadline the recipient claims it with a BIP-340
//! signature over the claim message, which the block publishes: the swap's counterparty, holding the recipient's pre-signature adapted
//! to its point T, reads t = s − s̃ from it and takes the other chain's leg; no one else learns anything from it. From the deadline on,
//! anyone may refund it to the locker's note. Either spends the lock once, by a nullifier in the chain's nullifier tree.
//!
//! The block program has no clock. A block names a time T (`BlockOut::time`), the landing contract lands it only between T and
//! T + TIME_WINDOW, and the program decides by T alone: a claim only while T + TIME_WINDOW is at most the deadline, a refund only from
//! T at or past it. So a claim or refund posted to the queue is either taken or passed over, never one that would keep a block from
//! landing.

use super::{fr_be, fr_from_be, node_hash, ops::NoteTo, poseidon, Fr, TREE_DEPTH};
use ff::FromUniformBytes;
use k256::elliptic_curve::group::Group;
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::point::AffineCoordinates;
use k256::elliptic_curve::sec1::FromEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar, U256};
use sha2::{Digest, Sha256};

/// How long after the time a block names it may land.
pub const TIME_WINDOW: u64 = 3600;
const LOCK_DOMAIN: &[u8] = b"tacit-block-lock-v1";
const CLAIM_DOMAIN: &[u8] = b"tacit-block-claim-v1";
pub const SETTLE_CLAIM: u8 = 1;
pub const SETTLE_REFUND: u8 = 2;
/// What a claim or refund posted to the landing contract's queue starts with: no spend's first public (a field element) is it.
pub const SETTLE_MARK: [u8; 32] = [0xff; 32];

pub(crate) fn field_of(tag: &[u8], parts: &[&[u8]]) -> Fr {
    let mut wide = [0u8; 64];
    for (i, half) in wide.chunks_mut(32).enumerate() {
        let mut h = Sha256::new();
        h.update(tag);
        for p in parts {
            h.update(p);
        }
        h.update([i as u8]);
        half.copy_from_slice(&h.finalize());
    }
    Fr::from_uniform_bytes(&wide)
}

/// The first element of every lock leaf, and of every lock's nullifier.
pub fn lock_tag() -> Fr {
    field_of(b"tacit-block-lock-leaf-v1", &[])
}

fn lock_nf_tag() -> Fr {
    field_of(b"tacit-block-lock-nf-v1", &[])
}

/// What a lock holds and for whom.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Lock {
    /// The recipient's BIP-340 key (x-only), which signs its claim.
    pub recipient: [u8; 32],
    /// Unix seconds: claims land before it, refunds from it.
    pub deadline: u64,
    /// The note a claim makes, and the one a refund makes.
    pub claim_to: NoteTo,
    pub refund_to: NoteTo,
}

fn to_bytes(t: &NoteTo) -> Vec<u8> {
    [fr_be(&t.npk).to_vec(), fr_be(&t.rho).to_vec(), t.memo.to_vec()].concat()
}

fn note_to(b: &[u8]) -> Option<NoteTo> {
    Some(NoteTo { npk: fr_from_be(b.get(..32)?)?, rho: fr_from_be(b.get(32..64)?)?, memo: b.get(64..96)?.try_into().ok()? })
}

pub const LOCK_LEN: usize = 32 + 8 + 96 + 96;

impl Lock {
    pub fn to_bytes(&self) -> Vec<u8> {
        [self.recipient.to_vec(), self.deadline.to_be_bytes().to_vec(), to_bytes(&self.claim_to), to_bytes(&self.refund_to)].concat()
    }

    pub fn from_bytes(b: &[u8]) -> Option<Lock> {
        if b.len() != LOCK_LEN {
            return None;
        }
        Some(Lock {
            recipient: b[..32].try_into().ok()?,
            deadline: u64::from_be_bytes(b[32..40].try_into().ok()?),
            claim_to: note_to(&b[40..136])?,
            refund_to: note_to(&b[136..232])?,
        })
    }

    /// The leaf a lock of `value` of `asset` is in the note tree: Poseidon(LOCK_TAG, asset, value, its terms' field).
    pub fn leaf(&self, asset: &Fr, value: u64) -> Fr {
        let terms = field_of(LOCK_DOMAIN, &[&self.to_bytes()]);
        poseidon(&[lock_tag(), *asset, Fr::from(value), terms])
    }
}

/// The lock leaf's nullifier at `index`.
pub fn lock_nullifier(leaf: &Fr, index: u64) -> Fr {
    poseidon(&[lock_nf_tag(), *leaf, Fr::from(index)])
}

/// What the recipient signs to claim the lock `leaf` on the chain bound to `chain`: SHA-256(CLAIM_DOMAIN ‖ chain ‖ leaf). It names
/// the lock, so the note the claim makes (in the lock's terms) cannot be redirected.
pub fn claim_message(chain: &[u8; 32], leaf: &Fr) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(CLAIM_DOMAIN);
    h.update(chain);
    h.update(fr_be(leaf));
    h.finalize().into()
}

fn tagged(tag: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let t: [u8; 32] = Sha256::digest(tag).into();
    let mut h = Sha256::new();
    h.update(t);
    h.update(t);
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// BIP-340 verification of `sig` (R.x ‖ s) over `msg` by the x-only key `pubkey`.
pub fn bip340_verify(sig: &[u8; 64], msg: &[u8; 32], pubkey: &[u8; 32]) -> bool {
    let Some(s) = Option::<Scalar>::from(Scalar::from_repr(*FieldBytes::from_slice(&sig[32..]))) else { return false };
    let mut comp = [0u8; 33];
    comp[0] = 0x02;
    comp[1..].copy_from_slice(pubkey);
    let Ok(enc) = EncodedPoint::from_bytes(comp) else { return false };
    let Some(p) = Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&enc)) else { return false };
    let e = <Scalar as Reduce<U256>>::reduce_bytes(FieldBytes::from_slice(&tagged(b"BIP0340/challenge", &[&sig[..32], pubkey, msg])));
    let r = ProjectivePoint::generator() * s - ProjectivePoint::from(p) * e;
    if bool::from(r.is_identity()) {
        return false;
    }
    let r = r.to_affine();
    !bool::from(r.y_is_odd()) && r.x().as_slice() == &sig[..32]
}

/// A claim or a refund of a lock, as a block takes it: the lock's asset, value and terms, where its leaf is in the note tree (the
/// index, the root it is shown against, which the landing contract checks a block ended at when the settle is posted to its queue,
/// and the sibling path, from the leaf up) and, for a claim, the recipient's signature.
#[derive(Clone, Debug, PartialEq)]
pub struct Settle {
    pub kind: u8,
    pub asset: Fr,
    pub value: u64,
    pub lock: Lock,
    pub index: u64,
    pub root: Fr,
    pub path: [Fr; TREE_DEPTH],
    pub sig: Option<[u8; 64]>,
}

impl Settle {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = vec![self.kind];
        b.extend(fr_be(&self.asset));
        b.extend(self.value.to_be_bytes());
        b.extend(self.lock.to_bytes());
        b.extend(self.index.to_be_bytes());
        b.extend(fr_be(&self.root));
        for p in &self.path {
            b.extend(fr_be(p));
        }
        if let Some(s) = &self.sig {
            b.extend(s);
        }
        b
    }

    pub fn from_bytes(b: &[u8]) -> Option<Settle> {
        let (&kind, rest) = b.split_first()?;
        let sig_len = match kind {
            SETTLE_CLAIM => 64,
            SETTLE_REFUND => 0,
            _ => return None,
        };
        if rest.len() != 32 + 8 + LOCK_LEN + 8 + 32 + 32 * TREE_DEPTH + sig_len {
            return None;
        }
        let asset = fr_from_be(&rest[..32])?;
        let value = u64::from_be_bytes(rest[32..40].try_into().ok()?);
        let lock = Lock::from_bytes(&rest[40..40 + LOCK_LEN])?;
        let at = 40 + LOCK_LEN;
        let index = u64::from_be_bytes(rest[at..at + 8].try_into().ok()?);
        let root = fr_from_be(&rest[at + 8..at + 40])?;
        let mut path = [Fr::from(0u64); TREE_DEPTH];
        for (i, p) in path.iter_mut().enumerate() {
            *p = fr_from_be(&rest[at + 40 + 32 * i..at + 72 + 32 * i])?;
        }
        let sig = (sig_len == 64).then(|| rest[rest.len() - 64..].try_into().unwrap());
        Some(Settle { kind, asset, value, lock, index, root, path, sig })
    }

    pub fn leaf(&self) -> Fr {
        self.lock.leaf(&self.asset, self.value)
    }

    /// The note tree's root the path leads to from the lock's leaf.
    pub fn path_root(&self) -> Fr {
        let mut h = self.leaf();
        for (d, sib) in self.path.iter().enumerate() {
            h = if (self.index >> d) & 1 == 0 { node_hash(&h, sib) } else { node_hash(sib, &h) };
        }
        h
    }

    /// The note it makes: the claim's or the refund's keys, the lock's asset and value.
    pub fn to(&self) -> NoteTo {
        if self.kind == SETTLE_CLAIM {
            self.lock.claim_to
        } else {
            self.lock.refund_to
        }
    }

    /// Whether a block naming `time` takes it on the chain bound to `chain`: a claim signed by the recipient while the block lands
    /// before the deadline, a refund once it is past.
    pub fn allowed(&self, chain: &[u8; 32], time: u64) -> bool {
        if self.index >= 1u64 << TREE_DEPTH || self.path_root() != self.root {
            return false;
        }
        match (self.kind, &self.sig) {
            (SETTLE_CLAIM, Some(sig)) => {
                time.checked_add(TIME_WINDOW).is_some_and(|t| t <= self.lock.deadline) && bip340_verify(sig, &claim_message(chain, &self.leaf()), &self.lock.recipient)
            }
            (SETTLE_REFUND, None) => time >= self.lock.deadline,
            _ => false,
        }
    }
}

/// A claim or refund posted to the queue: SETTLE_MARK ‖ the settle ‖ the memo published for the note it makes.
pub fn forced_settle(p: &[u8], memo_len: usize) -> Option<(Settle, &[u8])> {
    if p.len() < 32 + memo_len || p[..32] != SETTLE_MARK {
        return None;
    }
    let (body, memo) = p[32..].split_at(p.len() - 32 - memo_len);
    Some((Settle::from_bytes(body)?, memo))
}
