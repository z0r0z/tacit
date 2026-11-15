use std::{collections::VecDeque, fmt::Write, rc::Rc};

use ark_bn254::Fr;
use rustc_hash::FxHashMap;
use tracing::debug;

use crate::{
    circom::{ast::Function, parse_function},
    circuit::{
        CircuitError,
        circuit::Circuit,
        interpreter::execute_function,
        value::{Value, ValueError},
    },
};

/// Runtime context for witness generation.
///
/// Manages the circuit, current witness values, variable scopes, and component
/// triggering logic.  Based on snarkjs's `src/calculateWitness.js::RTCtx` class.
pub struct RTCtx<'a> {
    pub circuit: &'a Circuit,
    pub witness: Vec<Option<Fr>>,
    pub not_init_signals: Vec<i64>,
    pub current_component: Option<String>,

    scopes: Vec<FxHashMap<String, Value>>,

    // Components whose last input was set from inside another component's body. They run once that body is
    // done (`drain`), so a long chain of components is a loop here and not a call stack as deep as the chain.
    pending: VecDeque<usize>,

    templates: FxHashMap<String, Rc<Function>>,
    #[allow(dead_code)]
    functions: FxHashMap<String, Rc<Function>>,
}

impl<'a> RTCtx<'a> {
    pub fn new(circuit: &'a Circuit) -> Result<Self, CircuitError> {
        let n_signals = circuit.n_signals;
        #[allow(clippy::cast_possible_wrap)]
        let not_init_signals = circuit
            .components
            .iter()
            .map(|c| c.input_signals as i64)
            .collect();

        let templates = circuit
            .templates
            .iter()
            .map(|(k, v)| {
                let func = parse_function(v).map_err(|e| CircuitError::ParseError {
                    source: e,
                    function: k.clone(),
                })?;
                Ok((k.clone(), Rc::new(func)))
            })
            .collect::<Result<_, CircuitError>>()?;

        let functions = circuit
            .functions
            .iter()
            .map(|(k, v)| {
                let func = parse_function(&v.func).map_err(|e| CircuitError::ParseError {
                    source: e,
                    function: k.clone(),
                })?;
                Ok((k.clone(), Rc::new(func)))
            })
            .collect::<Result<_, CircuitError>>()?;

        Ok(Self {
            circuit,
            witness: vec![None; n_signals],
            not_init_signals,
            current_component: None,
            scopes: vec![FxHashMap::default()],
            pending: VecDeque::new(),
            templates,
            functions,
        })
    }

    pub fn set_signal(
        &mut self,
        name: &str,
        selectors: Vec<u32>,
        value: Fr,
    ) -> Result<(), CircuitError> {
        let full = self.build_signal_name(name, selectors)?;
        self.set_signal_full(&full, value, true)
    }

    pub fn get_signal(&self, name: &str, selectors: Vec<u32>) -> Result<Fr, CircuitError> {
        let full = self.build_signal_name(name, selectors)?;
        self.get_signal_full(&full)
    }

    pub fn set_pin(
        &mut self,
        component_name: &str,
        component_sels: Vec<u32>,
        signal_name: &str,
        signal_sels: Vec<u32>,
        value: Fr,
    ) -> Result<(), CircuitError> {
        let full = self.build_pin_name(component_name, component_sels, signal_name, signal_sels)?;
        // A component whose last input this is runs now, and so does everything its outputs set off: the
        // statement after this one may read them.
        self.set_signal_full(&full, value, false)?;
        self.drain()
    }

    pub fn get_pin(
        &self,
        component_name: &str,
        component_sels: Vec<u32>,
        signal_name: &str,
        signal_sels: Vec<u32>,
    ) -> Result<Fr, CircuitError> {
        let full = self.build_pin_name(component_name, component_sels, signal_name, signal_sels)?;
        self.get_signal_full(&full)
    }

