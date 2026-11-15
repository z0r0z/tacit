use ark_bn254::Fr;

#[derive(Debug, Clone)]
pub struct Function {
    pub body: Vec<Stmt>,
}

#[derive(Debug, Clone)]
pub enum Stmt {
    Block(Vec<Stmt>),
    Expr(Expr),
    Assert {
        lhs: Expr,
        rhs: Expr,
        loc: String,
    },
    If {
        cond: Expr,
        then: Box<Stmt>,
        else_: Option<Box<Stmt>>,
    },
    While {
        cond: Expr,
        body: Box<Stmt>,
    },
    For {
        init: Expr,
        cond: Expr,
        update: Expr,
        body: Box<Stmt>,
    },
    Return(Expr),
}

#[derive(Debug, Clone, Copy)]
pub enum BinOpKind {
    Add,
    Sub,
    Mul,
    Mod,
    Div,
    Eq,
    Neq,
    Lt,
    Gt,
    Shl,
    Shr,
    And,
}

#[derive(Debug, Clone)]
pub enum Expr {
    NumberLit(Fr),
    PrimeConst, // __P__
    MaskConst,  // __MASK__
    ArrayLit(Vec<Expr>),

    // ctx.* methods
    GetSignal(String, Vec<Expr>),
    GetPin(String, Vec<Expr>, String, Vec<Expr>),
    GetVar(String, Vec<Expr>),
    SetSignal(String, Vec<Expr>, Box<Expr>),
    SetVar(String, Vec<Expr>, Box<Expr>),
    SetPin(String, Vec<Expr>, String, Vec<Expr>, Box<Expr>),
    CallFunction(String, Vec<Expr>),

    // BigInt operations
    BinOp {
        op: BinOpKind,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    Inverse(Box<Expr>, Box<Expr>),
    ModPow(Box<Expr>, Box<Expr>, Box<Expr>),

    // JS short-circuit ||
    LogicalOr(Box<Expr>, Box<Expr>),

    // Control flow
    Ternary {
        cond: Box<Expr>,
        then: Box<Expr>,
        else_: Box<Expr>,
    },
}
