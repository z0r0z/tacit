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
import { bech32, bech32m } from '@scure/base';
import { runTick } from './watchtower-core.mjs';

// ---- CLI ----
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const CONFIG_PATH = arg('--config', './watchtower-config.json');
const DRY_RUN = flag('--dry-run');
const ONCE = flag('--once');
// --reclaim <addr>: sweep the bid wallet's spendable sats back to <addr> and
// exit. Self-reclaim path — the bid wallet is the buyer's own key, so this is
// a normal send. Asset UTXOs are excluded (selectSatsUtxosSafe), so a partially
// filled bid keeps its bought tokens.
const RECLAIM_DEST = arg('--reclaim', null);

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

// Safety net: the dapp fires UI renders (renderMarket, toasts, panel refreshes)
// from setTimeout tails of the claim/take flows. Those are async and assume a
// browser DOM; under jsdom a missing element rejects in a timer the caller's
// sync try/catch can't see. Every critical step (claim/take) is awaited with
// its own error handling below, so a stray fire-and-forget UI rejection is
// never on the settlement path — log it and keep the daemon alive rather than
// letting Node's default unhandled-rejection exit kill an in-flight fill.
process.on('unhandledRejection', (err) => {
  log('warn', 'swallowed unhandled rejection (headless UI side-effect)', { err: String(err?.message || err) });
});

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

// ---- state (watchtower-core shape: { filledBase: bigint, processed: {} }) ----
const coreState = { filledBase: 0n, processed: {} };
if (existsSync(STATE_PATH)) {
  try {
    const loaded = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    coreState.filledBase = (() => { try { return BigInt(loaded.filled_base || '0'); } catch { return 0n; } })();
    coreState.processed = loaded.processed_intents || {};
  } catch (e) { log('warn', 'state unreadable, starting fresh', { err: e.message }); }
}
function saveState() {
  const json = { filled_base: coreState.filledBase.toString(), processed_intents: coreState.processed };
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(json, null, 2));
  renameSync(tmp, STATE_PATH);
}

// ---- per-bid engine context (shared core; same logic as the orchestrator) ----
const ctx = {
  dapp: m,
  workerBase: WORKER_BASE,
  network: NETWORK,
  assetId: ASSET_ID,
  decimals: DECIMALS,
  priv: privBytes,
  pub: m.wallet.pub,
  pubHex: PUB_HEX,
  h160: OUR_H160,
  address: ADDR,
  maxUnitPriceSats: MAX_UNIT_PRICE_SATS,
  maxTotalFillBase: MAX_TOTAL_FILL_BASE,
  claimFulfilTimeoutSec: CLAIM_FULFIL_TIMEOUT_SEC,
  minBidWalletSats: MIN_BID_WALLET_SATS,
  dryRun: DRY_RUN,
  log,
};

// ---- one tick (delegates to the shared per-bid engine) ----
async function tick() {
  const r = await runTick(ctx, coreState, { persist: saveState });
  return r.fills || 0;
}

// ---- reclaim: sweep spendable sats back to a destination address ----
function addressToScript(addr) {
  const hrp = NETWORK === 'mainnet' ? 'bc' : 'tb';
  let ver, prog;
  try {
    const d = bech32.decode(addr);
    if (d.prefix !== hrp) throw new Error('hrp');
    ver = d.words[0];
    if (ver !== 0) throw new Error('v0-only via bech32'); // witness v1+ is bech32m
    prog = bech32.fromWords(d.words.slice(1));
  } catch {
    const d = bech32m.decode(addr);
    if (d.prefix !== hrp) throw new Error(`address is not a ${hrp} (${NETWORK}) address`);
    ver = d.words[0];
    prog = bech32m.fromWords(d.words.slice(1));
  }
  const p = Uint8Array.from(prog);
  const op = ver === 0 ? 0x00 : (0x50 + ver); // OP_0 / OP_1..OP_16
  return Uint8Array.from([op, p.length, ...p]);
}

async function reclaim(dest) {
  if (dest === ADDR) throw new Error('refusing self-reclaim: dest equals the bid wallet address');
  const destScript = addressToScript(dest);
  const holdings = await m.scanHoldings(true);
  const allUtxos = await m.getUtxos(ADDR);
  const inputs = m.selectSatsUtxosSafe(allUtxos, holdings);
  if (!inputs.length) { log('info', 'reclaim: no spendable sats UTXOs'); return; }
  const totalIn = inputs.reduce((s, u) => s + u.value, 0);
  const feeRate = await m.getFeeRate();
  const fee = m.feeFor(m.estSatsSendVb(inputs.length, false), feeRate);
  if (totalIn <= fee + 330) throw new Error(`balance ${totalIn} too small to reclaim at ${feeRate} sat/vB (fee ${fee})`);
  const recipientValue = totalIn - fee;
  log('info', 'reclaim plan', { inputs: inputs.length, total_in: totalIn, fee, send: recipientValue, dest });
  if (DRY_RUN) { log('info', 'DRY RUN — not broadcasting'); return; }
  const tx = m.buildSatsSendTx({ inputs, recipientScript: destScript, recipientValue, changeScript: destScript, changeValue: 0 });
  for (let i = 0; i < tx.inputs.length; i++) tx.inputs[i].witness = m.signP2wpkhInput(tx, i, inputs[i].value);
  const txHex = bytesToHex(m.serializeTx(tx));
  const sentTxid = m.txid(tx);
  await m.broadcastWithRetry(txHex);
  log('info', 'reclaim broadcast', { txid: sentTxid, sats: recipientValue, dest });
}

// ---- main ----
let shutdown = false;
if (RECLAIM_DEST) {
  await reclaim(RECLAIM_DEST);
  process.exit(0);
}
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
