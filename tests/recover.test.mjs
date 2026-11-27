import assert from 'node:assert/strict';
const C = await import('../dapp/recover/core.js');
const mem = (o = {}) => { const m = new Map(Object.entries(o)); return { get length(){return m.size}, key:i=>[...m.keys()][i], getItem:k=>m.get(k)??null, setItem:(k,v)=>m.set(k,v) }; };
assert.deepEqual(C.inspectStorage(mem()), { slots: [], identities: [] });
const priv = new Uint8Array(32); priv[31] = 1;
const raw = await C.encryptPrivkey(priv, 'correct horse battery staple');
const encrypted = C.inspectStorage(mem({ 'tacit-wallet-v1:mainnet': raw })).slots[0];
assert.equal(encrypted.shape, 'encrypted'); assert.match(encrypted.address, /^bc1q/);
const bound = C.inspectStorage(mem({ 'tacit-wallet-v1:signet:by:tb1ptest': raw })).slots[0]; assert.equal(bound.binding, 'tb1ptest');
assert.equal(C.inspectStorage(mem({ 'tacit-wallet-v1:mainnet': '01'.repeat(32) })).slots[0].shape, 'plaintext');
assert.equal(C.inspectStorage(mem({ 'tacit-wallet-v1:mainnet': '{nope' })).slots[0].shape, 'malformed');
assert.equal(C.inspectStorage(mem({ 'tacit-btc-wallet-v1': '{}' })).identities[0].kind, 'Bitcoin wallet signature');
assert.deepEqual(await C.decryptPrivkey(raw, 'correct horse battery staple'), priv);
await assert.rejects(C.decryptPrivkey(raw, 'wrong'), /Wrong passphrase/);
const expected = [
  'Tacit identity\n\nSigning this creates your Tacit private key. Anyone who has this signature controls all of your Tacit funds.\n\nSign it only in a Tacit app you trust. Every Tacit app asks for exactly this message.\n\nnetwork: mainnet\nversion: 1',
  'tacit.finance: derive your Tacit identity on mainnet.\n\nSign this only on https://tacit.finance. It sends no transaction and moves no funds.',
  'Sign this message to derive your tacit.finance identity.\n\nnetwork: mainnet\nversion: 1\n\nThis signature will not send any transaction or spend any funds.',
];
assert.deepEqual(C.HISTORICAL_MESSAGES.map((x) => x.text('mainnet')), expected);
for (const msg of C.HISTORICAL_MESSAGES) for (const protocol of ['ecdsa','bip322']) {
  assert.equal(C.signatureResult(new Uint8Array(64).fill(7), 'mainnet').address, 'bc1qeza8f67ttpq935du8w3wtpujuvz3wkerqrsme5', `${msg.id}/${protocol}`);
}
console.log('recover core: ok');
