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
import { POOL } from './chain.js';
import { reflectionEthProof } from './worker-client.js';

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

// Fetch the raw compressed eth-proof bytes bitcoin_prove's Mode-B branch needs and write them to
// $PROVER_OUT/eth_compressed.bin (the path bitcoin_prove.rs now derives from PROVER_OUT — previously
// hardcoded to a RunPod-box-only path, which is what produced the ENOENT the first time a modeB=1 job
// reached this relay). contentHash is derived from the job's own ethPv so a pending candidate getting
// replaced mid-flight is detected as a miss (the worker refuses to serve the wrong one) rather than
// silently recursing a different eth-side witness set than the fixture actually committed to.
async function writeEthProofFor(ethPv) {
  const contentHash = keccak256(ethPv.startsWith('0x') ? ethPv : `0x${ethPv}`);
  const res = await reflectionEthProof(contentHash);
  if (!res || !res.ethCompressedProofB64) {
    throw new Error(`no eth-state proof blob for contentHash=${contentHash} — the eth-state candidate this `
      + `Mode-B job was built from is gone (republish /reflection/eth-state, or wait for a fresh job)`);
  }
  await writeFile(path.join(CFG.proverOut, 'eth_compressed.bin'), Buffer.from(res.ethCompressedProofB64, 'base64'));
}

