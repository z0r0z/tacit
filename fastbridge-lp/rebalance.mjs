#!/usr/bin/env node
// Opt-in whole-note rebalancing from the provider's leased main-address notes to its derived reverse address.
// node fastbridge-lp/rebalance.mjs --dry-run

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const json = (value) => JSON.stringify(value, (key, v) => typeof v === 'bigint' ? v.toString() : v);

export async function main() {
  const DRY = process.argv.includes('--dry-run');
  const cfgPath = resolve(process.env.FB_LP_CONFIG || 'fastbridge-lp/config.json');
  const { applyEnv } = await import('./lib/env-config.mjs');
  let C;
  try { C = applyEnv(JSON.parse(readFileSync(cfgPath, 'utf8'))); } catch (e) { console.error(String((e && e.message) || e)); process.exitCode = 1; return; }
  const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.error('FB_LP_KEY must be 64 hex characters (set it in the environment)'); process.exitCode = 1; return; }
  delete process.env.FB_LP_KEY;
  const log = (o) => console.log(json({ ts: new Date().toISOString(), ...o }));
  const { parseRebalanceConfig, parseLeaseManifest, acquireProcessLock, makeReverseRebalancer } = await import('./lib/reverse-rebalance.mjs');
  let config, leases;
  try {
    if (C.pair) throw new Error('reverse rebalancing is for the TAC provider, not a BTC-ETH pair provider');
    config = parseRebalanceConfig(C, { dryRun: DRY });
    leases = config.leases
      ? parseLeaseManifest(JSON.parse(readFileSync(resolve(config.leases), 'utf8')))
      : { version: 1, notes: [], feeCoins: [] };
  } catch (e) { console.error(String((e && e.message) || e)); process.exitCode = 1; return; }

  const data = resolve(C.dataDir || 'fastbridge-lp/data');
  const lock = acquireProcessLock(resolve(data, 'rebalance.pid'));
  let fileStorage = null;
  try {
    const network = C.network || 'mainnet';
    if (C.reverse?.enabled === true) {
      globalThis.__TACIT_WORKER_BASE__ = process.env.TACIT_WORKER_BASE || 'https://api.tacit.finance';
      globalThis.__TACIT_CHAIN_VIA_WORKER__ = true;
    }
    const { loadTacit } = await import('../worker-relay/src/lib/btc-pool-transparent.js');
    const { secp, sha256, hmac, bytesToHex } = await import('../dapp/vendor/tacit-deps.min.js');
    secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
    const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
    const { makeBtcWallet } = await import('../dapp/bitcoin-taproot-wallet.js');
    const { makeFileStorage } = await import('./lib/storage.mjs');
    const { makeStrictFileStore, makeMemoryStore } = await import('./lib/store.mjs');
    const { makeAlert } = await import('./lib/alert.mjs');
    const { reverseKeyOf, makeReverseInventory } = await import('./lib/reverse.mjs');
    setActiveNetwork(network);
    const key = Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16)));
    const wallet = (priv) => makeBtcWallet({ priv, hrp: network === 'mainnet' ? 'bc' : 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 }).prims;
    const house = wallet(key), reverse = wallet(reverseKeyOf(key));
    const mainAddress = house.wallet.address(), reverseAddress = reverse.wallet.address();
    if (mainAddress === reverseAddress) throw new Error('the reverse address is the main address: refusing');

    const tacit = await loadTacit(network, { livePool: true });
    if (DRY) {
      const values = new Map();
      globalThis.localStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k), key: (i) => [...values.keys()][i] ?? null, get length() { return values.size; } };
    } else {
      fileStorage = makeFileStorage(resolve(data, 'rebalance-wallet-cache.json'));
      globalThis.localStorage = fileStorage;
    }
    delete globalThis.location;
    tacit.wallet.priv = key;
    tacit.wallet.pub = house.wallet.pub;
    const destination = bytesToHex(reverse.wallet.pub);
    const reverseReader = makeReverseInventory({ tacit, asset: C.btcAsset, log, includeUnconfirmed: true });
    const reverseInventory = {
      async notes() {
        const saved = { priv: tacit.wallet.priv, pub: tacit.wallet.pub };
        tacit.wallet.priv = reverseKeyOf(key);
        tacit.wallet.pub = reverse.wallet.pub;
        try { return await reverseReader.notes(); }
        finally { tacit.wallet.priv = saved.priv; tacit.wallet.pub = saved.pub; }
      },
    };

    const realFetch = globalThis.fetch;
    const bases = (C.btcBases?.length ? C.btcBases : ['https://mempool.space/api', 'https://blockstream.info/api']).map((b) => b.replace(/\/$/, ''));
    const getJson = async (path) => {
      for (const base of bases) {
        try {
          const response = await realFetch(base + path, { signal: AbortSignal.timeout(30000) });
          if (response.ok) return await response.json();
        } catch { /* try the next explorer */ }
      }
      return null;
    };
    const store = DRY ? makeMemoryStore() : makeStrictFileStore(resolve(data, 'rebalance'));
    const reverseSwaps = makeStrictFileStore(resolve(data, 'reverse/swaps'));
    const alert = makeAlert({ log, webhook: process.env.FB_LP_ALERT_WEBHOOK || null, name: C.name || undefined });
    const sidecar = makeReverseRebalancer({
      config, leases, store, reverseSwaps, tacit, getJson, reverseInventory, mainAddress, reverseAddress, destination,
      dryRun: DRY, log, alert, realFetch, ownPubHex: () => bytesToHex(tacit.wallet.pub), expectedPubHex: bytesToHex(house.wallet.pub),
    });
    log({ level: 'info', msg: DRY ? 'reverse rebalancer dry run: planning only, no journals or sends' : 'reverse rebalancer started', enabled: config.enabled, dryRun: DRY, mainAddress, reverseAddress, config: cfgPath, leases: config.leases });
    let busy = false, tickFailed = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try { const report = await sidecar.step(); log({ level: 'info', msg: 'reverse rebalance tick', report }); }
      catch (e) { tickFailed = true; log({ level: 'error', msg: 'reverse rebalance tick failed', error: String((e && e.message) || e).slice(0, 240) }); }
      finally { busy = false; }
    };
    if (DRY) { await tick(); if (tickFailed) process.exitCode = 1; return; }
    await tick();
    const timer = setInterval(tick, config.tickSecs * 1000);
    const stop = () => { clearInterval(timer); lock.release(); fileStorage?.flush(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await new Promise(() => {});
  } finally {
    lock.release();
    fileStorage?.flush();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(String((e && e.message) || e).slice(0, 500)); process.exitCode = 1; });
