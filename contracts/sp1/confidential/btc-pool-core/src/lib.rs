//! Bitcoin-native shielded pool: note leaf, nullifier, `T_BTC_SPEND` body codec and the spend relation
//! the btc-pool-prover guest proves (DESIGN-btc-shielded-pool.md §2-§4).

use cxfer_core::{
    bip340_verify, compress, decompress, from_affine_xy, keccak_bytes, keccak_merkle_verify, scalar_reduce_be,
    verify_pedersen_opening, KECCAK_TREE_DEPTH,
};
use k256::elliptic_curve::PrimeField;
use k256::{FieldBytes, Scalar};
#[allow(unused_imports)] // ProjectivePoint::generator() resolves through Group on the RISC-V target (sp1 k256)
use k256::elliptic_curve::group::Group;
use k256::ProjectivePoint;

fn kn(parts: &[&[u8]]) -> [u8; 32] {
    keccak_bytes(&parts.concat())
}

/// A canonical 32-byte big-endian scalar (< n), else None.
fn scalar_canonical_be(bytes: &[u8]) -> Option<Scalar> {
    let fb: FieldBytes = <[u8; 32]>::try_from(bytes).ok()?.into();
    Option::<Scalar>::from(Scalar::from_repr(fb))
}

pub const BTC_POOL_NOTE_DOMAIN: &[u8] = b"tacit-btc-pool-note-v1";
pub const BTC_POOL_NF_DOMAIN: &[u8] = b"tacit-btc-pool-nf-v1";
pub const BTC_POOL_SPEND_DOMAIN: &[u8] = b"tacit-btc-pool-spend-v1";
pub const T_BTC_SPEND_OPCODE: u8 = 0x6D;
pub const BTC_POOL_MAX_IN: usize = 2;
pub const BTC_POOL_MAX_OUT: usize = 3;
pub const BTC_POOL_PV_VERSION: u16 = 1;
/// Cx ‖ Cy ‖ spend_key ‖ nk_pub ‖ pk_eph ‖ ct_note.
pub const BTC_POOL_OUTPUT_LEN: usize = 32 + 32 + 32 + 33 + 33 + 56;
/// exit_vout ‖ Cx ‖ Cy ‖ dest_spk_hash.
pub const BTC_POOL_EXIT_LEN: usize = 4 + 32 + 32 + 32;
/// txid ‖ vout: an outpoint the carrier must spend, all zero for none.
pub const BTC_POOL_BIND_LEN: usize = 32 + 4;
/// vout ‖ value ‖ spk_hash.
pub const BTC_POOL_WANT_LEN: usize = 4 + 8 + 32;

/// leaf = keccak(asset ‖ Cx ‖ Cy ‖ spend_key ‖ nk_pub ‖ "tacit-btc-pool-note-v1").
pub fn btc_pool_note_leaf(
    asset: &[u8; 32],
    cx: &[u8; 32],
    cy: &[u8; 32],
    spend_key: &[u8; 32],
    nk_pub: &[u8; 33],
) -> [u8; 32] {
    kn(&[asset, cx, cy, spend_key, nk_pub, BTC_POOL_NOTE_DOMAIN])
}

/// nf = keccak("tacit-btc-pool-nf-v1" ‖ leaf ‖ nk_note(32, BE) ‖ leaf_index(8, BE)).
pub fn btc_pool_nullifier(leaf: &[u8; 32], nk_note: &[u8; 32], leaf_index: u64) -> [u8; 32] {
    kn(&[BTC_POOL_NF_DOMAIN, leaf, nk_note, &leaf_index.to_be_bytes()])
}

/// msg = keccak("tacit-btc-pool-spend-v1" ‖ body), the message every input's spend_key signs.
pub fn btc_pool_spend_msg(body: &[u8]) -> [u8; 32] {
    kn(&[BTC_POOL_SPEND_DOMAIN, body])
}

/// A pool output: appends a leaf.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BtcPoolOutput {
    pub cx: [u8; 32],
    pub cy: [u8; 32],
    pub spend_key: [u8; 32],
    pub nk_pub: [u8; 33],
    pub pk_eph: [u8; 33],
    pub ct_note: [u8; 56],
}

impl BtcPoolOutput {
    pub fn leaf(&self, asset: &[u8; 32]) -> [u8; 32] {
        btc_pool_note_leaf(asset, &self.cx, &self.cy, &self.spend_key, &self.nk_pub)
    }
}

/// An exit: a transparent note `(asset, Cx, Cy)` at the carrier's output `exit_vout`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BtcPoolExit {
    pub exit_vout: u32,
    pub cx: [u8; 32],
    pub cy: [u8; 32],
    pub dest_spk_hash: [u8; 32],
}

/// A want: the carrier's output `vout` pays at least `value` sats to a script whose SHA-256 is `spk_hash`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BtcPoolWant {
    pub vout: u32,
    pub value: u64,
    pub spk_hash: [u8; 32],
}

/// A `T_BTC_SPEND` body: every payload byte before `proof_len` (design §3). Integers little-endian.
/// `bind` is `txid ‖ vout` of an outpoint the carrier must spend, all zero for none; `bind` and `want` are
/// acceptance rules on the carrier, covered by the spend signatures and `keccak(body)` like every field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BtcPoolSpendBody {
    pub asset: [u8; 32],
    pub h_anchor: u32,
    pub bind: [u8; BTC_POOL_BIND_LEN],
    pub nullifiers: Vec<[u8; 32]>,
    pub outputs: Vec<BtcPoolOutput>,
    pub exit: Option<BtcPoolExit>,
    pub want: Option<BtcPoolWant>,
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let end = self.pos.checked_add(n).ok_or("btc-pool: body truncated")?;
        let s = self.buf.get(self.pos..end).ok_or("btc-pool: body truncated")?;
        self.pos = end;
        Ok(s)
    }
    fn arr<const N: usize>(&mut self) -> Result<[u8; N], &'static str> {
        let mut a = [0u8; N];
        a.copy_from_slice(self.take(N)?);
        Ok(a)
    }
    fn u8(&mut self) -> Result<u8, &'static str> {
        Ok(self.take(1)?[0])
    }
    fn u32_le(&mut self) -> Result<u32, &'static str> {
        Ok(u32::from_le_bytes(self.arr::<4>()?))
    }
    fn u64_le(&mut self) -> Result<u64, &'static str> {
        Ok(u64::from_le_bytes(self.arr::<8>()?))
    }
    /// (Cx, Cy): an on-curve affine point, both coordinates below p.
    fn point_xy(&mut self) -> Result<([u8; 32], [u8; 32]), &'static str> {
        let (cx, cy) = (self.arr::<32>()?, self.arr::<32>()?);
        if from_affine_xy(&cx, &cy).is_none() {
            return Err("btc-pool: commitment not a curve point");
        }
        Ok((cx, cy))
    }
    fn xonly_key(&mut self) -> Result<[u8; 32], &'static str> {
        let k = self.arr::<32>()?;
        let mut comp = [0u8; 33];
        comp[0] = 0x02;
        comp[1..].copy_from_slice(&k);
        if decompress(&comp).is_none() {
            return Err("btc-pool: spend_key not an x-only key");
        }
        Ok(k)
    }
    fn compressed_point(&mut self, err: &'static str) -> Result<[u8; 33], &'static str> {
        let p = self.arr::<33>()?;
        if !(p[0] == 0x02 || p[0] == 0x03) || decompress(&p).is_none() {
            return Err(err);
        }
        Ok(p)
    }
}

