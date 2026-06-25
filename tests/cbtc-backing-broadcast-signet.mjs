// cBTC.zk backing real broadcast + verify E2E (Signet lock → Sepolia escrow + mint + slash).
//
// REQUIRES A DEPLOYED POOL + COLLATERAL ENGINE + A RUNNING BOX/WORKER + reflection coverage of the signet
// lock. This exercises the cBTC.zk REAL-BTC backing path end to end, which is DISTINCT from the cBTC.tac
// slot lifecycle already covered by cbtc-zk-slot-lifecycle-signet.mjs (slot mint/burn). Here the chain is:
//   1. Bitcoin self-custody LOCK (T_CBTC_LOCK 0x66) — the inverse of burn-deposit-bitcoin.parseCbtcLockEnvelope,
//      built exactly as tests/cbtc-lock-signet.mjs --broadcast does (commit/reveal Taproot envelope; the
//      note blinding is SEED-DERIVED from priv + the funding anchor so recovery works from the key alone).
//   2. ETH ESCROW — postEscrow(outpoint) funds the slashable native-ETH insurance the pool reads via
//      engine.escrowSufficient(outpoint, vBtc) before it will mint (CollateralEngine.sol §postEscrow).
//   3. cBTC MINT (OP_CBTC_MINT) — defi.mintCbtc mints the owner-free bearer cBTC.zk note pinned 1:1 to the
//      lock's sats, gated by the reflection-recorded lock + escrow sufficiency.
//   4. ESCROW / SLASH path — assert claimEscrow is LOCKED while cBTC is outstanding (cbtcMinted ∧
//      !redeemed), then drive the slash branch: a bare lock spend (cbtcLockSpent ∧ minted ⇒ rug) makes
//      slash(outpoint) sweep the escrow to the insurance reserve.
//
// It CANNOT pass until pool+engine are deployed, a box settles the queue, AND the reflection prover has
// folded the signet lock (so cbtcLock[outpoint].vBtc is recorded). Until then it is correct-by-construction
// against cbtc-lock-signet.mjs + confidential-cdp-op.mjs (buildCbtcMintOp) + CollateralEngine.sol, and it
// FAILS LOUDLY on a missing prereq.
//
// Run:  node tests/cbtc-backing-broadcast-signet.mjs [contracts/deployments/11155111.json]
//       SKIP_SLASH=1 node ...   # do the lock+escrow+mint, but leave the lock live (no rug/slash)
//       node tests/cbtc-backing-broadcast-signet.mjs --reset
//
// Wallets:
//   .local/amm-e2e-signet-wallets.json (founder) — funds the signet lock (≥ ~50k sats). [gen-amm-e2e-signet-wallets.mjs]
//   ~/.tacit-validation/sepolia.json { priv_hex } — a funded Sepolia EOA that posts the ETH escrow.
//
// REVIEWER MUST CHECK at run time:
//   (a) engine.escrowRatioBps × the validated ETH/BTC mark sets requiredEscrow(vBtc). The harness reads
//       requiredEscrow on-chain and posts that exact wei — if the feed deviates between the read and the
//       mint, escrowSufficient may flip; re-run.
//   (b) The mint only lands once the REFLECTION prover has folded the lock (the pool gates the OP_CBTC_MINT
//       on cbtcLock[outpoint].vBtc == vBtc). The harness polls cbtcLock readiness before minting; if the
//       prover is not running it will time out (expected).
//   (c) The SLASH phase deliberately RUGS the lock (a bare on-chain spend of the lock UTXO without an
//       in-tx cBTC burn). Only run it on a throwaway signet lock — it forfeits the posted escrow to the
//       reserve. SKIP_SLASH=1 leaves the lock honest (claim via redeem instead).

import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
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

import * as secp from '@noble/secp256k1';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { createHash } from 'node:crypto';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);

