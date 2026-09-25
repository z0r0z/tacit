// Port of tests/btc-pool-zk.test.mjs: reference model, valid proofs, every soundness negative and the shared
// vectors. Needs the pinned pot18 at dapp/circuits/pot18_final.ptau (or PTAU=…) for real proofs; params are
// cached in artifacts/.
//
//   cargo test --release -- --nocapture

use btc_pool_halo2::{fixture::*, model::*, *};
use ff::Field;
use halo2_proofs::halo2curves::bn256::Fr;
use num_bigint::BigUint;
use serde_json::Value as J;
use std::sync::OnceLock;

fn vectors() -> &'static J {
    static V: OnceLock<J> = OnceLock::new();
    V.get_or_init(|| {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../tests/vectors/btc-pool-zk-vectors.json");
        serde_json::from_str(&std::fs::read_to_string(p).expect("vectors")).unwrap()
    })
}
fn fx() -> &'static Fixture {
    static F: OnceLock<Fixture> = OnceLock::new();
    F.get_or_init(Fixture::new)
}
fn keys() -> &'static (Params, Pk) {
    static K: OnceLock<(Params, Pk)> = OnceLock::new();
    K.get_or_init(|| {
        let params = btc_pool_halo2::srs::load_or_convert(None).expect("params");
        let pk = keygen(&params).unwrap();
        (params, pk)
    })
}

fn d(x: &Fr) -> String {
    to_dec(x)
}
fn pts(p: &Pt) -> J {
    J::from(vec![d(&p[0]), d(&p[1])])
}
fn s(x: &J) -> String {
    x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())
}

// The witness must fail, and some failure must be in a region named by one of `at` (the intended check).
fn neg_at(label: &str, w: &SpendWitness, at: &[&str]) {
    let fs = failures(w);
    assert!(!fs.is_empty(), "{label}: witness satisfied the circuit");
    let hit = fs.iter().any(|f| at.iter().any(|t| f.contains(&format!("('{t}"))));
    if std::env::var("VERBOSE").is_ok() || !hit {
        for f in fs.iter().take(6) {
            println!("      {}", f.lines().next().unwrap_or(""));
        }
    }
    assert!(hit, "{label}: no failure in {at:?}");
    println!("  ok - {label}");
}
fn relink(w: &mut SpendWitness, k: usize, v: &Fr) {
    w.out_leaf[k] = leaf_of(&w.asset, v, &w.out_npk[k], &w.out_rho[k]);
}
fn frb(x: &BigUint) -> Fr {
    fr(x)
}

