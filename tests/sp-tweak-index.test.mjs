// Silent-payment tweak index (worker-relay/src/sp-tweak-index.js) against the official BIP-352 vectors.
//
// Every receiving vector's transaction is packed into one mock block. The index must publish exactly the
// vector's expected tweak (input_hash·A_sum) for each eligible transaction and nothing for the rest; a wallet
// holding the vector's keys must then find exactly the expected outputs from the served tweaks alone. Also
// covers the HTTP surface, a reorg, the bitcoind (getblock verbosity 3) adapter, and the dapp's
// scanSilentPaymentsViaIndex end to end for both wallet key versions, with signed spends of what it found.
//
// Run: node tests/sp-tweak-index.test.mjs
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const g = globalThis;
const set = (k, v) => { try { g[k] = v; } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); } };
set('window', dom.window);
set('document', dom.window.document);
set('localStorage', dom.window.localStorage);
set('location', dom.window.location);
if (!g.navigator) set('navigator', dom.window.navigator);
g.prompt = () => null; g.alert = () => {}; g.confirm = () => false;
g.__TACIT_NO_INIT__ = true;
dom.window.localStorage.setItem('tacit-network-v1', 'signet');

// better-sqlite3 lives in worker-relay's node_modules; the service resolves it from there.
createRequire(new URL('../worker-relay/package.json', import.meta.url))('better-sqlite3');
const IX = await import('../worker-relay/src/sp-tweak-index.js');
const T = await import('../dapp/tacit.js');
const VECTORS = JSON.parse(readFileSync(new URL('./vectors/bip352-send-and-receive.json', import.meta.url), 'utf8'));

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => { const b = new Uint8Array(h.length >> 1); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16); return b; };
const fakeTxid = (s) => hex(sha256(new TextEncoder().encode(s)));

function parseWitness(h) {
  if (!h) return [];
  const buf = unhex(h);
  let i = 0;
  const varint = () => { const b = buf[i++]; if (b < 0xfd) return b; if (b === 0xfd) { const v = buf[i] | (buf[i + 1] << 8); i += 2; return v; } throw new Error('varint'); };
  const n = varint();
  const items = [];
  for (let k = 0; k < n; k++) { const len = varint(); items.push(hex(buf.slice(i, i + len))); i += len; }
  return items;
}

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

// ---------------------------------------------------------------- mock chain
const coinbase = (h) => ({ txid: fakeTxid(`cb${h}`), vin: [{ is_coinbase: true, txid: '00'.repeat(32), vout: 0xffffffff }], vout: [{ scriptpubkey: '5120' + '77'.repeat(32), value: 5e9 }] });
const cases = [];
VECTORS.forEach((v, vi) => v.receiving.forEach((r, ri) => {
  const txid = fakeTxid(`vec${vi}.${ri}`);
  cases.push({ vi, ri, txid, r, comment: v.comment, tx: {
    txid,
    vin: r.given.vin.map((x) => ({ txid: x.txid, vout: x.vout, scriptsig: x.scriptSig || '', witness: parseWitness(x.txinwitness), prevout: { scriptpubkey: x.prevout.scriptPubKey.hex } })),
    vout: [{ scriptpubkey: '0014' + '00'.repeat(20), value: 1234 }, ...r.given.outputs.map((x) => ({ scriptpubkey: '5120' + x, value: 1000 }))],
  } });
}));
const noTaproot = { txid: fakeTxid('p2wpkh-only'), vin: cases[0].tx.vin, vout: [{ scriptpubkey: '0014' + '11'.repeat(20), value: 5000 }] };

function makeChain() {
  const blocks = new Map(); // height -> { hash, prev, time, txs }
  const add = (height, txs, salt = '') => {
    const prev = blocks.get(height - 1)?.hash || '00'.repeat(32);
    blocks.set(height, { hash: fakeTxid(`blk${height}${salt}`), prev, time: 1_700_000_000 + height, txs });
  };
  return {
    blocks, add,
    source: {
      name: 'mock',
      async tipHeight() { return Math.max(...blocks.keys()); },
      async blockHash(h) { const b = blocks.get(h); if (!b) throw new Error('404'); return b.hash; },
      async block(hash) { for (const [height, b] of blocks) if (b.hash === hash) return { hash, height, prev: b.prev, time: b.time, txs: b.txs }; throw new Error('404'); },
    },
  };
}

const chain = makeChain();
chain.add(99, [coinbase(99)]);
chain.add(100, [coinbase(100), noTaproot, ...cases.map((c) => c.tx)]);
chain.add(101, [coinbase(101)]);
const store = IX.openStore(':memory:');
const ix = IX.createIndexer({ source: chain.source, store, startHeight: 99, network: 'signet' });
await ix.step();