    pub fn set_var(
        &mut self,
        name: &str,
        selectors: &[u32],
        value: Value,
    ) -> Result<Value, CircuitError> {
        let scope = self
            .scopes
            .last_mut()
            .ok_or(CircuitError::RuntimeError("No active scope".to_string()))?;

        if selectors.is_empty() {
            scope.insert(name.to_string(), value.clone());
            return Ok(value);
        }

        let entry = scope
            .entry(name.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let Value::Array(arr) = entry else {
            return Err(CircuitError::RuntimeError(format!(
                "Variable is not an array: {name}"
            )));
        };
        set_var_array(arr, selectors, value.clone());
        Ok(value)
    }

    pub fn get_var(&self, name: &str, selectors: &[u32]) -> Result<Value, CircuitError> {
        for scope in self.scopes.iter().rev() {
            if let Some(v) = scope.get(name) {
                return select(v, selectors).cloned();
            }
        }
        Err(CircuitError::RuntimeError(format!(
            "Variable not defined: {name}"
        )))
    }

    #[allow(clippy::unused_self)]
    pub fn call_function(&self, _name: &str, _args: &[Value]) -> Result<Value, CircuitError> {
        Err(CircuitError::RuntimeError(
            "call_function is not supported yet".to_string(),
        ))
    }

    pub fn trigger_component(&mut self, c: usize) -> Result<(), CircuitError> {
        self.not_init_signals[c] -= 1;
        self.run_component(c)
    }

    /// Runs every component set off from inside another's body, each of which may set off more.
    pub fn drain(&mut self) -> Result<(), CircuitError> {
        while let Some(c) = self.pending.pop_front() {
            self.run_component(c)?;
        }
        Ok(())
    }

    fn run_component(&mut self, c: usize) -> Result<(), CircuitError> {
        debug!("component triggered: {}", self.circuit.components[c].name);

        // Push new scope for this component
        let component = &self.circuit.components[c];
        let new_component = Some(component.name.clone());
        let old_component = std::mem::replace(&mut self.current_component, new_component);

        let new_scope = component.params.clone();
        let first_scope = self.scopes.first().cloned().unwrap_or_default();
        let new_scope = vec![first_scope, new_scope];
        let old_scope = std::mem::replace(&mut self.scopes, new_scope);

        let func = self
            .templates
            .get(&component.template)
            .ok_or_else(|| {
                CircuitError::RuntimeError(format!(
                    "Template not defined: {} for component {}",
                    component.template, component.name
                ))
            })?
            .clone();
        execute_function(self, &func)?;

        // Restore old component and scope
        self.scopes = old_scope;
        self.current_component = old_component;
        debug!("component finished: {}", self.circuit.components[c].name);
        Ok(())
    }

    fn build_signal_name(&self, name: &str, selectors: Vec<u32>) -> Result<String, CircuitError> {
        let mut s = if let Some(current) = &self.current_component {
            format!("{current}.{name}")
        } else {
            name.to_string()
        };
        append_selectors(&mut s, selectors)?;
        Ok(s)
    }

    fn build_pin_name(
        &self,
        component_name: &str,
        component_sels: Vec<u32>,
        signal_name: &str,
        signal_sels: Vec<u32>,
    ) -> Result<String, CircuitError> {
        let mut s = if component_name == "one" {
            "one".to_string()
        } else if let Some(current) = &self.current_component {
            format!("{current}.{component_name}")
        } else {
            component_name.to_string()
        };
        append_selectors(&mut s, component_sels)?;
        s.push('.');
        s.push_str(signal_name);
        append_selectors(&mut s, signal_sels)?;
        Ok(s)
    }

    fn signal_idx(&self, full: &str) -> Result<usize, CircuitError> {
        if let Some(&idx) = self.circuit.signal_name2_idx.get(full) {
            return Ok(idx);
        }
        full.parse::<usize>()
            .map_err(|e| CircuitError::RuntimeError(format!("Invalid signal index: {e}")))
    }

    fn get_signal_full(&self, full: &str) -> Result<Fr, CircuitError> {
        // tracing::trace!("get {full}");
        let s_id = self.signal_idx(full)?;
        self.witness[s_id].ok_or_else(|| CircuitError::SignalNotAssigned(full.to_string()))
    }

    fn set_signal_full(&mut self, full: &str, value: Fr, defer: bool) -> Result<(), CircuitError> {
        // tracing::trace!("set {full} = {value}");
        let s_id = self.signal_idx(full)?;
        let first_init = self.witness[s_id].is_none();
        self.witness[s_id] = Some(value);

        let mut to_trigger = Vec::new();
        let trigs = self.circuit.signals[s_id].trigger_components.clone();
        for &c in &trigs {
            if first_init {
                self.not_init_signals[c] -= 1;
            }
            to_trigger.push(c);
        }

        for c in to_trigger {
            if self.not_init_signals[c] == 0 {
                if defer {
                    // counted as started now, so a second set of one of its inputs cannot queue it again
                    self.not_init_signals[c] -= 1;
                    self.pending.push_back(c);
                } else {
                    self.trigger_component(c)?;
                }
            }
        }

        Ok(())
    }

    #[allow(clippy::unused_self)]
    pub fn assert_eq(&self, a: &Fr, b: &Fr, err: &str) -> Result<(), CircuitError> {
        if a != b {
            return Err(CircuitError::AssertionFailed(
                Box::new(*a),
                Box::new(*b),
                err.to_string(),
            ));
        }
        Ok(())
    }
}

fn set_var_array(a: &mut Vec<Value>, sels: &[u32], value: Value) {
    let idx = sels[0] as usize;
    while a.len() <= idx {
        a.push(0u64.into());
    }
    if sels.len() == 1 {
        a[idx] = value;
        return;
    }
    if !matches!(a[idx], Value::Array(_)) {
        a[idx] = Value::Array(Vec::new());
    }
    let Value::Array(nested) = &mut a[idx] else {
        unreachable!()
    };
    set_var_array(nested, &sels[1..], value);
}

fn select<'a>(a: &'a Value, sels: &[u32]) -> Result<&'a Value, CircuitError> {
    if sels.is_empty() {
        return Ok(a);
    }
    let Value::Array(arr) = a else {
        return Err(CircuitError::ValueError(ValueError::ExpectedArray));
    };
    let idx = sels[0] as usize;
    let next = arr
        .get(idx)
        .ok_or(CircuitError::ValueError(ValueError::ValueOutOfRange))?;
    select(next, &sels[1..])
}

