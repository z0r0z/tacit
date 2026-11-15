#!/usr/bin/env node
// A bridged token's send on Bitcoin as the wallet makes it (dapp/tacit.js buildAndBroadcastCXferMulti: a bound transfer, T_CXFER_BOUND 0x39, every
// output P2WPKH) as reflection inputs for the PINNED reflection guest. One block [coinbase, commit, reveal] over a prior live set holding the input:
//   send  cUSDT from a note held at the key's P2WPKH address, as a bound transfer's output leaves it (BOUND, zero auth key), 300 of 700 to another
//         key and the change back                                                 folds: two bound notes with the zero auth key, the input nullified
//   move  cUSDT from the note the bridge minted at the key's Taproot address (UNBOUND, auth key = the key's x-only), signed by key path, whole to
//         the key's own P2WPKH address                                            folds: the same
// Each fixture carries the JS mirror's newDigest; reflect-local executes the pinned ELF on it and compares (DIGEST_MATCH). The chain binding is the
// mainnet deployment's. The range proof and kernel take fresh nonces, so each run makes other txids and digests.
//   node tests/gen-reflection-bound-send-synth.mjs <outdir>
//   reflect-local contracts/sp1/confidential/elf/reflection-prover <outdir>/bound_send_send.json
// The two executed against the pinned ELF (DIGEST_MATCH) are kept as contracts/sp1/confidential/fixtures/reflection_bound_send_{send,move}.json.

const store = new Map();
const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), set: () => true });
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, body: el(), head: el(), documentElement: el(), readyState: 'complete' };
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear(), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } };
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', hash: '', search: '', pathname: '/', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true, language: 'en' }, configurable: true }); } catch {}
globalThis.addEventListener = () => {};
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
store.set('tacit-network-v1', 'mainnet');

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hexToBytes, bytesToHex, concatBytes } from '../node_modules/@noble/hashes/utils.js';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: gen-reflection-bound-send-synth.mjs <outdir>');
mkdirSync(outDir, { recursive: true });

const dapp = await import('../dapp/tacit.js');
const { getConfidentialDeployment } = await import('../dapp/confidential-deployments.js');
const { makeScanReflectionIndexer } = await import('../dapp/confidential-reflection-scan-indexer.js');
const { classifyConfidentialTx } = await import('../dapp/burn-deposit-bitcoin.js');
const bs = await import('../dapp/bound-swap.js');
const { computeTxid, computeMerkleRoot, mineHeader, cat } = await import('./btc-mini.mjs');

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const dsha = (b) => sha256(sha256(b));
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const rev = (h) => strip(h).match(/../g).reverse().join('');
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const ZERO = '0x' + '00'.repeat(32);
const BLOCK_HEIGHT = 970101;

const dep = getConfidentialDeployment('mainnet');
const BINDING = '0x' + bytesToHex(keccak_256(hexToBytes(BigInt(dep.chainId).toString(16).padStart(64, '0') + strip(dep.pool))));
const CUSDT = '0xc50e8dd9666f64a23e5457d686382901f08aaea3554328fc4ac25d2f9fac6c00';
const SK = sha256(new TextEncoder().encode('reflect-bound-send/holder'));
dapp.wallet.priv = SK; dapp.wallet.pub = secp.getPublicKey(SK, true); dapp.wallet.mode = 'passkey';
const ADDR = dapp.wallet.address(), PUB = dapp.wallet.pub, XONLY = PUB.slice(1);
const RECIP_PUB = secp.getPublicKey(sha256(new TextEncoder().encode('reflect-bound-send/recipient')), true);
const AMOUNT = 700_000_000n, SEND = 300_000_000n, NOTE_SATS = 546;
const BLINDING = BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode('reflect-bound-send/note-blinding')))) % secp.CURVE.n;
dapp._testSetScanHoldingsOverride(() => new Map());

let broadcasts = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = (opts.method || 'GET').toUpperCase();
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'POST' && typeof opts.body === 'string' && opts.body.includes('"jsonrpc"')) {
    const rpc = JSON.parse(opts.body);
    if (rpc.method === 'eth_getStorageAt') return json({ jsonrpc: '2.0', id: rpc.id, result: word(0) });
    return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'mock' } });
  }
  if (u.endsWith('/v1/fees/recommended')) return json({ fastestFee: 10, halfHourFee: 5, hourFee: 2, economyFee: 1, minimumFee: 1 });
  if (u.includes('/scripthash/')) return json([]);
  if (u.includes(`/address/${ADDR}/utxo`)) { dapp._testClearRecentSpends(); return json([{ txid: bytesToHex(sha256(new TextEncoder().encode('reflect-bound-send/sats-' + broadcasts.length))), vout: 0, value: 5_000_000, status: { confirmed: true } }]); }
  if (method === 'POST' && u.endsWith('/tx')) { if (!broadcasts.includes(opts.body)) broadcasts.push(opts.body); return new Response('0'.repeat(64), { status: 200 }); }
  if (/\/tx\/[0-9a-f]{64}\/outspend\/\d+$/.test(u)) return json({ spent: false });
  if (method === 'GET' && /\/tx\/[0-9a-f]{64}$/.test(u)) return broadcasts.length ? json({ txid: u.slice(-64), status: { confirmed: false } }) : json({ error: 'Not found' }, 404);
  if (u.includes('/blocks/tip/height')) return new Response('0', { status: 200 });
  if (u.includes('/assets/hint')) return json({ ok: true });
  return json({ error: 'mock: no handler for ' + u }, 404);
};

