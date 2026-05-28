// Tests for the claimable-link primitives in dapp/claim-link.js. These pin the
// load-bearing properties: the key derivation is deterministic (sender and
// recipient must agree on the spend key), a PIN changes the key (so a leaked
// URL alone can't claim), and the wire format round-trips + fails closed on
// malformed input.
//
// jsdom shim mirrors prf-wallet.test.mjs — claim-link.js + the vendor bundle
// expect window/crypto/atob/btoa at import time on some Node versions.
//
// Run: `node tests/claim-link.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');

import { secp, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
const {
  genClaimSecret, claimKeyFromSecret,
  encodeClaimLink, decodeClaimLink, buildClaimUrl,
} = await import('../dapp/claim-link.js');

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
}
function expectThrow(label, fn) {
  try { fn(); ok(label + ' (expected throw)', false); }
  catch { ok(label, true); }
}

const TXID = 'a'.repeat(64);
const isCompressedPub = (pub) => pub instanceof Uint8Array && pub.length === 33 && (pub[0] === 2 || pub[0] === 3);

console.log('genClaimSecret:');
{
  const a = genClaimSecret();
  const b = genClaimSecret();
  ok('returns 32 bytes', a instanceof Uint8Array && a.length === 32);
  ok('is not all-zero', a.some((x) => x !== 0));
  ok('two calls differ (CSPRNG)', bytesToHex(a) !== bytesToHex(b));
}

console.log('\nclaimKeyFromSecret:');
{
  const secret = genClaimSecret();
  const k1 = claimKeyFromSecret(secret);
  const k2 = claimKeyFromSecret(secret);
  ok('derivation is deterministic (sender == recipient)', k1.pubHex === k2.pubHex);
  ok('produces a valid compressed pubkey', isCompressedPub(k1.pub) && k1.pubHex === bytesToHex(secp.getPublicKey(k1.priv, true)));

  const noPin = claimKeyFromSecret(secret);
  const withPin = claimKeyFromSecret(secret, '4321');
  ok('PIN changes the derived key', noPin.pubHex !== withPin.pubHex);

  const pinA = claimKeyFromSecret(secret, '0000');
  const pinB = claimKeyFromSecret(secret, '0001');
  ok('different PINs derive different keys', pinA.pubHex !== pinB.pubHex);
  ok('same PIN is deterministic', claimKeyFromSecret(secret, '0000').pubHex === pinA.pubHex);

  expectThrow('rejects non-32-byte secret', () => claimKeyFromSecret(new Uint8Array(31)));
}

console.log('\nencode / decode round-trip:');
{
  const secret = genClaimSecret();
  const payload = encodeClaimLink({ secret32: secret, txid: TXID, network: 'signet', pinned: false });
  const dec = decodeClaimLink(payload);
  ok('round-trips the secret', bytesToHex(dec.secret32) === bytesToHex(secret));
  ok('round-trips the txid', dec.txid === TXID);
  ok('round-trips the network', dec.network === 'signet');
  ok('round-trips pinned=false', dec.pinned === false);

  const pinnedPayload = encodeClaimLink({ secret32: secret, txid: TXID, network: 'mainnet', pinned: true });
  ok('round-trips pinned=true', decodeClaimLink(pinnedPayload).pinned === true);

  // Decoded secret + the out-of-band PIN must reproduce the sender's claimPub.
  const senderPub = claimKeyFromSecret(secret, '9999').pubHex;
  const recipientPub = claimKeyFromSecret(decodeClaimLink(pinnedPayload).secret32, '9999').pubHex;
  ok('decoded secret + PIN reproduces the sender claim pubkey', senderPub === recipientPub);
}

console.log('\ndecode tolerates URL / fragment / raw forms:');
{
  const payload = encodeClaimLink({ secret32: genClaimSecret(), txid: TXID, network: 'signet' });
  const url = buildClaimUrl('https://tacit.finance', payload);
  ok('full URL form', decodeClaimLink(url).txid === TXID);
  ok('fragment form', decodeClaimLink('#claim=' + payload).txid === TXID);
  ok('raw payload form', decodeClaimLink(payload).txid === TXID);
  ok('ignores trailing query/hash junk', decodeClaimLink('#claim=' + payload + '&foo=bar').txid === TXID);
}

console.log('\ndecode fails closed on malformed input:');
{
  const good = encodeClaimLink({ secret32: genClaimSecret(), txid: TXID, network: 'signet' });
  expectThrow('empty input', () => decodeClaimLink(''));
  expectThrow('wrong version', () => decodeClaimLink(good.replace(/^v1\./, 'v2.')));
  expectThrow('unknown network', () => decodeClaimLink(good.replace('.signet.', '.testnet4.')));
  expectThrow('too few parts', () => decodeClaimLink('v1.signet.abcd'));
  expectThrow('bad txid', () => decodeClaimLink(good.replace('.' + TXID + '.', '.' + 'z'.repeat(64) + '.')));
  expectThrow('bad pin flag', () => decodeClaimLink(good.replace(/\.0$/, '.7')));
}

console.log('\nencode validates inputs:');
{
  const secret = genClaimSecret();
  expectThrow('rejects unsupported network', () => encodeClaimLink({ secret32: secret, txid: TXID, network: 'testnet4' }));
  expectThrow('rejects short txid', () => encodeClaimLink({ secret32: secret, txid: 'abc', network: 'signet' }));
  expectThrow('rejects non-32-byte secret', () => encodeClaimLink({ secret32: new Uint8Array(16), txid: TXID, network: 'signet' }));
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