fn append_selectors(out: &mut String, selectors: Vec<u32>) -> Result<(), CircuitError> {
    for s in selectors {
        write!(out, "[{s}]")
            .map_err(|e| CircuitError::RuntimeError(format!("Failed to build signal name: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn circuit() -> Circuit {
        let data = include_str!("../testdata/withdraw.json");
        serde_json::from_str(data).unwrap()
    }

    fn num(n: u64) -> Value {
        Value::from(n)
    }

    #[test]
    fn full_name_signal() {
        let c = circuit();
        let mut ctx = RTCtx::new(&c).unwrap();

        ctx.current_component = Some("main".to_string());
        assert_eq!(ctx.build_signal_name("root", vec![]).unwrap(), "main.root");
        assert_eq!(
            ctx.build_signal_name("out", vec![3]).unwrap(),
            "main.out[3]"
        );
        assert_eq!(
            ctx.build_signal_name("x", vec![1, 2]).unwrap(),
            "main.x[1][2]"
        );
    }

    #[test]
    fn full_name_pin() {
        let c = circuit();
        let mut ctx = RTCtx::new(&c).unwrap();

        ctx.current_component = Some("main".to_string());
        assert_eq!(
            ctx.build_pin_name("one", vec![], "x", vec![]).unwrap(),
            "one.x"
        );
        assert_eq!(
            ctx.build_pin_name("hasher", vec![], "in", vec![5]).unwrap(),
            "main.hasher.in[5]"
        );
    }

    #[test]
    fn set_one_signal_and_get_back() {
        let c = circuit();
        let mut ctx = RTCtx::new(&c).unwrap();

        ctx.set_signal("one", vec![], Fr::from(1u64)).unwrap();
        assert_eq!(ctx.get_signal("one", vec![]).unwrap(), Fr::from(1u64));
    }

    #[test]
    fn not_init_signals_starts_at_input_count() {
        let c = circuit();
        let ctx = RTCtx::new(&c).unwrap();

        assert_eq!(
            ctx.not_init_signals[0],
            i64::try_from(ctx.circuit.components[0].input_signals).unwrap(),
        );
    }

    #[test]
    fn set_get_var_scalar() {
        let c = circuit();
        let mut ctx = RTCtx::new(&c).unwrap();

        ctx.set_var("x", &[], num(42)).unwrap();
        assert_eq!(ctx.get_var("x", &[]).unwrap(), num(42));
    }

    #[test]
    fn set_get_var_indexed() {
        let c = circuit();
        let mut ctx = RTCtx::new(&c).unwrap();

        ctx.set_var("x", &[2], num(7)).unwrap();
        assert_eq!(ctx.get_var("x", &[2]).unwrap(), num(7));
        assert_eq!(ctx.get_var("x", &[0]).unwrap(), num(0));
        assert_eq!(ctx.get_var("x", &[1]).unwrap(), num(0));
    }

    #[test]
    fn set_get_var_nested() {
        let c = circuit();
        let mut ctx = RTCtx::new(&c).unwrap();

        ctx.set_var("x", &[1, 2], num(9)).unwrap();
        assert_eq!(ctx.get_var("x", &[1, 2]).unwrap(), num(9));
        assert_eq!(
            ctx.get_var("x", &[]).unwrap(),
            Value::Array(vec![num(0), Value::Array(vec![num(0), num(0), num(9)]),])
        );
    }

    #[test]
    fn get_var_falls_back_to_outer_scope() {
        let c = circuit();
        let mut ctx = RTCtx::new(&c).unwrap();

        ctx.set_var("x", &[], num(5)).unwrap();
        ctx.scopes.push(FxHashMap::default());
        assert_eq!(ctx.get_var("x", &[]).unwrap(), num(5));
    }

    #[test]
    fn set_var_shadows_outer_scope() {
        let c = circuit();
        let mut ctx = RTCtx::new(&c).unwrap();

        ctx.set_var("x", &[], num(5)).unwrap();
        ctx.scopes.push(FxHashMap::default());
        ctx.set_var("x", &[], num(10)).unwrap();
        assert_eq!(ctx.get_var("x", &[]).unwrap(), num(10));
        ctx.scopes.pop();
        assert_eq!(ctx.get_var("x", &[]).unwrap(), num(5));
    }

    #[test]
    fn get_var_undefined_errors() {
        let c = circuit();
        let ctx = RTCtx::new(&c).unwrap();

        assert!(ctx.get_var("nope", &[]).is_err());
    }
}