#[test]
fn reference_model_and_vectors() {
    let f = fx();
    let v = vectors();
    let o = output_keys(&f.alice.a_pub, &f.alice.n_pub, &f.s1);
    assert!(o.ak == f.k1.ak && o.nk_pub == f.k1.nk_pub && o.npk == f.k1.npk && o.rho == f.k1.rho);
    assert!(mul_b8(&f.k1.sk) == f.k1.ak && mul_b8(&f.k1.nk) == f.k1.nk_pub);
    println!("  ok - sender and owner derive the same Ak, NK, npk, rho; sk·B8 = Ak, nk·B8 = NK");
    let other = wallet_keys(&[7u8; 32], "mainnet");
    assert!(other.a != f.alice.a);
    assert!(owned_keys(&f.alice, &f.s2).ak != f.k1.ak);
    println!("  ok - network and shared secret separate keys");
    let sig = sign(&f.k1.sk, &f.bh);
    assert!(verify_sig(&f.k1.ak, &f.bh, &sig));
    assert!(!verify_sig(&f.k1.ak, &(f.bh + Fr::ONE), &sig));
    assert!(!verify_sig(&f.k2.ak, &f.bh, &sig));
    println!("  ok - EdDSA-Poseidon sign/verify; wrong message or key rejected");
    assert_eq!(root_from_path(&f.leaf2, 3, &f.tree.path(3)), f.tree.root);
    println!("  ok - Merkle path round trip");

    for e in v["poseidon"].as_array().unwrap() {
        let xs: Vec<Fr> = e["inputs"].as_array().unwrap().iter().map(|x| fr_dec(&s(x))).collect();
        assert_eq!(d(&poseidon(&xs)), s(&e["out"]));
    }
    let h = &v["hs"][0];
    let data = hex::decode(s(&h["data"])).unwrap();
    assert_eq!(hs_l(&s(&h["tag"]), &[&data]).to_string(), s(&h["l"]));
    assert_eq!(d(&hs_p(&s(&h["tag"]), &[&data])), s(&h["p"]));
    assert_eq!(pts(&base8()), v["base8"]);
    let w = &v["wallet"];
    assert_eq!(f.alice.a.to_string(), s(&w["a"]));
    assert_eq!(f.alice.n.to_string(), s(&w["n"]));
    assert_eq!(pts(&f.alice.a_pub), w["A"]);
    assert_eq!(pts(&f.alice.n_pub), w["N"]);
    assert_eq!(hex::encode(f.asset), s(&v["asset"]));
    assert_eq!(d(&f.asset_f), s(&v["assetF"]));
    for (i, (sx, k, val, idx)) in [(f.s1, &f.k1, 1000u64, 1u64), (f.s2, &f.k2, 234, 3)].into_iter().enumerate() {
        let n = &v["notes"][i];
        let t = note_tweaks(&sx);
        let leaf = leaf_of(&f.asset_f, &fr_u64(val), &k.npk, &k.rho);
        assert_eq!(hex::encode(sx), s(&n["s"]));
        assert_eq!(t.t_a.to_string(), s(&n["t_a"]));
        assert_eq!(t.t_n.to_string(), s(&n["t_n"]));
        assert_eq!(d(&t.rho), s(&n["rho"]));
        assert_eq!(k.sk.to_string(), s(&n["sk"]));
        assert_eq!(k.nk.to_string(), s(&n["nk"]));
        assert_eq!(pts(&k.ak), n["Ak"]);
        assert_eq!(pts(&k.nk_pub), n["NK"]);
        assert_eq!(d(&k.npk), s(&n["npk"]));
        assert_eq!(val.to_string(), s(&n["v"]));
        assert_eq!(d(&leaf), s(&n["leaf"]));
        assert_eq!(n["index"].as_u64().unwrap(), idx);
        assert_eq!(d(&nullifier(&k.nk, &leaf, idx)), s(&n["nf"]));
    }
    let tv = &v["tree"];
    let leaves: Vec<String> = [fr_u64(123), f.leaf1, fr_u64(456), f.leaf2].iter().map(d).collect();
    assert_eq!(J::from(leaves), tv["leaves"]);
    assert_eq!(d(&f.tree.root), s(&tv["root"]));
    for p in tv["paths"].as_array().unwrap() {
        let idx = p["index"].as_u64().unwrap() as usize;
        let path: Vec<String> = f.tree.path(idx).iter().map(d).collect();
        assert_eq!(J::from(path), p["path"]);
    }
    assert_eq!(d(&zeros()[TREE_DEPTH]), s(&tv["zeros32"]));
    assert_eq!(hex::encode(&f.body), s(&v["body"]["hex"]));
    assert_eq!(d(&f.bh), s(&v["body"]["bodyHash"]));
    let e = &v["eddsa"];
    assert_eq!(pts(&f.k1.ak), e["A"]);
    assert_eq!(d(&f.bh), s(&e["M"]));
    assert_eq!(pts(&sig.r8), e["R8"]);
    assert_eq!(d(&sig.s), s(&e["S"]));
    let pd = &v["pedersen"][0];
    let c = pedersen_bjj(&BigUint::from(600u32), &f.r_exit);
    assert_eq!(f.r_exit.to_string(), s(&pd["r"]));
    assert_eq!(pts(&c), pd["C"]);
    assert_eq!(hex::encode(pack_point(&c)), s(&pd["packed"]));
    println!("  ok - Poseidon, hsL/hsP, Base8, wallet, asset, notes, tree, body hash, EdDSA and Pedersen match the vectors byte for byte");

    let cases = v["groth16"]["cases"].as_array().unwrap();
    for (name, w) in f.cases() {
        let want = cases.iter().find(|c| c["name"] == name).unwrap();
        assert_eq!(J::from(publics_to_dec(&w.publics())), want["publics"], "{name}");
    }
    println!("  ok - pay, partialExit and shield public signals equal the Groth16 vector publics");
}

