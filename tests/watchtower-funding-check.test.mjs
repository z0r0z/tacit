// A watchtower registration's funding is checked by the API (worker/src/index.js watchtowerFundingCheck): its outpoint must pay the
// bid wallet (P2WPKH of bid_pubkey) at least the bid's price, in the mempool or a block, so a registration costs real sats. A funding
// not seen yet answers 409 funding_not_seen and is not counted against the write limits (the page asks again a moment later); a wrong
// script or a short output is refused; an upstream it cannot read answers 503. The chain is mocked: no network.
//   node tests/watchtower-funding-check.test.mjs
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { buildEnv } from '../server/harness.mjs';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex } from '@noble/hashes/utils';
import { signSchnorr } from '../dapp/bulletproofs.js';

globalThis.caches = createCacheStorage({ maxBytes: 8 * 1024 * 1024 });
const worker = (await import('../worker/src/index.js')).default;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; console.log(`  FAIL - ${m}`); } };
const NET = 'signet', ctx = { waitUntil: () => {} };
const env = buildEnv(createMemDriver(), { extra: { WATCHTOWER_REGISTER_ENABLED: 'true' } });

// the chain: txid -> the answer an Esplora gives for /tx/<txid>
const chain = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const m = /\/tx\/([0-9a-f]{64})$/.exec(url);
  if (m && !url.startsWith('https://api.test')) {
    const a = chain.get(m[1]);
    if (a === 'down') return new Response('upstream down', { status: 500 });
    if (!a) return new Response('Transaction not found', { status: 404 });
    return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};
async function call(method, path, body) {
  const init = { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) };
  const resp = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  let json; try { json = JSON.parse(await resp.text()); } catch { json = {}; }
  return { status: resp.status, json };
}
const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const OWNER = new Uint8Array(32).fill(7), OWNER_PUB = bytesToHex(secp.getPublicKey(OWNER, true));
const BID_PUB = bytesToHex(secp.getPublicKey(new Uint8Array(32).fill(9), true));
const WPKH = '0014' + bytesToHex(ripemd160(sha256(hex(BID_PUB))));
const ASSET = 'ab'.repeat(32), PRICE = 1200, EXP = Math.floor(Date.now() / 1000) + 3600;
// a self-take bound registration (its signed record names 32 zero bytes for the key), one per bid id
async function register(bidId, fundTxid) {
  const msg = sha256(cat(new TextEncoder().encode('tacit-watchtower-register-v1'), new TextEncoder().encode(NET), hex(ASSET), hex(bidId), hex(BID_PUB), hex(OWNER_PUB), new Uint8Array(32),
    u64(PRICE), u64('800'), u32(8), u64(EXP), hex(fundTxid).reverse(), u32(0)));
  return call('POST', `/watchtower/bids?network=${NET}`, { asset_id: ASSET, bid_id: bidId, owner_pubkey: OWNER_PUB, bid_pubkey: BID_PUB, bid_price_sats: PRICE, bid_amount_base: '800',
    decimals: 8, expiry: EXP, funding_outpoint: { txid: fundTxid, vout: 0 }, kind: 'bound', self_take: true, auth_sig: bytesToHex(signSchnorr(msg, OWNER)) });
}
const counted = async () => { const day = new Date().toISOString().slice(0, 10); return Number(await env.REGISTRY_KV.get(`ob-write-rl:pk:${day}:watchtower-register:${OWNER_PUB}`) || 0); };

const T1 = '11'.repeat(32), T2 = '22'.repeat(32), T3 = '33'.repeat(32), T4 = '44'.repeat(32);
let r = await register('a1'.repeat(16), T1);
ok(r.status === 409 && r.json.code === 'funding_not_seen', `a funding the chain has not seen is answered "not seen yet" (${r.status} ${r.json.code})`);
ok(await counted() === 0, 'and that answer is not counted against the write limits');
chain.set(T1, { txid: T1, vout: [{ scriptpubkey: WPKH, value: 3600 }], status: { confirmed: false } });
r = await register('a1'.repeat(16), T1);
ok(r.status === 200 && r.json.bid?.bid_id === 'a1'.repeat(16), `the same registration goes through once its funding is in the mempool (${r.status} ${r.json.error || ''})`);
ok(await counted() === 1, 'and it is counted once');
chain.set(T2, { txid: T2, vout: [{ scriptpubkey: '0014' + '00'.repeat(20), value: 3600 }] });
r = await register('a2'.repeat(16), T2);
ok(r.status === 400 && r.json.code === 'funding_wrong', `a funding that pays another script is refused (${r.status} ${r.json.code})`);
chain.set(T3, { txid: T3, vout: [{ scriptpubkey: WPKH, value: PRICE - 1 }] });
r = await register('a3'.repeat(16), T3);
ok(r.status === 400 && r.json.code === 'funding_short', `a funding under the bid's price is refused (${r.status} ${r.json.code})`);
chain.set(T4, 'down');
r = await register('a4'.repeat(16), T4);
ok(r.status === 503 && r.json.code === 'funding_unchecked', `an upstream that cannot be read answers 503, to be asked again (${r.status} ${r.json.code})`);
ok(!(await env.REGISTRY_KV.get(`wtbid:${NET}:${bytesToHex(ripemd160(sha256(hex(OWNER_PUB))))}:${'a2'.repeat(16)}`)), 'a refused registration stores nothing');

console.log(`\n${pass} watchtower-funding-check checks passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
