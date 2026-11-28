//! Offline tests for the backing ledger and the re-anchoring rule.
//!
//! Everything here runs without a prover, a network, or a live pool: the carrier transactions are built
//! byte-for-byte to Bitcoin's serialization so `cxfer_core::bitcoin` authenticates them for real (txid merkle
//! path, BIP141 witness commitment), and the pool-side proofs are injected through the crate's two seams. That
//! is deliberate — it tests the accounting rule this entry owns, not the crypto it hands off.

use super::*;
use cxfer_core::{commitment_hash, pedersen_commit_xy};

const ASSET: [u8; 32] = [0xB7u8; 32];
const RESERVED: [u8; 32] = [0x07u8; 32];

// ───────────────────────────── Bitcoin plumbing ─────────────────────────────

/// A SegWit transaction: version ‖ marker ‖ flag ‖ 1 input ‖ outputs ‖ 1 witness stack ‖ locktime. The envelope
/// rides witness item 1, the slot `worker-relay/src/lib/btc-pool-chain.js` reads.
/// The witness stack the pool actually reads: `[sig, leaf_script, control_block]`. `inputEnvelope` requires at
/// least three items and reads index 1, so a shorter stack is a spend the pool never sees and `read_exit` must
/// refuse it.
fn env_stack(payload: &[u8]) -> Vec<Vec<u8>> {
    vec![vec![0xFFu8; 32], envelope_script(payload), vec![0x20u8; 33]]
}

fn segwit_tx(witness_items: &[Vec<u8>], outputs: &[(u64, Vec<u8>)]) -> Vec<u8> {
    let mut t = vec![0x02u8, 0, 0, 0, 0x00, 0x01, 0x01];
    t.extend_from_slice(&[0x11u8; 32]); // prevout txid
    t.extend_from_slice(&0u32.to_le_bytes()); // prevout vout
    t.push(0x00); // scriptSig len
    t.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // sequence
    push_varint(&mut t, outputs.len());
    for (value, spk) in outputs {
        t.extend_from_slice(&value.to_le_bytes());
        push_varint(&mut t, spk.len());
        t.extend_from_slice(spk);
    }
    push_varint(&mut t, witness_items.len());
    for item in witness_items {
        push_varint(&mut t, item.len());
        t.extend_from_slice(item);
    }
    t.extend_from_slice(&[0, 0, 0, 0]); // locktime
    t
}

/// CompactSize, as Bitcoin serializes every count and length. A single byte would silently truncate an envelope
/// body (well past 0xff bytes) and produce a transaction that does not parse.
fn push_varint(out: &mut Vec<u8>, v: usize) {
    if v < 0xfd {
        out.push(v as u8);
    } else if v <= 0xffff {
        out.push(0xfd);
        out.extend_from_slice(&(v as u16).to_le_bytes());
    } else {
        out.push(0xfe);
        out.extend_from_slice(&(v as u32).to_le_bytes());
    }
}

/// The coinbase of a one-transaction block: a BIP141 commitment output over `tx`'s real witness, plus the
/// reserved-value witness item. Deterministic, so a test can rebuild it to read its txid.
fn coinbase_for(tx: &[u8]) -> Vec<u8> {
    let witness_root = cxfer_core::bitcoin::compute_merkle_root(&[
        [0u8; 32],
        cxfer_core::bitcoin::double_sha256(tx),
    ]);
    let mut pre = [0u8; 64];
    pre[..32].copy_from_slice(&witness_root);
    pre[32..].copy_from_slice(&RESERVED);
    let commitment = cxfer_core::bitcoin::double_sha256(&pre);

    let mut cb = vec![0x02u8, 0, 0, 0, 0x00, 0x01, 0x01];
    cb.extend_from_slice(&[0u8; 32]); // coinbase prevout txid
    cb.extend_from_slice(&0xffffffffu32.to_le_bytes()); // coinbase prevout vout
    cb.push(0x00); // scriptSig len
    cb.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // sequence
    cb.push(0x01); // one output
    cb.extend_from_slice(&0u64.to_le_bytes());
    cb.push(0x26); // 38-byte commitment script
    cb.extend_from_slice(&[0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed]);
    cb.extend_from_slice(&commitment);
    cb.push(0x01); // one witness item: the reserved value
    cb.push(0x20);
    cb.extend_from_slice(&RESERVED);
    cb.extend_from_slice(&[0, 0, 0, 0]);
    cb
}

/// The `h_anchor` a carrier's spend envelope proves against, read out of the transaction the same way
/// `read_exit` reads it. `None` when the carrier holds no parseable `T_BTC_SPEND`.
fn h_anchor_of(tx: &[u8]) -> Option<u32> {
    let inputs = cxfer_core::bitcoin::extract_inputs(tx)?;
    for vin in 0..inputs.len() {
        if let Some(p) = envelope_of_input(tx, vin) {
            if let Some(b) = parse_spend(&p) {
                return Some(b.h_anchor);
            }
        }
    }
    None
}

/// A witness for `tx` as the second transaction of a two-leaf block, every path derived from the bytes.
fn witness_for(tx: &[u8], pool_root: [u8; 32], value: u64, blinding: [u8; 32]) -> ExitWitness {
    let cb = coinbase_for(tx);
    let cb_txid = cxfer_core::bitcoin::compute_txid(&cb).unwrap();
    let txid = cxfer_core::bitcoin::compute_txid(tx).unwrap();
    let root = cxfer_core::bitcoin::compute_merkle_root(&[cb_txid, txid]);
    ExitWitness {
        tx: tx.to_vec(),
        vin: 0,
        // the coinbase wtxid is 0 and it sits at index 0, so the tx's sibling at index 1 is zero
        wtxid_siblings: vec![[0u8; 32]],
        coinbase: cb,
        // the coinbase's sibling at index 0 is the tx under test
        coinbase_txid_siblings: vec![txid],
        merkle_index: 1,
        merkle_siblings: vec![cb_txid],
        confirmed_block_root: root,
        // The block height is derived from the spend's own `h_anchor` so every fixture sits inside the
        // pool's 144-block window: the carrier confirms one block after the anchor it proves against.
        confirmed_block_height: h_anchor_of(tx).map(|h| h + 1).unwrap_or(800_001),
        pool_root,
        value,
        blinding,
    }
}

/// `<xonly> OP_CHECKSIG OP_FALSE OP_IF "TACIT" 0x01 <payload> OP_ENDIF`: the script a Tacit envelope rides.
fn envelope_script(payload: &[u8]) -> Vec<u8> {
    let mut s = vec![0x20];
    s.extend_from_slice(&[0x22u8; 32]);
    s.push(0xac); // OP_CHECKSIG
    s.push(0x00); // OP_FALSE
    s.push(0x63); // OP_IF
    for part in [b"TACIT".to_vec(), vec![0x01], payload.to_vec()] {
        push_data(&mut s, &part);
    }
    s.push(0x68); // OP_ENDIF
    s
}

fn push_data(s: &mut Vec<u8>, data: &[u8]) {
    if data.len() <= 0x4b {
        s.push(data.len() as u8);
    } else if data.len() <= 0xff {
        s.push(0x4c);
        s.push(data.len() as u8);
    } else {
        s.push(0x4d);
        s.extend_from_slice(&(data.len() as u16).to_le_bytes());
    }
    s.extend_from_slice(data);
}

fn p2tr_script(key: &[u8; 32]) -> Vec<u8> {
    let mut s = vec![0x51, 0x20];
    s.extend_from_slice(key);
    s
}

// ───────────────────────────── pool payloads ─────────────────────────────

