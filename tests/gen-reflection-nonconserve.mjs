#!/usr/bin/env node
// REFLECT-1 negative-test fixture: derive a NON-CONSERVING reflection input from the pinned
// reflection_input.json by emptying the prior live set (so the cxfer detects 0 pool inputs ⇒
// Σ C_in = 0 ≠ its multi-input kernel ⇒ conservation fails) and stripping the cxfer's effects to a
// SKIP-stream (no spends, no output witnesses). Running the PINNED reflection ELF over this via
// contracts/sp1/reflect-exec must EXECUTE_OK — i.e. the guest SKIPS the non-conserving cxfer rather
// than reading the (absent) output witnesses. A guest that did NOT enforce conservation would try to
// read them and PANIC. This is the positive evidence that gates BRIDGE (readiness-gate.sh layer 9):
//
//   node tests/gen-reflection-nonconserve.mjs > /tmp/refl_nonconserve.json
//   ( cd contracts/sp1/reflect-exec && cargo run --release --bin reflect-execute -- /tmp/refl_nonconserve.json )
//   # EXECUTE_OK  → the pinned guest skips a non-conserving CXFER (conservation enforced) → allowlist its vkey
//   # execute failed → the pinned guest read the outputs (no enforcement) → keep it BLOCKED

import { readFileSync } from 'node:fs';

const src = new URL('../contracts/sp1/confidential/fixtures/reflection_input.json', import.meta.url);
const f = JSON.parse(readFileSync(src));
f.prior.live = [];
f.prior.liveCount = 0;
for (const b of (f.blocks || [])) for (const t of (b.txs || [])) { t.openings = []; t.spentInserts = []; t.burnInsert = null; t.outputs = []; }
delete f.newDigest; // the new digest is the skip result; we assert EXECUTE_OK, not a specific digest
process.stdout.write(JSON.stringify(f));
