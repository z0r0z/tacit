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

import { JSDOM } from './_jsdom.mjs';
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

console.log('\nclaimKeyFromSecretV2 (the PIN scheme of new links):');
{
  const { claimKeyFromSecretV2, pinAcceptable, PIN_KDF_ITERATIONS, PIN_MIN_LENGTH } = await import('../dapp/claim-link.js');
  const { createHash, pbkdf2Sync } = await import('node:crypto');
  const secret = new Uint8Array(32).fill(7);
  ok('PBKDF2 at 600,000 rounds or more', PIN_KDF_ITERATIONS >= 600000);
  ok('a new link takes a PIN of 6 or more characters, or none', PIN_MIN_LENGTH >= 6 && pinAcceptable('') && pinAcceptable('123456') && !pinAcceptable('12345') && !pinAcceptable('1'));
  const noPin = await claimKeyFromSecretV2(secret);
  ok('without a PIN it is the first scheme (the secret is the key)', noPin.pubHex === claimKeyFromSecret(secret).pubHex);
  const t0 = Date.now();
  const k = await claimKeyFromSecretV2(secret, '246810');
  const ms = Date.now() - t0;
  const want = pbkdf2Sync(Buffer.from('246810'), Buffer.concat([Buffer.from('tacit-claim-pin-v2'), Buffer.from(secret)]), PIN_KDF_ITERATIONS, 32, 'sha256');
  ok('with a PIN the seed is PBKDF2-SHA256(pin, domain || secret)', bytesToHex(k.priv) === want.toString('hex'));
  ok('and differs from the first scheme\'s seed for the same PIN', k.pubHex !== claimKeyFromSecret(secret, '246810').pubHex);
  ok('deterministic', (await claimKeyFromSecretV2(secret, '246810')).pubHex === k.pubHex);
  ok('different PINs derive different keys', (await claimKeyFromSecretV2(secret, '246811')).pubHex !== k.pubHex);
  console.log(`  (one PIN derivation took ${ms} ms)`);
  // the first scheme is unchanged: sha256(domain || secret || pin), mapped into range
  const v1raw = createHash('sha256').update(Buffer.concat([Buffer.from('tacit-claim-pin-v1'), Buffer.from(secret), Buffer.from('4321')])).digest('hex');
  ok('the first scheme\'s PIN seed is unchanged', bytesToHex(claimKeyFromSecret(secret, '4321').priv) === v1raw);
}

console.log('\nTAC claim links (dapp/tac/claim.js): p1 still read, p2 made:');
{
  const { register } = await import('node:module');
  register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));
  const TC = await import('../dapp/tac/claim.js');
  const { claimKeyFromSecretV2 } = await import('../dapp/claim-link.js');
  const secret = new Uint8Array(32).fill(3);
  const p1 = TC.encodeClaim({ secret32: secret, txid: TXID, network: 'mainnet', pinned: true, version: 1 });
  ok('a p1 link encodes as before', p1.startsWith('p1.mainnet.') && p1.endsWith('.1'));
  const d1 = TC.decodeClaim(TC.claimUrl('https://tacit.finance', p1));
  ok('a p1 link decodes, as scheme 1', d1.version === 1 && d1.pinned === true && bytesToHex(d1.secret32) === bytesToHex(secret));
  const p2 = TC.encodeClaim({ secret32: secret, txid: TXID, network: 'mainnet', pinned: true });
  ok('a new link is p2', p2.startsWith('p2.mainnet.'));
  ok('a p2 link decodes, as scheme 2', TC.decodeClaim('#tacclaim=' + p2).version === 2);
  expectThrow('another tag is refused', () => TC.decodeClaim(p2.replace(/^p2\./, 'p9.')));
  // the wallet a link opens: p1 from the first scheme, p2 from the second
  const pool = { walletFromSeed: (priv, network) => ({ addressString: 'bp1q' + bytesToHex(priv), network }) };
  const addr = (k) => 'bp1q' + bytesToHex(k.priv);
  const w1 = await TC.claimPoolWallet(pool, secret, { pin: '1234', network: 'mainnet', version: 1 });
  ok('a p1 link with a 4-digit PIN opens the same wallet as before', w1.addressString === addr(claimKeyFromSecret(secret, '1234')));
  const w0 = await TC.claimPoolWallet(pool, secret, { network: 'mainnet' });
  ok('a link with no PIN opens the secret\'s wallet', w0.addressString === addr(claimKeyFromSecret(secret)));
  const w2 = await TC.claimPoolWallet(pool, secret, { pin: '123456', network: 'mainnet', version: 2 });
  ok('a p2 link opens the second scheme\'s wallet', w2.addressString === addr(await claimKeyFromSecretV2(secret, '123456')));
  ok('the same ask gives the same wallet object', (await TC.claimPoolWallet(pool, secret, { pin: '123456', network: 'mainnet', version: 2 })) === w2);
  // making a link: a short PIN is refused before anything is paid; the link and what is kept say p2
  const paidTo = []; let kept = null;
  const S = { payPrivately: async (t, o) => { paidTo.push(o.to); return { revealTxid: TXID }; } };
  globalThis.location = { origin: 'https://tacit.finance' };
  let threw = false;
  try { await TC.createClaim({}, { S, pool, poolWallet: {}, amount: 1n, asset: 'x', pin: '1234', keep: (x) => { kept = x; } }); } catch { threw = true; }
  ok('a new link with a PIN under 6 digits is refused, with nothing kept or paid', threw && paidTo.length === 0 && kept === null);
  const r = await TC.createClaim({}, { S, pool, poolWallet: {}, amount: 1n, asset: 'x', pin: '135790', keep: (x) => { kept = x; } });
  ok('a 6-digit PIN makes a p2 link, kept as scheme 2', paidTo.length === 1 && kept?.version === 2 && /#tacclaim=p2\.mainnet\./.test(r.link));
  const back = TC.decodeClaim(r.link);
  const opened = await TC.claimPoolWallet({ walletFromSeed: pool.walletFromSeed }, back.secret32, { pin: '135790', network: 'mainnet', version: back.version });
  ok('and the claimer, from the link and the PIN, opens the wallet it paid', opened.addressString === paidTo[0] && paidTo[0] === addr(await claimKeyFromSecretV2(back.secret32, '135790')));
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