#[test]
fn valid_proofs() {
    let f = fx();
    let (params, pk) = keys();
    let vk = pk.get_vk();
    let v = vectors();
    let cases = v["groth16"]["cases"].as_array().unwrap();
    let mut pay = None;
    for (name, w) in f.cases() {
        satisfies(&w).unwrap();
        let t0 = std::time::Instant::now();
        let proof = prove(params, pk, &w).unwrap();
        let dt = t0.elapsed();
        assert!(verify(params, vk, &w.publics(), &proof));
        let pubs: Vec<String> = cases.iter().find(|c| c["name"] == name).unwrap()["publics"].as_array().unwrap().iter().map(s).collect();
        let doc = serde_json::json!({ "proof": hex::encode(&proof), "publics": pubs });
        assert!(verify_json(params, vk, &doc).unwrap());
        println!("  ok - {name}: proves ({:.2} s) and verifies under the Groth16 vector publics, {} B", dt.as_secs_f64(), proof.len());
        if name == "pay" {
            pay = Some((w, proof));
        }
    }
    let (w, proof) = pay.unwrap();
    assert!(publics_acceptable(&f.pay().nf, false));
    assert!(publics_acceptable(&f.partial_exit().nf, false));
    assert!(publics_acceptable(&f.shield().nf, true));
    println!("  ok - indexer publics rules accept pay, partial exit and shield");

    let mut bad = w.publics();
    bad[0] = Tree::new(&[f.leaf1]).root;
    assert!(!verify(params, vk, &bad, &proof));
    println!("  ok - wrong root: a valid proof does not verify under another root");
    let mut bad = w.publics();
    bad[1] = body_hash(b"another body");
    assert!(!verify(params, vk, &bad, &proof));
    println!("  ok - body-hash tamper: a valid proof does not verify for another body");
    for i in 0..N_PUBLIC {
        let mut bad = w.publics();
        bad[i] += Fr::ONE;
        assert!(!verify(params, vk, &bad, &proof), "public {i} is not bound");
    }
    println!("  ok - each of the {N_PUBLIC} public inputs is bound: changing any one rejects the proof");
    let tampered = cases.iter().find(|c| c["name"] == "pay-tampered-bodyHash").unwrap();
    let doc = serde_json::json!({ "proof": hex::encode(&proof), "publics": tampered["publics"] });
    assert!(!verify_json(params, vk, &doc).unwrap());
    println!("  ok - pay-tampered-bodyHash vector publics rejected");
    let mut p2 = proof.clone();
    let mid = p2.len() / 2;
    p2[mid] ^= 1;
    assert!(!verify(params, vk, &w.publics(), &p2));
    assert!(!verify(params, vk, &w.publics(), &proof[..proof.len() - 1]));
    println!("  ok - corrupted and truncated proofs rejected");
    let mut nonc = publics_to_dec(&w.publics());
    nonc[3] = (to_big(&w.nf[0]) + p_big()).to_string();
    assert!(publics_from_dec(&nonc).is_err());
    println!("  ok - non-canonical public input (nf + p) refused by the parser");
    let vkb = vk_bytes(vk);
    let pinned = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/artifacts/vk.bin")).expect("artifacts/vk.bin");
    assert!(pinned == vkb, "circuit changed: artifacts/vk.bin is stale (btc-pool-halo2 keygen)");
    let vk2 = vk_from_bytes(&vkb).unwrap();
    assert!(verify(params, &vk2, &w.publics(), &proof));
    let rt = srs::read_params(&srs::write_params(params)).unwrap();
    assert!(verify(&rt, &vk2, &w.publics(), &proof));
    println!("  ok - vk equals the pinned artifacts/vk.bin; vk and params serialization round trip; vk {}", &vk_digest(vk)[..16]);
}

