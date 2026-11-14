use super::*;
use std::path::PathBuf;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures")
}

// A deterministic stream for test data.
struct Stream(B256);

impl Stream {
    fn next(&mut self) -> U256 {
        self.0 = keccak256(self.0);
        U256::from_be_bytes(self.0 .0)
    }

    fn below(&mut self, n: u64) -> u64 {
        (self.next() % U256::from(n)).to::<u64>()
    }
}

#[test]
fn packing_truncates_by_at_most_two_to_the_minus_m() {
    let mut s = Stream(B256::ZERO);
    for m in [20usize, 24] {
        for _ in 0..2000 {
            let v = s.next() >> s.below(256);
            let back = unpack(pack(v, m), m);
            assert!(back <= v && v - back <= v >> m, "m {m} v {v}");
            assert!(pack(v, m) < U256::from(1) << (m + 8));
        }
        for v in [0u64, 1, (1 << m) - 1, 1 << m, (1 << (m + 1)) - 1, 1 << (m + 1)] {
            assert_eq!(unpack(pack(U256::from(v), m), m), U256::from(v));
        }
    }
}

#[test]
fn full_mul_div_is_solady_s() {
    let max = U256::MAX;
    assert_eq!(full_mul_div(max, max, max), Some(max));
    assert_eq!(full_mul_div(max, U256::from(2), U256::from(1)), None);
    assert_eq!(full_mul_div(U256::from(7), U256::from(3), U256::from(2)), Some(U256::from(10)));
    assert_eq!(full_mul_div(U256::from(1), U256::from(1), U256::ZERO), None);
}

#[derive(serde::Deserialize)]
struct MainnetHeader {
    number: u64,
    hash: B256,
    raw: Bytes,
}

#[derive(serde::Deserialize)]
struct MainnetHeaders {
    headers: Vec<MainnetHeader>,
}

/// Real headers from the Merge on (16 to 21 fields) parse, with their number and hash.
#[test]
fn real_mainnet_headers_parse() {
    let f: MainnetHeaders =
        serde_json::from_str(&std::fs::read_to_string(fixtures().join("trie/mainnet-headers.json")).unwrap()).unwrap();
    assert!(f.headers.len() > 50);
    for h in &f.headers {
        let p = header(&h.raw).unwrap();
        assert_eq!(p.number, h.number);
        assert_eq!(p.hash, h.hash);
    }
}

fn config() -> Config {
    // TacLaunchFixture's venues: STEP 50, windows of 12, 18 and 36 intervals, two thirds coverage.
    Config {
        step: 50,
        short_points: 12,
        window_points: 18,
        max_points: 36,
        min_coverage_bps: 6_600,
        precision: Address::ZERO,
        sqrt_p_low: U256::from(1),
        sqrt_p_high: U256::from(2),
        pool: Address::ZERO,
        slot_a: B256::ZERO,
        slot_b: B256::ZERO,
        eth_scale: U256::from(1),
        tac_scale: U256::from(1),
    }
}

// Random histories for the answers' cross-check with TacPairOracle (test/TacProvenOracle.t.sol): prices around the
// fixture venues' (baseA, baseB as given), depths from 1 to 5,001 ETH, some intervals unrecorded.
fn cases(base_a: U256, base_b: U256) -> String {
    let c = config();
    let mut s = Stream(keccak256("tac proven cases"));
    let mut out = Vec::new();
    for case in 0..24 {
        let x = 519_950 + s.below(100);
        let count = 2 + s.below(7);
        let lo = x - c.max_points;
        // a share of intervals without a sample, more in later cases
        let gap = [0u64, 0, 5, 15, 30][case % 5];
        let mut venue = |base: U256| -> Vec<Sample> {
            (lo..=x)
                .map(|_| {
                    if s.below(100) < gap {
                        return None;
                    }
                    let p = base * U256::from(3_000 + s.below(14_000)) / U256::from(10_000u64) + U256::from(1);
                    let d = U256::from(1_000_000_000_000_000_000u64) * U256::from(1 + s.below(5_000));
                    Some((p, d))
                })
                .collect()
        };
        let a = venue(base_a);
        let b = venue(base_b);
        let samples = Samples { c: &c, x, lo, a: &a, b: &b };
        let hex = |v: U256| format!("\"{v:#x}\"");
        let arr = |v: &[Sample], depth: bool| {
            v.iter()
                .map(|o| hex(o.map(|(p, d)| if depth { d } else { p }).unwrap_or_default()))
                .collect::<Vec<_>>()
                .join(",")
        };
        let words = (0..count).map(|j| hex(samples.word(x - 1 + j))).collect::<Vec<_>>().join(",");
        out.push(format!(
            "{{\"x\":{x},\"count\":{count},\"priceA\":[{}],\"depthA\":[{}],\"priceB\":[{}],\"depthB\":[{}],\"words\":[{words}],\"head\":{}}}",
            arr(&a, false),
            arr(&a, true),
            arr(&b, false),
            arr(&b, true),
            hex(samples.head(count, 0)),
        ));
    }
    format!("{{\"cases\":[{}]}}\n", out.join(","))
}

