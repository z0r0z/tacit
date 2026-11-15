// The wrap walk's memo as the pool helpers keep it (dapp/confidential-pool-ux.js _walkWrapsOf, forgetKeys): a key's scan is asked again for every new wrap in the pool, and the second one
// works out only what is new; forgetKeys() drops what the walks of the key worked out (it is derived from the key), so the scan after it works everything out again. Counted in keccaks, the
// walk's share of which is two for each index and amount worked out.
//
// Run: `node tests/wrap-walk-memo-ux.test.mjs`
import { JSDOM } from './_jsdom.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
globalThis.fetch = async () => { throw new Error('offline'); };
globalThis.__TACIT_NO_INIT__ = true;
localStorage.setItem('tacit-network-v1', 'mainnet');

const { secp, sha256, keccak_256 } = await import('../dapp/vendor/tacit-deps.min.js');
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond === true) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label} ${detail}`); fail++; } };

let calls = 0;
const counting = (b) => { calls++; return keccak_256(b); };
const ux = makeConfidentialPoolUx({ secp, keccak256: counting, sha256, network: 'mainnet' });
const priv = new Uint8Array(32); priv[31] = 33;
const assets = ux.assets.filter((a) => a.assetId).slice(0, 2);
const AMOUNTS = 20, GAP = 24;
let nextId = 0x7000;
const wraps = (n) => assets.flatMap((a, k) => Array.from({ length: n }, (_, i) => ({
  type: 'Wrap', assetId: a.assetId, amount: String(BigInt(a.unitScale || 1) * BigInt((i + 1) * 1000 + k * 7 + 1)),   // in units of the asset's scale, as the walk reads them
    depositId: '0x' + (0x6000 + k * 100 + i).toString(16).padStart(64, '0'), txHash: '0x' + (0x9000 + k * 100 + i).toString(16).padStart(64, '0'),
})));
const scan = async (events) => { calls = 0; const r = await ux.recover({ walletPriv: priv, events, deep: true, cbtc: false, cdp: false, farm: false, locks: false }); return { r, calls }; };
const PAIRS = 2 * GAP * AMOUNTS * assets.length;          // keccaks the walk makes when it works every index and amount out

ok('the fixtures are two pool assets with twenty amounts each', assets.length === 2 && wraps(AMOUNTS).length === 40);
const first = await scan(wraps(AMOUNTS));
ok('the first scan of a key works every index and amount out', first.calls >= PAIRS, `(${first.calls} keccaks, the walk's share is ${PAIRS})`);
const more = [...wraps(AMOUNTS), { type: 'Wrap', assetId: assets[0].assetId, amount: String(BigInt(assets[0].unitScale || 1) * 1001n), depositId: '0x' + (0xa000).toString(16).padStart(64, '0'), txHash: '0x' + (0xb000).toString(16).padStart(64, '0') }];
const second = await scan(more);
ok('after one more wrap in the pool, the scan works out none of it again', first.calls - second.calls >= 0.9 * PAIRS, `(${first.calls} then ${second.calls})`);
ok('and finds what the first did', JSON.stringify(second.r.diagnostics.wrap.scanned.map((s) => [s.assetId, s.indexesTried, s.matched])) === JSON.stringify(first.r.diagnostics.wrap.scanned.map((s) => [s.assetId, s.indexesTried, s.matched])));
ux.forgetKeys();
const third = await scan(more);
ok('after forgetKeys() the scan works everything out again: the memo is gone with the key', third.calls - second.calls >= 0.9 * PAIRS && third.calls - second.calls <= 1.3 * PAIRS, `(${second.calls} then ${third.calls})`);
const fourth = await scan(more);
ok('and keeps it again for the next one', third.calls - fourth.calls >= 0.9 * PAIRS, `(${third.calls} then ${fourth.calls})`);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