fn boundary_bytes(c_secp: &[u8; 33], c_bjj: &[u8; 32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(BOUNDARY_LEN);
    b.extend_from_slice(c_secp);
    b.extend_from_slice(c_bjj);
    b.extend_from_slice(&[0x5Eu8; 169 + 591]); // sigma ‖ bpp: opaque here, the caller's seam owns them
    b
}

/// A compressed secp commitment for `value`: a real curve point, so `commitment_hash_compressed` accepts it.
fn c_secp_of(value: u64, blinding: &[u8; 32]) -> [u8; 33] {
    let enc = {
        let c = cxfer_core::pedersen_commit_xy(value, blinding);
        c
    };
    let _ = enc;
    // `commitment_hash_compressed` decompresses, so build the compressed form from the uncompressed (Cx, Cy)
    // the crate exposes: prefix 0x02 with Cx is a valid point iff Cy is even. Use the crate's own compressor.
    let (cx, cy) = cxfer_core::pedersen_commit_xy(value, blinding);
    let mut buff = [0u8; 33];
    buff[0] = if cy[31] & 1 == 0 { 0x02 } else { 0x03 };
    buff[1..].copy_from_slice(&cx);
    buff
}

/// A `T_BTC_SPEND` payload with `has_exit = 1`, encoded exactly as §3 lays it out.
#[allow(clippy::too_many_arguments)]
fn spend_with_exit(
    asset: &[u8; 32],
    h_anchor: u32,
    nf: &[[u8; 32]],
    exit_vout: u32,
    c_secp: &[u8; 33],
    dest_spk_hash: &[u8; 32],
    boundary: &[u8],
) -> Vec<u8> {
    assert_eq!(boundary.len(), BOUNDARY_LEN);
    let mut exit = Vec::with_capacity(EXIT_LEN);
    exit.extend_from_slice(&exit_vout.to_le_bytes());
    exit.extend_from_slice(dest_spk_hash);
    exit.extend_from_slice(boundary);
    assert_eq!(exit.len(), EXIT_LEN);
    let _ = c_secp;

    let mut b = vec![T_BTC_SPEND];
    b.extend_from_slice(asset);
    b.extend_from_slice(&h_anchor.to_le_bytes());
    b.extend_from_slice(&[0u8; BIND_LEN]); // bind = none
    b.push(nf.len() as u8);
    for n in nf {
        b.extend_from_slice(n);
    }
    b.push(0); // n_out = 0
    b.push(1); // has_exit
    b.extend_from_slice(&exit);
    b.push(0); // has_want
    b.extend_from_slice(&64u16.to_le_bytes()); // proof_len
    b.extend_from_slice(&[0x77u8; 64]); // proof (opaque: the seam verifies it)
    b
}

/// A `T_BTC_SPEND` carrying both an exit and a want, for the check that an unsatisfied want makes the pool
/// reject the whole spend — and with it the exit.
fn spend_with_exit_and_want(
    asset: &[u8; 32],
    h_anchor: u32,
    nf: &[[u8; 32]],
    exit_vout: u32,
    dest_spk_hash: &[u8; 32],
    boundary: &[u8],
    want: &[u8],
) -> Vec<u8> {
    assert_eq!(boundary.len(), BOUNDARY_LEN);
    assert_eq!(want.len(), WANT_LEN);
    let mut exit = Vec::with_capacity(EXIT_LEN);
    exit.extend_from_slice(&exit_vout.to_le_bytes());
    exit.extend_from_slice(dest_spk_hash);
    exit.extend_from_slice(boundary);

    let mut b = vec![T_BTC_SPEND];
    b.extend_from_slice(asset);
    b.extend_from_slice(&h_anchor.to_le_bytes());
    b.extend_from_slice(&[0u8; BIND_LEN]);
    b.push(nf.len() as u8);
    for n in nf {
        b.extend_from_slice(n);
    }
    b.push(0); // n_out = 0
    b.push(1); // has_exit
    b.extend_from_slice(&exit);
    b.push(1); // has_want
    b.extend_from_slice(want);
    b.extend_from_slice(&64u16.to_le_bytes());
    b.extend_from_slice(&[0x77u8; 64]);
    b
}

/// A payload that burns its inputs and creates nothing: no exit, so nothing to anchor.
fn spend_without_exit(asset: &[u8; 32], nf: &[u8; 32]) -> Vec<u8> {
    let mut b = vec![T_BTC_SPEND];
    b.extend_from_slice(asset);
    b.extend_from_slice(&1u32.to_le_bytes());
    b.extend_from_slice(&[0u8; BIND_LEN]);
    b.push(1);
    b.extend_from_slice(nf);
    b.push(0); // n_out
    b.push(0); // has_exit
    b.push(0); // has_want
    b.extend_from_slice(&64u16.to_le_bytes());
    b.extend_from_slice(&[0x77u8; 64]);
    b
}

/// The whole exit fixture: a synthetic `T_BTC_SPEND` carrying an exit, riding a real SegWit carrier in a real
/// one-transaction block, so every Bitcoin check in `read_exit` runs for real.
struct Fixture {
    w: ExitWitness,
    commitment: [u8; 32],
    dest_spk: Vec<u8>,
}

fn exit_fixture(value: u64, blind: [u8; 32], h_anchor: u32, exit_vout: u32) -> Fixture {
    let (cx, cy) = pedersen_commit_xy(value, &blind);
    let c_secp = c_secp_of(value, &blind);
    let dest_spk = p2tr_script(&[0x44u8; 32]);
    let dest_spk_hash = cxfer_core::bitcoin::sha256_once(&dest_spk);
    let boundary = boundary_bytes(&c_secp, &[0x66u8; 32]);
    let body = spend_with_exit(
        &ASSET,
        h_anchor,
        &[[0xA1u8; 32], [0xA2u8; 32]],
        exit_vout,
        &c_secp,
        &dest_spk_hash,
        &boundary,
    );
    // The exit names vout `exit_vout`, so the carrier must HAVE that output and it must pay `dest_spk`:
    // `read_exit` binds both: a free `exit_vout` would let one exit fork into many anchors. Outputs before it are
    // strangers, so a vout that names the wrong index fails on the script hash rather than by accident.
    let mut outs: Vec<(u64, Vec<u8>)> = (0..exit_vout)
        .map(|i| (0u64, p2tr_script(&[0x50u8 + i as u8; 32])))
        .collect();
    outs.push((0u64, dest_spk.clone()));
    let tx = segwit_tx(&env_stack(&body), &outs);
    let w = witness_for(&tx, [0x99u8; 32], value, blind);
    Fixture {
        w,
        commitment: commitment_hash(&cx, &cy),
        dest_spk,
    }
}

/// Fund a ledger the way the crate allows: through `credit_shield`, with a shield whose boundary opens to the
/// value. `fund` is private precisely so a test cannot mint backing out of nothing.
fn fund_via_shield(l: &mut BackingLedger, asset: &[u8; 32], value: u64) {
    let c_secp = c_secp_of(value, &[0x0Fu8; 32]);
    let boundary = boundary_bytes(&c_secp, &[0x0Eu8; 32]);
    let mut b = vec![T_BTC_SHIELD];
    b.extend_from_slice(asset);
    b.push(1); // n_in
    b.push(1); // n_out
    b.extend_from_slice(&[0x01; POOL_OUTPUT_LEN]);
    b.extend_from_slice(&boundary);
    b.extend_from_slice(&[0x09; KERNEL_SIG_LEN]);
    b.extend_from_slice(&0u16.to_le_bytes()); // proof_len
    let body = ShieldBody::parse(&b).expect("canonical shield");
    assert_eq!(
        credit_shield(
            l,
            asset,
            &body,
            value,
            &[0x0Fu8; 32],
            &[0x42u8; 32],
            &|_, _| true,
            &|_, _, _| true
        ),
        Some(()),
        "the shield fixture must credit"
    );
}

/// A SegWit transaction with many inputs, each carrying its own witness stack. `segwit_tx` above is the
/// one-input shape every fixture used; the three checks added for §10 risk 6 are all about the *carrier*, so
/// they need a carrier that can hold more than one envelope.
fn segwit_tx_multi(
    inputs: &[([u8; 32], u32, Vec<Vec<u8>>)],
    outputs: &[(u64, Vec<u8>)],
) -> Vec<u8> {
    let mut t = vec![0x02u8, 0, 0, 0, 0x00, 0x01];
    push_varint(&mut t, inputs.len());
    for (txid, vout, _) in inputs {
        t.extend_from_slice(txid);
        t.extend_from_slice(&vout.to_le_bytes());
        t.push(0x00); // scriptSig len
        t.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
    }
    push_varint(&mut t, outputs.len());
    for (value, spk) in outputs {
        t.extend_from_slice(&value.to_le_bytes());
        push_varint(&mut t, spk.len());
        t.extend_from_slice(spk);
    }
    for (_, _, witness) in inputs {
        push_varint(&mut t, witness.len());
        for item in witness {
            push_varint(&mut t, item.len());
            t.extend_from_slice(item);
        }
    }
    t.extend_from_slice(&[0, 0, 0, 0]); // locktime
    t
}

/// A `T_BTC_SPEND` payload with a caller-chosen `bind` and `want`, encoded exactly as §3 lays it out.
#[allow(clippy::too_many_arguments)]
fn spend_full(
    asset: &[u8; 32],
    h_anchor: u32,
    bind: &[u8; BIND_LEN],
    nf: &[[u8; 32]],
    exit_vout: Option<u32>,
    dest_spk_hash: &[u8; 32],
    boundary: &[u8],
    want: Option<&[u8; WANT_LEN]>,
) -> Vec<u8> {
    let mut b = vec![T_BTC_SPEND];
    b.extend_from_slice(asset);
    b.extend_from_slice(&h_anchor.to_le_bytes());
    b.extend_from_slice(bind);
    b.push(nf.len() as u8);
    for n in nf {
        b.extend_from_slice(n);
    }
    b.push(0); // n_out = 0
    match exit_vout {
        None => b.push(0),
        Some(v) => {
            b.push(1);
            b.extend_from_slice(&v.to_le_bytes());
            b.extend_from_slice(dest_spk_hash);
            b.extend_from_slice(boundary);
        }
    }
    match want {
        None => b.push(0),
        Some(w) => {
            b.push(1);
            b.extend_from_slice(w);
        }
    }
    b.extend_from_slice(&64u16.to_le_bytes());
    b.extend_from_slice(&[0x77u8; 64]);
    b
}

// ───────────────────────────── the ledger ─────────────────────────────

#[test]
fn ledger_refuses_unfunded_and_never_partially_books() {
    let mut l = BackingLedger::default();
    let a = ExitAnchor {
        outpoint: [1u8; 32],
        commitment: [2u8; 32],
        asset: ASSET,
        value: 100,
    };
    assert_eq!(admit_exit(&mut l, &a, &ASSET), None, "nothing funded yet");
    assert_eq!((l.funded, l.exited), (0, 0), "a refused exit books nothing");

    fund_via_shield(&mut l, &ASSET, 70);
    assert_eq!(
        admit_exit(&mut l, &a, &ASSET),
        None,
        "70 does not cover 100"
    );
    assert_eq!(l.exited, 0, "still nothing booked");

    fund_via_shield(&mut l, &ASSET, 30);
    assert_eq!(
        admit_exit(&mut l, &a, &ASSET),
        Some(()),
        "70 + 30 covers 100"
    );
    assert_eq!((l.funded, l.exited, l.available()), (100, 100, 0));
}

#[test]
fn ledger_cannot_be_drained_past_its_funding() {
    let mut l = BackingLedger::default();
    fund_via_shield(&mut l, &ASSET, 1000);
    for i in 0..10u8 {
        assert_eq!(l.debit(&[i; 32], &[i.wrapping_add(1); 32], 100), Some(()));
    }
    assert_eq!(l.available(), 0);
    assert_eq!(
        l.debit(&[0xFF; 32], &[0xFE; 32], 1),
        None,
        "an eleventh exit is refused, not clamped"
    );
    assert_eq!(l.exited, 1000, "the refused one debited nothing");
}

#[test]
fn the_same_exit_cannot_back_two_debits() {
    // Re-folding a block must not spend the backing twice. The counters alone cannot tell a re-fold from a
    // second exit, so the outpoint set is what makes the transition idempotent.
    let mut l = BackingLedger::default();
    fund_via_shield(&mut l, &ASSET, 1000);
    let a = ExitAnchor {
        outpoint: [0x11; 32],
        commitment: [0x22; 32],
        asset: ASSET,
        value: 400,
    };
    assert_eq!(admit_exit(&mut l, &a, &ASSET), Some(()));
    assert_eq!(
        admit_exit(&mut l, &a, &ASSET),
        None,
        "the same exit twice is refused"
    );
    assert_eq!(l.exited, 400, "and debited nothing the second time");
    assert_eq!(l.exited_at.len(), 1);

    // A different exit at a different outpoint still books.
    let b = ExitAnchor {
        outpoint: [0x33; 32],
        commitment: [0x44; 32],
        asset: ASSET,
        value: 400,
    };
    assert_eq!(admit_exit(&mut l, &b, &ASSET), Some(()));
    assert_eq!((l.funded, l.exited, l.available()), (1000, 800, 200));
}

#[test]
fn ledger_fund_saturates_and_value_zero_is_never_an_anchor() {
    let mut l = BackingLedger {
        funded: u128::MAX - 1,
        exited: 0,
        shielded: BTreeSet::new(),
        exited_at: BTreeSet::new(),
        exited_notes: BTreeSet::new(),
    };
    fund_via_shield(&mut l, &ASSET, 10);
    assert_eq!(l.funded, u128::MAX, "saturates rather than wrapping");
    let zero = ExitAnchor {
        outpoint: [3u8; 32],
        commitment: [4u8; 32],
        asset: ASSET,
        value: 0,
    };
    assert_eq!(
        admit_exit(&mut l, &zero, &ASSET),
        None,
        "a zero-value exit backs nothing"
    );
}

// ───────────────────────────── boundaries ─────────────────────────────

/// A `T_BTC_SHIELD` payload of the shape §3 gives, carrying whatever boundary and proof the test wants.
fn shield_payload(boundary: &[u8], proof: &[u8]) -> Vec<u8> {
    let mut b = vec![T_BTC_SHIELD];
    b.extend_from_slice(&[0xaa; 32]); // asset
    b.push(1); // n_in
    b.push(1); // n_out
    b.extend_from_slice(&[0x01; POOL_OUTPUT_LEN]); // one pool output
    b.extend_from_slice(boundary);
    b.extend_from_slice(&[0x09; KERNEL_SIG_LEN]); // kernel_sig
    b.extend_from_slice(&(proof.len() as u16).to_le_bytes());
    b.extend_from_slice(proof);
    b
}

#[test]
fn shield_parse_reads_the_layout_and_refuses_non_canonical_shapes() {
    let bytes = boundary_bytes(&[0x02u8; 33], &[0x03u8; 32]);
    let payload = shield_payload(&bytes, &[0x07; 5]);
    let body = ShieldBody::parse(&payload).expect("a canonical shield");
    assert_eq!(body.asset, [0xaa; 32]);
    assert_eq!(body.outputs.len(), 1);
    assert_eq!(body.boundary.c_bjj, [0x03u8; 32]);
    assert_eq!(body.proof, &[0x07; 5]);
    assert_eq!(
        body.body.len(),
        1 + 32 + 1 + 1 + POOL_OUTPUT_LEN + BOUNDARY_LEN
    );

    let mut wrong_op = payload.clone();
    wrong_op[0] = T_BTC_SPEND;
    assert!(
        ShieldBody::parse(&wrong_op).is_none(),
        "a spend is not a shield"
    );

    let mut zero_in = payload.clone();
    zero_in[33] = 0;
    assert!(ShieldBody::parse(&zero_in).is_none(), "n_in = 0");

    let mut too_many_in = payload.clone();
    too_many_in[33] = (SHIELD_MAX_IN + 1) as u8;
    assert!(
        ShieldBody::parse(&too_many_in).is_none(),
        "n_in past the cap"
    );

    let mut zero_out = payload.clone();
    zero_out[34] = 0;
    assert!(ShieldBody::parse(&zero_out).is_none(), "n_out = 0");

    // every truncation of a canonical payload is refused, never read as a shorter valid one
    for n in 0..payload.len() {
        assert!(
            ShieldBody::parse(&payload[..n]).is_none(),
            "truncated at {n}"
        );
    }
    // and a trailing byte is refused
    let mut trailing = payload.clone();
    trailing.push(0);
    assert!(ShieldBody::parse(&trailing).is_none(), "trailing bytes");
}

#[test]
fn credit_shield_requires_a_matching_boundary() {
    let bytes = boundary_bytes(&[0x02u8; 33], &[0x03u8; 32]);
    let payload = shield_payload(&bytes, &[0x07; 5]);
    let body = ShieldBody::parse(&payload).unwrap();
    let blind = [0x11u8; 32];
    let root = [0x42u8; 32];
    let mut l = BackingLedger::default();

    let pool_yes: ShieldProofCheck<'_> = &|_: &ShieldBody<'_>, r: &[u8; 32]| r == &root;
    let pool_no: ShieldProofCheck<'_> = &|_: &ShieldBody<'_>, _: &[u8; 32]| false;

    assert_eq!(
        credit_shield(
            &mut l,
            &body.asset,
            &body,
            0,
            &blind,
            &root,
            pool_yes,
            &|_, _, _| true
        ),
        None,
        "a shield that moved nothing"
    );
    assert_eq!(
        credit_shield(
            &mut l,
            &body.asset,
            &body,
            500,
            &blind,
            &root,
            pool_yes,
            &|_, _, _| false
        ),
        None,
        "a boundary that does not open"
    );
    assert_eq!(
        credit_shield(&mut l, &body.asset, &body, 500, &blind, &root, pool_no, &|_, _, _| true),
        None,
        "a pool proof that did not verify: this is the only way value enters, so it has to be checked here"
    );
    assert_eq!(
        credit_shield(
            &mut l,
            &[0xff; 32],
            &body,
            500,
            &blind,
            &root,
            pool_yes,
            &|_, _, _| true
        ),
        None,
        "a shield of another asset cannot fund this fold"
    );
    assert_eq!(l.funded, 0, "none of the refusals funded anything");

    let ok = |b: &Boundary<'_>, v: u64, bl: &[u8; 32]| {
        b.c_bjj == [0x03u8; 32] && v == 500 && bl == &blind
    };
    assert_eq!(
        credit_shield(
            &mut l,
            &body.asset,
            &body,
            500,
            &blind,
            &root,
            pool_yes,
            &ok
        ),
        Some(())
    );
    assert_eq!(l.funded, 500);
    assert_eq!(
        credit_shield(
            &mut l,
            &body.asset,
            &body,
            500,
            &blind,
            &root,
            pool_yes,
            &ok
        ),
        None,
        "re-folding the same shield must not mint backing"
    );
    assert_eq!(l.funded, 500, "and credited nothing the second time");
}

