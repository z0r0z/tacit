#!/usr/bin/env node
// The Bitcoin-to-Bitcoin swap desk (dapp/btcswap-desk.js). One process: it answers quotes, offers and the claim's two signing
// rounds over HTTP, and advances every open swap (checks the holder's lock, locks tracked TAC against it, reads t from the
// claim and opens the holder's lock, or refunds its own lock after its timelock).
//
//   BTCSWAP_DESK_KEY=<64 hex>        the desk's key: its Bitcoin wallet and the root of its swap seed. Env only.
//   BTCSWAP_DESK_CONFIG=<path>       the config file (README.md). Default ./btcswap-desk/config.json
//   BTCSWAP_DESK_ALERT_WEBHOOK=<url> optional: alerts are POSTed there as JSON as well as logged
//   node btcswap-desk/server.mjs [--dry-run]     (Node 22; run from the repository root)
//
// --dry-run answers /info and /quote and checks offers, but keeps its swaps in memory and advances none.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const cfgPath = resolve(process.env.BTCSWAP_DESK_CONFIG || 'btcswap-desk/config.json');
const C = JSON.parse(readFileSync(cfgPath, 'utf8'));
const keyHex = String(process.env.BTCSWAP_DESK_KEY || '').trim().replace(/^0x/, '');
if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.error('BTCSWAP_DESK_KEY must be 64 hex characters (set it in the environment)'); process.exit(1); }
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

const { makeFileStorage } = await import('../fastbridge-lp/lib/storage.mjs');
const { makeFileStore, makeMemoryStore } = await import('../fastbridge-lp/lib/store.mjs');
const { makeHttpServer } = await import('../fastbridge-lp/lib/http.mjs');
const { loadTacit } = await import('../worker-relay/src/lib/btc-pool-transparent.js');
const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
const { makeBtcWallet } = await import('../dapp/bitcoin-taproot-wallet.js');
const { makeAdaptorBtcTx, tacitKit } = await import('../dapp/adaptor-btc-tx.js');
const { makeEsploraBtcChain } = await import('../dapp/fastbridge-btc.js');
const { makeBtcSwapDesk } = await import('../dapp/btcswap-desk.js');
const { makeOwnNotes, makeReflectionTracking } = await import('../dapp/btcswap-notes.js');

const network = C.network || 'mainnet';
setActiveNetwork(network);
const key = Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16)));
const seed = hmac(sha256, key, new TextEncoder().encode('tacit-btcswap-desk-seed'));
const data = resolve(C.dataDir || 'btcswap-desk/data');

const tacit = await loadTacit(network);
// as in fastbridge-lp/server.mjs: the wallet module's checkpoints go to a file, and it is built with no location
globalThis.localStorage = makeFileStorage(resolve(data, 'wallet-cache.json'));
const savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
delete globalThis.location;
const { prims } = makeBtcWallet({ priv: key, hrp: network === 'mainnet' ? 'bc' : 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
const builder = makeAdaptorBtcTx({ prims, kit: tacitKit(tacit) });
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => fetch(u, o), network });
if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
const btc = makeEsploraBtcChain({
  bases: C.btcBases, tacit, prims, builder, pool: ux.pool, ethGetStorageAt: (to, slot, tag) => ux.rpc('eth_getStorageAt', [to, slot, tag]),
  poolAddress: C.poolAddress, binding: ux.chainBindingHex(), keccak256: keccak_256, secp,
});

const confs = (C.policy.confs || [['0', 1]]).map(([from, n]) => [BigInt(from), n]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const policy = {
  asset: C.asset, minAmount: BigInt(C.quote.minAmount), maxAmount: BigInt(C.quote.maxAmount), feeBps: C.quote.feeBps, flatFee: BigInt(C.quote.flatFee ?? 0), validSecs: C.quote.validSecs ?? 600,
  csvHolder: C.policy.csvHolder ?? 288, csvDesk: C.policy.csvDesk ?? 144, acceptWaitSecs: C.policy.acceptWaitSecs ?? 6 * 3600,
  minConfsFor: (v) => confs.reduce((n, [from, c]) => (BigInt(v) >= from ? c : n), confs[0][1]),
};
const alert = (o) => { log(o); if (process.env.BTCSWAP_DESK_ALERT_WEBHOOK) fetch(process.env.BTCSWAP_DESK_ALERT_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }).catch(() => {}); };
const desk = makeBtcSwapDesk({
  seed, now: () => Math.floor(Date.now() / 1000), policy, btc, log, alert,
  store: DRY ? makeMemoryStore() : makeFileStore(resolve(data, 'swaps')), quotes: DRY ? makeMemoryStore() : makeFileStore(resolve(data, 'quotes')),
  inventory: makeOwnNotes({ btc, tacit, asset: C.asset }),
  tracking: makeReflectionTracking({ base: C.apiBase || 'https://tacit-api.onrender.com', pool: ux.pool, network }),
});

log({ level: 'info', msg: 'btc swap desk', network, dryRun: DRY, bitcoinAddress: btc.address, deskPub: Buffer.from(prims.wallet.pub).toString('hex'), config: cfgPath, data });
desk.available().then((a) => log({ level: 'info', msg: 'tracked TAC on hand', units: String(a) })).catch((e) => log({ level: 'warn', msg: 'could not read the inventory', error: String(e.message || e) }));
let busy = false;
if (!DRY) setInterval(async () => { if (busy) return; busy = true; try { await desk.tick(); } catch (e) { log({ level: 'error', msg: 'tick failed', error: String(e.message || e) }); } finally { busy = false; } }, (C.tickSecs ?? 15) * 1000);
const server = makeHttpServer({ handle: desk.handle, origins: C.origins || [], trustProxy: !!C.trustProxy, kindOf: (m, p) => (p === '/offer' || /\/(nonce|sign)$/.test(p) ? 'offer' : 'default') });
server.listen(C.port ?? 8788, () => log({ level: 'info', msg: 'listening', port: C.port ?? 8788 }));
