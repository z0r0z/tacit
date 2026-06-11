#!/usr/bin/env node
// Hosted multi-bid watchtower orchestrator (ops/PLAN-hosted-watchtower-render.md).
//
// Runs as a Render Background Worker. Reads the bids buyers registered via
// POST /watchtower/bids (stored in REGISTRY_KV, shared with tacit-api over the
// same Postgres), and for each active bid decrypts the dedicated key, runs ONE
// poll cycle through the shared per-bid engine (fulfiller/watchtower-core.mjs),
// and persists progress back to KV. Bids are processed serially because the
// dapp keeps a single global wallet — watchtower-core binds it per bid.
//
// Trust boundary (ops doc): the orchestrator holds only the dedicated bid keys
// (decrypted in-process from ciphertext-at-rest), each bounded to the funding a
// buyer chose to commit and self-reclaimable. The service decryption key lives
// only in WATCHTOWER_SERVICE_SK.
//
// Env: WATCHTOWER_SERVICE_SK (hex64, required), WATCHTOWER_NETWORK,
// WATCHTOWER_API_BASE, WATCHTOWER_TICK_SEC, WATCHTOWER_MIN_BID_SATS,
// WATCHTOWER_CLAIM_TIMEOUT_SEC, WATCHTOWER_MAX_BID_PRICE_SATS (pilot cap, 0=off),
// DATABASE_URL (Postgres; in-memory if unset), PORT (health endpoint).

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';
import { createKVNamespace } from '../server/kv-store.mjs';
import { createMemDriver } from '../server/driver-mem.mjs';
import { runTick } from './watchtower-core.mjs';
import { decryptBidKeyWithService, pubkeyFor, servicePubFromSk } from './watchtower-crypto.mjs';

const NETWORK = process.env.WATCHTOWER_NETWORK || 'signet';
const API_BASE = (process.env.WATCHTOWER_API_BASE || 'https://api.tacit.finance').replace(/\/+$/, '');
const SERVICE_SK_HEX = (process.env.WATCHTOWER_SERVICE_SK || '').toLowerCase().trim();
const TICK_SEC = Number(process.env.WATCHTOWER_TICK_SEC || 60);
const MIN_BID_WALLET_SATS = Number(process.env.WATCHTOWER_MIN_BID_SATS || 1000);
const CLAIM_FULFIL_TIMEOUT_SEC = Number(process.env.WATCHTOWER_CLAIM_TIMEOUT_SEC || 360);
const MAX_BID_PRICE_SATS = Number(process.env.WATCHTOWER_MAX_BID_PRICE_SATS || 0); // pilot cap; 0 = off
const PORT = Number(process.env.PORT || 8788);

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

if (!/^[0-9a-f]{64}$/.test(SERVICE_SK_HEX)) {
  console.error('WATCHTOWER_SERVICE_SK must be 64 hex chars (the service decryption key)');
  process.exit(1);
}
const SERVICE_SK = hexToBytes(SERVICE_SK_HEX);
if (NETWORK !== 'signet' && NETWORK !== 'mainnet') { console.error('WATCHTOWER_NETWORK must be signet|mainnet'); process.exit(1); }

// ---- storage (Postgres in prod, in-memory locally — mirrors server/index.mjs) ----
const driver = process.env.DATABASE_URL
  ? await (await import('../server/driver-pg.mjs')).createPgDriver(process.env.DATABASE_URL)
  : createMemDriver();
const kv = createKVNamespace(driver, 'REGISTRY_KV');
const KEY_PREFIX = `wtbid:${NETWORK}:`;

// ---- jsdom + dapp (network set before load so NET initializes) ----
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
// Node 21+ exposes a read-only built-in `navigator`; assigning throws there.
// The built-in is fine for the headless dapp (SW registration is skipped), so
// only set jsdom's when the slot is writable (older Node).
try { globalThis.navigator = dom.window.navigator; } catch { /* read-only built-in navigator — keep it */ }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.__TACIT_WORKER_BASE__ = API_BASE;
globalThis.localStorage.setItem('tacit-network-v1', NETWORK);
// The dapp fires UI renders from claim/take tails; under jsdom a missing
// element rejects in a timer no sync try/catch sees. Every settlement step is
// awaited with its own handling in watchtower-core, so a stray UI rejection is
// never on the settlement path — log and keep the orchestrator alive.
process.on('unhandledRejection', (err) => log('warn', 'swallowed unhandled rejection (headless UI side-effect)', { err: String(err?.message || err) }));

const DAPP_PATH = resolve(new URL('.', import.meta.url).pathname, '../dapp/tacit.js');
const m = await import('file://' + DAPP_PATH);
log('info', 'hosted watchtower booting', { network: NETWORK, api: API_BASE, service_pub: servicePubFromSk(SERVICE_SK), tick_sec: TICK_SEC, storage: process.env.DATABASE_URL ? 'postgres' : 'memory' });

