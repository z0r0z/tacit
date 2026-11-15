// A token bridged from the pool to Bitcoin, other than TAC, is sent, split and moved by the wallet's own transfer builder (dapp/tacit.js
// buildAndBroadcastCXferMulti) as a bound transfer (T_CXFER_BOUND, 0x39), and the bytes it broadcasts are what the reflection folds and the bridge burns:
//
//   1  a send of cUSDT from a note held at the key's P2WPKH address: the reveal is 0x39 naming this pool's chain binding, every output is P2WPKH, the
//      note's signature is SIGHASH_ALL, and the recipient opens its output from its own key and the sender's
//   2  the reflection's JS mirror (the guest's fold) folds that reveal: both outputs live as BOUND notes with the zero auth key (no Taproot key, so the
//      fast lane can never spend them), the input nullified
//   3  the recipient's note burns home: the burn planner finds its bound leaf (class 2) in the folded note tree, under the zero owner
//   4  the move off the Taproot address (a note the bridge minted, unbound, signed by key path) is a 0x39 too, and folds the same way
//   5  TAC is unchanged (a plain 0x22/0x23 transfer); a stealth recipient for a bridged token is refused before anything is sent
//   6  the wallet names a bridged token it has no etch for (cUSDT at 6 decimals, a runtime token at its own)
//
//   node tests/bridged-bound-send.test.mjs

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

import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');
const { getConfidentialDeployment } = await import('../dapp/confidential-deployments.js');
const { classifyConfidentialTx, inputFirstWitnessItem, sigBindsAllOutputs } = await import('../dapp/burn-deposit-bitcoin.js');
const { makeScanReflectionIndexer } = await import('../dapp/confidential-reflection-scan-indexer.js');
const { makeConfidentialTransfer } = await import('../dapp/confidential-transfer.js');
const { makeConfidentialBridgeMint } = await import('../dapp/confidential-bridge-mint.js');
const { makeBridgeBurnBroadcaster } = await import('../dapp/bridge-burn-broadcast.js');
const bs = await import('../dapp/bound-swap.js');

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { console.log(`  ok - ${label}`); pass++; } else { console.log(`  FAIL - ${label}`); fail++; } };
const section = async (title, fn) => { console.log(`\n# ${title}`); try { await fn(); } catch (e) { fail++; console.log(`  FAIL - ${title} threw\n${e.stack}`); } };
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const rev = (h) => strip(h).match(/../g).reverse().join('');
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const ZERO = '0x' + '00'.repeat(32);
const p2wpkh = (pub) => concatBytes(Uint8Array.of(0x00, 0x14), ripemd160(sha256(pub)));

// ---- the deployment, the parties, the token ----
const dep = getConfidentialDeployment('mainnet');
const BINDING = '0x' + bytesToHex(keccak_256(hexToBytes(BigInt(dep.chainId).toString(16).padStart(64, '0') + strip(dep.pool))));
const SK = hexToBytes('0c'.repeat(32));
dapp.wallet.priv = SK; dapp.wallet.pub = secp.getPublicKey(SK, true); dapp.wallet.mode = 'passkey';
const ADDR = dapp.wallet.address(), PUB = dapp.wallet.pub, XONLY = PUB.slice(1);
const RECIP_SK = hexToBytes('0d'.repeat(32)), RECIP_PUB = secp.getPublicKey(RECIP_SK, true);
const CUSDT = 'c50e8dd9666f64a23e5457d686382901f08aaea3554328fc4ac25d2f9fac6c00';
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const AMOUNT = 700n, SEND = 300n, BLINDING = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn, NOTE_SATS = 546;

dapp._testSetScanHoldingsOverride(() => new Map());   // the notes are handed to the builder

