//! Client-proved Bitcoin shielded pool: the note model of dapp/btc-pool-zk.js and the checks an indexer runs
//! natively around dapp/circuits/btc-pool/spend.circom.
//!
//! ```text
//! a, n      = hsL("tacit-btc-pool-zk-wallet-{spend,nk}-v1", network ‖ seed)     A = a·B8, N = n·B8
//! t_a, t_n  = hsL("tacit-btc-pool-zk-{auth,nk}-tweak-v1", s)                    s = 33-byte secp ECDH secret
//! rho       = hsP("tacit-btc-pool-zk-rho-v1", s)
//! Ak = A + t_a·B8    NK = N + t_n·B8    sk_note = a + t_a    nk_note = n + t_n   (mod l)
//! npk  = Poseidon(Ak.x, Ak.y, NK.x, NK.y)
//! leaf = Poseidon(assetF, v, npk, rho)       assetF   = sha256("tacit-btc-pool-zk-asset-v1" ‖ asset) mod p
//! nf   = Poseidon(nk_note, leaf, index)      bodyHash = sha256("tacit-btc-pool-zk-body-v1" ‖ body) mod p
//! hsX(tag, m) = (sha256(tag ‖ m ‖ 0) ‖ sha256(tag ‖ m ‖ 1)) mod X, big-endian; hsL rejects 0
//! ```

pub mod boundary;
pub mod poseidon;
mod poseidon_constants;
pub mod verify;

#[path = "../../src/babyjubjub.rs"]
pub mod babyjubjub;
#[path = "../../src/groth16.rs"]
pub mod groth16;

use bn::Fr;
use num_bigint::BigUint;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub use babyjubjub::{add as bjj_add, mul_bits, unpack as bjj_unpack};
pub use poseidon::poseidon;

pub type Pt = (Fr, Fr);

pub const TREE_DEPTH: usize = 32;
pub const N_IN: usize = 2;
pub const N_OUT: usize = 3;
pub const N_PUBLIC: usize = 12;

pub const TAG_SPEND: &[u8] = b"tacit-btc-pool-zk-wallet-spend-v1";
pub const TAG_NK: &[u8] = b"tacit-btc-pool-zk-wallet-nk-v1";
pub const TAG_AUTH_TWEAK: &[u8] = b"tacit-btc-pool-zk-auth-tweak-v1";
pub const TAG_NK_TWEAK: &[u8] = b"tacit-btc-pool-zk-nk-tweak-v1";
pub const TAG_RHO: &[u8] = b"tacit-btc-pool-zk-rho-v1";
pub const TAG_ASSET: &[u8] = b"tacit-btc-pool-zk-asset-v1";
pub const TAG_BODY: &[u8] = b"tacit-btc-pool-zk-body-v1";

const BASE8_U: &str = "5299619240641551281634865583518297030282874472190772894086521144482721001553";
const BASE8_V: &str = "16950150798460657717958625567821834550301663161624707787222815936182638968203";
const L_DEC: &str = "2736030358979909402780800718157159386076813972158567259200215660948447373041";
const P_DEC: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495617";

pub fn base8() -> Pt {
    (Fr::from_str(BASE8_U).unwrap(), Fr::from_str(BASE8_V).unwrap())
}
pub fn l_order() -> &'static BigUint {
    static V: OnceLock<BigUint> = OnceLock::new();
    V.get_or_init(|| BigUint::parse_bytes(L_DEC.as_bytes(), 10).unwrap())
}
fn p_order() -> &'static BigUint {
    static V: OnceLock<BigUint> = OnceLock::new();
    V.get_or_init(|| BigUint::parse_bytes(P_DEC.as_bytes(), 10).unwrap())
}
pub fn identity() -> Pt {
    (Fr::zero(), Fr::one())
}
pub fn pt_eq(a: &Pt, b: &Pt) -> bool {
    a.0 == b.0 && a.1 == b.1
}