/// The three checks that make `read_exit` agree with the pool's `acceptSpend`: the witness shape it reads, an
/// unsatisfied `want`, and the `h_anchor` window. Each is a way to anchor an exit riding a spend the live pool
/// rejects, which would count one pool note twice.
#[test]
fn read_exit_refuses_a_spend_the_live_pool_would_reject() {
    let value = 900u64;
    let blind = [0x11u8; 32];
    let h = 800_000u32;
    let pool_ok = |_: &SpendBody<'_>, _: &[u8; 32]| true;
    let opens = |_: &Boundary<'_>, _: u64, _: &[u8; 32]| true;

    // Baseline: the honest fixture reads.
    let f = exit_fixture(value, blind, h, 1);
    assert!(read_exit(&f.w, &ASSET, &pool_ok, &opens).is_some());

    // 1. A two-item witness stack is a Taproot script-path spend under an unknown leaf version. Consensus
    //    accepts it, `inputEnvelope` never reads it, so read_exit must not either.
    let body = spend_with_exit(
        &ASSET,
        h,
        &[[0xA1u8; 32]],
        1,
        &c_secp_of(value, &blind),
        &cxfer_core::bitcoin::sha256_once(&p2tr_script(&[0x44u8; 32])),
        &boundary_bytes(&c_secp_of(value, &blind), &[0x66u8; 32]),
    );
    let outs = vec![
        (0u64, p2tr_script(&[0x50u8; 32])),
        (0u64, p2tr_script(&[0x44u8; 32])),
    ];
    let tx_two = segwit_tx(&[vec![0xFFu8; 32], envelope_script(&body)], &outs);
    let w_two = witness_for(&tx_two, [0x99u8; 32], value, blind);
    assert_eq!(
        read_exit(&w_two, &ASSET, &pool_ok, &opens),
        None,
        "a two-item witness stack is not a shape the pool reads"
    );

    // 2. A `want` the carrier does not satisfy makes the pool reject the whole spend, so the exit riding it
    //    never lands. Here the want names a vout the carrier does not have.
    let mut want = Vec::new();
    want.extend_from_slice(&7u32.to_le_bytes()); // vout that does not exist
    want.extend_from_slice(&1u64.to_le_bytes());
    want.extend_from_slice(&[0x5Au8; 32]);
    let body_want = spend_with_exit_and_want(
        &ASSET,
        h,
        &[[0xA1u8; 32]],
        1,
        &cxfer_core::bitcoin::sha256_once(&p2tr_script(&[0x44u8; 32])),
        &boundary_bytes(&c_secp_of(value, &blind), &[0x66u8; 32]),
        &want,
    );
    let tx_want = segwit_tx(&env_stack(&body_want), &outs);
    let w_want = witness_for(&tx_want, [0x99u8; 32], value, blind);
    assert_eq!(
        read_exit(&w_want, &ASSET, &pool_ok, &opens),
        None,
        "an unsatisfied want is a spend the pool rejects whole"
    );

    // 3. An `h_anchor` outside the 144-block window below the confirming block is a stale proof: the pool
    //    rejects the spend, so the exit is not supply.
    let stale = exit_fixture(value, blind, h, 1);
    let mut w_stale = stale.w.clone();
    w_stale.confirmed_block_height = h + ANCHOR_WINDOW + 1;
    assert_eq!(
        read_exit(&w_stale, &ASSET, &pool_ok, &opens),
        None,
        "an h_anchor more than 144 blocks below the confirming block is refused"
    );
    // And one exactly at the near edge of the window still reads.
    let mut w_edge = stale.w.clone();
    w_edge.confirmed_block_height = h + ANCHOR_WINDOW;
    assert!(read_exit(&w_edge, &ASSET, &pool_ok, &opens).is_some());
    // As does an anchor one block below the confirming block, the ordinary case.
    let mut w_fresh = stale.w.clone();
    w_fresh.confirmed_block_height = h + 1;
    assert!(read_exit(&w_fresh, &ASSET, &pool_ok, &opens).is_some());
}