// ---- the chain, as the builder sees it (Ethereum: nothing spent) ----
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
  if (u.includes(`/address/${ADDR}/utxo`)) { dapp._testClearRecentSpends(); return json([{ txid: 'ee'.repeat(32), vout: 0, value: 5_000_000, status: { confirmed: true } }]); }
  if (method === 'POST' && u.endsWith('/tx')) { if (!broadcasts.includes(opts.body)) broadcasts.push(opts.body); return new Response('0'.repeat(64), { status: 200 }); }
  if (/\/tx\/[0-9a-f]{64}\/outspend\/\d+$/.test(u)) return json({ spent: false });
  if (method === 'GET' && /\/tx\/[0-9a-f]{64}$/.test(u)) return broadcasts.length ? json({ txid: u.slice(-64), status: { confirmed: false } }) : json({ error: 'Not found' }, 404);
  if (u.includes('/blocks/tip/height')) return new Response('0', { status: 200 });
  if (u.includes('/assets/hint')) return json({ ok: true });
  return json({ error: 'mock: no handler for ' + u }, 404);
};

let seq = 0;
const noteAt = (extra = {}) => ({ utxo: { txid: String(++seq).padStart(2, '0').repeat(32).slice(0, 64), vout: 0, value: NOTE_SATS }, amount: AMOUNT, blinding: BLINDING, ...extra });
async function send(args) {
  broadcasts = [];
  const r = await dapp.buildAndBroadcastCXferMulti({ useBpp: true, ...args });
  const [commitHex, revealHex] = broadcasts;
  const reveal = bs.parseTx(revealHex);
  const env = dapp.decodeEnvelopeScript(reveal.inputs[0].witness[1]);
  return { r, commitHex, revealHex, reveal, env };
}

// ---- the reflection's JS mirror: one live note (its auth key and bound tag as given), then the block [commit, reveal] ----
async function reflect(sent, { input, auth, bound }) {
  const ix = makeScanReflectionIndexer({ secp, keccak256: keccak_256, sha256 });
  const cp = ix.pool, norm = (x) => cp._internal.hx(cp._internal.b32(x));
  const C = dapp.pedersenCommit(AMOUNT, BLINDING).toAffine(), cx = word(C.x), cy = word(C.y);
  const key = cp.outpointKey('0x' + rev(input.utxo.txid), input.utxo.vout);
  ix.state()._acc.live.insert(key, cp.commitmentHash(cx, cy), '0x' + CUSDT, auth, bound);
  ix.coords().set(norm(key), { cx, cy });
  const rows = [sent.commitHex, sent.revealHex].map((h) => { const t = bs.parseTx(h); return { txidDisplay: t.txid, rawHex: strip(h), decode: classifyConfidentialTx('0x' + strip(h)), vins: t.inputs.map((i) => ({ prevTxidDisplay: i.txid, vout: i.vout })) }; });
  const before = ix.state().counts();
  const out = await ix.assembleBlocks([{ txs: rows }], { headers: [], anchorHeight: 100, chainBinding: BINDING });
  const k = (txid, vout) => cp.outpointKey('0x' + rev(txid), vout);
  const triple = (txid, vout) => ix.snapshot().liveTriples.find((t) => strip(t[0]) === strip(k(txid, vout))) || null;
  return { ix, cp, folded: out.blocks[0].txs.map((t) => t.outputs.length), skipped: out.nonConserving, before, after: ix.state().counts(), inputLive: ix.state()._acc.live.get(key) != null, triple };
}

let held = null;   // the send of §1, reused by §2 and §3