#[test]
fn soundness_negatives() {
    let f = fx();
    let base = f.pay();
    let base_exit = f.partial_exit();
    let base_shield = f.shield();
    satisfies(&base).unwrap();
    satisfies(&base_exit).unwrap();
    satisfies(&base_shield).unwrap();
    let p = p_big().clone();
    let l = l_big().clone();
    let two64: BigUint = BigUint::from(1u8) << 64usize;
    let u = |x: &Fr| to_big(x);

    {
        let mut x = base.clone();
        x.out_v[0] += Fr::ONE;
        let v0 = x.out_v[0];
        relink(&mut x, 0, &v0);
        neg_at("inflation: outputs exceed inputs", &x, &["balance"]);
    }
    {
        let mut x = base.clone();
        x.out_v[0] = frb(&(&p - 1u8));
        x.out_v[1] = x.out_v[1] + Fr::ONE + base.out_v[0];
        x.out_leaf[0] = poseidon(&[f.asset_f, frb(&(&p - 1u8)), x.out_npk[0], x.out_rho[0]]);
        let v1 = x.out_v[1];
        relink(&mut x, 1, &v1);
        neg_at("range: a field-negative output balancing a larger one", &x, &["out0 v range"]);
    }
    {
        let v_big = frb(&(&two64 + 1u8));
        let lb = poseidon(&[f.asset_f, v_big, f.k1.npk, f.k1.rho]);
        let t2 = Tree::new(&[lb]);
        let mut x = base.clone();
        x.root = t2.root;
        x.in_v = [v_big, Fr::ZERO];
        x.in_index = [Fr::ZERO, Fr::ZERO];
        x.in_path[0] = t2.path(0);
        x.nf = [poseidon(&[fr(&f.k1.nk), lb, Fr::ZERO]), Fr::ZERO];
        x.out_v = [v_big, Fr::ZERO, Fr::ZERO];
        x.out_leaf = [poseidon(&[f.asset_f, v_big, x.out_npk[0], x.out_rho[0]]), Fr::ZERO, Fr::ZERO];
        neg_at("range: an input ≥ 2^64 that is a tree member", &x, &["in0 v range"]);
    }
    {
        let mut x = base_exit.clone();
        x.exit_v = frb(&(&two64 + 600u32));
        let o0 = x.out_v[0];
        x.out_v[0] = o0 - frb(&two64);
        relink(&mut x, 0, &o0);
        neg_at("range: exit value ≥ 2^64 against a wrapped output", &x, &["exit v"]);
    }
    {
        let mut x = base.clone();
        x.root += Fr::ONE;
        neg_at("wrong root", &x, &["in0 membership"]);
    }
    {
        let forged = leaf_of(&f.asset_f, &fr_u64(5000), &f.k1.npk, &f.k1.rho);
        let mut x = base.clone();
        x.in_v[0] = fr_u64(5000);
        x.out_v[0] += fr_u64(4000);
        let v0 = x.out_v[0];
        relink(&mut x, 0, &v0);
        x.nf[0] = nullifier(&f.k1.nk, &forged, 1);
        neg_at("membership: a leaf that is not in the tree", &x, &["in0 membership"]);
    }
    {
        let mut x = base.clone();
        let idx = frb(&((BigUint::from(1u8) << 32usize) + 1u8));
        x.in_index[0] = idx;
        x.nf[0] = poseidon(&[fr(&f.k1.nk), f.leaf1, idx]);
        neg_at("nullifier alias: index + 2^32", &x, &["in0 index"]);
    }
    {
        let mut x = base.clone();
        let nk = fr(&(&f.k1.nk + &l));
        x.in_nk[0] = nk;
        x.nf[0] = poseidon(&[nk, f.leaf1, Fr::ONE]);
        neg_at("nullifier alias: nk_note + l", &x, &["in0 nk"]);
    }
    {
        let mut x = base.clone();
        let nk = fr(&(&l - &f.k1.nk));
        x.in_nk[0] = nk;
        x.nf[0] = poseidon(&[nk, f.leaf1, Fr::ONE]);
        neg_at("nullifier alias: l − nk_note (negated NK)", &x, &["in0 membership"]);
    }
    {
        let mut x = base.clone();
        x.nf[0] += Fr::ONE;
        neg_at("nullifier: any value other than Poseidon(nk, leaf, index)", &x, &["in0 nullifier"]);
    }
    {
        let w = build_witness(f.tree.root, f.bh, f.asset_f, &[Some(f.in1()), Some(f.in1())], &[Some(f.out_to(&f.bob, 2000, &s_out(6))), None, None], None, None).unwrap();
        assert_eq!(w.nf[0], w.nf[1]);
        assert!(!publics_acceptable(&w.nf, false));
        println!("  ok - one note in both slots yields one nullifier twice; the indexer distinctness rule rejects it");
    }
    {
        let mut x = base.clone();
        x.nf[1] = Fr::ZERO;
        neg_at("empty slot: nf = 0 with a non-zero value", &x, &["in1 empty"]);
        let mut y = base.clone();
        y.out_leaf[2] = Fr::ZERO;
        neg_at("empty output: leaf 0 with a non-zero value", &y, &["out2 empty"]);
    }
    {
        let mut x = base.clone();
        x.body_hash += Fr::ONE;
        neg_at("body-hash tamper: signatures are over the original body", &x, &["in0 sig eq"]);
    }
    {
        let mut x = base.clone();
        let sg = sign(&(&f.k1.sk + 1u8), &f.bh);
        x.sig_r8[0] = sg.r8;
        x.sig_s[0] = sg.s;
        neg_at("wrong owner: signature under another key", &x, &["in0 sig eq"]);
        let t_a = note_tweaks(&f.s1).t_a;
        let sg2 = sign(&t_a, &f.bh);
        let mut y = base.clone();
        y.sig_r8[0] = sg2.r8;
        y.sig_s[0] = sg2.s;
        neg_at("wrong owner: the sender, who knows t_a but not a", &y, &["in0 sig eq"]);
        let mut z = base.clone();
        z.body_hash = body_hash(b"redirected body");
        neg_at("delegated prover: a signed body cannot be proved as another body", &z, &["in0 sig eq"]);
    }
    {
        let mut x = base.clone();
        x.dep_c = pedersen_bjj(&BigUint::from(0u8), &BigUint::from(0u8));
        x.dep_v = fr_u64(5);
        x.dep_r = Fr::ZERO;
        x.out_v[0] += fr_u64(5);
        let v0 = x.out_v[0];
        relink(&mut x, 0, &v0);
        neg_at("deposit: a spend with depC = identity cannot add value", &x, &["dep commitment"]);
        let mut y = base_shield.clone();
        y.dep_v += Fr::ONE;
        y.out_v[0] += Fr::ONE;
        let v0 = y.out_v[0];
        relink(&mut y, 0, &v0);
        neg_at("deposit: shield value must open depC", &y, &["dep commitment"]);
    }
    {
        let mut x = base_exit.clone();
        x.exit_v = frb(&(u(&x.exit_v) + &l));
        x.out_v[0] = frb(&((u(&x.out_v[0]) + &p - &l) % &p));
        x.out_leaf[0] = poseidon(&[f.asset_f, x.out_v[0], x.out_npk[0], x.out_rho[0]]);
        neg_at("exit: v + l opens the same BabyJub point but fails the 64-bit range", &x, &["exit v"]);
        let mut y = base_exit.clone();
        y.exit_v = frb(&(u(&y.exit_v) + secp_n()));
        neg_at("exit: v + n_secp fails the 64-bit range", &y, &["exit v"]);
        let mut z = base_exit.clone();
        z.exit_v -= Fr::ONE;
        neg_at("exit: value must open exitC", &z, &["exit commitment"]);
    }
}

