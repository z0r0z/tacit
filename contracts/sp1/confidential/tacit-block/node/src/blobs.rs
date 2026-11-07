//! The blob side of a block: the commitments and openings a block whose lists travel in blobs shows the landing contract, and the
//! input buffer the block program takes (blob count ‖ commitments ‖ every new note's memo in the block's output order).

use tacit_block_common::{blob, memo_hash, BlockData};

/// What the landing contract needs of one blob beside the blob itself: its KZG commitment, the point the program opens it at, the value
/// there and the proof.
#[derive(Clone, Debug)]
pub struct BlobOpening {
    pub commitment: [u8; 48],
    pub z: [u8; 32],
    pub y: [u8; 32],
    pub proof: [u8; 48],
}

impl BlobOpening {
    pub fn to_bytes(&self) -> Vec<u8> {
        [self.commitment.to_vec(), self.z.to_vec(), self.y.to_vec(), self.proof.to_vec()].concat()
    }
}

/// The blobs of a block whose lists (`data`, as a run without blobs found them) go in blobs, the memo of each new note found among
/// `pool` by its hash: → (the program's blob buffer, each blob's raw bytes, each blob's opening).
#[allow(clippy::type_complexity)]
pub fn blob_input(data: &BlockData, pool: &[Vec<u8>]) -> Result<(Vec<u8>, Vec<Vec<u8>>, Vec<BlobOpening>), String> {
    let mut memos: Vec<u8> = vec![];
    let mut outputs = vec![];
    for o in &data.outputs {
        let m = pool.iter().find(|m| memo_hash(m)[..] == o[32..]).ok_or("a new note without its memo")?;
        outputs.push((<[u8; 32]>::try_from(&o[..32]).unwrap(), m.clone()));
        memos.extend(m);
    }
    let stream = blob::stream(&outputs, &data.nullifiers, &data.claims);
    let settings = c_kzg::ethereum_kzg_settings(0);
    let n = blob::blobs_for(stream.len());
    let mut raw = vec![];
    let mut commitments = vec![];
    for i in 0..n {
        let bytes = blob::blob(&stream, i);
        let b = c_kzg::Blob::from_bytes(&bytes).map_err(|e| format!("blob: {e:?}"))?;
        commitments.push(settings.blob_to_kzg_commitment(&b).map_err(|e| format!("commitment: {e:?}"))?.to_bytes().into_inner());
        raw.push(bytes);
    }
    let (claims, _) = blob::claims(&stream, &commitments).ok_or("blob claims")?;
    let mut openings = vec![];
    for (i, c) in claims.iter().enumerate() {
        let b = c_kzg::Blob::from_bytes(&raw[i]).map_err(|e| format!("blob: {e:?}"))?;
        let z = c_kzg::Bytes32::from_bytes(&c[32..64]).map_err(|e| format!("z: {e:?}"))?;
        let (proof, y) = settings.compute_kzg_proof(&b, &z).map_err(|e| format!("kzg proof: {e:?}"))?;
        if y.as_slice() != &c[64..96] {
            return Err("the program's blob evaluation differs from the KZG library's".into());
        }
        openings.push(BlobOpening { commitment: commitments[i], z: c[32..64].try_into().unwrap(), y: c[64..96].try_into().unwrap(), proof: proof.to_bytes().into_inner() });
    }
    let mut buf = (n as u32).to_be_bytes().to_vec();
    for c in &commitments {
        buf.extend(c);
    }
    buf.extend(memos);
    Ok((buf, raw, openings))
}