function block(hexes) {
  const txs = hexes.map((h) => Buffer.from(strip(h), 'hex'));
  const ids = txs.map(computeTxid);
  const reserved = Buffer.alloc(32, 7);
  const wcommit = dsha(cat([computeMerkleRoot([Buffer.alloc(32), ...txs.map(dsha)]), reserved]));
  const coinbase = cat([
    [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
    [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
    [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,
    [0x01], [0x20], reserved, Buffer.alloc(4),
  ]);
  const cbTxid = computeTxid(coinbase);
  return { coinbase, cbTxid, txs, ids, header: mineHeader(computeMerkleRoot([cbTxid, ...ids])) };
}

const CASES = {
  send: { tag: 'send', recipient: RECIP_PUB, amount: SEND, taproot: false },
  move: { tag: 'move', recipient: PUB, amount: AMOUNT, taproot: true },
};
const summary = {};
for (const [name, c] of Object.entries(CASES)) {
  const noteTxid = bytesToHex(sha256(new TextEncoder().encode(`reflect-bound-send/${c.tag}/note`)));
  const input = { utxo: { txid: noteTxid, vout: 0, value: NOTE_SATS }, amount: AMOUNT, blinding: BLINDING,
    ...(c.taproot ? { scriptpubkey: bytesToHex(concatBytes(Uint8Array.of(0x51, 0x20), XONLY)), taprootKeyPath: true } : {}) };
  broadcasts = [];
  await dapp.buildAndBroadcastCXferMulti({ assetIdHex: strip(CUSDT), recipients: [{ pubHex: bytesToHex(c.recipient), amount: c.amount }], forceUtxos: [input], useBpp: true });
  const [commitHex, revealHex] = broadcasts;
  const reveal = bs.parseTx(revealHex), d = classifyConfidentialTx('0x' + strip(revealHex));
  if (!d || d.type !== 'cxfer_bound' || strip(d.target) !== strip(BINDING)) throw new Error(`${name}: the builder did not make a bound transfer to this pool`);

  const b = block([commitHex, revealHex]);
  const ix = makeScanReflectionIndexer({ secp, keccak256: keccak_256, sha256 });
  const cp = ix.pool, st = ix.state();
  st.setHeight(BLOCK_HEIGHT - 1);
  const C = dapp.pedersenCommit(AMOUNT, BLINDING).toAffine(), cx = word(C.x), cy = word(C.y);
  const key = cp.outpointKey('0x' + rev(noteTxid), 0);
  if (c.taproot) { const auth = '0x' + bytesToHex(XONLY); st.foldOutput(cp.btcNoteLeaf(CUSDT, cx, cy, auth), key, cp.commitmentHash(cx, cy), CUSDT, auth); }
  else st.foldOutputBound(cp.btcNoteLeafBound(CUSDT, cx, cy, ZERO, BINDING), key, cp.commitmentHash(cx, cy), CUSDT, ZERO);
  ix.coords().set(key.toLowerCase(), { cx, cy });
  const before = st.counts();
  const fixture = await ix.assembleBlocks([{ txs: [
    { txidDisplay: Buffer.from(b.cbTxid).reverse().toString('hex'), rawHex: Buffer.from(b.coinbase).toString('hex'), decode: null, vins: [] },
    ...b.txs.map((raw, i) => {
      const t = bs.parseTx(raw.toString('hex'));
      return { txidDisplay: Buffer.from(b.ids[i]).reverse().toString('hex'), rawHex: raw.toString('hex'), decode: classifyConfidentialTx('0x' + raw.toString('hex')), vins: t.inputs.map((x) => ({ prevTxidDisplay: x.txid, vout: x.vout })) };
    }),
  ] }], { headers: ['0x' + Buffer.from(b.header).toString('hex')], anchorHeight: BLOCK_HEIGHT, chainBinding: BINDING });
  const after = st.counts();
  const k = (txid, vout) => cp.outpointKey('0x' + rev(txid), vout);
  const triple = (vout) => ix.snapshot().liveTriples.find((t) => strip(t[0]) === strip(k(reveal.txid, vout))) || null;
  const t0 = triple(0), t1 = triple(1);
  const r = {
    opcode: '0x39', inputBound: !c.taproot, outputs: reveal.outputs.map((o) => bytesToHex(o.script).slice(0, 4)),
    folded: fixture.blocks[0].txs.slice(1).map((t) => t.outputs.length), skipped: (fixture.nonConserving || []).map((s) => s.reason),
    out0: t0 && { bound: Number(t0[4]), authZero: /^0*$/.test(strip(t0[3] || '0')) }, out1: t1 && { bound: Number(t1[4]), authZero: /^0*$/.test(strip(t1[3] || '0')) },
    inputLive: st._acc.live.get(key) != null, live: `${before.live}->${after.live}`, notes: `${before.note}->${after.note}`, spent: `${before.spent}->${after.spent}`,
    chainBinding: fixture.chainBinding, newDigest: fixture.newDigest, revealTxid: reveal.txid,
  };
  summary[name] = r;
  writeFileSync(join(outDir, `bound_send_${name}.json`), JSON.stringify(fixture));
  console.error(`${name}: ${JSON.stringify(r)}`);
}
writeFileSync(join(outDir, 'bound_send_summary.json'), JSON.stringify({ asset: CUSDT, chainBinding: BINDING, cases: summary }, null, 2));
process.exit(0);
