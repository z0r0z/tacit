//! JSON-RPC over a list of nodes: each request goes to the first node that answers it, trying the next on an error.

use serde_json::{json, Value};
use std::time::Duration;

pub struct Rpc {
    nodes: Vec<String>,
    agent: ureq::Agent,
}

impl Rpc {
    pub fn new(nodes: &str) -> Self {
        let nodes = nodes.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
        assert!(!nodes.is_empty(), "no nodes");
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();
        Rpc { nodes, agent }
    }

    fn post(&self, node: &str, body: &Value) -> Result<Value, String> {
        let r = self
            .agent
            .post(node)
            .set("content-type", "application/json")
            .send_json(body.clone())
            .map_err(|e| format!("{node}: {e}"))?;
        r.into_json::<Value>().map_err(|e| format!("{node}: {e}"))
    }

    /// One call; tries each node in turn, three rounds, with a pause between rounds.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let mut last = String::new();
        for round in 0..3 {
            for node in &self.nodes {
                match self.post(node, &body) {
                    Ok(v) if v.get("result").is_some() => return Ok(v["result"].clone()),
                    Ok(v) => last = format!("{node}: {}", v.get("error").unwrap_or(&v)),
                    Err(e) => last = e,
                }
            }
            std::thread::sleep(Duration::from_millis(800 * (round + 1)));
        }
        Err(format!("{method}: {last}"))
    }

    /// Several calls in one request, results in order; falls back to one call each when a node refuses the batch.
    pub fn batch(&self, calls: &[(&str, Value)]) -> Result<Vec<Value>, String> {
        let body: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(i, (m, p))| json!({"jsonrpc": "2.0", "id": i, "method": m, "params": p}))
            .collect();
        let body = Value::Array(body);
        for node in &self.nodes {
            let Ok(Value::Array(rs)) = self.post(node, &body) else { continue };
            let mut out = vec![Value::Null; calls.len()];
            let mut ok = rs.len() == calls.len();
            for r in &rs {
                match (r.get("id").and_then(Value::as_u64), r.get("result")) {
                    (Some(i), Some(v)) if (i as usize) < out.len() && !v.is_null() => out[i as usize] = v.clone(),
                    _ => ok = false,
                }
            }
            if ok {
                return Ok(out);
            }
        }
        calls.iter().map(|(m, p)| self.call(m, p.clone())).collect()
    }

    /// eth_call `data` on `to` at `block` ("latest" or a number).
    pub fn eth_call(&self, to: &str, data: &[u8], block: &str) -> Result<Vec<u8>, String> {
        let r = self.call("eth_call", json!([{"to": to, "data": format!("0x{}", hex::encode(data))}, block]))?;
        hex::decode(r.as_str().unwrap_or_default().trim_start_matches("0x")).map_err(|e| e.to_string())
    }
}