function addressFor(pub) {
  return bech32.encode(NETWORK === 'mainnet' ? 'bc' : 'tb', [0, ...bech32.toWords(ripemd160(sha256(pub)))]);
}
// The bid's limit unit price = total price / total whole-token amount. The
// watchtower takes asks at or below this; the cumulative cap is the bid amount.
function unitPriceCeil(rec) {
  const whole = Number(BigInt(rec.bid_amount_base)) / Math.pow(10, rec.decimals | 0);
  return whole > 0 ? Number(rec.bid_price_sats) / whole : 0;
}

// Build the per-bid engine context from a registration record. Returns null if
// the record can't be serviced (decrypt failure or pubkey mismatch — the latter
// means a tampered/forged ciphertext, which the cross-check below rejects).
function ctxForBid(rec) {
  let bidPriv;
  try { bidPriv = decryptBidKeyWithService(rec.enc_bid_privkey, SERVICE_SK, hexToBytes(rec.owner_pubkey), rec.asset_id, rec.bid_id); }
  catch (e) { log('warn', 'skip bid: key decrypt failed', { bid_id: rec.bid_id, err: e.message }); return null; }
  const bidPub = pubkeyFor(bidPriv);
  if (bytesToHex(bidPub) !== rec.bid_pubkey) {
    log('warn', 'skip bid: decrypted pubkey != registered bid_pubkey (record tampered)', { bid_id: rec.bid_id });
    return null;
  }
  return {
    dapp: m,
    workerBase: API_BASE,
    network: NETWORK,
    assetId: rec.asset_id,
    decimals: rec.decimals | 0,
    priv: bidPriv,
    pub: bidPub,
    pubHex: rec.bid_pubkey,
    h160: bytesToHex(ripemd160(sha256(bidPub))),
    address: addressFor(bidPub),
    maxUnitPriceSats: unitPriceCeil(rec),
    maxTotalFillBase: (() => { try { return BigInt(rec.bid_amount_base); } catch { return 0n; } })(),
    claimFulfilTimeoutSec: CLAIM_FULFIL_TIMEOUT_SEC,
    minBidWalletSats: MIN_BID_WALLET_SATS,
    dryRun: false,
    log: (lvl, msg, extra = {}) => log(lvl, msg, { bid_id: rec.bid_id, ...extra }),
  };
}

// ---- health endpoint ----
let lastCycleAt = null, lastActive = 0, lastError = null;
createServer((req, res) => {
  if ((req.url || '').startsWith('/watchtower-health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, network: NETWORK, service_pub: servicePubFromSk(SERVICE_SK),
      last_cycle_at: lastCycleAt, active_bids: lastActive, last_error: lastError,
    }));
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => log('info', 'health endpoint up', { port: PORT }));

// ---- one cycle over all registered bids ----
async function cycle() {
  const now = Math.floor(Date.now() / 1000);
  let active = 0;
  let cursor = null;
  do {
    const page = await kv.list({ prefix: KEY_PREFIX, cursor });
    cursor = page.list_complete ? null : page.cursor;
    for (const k of page.keys) {
      const rec = await kv.get(k.name, 'json');
      if (!rec || rec.status !== 'active') continue;
      if (Number(rec.expiry || 0) <= now) continue;
      if (MAX_BID_PRICE_SATS > 0 && Number(rec.bid_price_sats) > MAX_BID_PRICE_SATS) {
        log('warn', 'skip bid: exceeds pilot per-bid cap', { bid_id: rec.bid_id, bid_price_sats: rec.bid_price_sats });
        continue;
      }
      const ctx = ctxForBid(rec);
      if (!ctx) continue;
      active++;
      const coreState = {
        filledBase: (() => { try { return BigInt(rec.filled_base || '0'); } catch { return 0n; } })(),
        processed: rec.processed_intents || {},
      };
      const persist = async (st) => {
        rec.filled_base = st.filledBase.toString();
        rec.processed_intents = st.processed;
        if (ctx.maxTotalFillBase > 0n && st.filledBase >= ctx.maxTotalFillBase) rec.status = 'filled';
        await kv.put(k.name, JSON.stringify(rec), { expiration: rec.expiry });
      };
      try {
        const r = await runTick(ctx, coreState, { persist });
        if (r.fills) log('info', 'bid filled this cycle', { bid_id: rec.bid_id, fills: r.fills, filled_base: coreState.filledBase.toString() });
      } catch (e) { log('error', 'bid tick threw', { bid_id: rec.bid_id, err: e.message }); }
    }
  } while (cursor);
  lastCycleAt = new Date().toISOString();
  lastActive = active;
  return active;
}

// ---- main loop ----
let shutdown = false;
process.on('SIGINT', () => { log('info', 'SIGINT — finishing'); shutdown = true; });
process.on('SIGTERM', () => { log('info', 'SIGTERM — finishing'); shutdown = true; });
log('info', 'orchestrator active', { interval_sec: TICK_SEC });
while (!shutdown) {
  try { const n = await cycle(); log('info', 'cycle complete', { active_bids: n }); lastError = null; }
  catch (e) { log('error', 'cycle threw', { err: e.message }); lastError = e.message; }
  for (let s = 0; s < TICK_SEC && !shutdown; s++) await new Promise((r) => setTimeout(r, 1000));
}
log('info', 'shutdown clean');
process.exit(0);
