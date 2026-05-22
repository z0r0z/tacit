// Regression guard: stealth-credit + seen-tx caches must invalidate when
// wallet.pub changes. The signet CXFER e2e Phase 7 caught a real bug where
// `_stealthCreditsCache` was populated by Bob, kept across an asAlice()
// switch, and Alice's loadStealthCredits() returned Bob's entries —
// causing Alice to mis-attribute foreign UTXOs as her own and try to spend
// them (Schnorr sig fails at broadcast). The fix tracks the key that
// populated the cache and re-reads on mismatch. This test locks that
// invariant so a future refactor can't silently reintroduce the bug.
//
// Same shape would affect a production user who connects a DIFFERENT
// signer mid-session without a page reload — not a test-only concern.
//
// Setup mirrors tests/stealth-cxfer-signet-e2e.mjs (JSDOM + localStorage
// shims so dapp/tacit.js can load in node).

import { JSDOM } from 'jsdom';
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

const dapp = await import('../dapp/tacit.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}\n  ${e.stack?.split('\n').slice(1, 4).join('\n  ')}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'assertEq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

const aliceKp = (() => { const priv = hexToBytes('aa'.repeat(32)); return { priv, pub: secp.getPublicKey(priv, true) }; })();
const bobKp   = (() => { const priv = hexToBytes('bb'.repeat(32)); return { priv, pub: secp.getPublicKey(priv, true) }; })();
function asAlice() { dapp.wallet.priv = aliceKp.priv; dapp.wallet.pub = aliceKp.pub; }
function asBob()   { dapp.wallet.priv = bobKp.priv;   dapp.wallet.pub = bobKp.pub; }

// Common fixture for both caches.
const TXID = 'a'.repeat(64);
const VOUT = 0;
const ASSET = 'cc'.repeat(32);

// ============================================================================
// Stealth-credit cache
// ============================================================================

test('credits: Bob writing does not leak into Alice on wallet switch', () => {
  // Clean slate — wipe any cached state from prior tests in the same module.
  globalThis.localStorage.clear();

  asAlice();
  // Alice writes a credit.
  dapp.recordStealthCredit({
    txidHex: TXID, vout: VOUT, assetIdHex: ASSET,
    amount: 100n,
    amountBlinding: 1n,
    stealthBlinding: 2n,
    commitmentHex: '02' + 'ab'.repeat(32),
    senderPubHex: '03' + 'cd'.repeat(32),
    blockTime: null,
  });
  const aliceCredit = dapp.getStealthCredit(TXID, VOUT);
  assertEq(aliceCredit.amount, 100n, 'Alice sees her own credit');

  asBob();
  // Bob loads — must NOT see Alice's credit.
  const bobCredit = dapp.getStealthCredit(TXID, VOUT);
  assertEq(bobCredit, null, 'Bob MUST NOT see Alice\'s credit after wallet switch');

  // Bob writes a different credit at the same (txid, vout).
  dapp.recordStealthCredit({
    txidHex: TXID, vout: VOUT, assetIdHex: ASSET,
    amount: 200n,
    amountBlinding: 3n,
    stealthBlinding: 4n,
    commitmentHex: '02' + 'ef'.repeat(32),
    senderPubHex: '03' + 'fe'.repeat(32),
    blockTime: null,
  });
  const bobOwnCredit = dapp.getStealthCredit(TXID, VOUT);
  assertEq(bobOwnCredit.amount, 200n, 'Bob sees his own credit after writing');

  // Switch back to Alice — she must still see her ORIGINAL credit, NOT Bob's.
  asAlice();
  const aliceAgain = dapp.getStealthCredit(TXID, VOUT);
  assertEq(aliceAgain.amount, 100n, 'Alice\'s credit survives Bob\'s write at same key');
});

test('credits: flush after wallet switch writes to the active wallet\'s key', async () => {
  globalThis.localStorage.clear();

  asAlice();
  dapp.recordStealthCredit({
    txidHex: TXID, vout: VOUT, assetIdHex: ASSET,
    amount: 50n,
    amountBlinding: 11n,
    stealthBlinding: 12n,
  });
  // Wait for the debounced flush (50ms scheduled by _scheduleStealthCreditsFlush).
  await new Promise(r => setTimeout(r, 100));
  const aliceKey = `tacit-stealth-credits-v1:signet:${Buffer.from(aliceKp.pub).toString('hex')}`;
  const bobKey   = `tacit-stealth-credits-v1:signet:${Buffer.from(bobKp.pub).toString('hex')}`;
  assert(globalThis.localStorage.getItem(aliceKey), 'Alice\'s key has her credit');
  assert(!globalThis.localStorage.getItem(bobKey),   'Bob\'s key empty before his write');

  asBob();
  dapp.recordStealthCredit({
    txidHex: TXID, vout: VOUT, assetIdHex: ASSET,
    amount: 75n,
    amountBlinding: 21n,
    stealthBlinding: 22n,
  });
  await new Promise(r => setTimeout(r, 100));
  // Bob's write lands under Bob's key — not Alice's.
  assert(globalThis.localStorage.getItem(bobKey), 'Bob\'s key has his credit after his write');
  const aliceStored = JSON.parse(globalThis.localStorage.getItem(aliceKey));
  assertEq(aliceStored[`${TXID}:${VOUT}`].amount, '50',
    'Alice\'s on-disk amount UNCHANGED by Bob\'s same-key write (cross-tenant corruption guard)');
});

// ============================================================================
// Seen-tx negative cache (parallel structure; same invariant)
// ============================================================================

test('seen-txids: Bob\'s seen markers do not leak into Alice on wallet switch', () => {
  globalThis.localStorage.clear();

  asAlice();
  dapp.markStealthTxidSeen(ASSET, TXID);
  assert(dapp.isStealthTxidSeen(ASSET, TXID), 'Alice sees her own marker');

  asBob();
  assert(!dapp.isStealthTxidSeen(ASSET, TXID), 'Bob MUST NOT see Alice\'s seen marker');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
