// The provider loop: run the holder flow over a provider's stuck notes, offloading them to the desk for tracked TAC.
//
//   PROVIDER_KEY=<64 hex> node tools/provider-offload.mjs --desk https://tacit-btcswap-desk.onrender.com \
//     --config provider.json --notes stuck-notes.json [--floor 300] [--dry-run]
//
// --config is the provider's own config (the desk's config.json shape: network, asset, btcBases, poolAddress,
// apiBase, dataDir). --notes is a JSON list of the provider's stuck notes, one per line of the file:
//
//   [{ "txid": "<64 hex>", "vout": 0, "amount": "10000000000", "blinding": "<64 hex>", "height": 123456 }]
//
// --floor is the most discount the provider will take, in basis points (default 300, from the config's
// provider.floorBps when set). A note whose desk quote discounts more than the floor is left alone: a provider
// never sells below the floor in its own config. --dry-run quotes every note and prints what would happen,
// and swaps nothing.
//
// Each note that clears the floor is swapped at the desk, one at a time, and the tool waits for each swap to
// finish before the next. The swap ends with a tracked note, which the provider bridges home through its normal
// fast-bridge flow (the tool prints the claimed note's outpoint; it does not bridge it). A swap that ends
// refunded leaves the provider with its note back, and the tool says so and moves on.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeBtcSwapHolder, holderDone } from '../dapp/btcswap-holder.js';
import { deskClient } from '../dapp/btcswap-desk.js';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DRY = process.argv.includes('--dry-run');
const DESK = arg('--desk', 'https://tacit-btcswap-desk.onrender.com').replace(/\/$/, '');
const cfgPath = resolve(arg('--config', 'provider.json'));
const C = JSON.parse(readFileSync(cfgPath, 'utf8'));
const FLOOR = Number(arg('--floor', C.provider?.floorBps ?? 300));
const keyHex = String(process.env.PROVIDER_KEY || '').trim().replace(/^0x/, '');
if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.error('PROVIDER_KEY must be 64 hex characters (set it in the environment)'); process.exit(1); }
const notesPath = arg('--notes', null);
if (!notesPath) { console.error('provider-offload: --notes <file> is required'); process.exit(1); }
const notes = JSON.parse(readFileSync(resolve(notesPath), 'utf8'));
if (!Array.isArray(notes) || !notes.length) { console.error('provider-offload: --notes holds no notes'); process.exit(1); }
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

const { makeFileStorage } = await import('../fastbridge-lp/lib/storage.mjs');
const { makeFileStore, makeMemoryStore } = await import('../fastbridge-lp/lib/store.mjs');
const { loadTacit } = await import('../worker-relay/src/lib/btc-pool-transparent.js');
const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
const { makeBtcWallet } = await import('../dapp/bitcoin-taproot-wallet.js');
const { makeAdaptorBtcTx, tacitKit } = await import('../dapp/adaptor-btc-tx.js');
const { makeEsploraBtcChain } = await import('../dapp/fastbridge-btc.js');

const network = C.network || 'mainnet';
setActiveNetwork(network);
const key = Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16)));
const seed = hmac(sha256, key, new TextEncoder().encode('tacit-provider-offload-seed'));
const data = resolve(C.dataDir || 'provider-offload/data');

const tacit = await loadTacit(network);
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

const desk = deskClient({ base: DESK });
const store = DRY ? makeMemoryStore() : makeFileStore(resolve(data, 'swaps'));
const holder = makeBtcSwapHolder({ seed, store, btc, desk, policy: { minConfs: 2 } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log({ level: 'info', msg: 'provider offload', desk: DESK, floorBps: FLOOR, notes: notes.length, dryRun: DRY, address: prims.wallet.address() });
for (const n of notes) {
  const note = { txid: n.txid.replace(/^0x/, '').toLowerCase(), vout: n.vout, amount: BigInt(n.amount), blinding: hexToBytes(String(n.blinding).replace(/^0x/, '')), height: n.height };
  const q = await desk.quote(note.amount, { txid: note.txid, vout: note.vout });
  if (!q.ok) { log({ level: 'skip', note: `${note.txid}:${note.vout}`, why: q.why }); continue; }
  if (q.discountBps > FLOOR) { log({ level: 'skip', note: `${note.txid}:${note.vout}`, why: `the discount is ${q.discountBps}bps, over the ${FLOOR}bps floor`, discountBps: q.discountBps, class: q.class }); continue; }
  log({ level: 'quote', note: `${note.txid}:${note.vout}`, class: q.class, discountBps: q.discountBps, out: q.out, fee: q.fee });
  if (DRY) continue;
  const rec = await holder.start({ asset: hexToBytes(C.asset), amount: note.amount, notes: [note], quote: q });
  let cur = rec;
  while (!holderDone(cur)) { await sleep(15000); cur = await holder.step(await store.get(rec.id)); }
  if (cur.phase === 'done') log({ level: 'done', note: `${note.txid}:${note.vout}`, claimed: `${cur.claim.txid}:0`, out: cur.out, why: 'tracked: bridge it home through the fast-bridge flow' });
  else log({ level: 'refunded', note: `${note.txid}:${note.vout}`, phase: cur.phase, why: cur.why || 'the swap ended without a claim; the note is back with the provider' });
}
log({ level: 'info', msg: 'provider offload finished' });
