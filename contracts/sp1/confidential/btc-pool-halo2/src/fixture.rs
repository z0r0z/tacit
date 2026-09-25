//! The tests/btc-pool-zk.test.mjs fixture: a wallet with two notes in a four-leaf tree and the pay,
//! partial-exit and shield spends.

use crate::model::*;
use halo2_proofs::halo2curves::bn256::Fr;
use num_bigint::BigUint;

pub struct Fixture {
    pub alice: Wallet,
    pub bob: Wallet,
    pub asset: [u8; 32],
    pub asset_f: Fr,
    pub s1: [u8; 33],
    pub s2: [u8; 33],
    pub k1: Owned,
    pub k2: Owned,
    pub leaf1: Fr,
    pub leaf2: Fr,
    pub tree: Tree,
    pub body: Vec<u8>,
    pub bh: Fr,
    pub r_exit: BigUint,
}

pub fn s_of(prefix: u8, fill: u8) -> [u8; 33] {
    let mut s = [fill; 33];
    s[0] = prefix;
    s
}
pub fn s_out(i: u8) -> [u8; 33] {
    s_of(2, 0x40 + i)
}

impl Fixture {
    pub fn new() -> Fixture {
        let alice = wallet_keys(&[7u8; 32], "signet");
        let bob = wallet_keys(&[9u8; 32], "signet");
        let asset = [0xabu8; 32];
        let asset_f = asset_field(&asset);
        let (s1, s2) = (s_of(2, 0x11), s_of(3, 0x22));
        let k1 = owned_keys(&alice, &s1);
        let k2 = owned_keys(&alice, &s2);
        let leaf1 = leaf_of(&asset_f, &fr_u64(1000), &k1.npk, &k1.rho);
        let leaf2 = leaf_of(&asset_f, &fr_u64(234), &k2.npk, &k2.rho);
        let tree = Tree::new(&[fr_u64(123), leaf1, fr_u64(456), leaf2]);
        let body = b"T_BTC_SPEND body bytes: asset h_anchor bind nf outputs exit want".to_vec();
        let bh = body_hash(&body);
        let r_exit = hs_l("test-exit-r", &[&s1]);
        Fixture { alice, bob, asset, asset_f, s1, s2, k1, k2, leaf1, leaf2, tree, body, bh, r_exit }
    }

    pub fn inp(&self, k: &Owned, v: u64, index: u64, bh: &Fr, sk: &BigUint) -> InNote {
        InNote { v, rho: k.rho, nk: k.nk.clone(), ak: k.ak, index, path: self.tree.path(index as usize), sig: sign(sk, bh) }
    }
    pub fn in1(&self) -> InNote {
        self.inp(&self.k1, 1000, 1, &self.bh, &self.k1.sk)
    }
    pub fn in2(&self) -> InNote {
        self.inp(&self.k2, 234, 3, &self.bh, &self.k2.sk)
    }
    pub fn out_to(&self, w: &Wallet, v: u64, s: &[u8; 33]) -> OutNote {
        let o = output_keys(&w.a_pub, &w.n_pub, s);
        OutNote { v, npk: o.npk, rho: o.rho }
    }

    pub fn pay(&self) -> SpendWitness {
        build_witness(
            self.tree.root,
            self.bh,
            self.asset_f,
            &[Some(self.in1()), Some(self.in2())],
            &[Some(self.out_to(&self.bob, 900, &s_out(0))), Some(self.out_to(&self.alice, 300, &s_out(1))), Some(self.out_to(&self.bob, 34, &s_out(2)))],
            None,
            None,
        )
        .unwrap()
    }
    pub fn partial_exit(&self) -> SpendWitness {
        build_witness(
            self.tree.root,
            self.bh,
            self.asset_f,
            &[Some(self.in1()), None],
            &[Some(self.out_to(&self.alice, 350, &s_out(3))), Some(self.out_to(&self.bob, 50, &s_out(4))), None],
            Some(Opening { v: 600, r: self.r_exit.clone() }),
            None,
        )
        .unwrap()
    }
    pub fn shield(&self) -> SpendWitness {
        build_witness(
            self.tree.root,
            body_hash(b"T_BTC_SHIELD body"),
            self.asset_f,
            &[None, None],
            &[Some(self.out_to(&self.alice, 777, &s_out(5))), None, None],
            None,
            Some(Opening { v: 777, r: hs_l("test-dep-r", &[&self.s2]) }),
        )
        .unwrap()
    }
    pub fn cases(&self) -> Vec<(&'static str, SpendWitness)> {
        vec![("pay", self.pay()), ("partialExit", self.partial_exit()), ("shield", self.shield())]
    }
}

impl Default for Fixture {
    fn default() -> Self {
        Self::new()
    }
}