/// A shield cannot be credited from caller bytes alone: it must ride a real input of a confirmed transaction,
/// the carrier must hold at least `n_in + 1` inputs the way the pool requires, and the merkle path must reach
/// the block the caller attests. `credit_shield` keeps its shape for the folded path; `read_shield` is the
/// authenticated entry point.
#[test]
fn read_shield_authenticates_the_carrier_before_crediting() {
    let value = 500u64;
    let blind = [0x0Fu8; 32];
    let c_secp = c_secp_of(value, &blind);
    let boundary = boundary_bytes(&c_secp, &[0x0Eu8; 32]);

    // Two carried inputs so a `n_in = 1` shield has the `inputs[1..]` the pool resolves.
    let mut b = vec![T_BTC_SHIELD];
    b.extend_from_slice(&ASSET);
    b.push(1); // n_in
    b.push(1); // n_out
    b.extend_from_slice(&[0x01; POOL_OUTPUT_LEN]);
    b.extend_from_slice(&boundary);
    b.extend_from_slice(&[0x09; KERNEL_SIG_LEN]);
    b.extend_from_slice(&0u16.to_le_bytes());
    let body = ShieldBody::parse(&b).expect("canonical shield");
    assert_eq!(body.n_in, 1);

    // The carrier carries vin[0] (its own coin) plus the shielded note, which is what `n_in = 1` requires.
    let outs: Vec<(u64, Vec<u8>)> = vec![(0u64, p2tr_script(&[0x50u8; 32]))];
    let tx = segwit_tx_multi(
        &[
            ([0x11u8; 32], 0, env_stack(&b)),
            (
                [0x12u8; 32],
                1,
                vec![vec![0xFFu8; 32], vec![0x00u8; 8], vec![0x20u8; 33]],
            ),
        ],
        &outs,
    );

    let mk = |tx: &[u8], index: u32, root: [u8; 32]| {
        let cb = coinbase_for(tx);
        let cb_txid = cxfer_core::bitcoin::compute_txid(&cb).unwrap();
        let txid = cxfer_core::bitcoin::compute_txid(tx).unwrap();
        ShieldWitness {
            tx: tx.to_vec(),
            vin: 0,
            wtxid_siblings: vec![[0u8; 32]],
            coinbase: cb,
            coinbase_txid_siblings: vec![txid],
            merkle_index: index,
            merkle_siblings: vec![cb_txid],
            confirmed_block_root: root,
            pool_root: [0x42u8; 32],
            value,
        }
    };

    let txid = cxfer_core::bitcoin::compute_txid(&tx).unwrap();
    let cb_txid = cxfer_core::bitcoin::compute_txid(&coinbase_for(&tx)).unwrap();
    let real_root = cxfer_core::bitcoin::compute_merkle_root(&[cb_txid, txid]);

    let mut l = BackingLedger::default();
    let w = mk(&tx, 1, real_root);
    let credited = read_shield(&w, &ASSET, &mut l, &blind, &|_, _| true, &|_, _, _| true);
    assert_eq!(
        credited,
        Some(value),
        "an authenticated shield credits its value"
    );
    assert_eq!(l.available(), value as u128);

    // The same shield again: one body, one credit, whatever the caller supplies.
    let mut l2 = BackingLedger::default();
    let w2 = mk(&tx, 1, real_root);
    assert_eq!(
        read_shield(&w2, &ASSET, &mut l2, &blind, &|_, _| true, &|_, _, _| true),
        Some(value)
    );
    assert_eq!(
        read_shield(&w2, &ASSET, &mut l2, &blind, &|_, _| true, &|_, _, _| true),
        None
    );
    assert_eq!(l2.available(), value as u128, "a re-fold does not mint");

    // A shield of another asset cannot fund this fold, however well authenticated it is.
    let mut l_wrong = BackingLedger::default();
    let w_wrong = mk(&tx, 1, real_root);
    assert_eq!(
        read_shield(
            &w_wrong,
            &[0xFFu8; 32],
            &mut l_wrong,
            &blind,
            &|_, _| true,
            &|_, _, _| true
        ),
        None,
        "a shield of another asset credits nothing"
    );
    assert_eq!(l_wrong.available(), 0);

    // A block root the merkle path does not reach is refused.
    let mut bad_root = BackingLedger::default();
    let w_bad = mk(&tx, 1, [0x77u8; 32]);
    assert_eq!(
        read_shield(
            &w_bad,
            &ASSET,
            &mut bad_root,
            &blind,
            &|_, _| true,
            &|_, _, _| true
        ),
        None
    );
    assert_eq!(bad_root.available(), 0);

    // A carrier with fewer inputs than `n_in + 1` is a shield the pool never accepts.
    let mut l_noin = BackingLedger::default();
    let mut b_big = vec![T_BTC_SHIELD];
    b_big.extend_from_slice(&ASSET);
    b_big.push(3); // n_in = 3, but the carrier carries two inputs
    b_big.push(1);
    b_big.extend_from_slice(&[0x01; POOL_OUTPUT_LEN]);
    b_big.extend_from_slice(&boundary);
    b_big.extend_from_slice(&[0x09; KERNEL_SIG_LEN]);
    b_big.extend_from_slice(&0u16.to_le_bytes());
    let tx_big = segwit_tx_multi(
        &[
            ([0x11u8; 32], 0, env_stack(&b_big)),
            ([0x12u8; 32], 1, vec![vec![0xFFu8; 32]]),
        ],
        &outs,
    );
    let cb_big = coinbase_for(&tx_big);
    let cb_big_txid = cxfer_core::bitcoin::compute_txid(&cb_big).unwrap();
    let tx_big_txid = cxfer_core::bitcoin::compute_txid(&tx_big).unwrap();
    let root_big = cxfer_core::bitcoin::compute_merkle_root(&[cb_big_txid, tx_big_txid]);
    let w_big = ShieldWitness {
        tx: tx_big.clone(),
        vin: 0,
        wtxid_siblings: vec![[0u8; 32]],
        coinbase: cb_big,
        coinbase_txid_siblings: vec![tx_big_txid],
        merkle_index: 1,
        merkle_siblings: vec![cb_big_txid],
        confirmed_block_root: root_big,
        pool_root: [0x42u8; 32],
        value,
    };
    assert_eq!(
        read_shield(
            &w_big,
            &ASSET,
            &mut l_noin,
            &blind,
            &|_, _| true,
            &|_, _, _| true
        ),
        None,
        "a shield claiming more notes than the carrier carries never lands"
    );
    assert_eq!(l_noin.available(), 0);
}

/// The pool reads a shield only from vin[0] (`T_BTC_SHIELD must ride vin[0]`), so a confirmed shield sitting
/// on a later input is a spend the pool rejected whole and must credit nothing here.
#[test]
fn read_shield_refuses_a_shield_that_does_not_ride_vin0() {
    let value = 500u64;
    let blind = [0x0Fu8; 32];
    let c_secp = c_secp_of(value, &blind);
    let mut b = vec![T_BTC_SHIELD];
    b.extend_from_slice(&ASSET);
    b.push(1);
    b.push(1);
    b.extend_from_slice(&[0x01; POOL_OUTPUT_LEN]);
    b.extend_from_slice(&boundary_bytes(&c_secp, &[0x0Eu8; 32]));
    b.extend_from_slice(&[0x09; KERNEL_SIG_LEN]);
    b.extend_from_slice(&0u16.to_le_bytes());

    let outs: Vec<(u64, Vec<u8>)> = vec![(0u64, p2tr_script(&[0x50u8; 32]))];
    let tx = segwit_tx_multi(
        &[
            (
                [0x11u8; 32],
                0,
                vec![vec![0xFFu8; 32], vec![0x00u8; 8], vec![0x20u8; 33]],
            ),
            ([0x12u8; 32], 1, env_stack(&b)),
        ],
        &outs,
    );
    let cb = coinbase_for(&tx);
    let cb_txid = cxfer_core::bitcoin::compute_txid(&cb).unwrap();
    let txid = cxfer_core::bitcoin::compute_txid(&tx).unwrap();
    let root = cxfer_core::bitcoin::compute_merkle_root(&[cb_txid, txid]);
    let w = ShieldWitness {
        tx,
        vin: 1, // the envelope is real, confirmed, and on the wrong input
        wtxid_siblings: vec![[0u8; 32]],
        coinbase: cb,
        coinbase_txid_siblings: vec![txid],
        merkle_index: 1,
        merkle_siblings: vec![cb_txid],
        confirmed_block_root: root,
        pool_root: [0x42u8; 32],
        value,
    };
    let mut l = BackingLedger::default();
    assert_eq!(
        read_shield(&w, &ASSET, &mut l, &blind, &|_, _| true, &|_, _, _| true),
        None
    );
    assert_eq!(l.available(), 0);
}

/// The merkle path proves the txid; BIP141 is what proves the witness actually committed to it. A carrier whose
/// wtxid commitment is broken is not in the block as witnessed, which is exactly what the pool checks first.
#[test]
fn read_shield_refuses_a_carrier_whose_witness_commitment_is_broken() {
    let value = 500u64;
    let blind = [0x0Fu8; 32];
    let c_secp = c_secp_of(value, &blind);
    let mut b = vec![T_BTC_SHIELD];
    b.extend_from_slice(&ASSET);
    b.push(1);
    b.push(1);
    b.extend_from_slice(&[0x01; POOL_OUTPUT_LEN]);
    b.extend_from_slice(&boundary_bytes(&c_secp, &[0x0Eu8; 32]));
    b.extend_from_slice(&[0x09; KERNEL_SIG_LEN]);
    b.extend_from_slice(&0u16.to_le_bytes());

    let outs: Vec<(u64, Vec<u8>)> = vec![(0u64, p2tr_script(&[0x50u8; 32]))];
    let tx = segwit_tx_multi(
        &[
            ([0x11u8; 32], 0, env_stack(&b)),
            (
                [0x12u8; 32],
                1,
                vec![vec![0xFFu8; 32], vec![0x00u8; 8], vec![0x20u8; 33]],
            ),
        ],
        &outs,
    );
    let cb = coinbase_for(&tx);
    let cb_txid = cxfer_core::bitcoin::compute_txid(&cb).unwrap();
    let txid = cxfer_core::bitcoin::compute_txid(&tx).unwrap();
    let root = cxfer_core::bitcoin::compute_merkle_root(&[cb_txid, txid]);
    let w = ShieldWitness {
        tx,
        vin: 0,
        wtxid_siblings: vec![[0xAAu8; 32]], // the commitment the coinbase actually carries is the zero one
        coinbase: cb,
        coinbase_txid_siblings: vec![txid],
        merkle_index: 1,
        merkle_siblings: vec![cb_txid],
        confirmed_block_root: root,
        pool_root: [0x42u8; 32],
        value,
    };
    let mut l = BackingLedger::default();
    assert_eq!(
        read_shield(&w, &ASSET, &mut l, &blind, &|_, _| true, &|_, _, _| true),
        None
    );
    assert_eq!(l.available(), 0);
}

