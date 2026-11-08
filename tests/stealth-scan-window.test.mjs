// scanAssetForStealthReceipts over an index of 1,600 transfers (what one 8 x 200 Rescan reads): every transfer is
// checked, the transfers are read a window at a time rather than one request each, a read that failed is counted and
// tried again by the next scan, and the seen-transfer cache holds the whole walk, so the next scan skips all of it.
//
// Setup mirrors tests/stealth-cache-isolation.test.mjs (JSDOM + localStorage shims so dapp/tacit.js loads in node);
// the worker is a fetch stub. Run with Node >= 22 and NODE_OPTIONS=--no-experimental-global-navigator.

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

import { hexToBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

const ASSET = 'cc'.repeat(32), ASSET2 = 'dd'.repeat(32);
const N = 1600;
const txids = Array.from({ length: N }, (_, i) => i.toString(16).padStart(64, '0'));
// The worker lists an asset's newest transfers first, then its full walk, which repeats them.
const fresh = Array.from({ length: 300 }, (_, i) => (0x100000 + i).toString(16).padStart(64, '0'));
const INDEX = { [ASSET]: txids, [ASSET2]: [...fresh.slice(-100), ...fresh] };

// The worker serves the asset's transfer index (paged by offset); the dapp reads each transfer from the public
// indexers. A transfer that holds no envelope for anyone is what almost every scanned transfer looks like.
const CONFIRMED = new Set();
const reads = { total: 0, inflight: 0, maxInflight: 0, failing: false, hosts: {}, starts: [] };
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const listed = /^\/assets\/([0-9a-f]{64})\/recent-xfer-txids$/.exec(url.pathname);
  if (listed && INDEX[listed[1]]) {
    const all = INDEX[listed[1]], limit = Number(url.searchParams.get('limit')), at = Number(url.searchParams.get('cursor') || 0);
    const page = all.slice(at, at + limit), end = at + page.length;
    return json({ asset_id: listed[1], txids: page, next_cursor: end >= all.length ? null : String(end), done: end >= all.length });
  }
  const m = /\/tx\/([0-9a-f]{64})$/.exec(url.pathname);
  if (m) {
    reads.total++;
    reads.starts.push(Date.now());
    reads.hosts[url.host] = (reads.hosts[url.host] || 0) + 1;
    reads.maxInflight = Math.max(reads.maxInflight, ++reads.inflight);
    await new Promise((r) => setTimeout(r, 3));
    reads.inflight--;
    if (reads.failing) return json({ error: 'unavailable' }, 500);
    const id = m[1];
    // every 25th transfer has one input, like the mint-shaped ones in the live index: read, and not a shielded transfer
    const vin = [{ txid: id, vout: 0, witness: ['00', '00', '00'] }];
    if (parseInt(id, 16) % 25 !== 0) vin.push({ txid: id, vout: 1, witness: [] });
    return json({ txid: id, status: { confirmed: CONFIRMED.has(id) }, vin: CONFIRMED.has(id) ? [{ txid: id, vout: 0, witness: ['00', '00', '00'] }] : vin, vout: [] });
  }
  return json({ error: 'not found' }, 404);
};

const dapp = await import('../dapp/tacit.js');
const priv = hexToBytes('aa'.repeat(32));
dapp.wallet.priv = priv;
dapp.wallet.pub = secp.getPublicKey(priv, true);
dapp.setTxReadSpacingMs(0);          // the page's pacing is tested below; the walks here read at the speed of the stub

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

await test('a Rescan-sized walk checks every transfer in the index', async () => {
  const progress = [];
  const r = await dapp.scanAssetForStealthReceipts(ASSET, { pageLimit: 200, maxPages: 8, gapMs: 0, onProgress: (p) => progress.push(p) });
  assert(r.complete === true, 'the walk did not reach the end of the index');
  assert(r.pagesScanned === 8, `expected 8 pages, read ${r.pagesScanned}`);
  assert(r.txsScanned === N && r.txsSkipped === 0 && r.txsFailed === 0, `expected ${N} checked, got ${r.txsScanned} (+${r.txsSkipped} skipped, ${r.txsFailed} failed)`);
  assert(progress.length === N, 'progress did not report every transfer');
  assert(progress[progress.length - 1].txsScanned === N, 'the last progress report is not the full count');
  assert(reads.total === N, `${reads.total} reads for ${N} transfers`);
});

await test('transfers are read in a window, within the dapp\'s in-flight cap', () => {
  assert(reads.maxInflight > 1, 'the transfers were read one at a time');
  assert(reads.maxInflight <= 12, `${reads.maxInflight} reads in flight at once`);
});