console.log('Index vs vectors:');
const b100 = store.get(100);
const byTxid = new Map(b100.tweaks.map((e) => [e.txid, e]));
check('coinbase and no-taproot txs are not published', !byTxid.has(coinbase(100).txid) && !byTxid.has(noTaproot.txid));
for (const c of cases) {
  const label = `index ${c.vi}.${c.ri} ${c.comment}`;
  const e = byTxid.get(c.txid);
  const want = c.r.expected.tweak || null;
  if (!want) { check(label, !e, e ? 'published a tweak for an ineligible tx' : ''); continue; }
  if (!e || e.tweak !== want) { check(label, false, `tweak ${e?.tweak} != ${want}`); continue; }
  const outsOk = e.outputs.length === c.r.given.outputs.length && e.outputs.every((o, i) => o.vout === i + 1 && o.xonly === c.r.given.outputs[i] && o.value === 1000);
  // The wallet side, from the served tweak alone.
  const scanPriv = unhex(c.r.given.key_material.scan_priv_key);
  const spendPriv = unhex(c.r.given.key_material.spend_priv_key);
  const outputs = [{ script: unhex('0014' + '00'.repeat(20)) }, ...e.outputs.map((o) => ({ script: unhex('5120' + o.xonly) }))];
  const matches = T.receiverScanOutputsWithTweak({ tweak: unhex(e.tweak), outputs, scanPriv, spendPub: secp.getPublicKey(spendPriv, true), labels: c.r.given.labels });
  let ok = outsOk;
  if (c.r.expected.outputs) {
    const got = matches.map((m) => `${hex(m.outputXonly)}:${hex(m.tweak)}`).sort();
    const exp = c.r.expected.outputs.map((o) => `${o.pub_key}:${o.priv_key_tweak}`).sort();
    ok = ok && JSON.stringify(got) === JSON.stringify(exp);
  } else ok = ok && matches.length === c.r.expected.n_outputs;
  check(label, ok, ok ? '' : `outputs ${outsOk} matches ${matches.length}`);
}

// ---------------------------------------------------------------- HTTP
console.log('\nHTTP:');
const srv = createServer(IX.createHandler({ store, network: 'signet', sourceName: 'mock' }));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
{
  const tip = await (await fetch(`${base}/sp/tip`)).json();
  check('/sp/tip reports the indexed top and start', tip.height === 101 && tip.hash === chain.blocks.get(101).hash && tip.startHeight === 99 && tip.network === 'signet');
  const r = await fetch(`${base}/sp/tweaks/100`);
  const j = await r.json();
  check('/sp/tweaks/:height serves the block', j.height === 100 && j.hash === chain.blocks.get(100).hash && j.tweaks.length === b100.tweaks.length);
  check('CORS * on GET', r.headers.get('access-control-allow-origin') === '*');
  const pre = await fetch(`${base}/sp/tweaks/100`, { method: 'OPTIONS' });
  check('OPTIONS preflight allowed', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*');
  check('unindexed height is 404', (await fetch(`${base}/sp/tweaks/5000`)).status === 404);
  const rng = await (await fetch(`${base}/sp/tweaks?from=99&to=101`)).json();
  check('range returns contiguous blocks', rng.blocks.map((b) => b.height).join() === '99,100,101' && rng.tip === 101);
  check('oversized range refused', (await fetch(`${base}/sp/tweaks?from=0&to=500`)).status === 400);
  check('POST refused', (await fetch(`${base}/sp/tip`, { method: 'POST' })).status === 405);
  const h = await (await fetch(`${base}/health`)).json();
  check('/health ok', h.ok === true && h.height === 101);
}

// ---------------------------------------------------------------- reorg
console.log('\nReorg:');
{
  const oldHash = chain.blocks.get(101).hash;
  chain.add(101, [coinbase(101), cases[0].tx], 'b');
  chain.add(102, [coinbase(102)], 'b');
  await ix.step();
  const b = store.get(101);
  check('replaced block re-indexed', b.hash !== oldHash && b.hash === chain.blocks.get(101).hash && b.tweaks.length === 1);
  check('indexing continued past the fork', store.get(102)?.hash === chain.blocks.get(102).hash);
}

// ---------------------------------------------------------------- bitcoind adapter
console.log('\nbitcoind adapter:');
{
  const c = cases[8];
  const rpcTx = {
    txid: c.txid,
    vin: c.tx.vin.map((v) => ({ txid: v.txid, vout: v.vout, scriptSig: { hex: v.scriptsig }, txinwitness: v.witness.length ? v.witness : undefined, prevout: { scriptPubKey: { hex: v.prevout.scriptpubkey } } })),
    vout: c.tx.vout.map((o) => ({ scriptPubKey: { hex: o.scriptpubkey }, value: o.value / 1e8 })),
  };
  const cb = { txid: 'ab'.repeat(32), vin: [{ coinbase: '03aabbcc' }], vout: [{ scriptPubKey: { hex: '5120' + '11'.repeat(32) }, value: 50 }] };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ url, method, auth: init.headers.Authorization });
    const result = method === 'getblock' ? { hash: params[0], height: 7, previousblockhash: 'cc'.repeat(32), time: 1, tx: [cb, rpcTx] } : null;
    return { json: async () => ({ result, error: null }) };
  };
  const src = IX.makeRpcSource({ url: 'http://user:pa%24s@127.0.0.1:8332/', fetchImpl });
  const blk = await src.block('dd'.repeat(32));
  const tw = IX.computeBlockTweaks(blk.txs);
  check('getblock v3 → same tweak as the vector', tw.length === 1 && tw[0].tweak === c.r.expected.tweak && tw[0].outputs[0].value === 1000);
  check('RPC credentials sent as basic auth, not in the URL', calls[0].auth === 'Basic ' + Buffer.from('user:pa$s').toString('base64') && !calls[0].url.includes('user'));
}

