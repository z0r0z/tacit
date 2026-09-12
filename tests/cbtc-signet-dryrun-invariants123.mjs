// cBTC Model-B self-custody lock — signet dry run driver (invariants 1-3 only; see
// ops checklist at the bottom of dapp/cbtc-lock.js). Mirrors scripts/confidential-exit-base.mjs's
// wallet/env-loading shape but drives the REAL Bitcoin-side primitives:
//   dapp/tacit.js            — commit/reveal tx construction, signing, broadcast (loaded under jsdom,
//                               same pattern as tests/cbtc-lock-signet.mjs)
//   dapp/cbtc-lock.js        — makeCbtcLock (funding-first blinding derivation, envelope build)
//   dapp/cbtc-lock-broadcast.js — makeCbtcLockBroadcast (the commit->reveal tx-construction seam)
//   dapp/cbtc-note-recovery.js  — deriveCbtcNoteBlinding / anchorBytes / scanCbtc
//   dapp/confidential-pool.js   — CBTC_ZK_ASSET_ID, commitXY, makeScanReflectionState().foldCbtcLock
//                                 (the JS mirror of cxfer-core's fold_cbtc_lock — the guest-equivalent
//                                 classify/fold logic; no SP1 proving needed to exercise it)
//   dapp/burn-deposit-bitcoin.js — classifyConfidentialTx / txOutputValue (guest-mirroring tx parser)
//
// THROWAWAY KEY, SIGNET ONLY. Zero real value at risk. Does NOT attempt invariant 4 (wallet-wipe
// recovery) — see the report this produces for why that's a dedicated follow-up.
//
// Usage: node scratchpad/cbtc-signet-dryrun.mjs
import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const SCRATCH = path.join(REPO, 'scratchpad');
const KEY_PATH = path.join(SCRATCH, 'cbtc-signet-test-key.json');

const log = (s) => console.log(`[cbtc-signet] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log('loading tacit.js under jsdom...');
const dapp = await import(path.join(REPO, 'dapp/tacit.js'));
log('tacit.js loaded');
const { makeConfidentialPool } = await import(path.join(REPO, 'dapp/confidential-pool.js'));
const { makeCbtcNoteRecovery } = await import(path.join(REPO, 'dapp/cbtc-note-recovery.js'));
const { makeCbtcLock } = await import(path.join(REPO, 'dapp/cbtc-lock.js'));
const { makeCbtcLockBroadcast } = await import(path.join(REPO, 'dapp/cbtc-lock-broadcast.js'));
const { classifyConfidentialTx } = await import(path.join(REPO, 'dapp/burn-deposit-bitcoin.js'));

const secp = await import('@noble/secp256k1');
const { sha256 } = await import('@noble/hashes/sha256');
const { keccak_256 } = await import('@noble/hashes/sha3');
const { hmac } = await import('@noble/hashes/hmac');

const pool = makeConfidentialPool({ secp, keccak256: (b) => keccak_256(b), sha256: (b) => sha256(b) });
const rec = makeCbtcNoteRecovery({ hmac, sha256, curveOrder: secp.CURVE.n });

// ── 1. fresh throwaway signet keypair (persisted so re-runs don't burn a new faucet drip) ──
let keyRecord;
if (existsSync(KEY_PATH)) {
  keyRecord = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
  log(`reusing existing throwaway key at ${KEY_PATH}`);
} else {
  const priv = randomBytes(32);
  keyRecord = { priv_hex: dapp.bytesToHex(priv), created: new Date().toISOString(), note: 'SIGNET-ONLY throwaway key generated for the cBTC lock dry run. Zero real value.' };
  writeFileSync(KEY_PATH, JSON.stringify(keyRecord, null, 2) + '\n', { mode: 0o600 });
  log(`generated fresh throwaway keypair, saved to ${KEY_PATH}`);
}
dapp.wallet.priv = dapp.hexToBytes(keyRecord.priv_hex);
dapp.wallet.pub = secp.getPublicKey(dapp.wallet.priv, true);
await dapp.ensurePrivkey();
const addr = dapp.wallet.address();
keyRecord.address = addr;
writeFileSync(KEY_PATH, JSON.stringify(keyRecord, null, 2) + '\n', { mode: 0o600 });
log(`throwaway signet address: ${addr}`);

// ── 2. fund it (the tacit worker's signet faucet drip; zero-value signet sats) ──
const ESPLORA = 'https://mempool.space/signet/api';
async function balanceOf(a) {
  const r = await fetch(`${ESPLORA}/address/${a}`);
  if (!r.ok) throw new Error(`esplora address lookup failed: HTTP ${r.status}`);
  const j = await r.json();
  return j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum;
}
async function waitForBalance(a, min, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let bal = 0;
    try { bal = await balanceOf(a); } catch (e) { log(`  balance check failed (${e.message}), retrying...`); }
    if (bal >= min) return bal;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} >= ${min} sats (have ${bal})`);
    log(`  waiting for ${label} (have ${bal}, need ${min})...`);
    await sleep(20000);
  }
}

