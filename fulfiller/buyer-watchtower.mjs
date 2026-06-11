#!/usr/bin/env node
// Buyer-side watchtower for resting limit bids.
//
// Completes fills for a buyer who has posted a bid and walked away. It runs as
// a dedicated "bid wallet" key, watches for seller atomic-intents that target
// that key, and — for any that match the bid's price/size policy — claims and
// takes them. The take is a normal taker settlement: the buyer's sats input is
// signed SIGHASH_ALL over the full assembled tx (handled inside
// takeAxferIntent -> takeAxferOffer), so the signature is bound to one exact
// settlement that delivers the asset to the buyer. It is not a reusable
// authorization and cannot be redirected.
//
// Trust boundary (bounded, opt-in, self-reclaimable):
//   - Holds the dedicated bid-wallet key ONLY. The buyer funds that key with
//     just the bid amount; the main wallet key is never given to this process.
//   - Worst case (this process compromised): exposure is capped at the
//     dedicated bid wallet's balance — the amount the buyer chose to commit.
//   - Verify-before-take: every fill is gated by verifyAxferOffer (delivers to
//     our pubkey + on-chain Pedersen opening binds the claimed amount) AND a
//     bid-policy gate (unit price <= limit, cumulative <= max fill, not expired)
//     before any sats are spent.
//   - Self-reclaim: the bid wallet is the buyer's own key; reclaiming unspent
//     funds is a normal send. Nothing here locks funds irreversibly.
//
// Architecture: imports dapp/tacit.js under a jsdom shim and drives the same
// taker path the browser does — no crypto or tx-building reimplementation.
//
// STATUS: v1 — NOT yet signet-validated end to end. Run with --dry-run first,
// then on signet against a live seller before any mainnet use.
//
// Usage:
//   node buyer-watchtower.mjs --config ./watchtower-config.json [--once] [--dry-run]

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';

// ---- CLI ----
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const CONFIG_PATH = arg('--config', './watchtower-config.json');
const DRY_RUN = flag('--dry-run');
const ONCE = flag('--once');