await test('the seen-transfer cache holds the whole walk, so the next scan skips all of it', async () => {
  const before = reads.total;
  const r = await dapp.scanAssetForStealthReceipts(ASSET, { pageLimit: 200, maxPages: 8, gapMs: 0 });
  assert(r.complete === true && r.txsScanned === 0 && r.txsSkipped === N, `second scan checked ${r.txsScanned}, skipped ${r.txsSkipped}`);
  assert(reads.total === before, 'the second scan read transfers again');
});

await test('a transaction that was read and is not a shielded transfer counts as checked, not as failed', async () => {
  // the first scan above read 64 such transfers; none was reported failed, and the next scan reads none of them again
  assert(dapp.isStealthTxidSeen(ASSET, txids[0]) && dapp.isStealthTxidSeen(ASSET, txids[25]), 'a one-input transfer was left unmarked');
});

await test('a transfer the index lists twice is counted and read once', async () => {
  globalThis.localStorage.clear();
  const before = reads.total, progress = [];
  const r = await dapp.scanAssetForStealthReceipts(ASSET2, { pageLimit: 100, maxPages: 10, gapMs: 0, onProgress: (p) => progress.push(p) });
  assert(r.complete === true, 'the walk did not reach the end of the index');
  assert(r.txsScanned === 300 && r.txsSkipped === 0 && r.txsFailed === 0, `expected 300 transfers, got ${r.txsScanned} (+${r.txsSkipped} skipped, ${r.txsFailed} failed)`);
  assert(reads.total - before === 300, `${reads.total - before} reads for 300 transfers`);
  assert(progress.length === 300 && progress[progress.length - 1].txsScanned === 300, 'progress counted a repeat');
  const again = await dapp.scanAssetForStealthReceipts(ASSET2, { pageLimit: 100, maxPages: 10, gapMs: 0 });
  assert(again.txsScanned === 0 && again.txsSkipped === 300, `a second scan skipped ${again.txsSkipped} and read ${again.txsScanned}, not 300 and none`);
});

await test('a transfer whose read failed is counted, left unmarked, and read again by the next scan', async () => {
  globalThis.localStorage.clear();
  const bobPriv = hexToBytes('bb'.repeat(32));          // a fresh wallet: no seen markers
  dapp.wallet.priv = bobPriv;
  dapp.wallet.pub = secp.getPublicKey(bobPriv, true);
  reads.failing = true;
  const first = await dapp.scanAssetForStealthReceipts(ASSET, { pageLimit: 24, maxPages: 1, gapMs: 0 });
  assert(first.txsFailed === 24, `expected 24 failed reads, got ${first.txsFailed}`);
  reads.failing = false;
  const second = await dapp.scanAssetForStealthReceipts(ASSET, { pageLimit: 24, maxPages: 1, gapMs: 0 });
  assert(second.txsScanned === 24 && second.txsSkipped === 0 && second.txsFailed === 0,
    `the failed reads were not tried again (checked ${second.txsScanned}, skipped ${second.txsSkipped}, failed ${second.txsFailed})`);
});

await test('a scan does not rest while all goes well; a window with a failed read starts a rest that doubles; held transfers make it wait for nothing', async () => {
  // the three behaviours are timed with real waits, kept short
  const asset = 'ab'.repeat(32), mk = (from, n) => Array.from({ length: n }, (_, i) => (from + i).toString(16).padStart(64, '0'));
  INDEX[asset] = mk(0x300000, 24);
  const asset2 = 'ae'.repeat(32);
  INDEX[asset2] = mk(0x350000, 24);        // other transfers for the failing phase: the ones just read are held by the app's read cache
  globalThis.localStorage.clear();
  const bob = hexToBytes('cc'.repeat(32)); dapp.wallet.priv = bob; dapp.wallet.pub = secp.getPublicKey(bob, true);
  reads.maxInflight = 0;
  // 24 transfers, windows of 4: six windows, five rests of 40 ms when every read works
  let t0 = Date.now();
  let r = await dapp.scanAssetForStealthReceipts(asset, { pageLimit: 100, maxPages: 1, window: 4, gapMs: 40 });
  const clean = Date.now() - t0;
  assert(r.txsScanned === 24 && r.txsFailed === 0, `clean scan checked ${r.txsScanned}, failed ${r.txsFailed}`);
  assert(reads.maxInflight <= 4, `${reads.maxInflight} reads at once, window is 4`);
  assert(clean >= 5 * 40 - 15, `the scan rested ${clean} ms in all, expected about ${5 * 40}`);
  // other transfers failing, for a wallet with no markers: each failed window doubles the rest, so the scan takes far longer
  globalThis.localStorage.clear();
  const carol = hexToBytes('ce'.repeat(32)); dapp.wallet.priv = carol; dapp.wallet.pub = secp.getPublicKey(carol, true);
  reads.failing = true;
  t0 = Date.now();
  r = await dapp.scanAssetForStealthReceipts(asset2, { pageLimit: 100, maxPages: 1, window: 4, gapMs: 0, failGapMs: 10 });
  const failing = Date.now() - t0;
  reads.failing = false;
  assert(r.txsFailed === 24, `expected 24 failed reads, got ${r.txsFailed} (scanned ${r.txsScanned}, skipped ${r.txsSkipped}, complete ${r.complete}, pages ${r.pagesScanned}, ${failing} ms, reads ${reads.total})`);
  assert(failing >= 10 + 20 + 40 + 80 + 160 - 40, `a failing scan rested only ${failing} ms: the rest did not double from 10 ms`);
  // the retry reads them, and then a scan of what is held waits for nothing
  t0 = Date.now();
  r = await dapp.scanAssetForStealthReceipts(asset2, { pageLimit: 100, maxPages: 1, window: 4, gapMs: 400 });
  assert(r.txsScanned === 24 && r.txsFailed === 0, 'the retry read them');
  await dapp.scanAssetForStealthReceipts(asset2, { pageLimit: 100, maxPages: 1, window: 4, gapMs: 400 });
  assert(Date.now() - t0 < 6 * 400, 'a scan of what is held waited between windows');
});