#[test]
fn boundary_parse_rejects_every_wrong_length() {
    assert!(Boundary::parse(&[]).is_none());
    assert!(Boundary::parse(&[0u8; BOUNDARY_LEN - 1]).is_none());
    assert!(Boundary::parse(&[0u8; BOUNDARY_LEN + 1]).is_none());
    let bytes = boundary_bytes(&[0x02u8; 33], &[0x03u8; 32]);
    let b = Boundary::parse(&bytes).unwrap();
    assert_eq!(b.proof.len(), 169 + 591);
    assert_eq!(b.c_secp, [0x02u8; 33]);
    assert_eq!(b.c_bjj, [0x03u8; 32]);
}

// ───────────────────────────── parsing ─────────────────────────────

#[test]
fn spend_parse_reads_the_exit_where_the_layout_puts_it() {
    let blind = [0x01u8; 32];
    let c_secp = c_secp_of(7, &blind);
    let boundary = boundary_bytes(&c_secp, &[0x66u8; 32]);
    let payload = spend_with_exit(
        &ASSET,
        910_000,
        &[[0xB1u8; 32], [0xB2u8; 32]],
        3,
        &c_secp,
        &[0x12u8; 32],
        &boundary,
    );

    let body = parse_spend(&payload).expect("a canonical spend parses");
    assert_eq!(body.asset, ASSET);
    assert_eq!(body.h_anchor, 910_000);
    assert_eq!(body.bind, [0u8; BIND_LEN]);
    assert_eq!(body.nullifiers, vec![[0xB1u8; 32], [0xB2u8; 32]]);
    assert!(body.outputs.is_empty());
    assert!(body.want.is_none());
    assert_eq!(body.proof.len(), 64);

    let exit = body.exit.expect("has_exit = 1");
    assert_eq!(exit.exit_vout, 3);
    assert_eq!(exit.dest_spk_hash, [0x12u8; 32]);
    assert_eq!(exit.boundary.c_secp, c_secp);
    assert_eq!(exit.boundary.c_bjj, [0x66u8; 32]);
    assert_eq!(exit.boundary.proof, &[0x5Eu8; 169 + 591][..]);
}

#[test]
fn spend_parse_refuses_every_non_canonical_shape() {
    let blind = [0x01u8; 32];
    let c_secp = c_secp_of(7, &blind);
    let boundary = boundary_bytes(&c_secp, &[0x66u8; 32]);
    let good = spend_with_exit(
        &ASSET,
        1,
        &[[0xB1u8; 32]],
        0,
        &c_secp,
        &[0x12u8; 32],
        &boundary,
    );
    assert!(parse_spend(&good).is_some(), "control");

    // Wrong opcode.
    let mut other = good.clone();
    other[0] = T_BTC_SHIELD;
    assert!(parse_spend(&other).is_none(), "not a spend");

    // Every truncation: a payload cut anywhere is refused, never read as a shorter valid one.
    for n in 0..good.len() {
        assert!(
            parse_spend(&good[..n]).is_none(),
            "truncation at {n} must be refused"
        );
    }

    // Trailing bytes after the declared proof.
    let mut trailing = good.clone();
    trailing.push(0x00);
    assert!(parse_spend(&trailing).is_none(), "trailing bytes");

    // A zero nullifier, and a repeated one.
    let mut zero_nf = good.clone();
    zero_nf[1 + 32 + 4 + BIND_LEN + 1] = 0;
    zero_nf[1 + 32 + 4 + BIND_LEN + 2..1 + 32 + 4 + BIND_LEN + 33].fill(0);
    assert!(parse_spend(&zero_nf).is_none(), "a zero nullifier");

    let two = spend_with_exit(
        &ASSET,
        1,
        &[[0xC1u8; 32], [0xC1u8; 32]],
        0,
        &c_secp,
        &[0x12u8; 32],
        &boundary,
    );
    assert!(parse_spend(&two).is_none(), "a repeated nullifier");

    // n_in = 0 and n_in = 3.
    let mut no_in = good.clone();
    no_in[1 + 32 + 4 + BIND_LEN] = 0;
    assert!(parse_spend(&no_in).is_none(), "n_in = 0");

    // has_exit outside {0, 1}.
    let has_exit_at = 1 + 32 + 4 + BIND_LEN + 1 + 32 + 1;
    let mut bad_flag = good.clone();
    bad_flag[has_exit_at] = 2;
    assert!(parse_spend(&bad_flag).is_none(), "has_exit = 2");

    // A spend that creates nothing at all: n_out = 0 and has_exit = 0.
    let nothing = spend_without_exit(&ASSET, &[0xB1u8; 32]);
    assert!(
        parse_spend(&nothing).is_none(),
        "a spend with no outputs and no exit"
    );
}

// ───────────────────────────── exits, end to end ─────────────────────────────

#[test]
fn read_exit_authenticates_a_real_carrier_and_books_it() {
    let value = 25_000u64;
    let blind = [0x5Au8; 32];
    let f = exit_fixture(value, blind, 910_000, 1);

    let pool_ok = |_: &SpendBody<'_>, _: &[u8; 32]| true;
    let opens = |b: &Boundary<'_>, v: u64, bl: &[u8; 32]| {
        v == value && bl == &blind && b.c_bjj == [0x66u8; 32]
    };

    let anchor = read_exit(&f.w, &ASSET, &pool_ok, &opens).expect("a real carrier authenticates");
    assert_eq!(anchor.value, value);
    assert_eq!(anchor.asset, ASSET);
    assert_eq!(
        anchor.commitment, f.commitment,
        "the DAG keys on the boundary's commitment"
    );
    assert_eq!(
        anchor.outpoint,
        cxfer_core::outpoint_key(&cxfer_core::bitcoin::compute_txid(&f.w.tx).unwrap(), 1)
    );

    let mut l = BackingLedger::default();
    assert_eq!(
        admit_exit(&mut l, &anchor, &ASSET),
        None,
        "reading is not backing: the ledger must hold the value"
    );
    fund_via_shield(&mut l, &ASSET, value - 1);
    assert_eq!(
        admit_exit(&mut l, &anchor, &ASSET),
        None,
        "one sat short is short"
    );
    fund_via_shield(&mut l, &ASSET, 1);
    assert_eq!(admit_exit(&mut l, &anchor, &ASSET), Some(()));
    assert_eq!(l.available(), 0);
    assert_eq!(
        admit_exit(&mut l, &anchor, &ASSET),
        None,
        "and re-reading it debits nothing further"
    );
}

#[test]
fn read_exit_refuses_a_wrong_asset_or_a_seam_that_says_no() {
    let value = 100u64;
    let blind = [0x22u8; 32];
    let f = exit_fixture(value, blind, 1, 0);
    let yes_pool = |_: &SpendBody<'_>, _: &[u8; 32]| true;
    let yes_opens = |_: &Boundary<'_>, _: u64, _: &[u8; 32]| true;
    assert!(
        read_exit(&f.w, &ASSET, &yes_pool, &yes_opens).is_some(),
        "control"
    );

    assert!(
        read_exit(&f.w, &ASSET, &|_, _| false, &yes_opens).is_none(),
        "the pool proof seam said no"
    );
    assert!(
        read_exit(&f.w, &ASSET, &yes_pool, &|_, _, _| false).is_none(),
        "the boundary seam said no"
    );
    assert!(
        read_exit(&f.w, &[0x01u8; 32], &yes_pool, &yes_opens).is_none(),
        "another asset's spend cannot back this fold"
    );
}

#[test]
fn read_exit_refuses_a_spend_without_an_exit() {
    let blind = [0x22u8; 32];
    let dest_spk = p2tr_script(&[0x44u8; 32]);
    let payload = spend_without_exit(&ASSET, &[0xB1u8; 32]);
    let tx = segwit_tx(&env_stack(&payload), &[(0u64, dest_spk)]);
    let w = witness_for(&tx, [0x99u8; 32], 100, blind);
    let yes_pool = |_: &SpendBody<'_>, _: &[u8; 32]| true;
    let yes_opens = |_: &Boundary<'_>, _: u64, _: &[u8; 32]| true;
    assert!(
        read_exit(&w, &ASSET, &yes_pool, &yes_opens).is_none(),
        "a payload with no exit anchors nothing"
    );
}

#[test]
fn read_exit_refuses_a_tampered_carrier() {
    let value = 100u64;
    let blind = [0x33u8; 32];
    let f = exit_fixture(value, blind, 1, 0);
    let yes_pool = |_: &SpendBody<'_>, _: &[u8; 32]| true;
    let yes_opens = |_: &Boundary<'_>, _: u64, _: &[u8; 32]| true;
    assert!(
        read_exit(&f.w, &ASSET, &yes_pool, &yes_opens).is_some(),
        "control"
    );

    // Swap the witness for a different envelope. The txid is unchanged — that is the attack premise — so only
    // the BIP141 commitment catches it. This is the check that keeps a forged exit out of the fold.
    let c_secp = c_secp_of(value, &blind);
    let boundary = boundary_bytes(&c_secp, &[0x66u8; 32]);
    let forged_body = spend_with_exit(
        &ASSET,
        2,
        &[[0xC1u8; 32]],
        0,
        &c_secp,
        &[0x11u8; 32],
        &boundary,
    );
    let forged = segwit_tx(&env_stack(&forged_body), &[(0u64, f.dest_spk.clone())]);
    assert_eq!(
        cxfer_core::bitcoin::compute_txid(&forged),
        cxfer_core::bitcoin::compute_txid(&f.w.tx),
        "same txid after the swap"
    );
    let mut w = f.w.clone();
    w.tx = forged;
    assert!(
        read_exit(&w, &ASSET, &yes_pool, &yes_opens).is_none(),
        "a swapped witness breaks the commitment"
    );

    // A block the transaction is not in.
    let mut w2 = f.w.clone();
    w2.confirmed_block_root = [0x77u8; 32];
    assert!(
        read_exit(&w2, &ASSET, &yes_pool, &yes_opens).is_none(),
        "inclusion in the block is checked"
    );

    // An opening that is not the committed one: the value is not the prover's to choose.
    let mut w3 = f.w.clone();
    w3.value = value + 1;
    assert!(
        read_exit(&w3, &ASSET, &yes_pool, &|_, v, _| v == value).is_none(),
        "the opening must match the commitment"
    );

    // A proofless spend (proof_len = 0) covered by a carrier aggregate is a legal shape: the fold's pool seam
    // is what decides whether the aggregate verified, so the parser must accept it rather than drop it.
    let proofless = {
        let mut b = vec![T_BTC_SPEND];
        b.extend_from_slice(&ASSET);
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&[0u8; BIND_LEN]);
        b.push(1);
        b.extend_from_slice(&[0xB1u8; 32]);
        b.push(0); // n_out
        b.push(1); // has_exit
        let boundary = boundary_bytes(&c_secp_of(value, &blind), &[0x66u8; 32]);
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&[0x12u8; 32]);
        b.extend_from_slice(&boundary);
        b.push(0); // has_want
        b.extend_from_slice(&0u16.to_le_bytes()); // proof_len = 0
        b
    };
    let body = parse_spend(&proofless).expect("a proofless spend is a legal shape");
    assert_eq!(body.proof.len(), 0, "and carries no proof of its own");
    assert!(body.exit.is_some(), "with its exit still readable");

    // A null is not an anchor.
    let mut w4 = f.w.clone();
    w4.value = 0;
    assert!(
        read_exit(&w4, &ASSET, &yes_pool, &yes_opens).is_none(),
        "a zero-value exit is refused outright"
    );
}