if (!existsSync(CONFIG_PATH)) {
  console.error(`config not found: ${CONFIG_PATH}`);
  console.error('Sample shape:');
  console.error(JSON.stringify({
    bid_wallet_privkey: 'hex64 (or set TACIT_BID_WALLET_PRIVKEY env var)',
    worker_base: 'https://api.tacit.finance',
    network: 'signet',
    asset_id: 'hex64 — the asset being bought',
    max_unit_price_sats: 220,          // hard ceiling: sats per WHOLE token
    max_total_fill_base: '100000000',  // cumulative cap in BASE units
    decimals: 8,
    interval_sec: 60,
    claim_fulfil_timeout_sec: 600,     // how long to wait for the seller to fulfil after we claim
    min_bid_wallet_sats: 1000,         // refuse to act below this (keeps a fee buffer)
  }, null, 2));
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const PRIV = (process.env.TACIT_BID_WALLET_PRIVKEY || cfg.bid_wallet_privkey || '').toLowerCase().trim();
if (!/^[0-9a-f]{64}$/.test(PRIV)) {
  console.error('bid_wallet_privkey must be 64 hex chars (env TACIT_BID_WALLET_PRIVKEY or config field)');
  process.exit(1);
}
const WORKER_BASE = (cfg.worker_base || 'https://api.tacit.finance').replace(/\/+$/, '');
const NETWORK = cfg.network || 'signet';
if (NETWORK !== 'signet' && NETWORK !== 'mainnet') { console.error('network must be signet|mainnet'); process.exit(1); }
const ASSET_ID = String(cfg.asset_id || '').toLowerCase();
if (!/^[0-9a-f]{64}$/.test(ASSET_ID)) { console.error('asset_id must be 64 hex chars'); process.exit(1); }
const MAX_UNIT_PRICE_SATS = Number(cfg.max_unit_price_sats);
if (!Number.isFinite(MAX_UNIT_PRICE_SATS) || MAX_UNIT_PRICE_SATS <= 0) { console.error('max_unit_price_sats must be > 0'); process.exit(1); }
const MAX_TOTAL_FILL_BASE = BigInt(cfg.max_total_fill_base || '0');
const DECIMALS = Number.isInteger(cfg.decimals) ? cfg.decimals : 0;
const INTERVAL_SEC = Number.isInteger(cfg.interval_sec) ? cfg.interval_sec : 60;
const CLAIM_FULFIL_TIMEOUT_SEC = Number.isInteger(cfg.claim_fulfil_timeout_sec) ? cfg.claim_fulfil_timeout_sec : 600;
const MIN_BID_WALLET_SATS = Number.isInteger(cfg.min_bid_wallet_sats) ? cfg.min_bid_wallet_sats : 1000;
const STATE_PATH = resolve(cfg.state_path || `./watchtower-state-${ASSET_ID.slice(0, 12)}.json`);

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

// ---- jsdom + dapp import (network set before load so NET initializes) ----
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.__TACIT_WORKER_BASE__ = WORKER_BASE;
globalThis.localStorage.setItem('tacit-network-v1', NETWORK);

const DAPP_PATH = resolve(new URL('.', import.meta.url).pathname, '../dapp/tacit.js');
log('info', 'booting watchtower', { config: CONFIG_PATH, network: NETWORK, asset_id: ASSET_ID, dry_run: DRY_RUN });
const m = await import('file://' + DAPP_PATH);

// ---- wallet = the dedicated bid key ----
const privBytes = hexToBytes(PRIV);
m.wallet.priv = privBytes;
m.wallet.pub = secp.getPublicKey(privBytes, true);
const PUB_HEX = bytesToHex(m.wallet.pub);
const OUR_H160 = bytesToHex(ripemd160(sha256(m.wallet.pub)));
const ADDR = bech32.encode(NETWORK === 'mainnet' ? 'bc' : 'tb', [0, ...bech32.toWords(ripemd160(sha256(m.wallet.pub)))]);
log('info', 'bid wallet loaded', { pubkey: PUB_HEX, address: ADDR });

// ---- state ----
let state = { filled_base: '0', processed_intents: {} };
if (existsSync(STATE_PATH)) {
  try {
    const loaded = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    state = { filled_base: loaded.filled_base || '0', processed_intents: loaded.processed_intents || {} };
  } catch (e) { log('warn', 'state unreadable, starting fresh', { err: e.message }); }
}
function saveState() {
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}
const filledBase = () => { try { return BigInt(state.filled_base || '0'); } catch { return 0n; } };

// ---- bid wallet sats balance ----
async function bidWalletSats() {
  try {
    const utxos = await m.getUtxos(ADDR);
    return utxos.reduce((s, u) => s + (u.value || 0), 0);
  } catch (e) { log('warn', 'getUtxos failed', { err: e.message }); return null; }
}

// ---- discovery: seller atomic-intents on the asset that target this bid wallet ----
async function fetchTargetingIntents() {
  const url = `${WORKER_BASE}/assets/${ASSET_ID}/atomic-intents?network=${encodeURIComponent(NETWORK)}`;
  let j;
  try { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); j = await r.json(); }
  catch (e) { log('warn', 'atomic-intents list failed', { err: e.message }); return []; }
  const intents = Array.isArray(j.intents) ? j.intents : (Array.isArray(j) ? j : []);
  const now = Math.floor(Date.now() / 1000);
  return intents.filter((it) => {
    if (!it || !it.intent_id) return false;
    if (Number(it.expiry || 0) <= now) return false;
    // Targets us: the worker stores intended_buyer_h160 for bid-flow intents.
    const tgt = String(it.intended_buyer_h160 || '').toLowerCase();
    const rcp = String(it.recipient_pubkey || '').toLowerCase();
    if (tgt && tgt !== OUR_H160) return false;
    if (!tgt && rcp && rcp !== PUB_HEX) return false;
    if (!tgt && !rcp) return false; // untargeted listing — not a fill for our bid
    return true;
  });
}

// ---- policy gate: unit price <= limit, cumulative within max fill ----
function policyOk(it) {
  let amt, price;
  try { amt = BigInt(it.amount); price = Number(it.price_sats); } catch { return { ok: false, reason: 'unparseable amount/price' }; }
  if (amt <= 0n || !Number.isFinite(price) || price <= 0) return { ok: false, reason: 'non-positive amount/price' };
  // unit price in sats per WHOLE token = price_sats / (amount / 10^decimals)
  const whole = Number(amt) / Math.pow(10, DECIMALS);
  const unit = whole > 0 ? price / whole : Infinity;
  if (unit > MAX_UNIT_PRICE_SATS) return { ok: false, reason: `unit price ${unit.toFixed(2)} > cap ${MAX_UNIT_PRICE_SATS}` };
  if (MAX_TOTAL_FILL_BASE > 0n && filledBase() + amt > MAX_TOTAL_FILL_BASE) {
    return { ok: false, reason: `would exceed max_total_fill (${filledBase() + amt} > ${MAX_TOTAL_FILL_BASE})` };
  }
  return { ok: true, amt, price };
}