const LOCK_SATS = 6000n; // small signet test lock
const NEEDED = 15000; // lock sats + dust vout0 + reveal fee + commit fee headroom

let bal = 0;
try { bal = await balanceOf(addr); } catch {}
if (bal < NEEDED) {
  log(`balance ${bal} < ${NEEDED}; requesting a faucet drip from the tacit worker...`);
  const WORKER_BASE = process.env.TACIT_WORKER_BASE || 'https://api.tacit.finance';
  try {
    const resp = await fetch(`${WORKER_BASE}/drip`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${JSON.stringify(j)}`);
    log(`drip requested: ${JSON.stringify(j)}`);
  } catch (e) {
    log(`worker /drip failed (${e.message}) — fall back to a public signet faucet manually:`);
    log(`  https://signet.bc-2.jp/  or  https://alt.signetfaucet.com/  -> ${addr}`);
  }
  bal = await waitForBalance(addr, NEEDED, 30 * 60 * 1000, 'throwaway wallet funding');
}
log(`funded: ${bal} sats`);

// ── 3. wire the real cbtc-lock.js / cbtc-lock-broadcast.js primitives ──
function signCommitInputs(commitTx, picked, wpkhSpk) {
  // Mirrors tacit.js's internal (unexported) signCommitInputs, using the exported per-input signers.
  const prevouts = picked.map((u) => ({
    value: u.value,
    script: (u.scriptpubkey && u.scriptpubkey.startsWith('5120')) ? dapp.hexToBytes(u.scriptpubkey) : wpkhSpk,
  }));
  for (let i = 0; i < commitTx.inputs.length; i++) {
    if (picked[i].scriptpubkey && picked[i].scriptpubkey.startsWith('5120')) {
      commitTx.inputs[i].witness = dapp.signTaprootKeypathInput(commitTx, i, prevouts);
    } else {
      commitTx.inputs[i].witness = dapp.signP2wpkhInput(commitTx, i, picked[i].value);
    }
  }
}

async function selectLockFunding({ amountSats }) {
  const utxos = await dapp.getUtxos(addr);
  const spendable = utxos.filter((u) => u.value > Number(dapp.DUST)).sort((a, b) => b.value - a.value);
  const feeRate = await dapp.getFeeRate('priority');
  const need = Number(amountSats) + Number(dapp.DUST) + dapp.feeFor(250, feeRate) + dapp.feeFor(dapp.estCommitVb(1), feeRate);
  const chosen = spendable.find((u) => u.value >= need) || spendable[0];
  if (!chosen) throw new Error('no spendable UTXOs for the lock funding');
  return { fundingPrevout: { txid: chosen.txid, vout: chosen.vout } };
}

const ownLockScriptPubKey = () => dapp.p2wpkhScript(dapp.wallet.pub);

const broadcastCbtcLockTx = makeCbtcLockBroadcast({
  wallet: dapp.wallet,
  encodeEnvelopeScript: dapp.encodeEnvelopeScript,
  tapLeafHash: dapp.tapLeafHash,
  tweakedOutputKey: dapp.tweakedOutputKey,
  TAP_NUMS: dapp.TAP_NUMS,
  p2trScript: dapp.p2trScript,
  controlBlock: dapp.controlBlock,
  p2wpkhScript: dapp.p2wpkhScript,
  feeFor: dapp.feeFor,
  getFeeRate: dapp.getFeeRate,
  getUtxos: dapp.getUtxos,
  signCommitInputs,
  signTaprootScriptPathInput: dapp.signTaprootScriptPathInput,
  serializeTx: dapp.serializeTx,
  txid: dapp.txid,
  broadcast: dapp.broadcast,
  broadcastWithRetry: dapp.broadcastWithRetry,
  estCommitVb: dapp.estCommitVb,
  DUST: dapp.DUST,
  bytesToHex: dapp.bytesToHex,
  hexToBytes: dapp.hexToBytes,
});

const cbtcLock = makeCbtcLock({
  privkey: dapp.wallet.priv,
  asset: pool.CBTC_ZK_ASSET_ID,
  commitXY: pool.commitXY,
  deriveCbtcNoteBlinding: rec.deriveCbtcNoteBlinding,
  anchorBytes: rec.anchorBytes,
  selectLockFunding,
  ownLockScriptPubKey,
  broadcastCbtcLockTx,
  postHint: null, // no shared worker /hint fast-track needed for this dry run
  lockVout: 1,
});

// ── 4. build + broadcast the real T_CBTC_LOCK (0x66) tx ──
const results = { addr, keyPath: KEY_PATH, lockSats: LOCK_SATS.toString() };
log(`building + broadcasting the cBTC lock (${LOCK_SATS} sats)...`);
const lockResult = await cbtcLock.buildAndBroadcastCbtcLock({ amountSats: LOCK_SATS });
log(`lock broadcast: txid=${lockResult.lockTxid} vout=${lockResult.lockVout}`);
results.lockTxid = lockResult.lockTxid;
results.lockVout = lockResult.lockVout;
results.blinding = lockResult.blinding.toString();
results.anchor = lockResult.anchor;

// ── invariant 1: the lock tx lands on signet (wait for confirmation) ──
async function waitForConfirmation(txid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await fetch(`${ESPLORA}/tx/${txid}/status`);
    if (r.ok) {
      const j = await r.json();
      if (j.confirmed) return j;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${txid} to confirm`);
    log(`  waiting for ${txid} to confirm...`);
    await sleep(30000);
  }
}
log('waiting for the lock reveal to confirm on signet...');
const status = await waitForConfirmation(lockResult.lockTxid, 60 * 60 * 1000);
log(`INVARIANT 1 PASS: lock tx confirmed at height ${status.block_height}`);
results.invariant1 = { pass: true, blockHeight: status.block_height };

// ── invariant 2: the reflection guest-equivalent classifier + fold recognize the REAL tx ──
const rawHex = await (await fetch(`${ESPLORA}/tx/${lockResult.lockTxid}/hex`)).text();
const cls = classifyConfidentialTx(rawHex);
if (!cls || cls.type !== 'cbtc_lock') throw new Error(`classifyConfidentialTx did not recognize the lock tx as cbtc_lock (got ${JSON.stringify(cls)})`);
if (String(cls.lockVout) !== String(lockResult.lockVout)) throw new Error(`classified lockVout ${cls.lockVout} != broadcast lockVout ${lockResult.lockVout}`);
if (cls.vBtc == null) throw new Error('classified vBtc is null — txOutputValue could not read the lock output');
if (BigInt(cls.vBtc) !== LOCK_SATS) throw new Error(`classified vBtc ${cls.vBtc} != locked ${LOCK_SATS}`);
log(`classifier: type=${cls.type} lockVout=${cls.lockVout} vBtc=${cls.vBtc} cx=${cls.cx.slice(0, 14)}... cy=${cls.cy.slice(0, 14)}...`);

const scanState = pool.makeScanReflectionState();
const g0 = scanState.digest();
const foldDelta = scanState.foldCbtcLock({ asset: cls.asset, cx: cls.cx, cy: cls.cy, vBtc: BigInt(cls.vBtc), lockVout: cls.lockVout, lockTxid: lockResult.lockTxid });
if (!foldDelta) throw new Error('foldCbtcLock (guest-equivalent fold) rejected the real lock tx');
if (foldDelta.vBtc !== LOCK_SATS) throw new Error(`fold delta vBtc ${foldDelta.vBtc} != ${LOCK_SATS}`);
if (scanState.digest() === g0) throw new Error('fold did not advance the reflection digest');
if (scanState.cbtcBackingSats() !== LOCK_SATS) throw new Error(`cbtcBackingSats ${scanState.cbtcBackingSats()} != ${LOCK_SATS} after the fold`);
log(`INVARIANT 2 PASS: classifyConfidentialTx + foldCbtcLock (guest-equivalent) recognize + record the real lock (backing=${scanState.cbtcBackingSats()} sats, outpoint=${foldDelta.outpoint.slice(0, 14)}...)`);
results.invariant2 = { pass: true, classified: { type: cls.type, lockVout: cls.lockVout, vBtc: cls.vBtc }, foldDelta: { outpoint: foldDelta.outpoint, vBtc: foldDelta.vBtc.toString(), commitment: foldDelta.commitment } };

// ── invariant 3: the mint would open exactly 1:1 — recompute the blinding independently from the
// funding anchor (NOT from lockResult.blinding, to actually exercise the derivation) and confirm
// commitXY(vBtc, blinding) equals the on-chain committed (Cx,Cy) exactly. ──
const recomputedBlinding = rec.deriveCbtcNoteBlinding({
  privkey: dapp.wallet.priv,
  anchorOutpoint: rec.anchorBytes(lockResult.anchor.txid, lockResult.anchor.vout),
  outputIndex: 0,
});
if (recomputedBlinding !== lockResult.blinding) throw new Error('recomputed blinding != the blinding used to build the lock (derivation not stable)');
const { cx: mintCx, cy: mintCy } = pool.commitXY(BigInt(cls.vBtc), recomputedBlinding);
if (mintCx.toLowerCase() !== cls.cx.toLowerCase() || mintCy.toLowerCase() !== cls.cy.toLowerCase()) {
  throw new Error(`mint commitment mismatch: derived (${mintCx},${mintCy}) != on-chain (${cls.cx},${cls.cy})`);
}
// also exercise scanCbtc (the recovery-scan matcher invariant 4 will depend on) against the real lock,
// with decoy candidate anchors, to confirm it isolates the correct funding anchor from noise. This is
// NOT the full wallet-wipe invariant (that needs a real spent-prevout history enumeration) — see report.
const decoyAnchors = [
  { txid: '11'.repeat(32), vout: 3 },
  { txid: lockResult.anchor.txid, vout: lockResult.anchor.vout },
  { txid: '22'.repeat(32), vout: 1 },
];
const scanned = rec.scanCbtc({ privkey: dapp.wallet.priv, candidateAnchors: decoyAnchors, locks: [{ vBtc: cls.vBtc, cx: cls.cx, cy: cls.cy }], commitXY: pool.commitXY });
if (scanned.length !== 1 || scanned[0].anchor.txid !== lockResult.anchor.txid) throw new Error('scanCbtc did not recover the lock from its own funding anchor among decoys');
log(`INVARIANT 3 PASS: recomputed blinding -> commitXY(vBtc, blinding) == on-chain (Cx,Cy) exactly; scanCbtc isolates the correct anchor among decoys`);
results.invariant3 = { pass: true, blinding: recomputedBlinding.toString(), cx: mintCx, cy: mintCy };

results.invariant4 = { pass: null, note: 'NOT attempted in this pass — deliberately out of scope (highest-risk invariant; needs dedicated review + a real wallet-wipe simulation enumerating actual spent-prevout history)' };

writeFileSync(path.join(SCRATCH, 'cbtc-signet-dryrun-raw-result.json'), JSON.stringify(results, null, 2) + '\n');
log('all 3 invariants PASSED. Raw result written to scratchpad/cbtc-signet-dryrun-raw-result.json');
process.exit(0);