// ───────────────────────────── lineages ─────────────────────────────

#[test]
fn lineage_presents_short_histories_whole() {
    assert_eq!(lineage(0, None), Lineage::Full { hops: 0 });
    assert_eq!(lineage(255, None), Lineage::Full { hops: 255 });
    assert_eq!(
        lineage(255, Some(([1u8; 32], 10))),
        Lineage::Full { hops: 255 },
        "an anchor is unnecessary inside the cap"
    );
    // 256 steps is INSIDE the cap: `burn_deposit.rs` refuses only `ncx > 256`, so a 256-hop blob parses
    // today and must keep parsing. Re-anchoring it would be a rule this entry added, not one it preserved.
    assert_eq!(
        lineage(256, None),
        Lineage::Full { hops: 256 },
        "the cap is inclusive, matching ncx > 256"
    );
}

#[test]
fn lineage_re_anchors_past_the_cap() {
    assert_eq!(
        lineage(257, Some(([9u8; 32], 0))),
        Lineage::Anchored {
            hops: 257,
            from: [9u8; 32],
            distance: 0
        }
    );
    assert_eq!(
        lineage(10_000, Some(([9u8; 32], 256))),
        Lineage::Anchored {
            hops: 10_000,
            from: [9u8; 32],
            distance: 256
        },
        "an anchor exactly at the cap is still in reach"
    );
}

#[test]
fn lineage_refuses_an_out_of_reach_anchor() {
    assert_eq!(
        lineage(257, None),
        Lineage::Refused {
            hops: 257,
            cap: 256
        }
    );
    assert_eq!(
        lineage(700, Some(([9u8; 32], 257))),
        Lineage::Refused {
            hops: 700,
            cap: 256
        },
        "the anchor is itself beyond the cap"
    );
    assert_eq!(
        lineage(700, Some(([9u8; 32], 1000))),
        Lineage::Refused {
            hops: 700,
            cap: 256
        }
    );
}

#[test]
fn valid_leaves_adds_each_anchor_once() {
    let base = [([0x01u8; 32], [0x02u8; 32])];
    let a = ExitAnchor {
        outpoint: [0x03u8; 32],
        commitment: [0x04u8; 32],
        asset: ASSET,
        value: 5,
    };
    let out = valid_leaves(&base, &[a, a], &ASSET);
    assert_eq!(out.len(), 2, "the same anchor twice is one leaf");
    assert_eq!(
        out[0], base[0],
        "the leaves it already had come first, unchanged"
    );
    assert_eq!(out[1], (a.outpoint, a.commitment));

    // An existing leaf with the same outpoint but a DIFFERENT commitment must be refused, not appended: the
    // DAG resolves a hop against `(outpoint, commitment)`, so a second identity at the same outpoint opens a
    // leaf the DAG had already resolved — the outpoint-binding gap `reflect.rs` step 4 refuses.
    let clash = ExitAnchor {
        outpoint: [0x01u8; 32],
        commitment: [0x99u8; 32],
        asset: ASSET,
        value: 5,
    };
    let out = valid_leaves(&base, &[clash], &ASSET);
    assert_eq!(out.len(), 1, "the clashing anchor is dropped, not appended");
    assert_eq!(out[0], base[0], "the base set wins");
    assert!(
        !out.iter().any(|(_, c)| *c == [0x99u8; 32]),
        "the forged identity must not be reachable at all"
    );

    // The same anchor arriving twice is still one leaf.
    assert_eq!(valid_leaves(&base, &[clash, clash], &ASSET).len(), 1);
}

// ───────────────────────────── hostile input ─────────────────────────────

#[test]
fn witness_reading_is_panic_free_on_every_truncation() {
    let blind = [0x01u8; 32];
    let c_secp = c_secp_of(7, &blind);
    let dest_spk = p2tr_script(&[0x44u8; 32]);
    let boundary = boundary_bytes(&c_secp, &[0x66u8; 32]);
    let payload = spend_with_exit(
        &ASSET,
        1,
        &[[0xB1u8; 32]],
        0,
        &c_secp,
        &cxfer_core::bitcoin::sha256_once(&dest_spk),
        &boundary,
    );
    let tx = segwit_tx(&env_stack(&payload), &[(0u64, dest_spk)]);
    for n in 0..=tx.len() {
        let _ = envelope_of_input(&tx[..n], 0); // any panic, out-of-bounds or overflow fails the test
    }
    assert!(decode_envelope_script(b"not an envelope").is_none());
    assert!(
        envelope_of_input(&tx, 9).is_none(),
        "an input index past the end"
    );

    let mut trailing = envelope_script(&payload);
    trailing.push(0x00);
    assert!(
        decode_envelope_script(&trailing).is_none(),
        "trailing bytes after OP_ENDIF are rejected"
    );

    let mut no_endif = envelope_script(&payload);
    no_endif.pop();
    assert!(
        decode_envelope_script(&no_endif).is_none(),
        "a missing OP_ENDIF is rejected"
    );

    let mut wrong_magic = envelope_script(&payload);
    wrong_magic[40] = 0x00; // first byte of "TACIT"
    assert!(
        decode_envelope_script(&wrong_magic).is_none(),
        "a foreign envelope is not read as a Tacit one"
    );
}

#[test]
fn spend_parse_is_panic_free_on_a_hostile_corpus() {
    // Deterministic pseudo-random payloads, plus every prefix of a valid one: the parser runs on
    // prover-supplied stdin bytes, so a malformed payload must be refused with None, never a panic.
    let mut st: u64 = 0xD1B54A32D192ED03;
    let mut next = || {
        st = st
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        st
    };
    for _ in 0..4000 {
        let len = (next() % 400) as usize;
        let buf: Vec<u8> = (0..len).map(|_| (next() >> 33) as u8).collect();
        let _ = parse_spend(&buf);
    }
    // Runaway counts directly after a valid prefix.
    for n_in in [0u8, 3, 0xff] {
        let mut b = vec![T_BTC_SPEND];
        b.extend_from_slice(&ASSET);
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&[0u8; BIND_LEN]);
        b.push(n_in);
        b.extend_from_slice(&[0xCCu8; 200]);
        let _ = parse_spend(&b);
    }
}

// ─────────────────── invariants on the ways value enters and leaves ───────────────────

/// No public path credits the ledger without a shield. `fund` is private and its only caller is
/// `credit_shield`; the counters and dedup sets are private too, so a caller cannot add backing or forge an
/// exit out of band. The seam that stays open is the boundary: `boundary_ok` is the caller's closure, so
/// `credit_shield` is only as strong as the closure passed to it (§10 risk 1).
#[test]
fn no_path_credits_backing_without_a_shield() {
    let mut l = BackingLedger::default();
    let c_secp = c_secp_of(1_000_000, &[0x0Fu8; 32]);
    let boundary = boundary_bytes(&c_secp, &[0x0Eu8; 32]);
    let mut b = vec![T_BTC_SHIELD];
    b.extend_from_slice(&ASSET);
    b.push(1);
    b.push(1);
    b.extend_from_slice(&[0x01; POOL_OUTPUT_LEN]);
    b.extend_from_slice(&boundary);
    b.extend_from_slice(&[0x09; KERNEL_SIG_LEN]);
    b.extend_from_slice(&0u16.to_le_bytes());
    let body = ShieldBody::parse(&b).expect("canonical shield");
    let yes = |_: &Boundary<'_>, _: u64, _: &[u8; 32]| true;

    // A shield that moved nothing is refused: no zero-value credit exists.
    assert_eq!(
        credit_shield(
            &mut l,
            &ASSET,
            &body,
            0,
            &[0x0Fu8; 32],
            &[0x42u8; 32],
            &|_, _| true,
            &yes
        ),
        None,
        "a zero-value shield funds nothing"
    );
    // A shield of another asset is refused.
    assert_eq!(
        credit_shield(
            &mut l,
            &[0xBB; 32],
            &body,
            1_000_000,
            &[0x0Fu8; 32],
            &[0x42u8; 32],
            &|_, _| true,
            &yes
        ),
        None,
        "another asset's shield cannot fund this fold"
    );
    // A shield whose pool proof fails is refused and books nothing.
    assert_eq!(
        credit_shield(
            &mut l,
            &ASSET,
            &body,
            1_000_000,
            &[0x0Fu8; 32],
            &[0x42u8; 32],
            &|_, _| false,
            &yes
        ),
        None
    );
    assert_eq!(l.available(), 0, "a refusal books nothing");

    // The honest shield is accepted, and only once: a re-fold cannot mint.
    assert_eq!(
        credit_shield(
            &mut l,
            &ASSET,
            &body,
            1_000_000,
            &[0x0Fu8; 32],
            &[0x42u8; 32],
            &|_, _| true,
            &yes
        ),
        Some(())
    );
    assert_eq!(l.available(), 1_000_000);
    assert_eq!(
        credit_shield(
            &mut l,
            &ASSET,
            &body,
            1_000_000,
            &[0x0Fu8; 32],
            &[0x42u8; 32],
            &|_, _| true,
            &yes
        ),
        None,
        "the same shield body cannot credit twice"
    );
    // And the value credited is the caller's claim, not the boundary's: this is §10's assumption, so a
    // lying `boundary_ok` does mint. Pinned here so the limitation is visible in the test suite.
    let mut lie = BackingLedger::default();
    assert_eq!(
        credit_shield(&mut lie, &ASSET, &body, 1, &[0x0Fu8; 32],
            &[0x42u8; 32], &|_, _| true, &|_, _, _| true),
        Some(()),
        "§10: the boundary check is the caller's, so a permissive closure credits the claimed value"
    );
}

