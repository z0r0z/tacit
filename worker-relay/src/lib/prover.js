// Spawn the prebuilt Rust prover binaries in NETWORK mode (Succinct), read back
// the hex artifacts. This replaces the GPU box's `cargo run` + sp1-gpu-server with
// a network prove: the binaries were built with the SP1 SDK's .network() path, so
// they need no local GPU — only SP1_PROVER=network + a funded NETWORK_PRIVATE_KEY.
//
// The GPU box remains a drop-in fallback: point BITCOIN_PROVE_BIN / EXEC_BIN at a
// box-built binary and unset SP1_PROVER to prove locally instead (see README).

import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { keccak256 } from 'viem';
import { CFG } from './config.js';

function proverEnv(extra = {}) {
  // Env the spawned SP1 binary reads to route to the Succinct network prover.
  const env = {
    ...process.env,
    SP1_PROVER: CFG.sp1Prover, // 'network'
    NETWORK_RPC_URL: CFG.networkRpcUrl,
    PROVER_OUT: CFG.proverOut,
    ...extra,
  };
  if (CFG.networkPrivateKey) env.NETWORK_PRIVATE_KEY = CFG.networkPrivateKey;
  return env;
}

// Run a binary with a hard timeout; resolve with {code} or reject on timeout/spawn error.
function run(bin, { env, cwd, timeoutMs, tag }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = timeoutMs
      ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${tag} timed out after ${timeoutMs}ms`)); }, timeoutMs)
      : null;
    child.stdout.on('data', (d) => { out += d; process.stdout.write(`[${tag}] ${d}`); });
    child.stderr.on('data', (d) => { err += d; process.stderr.write(`[${tag}] ${d}`); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out, err }); });
  });
}

async function readHex(p) {
  const raw = (await readFile(p, 'utf8')).trim();
  return raw.startsWith('0x') ? raw : `0x${raw}`;
}

// ── Reflection: bitcoin_prove (eth-reflection prover-host) ──
// Writes the assembled reflection input to REFLECT_FIXTURE, spawns the binary in
// forward groth16 mode (single-ELF, no eth recursion — the always-on incremental attest),
// returns { publicValues, proofBytes }. Mode-B (reverse-bridge) recursion is left to the
// dedicated modeb path; this worker keeps forward reflection INCREMENTAL (1-2 blocks).
export async function proveReflection(input) {
  await mkdir(CFG.fixtureDir, { recursive: true });
  await mkdir(CFG.proverOut, { recursive: true });
  const fixture = path.join(CFG.fixtureDir, 'reflection_input.json');
  await writeFile(fixture, JSON.stringify(input));
  await rm(path.join(CFG.proverOut, 'bitcoin_proof_bytes.hex'), { force: true });

  const { code, out } = await run(CFG.bitcoinProveBin, {
    env: proverEnv({ PROOF_MODE: 'groth16', REFLECT_FIXTURE: fixture }),
    cwd: CFG.proverOut,
    tag: 'bitcoin_prove',
  });
  // The GPU client can panic in a cleanup destructor AFTER writing artifacts; treat a
  // fresh proof file as success regardless of exit code (mirrors reflection-relay-loop.sh).
  const pvPath = path.join(CFG.proverOut, 'bitcoin_pv.hex');
  const pbPath = path.join(CFG.proverOut, 'bitcoin_proof_bytes.hex');
  try {
    const publicValues = await readHex(pvPath);
    const proofBytes = await readHex(pbPath);
    return { publicValues, proofBytes };
  } catch (e) {
    throw new Error(`bitcoin_prove produced no proof (code=${code}): ${e.message}\n${out.slice(-2000)}`);
  }
}

// ── Settle: exec harness ──
// Writes the op JSON to OP_FILE, spawns the exec bin (MODE=groth16, network prove),
// returns { publicValues, proof }. A per-job timeout guards the FIFO.
export async function proveSettle({ type, op, memos = [], timeoutMs }) {
  await mkdir(CFG.fixtureDir, { recursive: true });
  const opFile = path.join(CFG.fixtureDir, `${type}_op.json`);
  // The guest commits to keccak256(memo) per emitted leaf; settle() then passes the real memos and the
  // contract re-checks them (else MemoLeafMismatch). Compute the real memo hashes so the harness feeds THOSE
  // (not the placeholder empty hashes) — the on-chain memos then match what the proof committed to.
  // The guest reads (leaves + lock_leaves) memo hashes AFTER the last op, so for a batch they must be the
  // concatenation of every op's memos in the SAME order the ops are written — otherwise memoRoot is computed
  // over a different ordering than settle() supplies and the contract rejects it.
  const memoHashes = (memos || []).map((m) => keccak256(m.startsWith('0x') ? m : `0x${m}`));
  await writeFile(opFile, JSON.stringify({ ...op, memoHashes }));
  const cwd = CFG.proverOut;
  await mkdir(cwd, { recursive: true });
  await rm(path.join(cwd, 'public_values.hex'), { force: true });
  await rm(path.join(cwd, 'proof_bytes.hex'), { force: true });

  // Each confidential op is a SINGLE-op SP1 binary (exec-<type>) that reads OP_FILE and proves that one op —
  // there is no unified OP_TYPE-dispatching `exec` deployed. Map the relay type to its binary; if a type has
  // no built binary yet, fail clearly rather than invoking the wrong prover.
  // Relay op type → its single-op network prover binary (names per the canonical harness_for map).
  const PEROP = {
    wrap: 'exec-wrap', transfer: 'exec-prove', batchtransfer: 'exec-batchtransfer', wraplp: 'exec-wraplp', wrapswap: 'exec-wrapswap', swap: 'exec-swap', unwrap: 'exec-unwrap', lp: 'exec-lp', lpremove: 'exec-lpremove',
    wraptransfer: 'exec-wraptransfer', sendunwrap: 'exec-sendunwrap', otc: 'exec-otc', route: 'exec-route', bid: 'exec-bid',
    bridgeburn: 'exec-bridgeburn', bridgemint: 'exec-bridgemint', cbtcmint: 'exec-cbtcmint',
    cdpmint: 'exec-cdpmint', cdpclose: 'exec-cdpclose',
  };
  const binName = PEROP[type];
  if (!binName) throw new Error(`exec:${type} — no prover binary deployed for this op (have: ${Object.keys(PEROP).join(', ')})`);
  const bin = path.join(path.dirname(CFG.execBin), binName);

  const { code, out } = await run(bin, {
    // The per-op binary proves its own op from OP_FILE; OP_TYPE is passed for forward-compat with a future
    // unified dispatcher but ignored by the single-op binaries.
    env: proverEnv({ MODE: 'groth16', OP_TYPE: type, OP_FILE: opFile }),
    cwd,
    timeoutMs,
    tag: `exec:${type}`,
  });
  try {
    const publicValues = await readHex(path.join(cwd, 'public_values.hex'));
    const proof = await readHex(path.join(cwd, 'proof_bytes.hex'));
    return { publicValues, proof };
  } catch (e) {
    throw new Error(`exec:${type} produced no proof (code=${code}): ${e.message}\n${out.slice(-2000)}`);
  }
}
