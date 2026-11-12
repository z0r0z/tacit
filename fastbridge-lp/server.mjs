#!/usr/bin/env node
// The fast bridge liquidity provider. One process: it answers quotes and offers over HTTP, and advances every open swap
// (checks the user's Bitcoin lock against the chain, makes its pool note ready, locks it, publishes the offer, reads t from
// the user's claim and takes the Bitcoin lock, or refunds after the deadline).
//
//   FB_LP_KEY=<64 hex>        the LP's key: its Bitcoin wallet, its pool identity, the root of its swap seed. Env only.
//   FB_LP_CONFIG=<path>       the config file (README.md). Default ./fastbridge-lp/config.json
//   FB_LP_ALERT_WEBHOOK=<url> optional: alerts are POSTed there as JSON as well as logged
//   PORT, FB_LP_DATA_DIR, FB_LP_NAME, FB_LP_BOARDS, FB_LP_MIN_AMOUNT, FB_LP_MAX_AMOUNT, FB_LP_FEE_BPS, FB_LP_FLAT_FEE   optional: set over the config (lib/env-config.mjs)
//   node fastbridge-lp/server.mjs [--dry-run]     (Node 22; run from the repository root)
//
// --dry-run answers /info and /quote and checks offers against the chain, but sends nothing and advances no swap.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
process.on('unhandledRejection', (e) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'unhandled rejection', error: String((e && e.message) || e).slice(0, 200) })));

const DRY = process.argv.includes('--dry-run');
const cfgPath = resolve(process.env.FB_LP_CONFIG || 'fastbridge-lp/config.json');
const { applyEnv } = await import('./lib/env-config.mjs');
let C;
try { C = applyEnv(JSON.parse(readFileSync(cfgPath, 'utf8'))); } catch (e) { console.error(String((e && e.message) || e)); process.exit(1); }
const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.error('FB_LP_KEY must be 64 hex characters (set it in the environment)'); process.exit(1); }
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

const { makeFileStorage } = await import('./lib/storage.mjs');
const { loadTacit } = await import('../worker-relay/src/lib/btc-pool-transparent.js');
const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
const { makeBtcWallet } = await import('../dapp/bitcoin-taproot-wallet.js');
const { makeAdaptorBtcTx, tacitKit } = await import('../dapp/adaptor-btc-tx.js');
const { makeFastBridgeEvm } = await import('../dapp/fastbridge-evm.js');
const { makeFileStore, makeFileLogStore, makeMemoryStore } = await import('./lib/store.mjs');
const { makeNodeBtcChain } = await import('./lib/btc-chain.mjs');
const { makeLpService } = await import('./lib/service.mjs');
const { makeHttpServer } = await import('./lib/http.mjs');

const network = C.network || 'mainnet';
setActiveNetwork(network);
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const key = hexToBytes(keyHex);
const hmacSha256 = (k, m) => hmac(sha256, k, m);
const seed = hmacSha256(key, new TextEncoder().encode('tacit-fastbridge-lp-seed'));

// The live pool: a note that came out of the Bitcoin shielded pool is told from the pool service, as a page tells it. Without this the validator
// asks a replay's (empty) exit set, and every such note, which the fast bridge exists to move, reads as not valid.
const tacit = await loadTacit(network, { livePool: true });
// loading the note validator gives this process a browser-like window with a localStorage of its own and a location at
// localhost. The wallet module keeps its scan checkpoints in localStorage, so a file stands in for it; and it is built
// with no location, because a localhost page makes the deployment config point the relay at the page itself.
globalThis.localStorage = makeFileStorage(resolve(C.dataDir || 'fastbridge-lp/data', 'wallet-cache.json'));
const savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
delete globalThis.location;
const { prims } = makeBtcWallet({ priv: key, hrp: network === 'mainnet' ? 'bc' : 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
const builder = makeAdaptorBtcTx({ prims, kit: tacitKit(tacit) });
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => fetch(u, o), network, logStore: makeFileLogStore(resolve(C.dataDir || 'fastbridge-lp/data', 'logs')) });
if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
// What the relay will not send (its free settles for the day are used up, it is held, it is busy) this process sends from its own account, the
// Ethereum address of the key, which holds the ETH for it. The settle is tried first, so one the pool would refuse costs nothing.
const acct = ux.account(key);
const selfSettle = async (x) => {
  if (!x || !x.publicValues || !x.proof) throw new Error('there is no proof to send');
  await ux.rpc('eth_call', [{ from: acct.address, to: ux.cfg.pool, data: ux.settleCalldata(x) }, 'latest']);
  return ux.settleFromAccount({ settlerPriv: key, publicValues: x.publicValues, proof: x.proof, memos: x.memos || [] });
};
const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256, walletPriv: key, seed, asset: C.evmAsset, poolAddress: C.poolAddress, policy: { minClaimSecs: C.policy.minClaimSecs }, selfSettle, ownAccount: { address: acct.address }, selfRetryMs: 60000, log });
const btc = makeNodeBtcChain({
  bases: C.btcBases, tacit, prims, builder, pool: ux.pool, ethGetStorageAt: (to, slot, tag) => ux.rpc('eth_getStorageAt', [to, slot, tag]),
  poolAddress: C.poolAddress, binding: ux.chainBindingHex(), keccak256: keccak_256, secp,
});