/// `exit_vout` must name an output the carrier actually has, and `dest_spk_hash` must be that output's
/// script hash. Without both, `exit_vout` is a free witness: one confirmed exit forks into unlimited anchors.
#[test]
fn read_exit_binds_vout_to_a_real_output_and_its_script() {
    let blind = [0x11u8; 32];
    let value = 900u64;
    let h = 800_000u32;

    // vout 2 exists and is the one paying the exit script: accepted.
    let good = exit_fixture(value, blind, h, 2);
    let anchor =
        read_exit(&good.w, &ASSET, &|_, _| true, &|_, _, _| true).expect("real vout, right script");
    assert_eq!(anchor.commitment, good.commitment);

    // Same carrier, but the body names vout 0 — a stranger's script. The old code debited against it.
    let mut wrong_index = exit_fixture(value, blind, h, 2);
    let c_secp = c_secp_of(value, &blind);
    let body = spend_with_exit(
        &ASSET,
        h,
        &[[0xA1u8; 32], [0xA2u8; 32]],
        0,
        &c_secp,
        &cxfer_core::bitcoin::sha256_once(&p2tr_script(&[0x44u8; 32])),
        &boundary_bytes(&c_secp, &[0x66u8; 32]),
    );
    let tx = segwit_tx(
        &env_stack(&body),
        &[
            (0u64, p2tr_script(&[0x50u8; 32])),
            (0u64, p2tr_script(&[0x51u8; 32])),
            (0u64, p2tr_script(&[0x44u8; 32])),
        ],
    );
    wrong_index.w = witness_for(&tx, [0x99u8; 32], value, blind);
    assert_eq!(
        read_exit(&wrong_index.w, &ASSET, &|_, _| true, &|_, _, _| true),
        None,
        "dest_spk_hash must be the hash of the script at exit_vout"
    );

    // vout 9 on a three-output carrier: no such output. The body itself names 9, so `parse_tx_output` is what
    // refuses it — not the script-hash check that caught the case above.
    let mut no_output = exit_fixture(value, blind, h, 9);
    let body9 = spend_with_exit(
        &ASSET,
        h,
        &[[0xA1u8; 32], [0xA2u8; 32]],
        9,
        &c_secp,
        &cxfer_core::bitcoin::sha256_once(&p2tr_script(&[0x44u8; 32])),
        &boundary_bytes(&c_secp, &[0x66u8; 32]),
    );
    let tx9 = segwit_tx(
        &env_stack(&body9),
        &[
            (0u64, p2tr_script(&[0x50u8; 32])),
            (0u64, p2tr_script(&[0x51u8; 32])),
            (0u64, p2tr_script(&[0x44u8; 32])),
        ],
    );
    no_output.w = witness_for(&tx9, [0x99u8; 32], value, blind);
    assert_eq!(
        read_exit(&no_output.w, &ASSET, &|_, _| true, &|_, _, _| true),
        None,
        "exit_vout must name an output the carrier actually has"
    );
}

/// `admit_exit` refuses an anchor in another asset, so one asset's backing cannot pay another's exit.
#[test]
fn admit_exit_refuses_an_anchor_in_another_asset() {
    let mut l = BackingLedger::default();
    fund_via_shield(&mut l, &ASSET, 1000);
    let other = [0xBBu8; 32];
    assert_eq!(
        admit_exit(
            &mut l,
            &ExitAnchor {
                outpoint: [0x77u8; 32],
                commitment: [0x78u8; 32],
                asset: other,
                value: 100,
            },
            &ASSET,
        ),
        None,
        "backing from one asset cannot pay another asset's exit"
    );
    assert_eq!(
        admit_exit(
            &mut l,
            &ExitAnchor {
                outpoint: [0x77u8; 32],
                commitment: [0x78u8; 32],
                asset: ASSET,
                value: 100,
            },
            &ASSET,
        ),
        Some(())
    );
}

// ─────────────── §10 risk 6: the three worker checks that are now mirrored ───────────────

/// A carrier whose vin[0] holds a transparent Tacit op is one the live pool refuses to read an exit out of
/// (`ctx.vin0TacitOp`). Before this check, `read_exit` read the exit anyway and booked backing for a note the
/// pool's own fold never creates.
#[test]
fn read_exit_refuses_a_carrier_whose_vin0_holds_a_transparent_op() {
    let blind = [0x11u8; 32];
    let value = 900u64;
    let h = 800_000u32;
    let good = exit_fixture(value, blind, h, 2);

    // Control: the untouched fixture reads, so the refusal below is the new check and not the fixture.
    assert!(
        read_exit(&good.w, &ASSET, &|_, _| true, &|_, _, _| true).is_some(),
        "control: the fixture must read before the hostile reshape"
    );

    // Same carrier, but vin[0] now carries a transparent op. `0x39` is T_CXFER_BOUND; any non-pool opcode has
    // the same effect, because the worker's `vin0TacitOp` is "an envelope that is not a pool op".
    let exit_body = envelope_script(&spend_with_exit(
        &ASSET,
        h,
        &[[0xA1u8; 32], [0xA2u8; 32]],
        2,
        &c_secp_of(value, &blind),
        &cxfer_core::bitcoin::sha256_once(&p2tr_script(&[0x44u8; 32])),
        &boundary_bytes(&c_secp_of(value, &blind), &[0x66u8; 32]),
    ));
    let transparent = envelope_script(&{
        let mut op = vec![0x39u8];
        op.extend_from_slice(&[0x05u8; 40]);
        op
    });
    let outs: Vec<(u64, Vec<u8>)> = vec![
        (0u64, p2tr_script(&[0x50u8; 32])),
        (0u64, p2tr_script(&[0x51u8; 32])),
        (0u64, p2tr_script(&[0x44u8; 32])),
    ];
    let tx = segwit_tx_multi(
        &[
            (
                [0x11u8; 32],
                0,
                vec![vec![0xFFu8; 32], transparent, vec![0x20u8; 33]],
            ),
            (
                [0x12u8; 32],
                1,
                vec![vec![0xFFu8; 32], exit_body.clone(), vec![0x20u8; 33]],
            ),
        ],
        &outs,
    );
    let mut w = witness_for(&tx, [0x99u8; 32], value, blind);
    w.vin = 1; // the exit rides the second input, which is legal for a T_BTC_SPEND
    assert_eq!(
        read_exit(&w, &ASSET, &|_, _| true, &|_, _, _| true),
        None,
        "vin[0] holds a transparent Tacit op, so the pool never accepts this carrier's exit"
    );

    // And a pool op in vin[0] is fine: the refusal is about *transparent* ops, not about vin[0] being used.
    let pool0 = envelope_script(&spend_without_exit(&ASSET, &[0xA9u8; 32]));
    let tx2 = segwit_tx_multi(
        &[
            (
                [0x11u8; 32],
                0,
                vec![vec![0xFFu8; 32], pool0, vec![0x20u8; 33]],
            ),
            (
                [0x12u8; 32],
                1,
                vec![vec![0xFFu8; 32], exit_body.clone(), vec![0x20u8; 33]],
            ),
        ],
        &outs,
    );
    let mut w2 = witness_for(&tx2, [0x99u8; 32], value, blind);
    w2.vin = 1;
    assert!(
        read_exit(&w2, &ASSET, &|_, _| true, &|_, _, _| true).is_some(),
        "a pool op in vin[0] is exactly what the worker allows"
    );
}

/// `bind` names an outpoint the carrier must spend. The worker rejects a carrier that does not spend it; the
/// crate read `bind` into the body and never looked. Without the check, a relayer quote could be satisfied by a
/// carrier funded from somewhere else entirely.
#[test]
fn read_exit_refuses_a_carrier_that_does_not_spend_the_bound_outpoint() {
    let blind = [0x11u8; 32];
    let value = 900u64;
    let h = 800_000u32;
    let dest_spk = p2tr_script(&[0x44u8; 32]);
    let dest_h = cxfer_core::bitcoin::sha256_once(&dest_spk);
    let c_secp = c_secp_of(value, &blind);
    let boundary = boundary_bytes(&c_secp, &[0x66u8; 32]);
    let outs: Vec<(u64, Vec<u8>)> = vec![
        (0u64, p2tr_script(&[0x50u8; 32])),
        (0u64, p2tr_script(&[0x51u8; 32])),
        (0u64, dest_spk.clone()),
    ];

    // The carrier spends `[0x11; 32]:0`. A bind naming exactly that is satisfied.
    let spent = ([0x11u8; 32], 0u32);
    let mut bind_ok = [0u8; BIND_LEN];
    bind_ok[..32].copy_from_slice(&spent.0);
    bind_ok[32..].copy_from_slice(&spent.1.to_le_bytes());
    let body = spend_full(
        &ASSET,
        h,
        &bind_ok,
        &[[0xA1u8; 32]],
        Some(2),
        &dest_h,
        &boundary,
        None,
    );
    let tx = segwit_tx(&env_stack(&body), &outs);
    let w = witness_for(&tx, [0x99u8; 32], value, blind);
    assert!(
        read_exit(&w, &ASSET, &|_, _| true, &|_, _, _| true).is_some(),
        "a bind the carrier really spends must be accepted"
    );

    // The same body, binding an outpoint this carrier does not spend: refused.
    let mut bind_bad = [0u8; BIND_LEN];
    bind_bad[..32].copy_from_slice(&[0xCCu8; 32]);
    bind_bad[32..].copy_from_slice(&7u32.to_le_bytes());
    let body_bad = spend_full(
        &ASSET,
        h,
        &bind_bad,
        &[[0xA1u8; 32]],
        Some(2),
        &dest_h,
        &boundary,
        None,
    );
    let tx_bad = segwit_tx(&env_stack(&body_bad), &outs);
    let w_bad = witness_for(&tx_bad, [0x99u8; 32], value, blind);
    assert_eq!(
        read_exit(&w_bad, &ASSET, &|_, _| true, &|_, _, _| true),
        None,
        "a bind naming an outpoint the carrier does not spend must be refused"
    );
}