await test('single transfer reads are taken by the explorers in turns, not all by the first', async () => {
  globalThis.localStorage.clear();
  globalThis.localStorage.setItem('tacit-custom-api-v1', JSON.stringify({ signet: 'https://second.example/api' }));
  const asset = 'cd'.repeat(32);
  INDEX[asset] = Array.from({ length: 40 }, (_, i) => (0x400000 + i).toString(16).padStart(64, '0'));
  for (const k of Object.keys(reads.hosts)) delete reads.hosts[k];
  const bob = hexToBytes('dd'.repeat(32)); dapp.wallet.priv = bob; dapp.wallet.pub = secp.getPublicKey(bob, true);
  const r = await dapp.scanAssetForStealthReceipts(asset, { pageLimit: 100, maxPages: 1, window: 4, gapMs: 0 });
  assert(r.txsScanned === 40, `checked ${r.txsScanned}`);
  const counts = Object.values(reads.hosts);
  assert(counts.length >= 2, `all reads went to ${Object.keys(reads.hosts).join(', ')}`);
  assert(Math.max(...counts) <= 40 * 0.7, `one explorer took ${Math.max(...counts)} of 40 reads: ${JSON.stringify(reads.hosts)}`);
});

await test('the page starts at most one transfer read in each interval, however many scans run at once, and makes nothing it already holds wait', async () => {
  globalThis.localStorage.clear();
  const bob = hexToBytes('ee'.repeat(32)); dapp.wallet.priv = bob; dapp.wallet.pub = secp.getPublicKey(bob, true);
  const mk = (from, n) => Array.from({ length: n }, (_, i) => (from + i).toString(16).padStart(64, '0'));
  const assets = ['a1', 'a2', 'a3'].map((x) => x.repeat(32));
  assets.forEach((a, k) => { INDEX[a] = mk(0x500000 + k * 100, 12); for (const id of INDEX[a]) CONFIRMED.add(id); });
  reads.starts.length = 0;
  dapp.setTxReadSpacingMs(30);
  const t0 = Date.now();
  // three scans at once, as the page's own scan and the one in the background are
  const rs = await Promise.all(assets.map((a) => dapp.scanAssetForStealthReceipts(a, { pageLimit: 100, maxPages: 1, window: 4, gapMs: 0 })));
  const took = Date.now() - t0;
  assert(rs.every((r) => r.txsScanned === 12 && r.txsFailed === 0), 'every transfer was read');
  assert(reads.starts.length === 36, `${reads.starts.length} reads for 36 transfers`);
  // timestamps are taken where the read arrives, after scheduling that a busy machine stretches or squeezes, so the rate is checked over runs of six reads, not between two
  const runs = reads.starts.slice(6).map((t, i) => t - reads.starts[i]);
  assert(Math.min(...runs) >= 6 * 30 - 70, `six reads were started within ${Math.min(...runs)} ms, the interval is 30 ms each`);
  assert(took >= 36 * 30 - 60, `36 reads took ${took} ms: they were not held to one in 30 ms`);
  // the same transfers again, read afresh by scans that do not use the seen record: the caches hold them, so nothing waits and nothing is asked
  reads.starts.length = 0;
  const t1 = Date.now();
  await Promise.all(assets.map((a) => dapp.scanAssetForStealthReceipts(a, { pageLimit: 100, maxPages: 1, window: 4, gapMs: 0, useSeenCache: false })));
  assert(reads.starts.length === 0, `${reads.starts.length} reads for transfers the page holds`);
  assert(Date.now() - t1 < 36 * 30 / 2, `held transfers waited ${Date.now() - t1} ms`);
  dapp.setTxReadSpacingMs(0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