// ── Reflection: bitcoin_prove (eth-reflection prover-host) ──
// Writes the assembled reflection input to REFLECT_FIXTURE, spawns the binary. A forward (modeB=0) fixture
// proves without eth recursion (the always-on incremental attest); a Mode-B (modeB=1) fixture additionally
// needs the compressed eth-proof bytes on disk first (writeEthProofFor above). Returns { publicValues,
// proofBytes } either way — the recursion branch lives inside bitcoin_prove itself, keyed on the fixture's
// own modeB field.
export async function proveReflection(input) {
  await mkdir(CFG.fixtureDir, { recursive: true });
  await mkdir(CFG.proverOut, { recursive: true });
  const fixture = path.join(CFG.fixtureDir, 'reflection_input.json');
  await writeFile(fixture, JSON.stringify(input));
  await rm(path.join(CFG.proverOut, 'bitcoin_proof_bytes.hex'), { force: true });
  if (input.modeB) await writeEthProofFor(input.ethPv);

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

// ── Mode-B: eth_prove (eth-reflection prover-host, the crossOut/consumed producer) ──
// Unlike bitcoin_prove/exec, eth_prove keeps its OWN cumulative resume state on disk (a committed
// eth_set_state.json + a not-yet-committed .pending.json — see the binary's header comment). This spawn
// wrapper never writes state_path() itself; committing pending -> state is the caller's job, done only
// once the caller has independently confirmed (via GET /reflection/eth-state) that a Bitcoin batch built
// from this exact candidate actually landed on-chain (see commitEthProveState below). Committing early
// would desync the NEXT eth_prove run's prior_set_root/prior_count from what's really on-chain — the
// "single-use proof" trap eth-state-sidecar.js's header comment covers in more depth.
function ethProveEnv(mode) {
  return proverEnv({
    SOURCE_CONSENSUS_RPC: CFG.sourceConsensusRpc,
    SOURCE_CHAIN_ID: CFG.sourceChainId,
    SOURCE_EXECUTION_RPC: CFG.sourceExecutionRpc,
    ...(CFG.sourceProofRpc ? { SOURCE_PROOF_RPC: CFG.sourceProofRpc } : {}),
    POOL,
    ...(CFG.ethCallOutbox ? { ETH_CALL_OUTBOX: CFG.ethCallOutbox } : {}),
    ...(CFG.ethProveDeployBlock ? { DEPLOY_BLOCK: CFG.ethProveDeployBlock } : {}),
    ...(CFG.ethProveGenesisSlot ? { GENESIS_SLOT: CFG.ethProveGenesisSlot } : {}),
    SCAN_CHUNK: CFG.ethProveScanChunk,
    SCAN_DELAY_MS: CFG.ethProveScanDelayMs,
    ETHPROVE_CYCLE_LIMIT: CFG.ethProveCycleLimit,
    ETHPROVE_GAS_LIMIT: CFG.ethProveGasLimit,
    ETH_PROVE_OUT_DIR: CFG.ethProveOutDir,
    ETH_PROVE_DEBUG_DIR: CFG.ethProveDebugDir,
    // eth_prove.rs reads its OWN SP1_PROVER var (backend selector: cpu|cuda|network|execute) — separate
    // from the bitcoin_prove/exec convention of always being 'network', because 'execute' (free local
    // dry-run, no STARK) is a real, distinct mode this binary supports and the sidecar uses deliberately.
    SP1_PROVER: mode === 'execute' ? 'execute' : CFG.sp1Prover,
  });
}

// mode 'execute': free local dry-run (no proof, no artifacts) — parses EXECUTE_OK/RAWPV off stdout so the
// caller can sanity-check cycle count and decode crossOutCount/etc. from RAWPV before spending a real
// network prove. mode 'network' (default): the real compressed proof + bundle, read back from ETH_PROVE_OUT_DIR.
export async function proveEthState({ mode = 'network', timeoutMs } = {}) {
  await mkdir(CFG.ethProveOutDir, { recursive: true });
  if (mode !== 'execute') {
    // Clear this run's output artifacts BEFORE spawning (mirrors proveReflection's own rm-before-run
    // guard above) — otherwise a run that panics without writing anything new leaves readFile below to
    // silently pick up a PREVIOUS successful run's leftover files and return them as if they were fresh.
    // That happened for real: a network proof rejected as "unexecutable" still left the prior candidate's
    // eth_set_state.pending.json on disk, and this function returned it as a "successful" result.
    await Promise.all([
      rm(path.join(CFG.ethProveOutDir, 'eth_compressed.bin'), { force: true }),
      rm(path.join(CFG.ethProveOutDir, 'eth_set.json'), { force: true }),
      rm(path.join(CFG.ethProveOutDir, 'eth_set_state.pending.json'), { force: true }),
    ]);
  }
  const { code, out, err } = await run(CFG.ethProveBin, { env: ethProveEnv(mode), cwd: CFG.ethProveOutDir, timeoutMs, tag: `eth_prove:${mode}` });
  const tail = (out + err).slice(-4000);
  if (mode === 'execute') {
    const m = out.match(/EXECUTE_OK cycles=(\d+) pv_bytes=(\d+)/);
    if (!m) throw new Error(`eth_prove execute produced no EXECUTE_OK line (code=${code}): ${tail}`);
    const rawpv = out.match(/RAWPV ([0-9a-f]+)/i);
    return { cycles: Number(m[1]), pvBytes: Number(m[2]), rawPvHex: rawpv ? rawpv[1] : null };
  }
  try {
    const [ethCompressed, bundleRaw, pendingRaw] = await Promise.all([
      readFile(path.join(CFG.ethProveOutDir, 'eth_compressed.bin')),
      readFile(path.join(CFG.ethProveOutDir, 'eth_set.json'), 'utf8'),
      readFile(path.join(CFG.ethProveOutDir, 'eth_set_state.pending.json'), 'utf8'),
    ]);
    const bundle = JSON.parse(bundleRaw); // { ethPv, crossouts:[{claimId,destCommitment,asset}], consumeds:[{nu,consumedVal,spendRoot}] }
    const pending = JSON.parse(pendingRaw); // { last_block, crossouts, consumeds } — the CANDIDATE cumulative state
    return {
      ethPv: bundle.ethPv,
      crossouts: bundle.crossouts.map((c) => ({ claimId: c.claimId, destCommitment: c.destCommitment, asset: c.asset })),
      consumeds: bundle.consumeds.map((c) => ({ nu: c.nu, consumedVal: c.consumedVal, spendRoot: c.spendRoot })),
      ethCompressedProofB64: ethCompressed.toString('base64'),
      lastBlock: pending.last_block,
      execBlock: pending.last_block,
    };
  } catch (e) {
    throw new Error(`eth_prove network run produced no usable artifacts (code=${code}): ${e.message}\n${tail}`);
  }
}

// Advance the committed resume state to the just-published candidate — call ONLY after independently
// confirming (GET /reflection/eth-state) that a Bitcoin batch built from it actually landed. Copies rather
// than renames: a crash mid-copy should never leave neither file intact (rename is atomic per-filesystem
// but this stays defensive and cheap either way — these files are at most a few MB).
export async function commitEthProveState() {
  const pending = path.join(CFG.ethProveOutDir, 'eth_set_state.pending.json');
  const committed = path.join(CFG.ethProveOutDir, 'eth_set_state.json');
  await writeFile(committed, await readFile(pending));
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
    // Stealth lock/claim. This is the ONLY sound way to pay a third party: a native note's owner is
    // keccak(nk ‖ dom), so a sender who builds the recipient's note either picks nk (and keeps spend
    // authority over their money) or derives the owner from a pubkey (and mints a note nobody can spend).
    // The lock escrows to a one-time key instead, and the recipient claims it into a note under an nk only
    // they can derive.
    stealthlock: 'exec-stealthlock', stealthclaim: 'exec-stealthclaim', stealthrefund: 'exec-stealthrefund',
    stealthlockbatch: 'exec-stealthlockbatch', bridgestealthmint: 'exec-bridgestealthmint',
    farmbond: 'exec-farmbond', farmharvest: 'exec-farmharvest', farmunbond: 'exec-farmunbond',
    adaptorlock: 'exec-adaptorlock', adaptorclaim: 'exec-adaptorclaim', adaptorrefund: 'exec-adaptorrefund',
    cdpliquidate: 'exec-cdpliquidate', cdptopup: 'exec-cdptopup', lpbond: 'exec-lpbond', wrapcdpmint: 'exec-wrapcdpmint',
    // Bitcoin-homed (authenticated) OP_TRANSFER batches: `fastlane` is the dapp's fast-lane exit shape
    // ({ chainBinding, spendRoot, bitcoinSpentRoot, transfer }); `crosslane` is the flat fixture shape.
    fastlane: 'exec-fastlane', crosslane: 'exec-crosslane',
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