await section('1. a send of cUSDT from a note at the key\'s P2WPKH address is a bound transfer', async () => {
  const input = noteAt();
  const s = await send({ assetIdHex: CUSDT, recipients: [{ pubHex: bytesToHex(RECIP_PUB), amount: SEND }], forceUtxos: [input] });
  held = { ...s, input };
  ok(broadcasts.length === 2, 'commit then reveal are broadcast');
  ok(s.env && s.env.opcode === 0x39 && s.env.payload[0] === 0x39 && strip(bytesToHex(s.env.payload.slice(1, 33))) === strip(BINDING),
    `the reveal's envelope is 0x39 and names this pool's chain binding (${BINDING.slice(0, 12)}…)`);
  const d = classifyConfidentialTx('0x' + strip(s.revealHex));
  ok(d && d.type === 'cxfer_bound' && strip(d.assetId) === CUSDT && strip(d.target) === strip(BINDING), 'the reflection\'s classifier reads it as cxfer_bound for cUSDT, naming the pool');
  ok(s.reveal.outputs.every((o) => bytesToHex(o.script).startsWith('0014')), 'every output is P2WPKH (no Taproot key on any note)');
  ok(bytesToHex(s.reveal.outputs[0].script) === bytesToHex(p2wpkh(RECIP_PUB)) && bytesToHex(s.reveal.outputs[1].script) === bytesToHex(p2wpkh(PUB)), 'vout 0 pays the recipient, vout 1 is the sender\'s change');
  const item = inputFirstWitnessItem('0x' + strip(s.revealHex), 1);
  ok(s.reveal.inputs[1].witness.length === 2 && item && item[item.length - 1] === 0x01 && sigBindsAllOutputs(item), 'the note\'s signature is SIGHASH_ALL: it binds every output, as the fold of a bound transfer requires');
  const anchor = concatBytes(hexToBytes(rev(input.utxo.txid)), Uint8Array.of(0, 0, 0, 0));
  const dec = s.env.payload, out0 = dec.slice(1 + 32 + 32 + 64 + 1, 1 + 32 + 32 + 64 + 1 + 41);
  const amt = dapp.decryptAmount(out0.slice(33, 41), dapp.deriveAmountKeystreamECDH(RECIP_SK, PUB, anchor, 0));
  const r = dapp.deriveBlinding(RECIP_SK, PUB, anchor, 0);
  ok(amt === SEND && bytesToHex(dapp.pedersenCommit(amt, r).toRawBytes(true)) === bytesToHex(out0.slice(0, 33)), `the recipient opens vout 0 from its key and the sender's (${amt} units)`);
  held.recipBlinding = r;
});

await section('2. the reflection folds it: two bound notes with the zero auth key, the input nullified', async () => {
  const m = await reflect(held, { input: held.input, auth: ZERO, bound: 1 });
  const t0 = m.triple(held.reveal.txid, 0), t1 = m.triple(held.reveal.txid, 1);
  ok(m.folded[0] === 0 && m.folded[1] === 2 && m.skipped.length === 0, `the commit folds nothing, the reveal folds 2 notes (skipped: ${m.skipped.map((x) => x.reason).join(',') || 'none'})`);
  ok(t0 && t1 && Number(t0[4]) === 1 && Number(t1[4]) === 1, 'both outputs are live as BOUND notes');
  ok(t0 && t1 && strip(t0[3] || '0').replace(/^0+/, '') === '' && strip(t1[3] || '0').replace(/^0+/, '') === '', 'both carry the zero auth key: the fast lane (a signature by that key) can never spend them');
  ok(!m.inputLive && m.after.spent === m.before.spent + 1, 'the input note is nullified');
  held.mirror = m;
});

