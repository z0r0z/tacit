// Tests for the Ethereum wallet-as-identity path (ethWallet.login in
// dapp/tacit.js). Covers the security-load-bearing checks: deterministic key
// derivation (RFC-6979 → same account, same tacit key), smart-contract-wallet
// rejection, signature-from-wrong-account rejection, and the identity-drift
// refusal added in the wallet-identity hardening pass (refuse rather than
// silently swap into a different, empty wallet).
//
// Drives login({address}) with a mocked EIP-1193 provider so the eip6963
// discovery/connect path is bypassed; the mock signs whatever message it's
// handed (real EIP-191), so recoverEthAddrFromSig agrees without hardcoding
// the derivation message.
//
// jsdom + __TACIT_NO_INIT__ shim mirrors the other tacit.js-importing tests.
//
// Run: `node tests/eth-wallet.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'denied', json: async () => ({}) });
globalThis.__TACIT_NO_INIT__ = true;

import { secp, sha256, keccak_256, bytesToHex, hexToBytes, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { prfBytesToScalar as toValidScalar } from '../dapp/prf-wallet.js';
const { ethWallet, wallet } = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};
async function expectThrow(label, fn, check) {
  try { await fn(); ok(label + ' (expected throw)', false); }
  catch (e) { ok(label, check ? !!check(e) : true); }
}

const enc = new TextEncoder();
function eip191Hash(msg) {
  const msgBytes = enc.encode(msg);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  return keccak_256(concatBytes(prefix, msgBytes));
}
function ethAddrOf(priv) {
  const pub = secp.getPublicKey(priv, false); // 65B uncompressed (0x04 || X || Y)
  return bytesToHex(keccak_256(pub.slice(1)).slice(12)); // last 20 bytes, lowercase hex
}
// EIP-191 personal_sign over the exact message handed in via msgHex.
function signPersonal(priv, msgHex) {
  const msgBytes = hexToBytes(String(msgHex).replace(/^0x/, ''));
  const msg = new TextDecoder().decode(msgBytes);
  const sig = secp.sign(eip191Hash(msg), priv); // low-S, carries .recovery
  const v = (sig.recovery + 27).toString(16).padStart(2, '0');
  return '0x' + bytesToHex(sig.toCompactRawBytes()) + v;
}

// Minimal EIP-1193 provider. `code` controls eth_getCode (EOA = '0x'); a
// non-empty value makes the address look like a smart-contract wallet.
function makeProvider({ signingPriv, code = '0x' }) {
  const p = {
    lastSig: null,
    request: async ({ method, params }) => {
      if (method === 'eth_getCode') return code;
      if (method === 'eth_requestAccounts') return ['0x' + ethAddrOf(signingPriv)];
      if (method === 'personal_sign') {
        const sig = signPersonal(signingPriv, params[0]);
        p.lastSig = sig;
        return sig;
      }
      throw new Error('unexpected method ' + method);
    },
  };
  return p;
}

const SIGNER_PRIV = sha256(enc.encode('eth-wallet-test-signer'));
const OTHER_PRIV  = sha256(enc.encode('eth-wallet-test-other'));
const ADDR = ethAddrOf(SIGNER_PRIV);

function reset() {
  try { ethWallet.disconnect(); } catch {}
  ethWallet.state = null;
  wallet.priv = null; wallet.pub = null; wallet.mode = null;
  localStorage.clear();
  globalThis.window.ethereum = null;
}

console.log('ethWallet.login — derivation:');
reset();
{
  const provider = makeProvider({ signingPriv: SIGNER_PRIV });
  globalThis.window.ethereum = provider;
  const st = await ethWallet.login({ address: ADDR });

  ok('login loads an eth-mode identity', wallet.mode === 'eth');
  ok('state binds the signing address', st.address === ADDR);
  // Tacit key = toValidScalar(sha256(65-byte r||s||v)). Recompute from the
  // signature the mock actually returned.
  const sigBytes = hexToBytes(provider.lastSig.slice(2));
  const expectedPubHex = bytesToHex(secp.getPublicKey(toValidScalar(sha256(sigBytes)), true));
  ok('derives tacit key from the signature', bytesToHex(wallet.pub) === expectedPubHex);
  ok('anchors pubkey in state', st.pubkey === expectedPubHex);

  // Determinism: a re-unlock (RFC-6979 → identical signature) reproduces the key.
  const firstPub = bytesToHex(wallet.pub);
  wallet.priv = null; wallet.pub = null; wallet.mode = null;
  await ethWallet.login({ address: ADDR });
  ok('re-unlock reproduces the same identity', bytesToHex(wallet.pub) === firstPub);
}

console.log('\nethWallet.login — rejections:');

// Smart-contract wallet (non-empty bytecode) → non-deterministic sigs, refuse.
reset();
{
  globalThis.window.ethereum = makeProvider({ signingPriv: SIGNER_PRIV, code: '0x60016002' });
  await expectThrow(
    'rejects a smart-contract wallet',
    () => ethWallet.login({ address: ADDR }),
    (e) => /smart-contract|EOA/i.test(e?.message || ''),
  );
}

// EIP-7702 delegated EOA (MetaMask "smart account"): eth_getCode returns the
// 0xef0100 ++ impl-address designator, but the account is still an EOA whose
// personal_sign is its own deterministic ECDSA. Must ACCEPT, not misread as a
// contract wallet (regression: 7702 mainnet accounts couldn't onboard).
console.log('\nethWallet.login — EIP-7702 delegated EOA:');
reset();
{
  const designator = '0xef0100' + '1234567890abcdef1234567890abcdef12345678';
  globalThis.window.ethereum = makeProvider({ signingPriv: SIGNER_PRIV, code: designator });
  const st = await ethWallet.login({ address: ADDR });
  ok('accepts a 7702-delegated EOA', wallet.mode === 'eth' && st.address === ADDR);
}

console.log('\nethWallet.login — rejections (cont.):');

// Provider signs with a different account than claimed → recovery mismatch.
reset();
{
  globalThis.window.ethereum = makeProvider({ signingPriv: OTHER_PRIV });
  await expectThrow(
    'rejects a signature from the wrong account',
    () => ethWallet.login({ address: ADDR }), // ask for ADDR but provider signs with OTHER
    (e) => /not the expected account|Signature is from/i.test(e?.message || ''),
  );
}

console.log('\nethWallet.login — identity-drift refusal (hardening):');

// Enroll, then pin a mismatched anchor to simulate the re-derived key differing
// from the stored one (wallet signing change / message change). Must refuse,
// not silently swap identities.
reset();
{
  globalThis.window.ethereum = makeProvider({ signingPriv: SIGNER_PRIV });
  await ethWallet.login({ address: ADDR }); // enroll, anchor = pubA
  wallet.priv = null; wallet.pub = null; wallet.mode = null; // locked reload
  const driftedPub = bytesToHex(secp.getPublicKey(OTHER_PRIV, true)); // a valid but wrong anchor
  ethWallet.state = { address: ADDR, pubkey: driftedPub };
  await expectThrow(
    'refuses when re-derived key differs from the enrolled anchor',
    () => ethWallet.login({ address: ADDR }),
    (e) => /signature changed/i.test(e?.message || ''),
  );
  ok('refused login leaves the wallet locked', wallet.priv === null && wallet.mode === null);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
