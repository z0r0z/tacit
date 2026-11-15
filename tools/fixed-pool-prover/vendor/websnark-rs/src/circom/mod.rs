//! Parses and executes `CircomV1` function definitions.
//!
//! `CircomV1` witness generation involves snarkJS `exec`-ing runtime Javascript
//! code from the witness.json files. This module provides a Rust implementation
//! that parses and interprets the function definitions, allowing us to generate
//! witnesses without any JS engines.

lalrpop_util::lalrpop_mod!(
    #[allow(clippy::all, clippy::pedantic, clippy::unwrap_used)]
    grammer,
    "circom/grammer.rs"
);
pub mod ast;

#[derive(thiserror::Error, Debug)]
#[error("parse error: {0}")]
pub struct ParseError(#[from] lalrpop_util::ParseError<usize, String, String>);

/// Parses a Circom function definition from the given input string and returns
/// an AST representation of it.
pub fn parse_function(input: &str) -> Result<ast::Function, ParseError> {
    // snarkjs (`@tornado/snarkjs/src/circuit.js`) emits `return foo();;` with a
    // double semicolon after returns.
    let input = input.replace(";;", ";");
    grammer::FunctionParser::new().parse(&input).map_err(|e| {
        ParseError(
            e.map_token(|t| t.to_string())
                .map_error(std::string::ToString::to_string),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_all() {
        let raw = include_str!("../testdata/withdraw.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();

        let templates = v["templates"].as_object().expect("templates object");
        for (name, src) in templates {
            let src = src.as_str().expect("template source is string");
            if let Err(e) = parse_function(src) {
                panic!("template {name}: {e}");
            }
        }

        let functions = v["functions"].as_object().expect("functions object");
        for (name, def) in functions {
            let src = def["func"].as_str().expect("function source is string");
            if let Err(e) = parse_function(src) {
                panic!("function {name}: {e}");
            }
        }
    }
}
