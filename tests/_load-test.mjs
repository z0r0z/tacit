import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage; globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1','signet');
console.log('loading tacit.js...');
const dapp = await import('../dapp/tacit.js').catch(e => { console.log('IMPORT ERR', e.message); process.exit(2); });
console.log('loaded OK. encodeEnvelopeScript=' + typeof dapp.encodeEnvelopeScript + ' wallet=' + typeof dapp.wallet + ' broadcast=' + typeof dapp.broadcast + ' getUtxos=' + typeof dapp.getUtxos + ' signTaprootScriptPathInput=' + typeof dapp.signTaprootScriptPathInput);
process.exit(0);