impl BtcPoolSpendBody {
    /// Canonical parse (design §3): opcode 0x6D, 1 ≤ n_in ≤ 2, 0 ≤ n_out ≤ 3, has_exit ∈ {0, 1},
    /// has_want ∈ {0, 1}, n_out + has_exit ≥ 1, every (Cx, Cy) on the curve with coordinates below p, every
    /// nk_pub/pk_eph a compressed point, every spend_key an x-only key, no trailing bytes. Fields are
    /// fixed-width, so `parse(b)?.encode() == b`.
    pub fn parse(body: &[u8]) -> Result<Self, &'static str> {
        let mut r = Reader { buf: body, pos: 0 };
        if r.u8()? != T_BTC_SPEND_OPCODE {
            return Err("btc-pool: body opcode");
        }
        let asset = r.arr::<32>()?;
        let h_anchor = r.u32_le()?;
        let bind = r.arr::<BTC_POOL_BIND_LEN>()?;
        let n_in = r.u8()? as usize;
        if n_in == 0 || n_in > BTC_POOL_MAX_IN {
            return Err("btc-pool: n_in out of range");
        }
        let mut nullifiers = Vec::with_capacity(n_in);
        for _ in 0..n_in {
            nullifiers.push(r.arr::<32>()?);
        }
        let n_out = r.u8()? as usize;
        if n_out > BTC_POOL_MAX_OUT {
            return Err("btc-pool: n_out out of range");
        }
        let mut outputs = Vec::with_capacity(n_out);
        for _ in 0..n_out {
            let (cx, cy) = r.point_xy()?;
            outputs.push(BtcPoolOutput {
                cx,
                cy,
                spend_key: r.xonly_key()?,
                nk_pub: r.compressed_point("btc-pool: nk_pub not a compressed point")?,
                pk_eph: r.compressed_point("btc-pool: pk_eph not a compressed point")?,
                ct_note: r.arr()?,
            });
        }
        let exit = match r.u8()? {
            0 => None,
            1 => {
                let exit_vout = r.u32_le()?;
                let (cx, cy) = r.point_xy()?;
                Some(BtcPoolExit { exit_vout, cx, cy, dest_spk_hash: r.arr()? })
            }
            _ => return Err("btc-pool: bad has_exit"),
        };
        let want = match r.u8()? {
            0 => None,
            1 => Some(BtcPoolWant { vout: r.u32_le()?, value: r.u64_le()?, spk_hash: r.arr()? }),
            _ => return Err("btc-pool: bad has_want"),
        };
        if n_out == 0 && exit.is_none() {
            return Err("btc-pool: spend has no outputs");
        }
        if r.pos != body.len() {
            return Err("btc-pool: trailing bytes in body");
        }
        Ok(Self { asset, h_anchor, bind, nullifiers, outputs, exit, want })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(
            1 + 32 + 4 + BTC_POOL_BIND_LEN + 1 + 32 * self.nullifiers.len() + 1 + BTC_POOL_OUTPUT_LEN * self.outputs.len()
                + 1 + BTC_POOL_EXIT_LEN + 1 + BTC_POOL_WANT_LEN,
        );
        b.push(T_BTC_SPEND_OPCODE);
        b.extend_from_slice(&self.asset);
        b.extend_from_slice(&self.h_anchor.to_le_bytes());
        b.extend_from_slice(&self.bind);
        b.push(self.nullifiers.len() as u8);
        for nf in &self.nullifiers {
            b.extend_from_slice(nf);
        }
        b.push(self.outputs.len() as u8);
        for o in &self.outputs {
            b.extend_from_slice(&o.cx);
            b.extend_from_slice(&o.cy);
            b.extend_from_slice(&o.spend_key);
            b.extend_from_slice(&o.nk_pub);
            b.extend_from_slice(&o.pk_eph);
            b.extend_from_slice(&o.ct_note);
        }
        match &self.exit {
            None => b.push(0),
            Some(e) => {
                b.push(1);
                b.extend_from_slice(&e.exit_vout.to_le_bytes());
                b.extend_from_slice(&e.cx);
                b.extend_from_slice(&e.cy);
                b.extend_from_slice(&e.dest_spk_hash);
            }
        }
        match &self.want {
            None => b.push(0),
            Some(w) => {
                b.push(1);
                b.extend_from_slice(&w.vout.to_le_bytes());
                b.extend_from_slice(&w.value.to_le_bytes());
                b.extend_from_slice(&w.spk_hash);
            }
        }
        b
    }
}

/// One spent note (private witness).
#[derive(Clone, Debug)]
pub struct BtcPoolSpendInput {
    pub cx: [u8; 32],
    pub cy: [u8; 32],
    pub value: u64,
    pub blinding: [u8; 32],
    pub spend_key: [u8; 32],
    pub nk_pub: [u8; 33],
    pub nk_note: [u8; 32],
    pub leaf_index: u64,
    pub path: Vec<[u8; 32]>,
    pub sig: [u8; 64],
}

/// Opening of one body commitment. A witness holds one per pool output in body order, then one for the
/// exit when the body has one.
#[derive(Clone, Debug)]
pub struct BtcPoolOpening {
    pub value: u64,
    pub blinding: [u8; 32],
}

#[derive(Clone, Debug)]
pub struct BtcPoolSpendWitness {
    pub body: Vec<u8>,
    pub root: [u8; 32],
    pub inputs: Vec<BtcPoolSpendInput>,
    pub outputs: Vec<BtcPoolOpening>,
}

/// The public statement: `abi.encode(uint16 1, bytes32 root, bytes32 keccak(body))`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BtcPoolSpendStatement {
    pub root: [u8; 32],
    pub body_hash: [u8; 32],
}

impl BtcPoolSpendStatement {
    pub fn abi_encode(&self) -> [u8; 96] {
        let mut out = [0u8; 96];
        out[30..32].copy_from_slice(&BTC_POOL_PV_VERSION.to_be_bytes());
        out[32..64].copy_from_slice(&self.root);
        out[64..96].copy_from_slice(&self.body_hash);
        out
    }
}

fn opens(cx: &[u8; 32], cy: &[u8; 32], value: u64, blinding: &[u8; 32]) -> bool {
    match from_affine_xy(cx, cy) {
        Some(c) => verify_pedersen_opening(&c, value, &scalar_reduce_be(blinding)),
        None => false,
    }
}

