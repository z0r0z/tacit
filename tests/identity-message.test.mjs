// The identity message is key material: every Ethereum- or Bitcoin-wallet identity is a hash of a signature over
// these exact bytes, so this test pins them. A failure here means every such identity would change.
import assert from 'node:assert';
import { secp, sha256, keccak_256, hmac, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { ethIdentityMessage, btcIdentityMessage, eip55 } from '../dapp/identity-message.js';
import { prfBytesToScalar } from '../dapp/prf-wallet.js';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m)); // as tacit.js sets it

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

ok('EIP-55 reference vectors', () => {
  for (const v of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
    assert.equal(eip55(v.toLowerCase(), keccak_256), v);
    assert.equal(eip55(v.slice(2).toLowerCase(), keccak_256), v);
  }
});

ok('Ethereum message bytes are pinned (mainnet)', () => {
  assert.equal(ethIdentityMessage({ address: '5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', netName: 'mainnet', keccak256: keccak_256 }), [
    'tacit.finance wants you to sign in with your Ethereum account:',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '',
    'Derive your Tacit identity on mainnet. Sign this only on https://tacit.finance; it sends no transaction and moves no funds.',
    '',
    'URI: https://tacit.finance',
    'Version: 1',
    'Chain ID: 1',
    'Nonce: tacitidentity',
    'Issued At: 2026-09-22T00:00:00Z',
  ].join('\n'));
});

ok('networks derive distinct messages; unknown networks are refused', () => {
  const m = (netName) => ethIdentityMessage({ address: '5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', netName, keccak256: keccak_256 });
  assert.notEqual(m('mainnet'), m('signet'));
  assert.match(m('signet'), /\nChain ID: 11155111\n/);
  assert.throws(() => m('testnet'));
  assert.throws(() => btcIdentityMessage({ netName: 'testnet' }));
});

ok('Bitcoin message bytes are pinned (mainnet)', () => {
  assert.equal(btcIdentityMessage({ netName: 'mainnet' }), [
    'tacit.finance: derive your Tacit identity on mainnet.',
    '',
    'Sign this only on https://tacit.finance. It sends no transaction and moves no funds.',
  ].join('\n'));
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
  const msg = ethIdentityMessage({ address: addr, netName: 'mainnet', keccak256: keccak_256 });
  assert.equal(w.derivationMsg(addr), msg);
  const want = bytesToHex(prfBytesToScalar(sha256(hexToBytes(personalSign('0x' + bytesToHex(enc(msg))).slice(2)))));
  assert.equal(got.priv, want);
  assert.equal(got.address, addr);
});

console.log(`\n${pass} passed, 0 failed`);
