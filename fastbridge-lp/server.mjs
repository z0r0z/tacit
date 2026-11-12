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
const { makeAlert } = await import('./lib/alert.mjs');

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
// TAC with up to 8 places, as the pool's units (8 places) and as the token's wei (18)
const tacUnits = (t) => { const [whole, frac = ''] = String(t).split('.'); return BigInt(whole) * 10n ** 8n + BigInt(frac.padEnd(8, '0').slice(0, 8)); };
const config = {
  claimPub: Buffer.from(prims.wallet.pub).toString('hex'), csvBlocks: C.csvBlocks ?? 144, alertSecs: C.alertSecs ?? 3600, reserve: C.reserve, inventory: C.inventory,
  lowFree: C.lowFreeTac != null ? tacUnits(C.lowFreeTac) : null,
  quote: { ...C.quote, btcAsset: C.btcAsset, evmAsset: C.evmAsset },
  policy: {
    minCsv: C.policy.minCsv ?? 72, evmWindowSecs: C.policy.evmWindowSecs ?? 4 * 3600, minClaimSecs: C.policy.minClaimSecs ?? 3600, claimSlackSecs: C.policy.claimSlackSecs ?? 7200,
    roundSecs: C.policy.roundSecs ?? 600, refundMarginSecs: C.policy.refundMarginSecs ?? 600, maxOfferAgeSecs: C.policy.maxOfferAgeSecs ?? 3600, holdAgeSecs: C.policy.holdAgeSecs,
    minAmount: C.quote.minAmount, maxAmount: C.quote.maxAmount,
    minConfsFor: (v) => confs.reduce((n, [from, c]) => (BigInt(v) >= from ? c : n), confs[0][1]),
  },
};
const data = resolve(C.dataDir || 'fastbridge-lp/data');
const alert = makeAlert({ log, webhook: process.env.FB_LP_ALERT_WEBHOOK || null, name: C.name || undefined });
// a dry run keeps its swaps and quotes in memory, so a later live run starts from nothing it did not choose
const swapStore = DRY ? makeMemoryStore() : makeFileStore(resolve(data, 'swaps'));
const service = makeLpService({ seed, btc, evm, swaps: swapStore, quoteStore: DRY ? makeMemoryStore() : makeFileStore(resolve(data, 'quotes')), config, log, alert });

log({ level: 'info', msg: 'fast bridge LP', network, dryRun: DRY, bitcoinAddress: btc.address, claimPub: config.claimPub, poolAccount: acct.address, config: cfgPath, data });
await service.start();
let busy = false;
if (!DRY) setInterval(async () => { if (busy) return; busy = true; try { await service.tick(); } finally { busy = false; } }, (C.tickSecs ?? 15) * 1000);

// Keeping the private TAC filled (lib/refill.mjs, README "Keeping it filled"): off unless the config names a treasury. When what the provider holds free
// falls under `lowWaterTac`, TAC at its own address is shielded, or a chunk is pulled from the treasury (which has approved this key for a limited
// amount, and can take that back with an approval of 0) and shielded. The key can pull nothing the treasury has not approved.
if (C.refill && !DRY) {
  const { makeRefill } = await import('./lib/refill.mjs');
  const rc = C.refill;
  const treasury = String(rc.treasury || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(treasury)) { console.error('refill.treasury must be an Ethereum address'); process.exit(1); }
  const tacMeta = ux.assetByTicker.TAC;
  if (!tacMeta || !tacMeta.underlying) { console.error('this build of the pool module has no TAC token to refill with'); process.exit(1); }
  const token = tacMeta.underlying;
  const wei = (t) => tacUnits(t) * 10n ** 10n;                      // also an ETH amount in its 18 places
  const word = (a) => BigInt(a).toString(16).padStart(64, '0');
  const readNum = async (data) => BigInt(await ux.rpc('eth_call', [{ to: token, data }, 'latest']));
  const stateFile = resolve(data, 'refill.json');
  const { readFileSync: readF, writeFileSync: writeF } = await import('node:fs');
  const minEth = wei(rc.minEth ?? '0');                             // a floor for the ETH it keeps; what it needs follows the gas price (below)
  const REFILL_GAS = 1_500_000n;                                    // a pull, a deposit and a settle sent from this address, with room
  const refill = makeRefill({
    free: () => service.free(),
    publicTac: () => readNum('0x70a08231' + word(acct.address)),
    allowance: () => readNum('0xdd62ed3e' + word(treasury) + word(acct.address)),
    treasuryTac: () => readNum('0x70a08231' + word(treasury)),
    ethOk: async () => {
      const [bal, price] = [BigInt(await ux.rpc('eth_getBalance', [acct.address, 'latest'])), BigInt(await ux.rpc('eth_gasPrice', []))];
      const need = REFILL_GAS * (2n * price + 100000000n);         // at twice the gas price of the moment and a 0.1 gwei tip, as a send reserves
      return bal >= (need > minEth ? need : minEth);
    },
    // a swap that is locking or refunding sends from this address: a refill waits for them, so two sends do not take one nonce
    quiet: async () => !(await swapStore.list()).some((r) => r.phase === 'locking' || r.phase === 'refunding'),
    pull: async (amount) => {
      const sent = await ux.sendPreparedTx({ walletPriv: key, to: token, calldata: '0x23b872dd' + word(treasury) + word(acct.address) + word(amount), gasLimit: 120000n });
      await ux.waitReceipt(sent.txHash);
    },
    shield: async (amount) => {
      const sent = await ux.routerWrap({ walletPriv: key, amountWei: amount, ticker: 'TAC' });
      let deposited = false;
      try {
        await ux.waitReceipt(sent.txHash);
        deposited = true;
        // when the relay is not sending settles it only proves, and this address sends the settle
        const state = await ux.relay.state().then((s) => (s && s.state) || null).catch(() => null);
        await ux.submitWrapSettle({ built: sent, depositTx: sent.txHash, ...(state != null && state !== 'ok' ? { selfSettle } : {}) });
      } catch (e) { if (deposited) e.deposited = sent.txHash; throw e; }
    },
    load: async () => { try { return JSON.parse(readF(stateFile, 'utf8')); } catch { return {}; } },
    save: async (s) => writeF(stateFile, JSON.stringify(s)),
    config: { lowWater: wei(rc.lowWaterTac ?? 3000), chunk: wei(rc.chunkTac ?? 5000), minShield: wei(rc.minShieldTac ?? 100), maxPerDay: wei(rc.maxPerDayTac ?? 20000), minIntervalSecs: rc.minIntervalSecs ?? 1800 },
    log, alert,
  });
  log({ level: 'info', msg: 'refill is on', treasury, lowWaterTac: rc.lowWaterTac ?? 3000, chunkTac: rc.chunkTac ?? 5000, maxPerDayTac: rc.maxPerDayTac ?? 20000 });
  setInterval(() => { refill.step().catch(() => {}); }, (rc.everySecs ?? 60) * 1000).unref();
}
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