// ---- one full fill: claim -> wait for seller fulfilment -> verify+take ----
async function attemptFill(it) {
  const intentIdHex = String(it.intent_id).toLowerCase();
  const priceSats = Number(it.price_sats);
  log('info', 'claiming targeting intent', { intent_id: intentIdHex, price_sats: priceSats, amount: it.amount });
  if (DRY_RUN) { log('info', 'DRY RUN — would claim + take', { intent_id: intentIdHex }); return { ok: false, dry: true }; }

  try { await m.claimAxferIntent({ assetIdHex: ASSET_ID, intentIdHex, priceSats }); }
  catch (e) { return { ok: false, reason: `claim failed: ${e.message}` }; }

  // Poll for the seller's fulfilment (partial_reveal). Bounded wait.
  const deadline = Date.now() + CLAIM_FULFIL_TIMEOUT_SEC * 1000;
  let fulfilment = null;
  while (Date.now() < deadline) {
    try {
      const f = await m.fetchAxferFulfilment({ assetIdHex: ASSET_ID, intentIdHex });
      const rec = f?.fulfilment || f;
      if (rec && rec.partial_reveal) { fulfilment = rec; break; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!fulfilment) return { ok: false, reason: 'seller did not fulfil within timeout' };

  // takeAxferIntent runs verifyAxferOffer (delivers to us + Pedersen binding)
  // then appends our sats input SIGHASH_ALL and broadcasts. We re-fetch the
  // intent record so takeAxferIntent has the canonical fields.
  let intentRec = it;
  try {
    const r = await fetch(`${WORKER_BASE}/assets/${ASSET_ID}/atomic-intents/${intentIdHex}?network=${encodeURIComponent(NETWORK)}`);
    if (r.ok) { const jj = await r.json(); intentRec = jj.intent || jj || it; }
  } catch { /* fall back to list record */ }

  try {
    const res = await m.takeAxferIntent({ intent: intentRec, fulfilment });
    return { ok: true, txid: res?.revealTxid || res?.txid || null };
  } catch (e) {
    return { ok: false, reason: `take failed: ${e.message}` };
  }
}

// ---- one tick ----
async function tick() {
  if (MAX_TOTAL_FILL_BASE > 0n && filledBase() >= MAX_TOTAL_FILL_BASE) {
    log('info', 'max fill reached — nothing to do', { filled_base: state.filled_base });
    return 0;
  }
  const sats = await bidWalletSats();
  if (sats != null && sats < MIN_BID_WALLET_SATS) {
    log('info', 'bid wallet below min — idling', { sats, min: MIN_BID_WALLET_SATS });
    return 0;
  }
  const intents = await fetchTargetingIntents();
  let fills = 0;
  for (const it of intents) {
    const id = String(it.intent_id).toLowerCase();
    if (state.processed_intents[id]) continue;
    const gate = policyOk(it);
    if (!gate.ok) { log('info', 'intent skipped by policy', { intent_id: id, reason: gate.reason }); continue; }
    const r = await attemptFill(it);
    if (r.ok) {
      state.processed_intents[id] = { txid: r.txid, at: Math.floor(Date.now() / 1000), amount: it.amount };
      state.filled_base = (filledBase() + gate.amt).toString();
      saveState();
      fills++;
      log('info', 'fill completed', { intent_id: id, txid: r.txid, filled_base: state.filled_base });
      m.invalidateHoldingsCache();
      if (MAX_TOTAL_FILL_BASE > 0n && filledBase() >= MAX_TOTAL_FILL_BASE) break;
    } else if (!r.dry) {
      // Mark transient failures processed only if the claim definitively can't
      // proceed; otherwise leave unprocessed to retry next tick.
      log('warn', 'fill attempt failed', { intent_id: id, reason: r.reason });
    }
  }
  return fills;
}

// ---- main ----
let shutdown = false;
process.on('SIGINT', () => { log('info', 'SIGINT — finishing'); shutdown = true; });
process.on('SIGTERM', () => { log('info', 'SIGTERM — finishing'); shutdown = true; });

if (ONCE) {
  const n = await tick();
  log('info', 'one-shot complete', { fills: n });
  process.exit(0);
} else {
  log('info', 'watchtower active', { interval_sec: INTERVAL_SEC });
  while (!shutdown) {
    try { const n = await tick(); log('info', 'tick complete', { fills: n }); }
    catch (e) { log('error', 'tick threw', { err: e.message }); }
    if (shutdown) break;
    for (let s = 0; s < INTERVAL_SEC && !shutdown; s++) await new Promise((r) => setTimeout(r, 1000));
  }
  log('info', 'shutdown clean');
  process.exit(0);
}