// ---------------------------------------------------------------- wallet end to end
console.log('\nWallet scan through the index (both key versions):');
{
  const walletPriv = unhex('5c2ab6d5c3a6e0b1f7d4a3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e');
  T.wallet.priv = walletPriv;
  T.wallet.pub = secp.getPublicKey(walletPriv, true);
  const v1 = T.deriveWalletSilentPaymentKeys(walletPriv, 1);
  const v0 = T.deriveWalletSilentPaymentKeys(walletPriv, 0);
  // A sender with one P2WPKH input pays the new address in one tx and the old one in another.
  const senderPriv = unhex('11'.repeat(32));
  const senderPub = secp.getPublicKey(senderPriv, true);
  const pay = (keys, tag) => {
    const inTxid = fakeTxid(`fund-${tag}`);
    const [out] = T.senderComputeSilentPaymentOutputs({
      inputPrivs: [senderPriv], inputOutpoints: [T.bip352OutpointBytes(inTxid, 0)],
      recipients: [{ scanPub: keys.scanPub, spendPub: keys.spendPub }],
    });
    return {
      txid: fakeTxid(`pay-${tag}`),
      vin: [{ txid: inTxid, vout: 0, scriptsig: '', witness: ['30'.repeat(71), hex(senderPub)], prevout: { scriptpubkey: hex(T.p2wpkhScript(senderPub)) } }],
      vout: [{ scriptpubkey: '0014' + '22'.repeat(20), value: 9000 }, { scriptpubkey: '5120' + hex(out.xOnly), value: 4321 }],
    };
  };
  const txNew = pay(v1, 'new'), txOld = pay(v0, 'old');
  chain.add(103, [coinbase(103), txNew, txOld]);
  await ix.step();
  const seen = [];
  const res = await T.scanSilentPaymentsViaIndex({ baseUrl: base, fromHeight: 99, onProgress: (p) => seen.push(p) });
  check('scan covered the indexed range', res.from === 99 && res.to === 103 && res.blocks === 5 && seen.length === 1);
  const f = (txid) => res.found.find((x) => x.txid === txid);
  check('payment to the new address found as version 1', f(txNew.txid)?.keyVersion === 1 && f(txNew.txid)?.vout === 1 && f(txNew.txid)?.sats === 4321);
  check('payment to the legacy address found as version 0', f(txOld.txid)?.keyVersion === 0 && f(txOld.txid)?.vout === 1);
  check('nothing else matched', res.found.length === 2);
  check('resume point recorded', T.spIndexLastScanned() === 103);
  for (const [tx, ver] of [[txNew, 1], [txOld, 0]]) {
    const credit = T.getSpCredit(tx.txid, 1);
    const sk = T.spCreditSpendingKey(credit);
    const xonly = secp.getPublicKey(sk, true).slice(1);
    const script = T.p2trScript(xonly);
    const spendTx = { version: 2, locktime: 0, inputs: [{ txid: tx.txid, vout: 1, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: 4000, script: T.p2wpkhScript(T.wallet.pub) }] };
    const prevouts = [{ value: 4321, script }];
    const [sig] = T.signTaprootKeypathInput(spendTx, 0, prevouts, sk);
    const sh = T.tapSighashKeyPath(spendTx, 0, prevouts, 0x00);
    check(`v${ver} credit key opens the output and its key-path signature verifies`,
      credit.keyVersion === ver && hex(xonly) === tx.vout[1].scriptpubkey.slice(4) && T.verifySchnorr(sig, sh, xonly));
  }
  const again = await T.scanSilentPaymentsViaIndex({ baseUrl: base });
  check('a second scan resumes after the last height', again.from === 104 && again.blocks === 0);
  T.wallet.priv = null; T.wallet.pub = null;
}

srv.close();
console.log(`\nFinal: ${pass} passed · ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