/// Canonical big-endian bytes. `Fr::to_big_endian` serializes the Montgomery form, so go through U256.
pub fn fr_to_be(x: &Fr) -> [u8; 32] {
    let mut b = [0u8; 32];
    (*x).into_u256().to_big_endian(&mut b).expect("32 bytes");
    b
}
pub fn fr_from_big(x: &BigUint) -> Fr {
    let r = x % p_order();
    let v = r.to_bytes_be();
    let mut b = [0u8; 32];
    b[32 - v.len()..].copy_from_slice(&v);
    Fr::from_slice(&b).expect("reduced")
}
pub fn big_from_fr(x: &Fr) -> BigUint {
    BigUint::from_bytes_be(&fr_to_be(x))
}
pub fn fr_u64(v: u64) -> Fr {
    fr_from_big(&BigUint::from(v))
}

fn wide(tag: &[u8], parts: &[&[u8]]) -> BigUint {
    let mut out = [0u8; 64];
    for (k, half) in out.chunks_mut(32).enumerate() {
        let mut h = Sha256::new();
        h.update(tag);
        for p in parts {
            h.update(p);
        }
        h.update([k as u8]);
        half.copy_from_slice(&h.finalize());
    }
    BigUint::from_bytes_be(&out)
}

/// Hash to a nonzero scalar mod l.
pub fn hs_l(tag: &[u8], parts: &[&[u8]]) -> Option<BigUint> {
    let x = wide(tag, parts) % l_order();
    if x == BigUint::from(0u8) {
        None
    } else {
        Some(x)
    }
}
/// Hash to a field element mod p.
pub fn hs_p(tag: &[u8], parts: &[&[u8]]) -> Fr {
    fr_from_big(&wide(tag, parts))
}

fn sha_mod_p(tag: &[u8], data: &[u8]) -> Fr {
    let mut h = Sha256::new();
    h.update(tag);
    h.update(data);
    fr_from_big(&BigUint::from_bytes_be(&h.finalize()))
}
pub fn asset_field(asset: &[u8; 32]) -> Fr {
    sha_mod_p(TAG_ASSET, asset)
}
/// The circuit's `bodyHash` public input for an envelope body.
pub fn body_hash(body: &[u8]) -> Fr {
    sha_mod_p(TAG_BODY, body)
}

/// k·B8 for any non-negative integer k (reduced by the subgroup order implicitly).
pub fn mul_b8(k: &BigUint) -> Pt {
    mul_bits(&base8(), &k.to_bytes_be())
}

pub struct WalletKeys {
    pub a: BigUint,
    pub n: BigUint,
    pub a_pub: Pt,
    pub n_pub: Pt,
}

pub fn wallet_keys(seed: &[u8; 32], network: &str) -> Option<WalletKeys> {
    if network != "mainnet" && network != "signet" {
        return None;
    }
    let a = hs_l(TAG_SPEND, &[network.as_bytes(), seed])?;
    let n = hs_l(TAG_NK, &[network.as_bytes(), seed])?;
    Some(WalletKeys { a_pub: mul_b8(&a), n_pub: mul_b8(&n), a, n })
}

pub struct NoteTweaks {
    pub t_a: BigUint,
    pub t_n: BigUint,
    pub rho: Fr,
}

pub fn note_tweaks(s: &[u8; 33]) -> Option<NoteTweaks> {
    Some(NoteTweaks { t_a: hs_l(TAG_AUTH_TWEAK, &[s])?, t_n: hs_l(TAG_NK_TWEAK, &[s])?, rho: hs_p(TAG_RHO, &[s]) })
}

pub fn npk(ak: &Pt, nk_pub: &Pt) -> Fr {
    poseidon(&[ak.0, ak.1, nk_pub.0, nk_pub.1])
}

/// Sender view: (Ak, NK, npk, rho) for the address (A, N) and shared secret s.
pub fn output_keys(a_pub: &Pt, n_pub: &Pt, s: &[u8; 33]) -> Option<(Pt, Pt, Fr, Fr)> {
    let t = note_tweaks(s)?;
    let ak = bjj_add(a_pub, &mul_b8(&t.t_a));
    let nkp = bjj_add(n_pub, &mul_b8(&t.t_n));
    Some((ak, nkp, npk(&ak, &nkp), t.rho))
}

