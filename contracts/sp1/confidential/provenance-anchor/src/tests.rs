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
    let tx = segwit_tx(
        &[vec![0xFFu8; 32], envelope_script(&body)],
        &[(0u64, dest_spk.clone())],
    );
    let w = witness_for(&tx, [0x99u8; 32], value, blind);
    Fixture {
        w,
        commitment: commitment_hash(&cx, &cy),
        dest_spk,
    }
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
    assert_eq!(admit_exit(&mut l, &a), None, "nothing funded yet");
    assert_eq!((l.funded, l.exited), (0, 0), "a refused exit books nothing");

    l.fund(&[0x01; 32], 70);
    assert_eq!(admit_exit(&mut l, &a), None, "70 does not cover 100");
    assert_eq!(l.exited, 0, "still nothing booked");

    l.fund(&[0x02; 32], 30);
    assert_eq!(admit_exit(&mut l, &a), Some(()), "70 + 30 covers 100");
    assert_eq!((l.funded, l.exited, l.available()), (100, 100, 0));
}

#[test]
fn ledger_cannot_be_drained_past_its_funding() {
    let mut l = BackingLedger::default();
    l.fund(&[0x01; 32], 1000);
    for i in 0..10u8 {
        assert_eq!(l.debit(&[i; 32], 100), Some(()));
    }
    assert_eq!(l.available(), 0);
    assert_eq!(
        l.debit(&[0xFF; 32], 1),
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
    l.fund(&[0x01; 32], 1000);
    let a = ExitAnchor {
        outpoint: [0x11; 32],
        commitment: [0x22; 32],
        asset: ASSET,
        value: 400,
    };
    assert_eq!(admit_exit(&mut l, &a), Some(()));
    assert_eq!(
        admit_exit(&mut l, &a),
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
    assert_eq!(admit_exit(&mut l, &b), Some(()));
    assert_eq!((l.funded, l.exited, l.available()), (1000, 800, 200));
}

#[test]
fn ledger_fund_saturates_and_value_zero_is_never_an_anchor() {
    let mut l = BackingLedger {
        funded: u128::MAX - 1,
        exited: 0,
        shielded: BTreeSet::new(),
        exited_at: BTreeSet::new(),
    };
    l.fund(&[0x09; 32], 10);
    assert_eq!(l.funded, u128::MAX, "saturates rather than wrapping");
    let zero = ExitAnchor {
        outpoint: [3u8; 32],
        commitment: [4u8; 32],
        asset: ASSET,
        value: 0,
    };
    assert_eq!(
        admit_exit(&mut l, &zero),
        None,
        "a zero-value exit backs nothing"
    );
}

// ───────────────────────────── boundaries ─────────────────────────────

#[test]
fn credit_shield_requires_a_matching_boundary() {
    let bytes = boundary_bytes(&[0x02u8; 33], &[0x03u8; 32]);
    let boundary = Boundary::parse(&bytes).unwrap();
    let blind = [0x11u8; 32];
    let mut l = BackingLedger::default();

    let carrier = [0x77u8; 32];
    assert_eq!(
        credit_shield(&mut l, &carrier, &boundary, 0, &blind, &|_, _, _| true),
        None,
        "a shield that moved nothing"
    );
    assert_eq!(
        credit_shield(&mut l, &carrier, &boundary, 500, &blind, &|_, _, _| false),
        None,
        "a boundary that does not open"
    );
    assert_eq!(l.funded, 0, "neither refusal funded anything");

    let ok = |b: &Boundary<'_>, v: u64, bl: &[u8; 32]| {
        b.c_bjj == [0x03u8; 32] && v == 500 && bl == &blind
    };
    assert_eq!(
        credit_shield(&mut l, &carrier, &boundary, 500, &blind, &ok),
        Some(())
    );
    assert_eq!(l.funded, 500);
    assert_eq!(
        credit_shield(&mut l, &carrier, &boundary, 500, &blind, &ok),
        None,
        "re-folding the same shield must not mint backing"
    );
    assert_eq!(l.funded, 500, "and credited nothing the second time");
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
        admit_exit(&mut l, &anchor),
        None,
        "reading is not backing: the ledger must hold the value"
    );
    l.fund(&[0x05; 32], value - 1);
    assert_eq!(admit_exit(&mut l, &anchor), None, "one sat short is short");
    l.fund(&[0x06; 32], 1);
    assert_eq!(admit_exit(&mut l, &anchor), Some(()));
    assert_eq!(l.available(), 0);
    assert_eq!(
        admit_exit(&mut l, &anchor),
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
    let tx = segwit_tx(
        &[vec![0u8; 0], envelope_script(&payload)],
        &[(0u64, dest_spk)],
    );
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
    let forged = segwit_tx(
        &[vec![0u8; 0], envelope_script(&forged_body)],
        &[(0u64, f.dest_spk.clone())],
    );
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
    assert_eq!(lineage(0, None), Lineage::Full { hops: 0, steps: 0 });
    assert_eq!(
        lineage(255, None),
        Lineage::Full {
            hops: 255,
            steps: 255
        }
    );
    assert_eq!(
        lineage(255, Some(([1u8; 32], 10))),
        Lineage::Full {
            hops: 255,
            steps: 255
        },
        "an anchor is unnecessary inside the cap"
    );
}

#[test]
fn lineage_re_anchors_past_the_cap() {
    assert_eq!(
        lineage(256, Some(([9u8; 32], 0))),
        Lineage::Anchored {
            hops: 256,
            from: [9u8; 32],
            distance: 0
        }
    );
    assert_eq!(
        lineage(10_000, Some(([9u8; 32], 255))),
        Lineage::Anchored {
            hops: 10_000,
            from: [9u8; 32],
            distance: 255
        }
    );
}

#[test]
fn lineage_refuses_an_out_of_reach_anchor() {
    assert_eq!(
        lineage(256, None),
        Lineage::Refused {
            hops: 256,
            cap: 256
        }
    );
    assert_eq!(
        lineage(700, Some(([9u8; 32], 256))),
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
    let out = valid_leaves(&base, &[a, a]);
    assert_eq!(out.len(), 2, "the same anchor twice is one leaf");
    assert_eq!(
        out[0], base[0],
        "the leaves it already had come first, unchanged"
    );
    assert_eq!(out[1], (a.outpoint, a.commitment));

    // An existing leaf with the same outpoint but a different commitment is not silently replaced: the base set
    // wins, so a caller cannot re-point a leaf the DAG already resolved.
    let clash = ExitAnchor {
        outpoint: [0x01u8; 32],
        commitment: [0x99u8; 32],
        asset: ASSET,
        value: 5,
    };
    assert_eq!(valid_leaves(&base, &[clash]).len(), 2);
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
    let tx = segwit_tx(
        &[vec![0u8; 0], envelope_script(&payload)],
        &[(0u64, dest_spk)],
    );
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
