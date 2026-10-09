// The holdings scan counts a farm-minted note (here a T_LP_HARVEST reward paying this wallet) only against the
// worker's receipt for it (/amm/farm-receipt): a recorded reward is counted with the receipt's opening, and a
// harvest the worker never applied is not counted, even with an opening for it on file. Mocked chain; no network.
//
// Run (Node 22): node --no-experimental-global-navigator tests/farm-receipt-holdings.test.mjs
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { randomBytes } from 'node:crypto';

const dom = new JSDOM('', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, __TACIT_NO_INIT__: true });
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
localStorage.setItem('tacit-network-v1', 'mainnet');

const routes = new Map();
const receipts = new Map();
const W = { route: true, scanned: 900200 };
let walletUtxos = [];
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if ((init?.method || 'GET').toUpperCase() === 'POST') throw new Error('offline: ' + url);
  if (url.includes('/amm/farm-receipt')) {
    if (!W.route) return json({ error: 'not found' }, 404);
    const t = new URL(url).searchParams.get('txid'), rec = receipts.get(t);
    return json(rec ? { found: true, ...rec, scanned_height: W.scanned } : { found: false, note: null, scanned_height: W.scanned });
  }
  if (/\/address\/[^/]+\/utxo/.test(url)) return json(walletUtxos);
  if (/\/address\/[^/]+\/txs/.test(url)) return json([]);
  if (url.includes('/scripthash/')) return json([]);
  for (const [k, f] of routes) if (url.includes(k)) return json(f(url));
  throw new Error('offline: ' + url);
};

const T = await import('../dapp/tacit.js');
const BP = await import('./bulletproofs.mjs');
const { secp } = await import('../dapp/vendor/tacit-deps.min.js');
const { encodeLpHarvest } = await import('../dapp/amm-envelope.js');

const hex = (b) => Buffer.from(b).toString('hex');
const rnd = () => BigInt('0x' + hex(randomBytes(32))) % T.SECP_N;
const b32 = (x) => new Uint8Array(Buffer.from(x.toString(16).padStart(64, '0'), 'hex'));
const old = Math.floor(Date.now() / 1000) - 7200;

const V = new Uint8Array(randomBytes(32)); const Vpub = secp.getPublicKey(V, true);
T.wallet.priv = V; T.wallet.pub = Vpub;
const REWARD_ASSET = 'aa'.repeat(32);

// A T_LP_HARVEST whose reward (vout 1) pays this wallet.
function harvestTx(tag, rewardAmount) {
  const X = tag + '9'.repeat(62), r = rnd();
  const payload = encodeLpHarvest({
    farmId: new Uint8Array(32).fill(7), bondId: new Uint8Array(36).fill(3), harvesterPubkey: Vpub,
    exitAccPerShare: 0n, exitViewHeight: 99, rewardAmount, rewardR: b32(r),
    ownerCommit: new Uint8Array(32).fill(4), oldNonce: new Uint8Array(32).fill(5), shares: 1000n, harvesterSig: new Uint8Array(64),
  });
  const tx = { txid: X, version: 2, locktime: 0,
    vin: [{ txid: tag + '3'.repeat(62), vout: 0, witness: ['00'.repeat(64), hex(T.encodeEnvelopeScript(T.wallet.xonly(), payload)), 'c0' + '11'.repeat(32)] }],
    vout: [
      { scriptpubkey: '6a20' + '00'.repeat(32), scriptpubkey_type: 'op_return', value: 0 },
      { scriptpubkey: hex(T.p2wpkhScript(Vpub)), scriptpubkey_type: 'v0_p2wpkh', value: 546 },
    ],
    status: { confirmed: true, block_height: 900000, block_time: old } };
  routes.set(`/tx/${X}/outspend`, () => ({ spent: false }));
  routes.set(`/tx/${X}`, () => tx);
  const note = { asset_id: REWARD_ASSET, commitment: hex(T.pointToBytes(BP.pedersenCommit(rewardAmount, r))), amount: String(rewardAmount), r: hex(b32(r)), vout: 1 };
  return { txid: X, note, r, utxo: { txid: X, vout: 1, value: 546, status: tx.status } };
}
const scan = async () => { T.invalidateHoldingsCache(); T.clearValidatorCaches(); return T.scanHoldings(true); };
const bal = (h) => h.get(REWARD_ASSET)?.balance ?? 0n;

const real = harvestTx('a1', 70n), forged = harvestTx('b2', 5_000_000n);
receipts.set(real.txid, { kind: 'harvest', farm_id: '07'.repeat(32), note: real.note });
walletUtxos = [real.utxo, forged.utxo];
// An opening for the unapplied harvest is on file, as one rebuilt from its envelope would be.
T.recordOpening(forged.txid, 1, REWARD_ASSET, 5_000_000n, forged.r);

{
  const h = await scan();
  assert.equal(bal(h), 70n, 'the recorded reward is counted and the unapplied harvest is not');
  console.log('ok 1 - a recorded reward counts; a harvest the worker never applied does not, even with an opening on file');
}
{
  W.route = false;
  receipts.clear();
  const h = await scan();
  assert.equal(bal(h), 0n, 'with no receipt route and no farm pre-scan, nothing is counted');
  console.log('ok 2 - against a worker with no receipt route, no farm note is counted without the farm pre-scan');
  W.route = true;
}
console.log('done');
process.exit(0);   // the dapp's timers (cache flushes, retries) would otherwise keep the process alive
