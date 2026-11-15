// The hosted watchtower loads the engine with __TACIT_CHAIN_VIA_WORKER__: it reads the chain through the API's proxy, and a 404 from the
// proxy (a transaction not on chain yet) is a plain not-found answer, never a reason to drop the proxy for the public explorers that
// throttle the server.
import { JSDOM } from './_jsdom.mjs';
let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, prompt: () => null, alert() {}, confirm: () => true });
globalThis.__TACIT_NO_INIT__ = true; globalThis.__TACIT_WORKER_BASE__ = 'https://api.example'; globalThis.__TACIT_CHAIN_VIA_WORKER__ = true;
localStorage.setItem('tacit-network-v1', 'mainnet');
process.on('unhandledRejection', () => {});
const urls = [];
globalThis.fetch = async (u) => {
  urls.push(String(u));
  if (String(u).startsWith('https://api.example/chain/tx/')) return new Response('{"error":"not found"}', { status: 404 });
  return new Response('[]', { status: 200 });
};
const m = await import('../dapp/tacit.js');
const a = 'aa'.repeat(32), b = 'bb'.repeat(32);
let e1 = null; try { await m.getTx(a); } catch (e) { e1 = e; }
ok(urls.some((u) => u.startsWith(`https://api.example/chain/tx/${a}`)), "the read goes to the proxy");
ok(!e1 || /404/.test(e1.message), `an unknown transaction reads as not found (${e1?.message || 'null'})`);
const before = urls.length;
try { await m.getTx(b); } catch {}
ok(urls.slice(before).some((u) => u.startsWith(`https://api.example/chain/tx/${b}`)), "after a 404 the next read still goes to the proxy");
ok(!urls.some((u) => /mempool\.space|blockstream/.test(u)), 'no public explorer was asked');
console.log(`\n${n} headless-proxy-404 checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
