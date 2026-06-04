// Silent-payment consolidation e2e — signet.
//
// Reproduces the bridge-fee funding shape: a wallet whose ONLY funds are a
// single 5,000-sat BIP-352 silent-payment credit (static address balance 0),
// then drives the real ensureSatsFunded gate the bridge deposit button calls
// and asserts it consolidates the credit to the static address and returns
// true. Exercises, on-chain:
//
//   1. faucet-fund a sender wallet B
//   2. B → buildAndBroadcastSatsSend(5000 sats → A's sp1q… address)
//   3. A → discoverSilentPaymentFromTxid (records the credit + tweak)
//   4. A → ensureSatsFunded(need, 'Bridging ETH') with the consolidation
//      confirm auto-accepted — and ONLY that confirm; the faucet-drip offer
//      is rejected so a missed consolidation fails loudly instead of
//      funding through another path
//   5. assert A's static address now holds ≥ need sats and the SP outpoint
//      is spent
//
// Resumable: state at .local/sp-consol-e2e-state.json (wallet keys + phase
// txids). To start over: rm .local/sp-consol-e2e-state.json
//
// Run:  cd tests && node sp-consolidation-e2e-signet.mjs

import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const dom = new JSDOM('<!doctype html><html><body><div id="toast-container"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

// Confirm stub: accept ONLY the silent-credit consolidation prompt. Anything
// else (faucet drip, ext-wallet funding) is declined so the test can't pass
// through an unintended funding path.
const confirms = [];
globalThis.confirm = (msg) => {
  confirms.push(msg);
  const isConsolidate = /consolidate/i.test(msg || '');
  console.log(`  [confirm] ${isConsolidate ? 'ACCEPT' : 'DECLINE'}: ${String(msg).split('\n')[0]}`);
  return isConsolidate;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'sp-consol-e2e-state.json');

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function info(msg) { console.log(`  ${msg}`); }
function step(n, msg) { console.log(`\n--- Phase ${n}: ${msg} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const dapp = await import('../dapp/tacit.js');

const state = loadState();
if (!state.privA) {
  state.privA = bytesToHex(secp.utils.randomPrivateKey());
  saveState(state);
}
if (!state.privB) {
  // Sender: reuse the funded amm-signet wallet when available (the shared
  // faucet runs dry); else fresh key + faucet drip in Phase 1.
  try {
    const W = JSON.parse(readFileSync(path.join(STATE_DIR, 'amm-signet-wallet.json'), 'utf8'));
    if (W.priv_hex) { state.privB = W.priv_hex; info('sender: reusing .local/amm-signet-wallet.json'); }
  } catch {}
  if (!state.privB) state.privB = bytesToHex(secp.utils.randomPrivateKey());
  saveState(state);
}
const PRIV_A = hexToBytes(state.privA);
const PRIV_B = hexToBytes(state.privB);

function useWallet(priv) {
  dapp.wallet.priv = priv;
  dapp.wallet.pub = secp.getPublicKey(priv, true);
  dapp.invalidateHoldingsCache();
  try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(dapp.wallet.pub), '1'); } catch {}
  return dapp.wallet.address();
}

const ADDR_A = useWallet(PRIV_A);
const SP_ADDR_A = dapp.walletSilentPaymentAddress();
const ADDR_B = useWallet(PRIV_B);

const SEND_SATS = 5000;   // mirror the reported account exactly
const ESPLORA = 'https://mempool.space/signet/api';

async function utxosOf(addr) {
  const r = await fetch(`${ESPLORA}/address/${addr}/utxo`);
  if (!r.ok) throw new Error(`esplora ${r.status}`);
  return r.json();
}
async function balanceOf(addr) {
  return (await utxosOf(addr)).reduce((a, u) => a + u.value, 0);
}
async function waitForBalance(addr, min, label, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let bal = 0;
    try { bal = await balanceOf(addr); } catch {}
    if (bal >= min) return bal;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${label} (${addr}) to reach ${min} sats`);
}

console.log(`\n=== silent-payment consolidation e2e (signet) ===\n`);
info(`wallet A (receiver): ${ADDR_A}`);
info(`A silent address:    ${SP_ADDR_A.slice(0, 28)}…`);
info(`wallet B (sender):   ${ADDR_B}`);

// --- Phase 1: fund sender B via faucet -------------------------------------
step(1, 'fund sender wallet B');
let balB = 0;
try { balB = await balanceOf(ADDR_B); } catch {}
if (balB >= SEND_SATS + 2000) {
  ok(`B already funded: ${balB} sats`);
} else {
  const WORKER_BASE = process.env.TACIT_WORKER_BASE || 'https://tacit-pin.rosscampbell9.workers.dev';
  const resp = await fetch(`${WORKER_BASE}/drip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: ADDR_B }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) fail(`faucet drip failed: HTTP ${resp.status} ${JSON.stringify(j)}`);
  info(`drip sent: ${j.amount_sats} sats (tx ${String(j.txid || '').slice(0, 12)}…)`);
  balB = await waitForBalance(ADDR_B, SEND_SATS + 2000, 'sender B');
  ok(`B funded: ${balB} sats`);
}

// --- Phase 2: B sends 5000 sats to A's silent-payment address --------------
step(2, `B → ${SEND_SATS} sats → A's sp1 address`);
if (state.spSendTxid) {
  ok(`already sent: ${state.spSendTxid}`);
} else {
  useWallet(PRIV_B);
  const res = await dapp.buildAndBroadcastSatsSend({ recipientAddr: SP_ADDR_A, amountSats: SEND_SATS });
  state.spSendTxid = res.txid;
  saveState(state);
  ok(`silent payment broadcast: ${res.txid} (fee ${res.fee} sats)`);
}

// --- Phase 3: A discovers + records the credit ------------------------------
step(3, 'A scans the tx and records the SP credit');
useWallet(PRIV_A);
// getTx needs the tx indexed; poll briefly.
let discovered = null;
for (let i = 0; i < 20 && !discovered; i++) {
  try {
    const d = await dapp.discoverSilentPaymentFromTxid(state.spSendTxid);
    if (d && d.length) discovered = d;
  } catch (e) { info(`discover retry (${e.message})`); }
  if (!discovered) await sleep(3000);
}
if (!discovered) fail('discoverSilentPaymentFromTxid found no credit after 60s');
const credits = dapp.loadSpCredits();
const entries = Object.entries(credits);
if (!entries.length) fail('loadSpCredits empty after discover');
const [creditKey, credit] = entries[0];
if (Number(credit.sats) !== SEND_SATS) fail(`credit sats ${credit.sats} ≠ ${SEND_SATS}`);
if (!credit.tweakHex) fail('credit missing tweakHex');
ok(`credit recorded: ${creditKey.slice(0, 16)}… = ${credit.sats} sats (tweak ${credit.tweakHex.slice(0, 12)}…)`);

const staticBalBefore = await balanceOf(ADDR_A).catch(() => 0);
if (staticBalBefore !== 0) info(`note: A static balance is ${staticBalBefore}, expected 0 — continuing`);

// --- Phase 4: the bridge gate — ensureSatsFunded with consolidation --------
step(4, 'ensureSatsFunded (the bridge deposit gate)');
const feeRate = await dapp.getFeeRate('priority');
const need = Math.max(2500, dapp.DUST + dapp.feeFor(800, feeRate) + 1000);
info(`priority fee rate ${feeRate} sat/vB → need = ${need} sats (gate formula)`);
if (5000 < need + 1000) {
  fail(`signet fee rate too high for the 5000-sat fixture (need+1000 = ${need + 1000}); cannot exercise the consolidation margin`);
}
const t0 = Date.now();
const funded = await dapp.ensureSatsFunded(need, 'Bridging ETH');
info(`ensureSatsFunded returned ${funded} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!confirms.some(m => /consolidate/i.test(m))) {
  fail(`consolidation confirm never appeared. Confirms seen: ${JSON.stringify(confirms)}`);
}
if (!funded) fail('ensureSatsFunded returned false — consolidation did not complete');
ok('consolidation offered, accepted, and gate passed');

// --- Phase 5: verify on-chain state ----------------------------------------
step(5, 'verify chain state');
const utxosA = await utxosOf(ADDR_A);
const balA = utxosA.reduce((a, u) => a + u.value, 0);
info(`A static address UTXOs: ${utxosA.map(u => u.value).join(' + ')} = ${balA} sats`);
if (balA < need) fail(`A static balance ${balA} < need ${need}`);
const [spTxid, spVout] = creditKey.split(':');
const outspend = await fetch(`${ESPLORA}/tx/${spTxid}/outspend/${spVout}`).then(r => r.json());
if (!outspend.spent) fail('SP outpoint still unspent — consolidation tx did not spend the credit');
ok(`SP outpoint spent by ${String(outspend.txid).slice(0, 12)}… ; A consolidated balance ${balA} sats ≥ need ${need}`);
const burned = SEND_SATS + staticBalBefore - balA;
info(`consolidation fee burned: ${burned} sats`);

console.log(`\n=== PASS — silent-payment credit funds the bridge gate end-to-end ===\n`);
process.exit(0);
