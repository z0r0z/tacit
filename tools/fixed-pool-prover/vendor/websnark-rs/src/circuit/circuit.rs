use std::collections::HashMap;

use ark_bn254::Fr;
use rustc_hash::FxHashMap;
use tracing::instrument;

use crate::circuit::{CircuitError, Witness, rt_ctx::RTCtx, value::Value};

/// CircomV1-compatible circuit definition.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Circuit {
    pub n_pub_inputs: usize,
    pub n_prv_inputs: usize,
    pub n_inputs: usize,
    pub n_outputs: usize,
    pub n_vars: usize,
    pub n_signals: usize,
    pub n_constants: usize,

    pub signal_name2_idx: FxHashMap<String, usize>,
    pub component_name2_idx: FxHashMap<String, usize>,

    pub signals: Vec<Signal>,
    pub components: Vec<Component>,

    pub templates: FxHashMap<String, String>,
    pub functions: FxHashMap<String, Function>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Signal {
    pub names: Vec<String>,
    #[serde(rename = "triggerComponents")]
    pub trigger_components: Vec<usize>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Component {
    pub name: String,
    pub template: String,
    pub params: FxHashMap<String, Value>,
    #[serde(rename = "inputSignals")]
    pub input_signals: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Function {
    pub params: Vec<String>,
    pub func: String,
}

impl Circuit {
    /// Generate the witness for a given circuit and input signals. The `input_signals`
    /// map should contain the named input values for the circuit.
    ///
    /// # Errors
    /// Returns an error if the circuit or input signals are invalid, or if the
    /// witness cannot be generated.
    #[instrument(skip_all)]
    pub fn witness(&self, input_signals: HashMap<String, Value>) -> Result<Witness, CircuitError> {
        let mut ctx = RTCtx::new(self)?;
        ctx.set_signal("one", vec![], Fr::from(1u64))?;

        for (c, v) in ctx.not_init_signals.clone().iter().enumerate() {
            if *v == 0 {
                ctx.trigger_component(c)?;
            }
        }
        ctx.drain()?;

        for (name, values) in input_signals {
            ctx.current_component = Some("main".to_string());
            iterate_selector(&mut ctx, &name, values, &mut Vec::new())?;
        }
        ctx.drain()?;

        for i in 0..ctx.circuit.n_inputs {
            let idx = ctx.circuit.input_idx(i)?;
            if ctx.witness[idx].is_none() {
                let signal_name = ctx.circuit.signal_name(i)?;
                return Err(CircuitError::SignalNotAssigned(signal_name));
            }
        }

        for i in 0..ctx.witness.len() {
            if ctx.witness[i].is_none() {
                let signal_name = ctx.circuit.signal_name(i)?;
                return Err(CircuitError::SignalNotAssigned(signal_name));
            }
        }

        let output = ctx.witness[..ctx.circuit.n_vars]
            .iter()
            .map(|v| v.ok_or(CircuitError::SignalNotAssigned("unreachable".to_string())))
            .collect::<Result<Vec<Fr>, CircuitError>>()?;
        Ok(Witness::new(output))
    }

    /// Returns the index of the i-th input
    ///
    /// # Errors
    /// Returns an error if the input index is out of bounds
    fn input_idx(&self, i: usize) -> Result<usize, CircuitError> {
        if i >= self.n_inputs {
            return Err(CircuitError::InputIndexOutOfBounds(i, self.n_inputs));
        }
        Ok(self.n_outputs + 1 + i)
    }

    /// Returns the name of the i-th input signal
    ///
    /// # Errors
    /// Returns an error if the input index is out of bounds
    fn signal_name(&self, i: usize) -> Result<String, CircuitError> {
        let idx = self.input_idx(i)?;
        Ok(self.signals[idx].names.join(","))
    }
}

fn iterate_selector(
    ctx: &mut RTCtx,
    name: &str,
    values: Value,
    sels: &mut Vec<u32>,
) -> Result<(), CircuitError> {
    match values {
        Value::Fr(f) => ctx.set_signal(name, sels.clone(), f)?,
        Value::Array(arr) => {
            for (i, val) in arr.into_iter().enumerate() {
                #[allow(clippy::cast_possible_truncation)]
                sels.push(i as u32);
                iterate_selector(ctx, name, val, sels)?;
                sels.pop();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[tracing_test::traced_test]
    fn test_witness() {
        let circuit_data = include_str!("../testdata/withdraw.json");
        let circuit: Circuit = serde_json::from_str(circuit_data).unwrap();

        let input_signal_data = include_str!("../testdata/withdraw_input_signals.json");
        let input_signals: HashMap<String, Value> =
            serde_json::from_str(input_signal_data).unwrap();

        let expected_witness_data = include_str!("../testdata/witness.json");
        let expected_witness: Witness = serde_json::from_str(expected_witness_data).unwrap();

        let witness = circuit.witness(input_signals).unwrap();
        assert_eq!(witness, expected_witness);
    }

    #[test]
    #[tracing_test::traced_test]
    fn test_witness_postcard_roundtrip() {
        let circuit_data = include_str!("../testdata/withdraw.json");
        let circuit: Circuit = serde_json::from_str(circuit_data).unwrap();

        let bytes = postcard::to_stdvec(&circuit).unwrap();
        let circuit: Circuit = postcard::from_bytes(&bytes).unwrap();

        let input_signal_data = include_str!("../testdata/withdraw_input_signals.json");
        let input_signals: HashMap<String, Value> =
            serde_json::from_str(input_signal_data).unwrap();

        let expected_witness_data = include_str!("../testdata/witness.json");
        let expected_witness: Witness = serde_json::from_str(expected_witness_data).unwrap();

        let witness = circuit.witness(input_signals).unwrap();
        assert_eq!(witness, expected_witness);
    }
}
