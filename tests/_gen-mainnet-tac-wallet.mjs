import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage; globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'mainnet');
import * as secp from '@noble/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
const dapp = await import('../dapp/tacit.js');
const priv = secp.utils.randomPrivateKey();
const pub = secp.getPublicKey(priv, true);
dapp.wallet.priv = priv; dapp.wallet.pub = pub;
const btc = dapp.wallet.address();
console.log('NETWORK: mainnet');
console.log('PRIV:', bytesToHex(priv));
console.log('PUB:', bytesToHex(pub));
console.log('BTC_ADDRESS:', btc);
