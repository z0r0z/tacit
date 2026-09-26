// Spike: real gas measurement for a snark-verifier-generated Solidity verifier of a real btc-pool-halo2
// proof (k=13, commit e3be20e1), against the pinned vk.bin/params-k13.bin — using the GWC multi-open
// scheme instead of SHPLONK. Companion to ../evm-client-pool-spike (the SHPLONK spike this mirrors
// line-for-line, only swapping gen_evm_proof_shplonk/gen_evm_verifier_shplonk for their _gwc equivalents).
// Feeds DESIGN-evm-client-pool.md's open §3a gas question: is GWC's simpler final pairing check enough
// to produce a smaller/cheaper/EIP-170-deployable verifier where SHPLONK's (504,095 gas, 35,645 bytes,
// over the cap) was not. Writes:
//   out/Verifier.sol   - the generated Solidity verifier
//   out/calldata.hex   - real calldata (instances + proof) for a live spend witness
// Deployment/gas measurement happens separately via forge (see README printed at the end).

use btc_pool_halo2::{circuit::SpendCircuit, fixture::Fixture, model::N_PUBLIC, srs};
use halo2_proofs::{
    circuit::Layouter,
    halo2curves::bn256::{Fr, G1Affine},
    plonk::{keygen_pk, Circuit, ConstraintSystem, Error, VerifyingKey},
};
use revm::{
    primitives::{CreateScheme, ExecutionResult, Output, TransactTo, TxEnv},
    InMemoryDB, EVM,
};
use snark_verifier_sdk::{
    evm::{encode_calldata, gen_evm_proof_gwc, gen_evm_verifier_gwc},
    CircuitExt,
};
use std::path::Path;

// snark-verifier-sdk's CircuitExt is a foreign trait; SpendCircuit is a foreign type (orphan rule), so
// we wrap it. This wrapper does no computation of its own — it only forwards to the pinned circuit.
#[derive(Clone, Default)]
struct Wrapper(SpendCircuit);

impl Circuit<Fr> for Wrapper {
    type Config = <SpendCircuit as Circuit<Fr>>::Config;
    type FloorPlanner = <SpendCircuit as Circuit<Fr>>::FloorPlanner;

    fn without_witnesses(&self) -> Self {
        Wrapper(self.0.without_witnesses())
    }
    fn configure(meta: &mut ConstraintSystem<Fr>) -> Self::Config {
        SpendCircuit::configure(meta)
    }
    fn synthesize(&self, cfg: Self::Config, ly: impl Layouter<Fr>) -> Result<(), Error> {
        self.0.synthesize(cfg, ly)
    }
}

impl CircuitExt<Fr> for Wrapper {
    fn instances(&self) -> Vec<Vec<Fr>> {
        vec![self
            .0
            .w
            .as_ref()
            .expect("witness required for instances()")
            .publics()
            .to_vec()]
    }
    // accumulator_indices() defaults to None: this is a standalone proof, not a recursive aggregation
    // step, so the generated verifier must run the full GWC decider (final pairing) itself.
}

fn main() {
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("out");
    std::fs::create_dir_all(&out).unwrap();

    eprintln!("loading pinned params-k13.bin / vk.bin (same params/vk as the SHPLONK spike — no new ceremony) ...");
    let params = srs::load_or_convert(None).expect("params");
    let vk_bytes = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../btc-pool-halo2/artifacts/vk.bin"),
    )
    .expect("read pinned vk.bin");
    let vk: VerifyingKey<G1Affine> =
        VerifyingKey::from_bytes::<SpendCircuit>(&vk_bytes, halo2_proofs::SerdeFormat::RawBytes)
            .expect("vk_from_bytes");

    eprintln!("deriving pk from the pinned vk (no re-keygen, same vk the circuit already pins) ...");
    let pk = keygen_pk(&params, vk, &SpendCircuit::default()).expect("keygen_pk");

    eprintln!("building a real witness (Fixture::pay(), the same fixture tests/spend.rs uses) ...");
    let w = Fixture::new().pay();
    let publics = w.publics().to_vec();
    assert_eq!(publics.len(), N_PUBLIC);
    let circuit = Wrapper(SpendCircuit { w: Some(w) });

    eprintln!("generating an EVM (Keccak-transcript) GWC proof over the real witness ...");
    let proof = gen_evm_proof_gwc(&params, &pk, circuit.clone(), vec![publics.clone()]);
    eprintln!("proof bytes: {}", proof.len());

    eprintln!("generating the Solidity verifier from the pinned vk + real protocol (snark-verifier GWC codegen, via solc) ...");
    let sol_path = out.join("Verifier.sol");
    let deployment_code =
        gen_evm_verifier_gwc::<Wrapper>(&params, pk.get_vk(), vec![N_PUBLIC], Some(&sol_path));
    eprintln!(
        "wrote {} ; unoptimized legacy-codegen deployment bytecode: {} bytes (EIP-170 cap is 24,576)",
        sol_path.display(),
        deployment_code.len()
    );

    let calldata = encode_calldata(&[publics.clone()], &proof);
    std::fs::write(out.join("calldata.hex"), hex::encode(&calldata)).unwrap();
    eprintln!("wrote {} ({} bytes)", out.join("calldata.hex").display(), calldata.len());

    eprintln!(
        "deploying to an in-memory EVM (revm) and calling with the real calldata ...\n\
         NOTE: limit_contract_code_size is raised here ONLY so the CALL's real execution gas can still\n\
         be measured regardless of whether this contract is under or over the EIP-170 cap — the printed\n\
         byte count above (and the report) says which.",
    );
    let calldata2 = encode_calldata(&[publics], &proof);
    let gas_used = deploy_and_call_uncapped(deployment_code, calldata2);
    println!("\n=== measured on-chain verify gas (execution only, real proof, real pinned vk, GWC) ===");
    println!("gas_used = {gas_used}");
}

/// Same as snark_verifier::loader::evm::deploy_and_call, but raises the deploy-time code-size cap so a
/// contract over EIP-170 can still be deployed inside this in-memory EVM for gas measurement. Research
/// use only — see the size-limit note printed above.
fn deploy_and_call_uncapped(deployment_code: Vec<u8>, calldata: Vec<u8>) -> u64 {
    let mut evm = EVM {
        env: Default::default(),
        db: Some(InMemoryDB::default()),
    };
    evm.env.cfg.limit_contract_code_size = Some(usize::MAX);

    evm.env.tx = TxEnv {
        gas_limit: u64::MAX,
        transact_to: TransactTo::Create(CreateScheme::Create),
        data: deployment_code.into(),
        ..Default::default()
    };
    let result = evm.transact_commit().unwrap();
    let contract = match result {
        ExecutionResult::Success { output: Output::Create(_, Some(contract)), .. } => contract,
        other => panic!("deploy failed: {other:?}"),
    };

    evm.env.tx = TxEnv {
        gas_limit: u64::MAX,
        transact_to: TransactTo::Call(contract),
        data: calldata.into(),
        ..Default::default()
    };
    match evm.transact_commit().unwrap() {
        ExecutionResult::Success { gas_used, .. } => gas_used,
        other => panic!("call failed: {other:?}"),
    }
}
