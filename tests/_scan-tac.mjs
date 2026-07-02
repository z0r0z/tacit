import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage; globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'mainnet');
import { readFileSync } from 'node:fs';
import * as secp from '/Users/z/tacit/node_modules/@noble/secp256k1/index.js';
const w = JSON.parse(readFileSync('/private/tmp/claude-501/-Users-z-tacit/75f9c6fb-adf6-4ec0-bf4d-e7c268bc747e/scratchpad/mainnet-tac-wallet.json','utf8'));
const priv = Uint8Array.from(w.priv_hex.match(/../g).map(x=>parseInt(x,16)));
const dapp = await import('/Users/z/tacit/dapp/tacit.js');
try { dapp.wallet.priv = priv; dapp.wallet.pub = secp.getPublicKey(priv, true); } catch(e){ console.log('wallet set err', e.message); }
console.log('wallet addr:', (()=>{try{return dapp.wallet.address()}catch(e){return e.message}})());
const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
// try the holdings scan
const fns = Object.keys(dapp).filter(k=>/scan|holding/i.test(k));
console.log('scan-ish exports:', fns.join(', ') || '(none exported)');
for (const fn of ['scanHoldings','scanHoldingsComplete','scanHoldingsCrossChain']) {
  if (typeof dapp[fn] === 'function') {
    try { const r = await dapp[fn](true); console.log(`${fn} ->`, JSON.stringify(r)?.slice(0,300)); break; }
    catch(e){ console.log(`${fn} threw:`, e.message); }
  }
}
// dump any holdings state
for (const k of ['holdings','HOLDINGS','walletHoldings','assetHoldings']) {
  if (dapp[k]) console.log('state', k, JSON.stringify(dapp[k])?.slice(0,400));
}