await section('3. the recipient\'s note burns home by its bound leaf (class 2)', async () => {
  const m = held.mirror;
  const bm = makeConfidentialBridgeMint({ pool: m.cp, ct: makeConfidentialTransfer({ keccak256: keccak_256 }) });
  const b = makeBridgeBurnBroadcaster({ pool: m.cp, bridgeMint: bm });
  const plan = b.planBridgeBurn({
    note: { txid: held.reveal.txid, vout: 0, sats: NOTE_SATS, asset: '0x' + CUSDT, value: SEND, blinding: held.recipBlinding, script: bytesToHex(p2wpkh(RECIP_PUB)) },
    notePriv: RECIP_SK, chainBinding: BINDING, dest: { owner: m.cp.nkToOwner('0x' + 'c5'.repeat(32)), blinding: 777n }, snapshot: m.ix.snapshot(),
  });
  ok(plan.sourceClass === 2 && strip(plan.owner) === strip(ZERO) && plan.wpkh === true, 'the planner names it class 2 (bound) under the zero owner, spent at P2WPKH');
  ok(strip(plan.srcLeaf) === strip(m.cp.btcNoteLeafBound('0x' + CUSDT, word(dapp.pedersenCommit(SEND, held.recipBlinding).toAffine().x), word(dapp.pedersenCommit(SEND, held.recipBlinding).toAffine().y), ZERO, BINDING)),
    'its source leaf is the bound leaf the Ethereum mint reconstructs for class 2');
  ok(/^0x2b/i.test(plan.envelope) || strip(plan.envelope).startsWith('2b'), 'the burn envelope is the 0x2B bridge burn');
});

await section('4. the move off the Taproot address (a note the bridge minted) is a bound transfer that folds', async () => {
  const input = noteAt({ scriptpubkey: bytesToHex(concatBytes(Uint8Array.of(0x51, 0x20), XONLY)), taprootKeyPath: true });
  const s = await send({ assetIdHex: CUSDT, recipients: [{ pubHex: bytesToHex(PUB), amount: AMOUNT }], forceUtxos: [input] });
  ok(s.env.opcode === 0x39 && s.reveal.inputs[1].witness.length === 1 && s.reveal.inputs[1].witness[0].length === 64, 'a 0x39 reveal, the note spent by a 64-byte key-path signature (SIGHASH_DEFAULT binds every output)');
  const m = await reflect(s, { input, auth: '0x' + bytesToHex(XONLY), bound: 0 });
  const t0 = m.triple(s.reveal.txid, 0);
  ok(m.folded[1] === 1 && t0 && Number(t0[4]) === 1 && strip(t0[3] || '0').replace(/^0+/, '') === '' && !m.inputLive, 'the unbound mint note is nullified and the moved note (the whole of it: one output, no change note of 0) is live, bound, with the zero auth key');
});

await section('5. TAC is unchanged; a stealth recipient for a bridged token is refused', async () => {
  const s = await send({ assetIdHex: TAC, recipients: [{ pubHex: bytesToHex(RECIP_PUB), amount: SEND }], forceUtxos: [noteAt()] });
  ok(s.env.opcode === 0x23 || s.env.opcode === 0x22, `a TAC send is the plain transfer (0x${s.env.opcode.toString(16)})`);
  broadcasts = [];
  let err = null;
  try { await dapp.buildAndBroadcastCXferMulti({ assetIdHex: CUSDT, recipients: [{ stealthAddress: 'tcs1example', amount: SEND }], forceUtxos: [noteAt()], useBpp: true }); } catch (e) { err = e; }
  ok(err && /stealth/.test(err.message) && broadcasts.length === 0, `refused with nothing sent (${err ? err.message.slice(0, 70) : 'no error'})`);
});

await section('6. the wallet names bridged tokens it has no etch for', async () => {
  const m = dapp.getAssetMeta(CUSDT);
  ok(m && m.ticker === 'cUSDT' && m.decimals === 6, `cUSDT: ${m ? `${m.ticker}, ${m.decimals} decimals` : 'no name'}`);
  const SPX = '45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48';
  dapp.addBridgedAsset({ assetId: SPX, ticker: 'SPX', capRaw: 10n ** 11n, minRaw: 0n, dec: 8 });
  const s = dapp.getAssetMeta(SPX);
  ok(s && s.ticker === 'SPX' && s.decimals === 8, `a runtime token: ${s ? `${s.ticker}, ${s.decimals} decimals` : 'no name'}`);
  ok(dapp.getAssetMeta('ab'.repeat(32)) == null, 'a token that is neither etched nor bridged stays unnamed');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
