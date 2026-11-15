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
let rest = 0;
globalThis.fetch = async (u) => {
  urls.push(String(u));
  if (rest > 0 && String(u).includes('/chain/address/')) { rest--; return new Response('{"error":"all upstreams cooling"}', { status: 429, headers: { 'retry-after': '120' } }); }
  if (String(u).startsWith('https://api.example/chain/tx/')) return new Response('{"error":"not found"}', { status: 404 });
  if (String(u).startsWith('https://api.example/chain/v1/fees/recommended?network=mainnet')) return new Response('{"fastestFee":3,"halfHourFee":2,"hourFee":2,"economyFee":1,"minimumFee":1}', { status: 200 });
  if (/mempool|blockstream/.test(String(u))) return new Response('rate limited', { status: 429 });
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
const rate = await m.getFeeRate('standard');
ok(rate === 2, `with every explorer throttled the fee rate comes from the proxy, not the 15 sat/vB fallback (${rate})`);
// one 429 from the proxy with a two-minute Retry-After rests it for seconds, not minutes: the next read goes through it
rest = 1;
const addr = 'bc1qdp49dk80dlg39gvnm05hplwwsh2ec4yehdwavv';
let r1err = null; try { await m.getUtxos(addr); } catch (e) { r1err = e.message; }
await new Promise((r) => setTimeout(r, 5_500));
const at = urls.length; let r2err = null, r2 = null; try { r2 = await m.getUtxos(addr); } catch (e) { r2err = e.message; }
ok(!r2err && urls.slice(at).some((u) => u.includes('api.example/chain/address/')), `after a long Retry-After from the proxy the next read goes through it (${r2err || 'ok'}; first read: ${r1err || 'ok'})`);

console.log(`\n${n} headless-proxy-404 checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
