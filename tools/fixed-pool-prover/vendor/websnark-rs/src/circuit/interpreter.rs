use ark_bn254::Fr;
use ark_ff::{AdditiveGroup, Field};

use crate::{
    circom::ast::{BinOpKind, Expr, Function, Stmt},
    circuit::{
        CircuitError, Value,
        rt_ctx::RTCtx,
        value::{bigint_to_fr, fr_to_bigint, fr_to_u32},
    },
};

/// Executes a function and returns its return value, or zero if it doesn't return anything.
pub fn execute_function(ctx: &mut RTCtx, func: &Function) -> Result<Value, CircuitError> {
    Ok(execute_block(ctx, &func.body)?.unwrap_or(0u64.into()))
}

/// Executes a statement, returning its return value if it has one, or None otherwise.
fn execute_stmt(ctx: &mut RTCtx, stmt: &Stmt) -> Result<Option<Value>, CircuitError> {
    match stmt {
        Stmt::Block(statements) => execute_block(ctx, statements),
        Stmt::Expr(expr) => {
            execute_expr(ctx, expr)?;
            Ok(None)
        }
        Stmt::Assert { lhs, rhs, loc } => {
            let a = execute_scalar_expr(ctx, lhs)?;
            let b = execute_scalar_expr(ctx, rhs)?;
            ctx.assert_eq(&a, &b, loc)?;
            Ok(None)
        }
        Stmt::If { cond, then, else_ } => {
            if is_truthy(execute_scalar_expr(ctx, cond)?) {
                execute_stmt(ctx, then)
            } else if let Some(else_) = else_ {
                execute_stmt(ctx, else_)
            } else {
                Ok(None)
            }
        }
        Stmt::While { cond, body } => {
            while is_truthy(execute_scalar_expr(ctx, cond)?) {
                if let Some(v) = execute_stmt(ctx, body)? {
                    return Ok(Some(v));
                }
            }
            Ok(None)
        }
        Stmt::For {
            init,
            cond,
            update,
            body,
        } => {
            execute_expr(ctx, init)?;
            while is_truthy(execute_scalar_expr(ctx, cond)?) {
                if let Some(v) = execute_stmt(ctx, body)? {
                    return Ok(Some(v));
                }
                execute_expr(ctx, update)?;
            }
            Ok(None)
        }
        Stmt::Return(expr) => {
            let value = execute_expr(ctx, expr)?;
            Ok(Some(value))
        }
    }
}

/// Evaluates a polymorphic `Expr` to a `Value`.
fn execute_expr(ctx: &mut RTCtx, expr: &Expr) -> Result<Value, CircuitError> {
    match expr {
        Expr::ArrayLit(arr) => Ok(Value::Array(execute_exprs(ctx, arr)?)),
        Expr::GetVar(name, sels) => {
            let sels = execute_selectors(ctx, sels)?;
            ctx.get_var(name, &sels)
        }
        Expr::SetVar(name, sels, value) => {
            let sels = execute_selectors(ctx, sels)?;
            let value = execute_expr(ctx, value)?;
            ctx.set_var(name, &sels, value.clone())?;
            Ok(value)
        }
        Expr::CallFunction(name, args) => {
            let args = execute_exprs(ctx, args)?;
            ctx.call_function(name, &args)
        }
        Expr::Ternary { cond, then, else_ } => {
            if is_truthy(execute_scalar_expr(ctx, cond)?) {
                execute_expr(ctx, then)
            } else {
                execute_expr(ctx, else_)
            }
        }
        _ => Ok(execute_scalar_expr(ctx, expr)?.into()),
    }
}

