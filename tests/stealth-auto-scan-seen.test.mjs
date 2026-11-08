// The background scan for shielded receipts, through the worker's global recent-transfer index: each transfer it rules
// out is recorded (the record the per-asset walk keeps), so a later session reads only the transfers that are new, the
// transfers are read a few at a time, a read that failed is left unmarked and tried again, and a transaction that was
// read and holds no shielded transfer counts as checked.
//
// Setup mirrors tests/stealth-scan-window.test.mjs (JSDOM + localStorage shims so dapp/tacit.js loads in node; the
// worker and the indexers are a fetch stub). Run with Node >= 22 and --no-experimental-global-navigator.

import { JSDOM } from './_jsdom.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

const ASSET = 'cc'.repeat(32), OTHER = 'ee'.repeat(32);
const id = (n) => n.toString(16).padStart(64, '0');
const entries = [
  ...Array.from({ length: 12 }, (_, i) => ({ txid: id(i + 1), aid: ASSET })),
  ...Array.from({ length: 4 }, (_, i) => ({ txid: id(0x1000 + i), aid: OTHER })),     // an asset the scan does not look at
];
const reads = { by: new Map(), inflight: 0, maxInflight: 0, failing: new Set(), hold: new Map() };
const total = () => [...reads.by.values()].reduce((a, b) => a + b, 0);
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/assets') return json({ assets: [{ asset_id: ASSET, verified: true, transfer_count: 12, etched_at: 1 }] });
  if (url.pathname === '/recent-cxfer-txids') return json({ entries });
  const m = /\/tx\/([0-9a-f]{64})$/.exec(url.pathname);
  if (m) {
    reads.by.set(m[1], (reads.by.get(m[1]) || 0) + 1);
    reads.maxInflight = Math.max(reads.maxInflight, ++reads.inflight);
    await new Promise((r) => setTimeout(r, reads.hold.get(m[1]) || 3));
    reads.inflight--;
    if (reads.failing.has(m[1])) return json({ error: 'unavailable' }, 500);
    // transfer 3 has one input: read, and not a shielded transfer
    const vin = [{ txid: m[1], vout: 0, witness: ['00', '00', '00'] }];
    if (m[1] !== id(3)) vin.push({ txid: m[1], vout: 1, witness: [] });
    return json({ txid: m[1], status: { confirmed: false }, vin, vout: [] });
  }
  return json({ error: 'not found' }, 404);
};

const priv = hexToBytes('aa'.repeat(32)), pub = secp.getPublicKey(priv, true);
// A session is a page load: its own copy of the module, with the same browser storage.
async function session(tag) {
  await new Promise((r) => setTimeout(r, 250));                  // the seen-transfer record is flushed to storage a moment after it is written
  const d = await import(`../dapp/tacit.js?${tag}`);
  d.wallet.priv = priv; d.wallet.pub = pub;
  d.setTxReadSpacingMs(0);          // the page's pacing of transfer reads is tested in stealth-scan-window; here the reads go at the speed of the stub
  return d;
}
const lastRun = () => `tacit-stealth-discover-last-v1:signet:${bytesToHex(pub)}`;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

const one = await session('one');
await test('the first session reads each listed transfer of the scanned assets once, a few at a time', async () => {
  reads.failing.add(id(5));
  await one._triggerStealthAutoScanInBackground(new Map());
  assert(reads.by.size === 12, `${reads.by.size} transfers read, expected the 12 of the scanned asset`);       // the dapp's fetch layer tries a failing read twice
  assert(![...reads.by.keys()].some((t) => entries.slice(12).some((e) => e.txid === t)), 'a transfer of another asset was read');
  assert(reads.maxInflight > 1 && reads.maxInflight <= 12, `${reads.maxInflight} reads in flight at once`);
});

await test('transfers ruled out are recorded; a read that failed is not', () => {
  for (const i of [1, 2, 4, 6, 7, 8, 9, 10, 11, 12]) assert(one.isStealthTxidSeen(ASSET, id(i)), `transfer ${i} was left unmarked`);
  assert(one.isStealthTxidSeen(ASSET, id(3)), 'a transaction with no shielded transfer was not counted as checked');
  assert(!one.isStealthTxidSeen(ASSET, id(5)), 'a transfer whose read failed was marked');
});

const two = await session('two');
await test('a later session reads only what was not ruled out', async () => {
  reads.failing.clear();
  reads.by.clear();
  globalThis.localStorage.removeItem(lastRun());                 // the wider sweep is throttled to every 6 h
  await two._triggerStealthAutoScanInBackground(new Map());
  assert(total() === 1 && reads.by.get(id(5)) === 1, `${total()} reads: ${[...reads.by.keys()].map((k) => k.slice(-2)).join(',')}; expected only the transfer that failed before`);
  assert(two.isStealthTxidSeen(ASSET, id(5)), 'the transfer read this time was not recorded');
});

const three = await session('three');
await test('with every listed transfer ruled out, a session reads none', async () => {
  reads.by.clear();
  globalThis.localStorage.removeItem(lastRun());
  await three._triggerStealthAutoScanInBackground(new Map());
  assert(total() === 0, `${total()} reads, expected none`);
});

// A second key, so what the sessions above recorded as read does not hide the transfers from it.
const priv2 = hexToBytes('bb'.repeat(32)), pub2 = secp.getPublicKey(priv2, true);
async function session2(tag) {
  await new Promise((r) => setTimeout(r, 250));
  const d = await import(`../dapp/tacit.js?${tag}`);
  d.wallet.priv = priv2; d.wallet.pub = pub2;
  return d;
}
const lastRun2 = () => `tacit-stealth-discover-last-v1:signet:${bytesToHex(pub2)}`;

const four = await session2('four');
await test('explorers that fail every read stop the scan after a few, and it does not record itself as done or try again for a while', async () => {
  reads.by.clear();
  for (let i = 1; i <= 12; i++) reads.failing.add(id(i));
  await four._triggerStealthAutoScanInBackground(new Map());
  assert(reads.by.size >= 4 && reads.by.size < 12, `${reads.by.size} transfers were tried, expected a few and not all 12`);
  assert(!globalThis.localStorage.getItem(lastRun2()), 'the sweep was recorded as done');
  assert(![...reads.by.keys()].some((t) => four.isStealthTxidSeen(ASSET, t)), 'a transfer that could not be read was marked');
  reads.by.clear();
  await four._triggerStealthAutoScanInBackground(new Map());
  assert(total() === 0, `${total()} reads while it was resting`);
});

const five = await session2('five');
await test('the scan waits while a purchase is checking its lot, then carries on', async () => {
  reads.by.clear(); reads.failing.clear();
  globalThis.localStorage.removeItem(lastRun2());
  const LOT = id(0x2000);
  reads.hold.set(LOT, 1200);
  const buy = five.requireValidatedLot(LOT, 0).catch(() => null);
  await new Promise((r) => setTimeout(r, 100));
  const scan = five._triggerStealthAutoScanInBackground(new Map());
  await new Promise((r) => setTimeout(r, 500));
  const early = [...reads.by.keys()].filter((t) => t !== LOT).length;
  assert(early === 0, `${early} transfers were read while the lot was being checked`);
  await buy; await scan;
  reads.hold.clear();
  assert([...reads.by.keys()].filter((t) => t !== LOT).length === 12, `${reads.by.size} transactions read after the check ended, expected the 12 transfers`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