const confs = (C.policy.confs || [['0', 1]]).map(([from, n]) => [BigInt(from), n]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const config = {
  claimPub: Buffer.from(prims.wallet.pub).toString('hex'), csvBlocks: C.csvBlocks ?? 144, alertSecs: C.alertSecs ?? 3600, reserve: C.reserve, inventory: C.inventory,
  quote: { ...C.quote, btcAsset: C.btcAsset, evmAsset: C.evmAsset },
  policy: {
    minCsv: C.policy.minCsv ?? 72, evmWindowSecs: C.policy.evmWindowSecs ?? 4 * 3600, minClaimSecs: C.policy.minClaimSecs ?? 3600, claimSlackSecs: C.policy.claimSlackSecs ?? 7200,
    roundSecs: C.policy.roundSecs ?? 600, refundMarginSecs: C.policy.refundMarginSecs ?? 600, maxOfferAgeSecs: C.policy.maxOfferAgeSecs ?? 3600,
    minAmount: C.quote.minAmount, maxAmount: C.quote.maxAmount,
    minConfsFor: (v) => confs.reduce((n, [from, c]) => (BigInt(v) >= from ? c : n), confs[0][1]),
  },
};
const data = resolve(C.dataDir || 'fastbridge-lp/data');
const alert = (o) => { log(o); if (process.env.FB_LP_ALERT_WEBHOOK) fetch(process.env.FB_LP_ALERT_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }).catch(() => {}); };
// a dry run keeps its swaps and quotes in memory, so a later live run starts from nothing it did not choose
const service = makeLpService({ seed, btc, evm, swaps: DRY ? makeMemoryStore() : makeFileStore(resolve(data, 'swaps')), quoteStore: DRY ? makeMemoryStore() : makeFileStore(resolve(data, 'quotes')), config, log, alert });

log({ level: 'info', msg: 'fast bridge LP', network, dryRun: DRY, bitcoinAddress: btc.address, claimPub: config.claimPub, poolAccount: acct.address, config: cfgPath, data });
await service.start();
let busy = false;
if (!DRY) setInterval(async () => { if (busy) return; busy = true; try { await service.tick(); } finally { busy = false; } }, (C.tickSecs ?? 15) * 1000);
const server = makeHttpServer({ handle: service.handle, origins: C.origins || [], trustProxy: !!C.trustProxy });
server.listen(C.port ?? 8787, () => log({ level: 'info', msg: 'listening', port: C.port ?? 8787 }));

// Boards the LP is on as well: its ad is posted there and the requests left for it are answered, so a user finds it without its URL.
if (C.boards && C.boards.length) {
  if (DRY) log({ level: 'info', msg: 'dry run: no board is joined' });
  else {
    const { makeBoardClient } = await import('../dapp/fastbridge-board-client.js');
    const { gatewayOf, makeMailboxServer, makeAdPublisher } = await import('../dapp/fastbridge-mailbox.js');
    const { signSchnorr } = await import('../dapp/bulletproofs.js');
    const keys = gatewayOf(key);
    for (const url of C.boards) {
      const board = makeBoardClient({ base: url });
      makeMailboxServer({ board, keys, handle: service.handle, signReply: (d) => signSchnorr(d, key), pollMs: (C.mailboxPollSecs ?? 3) * 1000, log }).start();
      makeAdPublisher({ board, handle: service.handle, claimPriv: key, claimPub: config.claimPub, keys, name: C.name || null, everySecs: 60, log }).start();
      log({ level: 'info', msg: 'on the board', board: url, gateway: Buffer.from(keys.pub).toString('hex') });
    }
    // bridges waiting for a provider: alerted when a new one appears, so the operator can raise what it takes
    const { checkWant } = await import('../dapp/fastbridge-board.js');
    const seen = new Set();
    const lookWants = async () => {
      const now = Math.floor(Date.now() / 1000), fresh = [];
      for (const url of C.boards) {
        try {
          for (const w of await makeBoardClient({ base: url }).wants()) {
            try { checkWant(w, now); } catch { continue; }
            if (w.btcAsset.replace(/^0x/, '').toLowerCase() === String(C.btcAsset).toLowerCase() && BigInt(w.amount) > 0n && !seen.has(w.pub)) { seen.add(w.pub); fresh.push(w.amount); }
          }
        } catch { /* a board that keeps no wants */ }
      }
      if (fresh.length) alert({ level: 'warn', msg: 'bridges are waiting for a provider', count: fresh.length, amounts: fresh });
    };
    lookWants(); setInterval(lookWants, 300000).unref();
  }
}