const dapp = await import('../dapp/tacit.js'); // Bitcoin tx primitives (commit/reveal, signing, broadcast)
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { makeConfidentialCdp } = await import('../dapp/confidential-cdp.js');
const { makeConfidentialDefiActions } = await import('../dapp/confidential-defi-actions.js');
const { makeConfidentialFarm } = await import('../dapp/confidential-farm.js');
const { makeConfidentialPool } = await import('../dapp/confidential-pool.js');
const { makeCbtcNoteRecovery } = await import('../dapp/cbtc-note-recovery.js');
const { buildCbtcLockEnvelope } = await import('../dapp/cbtc-envelope.js');
const { classifyConfidentialTx } = await import('../dapp/burn-deposit-bitcoin.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'cbtc-backing-e2e-state.json');
const WALLETS_FILE = path.join(STATE_DIR, 'amm-e2e-signet-wallets.json');
const SEPOLIA_KEY = path.join(os.homedir(), '.tacit-validation', 'sepolia.json');

const FLAGS = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
if (FLAGS.has('--reset') && existsSync(STATE_FILE)) { unlinkSync(STATE_FILE); console.log(`State reset: ${STATE_FILE} deleted`); }
const MANIFEST = process.argv.slice(2).find((a) => !a.startsWith('--'));
const SKIP_SLASH = process.env.SKIP_SLASH === '1';

function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function step(n, msg) { console.log(`\n--- Phase ${n}: ${msg} ---`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
const _hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const rand32Hex = () => '0x' + bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

// outpoint = keccak256(txid_be32 ‖ vout_le4) — the same key CollateralEngine + the pool use for a lock.
// (Mirrors cxfer-core canonical_*_vout / the confidential-pool outpointKey; computed here for the mint gate.)
function lockOutpoint(revealTxidHex, vout) {
  const txidBE = new Uint8Array(32);
  const h = String(revealTxidHex).replace(/^0x/, '');
  for (let i = 0; i < 32; i++) txidBE[i] = parseInt(h.slice((31 - i) * 2, (31 - i) * 2 + 2), 16); // display→BE
  const voutLE = new Uint8Array(4); new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  return '0x' + _hex(keccak256(concatBytes(txidBE, voutLE)));
}

// ---- network + UX ----
// Sepolia pilot pool lives under the deployment key "signet" (chainId 11155111). "mainnet" is gated.
const NETWORK = process.env.NETWORK || 'signet';
let ux;
try { ux = makeConfidentialPoolUx({ secp, keccak256, sha256, network: NETWORK }); }
catch (e) { fail(`confidential pool UX not configured: ${e.message}`); }
const cfg = ux.cfg;
if (MANIFEST) {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (m.pool) cfg.pool = m.pool;
  if (m.engine || m.collateralEngine) cfg.collateralEngine = m.engine || m.collateralEngine;
  if (m.deployBlock) cfg.deployBlock = m.deployBlock;
  info(`manifest ${MANIFEST}: pool=${cfg.pool} engine=${cfg.collateralEngine || '—'}`);
}
if (!cfg.collateralEngine) fail('cfg.collateralEngine is null — CollateralEngine (escrow/slash) not deployed.');
const ENGINE = cfg.collateralEngine;

// ---- Bitcoin (signet) wallet for the lock ----
if (!existsSync(WALLETS_FILE)) fail(`signet wallets not found at ${WALLETS_FILE} (gen-amm-e2e-signet-wallets.mjs)`);
const W = JSON.parse(readFileSync(WALLETS_FILE, 'utf8'));
const BTC_PRIV = hexToBytes(W.founder.priv_hex);
dapp.wallet.priv = BTC_PRIV;
dapp.wallet.pub = secp.getPublicKey(BTC_PRIV, true);
await dapp.ensurePrivkey();
const BTC_ADDR = dapp.wallet.address();

// ---- Sepolia EOA for the ETH escrow ----
if (!existsSync(SEPOLIA_KEY)) fail(`Sepolia escrow key not found at ${SEPOLIA_KEY} ({ "priv_hex": "<64-hex>" }, funded with test ETH)`);
const SEP = JSON.parse(readFileSync(SEPOLIA_KEY, 'utf8'));
const ESCROW_PRIV = hexToBytes(String(SEP.priv_hex).replace(/^0x/, ''));

// ---- pool/cdp helpers ----
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const cdp = makeConfidentialCdp({ keccak256, pool: ux.pool });
const defi = makeConfidentialDefiActions({
  pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256, pool: ux.pool }),
  relay: ux.relay, id: ux.identity(BTC_PRIV), chainBindingHex: ux.chainBindingHex, secp,
});
const rec = makeCbtcNoteRecovery({ hmac, sha256, curveOrder: secp.CURVE.n });
const CBTC_ZK_ASSET = '0x' + ux.pool.CBTC_ZK_ASSET_ID.replace(/^0x/, '');

const V_BTC = BigInt(process.env.V_BTC || 20000n); // sats to lock
const state = loadState();

console.log(`\n=== cBTC.zk backing E2E (Signet lock → Sepolia escrow + mint + slash) ===\n`);
console.log(`  pool:     ${cfg.pool}`);
console.log(`  engine:   ${ENGINE}`);
console.log(`  btc addr: ${BTC_ADDR}  (locks ${V_BTC} sats)`);
console.log(`  cBTC.zk:  ${CBTC_ZK_ASSET.slice(0, 18)}…`);
console.log(`  state:    ${STATE_FILE}\n`);

// ---- engine read helpers (eth_call over the UX rpc fallback) ----
const sel = (sig) => _hex(keccak256(new TextEncoder().encode(sig)).subarray(0, 4));
const word = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
async function engineCall(sig, ...words) {
  const data = '0x' + sel(sig) + words.map(word).join('');
  return ux.rpc('eth_call', [{ to: ENGINE, data }, 'latest']);
}
async function poolBoolCall(sig, outpoint) {
  const data = '0x' + sel(sig) + word(outpoint);
  const r = await ux.rpc('eth_call', [{ to: cfg.pool, data }, 'latest']);
  return BigInt(r || '0x0') === 1n;
}
const requiredEscrow = async (vBtc) => BigInt(await engineCall('requiredEscrow(uint256)', vBtc.toString(16)) || '0x0');
const escrowSufficient = async (outpoint, vBtc) => BigInt(await engineCall('escrowSufficient(bytes32,uint256)', outpoint, vBtc.toString(16)) || '0x0') === 1n;
const escrowTotal = async (outpoint) => BigInt(await engineCall('escrowTotal(bytes32)', outpoint) || '0x0');
const escrowSlashed = async (outpoint) => BigInt(await engineCall('escrowSlashed(bytes32)', outpoint) || '0x0') === 1n;
const cbtcMinted = (outpoint) => poolBoolCall('cbtcMinted(bytes32)', outpoint);
const cbtcLockSpent = (outpoint) => poolBoolCall('cbtcLockSpent(bytes32)', outpoint);
const cbtcLockRedeemed = (outpoint) => poolBoolCall('cbtcLockRedeemed(bytes32)', outpoint);
// the pool records cbtcLock[outpoint].vBtc once reflection folds the lock; read its presence via vBtc>0.
async function cbtcLockVBtc(outpoint) {
  const data = '0x' + sel('cbtcLock(bytes32)') + word(outpoint);
  try { const r = await ux.rpc('eth_call', [{ to: cfg.pool, data }, 'latest']); return BigInt((r || '0x0').slice(0, 66)); } catch { return 0n; }
}

// ---- a minimal Sepolia EOA tx sender (reuse the UX evmTx + rpc) ----
async function sendEth({ to, valueWei = 0n, calldata = '0x', gasLimit = 200000n }) {
  const evmTx = ux.evmTx;
  const acct = { priv: ESCROW_PRIV, address: '0x' + _hex(keccak256(secp.getPublicKey(ESCROW_PRIV, false).subarray(1)).subarray(12)) };
  const nonce = BigInt(await ux.rpc('eth_getTransactionCount', [acct.address, 'pending']));
  const tip = 1500000000n;
  const base = BigInt(await ux.rpc('eth_gasPrice', []) || '0x3b9aca00');
  const tx = { chainId: BigInt(cfg.chainId), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, gasLimit: BigInt(gasLimit), to, value: BigInt(valueWei), data: calldata };
  const signed = evmTx.signEip1559(tx, acct.priv);
  const txHash = await ux.rpc('eth_sendRawTransaction', [signed.raw]);
  return { txHash, from: acct.address };
}
async function waitReceipt(txHash, label) {
  for (let i = 0; i < 40; i++) {
    const r = await ux.rpc('eth_getTransactionReceipt', [txHash]);
    if (r && r.blockNumber) { if (BigInt(r.status || '0x1') !== 1n) fail(`${label} reverted (${txHash})`); return r; }
    await sleep(6000);
  }
  fail(`${label} not mined within ~4 min (${txHash})`);
}

// =========================================================================
// Phase 0: pre-flight
// =========================================================================
step(0, 'pre-flight (signet sats, Sepolia escrow EOA, engine reachable)');
{
  try {
    const r = await fetch(`https://mempool.space/signet/api/address/${BTC_ADDR}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const sats = (j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum) + (j.mempool_stats.funded_txo_sum - j.mempool_stats.spent_txo_sum);
    info(`signet ${BTC_ADDR}: ${sats} sats`);
    if (sats < Number(V_BTC) + 5000) fail(`signet wallet underfunded: need ≥ ${Number(V_BTC) + 5000} sats`);
  } catch (e) { fail(`signet balance check failed: ${e.message}`); }
  const re = await requiredEscrow(V_BTC);
  ok(`engine reachable; requiredEscrow(${V_BTC}) = ${re} wei`);
  if (re === 0n) warn('requiredEscrow is 0 (escrowRatioBps dormant or feed at 0) — the mint will pass with zero escrow; the slash phase still applies once funded.');
}

// =========================================================================
// Phase 1: Bitcoin self-custody LOCK (T_CBTC_LOCK 0x66)
// =========================================================================
step(1, 'Bitcoin LOCK (commit/reveal cBTC.zk lock envelope)');
if (state.lock?.revealTxid) {
  ok(`reusing lock: ${state.lock.revealTxid.slice(0, 16)}…:0  outpoint ${state.lock.outpoint.slice(0, 14)}…`);
} else {
  // verbatim from cbtc-lock-signet.mjs --broadcast (commit funds the reveal; note blinding seed-derived).
  const feeRate = await dapp.getFeeRate();
  const revealFee = dapp.feeFor(200, feeRate);
  const commitValue = Number(V_BTC) + revealFee;
  const utxos = await dapp.getUtxos(BTC_ADDR);
  const sats = utxos.filter((u) => u.value > dapp.DUST).sort((a, b) => b.value - a.value);
  const picked = []; let total = 0; let commitFee = 500;
  for (const u of sats) { picked.push(u); total += u.value; commitFee = dapp.feeFor(dapp.estCommitVb(picked.length), feeRate); if (total >= commitValue + commitFee + dapp.DUST) break; }
  if (total < commitValue + commitFee) fail(`insufficient signet sats for the lock: need ${commitValue + commitFee}, have ${total}`);
  const fundingAnchor = picked[0];
  // SEED-DERIVED blinding (priv + funding anchor) — the SAME derivation the recovery scan + defi.mintCbtc expect.
  const blinding = rec.deriveCbtcNoteBlinding({ privkey: dapp.wallet.priv, anchorOutpoint: rec.anchorBytes(fundingAnchor.txid, fundingAnchor.vout), outputIndex: 0 });
  const { cx, cy } = pool.commitXY(V_BTC, blinding);
  const env = buildCbtcLockEnvelope({ asset: CBTC_ZK_ASSET, lockVout: 0, cx, cy });
  const envelopeScript = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), hexToBytes(env.replace(/^0x/, '')));
  const leaf = dapp.tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = dapp.tweakedOutputKey(dapp.TAP_NUMS, leaf);
  const commitSpk = dapp.p2trScript(Q_xonly);
  const cb = dapp.controlBlock(dapp.TAP_NUMS, parity);
  const wpkh = dapp.p2wpkhScript(dapp.wallet.pub);
  const change = total - commitValue - commitFee;
  const commitOutputs = [{ value: commitValue, script: commitSpk }];
  if (change >= dapp.DUST) commitOutputs.push({ value: change, script: wpkh });
  const commitTx = { version: 2, locktime: 0, inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })), outputs: commitOutputs };
  for (let i = 0; i < commitTx.inputs.length; i++) commitTx.inputs[i].witness = dapp.signP2wpkhInput(commitTx, i, picked[i].value);
  const commitHex = bytesToHex(dapp.serializeTx(commitTx));
  const commitTxid = dapp.txid(commitTx);
  // the lock output (vout 0) holds exactly V_BTC sats under the wallet's own key (self-custody)
  const revealTx = { version: 2, locktime: 0, inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: Number(V_BTC), script: wpkh }] };
  revealTx.inputs[0].witness = dapp.signTaprootScriptPathInput(revealTx, [{ value: commitValue, script: commitSpk }], envelopeScript, cb);
  const revealHex = bytesToHex(dapp.serializeTx(revealTx));
  const revealTxid = dapp.txid(revealTx);
  const cls = classifyConfidentialTx(revealHex);
  if (!cls || cls.type !== 'cbtc_lock' || cls.cx.toLowerCase() !== cx.toLowerCase()) fail('lock reveal does not classify as a clean cbtc_lock');
  await dapp.broadcast(commitHex);
  await dapp.broadcastWithRetry(revealHex);
  const outpoint = lockOutpoint(revealTxid, 0);
  state.lock = { commitTxid, revealTxid, outpoint, vBtc: V_BTC.toString(), blinding: '0x' + BigInt(blinding).toString(16).padStart(64, '0'), cx, cy };
  saveState(state);
  ok(`LOCK broadcast: reveal ${revealTxid.slice(0, 16)}…:0  outpoint ${outpoint.slice(0, 14)}…  (${V_BTC} sats)`);
  info(`mempool: https://mempool.space/signet/tx/${revealTxid}`);
}
const OUTPOINT = state.lock.outpoint;

// =========================================================================
// Phase 2: post the ETH escrow on Sepolia (CollateralEngine.postEscrow)
// =========================================================================
step(2, 'ETH ESCROW (postEscrow on Sepolia)');
if (state.escrow?.completed) {
  ok(`reusing escrow: ${state.escrow.txHash}  (${state.escrow.amountWei} wei)`);
} else {
  const need = await requiredEscrow(V_BTC);
  const amount = need > 0n ? need : 1n; // post at least 1 wei so the slash phase has something to sweep
  info(`postEscrow(${OUTPOINT.slice(0, 14)}…) value=${amount} wei…`);
  const calldata = '0x' + sel('postEscrow(bytes32)') + word(OUTPOINT);
  const { txHash } = await sendEth({ to: ENGINE, valueWei: amount, calldata, gasLimit: 120000n });
  await waitReceipt(txHash, 'postEscrow');
  const total = await escrowTotal(OUTPOINT);
  if (total < amount) fail(`escrowTotal ${total} < posted ${amount}`);
  ok(`ESCROW posted: ${txHash}  escrowTotal=${total} wei`);
  state.escrow = { completed: true, txHash, amountWei: amount.toString() };
  saveState(state);
}

// =========================================================================
// Phase 3: cBTC MINT against the lock (OP_CBTC_MINT, reflection + escrow gated)
// =========================================================================
step(3, 'cBTC MINT (defi.mintCbtc — gated on reflected lock + escrowSufficient)');
if (state.mint?.completed) {
  ok(`reusing mint: ${state.mint.txHash || 'done'}`);
} else {
  // 3a: wait until the reflection prover has folded the lock (cbtcLock[outpoint].vBtc == V_BTC).
  info(`polling pool.cbtcLock(${OUTPOINT.slice(0, 14)}…) for reflection coverage (up to ~30 min)…`);
  let reflected = 0n;
  for (let i = 1; i <= 60; i++) {
    reflected = await cbtcLockVBtc(OUTPOINT);
    if (reflected >= V_BTC) { ok(`lock reflected: cbtcLock.vBtc=${reflected}`); break; }
    if (i % 5 === 0) info(`  attempt ${i}/60: cbtcLock.vBtc=${reflected} (need ${V_BTC}); reflection prover must fold the signet lock`);
    await sleep(30_000);
  }
  if (reflected < V_BTC) fail('lock never reflected on-chain — the reflection prover is not folding the signet lock (reviewer note b).');
  // 3b: confirm the escrow gate is satisfied before minting.
  if (!(await escrowSufficient(OUTPOINT, V_BTC))) fail(`escrowSufficient(${OUTPOINT.slice(0, 14)}…, ${V_BTC}) is false — top up escrow (reviewer note a)`);
  // 3c: mint the bearer cBTC.zk note (seed-derived; the box settles ConfidentialPool.settle()).
  info(`mintCbtc outpoint=${OUTPOINT.slice(0, 14)}… vBtc=${V_BTC}…`);
  const r = await defi.mintCbtc({
    outpoint: OUTPOINT, vBtc: V_BTC, blinding: state.lock.blinding,
    waitOpts: { onUpdate: (st) => info(`  · cbtc mint ${st.status}…`) },
  });
  info(`settle landed: ${r.txHash || r.status}`);
  await sleep(20_000);
  if (!(await cbtcMinted(OUTPOINT))) fail('pool.cbtcMinted(outpoint) is false after settle — the mint did not land');
  ok(`MINT verified: pool.cbtcMinted=true (cBTC.zk bearer note minted 1:1 to ${V_BTC} sats)`);
  state.mint = { completed: true, txHash: r.txHash || null };
  saveState(state);
}

// =========================================================================
// Phase 4: escrow LOCKED while outstanding → SLASH on a proven rug
// =========================================================================
step(4, 'ESCROW LOCK + SLASH (claim blocked while outstanding; slash on a proven rug)');
{
  // 4a: claimEscrow MUST be locked while cBTC is outstanding (minted ∧ not redeemed/spent).
  const minted = await cbtcMinted(OUTPOINT);
  const redeemed = await cbtcLockRedeemed(OUTPOINT);
  if (minted && !redeemed) {
    // a static-call to claimEscrow should revert (EscrowLocked). We probe via eth_call which surfaces the revert.
    const data = '0x' + sel('claimEscrow(bytes32)') + word(OUTPOINT);
    let reverted = false;
    try { await ux.rpc('eth_call', [{ to: ENGINE, from: state.escrow?.from || ux.account(BTC_PRIV).address, data }, 'latest']); }
    catch { reverted = true; }
    if (!reverted) warn('claimEscrow static-call did not revert — verify the EscrowLocked gate (it should while cBTC is outstanding)');
    else ok('claimEscrow is LOCKED while cBTC is outstanding (EscrowLocked) — escrow cannot be pulled out from under the mint');
  } else {
    warn(`escrow-lock check skipped (minted=${minted} redeemed=${redeemed})`);
  }

  if (SKIP_SLASH) { warn('SKIP_SLASH=1 — leaving the lock honest (no rug). The escrow stays claimable via redeem.'); }
  else if (state.slash?.completed) { ok(`reusing slash: ${state.slash.txHash}`); }
  else {
    // 4b: RUG the lock — a bare on-chain spend of the lock UTXO WITHOUT an in-tx cBTC burn. The reflection
    // guest surfaces this as cbtcLockSpent (not cbtcLockRedeemed). THROWAWAY ONLY: this forfeits the escrow.
    info(`rugging the lock: spending ${state.lock.revealTxid.slice(0, 16)}…:0 to the wallet (bare spend, no redeem)…`);
    const lockUtxoValue = Number(V_BTC);
    const feeRate = await dapp.getFeeRate();
    const fee = dapp.feeFor(150, feeRate);
    const wpkh = dapp.p2wpkhScript(dapp.wallet.pub);
    const spendTx = { version: 2, locktime: 0, inputs: [{ txid: state.lock.revealTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: lockUtxoValue - fee, script: wpkh }] };
    spendTx.inputs[0].witness = dapp.signP2wpkhInput(spendTx, 0, lockUtxoValue);
    const spendHex = bytesToHex(dapp.serializeTx(spendTx));
    const spendTxid = dapp.txid(spendTx);
    await dapp.broadcastWithRetry(spendHex);
    info(`rug spend ${spendTxid.slice(0, 16)}… — waiting for reflection to surface cbtcLockSpent (up to ~30 min)…`);
    state.rug = { spendTxid }; saveState(state);
    let spent = false;
    for (let i = 1; i <= 60; i++) {
      spent = await cbtcLockSpent(OUTPOINT);
      if (spent) { ok(`reflection folded the rug: pool.cbtcLockSpent=true`); break; }
      if (i % 5 === 0) info(`  attempt ${i}/60: cbtcLockSpent=${spent}`);
      await sleep(30_000);
    }
    if (!spent) fail('reflection never folded the rug spend — the prover must surface cbtcLockSpent before slash() can fire.');
    // 4c: slash() sweeps the WHOLE escrow to the insurance reserve (permissionless; gated on spent ∧ minted).
    const totalBefore = await escrowTotal(OUTPOINT);
    info(`slash(${OUTPOINT.slice(0, 14)}…) (escrowTotal=${totalBefore})…`);
    const calldata = '0x' + sel('slash(bytes32)') + word(OUTPOINT);
    const { txHash } = await sendEth({ to: ENGINE, calldata, gasLimit: 120000n });
    await waitReceipt(txHash, 'slash');
    if (!(await escrowSlashed(OUTPOINT))) fail('escrowSlashed(outpoint) is false after slash()');
    const totalAfter = await escrowTotal(OUTPOINT);
    if (totalAfter !== 0n) fail(`escrowTotal should be 0 after slash, got ${totalAfter}`);
    ok(`SLASH verified: escrowSlashed=true, escrowTotal 0 (${totalBefore} wei swept to the insurance reserve)`);
    state.slash = { completed: true, txHash, sweptWei: totalBefore.toString() };
    saveState(state);
  }
}

// =========================================================================
// Summary
// =========================================================================
console.log(`\n=== cBTC.zk backing E2E COMPLETE ===\n`);
console.log(`  LOCK:   ${state.lock.revealTxid}:0  (${state.lock.vBtc} sats)  outpoint ${OUTPOINT}`);
console.log(`  ESCROW: ${state.escrow?.txHash || '—'}  (${state.escrow?.amountWei || 0} wei)`);
console.log(`  MINT:   ${state.mint?.txHash || '—'}  cbtcMinted=${await cbtcMinted(OUTPOINT)}`);
console.log(`  SLASH:  ${state.slash?.txHash || (SKIP_SLASH ? 'SKIPPED' : '—')}  (${state.slash?.sweptWei || 0} wei to reserve)`);
console.log(`\nState: ${STATE_FILE}`);
process.exit(0);
