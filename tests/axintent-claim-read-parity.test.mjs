// Dapp ↔ worker byte parity for the maker claim-read message. Drift here =
// the maker's claim-detail signature 403s and they can't fulfil.
//
// Run: node tests/axintent-claim-read-parity.test.mjs

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.__TACIT_NO_INIT__ = true;

const dapp = await import('../dapp/tacit.js');
import { atomicIntentClaimReadMsg } from '../worker/src/index.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const test = (label, fn) => { try { if (fn() === true) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; } };

const cases = [
  ['aa'.repeat(32), 'bb'.repeat(16)],
  ['00'.repeat(32), 'ff'.repeat(16)],
  ['f0bbe868'.padEnd(64, '0'), '12'.repeat(16)],
];

console.log('\naxintent claim-read msg parity:');
for (const [asset, iid] of cases) {
  test(`asset ${asset.slice(0, 8)}… / iid ${iid.slice(0, 8)}…`, () => {
    const w = bytesToHex(atomicIntentClaimReadMsg(asset, iid));
    const d = bytesToHex(dapp.axintentClaimReadMsg(hexToBytes(asset), hexToBytes(iid)));
    return w === d;
  });
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
if (fail > 0) process.exit(1);