/// Two exits in one carrier naming the same `exit_vout` are both refused, matching the pool worker's
/// `claimed(vout)` rule. The ledger's outpoint set alone would only catch it after both were admitted.
#[test]
fn read_exit_refuses_a_carrier_that_already_claims_the_same_vout() {
    let blind = [0x11u8; 32];
    let value = 900u64;
    let h = 800_000u32;
    let dest_spk = p2tr_script(&[0x44u8; 32]);
    let dest_h = cxfer_core::bitcoin::sha256_once(&dest_spk);
    let c_secp = c_secp_of(value, &blind);
    let boundary = boundary_bytes(&c_secp, &[0x66u8; 32]);
    let outs: Vec<(u64, Vec<u8>)> = vec![
        (0u64, p2tr_script(&[0x50u8; 32])),
        (0u64, p2tr_script(&[0x51u8; 32])),
        (0u64, dest_spk.clone()),
    ];

    // Two distinct spends (distinct nullifiers, so the pool relation is satisfied for both) that both name
    // vout 2 as their exit.
    let a = spend_full(
        &ASSET,
        h,
        &[0u8; BIND_LEN],
        &[[0xA1u8; 32]],
        Some(2),
        &dest_h,
        &boundary,
        None,
    );
    let b = spend_full(
        &ASSET,
        h,
        &[0u8; BIND_LEN],
        &[[0xA2u8; 32]],
        Some(2),
        &dest_h,
        &boundary,
        None,
    );
    let tx = segwit_tx_multi(
        &[
            ([0x11u8; 32], 0, env_stack(&a)),
            ([0x12u8; 32], 1, env_stack(&b)),
        ],
        &outs,
    );
    let mut w = witness_for(&tx, [0x99u8; 32], value, blind);
    w.vin = 1;
    assert_eq!(
        read_exit(&w, &ASSET, &|_, _| true, &|_, _, _| true),
        None,
        "another envelope already claims vout 2 as its exit"
    );

    // The same two envelopes, but the second one's output is its own: both are readable, which is what stops
    // this from being a blanket refusal of multi-spend carriers.
    let c = spend_full(
        &ASSET,
        h,
        &[0u8; BIND_LEN],
        &[[0xA2u8; 32]],
        Some(1),
        &dest_h,
        &boundary,
        None,
    );
    // Point the body at vout 1 and give vout 1 the exit script, so the only thing under test is the claim rule.
    let mut outs_ok = outs.clone();
    outs_ok[1] = (0u64, dest_spk.clone());
    let tx3 = segwit_tx_multi(
        &[
            ([0x11u8; 32], 0, env_stack(&a)),
            ([0x12u8; 32], 1, env_stack(&c)),
        ],
        &outs_ok,
    );
    let mut w3 = witness_for(&tx3, [0x99u8; 32], value, blind);
    w3.vin = 1;
    assert!(
        read_exit(&w3, &ASSET, &|_, _| true, &|_, _, _| true).is_some(),
        "two exits on two different outputs of one carrier are both legitimate"
    );
}

/// The seam that mattered most: `boundary_ok` was the caller's, so a caller that said yes to everything could
/// mint backing against a boundary that proves nothing. `boundary_opens` verifies the sigma, the range proof and
/// the opening in-crate, and this vector is the real dapp prover's output, pinned byte-for-byte.
#[test]
fn boundary_opens_verifies_a_real_prover_output_and_refuses_a_doctored_one() {
    // `dapp/btc-pool-zk-boundary.js` `proveBoundary({ v: 12345n, rSecp: 0x1234abcdn, rBjj: 0x5678ef01n })`
    // with seedKey 0x0102..20. If the Rust verifier and the JS prover ever disagree, this is the test that says
    // so — the pool's own indexer path verifies the same bytes through the same `btc-pool-zk-core::boundary`.
    const C_SECP: &str = "037f4f02c895d266927f80ef72955fec7e97a4c72e7a9a466605a846d16730871b";
    const C_BJJ: &str = "483769acfbab8344cca7721c4750dbf3ab2b8d30d366f1c00aab0dfb705c7b9a";
    const SIGMA: &str = "03342073ede9da9d686e7490617fade3ceae52d656be53418c18f1544bafb17a55766c0eb02b3855b0fe661431e221b4a92591ae3cd9ec8ccc7de3c95cfb26faae2d2d0c2e4b3609fe76ef9da27a02969820f8e97dbd9e964b2ca727a26533174e0df108a7f027d0f0809a2ab56387ad770b4a142e2baa692cfba12cfd2a4451d403c2524a4e62528e03e9050050f1b54809900e923d016f259744ad25f47c8520ca75f6eb639fc4fb";
    const BPP: &str = "029fcaa4c6b7f88ea22ed45c87c42eb04ec99a6f81ade9c592274d7ea7472acbbf033af0d70dab7b9f5bb9113f1ed491db9b0386a705d556a481197c4433721fa986037053444b0e48afcd4587b20bcd4d74ad262ec4be82dab7430da674a51ed7a0f0415283b10f81fc7eafff7972c3670fbfe9a0cf372d11135ab832c1917c104cb9d4d27b3614e943fac5077de0e096ed712a2fb8d86e273a2769b7e811a3447852784bca6a0f6579151677cefb62c6be184b7661f79e54a034b6a8cb45b870c44d022eb4af8dca078adbbf3f19ef040c90a6b50197315b5440841febea3f8872a207027e86b43c17436f61aa685825b943f1c1537d4e6a0e3ef3d04d76e59b8eabdd750277c6505f1834367a9a227f645ccd5db53bbc5aa9efb524012c52234d5aac1e27036bcc3d4134cedea9ce581ca2b1358f37c915d8a4ec12fde8ef1b6fa5e7f29ec90338b83a49ce18c0f14df8124baeff507afaace42363af900d86834cb51e62f77b02343279d9142478f458e3249923d43c4a03822b276594b96d5957288d9bfc00c4020db69290200f75afc9206c46faed1e57c17cc79d03dcad46d257386eb2a38edd0398435b3dde2fc14bdfcafa76560701cb2a3157df9e503bfec0165961539c49bf03ab5fba9c22c27b4b1c35de796d64dec8c945b7a5e87dc89ba9ca3f2f91aaa55703a2e758e95317d06fcf853308465e5f398de2e72f4d5a0d82495015df829862d103a66e6834962db03f0231ccd27a9ebff420205fe6be233312b51bf5004f9af464035786e013776dac0b0d5bcc9d072b88ed91b5b1246c0c5b30f105effea7acf03c";

    let sigma = hex_bytes(SIGMA);
    let bpp = hex_bytes(BPP);
    assert_eq!(sigma.len(), 169, "sigma is 169 bytes");
    assert_eq!(bpp.len(), 591, "bpp is 591 bytes");
    let mut proof = sigma.clone();
    proof.extend_from_slice(&bpp);

    let boundary = Boundary {
        c_secp: hex_arr::<33>(C_SECP),
        c_bjj: hex_arr::<32>(C_BJJ),
        proof: &proof,
    };
    // The vector's blinding, big-endian, and its value: the real prover's statement.
    let blinding = be32(0x1234abcd);
    assert!(
        boundary_opens(&boundary, 12_345, &blinding),
        "the crate must verify the prover's own boundary, or the two implementations disagree"
    );

    // Every rejection below is one an attacker would try, and each must fail for its own reason.
    assert!(
        !boundary_opens(&boundary, 12_346, &blinding),
        "a boundary cannot be reused for a different value"
    );
    assert!(
        !boundary_opens(&boundary, 0, &blinding),
        "a zero value is never an anchor"
    );
    assert!(
        !boundary_opens(&boundary, 12_345, &be32(0x1234abce)),
        "a boundary cannot be reused with a different blinding"
    );

    // One flipped byte in the range proof: the sigma still parses, so this is the BP+ verifier talking.
    let mut tampered_bpp = proof.clone();
    tampered_bpp[300] ^= 0x01;
    let bad_bpp = Boundary {
        c_secp: boundary.c_secp,
        c_bjj: boundary.c_bjj,
        proof: &tampered_bpp,
    };
    assert!(
        !boundary_opens(&bad_bpp, 12_345, &blinding),
        "a tampered range proof must not verify"
    );

    // One flipped byte in the sigma: the cross-curve binding breaks.
    let mut tampered_sigma = proof.clone();
    tampered_sigma[40] ^= 0x01;
    let bad_sigma = Boundary {
        c_secp: boundary.c_secp,
        c_bjj: boundary.c_bjj,
        proof: &tampered_sigma,
    };
    assert!(
        !boundary_opens(&bad_sigma, 12_345, &blinding),
        "a tampered cross-curve sigma must not verify"
    );

    // A truncated proof is refused by length, not read as a shorter valid one.
    let short = Boundary {
        c_secp: boundary.c_secp,
        c_bjj: boundary.c_bjj,
        proof: &proof[..proof.len() - 1],
    };
    assert!(
        !boundary_opens(&short, 12_345, &blinding),
        "a short proof is not a valid proof"
    );
}

fn hex_bytes(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap_or(0))
        .collect()
}

fn hex_arr<const N: usize>(s: &str) -> [u8; N] {
    let v = hex_bytes(s);
    assert_eq!(v.len(), N, "vector length");
    let mut out = [0u8; N];
    out.copy_from_slice(&v);
    out
}

/// A u32 as a 32-byte big-endian scalar, which is how a blinding is written on the wire.
fn be32(v: u32) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[28..].copy_from_slice(&v.to_be_bytes());
    out
}

// ═══════════ REGRESI: serangan dari audit adversarial ═══════════

/// V1 — satu catatan, dua carrier. `bind = 0` membuat siapa pun boleh membawa payload yang sama ke
/// transaksi lain, jadi outpoint-nya berbeda tetapi commitment-nya sama. Debit harus menolak yang kedua.
#[test]
fn one_note_cannot_be_debited_through_a_second_carrier() {
    let mut l = BackingLedger::default();
    fund_via_shield(&mut l, &ASSET, 1000);
    let c1 = ExitAnchor {
        outpoint: [0xA1; 32],
        commitment: [0xC0; 32],
        asset: ASSET,
        value: 400,
    };
    let c2 = ExitAnchor {
        outpoint: [0xA2; 32],
        commitment: [0xC0; 32],
        asset: ASSET,
        value: 400,
    };
    assert_eq!(admit_exit(&mut l, &c1, &ASSET), Some(()));
    assert_eq!(
        admit_exit(&mut l, &c2, &ASSET),
        None,
        "the same note through a second carrier is refused"
    );
    assert_eq!(l.exited, 400, "backing is spent once for one note");
    assert_eq!(l.available(), 600);
}

/// V4 — leaf set satu aset tidak boleh menelan exit aset lain.
#[test]
fn valid_leaves_refuses_an_anchor_of_another_asset() {
    let a = ExitAnchor {
        outpoint: [0x11; 32],
        commitment: [0x22; 32],
        asset: [0xBB; 32],
        value: 400,
    };
    assert_eq!(
        valid_leaves(&[], &[a], &ASSET).len(),
        0,
        "an exit of another asset is not a leaf of this fold"
    );
}