// Negatives beyond the JS suite: halo2-specific encodings and the conditional EdDSA checks.
#[test]
fn extra_negatives() {
    let f = fx();
    let base = f.pay();
    let l = l_big().clone();
    {
        let mut x = base.clone();
        x.sig_s[0] = fr(&(to_big(&x.sig_s[0]) + &l));
        neg_at("EdDSA: S + l (same S·B8) fails S < l", &x, &["in0 sig S < l range"]);
    }
    {
        let mut x = base.clone();
        x.in_ak[0] = x.in_ak[1];
        neg_at("spend key: another note's Ak does not hash to this leaf", &x, &["in0 membership"]);
    }
    {
        let mut x = f.partial_exit();
        x.exit_r = fr(&(to_big(&x.exit_r) + (BigUint::from(1u8) << 251usize)));
        neg_at("exit: r ≥ 2^251 fails the r range", &x, &["exit r"]);
    }
    {
        // Empty slot: an arbitrary signature is not checked, but the slot must stay empty.
        let mut x = f.partial_exit();
        x.sig_s[1] = Fr::from(12345u64);
        satisfies(&x).expect("disabled signature is not checked");
        println!("  ok - empty slot: the signature is disabled (as circom's enabled = 0)");
    }
    {
        // Zero-value real note: membership skipped, nullifier and signature still bound.
        let k = &f.k2;
        let asset = f.asset_f;
        let leaf0 = leaf_of(&asset, &Fr::ZERO, &k.npk, &k.rho);
        let dummy = InNote { v: 0, rho: k.rho, nk: k.nk.clone(), ak: k.ak, index: 5, path: [Fr::ZERO; TREE_DEPTH], sig: sign(&k.sk, &f.bh) };
        let w = build_witness(f.tree.root, f.bh, asset, &[Some(f.in1()), Some(dummy)], &[Some(f.out_to(&f.bob, 1000, &s_out(7))), None, None], None, None).unwrap();
        assert_eq!(w.nf[1], nullifier(&k.nk, &leaf0, 5));
        satisfies(&w).expect("zero-value input skips membership");
        let mut y = w.clone();
        y.sig_s[1] += Fr::ONE;
        neg_at("zero-value input: its signature is still checked", &y, &["in1 sig eq"]);
        println!("  ok - zero-value input: membership skipped, nullifier bound");
    }
}

