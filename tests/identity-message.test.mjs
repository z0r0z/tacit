// The identity message is key material: every Ethereum- or Bitcoin-wallet identity, in every Tacit app, is a hash
// of a signature over these exact bytes, so this test pins them. A failure here means every such identity would change.
import assert from 'node:assert';
import { secp, sha256, keccak_256, hmac, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { identityMessage } from '../dapp/identity-message.js';
import { prfBytesToScalar } from '../dapp/prf-wallet.js';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m)); // as tacit.js sets it

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

ok('message bytes are pinned (mainnet)', () => {
  assert.equal(identityMessage({ netName: 'mainnet' }), [
    'Tacit identity',
    '',
    'Signing this creates your Tacit private key. Anyone who has this signature controls all of your Tacit funds.',
    '',
    'Sign it only in a Tacit app you trust. Every Tacit app asks for exactly this message.',
    '',
    'network: mainnet',
    'version: 1',
  ].join('\n'));
});

ok('networks derive distinct messages; unknown networks are refused', () => {
  assert.notEqual(identityMessage({ netName: 'mainnet' }), identityMessage({ netName: 'signet' }));
  assert.match(identityMessage({ netName: 'signet' }), /\nnetwork: signet\n/);
  assert.throws(() => identityMessage({ netName: 'testnet' }));
});

// evm-wallet's derivation, driven through a wallet that signs EIP-191 with a known key, must equal the hash of the
// signature over the pinned message (the same formula tacit.js's ethWallet.deriveKey uses).
const priv = hexToBytes('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const addr = bytesToHex(keccak_256(secp.getPublicKey(priv, false).slice(1)).slice(12));
const enc = (s) => new TextEncoder().encode(s);
const eip191 = (msg) => { const m = enc(msg); return keccak_256(new Uint8Array([...enc(`\x19Ethereum Signed Message:\n${m.length}`), ...m])); };
const personalSign = (msgHex) => {
  const sig = secp.sign(eip191(new TextDecoder().decode(hexToBytes(msgHex.slice(2)))), priv);
  return '0x' + bytesToHex(sig.toCompactRawBytes()) + (27 + sig.recovery).toString(16);
};
const provider = {
  request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts') return ['0x' + addr];
    if (method === 'eth_getCode') return '0x';
    if (method === 'personal_sign') return personalSign(params[0]);
    throw new Error('unexpected ' + method);
  },
};
globalThis.window = { ethereum: provider, addEventListener() {}, dispatchEvent() {} };
const { makeEvmWallet } = await import('../dapp/evm-wallet.js');
const w = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' });
const got = await w.deriveIdentity();
ok('evm-wallet derives sha256(signature over the pinned message)', () => {
  const msg = identityMessage({ netName: 'mainnet' });
  assert.equal(w.derivationMsg(), msg);
  const want = bytesToHex(prfBytesToScalar(sha256(hexToBytes(personalSign('0x' + bytesToHex(enc(msg))).slice(2)))));
  assert.equal(got.priv, want);
  assert.equal(got.address, addr);
});

console.log(`\n${pass} passed, 0 failed`);