/// Executes a scalar expression and returns its value as an `Fr`. Since we know the
/// expression is scalar, we can avoid constructing `Value` and the associated overhead.
///
/// Falls back to `execute_expr` for non-scalar expressions.
#[allow(clippy::too_many_lines)]
fn execute_scalar_expr(ctx: &mut RTCtx, expr: &Expr) -> Result<Fr, CircuitError> {
    match expr {
        Expr::NumberLit(fr) => Ok(*fr),
        //? p == 0 (mod p), which is correct for Fr-native ops.
        Expr::PrimeConst => Ok(Fr::ZERO),
        //? MASK > prime, so it can't be represented as an Fr; only valid as And's rhs (below).
        Expr::MaskConst => Err(CircuitError::RuntimeError(
            "MaskConst used outside of And".to_string(),
        )),
        Expr::GetSignal(name, sels) => {
            let sels = execute_selectors(ctx, sels)?;
            ctx.get_signal(name, sels)
        }
        Expr::GetPin(component_name, component_sels, signal_name, signal_sels) => {
            let component_sels = execute_selectors(ctx, component_sels)?;
            let signal_sels = execute_selectors(ctx, signal_sels)?;
            ctx.get_pin(component_name, component_sels, signal_name, signal_sels)
        }
        Expr::SetSignal(name, sels, value) => {
            let sels = execute_selectors(ctx, sels)?;
            let value = execute_scalar_expr(ctx, value)?;
            ctx.set_signal(name, sels, value)?;
            Ok(value)
        }
        Expr::SetPin(component_name, component_sels, signal_name, signal_sels, value) => {
            let component_sels = execute_selectors(ctx, component_sels)?;
            let signal_sels = execute_selectors(ctx, signal_sels)?;
            let value = execute_scalar_expr(ctx, value)?;
            ctx.set_pin(
                component_name,
                component_sels,
                signal_name,
                signal_sels,
                value,
            )?;
            Ok(value)
        }
        //? lhs is already reduced mod p, so this is a no-op (see Inverse/ModPow).
        Expr::BinOp {
            op: BinOpKind::Mod,
            lhs,
            rhs,
        } => {
            debug_assert!(matches!(rhs.as_ref(), Expr::PrimeConst));
            execute_scalar_expr(ctx, lhs)
        }
        //? MASK == 2^254 - 1 and every valid Fr value is < prime < 2^254, so this is a no-op.
        Expr::BinOp {
            op: BinOpKind::And,
            lhs,
            rhs,
        } if matches!(rhs.as_ref(), Expr::MaskConst) => execute_scalar_expr(ctx, lhs),
        Expr::BinOp { op, lhs, rhs } => {
            let lhs = execute_scalar_expr(ctx, lhs)?;
            let rhs = execute_scalar_expr(ctx, rhs)?;

            match op {
                BinOpKind::Add => Ok(lhs + rhs),
                BinOpKind::Sub => Ok(lhs - rhs),
                BinOpKind::Mul => Ok(lhs * rhs),
                BinOpKind::Mod => unreachable!("handled above"),
                BinOpKind::Div => {
                    let lhs = fr_to_bigint(lhs);
                    let rhs = fr_to_bigint(rhs);
                    Ok(bigint_to_fr(&(lhs / rhs)))
                }
                BinOpKind::Eq => Ok(Fr::from(u64::from(lhs == rhs))),
                BinOpKind::Neq => Ok(Fr::from(u64::from(lhs != rhs))),
                BinOpKind::Lt => Ok(Fr::from(u64::from(lhs < rhs))),
                BinOpKind::Gt => Ok(Fr::from(u64::from(lhs > rhs))),
                BinOpKind::And => {
                    let lhs = fr_to_bigint(lhs);
                    let rhs = fr_to_bigint(rhs);
                    Ok(bigint_to_fr(&(lhs & rhs)))
                }
                BinOpKind::Shl => {
                    let lhs = fr_to_bigint(lhs);
                    let n = fr_to_u32(rhs)?;
                    Ok(bigint_to_fr(&(lhs << n)))
                }
                BinOpKind::Shr => {
                    let lhs = fr_to_bigint(lhs);
                    let n = fr_to_u32(rhs)?;
                    Ok(bigint_to_fr(&(lhs >> n)))
                }
            }
        }
        Expr::Inverse(base, modulos) => {
            debug_assert!(matches!(modulos.as_ref(), Expr::PrimeConst));
            let base = execute_scalar_expr(ctx, base)?;
            base.inverse().ok_or(CircuitError::InvalidInverse)
        }
        Expr::ModPow(base, exp, modulos) => {
            debug_assert!(matches!(modulos.as_ref(), Expr::PrimeConst));
            let base = execute_scalar_expr(ctx, base)?;
            let exp = fr_to_u32(execute_scalar_expr(ctx, exp)?)?;
            Ok(base.pow([u64::from(exp)]))
        }
        Expr::LogicalOr(lhs, rhs) => {
            let lhs = execute_scalar_expr(ctx, lhs)?;
            if is_truthy(lhs) {
                return Ok(lhs);
            }
            execute_scalar_expr(ctx, rhs)
        }
        Expr::ArrayLit(_)
        | Expr::GetVar(..)
        | Expr::SetVar(..)
        | Expr::CallFunction(..)
        | Expr::Ternary { .. } => execute_expr(ctx, expr)?.into_fr().map_err(Into::into),
    }
}

/// Executes a block of statements and returns the value of the first return statement, if any.
fn execute_block(ctx: &mut RTCtx, stmts: &[Stmt]) -> Result<Option<Value>, CircuitError> {
    for s in stmts {
        if let Some(v) = execute_stmt(ctx, s)? {
            return Ok(Some(v));
        }
    }
    Ok(None)
}

/// Executes a list of expressions and returns their results.
fn execute_exprs(ctx: &mut RTCtx, exprs: &[Expr]) -> Result<Vec<Value>, CircuitError> {
    let mut res = Vec::with_capacity(exprs.len());
    for expr in exprs {
        res.push(execute_expr(ctx, expr)?);
    }
    Ok(res)
}

/// Executes a list of selector/index expressions (always scalar in circom).
fn execute_selectors(ctx: &mut RTCtx, exprs: &[Expr]) -> Result<Vec<u32>, CircuitError> {
    let mut res = Vec::with_capacity(exprs.len());
    for expr in exprs {
        res.push(fr_to_u32(execute_scalar_expr(ctx, expr)?)?);
    }
    Ok(res)
}

/// Returns true if the given value is "truthy" (not zero).
fn is_truthy(f: Fr) -> bool {
    f != Fr::ZERO
}