/// Owner view: (sk_note, nk_note) mod l.
pub fn owned_scalars(w: &WalletKeys, s: &[u8; 33]) -> Option<(BigUint, BigUint)> {
    let t = note_tweaks(s)?;
    Some(((&w.a + &t.t_a) % l_order(), (&w.n + &t.t_n) % l_order()))
}

pub fn leaf(asset_f: &Fr, v: u64, npk: &Fr, rho: &Fr) -> Fr {
    poseidon(&[*asset_f, fr_u64(v), *npk, *rho])
}

/// nf = Poseidon(nk_note, leaf, index); None unless nk_note < l and index < 2^32.
pub fn nullifier(nk_note: &BigUint, leaf: &Fr, index: u64) -> Option<Fr> {
    if nk_note >= l_order() || index >= 1u64 << 32 {
        return None;
    }
    Some(poseidon(&[fr_from_big(nk_note), *leaf, fr_u64(index)]))
}

pub fn zeros() -> &'static [Fr; TREE_DEPTH + 1] {
    static Z: OnceLock<[Fr; TREE_DEPTH + 1]> = OnceLock::new();
    Z.get_or_init(|| {
        let mut z = [Fr::zero(); TREE_DEPTH + 1];
        for i in 1..=TREE_DEPTH {
            z[i] = poseidon(&[z[i - 1], z[i - 1]]);
        }
        z
    })
}

pub fn root_from_path(leaf: &Fr, index: u64, path: &[Fr; TREE_DEPTH]) -> Fr {
    let mut cur = *leaf;
    for (d, sib) in path.iter().enumerate() {
        cur = if (index >> d) & 1 == 1 { poseidon(&[*sib, cur]) } else { poseidon(&[cur, *sib]) };
    }
    cur
}

/// Append-only Poseidon tree an indexer replays: filled left subtrees plus the current root.
pub struct Tree {
    filled: [Fr; TREE_DEPTH],
    root: Fr,
    pub len: u64,
}

impl Default for Tree {
    fn default() -> Self {
        Tree { filled: [Fr::zero(); TREE_DEPTH], root: zeros()[TREE_DEPTH], len: 0 }
    }
}

impl Tree {
    /// Appends a leaf and returns its index, or None when the tree is full.
    pub fn append(&mut self, leaf: Fr) -> Option<u64> {
        if self.len >= 1u64 << TREE_DEPTH {
            return None;
        }
        let z = zeros();
        let index = self.len;
        let mut cur = leaf;
        for d in 0..TREE_DEPTH {
            cur = if (index >> d) & 1 == 0 {
                self.filled[d] = cur;
                poseidon(&[cur, z[d]])
            } else {
                poseidon(&[self.filled[d], cur])
            };
        }
        self.root = cur;
        self.len += 1;
        Some(index)
    }

    pub fn root(&self) -> Fr {
        self.root
    }
}

/// EdDSA-Poseidon verify as circomlib's EdDSAPoseidonVerifier: S < l and S·B8 = R8 + 8·h·A.
pub fn eddsa_verify(a: &Pt, m: &Fr, r8: &Pt, s: &BigUint) -> bool {
    if s >= l_order() {
        return false;
    }
    let h = big_from_fr(&poseidon(&[r8.0, r8.1, a.0, a.1, *m]));
    let lhs = mul_b8(s);
    let rhs = bjj_add(r8, &mul_bits(a, &(h * 8u8).to_bytes_be()));
    pt_eq(&lhs, &rhs)
}

/// BabyJub Pedersen v·H_BJJ + r·G_BJJ.
pub fn pedersen_bjj(v: u64, r: &BigUint) -> Pt {
    let vh = mul_bits(&babyjubjub::h_bjj(), &v.to_be_bytes());
    let rg = mul_bits(&babyjubjub::g_bjj(), &r.to_bytes_be());
    bjj_add(&vh, &rg)
}