/// The `T_BTC_SPEND` relation (design §4). Every public fact is read from the parsed `body`; the witness
/// only supplies openings, note keys, membership paths and signatures.
pub fn verify_btc_pool_spend(w: &BtcPoolSpendWitness) -> Result<BtcPoolSpendStatement, &'static str> {
    let body = BtcPoolSpendBody::parse(&w.body)?;
    if w.inputs.len() != body.nullifiers.len() {
        return Err("btc-pool: input count does not match body");
    }
    for i in 0..body.nullifiers.len() {
        for j in (i + 1)..body.nullifiers.len() {
            if body.nullifiers[i] == body.nullifiers[j] {
                return Err("btc-pool: repeated nullifier");
            }
        }
    }
    let msg = btc_pool_spend_msg(&w.body);

    let mut sum_in: u128 = 0;
    for (inp, nf_body) in w.inputs.iter().zip(body.nullifiers.iter()) {
        if !opens(&inp.cx, &inp.cy, inp.value, &inp.blinding) {
            return Err("btc-pool: input opening");
        }
        // The tree has 2^32 slots; a wider index would pass membership under a second nullifier.
        if inp.path.len() != KECCAK_TREE_DEPTH || inp.leaf_index >> KECCAK_TREE_DEPTH != 0 {
            return Err("btc-pool: input membership");
        }
        let leaf = btc_pool_note_leaf(&body.asset, &inp.cx, &inp.cy, &inp.spend_key, &inp.nk_pub);
        if !keccak_merkle_verify(&leaf, inp.leaf_index, &inp.path, &w.root) {
            return Err("btc-pool: input membership");
        }
        // Parsed without reduction: `d` and `d + n` would otherwise both prove the note under two nullifiers.
        let nk = scalar_canonical_be(&inp.nk_note).ok_or("btc-pool: nk_note not canonical")?;
        if nk == k256::Scalar::ZERO {
            return Err("btc-pool: nk_note is zero");
        }
        // Full compressed equality, parity byte included: `d` and `n - d` share an x-coordinate.
        if compress(&(ProjectivePoint::generator() * nk)) != inp.nk_pub {
            return Err("btc-pool: nk_pub does not match nk_note");
        }
        if btc_pool_nullifier(&leaf, &inp.nk_note, inp.leaf_index) != *nf_body {
            return Err("btc-pool: nullifier mismatch");
        }
        if !bip340_verify(&inp.sig, &msg, &inp.spend_key) {
            return Err("btc-pool: spend signature");
        }
        sum_in += inp.value as u128;
    }

    let commitments = body.outputs.iter().map(|o| (&o.cx, &o.cy)).chain(body.exit.iter().map(|e| (&e.cx, &e.cy)));
    if w.outputs.len() != body.outputs.len() + body.exit.is_some() as usize {
        return Err("btc-pool: output count does not match body");
    }
    let mut sum_out: u128 = 0;
    for ((cx, cy), op) in commitments.zip(w.outputs.iter()) {
        if !opens(cx, cy, op.value, &op.blinding) {
            return Err("btc-pool: output opening");
        }
        sum_out += op.value as u128;
    }
    if sum_in != sum_out {
        return Err("btc-pool: conservation");
    }

    Ok(BtcPoolSpendStatement { root: w.root, body_hash: kn(&[&w.body]) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cxfer_core::pedersen_commit_xy;
    use sha2::{Digest, Sha256};

    fn bip340_tagged(tag: &[u8], msg: &[u8]) -> [u8; 32] {
        let t: [u8; 32] = Sha256::digest(tag).into();
        Sha256::new().chain_update(t).chain_update(t).chain_update(msg).finalize().into()
    }

    fn keccak_zeros() -> [[u8; 32]; KECCAK_TREE_DEPTH] {
        let mut z = [[0u8; 32]; KECCAK_TREE_DEPTH];
        for i in 1..KECCAK_TREE_DEPTH { z[i] = kn(&[&z[i - 1], &z[i - 1]]); }
        z
    }
    use k256::elliptic_curve::sec1::ToEncodedPoint;
    use k256::Scalar;

    const ASSET: [u8; 32] = [0xB7u8; 32];
    const H_ANCHOR: u32 = 910_000;
    /// secp256k1 group order n, big-endian.
    const N_BE: [u8; 32] = [
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0xBA, 0xAE,
        0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41,
    ];

    fn h(tag: &[u8], seed: u8) -> [u8; 32] {
        kn(&[b"btc-pool-test", tag, &[seed]])
    }
    fn sbytes(s: &Scalar) -> [u8; 32] {
        let mut b = [0u8; 32];
        b.copy_from_slice(s.to_bytes().as_slice());
        b
    }
    fn xonly_of(s: &Scalar) -> [u8; 32] {
        let c = compress(&(ProjectivePoint::GENERATOR * s));
        let mut x = [0u8; 32];
        x.copy_from_slice(&c[1..]);
        x
    }
    fn pubc(s: &Scalar) -> [u8; 33] {
        compress(&(ProjectivePoint::GENERATOR * s))
    }

    /// BIP-340 sign with a deterministic nonce (test-only).
    fn sign(sk: &Scalar, msg: &[u8; 32], nonce_seed: &[u8; 32]) -> [u8; 64] {
        let mut d = *sk;
        if compress(&(ProjectivePoint::GENERATOR * d))[0] == 0x03 {
            d = -d;
        }
        let px = xonly_of(&d);
        let mut k = scalar_reduce_be(&kn(&[nonce_seed, msg]));
        if compress(&(ProjectivePoint::GENERATOR * k))[0] == 0x03 {
            k = -k;
        }
        let rx = xonly_of(&k);
        let mut chal = Vec::with_capacity(96);
        chal.extend_from_slice(&rx);
        chal.extend_from_slice(&px);
        chal.extend_from_slice(msg);
        let e = scalar_reduce_be(&bip340_tagged(b"BIP0340/challenge", &chal));
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&rx);
        sig[32..].copy_from_slice(&sbytes(&(k + e * d)));
        sig
    }

    #[derive(Clone)]
    struct Note {
        cx: [u8; 32],
        cy: [u8; 32],
        value: u64,
        blinding: [u8; 32],
        sk: Scalar,
        spend_key: [u8; 32],
        nk_note: [u8; 32],
        nk_pub: [u8; 33],
    }

    impl Note {
        fn new(value: u64, seed: u8) -> Self {
            let blinding = h(b"r", seed);
            let (cx, cy) = pedersen_commit_xy(value, &blinding);
            let sk = scalar_reduce_be(&h(b"sk", seed));
            let nk = scalar_reduce_be(&h(b"nk", seed));
            Note { cx, cy, value, blinding, sk, spend_key: xonly_of(&sk), nk_note: sbytes(&nk), nk_pub: pubc(&nk) }
        }
        fn leaf(&self) -> [u8; 32] {
            btc_pool_note_leaf(&ASSET, &self.cx, &self.cy, &self.spend_key, &self.nk_pub)
        }
        fn nf(&self, leaf_index: u64) -> [u8; 32] {
            btc_pool_nullifier(&self.leaf(), &self.nk_note, leaf_index)
        }
    }

    fn pay_output(value: u64, seed: u8) -> (BtcPoolOutput, BtcPoolOpening) {
        let n = Note::new(value, seed);
        let mut ct_note = [0u8; 56];
        for (i, b) in ct_note.iter_mut().enumerate() {
            *b = seed.wrapping_mul(7).wrapping_add(i as u8);
        }
        let out = BtcPoolOutput {
            cx: n.cx,
            cy: n.cy,
            spend_key: n.spend_key,
            nk_pub: n.nk_pub,
            pk_eph: pubc(&scalar_reduce_be(&h(b"eph", seed))),
            ct_note,
        };
        (out, BtcPoolOpening { value, blinding: n.blinding })
    }

    fn exit_output(value: u64, seed: u8) -> (BtcPoolExit, BtcPoolOpening) {
        let blinding = h(b"exit-r", seed);
        let (cx, cy) = pedersen_commit_xy(value, &blinding);
        (BtcPoolExit { exit_vout: 1, cx, cy, dest_spk_hash: h(b"spk", seed) }, BtcPoolOpening { value, blinding })
    }

    /// Full depth-32 path for `index` in the tree holding exactly `leaves`.
    fn tree_path(leaves: &[[u8; 32]], index: usize) -> Vec<[u8; 32]> {
        let zeros = keccak_zeros();
        let mut level = leaves.to_vec();
        let mut idx = index;
        let mut path = Vec::with_capacity(KECCAK_TREE_DEPTH);
        for z in zeros.iter() {
            let sib = idx ^ 1;
            path.push(if sib < level.len() { level[sib] } else { *z });
            let mut next = Vec::with_capacity((level.len() + 1) / 2);
            for pair in level.chunks(2) {
                next.push(kn(&[&pair[0], if pair.len() == 2 { &pair[1] } else { z }]));
            }
            level = next;
            idx >>= 1;
        }
        path
    }

    /// opcode ‖ asset ‖ h_anchor ‖ bind: the fixed prefix before n_in.
    const PRE: usize = 1 + 32 + 4 + BTC_POOL_BIND_LEN;

    /// A tree with `pad` filler leaves then `notes`, and a body spending them into `outputs` and `exit`,
    /// fully signed.
    fn assemble(
        notes: &[Note],
        pad: usize,
        outputs: Vec<BtcPoolOutput>,
        exit: Option<BtcPoolExit>,
        openings: Vec<BtcPoolOpening>,
    ) -> BtcPoolSpendWitness {
        assemble_full(notes, pad, outputs, exit, openings, [0u8; BTC_POOL_BIND_LEN], None)
    }

    fn assemble_full(
        notes: &[Note],
        pad: usize,
        outputs: Vec<BtcPoolOutput>,
        exit: Option<BtcPoolExit>,
        openings: Vec<BtcPoolOpening>,
        bind: [u8; BTC_POOL_BIND_LEN],
        want: Option<BtcPoolWant>,
    ) -> BtcPoolSpendWitness {
        let mut leaves: Vec<[u8; 32]> = (0..pad).map(|k| h(b"filler", k as u8)).collect();
        leaves.extend(notes.iter().map(Note::leaf));
        let root = cxfer_core::keccak_merkle_root(&leaves);
        let body = BtcPoolSpendBody {
            asset: ASSET,
            h_anchor: H_ANCHOR,
            bind,
            nullifiers: notes.iter().enumerate().map(|(k, n)| n.nf((pad + k) as u64)).collect(),
            outputs,
            exit,
            want,
        }
        .encode();
        let msg = btc_pool_spend_msg(&body);
        let inputs = notes
            .iter()
            .enumerate()
            .map(|(k, n)| BtcPoolSpendInput {
                cx: n.cx,
                cy: n.cy,
                value: n.value,
                blinding: n.blinding,
                spend_key: n.spend_key,
                nk_pub: n.nk_pub,
                nk_note: n.nk_note,
                leaf_index: (pad + k) as u64,
                path: tree_path(&leaves, pad + k),
                sig: sign(&n.sk, &msg, &h(b"nonce", k as u8)),
            })
            .collect();
        BtcPoolSpendWitness { body, root, inputs, outputs: openings }
    }

    fn pay_1in1out() -> (BtcPoolSpendWitness, Vec<Note>) {
        let notes = vec![Note::new(50_000, 1)];
        let (o, op) = pay_output(50_000, 11);
        (assemble(&notes, 3, vec![o], None, vec![op]), notes)
    }

    fn pay_2in3out() -> (BtcPoolSpendWitness, Vec<Note>) {
        let notes = vec![Note::new(50_000, 1), Note::new(7_000, 2)];
        let (a, oa) = pay_output(40_000, 12);
        let (b, ob) = pay_output(16_000, 13);
        let (c, oc) = pay_output(1_000, 14);
        (assemble(&notes, 5, vec![a, b, c], None, vec![oa, ob, oc]), notes)
    }

    fn exit_1in() -> (BtcPoolSpendWitness, Vec<Note>) {
        let notes = vec![Note::new(50_000, 3)];
        let (e, op) = exit_output(50_000, 21);
        (assemble(&notes, 1, vec![], Some(e), vec![op]), notes)
    }

    /// Two inputs into two pool outputs (change, relayer fee) and an exit.
    fn partial_exit_2in() -> (BtcPoolSpendWitness, Vec<Note>) {
        let notes = vec![Note::new(30_000, 4), Note::new(12_000, 5)];
        let (a, oa) = pay_output(9_500, 15);
        let (b, ob) = pay_output(500, 16);
        let (e, oe) = exit_output(32_000, 22);
        (assemble(&notes, 2, vec![a, b], Some(e), vec![oa, ob, oe]), notes)
    }

    fn bind_outpoint(seed: u8, vout: u32) -> [u8; BTC_POOL_BIND_LEN] {
        let mut b = [0u8; BTC_POOL_BIND_LEN];
        b[..32].copy_from_slice(&h(b"bind-txid", seed));
        b[32..].copy_from_slice(&vout.to_le_bytes());
        b
    }

    fn want_of(vout: u32, value: u64, seed: u8) -> BtcPoolWant {
        BtcPoolWant { vout, value, spk_hash: h(b"want-spk", seed) }
    }

    /// A pay whose carrier must spend a bound outpoint.
    fn pay_bound() -> (BtcPoolSpendWitness, Vec<Note>) {
        let notes = vec![Note::new(50_000, 6)];
        let (a, oa) = pay_output(49_000, 17);
        let (b, ob) = pay_output(1_000, 18);
        (assemble_full(&notes, 4, vec![a, b], None, vec![oa, ob], bind_outpoint(1, 7), None), notes)
    }

    /// Exit to a maker's script with a want paying sats back, change kept shielded.
    fn exit_want_partial() -> (BtcPoolSpendWitness, Vec<Note>) {
        let notes = vec![Note::new(40_000, 7), Note::new(5_000, 8)];
        let (a, oa) = pay_output(15_000, 19);
        let (e, oe) = exit_output(30_000, 23);
        (assemble_full(&notes, 3, vec![a], Some(e), vec![oa, oe], bind_outpoint(2, 0), Some(want_of(2, 29_500, 1))), notes)
    }

    /// Re-sign every input after the body changed, so a test isolates the check it targets.
    fn resign(w: &mut BtcPoolSpendWitness, notes: &[Note]) {
        let msg = btc_pool_spend_msg(&w.body);
        for (k, (i, n)) in w.inputs.iter_mut().zip(notes).enumerate() {
            i.sig = sign(&n.sk, &msg, &h(b"nonce2", k as u8));
        }
    }

    fn expect_ok(w: &BtcPoolSpendWitness) -> BtcPoolSpendStatement {
        let st = verify_btc_pool_spend(w).expect("valid spend accepted");
        assert_eq!(st.root, w.root);
        assert_eq!(st.body_hash, cxfer_core::keccak_bytes(&w.body));
        st
    }

    #[test]
    fn btc_pool_valid_pay_1in_1out() {
        let (w, notes) = pay_1in1out();
        expect_ok(&w);
        let body = BtcPoolSpendBody::parse(&w.body).unwrap();
        assert_eq!(body.nullifiers, vec![notes[0].nf(3)]);
        assert_eq!(w.body.len(), PRE + 1 + 32 + 1 + BTC_POOL_OUTPUT_LEN + 1 + 1);
        assert_eq!(body.encode(), w.body);
    }

    #[test]
    fn btc_pool_valid_pay_2in_3out() {
        let (w, _) = pay_2in3out();
        expect_ok(&w);
        let body = BtcPoolSpendBody::parse(&w.body).unwrap();
        assert_eq!((body.outputs.len(), body.exit.is_none()), (3, true));
        assert_eq!(w.body.len(), PRE + 1 + 64 + 1 + 3 * BTC_POOL_OUTPUT_LEN + 1 + 1);
        assert_eq!(body.encode(), w.body);
    }

    #[test]
    fn btc_pool_valid_exit_only() {
        let (w, _) = exit_1in();
        expect_ok(&w);
        let body = BtcPoolSpendBody::parse(&w.body).unwrap();
        assert!(body.outputs.is_empty() && body.exit.is_some());
        assert_eq!(w.body.len(), PRE + 1 + 32 + 1 + 1 + BTC_POOL_EXIT_LEN + 1);
        assert_eq!(body.encode(), w.body);
    }

    #[test]
    fn btc_pool_valid_partial_exit() {
        let (w, _) = partial_exit_2in();
        expect_ok(&w);
        let body = BtcPoolSpendBody::parse(&w.body).unwrap();
        assert_eq!((body.outputs.len(), body.exit.is_some()), (2, true));
        assert_eq!(w.body.len(), PRE + 1 + 64 + 1 + 2 * BTC_POOL_OUTPUT_LEN + 1 + BTC_POOL_EXIT_LEN + 1);
        assert_eq!(body.encode(), w.body);
    }

    #[test]
    fn btc_pool_public_values_layout() {
        let (w, _) = pay_1in1out();
        let pv = expect_ok(&w).abi_encode();
        assert_eq!(&pv[..30], &[0u8; 30]);
        assert_eq!(&pv[30..32], &[0, 1]);
        assert_eq!(&pv[32..64], &w.root);
        assert_eq!(&pv[64..96], &cxfer_core::keccak_bytes(&w.body));
    }

    #[test]
    fn btc_pool_rejects_wrong_nk_note() {
        let (mut w, _) = pay_1in1out();
        w.inputs[0].nk_note = sbytes(&scalar_reduce_be(&h(b"nk", 99)));
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: nk_pub does not match nk_note"));
    }

    #[test]
    fn btc_pool_rejects_nk_note_plus_order_alias() {
        // A note whose nk_note is small enough that nk_note + n still fits in 32 bytes.
        let mut note = Note::new(50_000, 1);
        let d = Scalar::from(0x1234_5678u64);
        note.nk_note = sbytes(&d);
        note.nk_pub = pubc(&d);
        let (o, op) = pay_output(50_000, 11);
        let mut w = assemble(&[note.clone()], 0, vec![o], None, vec![op]);
        expect_ok(&w);

        let mut alias = N_BE;
        let mut carry = 0u16;
        for k in (0..32).rev() {
            let s = alias[k] as u16 + note.nk_note[k] as u16 + carry;
            alias[k] = s as u8;
            carry = s >> 8;
        }
        assert_eq!(carry, 0);
        assert_eq!(scalar_reduce_be(&alias), d, "d + n reduces to d");
        // The aliased encoding would name a different nullifier; put it in the body so only the
        // canonicality check stands between it and acceptance.
        let mut body = BtcPoolSpendBody::parse(&w.body).unwrap();
        body.nullifiers[0] = btc_pool_nullifier(&note.leaf(), &alias, 0);
        assert_ne!(body.nullifiers[0], note.nf(0));
        w.body = body.encode();
        resign(&mut w, &[note]);
        w.inputs[0].nk_note = alias;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: nk_note not canonical"));
    }

    #[test]
    fn btc_pool_rejects_zero_nk_note() {
        let (mut w, _) = pay_1in1out();
        w.inputs[0].nk_note = [0u8; 32];
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: nk_note is zero"));
    }

    #[test]
    fn btc_pool_rejects_parity_flipped_nk_pub() {
        // nk_note' = n - nk_note has the same x-coordinate as nk_note and the opposite parity.
        let (w0, notes) = pay_1in1out();
        let d = scalar_reduce_be(&notes[0].nk_note);
        let neg = sbytes(&-d);
        assert_eq!(pubc(&-d)[1..], notes[0].nk_pub[1..]);
        assert_ne!(pubc(&-d)[0], notes[0].nk_pub[0]);

        // Same note, negated nk_note: the leaf pins nk_pub's parity, so the point check rejects it.
        let mut body = BtcPoolSpendBody::parse(&w0.body).unwrap();
        body.nullifiers[0] = btc_pool_nullifier(&notes[0].leaf(), &neg, 3);
        let mut w = w0.clone();
        w.body = body.encode();
        resign(&mut w, &notes);
        w.inputs[0].nk_note = neg;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: nk_pub does not match nk_note"));

        // Flipping the parity byte of nk_pub alongside changes the leaf, which is not in the tree.
        let mut w = w0.clone();
        w.inputs[0].nk_note = neg;
        w.inputs[0].nk_pub[0] ^= 0x01;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));
    }

    #[test]
    fn btc_pool_rejects_bad_sig() {
        let (mut w, _) = pay_1in1out();
        w.inputs[0].sig[40] ^= 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: spend signature"));

        let (mut w, _) = pay_1in1out();
        let other = scalar_reduce_be(&h(b"sk", 77));
        w.inputs[0].sig = sign(&other, &btc_pool_spend_msg(&w.body), &[9u8; 32]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: spend signature"));
    }

    #[test]
    fn btc_pool_rejects_sig_over_other_body() {
        let (mut w, notes) = pay_1in1out();
        let (w_exit, _) = {
            let (e, op) = exit_output(50_000, 21);
            (assemble(&notes, 3, vec![], Some(e), vec![op]), ())
        };
        assert_eq!(w_exit.root, w.root);
        expect_ok(&w_exit);
        // The pay body with the exit body's signature.
        w.inputs[0].sig = w_exit.inputs[0].sig;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: spend signature"));
        // A signature over the raw body without the domain.
        w.inputs[0].sig = sign(&notes[0].sk, &cxfer_core::keccak_bytes(&w.body), &[3u8; 32]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: spend signature"));
    }

    #[test]
    fn btc_pool_rejects_body_tampered_after_signing() {
        let (w0, _) = pay_1in1out();
        // Every byte outside the nullifier field is covered only by the signature, so flipping it (while
        // keeping the body parseable and every other check satisfied where possible) must fail.
        let nf_range = PRE + 1..PRE + 33;
        for pos in 0..w0.body.len() {
            if nf_range.contains(&pos) {
                continue;
            }
            let mut w = w0.clone();
            w.body[pos] ^= 0x01;
            assert!(verify_btc_pool_spend(&w).is_err(), "tamper at byte {pos} accepted");
        }
        // Changing h_anchor, bind, pk_eph's parity (still a valid point) or ct_note fails on the signature.
        let pk_eph_at = PRE + 34 + 32 + 32 + 32 + 33;
        for pos in [33usize, 37, PRE - 1, pk_eph_at, w0.body.len() - 3] {
            let mut w = w0.clone();
            w.body[pos] ^= 0x01;
            assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: spend signature"), "byte {pos}");
        }
        // Exit: moving the exit to another vout or destination.
        let (w0, _) = exit_1in();
        let base = PRE + 1 + 32 + 1 + 1;
        for pos in [base, base + 4 + 64 + 3] {
            let mut w = w0.clone();
            w.body[pos] ^= 0x01;
            assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: spend signature"), "byte {pos}");
        }
        // Partial exit: every byte outside the nullifiers.
        let (w0, _) = partial_exit_2in();
        let nf_range = PRE + 1..PRE + 65;
        for pos in 0..w0.body.len() {
            if nf_range.contains(&pos) {
                continue;
            }
            let mut w = w0.clone();
            w.body[pos] ^= 0x01;
            assert!(verify_btc_pool_spend(&w).is_err(), "tamper at byte {pos} accepted");
        }
        // Bind and want: moving the bound outpoint, the want's output, its amount or its script.
        let (w0, _) = exit_want_partial();
        let want_at = w0.body.len() - BTC_POOL_WANT_LEN;
        for pos in [37usize, 68, 72, want_at, want_at + 4, want_at + 11, want_at + 12, w0.body.len() - 1] {
            let mut w = w0.clone();
            w.body[pos] ^= 0x01;
            assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: spend signature"), "byte {pos}");
        }
        let nf_range = PRE + 1..PRE + 65;
        for pos in 0..w0.body.len() {
            if nf_range.contains(&pos) {
                continue;
            }
            let mut w = w0.clone();
            w.body[pos] ^= 0x01;
            assert!(verify_btc_pool_spend(&w).is_err(), "tamper at byte {pos} accepted");
        }
    }

    #[test]
    fn btc_pool_rejects_bad_membership() {
        let (mut w, _) = pay_1in1out();
        w.inputs[0].leaf_index += 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));

        let (mut w, _) = pay_1in1out();
        w.root[0] ^= 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));

        let (mut w, _) = pay_1in1out();
        w.inputs[0].path[5][0] ^= 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));

        let (mut w, _) = pay_1in1out();
        w.inputs[0].path.pop();
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));

        // Another asset in the body changes the leaf.
        let (mut w, notes) = pay_1in1out();
        w.body[1] ^= 1;
        resign(&mut w, &notes);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));

        // A different spend_key changes the leaf.
        let (mut w, _) = pay_1in1out();
        w.inputs[0].spend_key = xonly_of(&scalar_reduce_be(&h(b"sk", 55)));
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));
    }

    #[test]
    fn btc_pool_rejects_unbalanced() {
        let notes = vec![Note::new(50_000, 1)];
        let (o, op) = pay_output(50_001, 11);
        let w = assemble(&notes, 0, vec![o], None, vec![op]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: conservation"));

        let (e, op) = exit_output(49_999, 21);
        let w = assemble(&notes, 0, vec![], Some(e), vec![op]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: conservation"));

        // Partial exit whose exit carries one unit more or less than the balance leaves.
        let notes = vec![Note::new(30_000, 4), Note::new(12_000, 5)];
        for v_exit in [32_001u64, 31_999] {
            let (a, oa) = pay_output(9_500, 15);
            let (b, ob) = pay_output(500, 16);
            let (e, oe) = exit_output(v_exit, 22);
            let w = assemble(&notes, 2, vec![a, b], Some(e), vec![oa, ob, oe]);
            assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: conservation"));
        }
        // The exit's opening misstated in the witness.
        let (mut w, _) = partial_exit_2in();
        w.outputs[2].value += 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output opening"));
        // Openings in the wrong order: the exit's opening against a pool output.
        let (mut w, _) = partial_exit_2in();
        w.outputs.rotate_right(1);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output opening"));

        let (mut w, _) = pay_1in1out();
        w.outputs[0].value += 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output opening"));

        let (mut w, _) = pay_1in1out();
        w.inputs[0].value += 1;
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input opening"));

        let (mut w, _) = pay_1in1out();
        w.outputs.push(BtcPoolOpening { value: 0, blinding: [1u8; 32] });
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output count does not match body"));
    }

    #[test]
    fn btc_pool_rejects_overflow() {
        // Sums agree mod 2^64 (u64::MAX + 2 ≡ 1) but not over u128.
        let notes = vec![Note::new(u64::MAX, 1), Note::new(2, 2)];
        let (o, op) = pay_output(1, 11);
        let w = assemble(&notes, 0, vec![o], None, vec![op]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: conservation"));
        let (e, oe) = exit_output(1, 21);
        let w = assemble(&notes, 0, vec![], Some(e), vec![oe]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: conservation"));

        // Values near the top of u64 balance exactly over u128.
        let (a, oa) = pay_output(u64::MAX, 12);
        let (b, ob) = pay_output(2, 13);
        let w = assemble(&notes, 0, vec![a, b], None, vec![oa, ob]);
        expect_ok(&w);
        let (a, oa) = pay_output(u64::MAX, 12);
        let (e, oe) = exit_output(2, 21);
        let w = assemble(&notes, 0, vec![a], Some(e), vec![oa, oe]);
        expect_ok(&w);
    }

    #[test]
    fn btc_pool_rejects_repeated_nullifier() {
        // One note named twice at its own position: one nullifier appearing twice in the body.
        let n = Note::new(25_000, 1);
        let (o, op) = pay_output(50_000, 11);
        let mut w = assemble(&[n.clone()], 2, vec![o], None, vec![op]);
        let mut body = BtcPoolSpendBody::parse(&w.body).unwrap();
        body.nullifiers.push(body.nullifiers[0]);
        w.body = body.encode();
        w.inputs.push(w.inputs[0].clone());
        resign(&mut w, &[n.clone(), n]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: repeated nullifier"));
    }

    #[test]
    fn btc_pool_identical_leaves_are_independent_notes() {
        let n = Note::new(25_000, 1);
        let leaves = vec![h(b"filler", 0), n.leaf(), n.leaf()];
        let root = cxfer_core::keccak_merkle_root(&leaves);
        assert_ne!(n.nf(1), n.nf(2));

        // Both copies in one spend.
        let (o, op) = pay_output(50_000, 11);
        let w = assemble(&[n.clone(), n.clone()], 1, vec![o], None, vec![op]);
        assert_eq!(w.root, root);
        expect_ok(&w);
        let body = BtcPoolSpendBody::parse(&w.body).unwrap();
        assert_eq!(body.nullifiers, vec![n.nf(1), n.nf(2)]);

        // Each copy on its own, under the same root, with distinct nullifiers.
        let mut seen = Vec::new();
        for idx in [1usize, 2] {
            let (o, op) = pay_output(25_000, 12);
            let body = BtcPoolSpendBody {
                asset: ASSET,
                h_anchor: H_ANCHOR,
                bind: [0u8; BTC_POOL_BIND_LEN],
                nullifiers: vec![n.nf(idx as u64)],
                outputs: vec![o],
                exit: None,
                want: None,
            }
            .encode();
            let sig = sign(&n.sk, &btc_pool_spend_msg(&body), &[5u8; 32]);
            let w = BtcPoolSpendWitness {
                body,
                root,
                inputs: vec![BtcPoolSpendInput {
                    cx: n.cx,
                    cy: n.cy,
                    value: n.value,
                    blinding: n.blinding,
                    spend_key: n.spend_key,
                    nk_pub: n.nk_pub,
                    nk_note: n.nk_note,
                    leaf_index: idx as u64,
                    path: tree_path(&leaves, idx),
                    sig,
                }],
                outputs: vec![op],
            };
            expect_ok(&w);
            seen.push(BtcPoolSpendBody::parse(&w.body).unwrap().nullifiers[0]);
            // Claiming the other copy's position under this nullifier fails.
            let mut w2 = w.clone();
            w2.inputs[0].leaf_index = (3 - idx) as u64;
            w2.inputs[0].path = tree_path(&leaves, 3 - idx);
            assert_eq!(verify_btc_pool_spend(&w2), Err("btc-pool: nullifier mismatch"));
        }
        assert_ne!(seen[0], seen[1]);
    }

    #[test]
    fn btc_pool_rejects_index_beyond_tree() {
        // index + 2^32 folds to the same root but would name a second nullifier.
        let (mut w, notes) = pay_1in1out();
        let wide = w.inputs[0].leaf_index + (1u64 << 32);
        let mut body = BtcPoolSpendBody::parse(&w.body).unwrap();
        body.nullifiers[0] = notes[0].nf(wide);
        w.body = body.encode();
        resign(&mut w, &notes);
        w.inputs[0].leaf_index = wide;
        assert!(keccak_merkle_verify(&notes[0].leaf(), wide, &w.inputs[0].path, &w.root));
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input membership"));
    }

    #[test]
    fn btc_pool_rejects_nullifier_mismatch() {
        let (mut w, notes) = pay_1in1out();
        let mut body = BtcPoolSpendBody::parse(&w.body).unwrap();
        body.nullifiers[0][0] ^= 1;
        w.body = body.encode();
        resign(&mut w, &notes);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: nullifier mismatch"));

        // Two inputs with their nullifiers swapped in the body.
        let (mut w, notes) = pay_2in3out();
        let mut body = BtcPoolSpendBody::parse(&w.body).unwrap();
        body.nullifiers.swap(0, 1);
        w.body = body.encode();
        resign(&mut w, &notes);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: nullifier mismatch"));
    }

    #[test]
    fn btc_pool_rejects_noncanonical_body() {
        let (w0, notes) = pay_1in1out();
        let check = |mutate: &dyn Fn(&mut Vec<u8>), err: &str| {
            let mut w = w0.clone();
            mutate(&mut w.body);
            resign(&mut w, &notes);
            assert_eq!(verify_btc_pool_spend(&w), Err(err));
        };
        check(&|b| b.push(0), "btc-pool: trailing bytes in body");
        check(&|b| b.truncate(b.len() - 1), "btc-pool: body truncated");
        check(&|b| b[0] = 0x6C, "btc-pool: body opcode");
        let (n_in_at, n_out_at) = (PRE, PRE + 33);
        let has_exit_at = n_out_at + 1 + BTC_POOL_OUTPUT_LEN;
        let has_want_at = has_exit_at + 1;
        assert_eq!(w0.body.len(), has_want_at + 1);
        check(&|b| b[n_in_at] = 0, "btc-pool: n_in out of range");
        check(&|b| b[n_in_at] = 3, "btc-pool: n_in out of range");
        check(&|b| b[n_out_at] = 4, "btc-pool: n_out out of range");
        check(&|b| b[n_out_at] = 0xFF, "btc-pool: n_out out of range");
        check(&|b| b[has_exit_at] = 2, "btc-pool: bad has_exit");
        check(&|b| b[has_exit_at] = 0xFF, "btc-pool: bad has_exit");
        check(&|b| b[has_want_at] = 2, "btc-pool: bad has_want");
        check(&|b| b[has_want_at] = 0xFF, "btc-pool: bad has_want");
        // has_exit = 1 with no exit bytes; has_want = 1 with no want bytes.
        check(&|b| b[has_exit_at] = 1, "btc-pool: body truncated");
        check(&|b| b[has_want_at] = 1, "btc-pool: body truncated");
        // A body cut inside bind.
        check(&|b| b.truncate(1 + 32 + 4 + 20), "btc-pool: body truncated");
        // n_in = 2 declared over a single nullifier re-frames every later field.
        let mut w = w0.clone();
        w.body[n_in_at] = 2;
        assert!(BtcPoolSpendBody::parse(&w.body).is_err());
        check(&|b| b.clear(), "btc-pool: body truncated");

        // Truncated exit, at every length short of the full 100 bytes (plus has_want).
        let (w0, notes) = partial_exit_2in();
        for cut in 1..=BTC_POOL_EXIT_LEN + 1 {
            let mut w = w0.clone();
            w.body.truncate(w0.body.len() - cut);
            resign(&mut w, &notes);
            assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: body truncated"), "cut {cut}");
        }
        let (w0, notes) = exit_1in();
        let mut w = w0.clone();
        w.body.truncate(w0.body.len() - 1);
        resign(&mut w, &notes);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: body truncated"));
        // Exit bytes after has_exit = 0: with no pool output the spend is empty, otherwise the exit trails.
        let mut w = w0.clone();
        w.body[PRE + 34] = 0;
        resign(&mut w, &notes);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: spend has no outputs"));
        let (w0, notes) = partial_exit_2in();
        let has_exit_at = PRE + 1 + 64 + 1 + 2 * BTC_POOL_OUTPUT_LEN;
        assert_eq!(w0.body[has_exit_at], 1);
        let mut w = w0.clone();
        w.body[has_exit_at] = 0;
        resign(&mut w, &notes);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: trailing bytes in body"));

        // Witness input count must match the body.
        let (mut w, _) = pay_2in3out();
        w.inputs.pop();
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: input count does not match body"));
    }

    #[test]
    fn btc_pool_rejects_empty_spend() {
        // n_out = 0 and has_exit = 0: a spend that only burns its inputs.
        let notes = vec![Note::new(0, 1)];
        let w = assemble(&notes, 0, vec![], None, vec![]);
        assert_eq!(w.body.len(), PRE + 1 + 32 + 1 + 1 + 1);
        assert_eq!(BtcPoolSpendBody::parse(&w.body), Err("btc-pool: spend has no outputs"));
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: spend has no outputs"));
    }

    #[test]
    fn btc_pool_valid_bind_and_want() {
        let (w, _) = pay_bound();
        expect_ok(&w);
        let body = BtcPoolSpendBody::parse(&w.body).unwrap();
        assert_eq!(body.bind, bind_outpoint(1, 7));
        assert_eq!(&w.body[37..73], &bind_outpoint(1, 7));
        assert!(body.want.is_none());
        assert_eq!(body.encode(), w.body);

        let (w, _) = exit_want_partial();
        expect_ok(&w);
        let body = BtcPoolSpendBody::parse(&w.body).unwrap();
        let want = body.want.clone().unwrap();
        assert_eq!(want, want_of(2, 29_500, 1));
        assert_eq!(w.body.len(), PRE + 1 + 64 + 1 + BTC_POOL_OUTPUT_LEN + 1 + BTC_POOL_EXIT_LEN + 1 + BTC_POOL_WANT_LEN);
        let at = w.body.len() - BTC_POOL_WANT_LEN;
        assert_eq!(w.body[at - 1], 1);
        assert_eq!(&w.body[at..at + 4], &2u32.to_le_bytes());
        assert_eq!(&w.body[at + 4..at + 12], &29_500u64.to_le_bytes());
        assert_eq!(&w.body[at + 12..], &want.spk_hash);
        assert_eq!(body.encode(), w.body);

        // A want on a pay with no exit, and u64::MAX sats: parsing places no bound on the value.
        let notes = vec![Note::new(10_000, 9)];
        let (o, op) = pay_output(10_000, 20);
        let w = assemble_full(&notes, 0, vec![o], None, vec![op], [0u8; BTC_POOL_BIND_LEN], Some(want_of(0, u64::MAX, 2)));
        expect_ok(&w);
    }

    #[test]
    fn btc_pool_rejects_malformed_want() {
        let (w0, notes) = exit_want_partial();
        let has_want_at = w0.body.len() - BTC_POOL_WANT_LEN - 1;
        let check = |mutate: &dyn Fn(&mut Vec<u8>), err: &str| {
            let mut w = w0.clone();
            mutate(&mut w.body);
            resign(&mut w, &notes);
            assert_eq!(BtcPoolSpendBody::parse(&w.body), Err(err));
            assert_eq!(verify_btc_pool_spend(&w), Err(err));
        };
        for v in [2u8, 3, 0x80, 0xFF] {
            check(&|b| b[has_want_at] = v, "btc-pool: bad has_want");
        }
        // Want bytes after has_want = 0.
        check(&|b| b[has_want_at] = 0, "btc-pool: trailing bytes in body");
        // Truncated want, at every length short of the full 44 bytes.
        for cut in 1..=BTC_POOL_WANT_LEN {
            check(&|b| b.truncate(b.len() - cut), "btc-pool: body truncated");
        }
        // Missing has_want byte altogether.
        let (w1, n1) = partial_exit_2in();
        let mut w = w1.clone();
        w.body.pop();
        resign(&mut w, &n1);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: body truncated"));
        // Extra byte after a want.
        check(&|b| b.push(0), "btc-pool: trailing bytes in body");
        // A want alone is not a spend output: no pool output and no exit is still empty.
        let notes = vec![Note::new(0, 1)];
        let w = assemble_full(&notes, 0, vec![], None, vec![], [0u8; BTC_POOL_BIND_LEN], Some(want_of(1, 1_000, 3)));
        assert_eq!(BtcPoolSpendBody::parse(&w.body), Err("btc-pool: spend has no outputs"));
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: spend has no outputs"));
    }

    #[test]
    fn btc_pool_bind_and_want_do_not_touch_conservation() {
        // The want's sats are outside the pool: exit plus outputs still equal the inputs exactly.
        let notes = vec![Note::new(40_000, 7), Note::new(5_000, 8)];
        for v_exit in [30_001u64, 29_999] {
            let (a, oa) = pay_output(15_000, 19);
            let (e, oe) = exit_output(v_exit, 23);
            let w = assemble_full(&notes, 3, vec![a], Some(e), vec![oa, oe], bind_outpoint(2, 0), Some(want_of(2, 30_000, 1)));
            assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: conservation"));
        }
        // Signing a body with bind zero and carrying it with a bind set (or the reverse) fails.
        let (w, notes) = pay_1in1out();
        let mut body = BtcPoolSpendBody::parse(&w.body).unwrap();
        body.bind = bind_outpoint(3, 1);
        let mut w2 = w.clone();
        w2.body = body.encode();
        assert_eq!(verify_btc_pool_spend(&w2), Err("btc-pool: spend signature"));
        resign(&mut w2, &notes);
        expect_ok(&w2);
    }

    #[test]
    fn btc_pool_rejects_four_outputs() {
        let notes = vec![Note::new(40_000, 1)];
        let outs: Vec<(BtcPoolOutput, BtcPoolOpening)> = (0..4).map(|k| pay_output(10_000, 30 + k)).collect();
        let w = assemble(
            &notes,
            0,
            outs.iter().map(|o| o.0.clone()).collect(),
            None,
            outs.iter().map(|o| o.1.clone()).collect(),
        );
        assert_eq!(w.body[PRE + 33], 4);
        assert_eq!(BtcPoolSpendBody::parse(&w.body), Err("btc-pool: n_out out of range"));
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: n_out out of range"));
        // Three outputs and an exit is within bounds.
        let outs: Vec<(BtcPoolOutput, BtcPoolOpening)> = (0..3).map(|k| pay_output(10_000, 30 + k)).collect();
        let (e, oe) = exit_output(10_000, 21);
        let mut openings: Vec<BtcPoolOpening> = outs.iter().map(|o| o.1.clone()).collect();
        openings.push(oe);
        let w = assemble(&notes, 0, outs.iter().map(|o| o.0.clone()).collect(), Some(e), openings);
        expect_ok(&w);
    }

    #[test]
    fn btc_pool_rejects_output_count_mismatch() {
        // Exit present, its opening missing.
        let (mut w, _) = partial_exit_2in();
        w.outputs.pop();
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output count does not match body"));
        // Exit present, no openings at all.
        let (mut w, _) = exit_1in();
        w.outputs.clear();
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output count does not match body"));
        // An extra opening beyond outputs + exit.
        let (mut w, _) = exit_1in();
        w.outputs.push(BtcPoolOpening { value: 0, blinding: [1u8; 32] });
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output count does not match body"));
        let (mut w, _) = partial_exit_2in();
        w.outputs.push(BtcPoolOpening { value: 0, blinding: [1u8; 32] });
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output count does not match body"));
        // No exit: one opening per pool output, nothing more.
        let (mut w, _) = pay_2in3out();
        w.outputs.pop();
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: output count does not match body"));
    }

    #[test]
    fn btc_pool_rejects_invalid_output_points() {
        let notes = vec![Note::new(50_000, 1)];
        let mut bad_x = [0u8; 32];
        bad_x[31] = 5; // 5^3 + 7 is a non-residue mod p: no point has x = 5
        let cases: [(&dyn Fn(&mut BtcPoolOutput), &str); 7] = [
            (&|o| o.spend_key = bad_x, "btc-pool: spend_key not an x-only key"),
            (&|o| o.nk_pub[1..].copy_from_slice(&bad_x), "btc-pool: nk_pub not a compressed point"),
            (&|o| o.nk_pub[0] = 0x04, "btc-pool: nk_pub not a compressed point"),
            (&|o| o.pk_eph[1..].copy_from_slice(&bad_x), "btc-pool: pk_eph not a compressed point"),
            (&|o| o.pk_eph = [0u8; 33], "btc-pool: pk_eph not a compressed point"),
            (&|o| o.cy[31] ^= 1, "btc-pool: commitment not a curve point"),
            (&|o| o.cx = [0u8; 32], "btc-pool: commitment not a curve point"),
        ];
        for (mutate, err) in cases {
            let (mut o, op) = pay_output(50_000, 11);
            mutate(&mut o);
            let w = assemble(&notes, 0, vec![o], None, vec![op]);
            assert_eq!(BtcPoolSpendBody::parse(&w.body), Err(err));
            assert_eq!(verify_btc_pool_spend(&w), Err(err));
            // The same output in the last slot of a partial exit.
            let (mut o, op) = pay_output(10_000, 12);
            mutate(&mut o);
            let (a, oa) = pay_output(20_000, 13);
            let (e, oe) = exit_output(20_000, 21);
            let w = assemble(&notes, 0, vec![a, o], Some(e), vec![oa, op, oe]);
            assert_eq!(verify_btc_pool_spend(&w), Err(err));
        }
        let (mut e, op) = exit_output(50_000, 21);
        e.cy[0] ^= 0x80;
        let w = assemble(&notes, 0, vec![], Some(e.clone()), vec![op.clone()]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: commitment not a curve point"));
        let (a, oa) = pay_output(10_000, 13);
        let w = assemble(&notes, 0, vec![a], Some(e), vec![oa, op]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: commitment not a curve point"));
    }

    #[test]
    fn btc_pool_rejects_coordinates_not_below_p() {
        // p = 2^256 - 2^32 - 977. A point with a small x has an alias x + p that still fits in 32 bytes.
        const P_BE: [u8; 32] = [
            0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
            0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0xFF, 0xFF, 0xFC, 0x2F,
        ];
        let add_p = |x: &[u8; 32]| -> [u8; 32] {
            let mut out = [0u8; 32];
            let mut carry = 0u16;
            for k in (0..32).rev() {
                let s = P_BE[k] as u16 + x[k] as u16 + carry;
                out[k] = s as u8;
                carry = s >> 8;
            }
            assert_eq!(carry, 0);
            out
        };
        let (x, y) = (1u8..=255)
            .find_map(|v| {
                let mut comp = [0u8; 33];
                comp[0] = 0x02;
                comp[32] = v;
                decompress(&comp).map(|p| {
                    let e = p.to_affine().to_encoded_point(false);
                    let mut x = [0u8; 32];
                    let mut y = [0u8; 32];
                    x.copy_from_slice(&e.as_bytes()[1..33]);
                    y.copy_from_slice(&e.as_bytes()[33..65]);
                    (x, y)
                })
            })
            .expect("a small x on the curve");
        assert!(from_affine_xy(&x, &y).is_some());
        assert!(from_affine_xy(&add_p(&x), &y).is_none(), "x + p must not decode");

        let notes = vec![Note::new(50_000, 1)];
        let (mut o, op) = pay_output(50_000, 11);
        o.cx = add_p(&x);
        o.cy = y;
        let w = assemble(&notes, 0, vec![o], None, vec![op.clone()]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: commitment not a curve point"));
        let (mut e, _) = exit_output(50_000, 21);
        e.cx = add_p(&x);
        e.cy = y;
        let w = assemble(&notes, 0, vec![], Some(e), vec![op]);
        assert_eq!(verify_btc_pool_spend(&w), Err("btc-pool: commitment not a curve point"));
    }

    #[test]
    fn btc_pool_nullifier_not_precomputable_from_public_fields() {
        let (w, notes) = pay_1in1out();
        let n = &notes[0];
        let leaf = n.leaf();
        let nf = BtcPoolSpendBody::parse(&w.body).unwrap().nullifiers[0];
        let mut nk_pub_x = [0u8; 32];
        nk_pub_x.copy_from_slice(&n.nk_pub[1..]);
        for public in [n.cx, n.cy, n.spend_key, nk_pub_x, ASSET, [0u8; 32]] {
            assert_ne!(nf, btc_pool_nullifier(&leaf, &public, 3));
        }
        assert_ne!(nf, kn(&[BTC_POOL_NF_DOMAIN, &leaf, &n.nk_pub, &3u64.to_be_bytes()]));
        assert_ne!(nf, kn(&[BTC_POOL_NF_DOMAIN, &leaf, &3u64.to_be_bytes()]));
        assert_ne!(nf, cxfer_core::nullifier(&leaf));
        assert_eq!(nf, kn(&[b"tacit-btc-pool-nf-v1", &leaf, &n.nk_note, &[0, 0, 0, 0, 0, 0, 0, 3]]));
    }

    #[test]
    fn btc_pool_leaf_domain_is_disjoint() {
        let n = Note::new(1, 1);
        let lf = n.leaf();
        assert_eq!(lf, kn(&[&ASSET, &n.cx, &n.cy, &n.spend_key, &n.nk_pub, b"tacit-btc-pool-note-v1"]));
        assert_ne!(lf, cxfer_core::btc_note_leaf(&ASSET, &n.cx, &n.cy, &n.spend_key));
        assert_ne!(lf, cxfer_core::leaf(&ASSET, &n.cx, &n.cy, &n.spend_key));
    }

    // ───────── cross-implementation vectors (tests/vectors/btc-pool-vectors.json) ─────────

    fn hx(b: &[u8]) -> String {
        let mut s = String::from("0x");
        for x in b {
            s.push_str(&format!("{:02x}", x));
        }
        s
    }

    fn witness_json(w: &BtcPoolSpendWitness) -> serde_json::Value {
        serde_json::json!({
            "body": hx(&w.body),
            "root": hx(&w.root),
            "inputs": w.inputs.iter().map(|i| serde_json::json!({
                "cx": hx(&i.cx), "cy": hx(&i.cy), "value": i.value.to_string(), "blinding": hx(&i.blinding),
                "spend_key": hx(&i.spend_key), "nk_pub": hx(&i.nk_pub), "nk_note": hx(&i.nk_note),
                "leaf_index": i.leaf_index, "path": i.path.iter().map(|p| hx(p)).collect::<Vec<_>>(),
                "sig": hx(&i.sig),
            })).collect::<Vec<_>>(),
            "outputs": w.outputs.iter().map(|o| serde_json::json!({
                "value": o.value.to_string(), "blinding": hx(&o.blinding),
            })).collect::<Vec<_>>(),
        })
    }

    fn body_json(body: &BtcPoolSpendBody) -> serde_json::Value {
        let outputs = body
            .outputs
            .iter()
            .map(|o| {
                serde_json::json!({
                    "cx": hx(&o.cx), "cy": hx(&o.cy), "spend_key": hx(&o.spend_key), "nk_pub": hx(&o.nk_pub),
                    "pk_eph": hx(&o.pk_eph), "ct_note": hx(&o.ct_note), "leaf": hx(&o.leaf(&body.asset)),
                })
            })
            .collect::<Vec<_>>();
        let exit = body.exit.as_ref().map(|e| {
            serde_json::json!({
                "exit_vout": e.exit_vout, "cx": hx(&e.cx), "cy": hx(&e.cy), "dest_spk_hash": hx(&e.dest_spk_hash),
            })
        });
        let want = body.want.as_ref().map(|w| {
            serde_json::json!({ "vout": w.vout, "value": w.value.to_string(), "spk_hash": hx(&w.spk_hash) })
        });
        serde_json::json!({
            "asset": hx(&body.asset),
            "h_anchor": body.h_anchor,
            "bind": hx(&body.bind),
            "nullifiers": body.nullifiers.iter().map(|n| hx(n)).collect::<Vec<_>>(),
            "outputs": outputs,
            "has_exit": body.exit.is_some() as u8,
            "exit": exit,
            "has_want": body.want.is_some() as u8,
            "want": want,
            "body": hx(&body.encode()),
            "body_hash": hx(&cxfer_core::keccak_bytes(&body.encode())),
            "spend_msg": hx(&btc_pool_spend_msg(&body.encode())),
        })
    }

    fn spend_case(name: &str, w: &BtcPoolSpendWitness, notes: &[Note]) -> serde_json::Value {
        let st = expect_ok(w);
        let body = BtcPoolSpendBody::parse(&w.body).unwrap();
        serde_json::json!({
            "name": name,
            "fields": body_json(&body),
            "notes_spent": notes.iter().zip(&w.inputs).map(|(n, i)| serde_json::json!({
                "value": n.value.to_string(), "blinding": hx(&n.blinding), "spend_sk": hx(&sbytes(&n.sk)),
                "leaf": hx(&n.leaf()), "leaf_index": i.leaf_index, "nullifier": hx(&n.nf(i.leaf_index)),
            })).collect::<Vec<_>>(),
            "witness": witness_json(w),
            "public_values": hx(&st.abi_encode()),
        })
    }

    fn vectors() -> serde_json::Value {
        let leaf_cases: Vec<serde_json::Value> =
            [(1u64, 1u8, 0u64), (50_000, 2, 7), (u64::MAX, 3, 0xFFFF_FFFF), (0, 4, 0x0102_0304)]
                .iter()
                .map(|&(v, s, idx)| {
                    let n = Note::new(v, s);
                    serde_json::json!({
                        "asset": hx(&ASSET), "value": v.to_string(), "blinding": hx(&n.blinding),
                        "cx": hx(&n.cx), "cy": hx(&n.cy), "spend_key": hx(&n.spend_key), "nk_pub": hx(&n.nk_pub),
                        "nk_note": hx(&n.nk_note), "leaf": hx(&n.leaf()),
                        "leaf_index": idx, "nullifier": hx(&n.nf(idx)),
                    })
                })
                .collect();
        let msg_cases: Vec<serde_json::Value> = [vec![], vec![0x6D], (0u8..=255).collect::<Vec<u8>>()]
            .iter()
            .map(|b| serde_json::json!({ "body": hx(b), "spend_msg": hx(&btc_pool_spend_msg(b)) }))
            .collect();
        let (pay1, n1) = pay_1in1out();
        let (pay2, n2) = pay_2in3out();
        let (exit, n3) = exit_1in();
        let (partial, n4) = partial_exit_2in();
        let (bound, n5) = pay_bound();
        let (want, n6) = exit_want_partial();
        serde_json::json!({
            "description": "DESIGN-btc-shielded-pool.md §2-§4 vectors from btc-pool-core. Hex is big-endian bytes as they appear on the wire or in the hash preimage; on-wire integers (h_anchor, bind's vout, exit_vout, want's vout and value) are little-endian inside `body`. `bind` is the 36 raw body bytes txid ‖ vout, all zero for none. Values are u64 decimal strings. witness.outputs holds one opening per pool output in body order, then the exit's opening when has_exit = 1.",
            "domains": {
                "note": "tacit-btc-pool-note-v1",
                "nullifier": "tacit-btc-pool-nf-v1",
                "spend": "tacit-btc-pool-spend-v1",
            },
            "formulas": {
                "leaf": "keccak256(asset ‖ Cx ‖ Cy ‖ spend_key ‖ nk_pub(33) ‖ 'tacit-btc-pool-note-v1')",
                "nullifier": "keccak256('tacit-btc-pool-nf-v1' ‖ leaf ‖ nk_note(32, BE) ‖ leaf_index(8, BE))",
                "spend_msg": "keccak256('tacit-btc-pool-spend-v1' ‖ body)",
                "body_hash": "keccak256(body)",
                "public_values": "abi.encode(uint16 1, bytes32 root, bytes32 body_hash)",
                "commitment": "C = value·H + blinding·G, H = the Tacit NUMS generator (tacit-generator-H-v1)",
            },
            "leaf_and_nullifier": leaf_cases,
            "spend_msg": msg_cases,
            "spends": [
                spend_case("pay_1in_1out", &pay1, &n1),
                spend_case("pay_2in_3out", &pay2, &n2),
                spend_case("exit_1in", &exit, &n3),
                spend_case("partial_exit_2in", &partial, &n4),
                spend_case("pay_bind", &bound, &n5),
                spend_case("exit_want_partial", &want, &n6),
            ],
        })
    }

    /// Writes the vectors when BTC_POOL_WRITE_VECTORS=1, otherwise checks the committed file matches.
    #[test]
    fn btc_pool_vectors_file() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/vectors/btc-pool-vectors.json");
        let text = serde_json::to_string_pretty(&vectors()).unwrap() + "\n";
        if std::env::var("BTC_POOL_WRITE_VECTORS").as_deref() == Ok("1") {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &text).unwrap();
        } else if let Ok(existing) = std::fs::read_to_string(&path) {
            assert_eq!(existing, text, "btc-pool-vectors.json is stale: rerun with BTC_POOL_WRITE_VECTORS=1");
        }
    }
}
