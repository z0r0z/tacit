use k256::elliptic_curve::sec1::FromEncodedPoint;
use k256::{AffinePoint, EncodedPoint, ProjectivePoint, Scalar};
use sha2::{Sha256, Digest};

pub fn pedersen_h() -> ProjectivePoint {
    let seed: [u8; 32] = Sha256::digest(b"tacit-generator-H-v1").into();
    for counter in 0u8..=255 {
        let mut hasher = Sha256::new();
        hasher.update(&seed);
        hasher.update(&[counter]);
        let x: [u8; 32] = hasher.finalize().into();
        let mut compressed = [0u8; 33];
        compressed[0] = 0x02;
        compressed[1..33].copy_from_slice(&x);
        if let Ok(ep) = EncodedPoint::from_bytes(&compressed) {
            let opt: Option<AffinePoint> = AffinePoint::from_encoded_point(&ep).into();
            if let Some(pt) = opt {
                return ProjectivePoint::from(pt);
            }
        }
    }
    panic!("failed to derive NUMS generator H");
}

pub fn verify_pedersen_opening(
    h: &ProjectivePoint,
    commitment: &[u8; 33],
    amount: u64,
    blinding: &[u8; 32],
) -> bool {
    let ep = match EncodedPoint::from_bytes(commitment) {
        Ok(ep) => ep,
        Err(_) => return false,
    };
    let c_opt: Option<AffinePoint> = AffinePoint::from_encoded_point(&ep).into();
    let c = match c_opt {
        Some(a) => ProjectivePoint::from(a),
        None => return false,
    };

    let mut amount_be = [0u8; 32];
    amount_be[24..32].copy_from_slice(&amount.to_be_bytes());
    let a_scalar = match Scalar::from_repr(amount_be.into()).into_option() {
        Some(s) => s,
        None => return false,
    };

    let r_scalar = match Scalar::from_repr((*blinding).into()).into_option() {
        Some(s) => s,
        None => return false,
    };

    let expected = *h * a_scalar + ProjectivePoint::GENERATOR * r_scalar;
    expected == c
}