#[test]
fn json_input_roundtrip() {
    let f = fx();
    let w = f.pay();
    let j = w.to_json();
    let back = SpendWitness::from_json(&j).unwrap();
    assert_eq!(back, w);
    let mut j2 = j.clone();
    j2["outV"][0] = J::from("-1");
    assert_eq!(SpendWitness::from_json(&j2).unwrap().out_v[0], -Fr::ONE);
    println!("  ok - circom input JSON round trip (negative decimals reduce mod p like snarkjs)");
}

// SRS: the pinned ptau converts to the cached params; a tampered power is refused.
#[test]
fn srs_conversion() {
    let path = srs::default_ptau_path();
    let Ok(bytes) = std::fs::read(&path) else {
        println!("  skip - no ptau at {}", path.display());
        return;
    };
    assert_eq!(srs::blake2b_hex(&bytes), srs::POT18_BLAKE2B);
    let (params, rep) = srs::params_from_ptau(&bytes, K).unwrap();
    assert_eq!(srs::write_params(&params), srs::write_params(&keys().0));
    for c in &rep.checks {
        println!("  ok - {c}");
    }
    // tauG1[5]: flip a bit of y (section 2 starts after the 12-byte file header, the header section and a section header)
    let mut bad = bytes.clone();
    let hdr_size = u64::from_le_bytes(bad[16..24].try_into().unwrap()) as usize;
    let g1_start = 12 + 12 + hdr_size + 12;
    bad[g1_start + 5 * 64 + 40] ^= 1;
    assert!(srs::params_from_ptau(&bad, K).is_err());
    let mut swapped = bytes.clone();
    let (a, b) = (g1_start + 5 * 64, g1_start + 6 * 64);
    let p5: Vec<u8> = swapped[a..a + 64].to_vec();
    let p6: Vec<u8> = swapped[b..b + 64].to_vec();
    swapped[a..a + 64].copy_from_slice(&p6);
    swapped[b..b + 64].copy_from_slice(&p5);
    assert!(srs::params_from_ptau(&swapped, K).is_err());
    println!("  ok - a corrupted or reordered τ^i·G1 is refused");
}
