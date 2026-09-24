// T_SWAP_VAR / T_SWAP_ROUTE fresh-refund-key fix — network-free unit test.
//
// A swap's refund output mints the spent input note's commitment VERBATIM under the refund's own key
// (cxfer-core onboard_btc_refund/onboard_batch_refunds): leaf = btc_note_leaf(asset, C_in, refund_auth).
// Paying the refund to the trader's own key (== the input note's own key) makes the refund's leaf and
// nullifier identical to the note the swap just spent — born already-nullified, value destroyed, if the
// refund branch is ever taken. `dapp/tacit.js`'s buildSwapVarEnvelopeSelfFulfill /
// buildSwapRouteEnvelopeSelfFulfill used to derive `refundScriptPubKey` as `p2trScript(traderPub.slice(1))`
// — exactly the bug. Fixed via `deriveSwapRefundKey` (an additive key tweak, the same primitive already
// used for stealth-received UTXOs), keyed by (traderPriv, the swap's own spent outpoint) — deterministic
// and reconstructible, never equal to the trader's own key. This locks that fix in.
//
// Run: node tests/amm-swap-refund-key.test.mjs

import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert';
import { p2trXonlyOf } from '../dapp/amm-refund-key.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const dapp = await import('../dapp/tacit.js');

const PRIV = randomBytes(32);
const PUB = secp.getPublicKey(PRIV, true);
dapp.wallet.priv = PRIV;
dapp.wallet.pub = PUB;
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(PUB), '1'); } catch {}

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const traderOwnRefundSpk = dapp.p2trScript(PUB.slice(1));

const ASSET_A = 'aa'.repeat(32);
const ASSET_B = 'bb'.repeat(32);
const ASSET_C = 'cc'.repeat(32);
const randTxid = () => bytesToHex(randomBytes(32));
const randBlinding = () => bytesToHex(randomBytes(32));

// ───────────────── 1. T_SWAP_VAR: refund key is fresh, not the trader's own ─────────────────
{
  const poolReserves = { pool_id_hex: randTxid(), reserve_a: '100000000000', reserve_b: '100000000000', fee_bps: 30 };
  const utxo1 = { txid: randTxid(), vout: 0, amount: '1000000', blinding: randBlinding(), asset_id_hex: ASSET_A };
  const built1 = await dapp.buildSwapVarEnvelopeSelfFulfill({
    poolReserves, assetInputUtxo: utxo1, direction: 0, deltaIn: 1_000_000n, minOut: 1n,
    expiryHeight: 900000, receiveAssetIdHex: ASSET_B,
  });
  assert.notStrictEqual(bytesToHex(built1.refundScriptPubKey), bytesToHex(traderOwnRefundSpk),
    'swap_var refund destination must not be the trader\'s own key');
  const refundXonly = p2trXonlyOf(built1.refundScriptPubKey);
  assert.strictEqual(refundXonly, bytesToHex(secp.getPublicKey(built1.refundPriv, true).slice(1)),
    'returned refundPriv actually corresponds to the refund script\'s embedded key');

  // A second, distinct input (different outpoint) must get a DIFFERENT refund key, not a fixed one.
  const utxo2 = { txid: randTxid(), vout: 1, amount: '2000000', blinding: randBlinding(), asset_id_hex: ASSET_A };
  const built2 = await dapp.buildSwapVarEnvelopeSelfFulfill({
    poolReserves, assetInputUtxo: utxo2, direction: 0, deltaIn: 1_000_000n, minOut: 1n,
    expiryHeight: 900000, receiveAssetIdHex: ASSET_B,
  });
  assert.notStrictEqual(bytesToHex(built1.refundScriptPubKey), bytesToHex(built2.refundScriptPubKey),
    'two different swaps by the same trader must not reuse the same refund key');

  // Re-deriving against the SAME outpoint again (e.g. a retry rebuild) must reproduce the SAME key —
  // deterministic, recoverable, no extra state needed.
  const built1b = await dapp.buildSwapVarEnvelopeSelfFulfill({
    poolReserves, assetInputUtxo: utxo1, direction: 0, deltaIn: 1_000_000n, minOut: 1n,
    expiryHeight: 900000, receiveAssetIdHex: ASSET_B,
  });
  assert.strictEqual(bytesToHex(built1.refundScriptPubKey), bytesToHex(built1b.refundScriptPubKey),
    'the same (trader, outpoint) must re-derive the identical refund key — recoverable with no extra state');
  ok('T_SWAP_VAR: refund key is fresh, per-swap, deterministic, and never the trader\'s own key');
}

// ───────────────── 2. T_SWAP_ROUTE: same fix, same guarantees ─────────────────
{
  const pools = [
    { pool_id: '11'.repeat(32), validation: 'verified', asset_a: ASSET_A, asset_b: ASSET_B, reserve_a: '100000000000', reserve_b: '100000000000', fee_bps: 30 },
    { pool_id: '22'.repeat(32), validation: 'verified', asset_a: ASSET_B, asset_b: ASSET_C, reserve_a: '100000000000', reserve_b: '100000000000', fee_bps: 30 },
  ];
  const utxo1 = { txid: randTxid(), vout: 0, amount: '1000000', blinding: randBlinding(), asset_id_hex: ASSET_A };
  const built1 = await dapp.buildSwapRouteEnvelopeSelfFulfill({
    pools, assetInputUtxo: utxo1, traderOutputAssetIdHex: ASSET_C, minOut: 1n, expiryHeight: 900000,
  });
  assert.notStrictEqual(bytesToHex(built1.refundScriptPubKey), bytesToHex(traderOwnRefundSpk),
    'swap_route refund destination must not be the trader\'s own key');
  const refundXonly = p2trXonlyOf(built1.refundScriptPubKey);
  assert.strictEqual(refundXonly, bytesToHex(secp.getPublicKey(built1.refundPriv, true).slice(1)),
    'returned refundPriv actually corresponds to the refund script\'s embedded key');

  const utxo2 = { txid: randTxid(), vout: 3, amount: '1000000', blinding: randBlinding(), asset_id_hex: ASSET_A };
  const built2 = await dapp.buildSwapRouteEnvelopeSelfFulfill({
    pools, assetInputUtxo: utxo2, traderOutputAssetIdHex: ASSET_C, minOut: 1n, expiryHeight: 900000,
  });
  assert.notStrictEqual(bytesToHex(built1.refundScriptPubKey), bytesToHex(built2.refundScriptPubKey),
    'two different routes by the same trader must not reuse the same refund key');
  ok('T_SWAP_ROUTE: refund key is fresh, per-swap, and never the trader\'s own key');
}

console.log(`\n${n} AMM swap refund-key checks passed.`);
process.exit(0); // dapp/tacit.js's import schedules background polling that would otherwise keep node alive
