// Local Groth16 verification of T_BTC_SPEND proofs (DESIGN-btc-shielded-pool.md §5) through the
// btc-pool-verify binary (contracts/sp1/confidential/btc-pool-host).
//
// Binary contract: stdin {"proof","public_values","vkey"} (0x-hex); stdout {"ok":true} or
// {"ok":false,"reason":…}, exit 0 either way. Any other exit status or output is an internal error and
// throws: it is never read as a rejection, so a broken verifier stalls the indexer instead of forking it.

import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PIN_PATH = fileURLToPath(new URL('../../../contracts/sp1/confidential/elf-vkey-pin.json', import.meta.url));

const toHex = (b) => (typeof b === 'string' ? (b.startsWith('0x') ? b : '0x' + b) : '0x' + Buffer.from(b).toString('hex'));

export function loadBtcPoolVkey({ env = process.env, pinPath = env.BTC_POOL_VKEY_PIN || DEFAULT_PIN_PATH } = {}) {
  const v = env.BTC_POOL_VKEY || JSON.parse(readFileSync(pinPath, 'utf8')).btc_pool_vkey;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v || '')) throw new Error(`btc_pool_vkey malformed: ${v}`);
  return v.toLowerCase();
}

export function runVerifier(bin, input, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, new Error(`btc-pool-verify timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code, signal) => {
      if (code !== 0) return finish(reject, new Error(`btc-pool-verify exited ${code ?? signal}: ${err.trim().slice(0, 500)}`));
      let res;
      try { res = JSON.parse(out.trim()); } catch { return finish(reject, new Error(`btc-pool-verify printed non-JSON: ${out.slice(0, 200)}`)); }
      if (res && res.ok === true) return finish(resolve, { ok: true });
      if (res && res.ok === false) return finish(resolve, { ok: false, reason: String(res.reason ?? '') });
      finish(reject, new Error(`btc-pool-verify returned an unexpected shape: ${out.slice(0, 200)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

// { enabled, reason, vkey, verify } — verify is null when disabled, which acceptSpend treats as
// "cannot decide" (the indexer halts at that spend) rather than as a rejection.
export function makeBtcPoolVerifier({ bin = process.env.BTC_POOL_VERIFY_BIN, vkey, timeoutMs, log = console.error } = {}) {
  let reason = null;
  if (!bin) reason = 'BTC_POOL_VERIFY_BIN is not set';
  else {
    try { accessSync(bin, constants.X_OK); } catch { reason = `BTC_POOL_VERIFY_BIN ${bin} is missing or not executable`; }
  }
  if (!reason && !vkey) {
    try { vkey = loadBtcPoolVkey(); } catch (e) { reason = `btc_pool_vkey unavailable: ${e.message}`; }
  }
  if (reason) {
    log(`!!! btc-pool: spend verification DISABLED (${reason}). Shields replay; the first T_BTC_SPEND halts the indexer.`);
    return { enabled: false, reason, vkey: vkey || null, verify: null };
  }
  const verify = async ({ proof, publicValues }) => {
    const r = await runVerifier(bin, { proof: toHex(proof), public_values: toHex(publicValues), vkey }, { timeoutMs });
    return r.ok;
  };
  return { enabled: true, reason: null, vkey, verify };
}