/// The cases file the Solidity cross-check reads is what this code computes; TAC_PROVEN_FIXTURE=1 rewrites it.
#[test]
fn the_solidity_cross_check_cases_are_current() {
    // TacLaunchFixture's venue spot prices: baseA = a.spot(), baseB = b.spot() at deployment.
    let base_a = full_mul_div(
        U256::from(300_000_000_000_000_000_000u128) * wad() / U256::from(3_780_000_000_000_000_000_000u128)
            + U256::from(3_000_000_000_000_000_000u128),
        wad(),
        U256::from(300_000_000_000_000_000_000u128) * U256::from(3_780_000_000_000_000_000u128) / wad()
            + U256::from(30_000_000_000_000_000_000_000u128),
    )
    .unwrap();
    let base_b = full_mul_div(
        U256::from(300_000_000u64) * U256::from(10_000_000_000u64),
        wad(),
        U256::from(3_200_000_000_000u64) * U256::from(10_000_000_000u64),
    )
    .unwrap();
    let path = fixtures().join("tac-proven/cases.json");
    let want = cases(base_a, base_b);
    if std::env::var("TAC_PROVEN_FIXTURE").is_ok() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &want).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), want, "run with TAC_PROVEN_FIXTURE=1 to rewrite");
}

// A real input (tac-oracle-host from mainnet, anchor 26412560, windows of 2, 3 and 4 intervals: 261 headers and both
// venues' proofs at 5 sample blocks) and the public values it gives.
fn mainnet() -> (Input, Vec<u8>) {
    let dir = fixtures().join("tac-proven/mainnet");
    let input: Input = bincode::deserialize(&std::fs::read(dir.join("input.bincode")).unwrap()).unwrap();
    let pv = std::fs::read_to_string(dir.join("pv.hex")).unwrap();
    let pv: Vec<u8> = (0..pv.trim().len() / 2).map(|i| u8::from_str_radix(&pv.trim()[2 * i..2 * i + 2], 16).unwrap()).collect();
    (input, pv)
}

#[test]
fn a_real_input_gives_its_public_values() {
    let (input, pv) = mainnet();
    assert_eq!(input.headers.len(), 261);
    assert_eq!(public_values(&input).unwrap(), pv);
    // the words for X - 1 and X, whose windows are all recorded, answer every window
    let p = public_values(&input).unwrap();
    for w in p[64..128].chunks(32) {
        let w = U256::from_be_slice(w);
        assert!((0..9usize).all(|f| !((w >> (28 * f)) & U256::from(0xfffffffu64)).is_zero()), "{w:x}");
    }
}

/// Nothing a prover hands in can make an interval unrecorded or change a sample: each change is refused.
#[test]
fn every_change_to_a_real_input_is_refused() {
    let (base, _) = mainnet();
    let refused = |name: &str, f: &dyn Fn(&mut Input), want: Error| {
        let mut i = base.clone();
        f(&mut i);
        assert_eq!(public_values(&i), Err(want), "{name}");
    };
    // the chain
    refused("a header left out", &|i| { i.headers.remove(100); }, Error::Chain);
    refused("a header changed", &|i| {
        let mut h = i.headers[100].to_vec();
        let n = h.len();
        h[n - 40] ^= 1;
        i.headers[100] = h.into();
    }, Error::Chain);
    refused("the first block off by one", &|i| i.first_block += 1, Error::Chain);
    refused("the headers cut before the block that picks X's sample", &|i| { i.headers.truncate(200); }, Error::Range);
    // the account proofs
    refused("an account proof cut short", &|i| { i.intervals[2][0].account_proof.pop(); }, Error::Proof);
    refused("an account said absent", &|i| { i.intervals[2][1].account = None; }, Error::Proof);
    refused("an account's storage root changed", &|i| {
        i.intervals[2][0].account.as_mut().unwrap().storage_root = B256::repeat_byte(7);
    }, Error::Proof);
    refused("the venues swapped", &|i| i.intervals[3].swap(0, 1), Error::Proof);
    // the storage proofs
    refused("a slot's value changed", &|i| {
        let s = &mut i.intervals[1][1].slots[0];
        s.value += U256::from(1);
    }, Error::Proof);
    refused("a slot said absent", &|i| { i.intervals[1][0].slots[1].value = U256::ZERO; }, Error::Proof);
    refused("a slot said absent with its proof cut to the root", &|i| {
        let s = &mut i.intervals[1][1].slots[1];
        s.value = U256::ZERO;
        s.proof.truncate(1);
    }, Error::Proof);
    refused("a storage proof cut short", &|i| { i.intervals[4][1].slots[0].proof.pop(); }, Error::Proof);
    refused("another slot", &|i| i.config.slot_a = B256::repeat_byte(1), Error::Proof);
    // the shape
    refused("an interval left out", &|i| { i.intervals.pop(); }, Error::Range);
    refused("one count too many", &|i| i.count = SPAN + 1, Error::Range);
}

/// A sample that misses the venue oracle's bounds is unrecorded, as its record would revert.
#[test]
fn out_of_bound_values_are_unrecorded() {
    let mut c = config();
    c.eth_scale = U256::from(1) << 104;
    assert_eq!(amm_read(&c, U256::from(1), U256::from(1)).map(|(_, d)| d > mask()), Some(true));
    assert_eq!(amm_read(&c, U256::ZERO, U256::from(1)), None);
    assert_eq!(precision_read(&c, U256::from(5), U256::ZERO), None);
}
