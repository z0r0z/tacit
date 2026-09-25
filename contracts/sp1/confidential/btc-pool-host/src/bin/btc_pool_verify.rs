//! Verifies a btc-pool-prover Groth16 proof locally against the SP1 Groth16 key
//! (DESIGN-btc-shielded-pool.md §5). No network access.
//!
//! stdin: {"proof":"0x..","public_values":"0x..","vkey":"0x.."}
//! stdout: {"ok":true} or {"ok":false,"reason":".."}, exit 0 either way; exit 2 on malformed input.

use serde_json::{json, Value};
use std::io::Read;
use std::process::exit;

fn fail(msg: &str) -> ! {
    eprintln!("btc-pool-verify: {msg}");
    exit(2)
}

fn hex_field(v: &Value, field: &str) -> Vec<u8> {
    let s = v.get(field).and_then(Value::as_str).unwrap_or_else(|| fail(&format!("missing hex field {field}")));
    hex::decode(s.strip_prefix("0x").unwrap_or(s)).unwrap_or_else(|_| fail(&format!("{field} is not hex")))
}

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap_or_else(|e| fail(&format!("read stdin: {e}")));
    let v: Value = serde_json::from_str(&raw).unwrap_or_else(|e| fail(&format!("input json: {e}")));
    let proof = hex_field(&v, "proof");
    let public_values = hex_field(&v, "public_values");
    let vkey = hex_field(&v, "vkey");
    if vkey.len() != 32 {
        fail("vkey must be 32 bytes");
    }
    let vkey_hex = format!("0x{}", hex::encode(&vkey));
    let out = match sp1_verifier::Groth16Verifier::verify(&proof, &public_values, &vkey_hex, &sp1_verifier::GROTH16_VK_BYTES) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "reason": e.to_string() }),
    };
    println!("{out}");
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    /// VERIFIER_HASH() and VK_ROOT() of the SP1 Groth16 verifier behind the immutable mainnet leaf
    /// 0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2 (VERSION v6.1.0).
    const MAINNET_VERIFIER_HASH: &str = "4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696";
    const MAINNET_VK_ROOT: &str = "002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352";

    #[test]
    fn groth16_key_matches_mainnet_verifier() {
        assert_eq!(hex::encode(Sha256::digest(*sp1_verifier::GROTH16_VK_BYTES)), MAINNET_VERIFIER_HASH);
        assert_eq!(hex::encode(*sp1_verifier::VK_ROOT_BYTES), MAINNET_VK_ROOT);
    }
}
