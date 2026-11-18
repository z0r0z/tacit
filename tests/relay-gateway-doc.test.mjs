// dapp/relay-gateway-doc.js: a relay's gateway key, vouched for by the relay's own key.
//
// Run: node tests/relay-gateway-doc.test.mjs

import assert from 'node:assert/strict';
import { secp, keccak_256, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeDoc, verifyDoc, docDigest, kidOf } from '../dapp/relay-gateway-doc.js';
import { newGatewayKey, gatewayKeys } from '../dapp/sealed-request.js';

let pass = 0, fail = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

const addressOfPriv = (priv) => `0x${bytesToHex(keccak_256(secp.getPublicKey(priv, false).slice(1)).slice(12))}`;
const signer = (priv) => async (hash) => { const s = await secp.signAsync(hash, priv); return bytesToHex(s.toCompactRawBytes()) + (s.recovery + 27).toString(16); };
const PRIV = hexToBytes('11'.repeat(32)), OTHER = hexToBytes('22'.repeat(32));
const RELAYER = addressOfPriv(PRIV);
const gw = () => bytesToHex(gatewayKeys(newGatewayKey()).pub);

console.log('the document');
await check('a document signed by the relayer\'s key is accepted and gives back the gateway key', async () => {
  const key = gw();
  const doc = await makeDoc({ relayer: RELAYER, key, sign: signer(PRIV) });
  assert.equal(doc.relayer, RELAYER.toLowerCase());
  assert.equal(doc.kid, kidOf(key));
  assert.equal(verifyDoc(doc, RELAYER), key);
  assert.equal(verifyDoc(JSON.parse(JSON.stringify(doc)), RELAYER.toUpperCase().replace('0X', '0x')), key, 'through JSON, and the address in any case');
});
await check('a v of 0 or 1 is read as 27 or 28', async () => {
  const key = gw();
  const doc = await makeDoc({ relayer: RELAYER, key, sign: signer(PRIV) });
  const v = parseInt(doc.sig.slice(128), 16) - 27;
  assert.equal(verifyDoc({ ...doc, sig: doc.sig.slice(0, 128) + '0' + v }, RELAYER), key);
});
await check('a key signed for by another address, a swapped key, a swapped relayer and a swapped id are each refused', async () => {
  const key = gw(), other = gw();
  const doc = await makeDoc({ relayer: RELAYER, key, sign: signer(PRIV) });
  assert.equal(verifyDoc(await makeDoc({ relayer: RELAYER, key, sign: signer(OTHER) }), RELAYER), null, 'signed by another key');
  assert.equal(verifyDoc({ ...doc, key: other, kid: kidOf(other) }, RELAYER), null, 'a forwarder\'s own key under the relay\'s signature');
  assert.equal(verifyDoc(doc, addressOfPriv(OTHER)), null, 'a document for another relayer');
  assert.equal(verifyDoc({ ...doc, relayer: addressOfPriv(OTHER) }, RELAYER), null, 'a document that names another relayer');
  assert.equal(verifyDoc({ ...doc, kid: kidOf(other) }, RELAYER), null, 'a wrong key id');
});
await check('anything that is not a document, or has a key that is not a point, is null and never a throw', async () => {
  const key = gw();
  const doc = await makeDoc({ relayer: RELAYER, key, sign: signer(PRIV) });
  for (const bad of [null, undefined, 5, 'x', [], {}, { ...doc, sig: '00' }, { ...doc, sig: doc.sig.slice(0, -2) + 'ff' }, { ...doc, key: '02' + '00'.repeat(32), kid: '00000000' }, { ...doc, key: 'zz'.repeat(33) }, { ...doc, kid: 'abc' }]) {
    assert.equal(verifyDoc(bad, RELAYER), null, JSON.stringify(bad)?.slice(0, 50));
  }
  assert.equal(verifyDoc(doc, 'nope'), null);
  assert.equal(verifyDoc(doc, null), null);
});
await check('a signer that returns something other than 65 bytes is an error, not a document', async () => {
  await assert.rejects(makeDoc({ relayer: RELAYER, key: gw(), sign: async () => '0x1234' }));
});
await check('the digest binds the relayer and the key (changing either changes it) and is domain separated', () => {
  const key = gw();
  assert.notEqual(bytesToHex(docDigest(RELAYER, key)), bytesToHex(docDigest(addressOfPriv(OTHER), key)));
  assert.notEqual(bytesToHex(docDigest(RELAYER, key)), bytesToHex(docDigest(RELAYER, gw())));
  assert.equal(docDigest(RELAYER, key).length, 32);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
