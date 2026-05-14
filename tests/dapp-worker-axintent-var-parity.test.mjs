// Dapp ↔ worker byte parity for T_AXFER_VAR publish-time helpers.
//
// The dapp's _axintentIdVar + _axintentPublishMsgVar are the literal bytes
// the maker signs at publish time. The worker's atomicIntentIdHexVar +
// atomicIntentPublishMsgVar are the literal bytes the worker re-derives at
// POST time to verify the maker's signature. Any drift between them =
// every variable-amount publish 403s at the worker.
//
// This test sweeps a small parameter matrix and asserts the two
// implementations produce byte-equivalent output for every combination.
// One-bit-flip differentiation (publish_msg changes when any field
// changes) is already covered by tests/worker-axintent-var.test.mjs PR1;
// this file is the cross-implementation parity check.

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.__TACIT_NO_INIT__ = true;

const dapp = await import('../dapp/tacit.js');
import {
  atomicIntentIdHexVar,
  atomicIntentPublishMsgVar,
  atomicIntentClaimMsgVar,
} from '../worker/src/index.js';
import { bytesToHex } from '@noble/hashes/utils';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

console.log('\n=== T_AXFER_VAR dapp ↔ worker byte parity ===\n');

// --- _axintentIdVar parity ---

const FIXTURES_ID = [
  { makerPub: '02' + 'aa'.repeat(32), utxoTxid: '11'.repeat(32), utxoVout: 0 },
  { makerPub: '03' + 'bb'.repeat(32), utxoTxid: '22'.repeat(32), utxoVout: 1 },
  { makerPub: '02' + 'cc'.repeat(32), utxoTxid: '33'.repeat(32), utxoVout: 65535 },
];

for (const f of FIXTURES_ID) {
  test(`intent_id parity for ${f.makerPub.slice(0, 6)}…/${f.utxoTxid.slice(0, 6)}…:${f.utxoVout}`, () => {
    const dappId   = dapp._axintentIdVar(f.makerPub, f.utxoTxid, f.utxoVout);
    const workerId = atomicIntentIdHexVar(f.makerPub, f.utxoTxid, f.utxoVout);
    return dappId === workerId;
  });
}

// --- _axintentPublishMsgVar parity ---

function publishFixture(overrides = {}) {
  return {
    assetIdHex:        'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b',
    intentIdHex:       dapp._axintentIdVar('02' + 'aa'.repeat(32), '11'.repeat(32), 0),
    makerPubHex:       '02' + 'aa'.repeat(32),
    makerAddress:      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    amountStr:         '100000000',
    priceSats:         50000,
    minTakeStr:        '10000000',
    expiry:            1820000000,
    assetUtxoTxidHex:  '11'.repeat(32),
    assetUtxoVout:     0,
    assetUtxoValue:    1000,
    network:           'mainnet',
    ...overrides,
  };
}

function eqMsg(label, overrides) {
  test(label, () => {
    const inputs = publishFixture(overrides);
    const dappBytes   = dapp._axintentPublishMsgVar(inputs);
    const workerBytes = atomicIntentPublishMsgVar(inputs);
    if (dappBytes.length !== 32 || workerBytes.length !== 32) return false;
    return bytesToHex(dappBytes) === bytesToHex(workerBytes);
  });
}

eqMsg('publish_msg parity for baseline mainnet fixture',          {});
eqMsg('publish_msg parity for signet fixture',                    { network: 'signet' });
eqMsg('publish_msg parity for non-zero min_take_amount',          { minTakeStr: '50000000' });
eqMsg('publish_msg parity for min_take_amount = "0" (absent)',    { minTakeStr: '0' });
eqMsg('publish_msg parity for large amount (near u64 max)',       { amountStr: '18446744073709551000' });
eqMsg('publish_msg parity for non-zero vout',                     { assetUtxoVout: 7 });
eqMsg('publish_msg parity for high vout',                         { assetUtxoVout: 65535 });
eqMsg('publish_msg parity for short bech32 address',              { makerAddress: 'bc1qhash160len20pad' });
eqMsg('publish_msg parity for long bech32 address (signet)',      { network: 'signet', makerAddress: 'tb1pq6tk5wuwc70k2vme48l9qegfvvkn3z2t6trhdtgafcrudpwk7gvqg6n40k' });
eqMsg('publish_msg parity for max-future expiry',                 { expiry: 2_500_000_000 });
eqMsg('publish_msg parity for utxo_value at DUST',                { assetUtxoValue: 546 });

// --- _axintentClaimMsgVar parity ---

import { hexToBytes } from '@noble/hashes/utils';

function claimFixture(overrides = {}) {
  return {
    assetIdBytes:     hexToBytes('f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b'),
    intentIdBytes:    hexToBytes('11'.repeat(16)),
    takerPubBytes:    hexToBytes('03' + 'bb'.repeat(32)),
    takerUtxoTxidHex: '22'.repeat(32),
    takerUtxoVout:    0,
    requestedAmount:  '50000000',
    ...overrides,
  };
}

function eqClaimMsg(label, overrides) {
  test(label, () => {
    const f = claimFixture(overrides);
    const dappBytes = dapp._axintentClaimMsgVar(
      f.assetIdBytes, f.intentIdBytes, f.takerPubBytes,
      f.takerUtxoTxidHex, f.takerUtxoVout, f.requestedAmount,
    );
    const workerBytes = atomicIntentClaimMsgVar(
      bytesToHex(f.assetIdBytes),
      bytesToHex(f.intentIdBytes),
      bytesToHex(f.takerPubBytes),
      f.takerUtxoTxidHex, f.takerUtxoVout, f.requestedAmount,
    );
    if (dappBytes.length !== 32 || workerBytes.length !== 32) return false;
    return bytesToHex(dappBytes) === bytesToHex(workerBytes);
  });
}

eqClaimMsg('claim_msg_v3 parity for baseline fixture',         {});
eqClaimMsg('claim_msg_v3 parity for non-zero vout',            { takerUtxoVout: 7 });
eqClaimMsg('claim_msg_v3 parity for high vout',                { takerUtxoVout: 65535 });
eqClaimMsg('claim_msg_v3 parity for small requested_amount',   { requestedAmount: '1' });
eqClaimMsg('claim_msg_v3 parity for large requested_amount',   { requestedAmount: '18446744073709551000' });
eqClaimMsg('claim_msg_v3 parity for different taker_pubkey',   { takerPubBytes: hexToBytes('02' + 'ee'.repeat(32)) });

console.log(`\n=== ${pass} passed · ${fail} failed ===`);
if (fail > 0) process.exit(1);
