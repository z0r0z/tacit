# vendor

`websnark-rs` 0.8.0 (MIT, https://github.com/Robert-MacWha/websnark-rs), copied from crates.io with its benches
removed and one change, in `src/circuit/rt_ctx.rs` and `src/circuit/circuit.rs`.

The circuit's witness is made by running its components: each runs as soon as its last input is set. That call
happened inside the call that set the input, so a chain of dependent components (the pool circuit's hash
windows) became a call stack hundreds of components deep, more than a browser worker's stack. Now a component
set off by a signal assignment inside another's body is queued and run, in order, when that body ends or when
a parent's pin assignment returns (`RTCtx::drain`), and a pin assignment still runs what it sets off before
the next statement. The witness is the same; the proof it gives is checked by the pool.
